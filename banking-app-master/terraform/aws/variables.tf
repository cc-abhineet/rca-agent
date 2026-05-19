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
# These default to 'latest' so you can do a quick first deploy.
# Pin to a specific git SHA in production: image_tag_banking_app = "abc1234"

variable "image_tag_banking_app" {
  description = "Docker image tag for banking-app (pushed to ECR)"
  type        = string
  default     = "latest"
}

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

# ── ECS ───────────────────────────────────────────────────────────────────────

variable "banking_app_cpu" {
  description = "ECS task CPU units for banking-app task (1024 = 1 vCPU)"
  type        = number
  default     = 512
}

variable "banking_app_memory" {
  description = "ECS task memory in MiB for banking-app task"
  type        = number
  default     = 768  # Spring Boot (H2, no load) + dd-agent sidecar fits comfortably
}

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
variable "ecs_instance_type" {
  description = "EC2 instance type for the ECS container instance"
  type        = string
  # t3.micro (1 GiB) and t3.small (2 GiB) are both too small —
  # the ECS-optimized AMI consumes ~1.1 GiB for OS + Docker + ECS agent,
  # leaving only ~940 MiB on t3.small vs ~1.5 GiB needed for 3 tasks.
  # t3.medium (4 GiB) leaves ~2.9 GiB for containers — comfortable for all 3.
  # Note: t3.medium costs ~$30/month (NOT free tier).
  default     = "t3.medium"
}

variable "ecs_instance_count" {
  description = "Number of ECS EC2 instances to launch for the cluster"
  type        = number
  default     = 1
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
