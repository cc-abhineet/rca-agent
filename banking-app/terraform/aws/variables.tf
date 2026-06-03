# ─────────────────────────────────────────────────────────────────────────────
# terraform/aws/variables.tf
# ─────────────────────────────────────────────────────────────────────────────

# ── AWS ───────────────────────────────────────────────────────────────────────

variable "aws_region" {
  description = "AWS region to deploy into"
  type        = string
  default     = "us-east-1"
}

variable "environment" {
  description = "Environment name — used in resource names and tags"
  type        = string
  default     = "production"
}

# ── Networking ────────────────────────────────────────────────────────────────

variable "vpc_cidr" {
  description = "CIDR block for the VPC"
  type        = string
  default     = "10.0.0.0/16"
}

variable "availability_zones" {
  description = "List of AZs to use for public subnets"
  type        = list(string)
  default     = ["us-east-1a", "us-east-1b"]
}

# ── ECR image tags ────────────────────────────────────────────────────────────
# The monitored-app's image tag lives inside var.monitored_app (see below).
# These two are for the platform's own services and rarely change.

variable "image_tag_ingestion_agent" {
  description = "Docker image tag for error-ingestion-agent"
  type        = string
  default     = "latest"
}

variable "image_tag_rca_agent" {
  description = "Docker image tag for rca-agent"
  type        = string
  default     = "latest"
}

variable "image_tag_dd_agent" {
  description = "Docker image tag for the Datadog agent sidecar"
  type        = string
  default     = "latest"
}

# ── RDS ───────────────────────────────────────────────────────────────────────

variable "rds_instance_class" {
  description = "RDS instance class"
  type        = string
  default     = "db.t3.micro"
}

variable "rds_allocated_storage_gb" {
  description = "Allocated storage in GB for RDS MySQL"
  type        = number
  default     = 20
}

variable "rds_db_name" {
  description = "MySQL database name"
  type        = string
  default     = "rca_db"
}

variable "rds_username" {
  description = "MySQL master username"
  type        = string
  default     = "rcaadmin"
}

# ── Monitored application (swappable) ─────────────────────────────────────────
# The "monitored app" is the source of errors the RCA pipeline analyses.
# It runs on a dedicated EC2 host so it can be replaced wholesale without
# touching the ingestion-agent or rca-agent hosts.
#
# To swap banking-app for a different application:
#   1. Push the new image to ECR (or to a different registry — adjust
#      `image_repo_name` and the ECR repos in ecr.tf accordingly).
#   2. Edit this block in terraform.tfvars: service_name, image_repo_name,
#      image_tag, port, task_cpu, task_memory, instance_type, needs_dd_sidecar,
#      extra_env.
#   3. terraform apply.
#
# The ingestion-agent and rca-agent hosts are unaffected by an app swap.

variable "monitored_app" {
  description = "Configuration for the monitored application (the source of errors the RCA pipeline analyses). Swap this block to point the platform at a different app."

  type = object({
    service_name     = string       # tag/label used in env vars, logs, DD
    image_repo_name  = string       # ECR repository name for the app image
    image_tag        = string       # ECR image tag (e.g. "latest" or a git SHA)
    port             = number       # public TCP port exposed by the app
    task_cpu         = number       # ECS task CPU units (1024 = 1 vCPU)
    task_memory      = number       # ECS task memory in MiB
    instance_type    = string       # EC2 instance type for this host
    needs_dd_sidecar = bool         # true to colocate the Datadog agent sidecar
    extra_env        = map(string)  # app-specific environment variables
  })

  default = {
    service_name     = "banking-app"
    image_repo_name  = "banking-app"
    image_tag        = "latest"
    port             = 8080
    task_cpu         = 512
    task_memory      = 768  # Spring Boot (H2, no load) + dd-agent sidecar fits comfortably
    # t3.small (2 GiB) leaves ~940 MiB after the ECS-optimized AMI's
    # ~1.1 GiB OS + Docker + ECS-agent overhead — comfortable for the
    # 768 MiB Spring Boot task. t3.micro (1 GiB) is too tight for Java.
    instance_type    = "t3.small"
    needs_dd_sidecar = true
    extra_env = {
      SPRING_DATASOURCE_URL               = "jdbc:h2:mem:bankingdb;DB_CLOSE_DELAY=-1;DB_CLOSE_ON_EXIT=FALSE"
      SPRING_DATASOURCE_DRIVER_CLASS_NAME = "org.h2.Driver"
      SPRING_DATASOURCE_USERNAME          = "sa"
      SPRING_DATASOURCE_PASSWORD          = ""
      SPRING_JPA_DATABASE_PLATFORM        = "org.hibernate.dialect.H2Dialect"
      SPRING_H2_CONSOLE_ENABLED           = "false"
      LOGGING_FILE_NAME                   = "/var/log/banking-app/app.log"
      DD_VERSION                          = "1.0.0"
      DD_LOGS_INJECTION                   = "true"
    }
  }
}

# ── ECS task sizing for platform services ────────────────────────────────────
# These two services are part of the platform itself and rarely need tuning.

variable "ingestion_agent_cpu" {
  description = "ECS task CPU units for ingestion-agent"
  type        = number
  default     = 256
}

variable "ingestion_agent_memory" {
  description = "ECS task memory in MiB for ingestion-agent"
  type        = number
  default     = 256
}

variable "rca_agent_cpu" {
  description = "ECS task CPU units for rca-agent"
  type        = number
  default     = 256
}

variable "rca_agent_memory" {
  description = "ECS task memory in MiB for rca-agent"
  type        = number
  default     = 512
}

# ── Per-host EC2 sizing ──────────────────────────────────────────────────────
# Each service runs on its own EC2 container instance. Right-size each host
# to its task's memory footprint plus ~1.1 GiB of ECS-optimized AMI overhead
# (OS + Docker + ECS agent).
#
# The monitored-app host's instance type lives inside var.monitored_app so
# it can be tuned per swappable app. These two are for the platform.

variable "ingestion_instance_type" {
  description = "EC2 instance type for the ingestion-agent host. t3.micro (1 GiB) leaves ~460 MiB for the 256 MiB Python poller — comfortable, and free-tier eligible."
  type        = string
  default     = "t3.micro"
}

variable "rca_instance_type" {
  description = "EC2 instance type for the rca-agent host. t3.small (2 GiB) leaves ~940 MiB for the 512 MiB FastAPI task with comfortable headroom for Claude API responses."
  type        = string
  default     = "t3.small"
}

# ── GitHub ────────────────────────────────────────────────────────────────────

variable "github_org" {
  description = "GitHub organisation that owns the service repos"
  type        = string
  default     = "oscorpAI"
}

# ── Datadog ───────────────────────────────────────────────────────────────────

variable "dd_site" {
  description = "Datadog site (datadoghq.com | datadoghq.eu | us3.datadoghq.com)"
  type        = string
  default     = "datadoghq.com"
}

variable "dd_poll_interval_seconds" {
  description = "Seconds between Datadog Logs API polls in the ingestion agent"
  type        = number
  default     = 30
}

variable "dd_initial_lookback_hours" {
  description = "Hours to look back on first poll when no cursor is stored"
  type        = number
  default     = 1
}
