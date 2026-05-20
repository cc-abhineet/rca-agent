# ─────────────────────────────────────────────────────────────────────────────
# terraform/aws/terraform.tfvars.example
#
# Copy to terraform.tfvars and fill in your values:
#   cp terraform.tfvars.example terraform.tfvars
#
# terraform.tfvars is in .gitignore — never commit it.
# Secrets (DD_API_KEY, ANTHROPIC_API_KEY, etc.) are NOT here — they live in
# SSM Parameter Store and are populated separately after terraform apply.
# ─────────────────────────────────────────────────────────────────────────────

aws_region  = "us-east-1"
environment = "production"
github_org  = "oscorpAI"

# Datadog site — must match where your account is registered
dd_site = "datadoghq.com"

# RDS — password is auto-generated and stored in SSM, not here
rds_instance_class = "db.t3.micro"

# ─────────────────────────────────────────────────────────────────────────────
# Monitored app — the service whose errors the platform analyses.
# Swap this whole block to point the platform at a different application.
# The ingestion-agent and rca-agent hosts are unaffected by an app swap.
# ─────────────────────────────────────────────────────────────────────────────
monitored_app = {
  service_name     = "banking-app"
  image_repo_name  = "banking-app"
  image_tag        = "latest"
  port             = 8080
  task_cpu         = 512
  task_memory      = 768       # MiB
  instance_type    = "t3.small" # 2 GiB — comfortable for Spring Boot + dd-agent
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

# ── Platform service sizing (rarely changed) ─────────────────────────────────

# Ingestion-agent host — Python poller, no inbound traffic
ingestion_instance_type = "t3.micro"  # 1 GiB, free-tier eligible
ingestion_agent_cpu     = 256
ingestion_agent_memory  = 256

# RCA-agent host — FastAPI + Claude SDK
rca_instance_type = "t3.small"        # 2 GiB
rca_agent_cpu     = 256
rca_agent_memory  = 512

# ── Platform-service image tags ──────────────────────────────────────────────
# Pin to a git SHA for reproducible deploys
image_tag_ingestion_agent = "latest"
image_tag_rca_agent       = "latest"
image_tag_dd_agent        = "latest"

# ─────────────────────────────────────────────────────────────────────────────
# Example: swapping banking-app for a hypothetical "order-app" Python service
# ─────────────────────────────────────────────────────────────────────────────
# monitored_app = {
#   service_name     = "order-app"
#   image_repo_name  = "order-app"
#   image_tag        = "v1.2.3"
#   port             = 5000
#   task_cpu         = 256
#   task_memory      = 384
#   instance_type    = "t3.micro"   # Python service — 1 GiB is plenty
#   needs_dd_sidecar = true
#   extra_env = {
#     LOG_LEVEL         = "INFO"
#     DD_VERSION        = "1.2.3"
#     DD_LOGS_INJECTION = "true"
#   }
# }
