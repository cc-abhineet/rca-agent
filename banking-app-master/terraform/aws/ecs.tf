# ─────────────────────────────────────────────────────────────────────────────
# terraform/aws/ecs.tf — ECS cluster, task definitions, and services
#
# Three ECS services:
#   1. banking-app       — Spring Boot + Datadog agent sidecar (shared log volume)
#   2. ingestion-agent   — Python poller (MODE=datadog_poll, polls Datadog Logs API)
#   3. rca-agent         — Python FastAPI (RCA_POLL_ENABLED=true, polls RDS)
#
# All secrets injected from Secrets Manager via ECS secrets[] references.
# No plaintext credentials in task definitions or images.
# ─────────────────────────────────────────────────────────────────────────────

resource "aws_ecs_cluster" "main" {
  name = "banking-app-cluster"

  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

# ── Locals: image URIs ────────────────────────────────────────────────────────

data "aws_caller_identity" "current" {}

locals {
  ecr_base = "${data.aws_caller_identity.current.account_id}.dkr.ecr.${var.aws_region}.amazonaws.com"

  banking_app_image    = "${local.ecr_base}/${aws_ecr_repository.banking_app.name}:${var.image_tag_banking_app}"
  dd_agent_image       = "${local.ecr_base}/${aws_ecr_repository.dd_agent.name}:${var.image_tag_dd_agent}"
  ingestion_agent_image = "${local.ecr_base}/${aws_ecr_repository.ingestion_agent.name}:${var.image_tag_ingestion_agent}"
  rca_agent_image      = "${local.ecr_base}/${aws_ecr_repository.rca_agent.name}:${var.image_tag_rca_agent}"

  # MySQL connection URL for Python services (password injected via secret at runtime)
  # The ECS secret sets DATABASE_URL_PASSWORD; the app constructs the full URL.
  # Alternatively, the full URL can be stored as a single secret — see AWS_DEPLOYMENT.md.
  db_host = aws_db_instance.rca_db.address
  db_url  = "mysql+pymysql://${var.rds_username}:PLACEHOLDER@${local.db_host}:3306/${var.rds_db_name}"
}

# ── Task Definition 1: banking-app + dd-agent sidecar ────────────────────────

resource "aws_ecs_task_definition" "banking_app" {
  family                   = "banking-app"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.banking_app_cpu
  memory                   = var.banking_app_memory
  execution_role_arn       = aws_iam_role.ecs_task_execution.arn
  task_role_arn            = aws_iam_role.ecs_task.arn

  # Shared ephemeral volume: banking-app writes logs here; dd-agent reads them
  volume {
    name = "app-logs"
  }

  container_definitions = jsonencode([
    # ── banking-app ──
    {
      name      = "banking-app"
      image     = local.banking_app_image
      essential = true

      portMappings = [{ containerPort = 8080, protocol = "tcp" }]

      environment = [
        { name = "SPRING_DATASOURCE_URL",               value = "jdbc:h2:mem:bankingdb;DB_CLOSE_DELAY=-1;DB_CLOSE_ON_EXIT=FALSE" },
        { name = "SPRING_DATASOURCE_DRIVER_CLASS_NAME", value = "org.h2.Driver" },
        { name = "SPRING_DATASOURCE_USERNAME",          value = "sa" },
        { name = "SPRING_DATASOURCE_PASSWORD",          value = "" },
        { name = "SPRING_JPA_DATABASE_PLATFORM",        value = "org.hibernate.dialect.H2Dialect" },
        { name = "SPRING_H2_CONSOLE_ENABLED",           value = "false" },
        { name = "LOGGING_FILE_NAME",                   value = "/var/log/banking-app/app.log" },
        { name = "DD_ENV",                              value = var.environment },
        { name = "DD_SERVICE",                          value = "banking-app" },
        { name = "DD_VERSION",                          value = "1.0.0" },
        { name = "DD_LOGS_INJECTION",                   value = "true" },
      ]

      secrets = [
        { name = "DD_API_KEY", valueFrom = aws_secretsmanager_secret.dd_api_key.arn },
      ]

      mountPoints = [{ sourceVolume = "app-logs", containerPath = "/var/log/banking-app" }]

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.banking_app.name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "banking-app"
        }
      }
    },

    # ── Datadog agent sidecar ──
    {
      name      = "dd-agent"
      image     = local.dd_agent_image
      essential = false  # banking-app keeps running if dd-agent dies

      environment = [
        { name = "DD_SITE",                             value = var.dd_site },
        { name = "DD_LOGS_ENABLED",                     value = "true" },
        { name = "DD_LOGS_CONFIG_CONTAINER_COLLECT_ALL", value = "false" },
        { name = "DD_APM_ENABLED",                      value = "false" },
        { name = "DD_PROCESS_AGENT_ENABLED",            value = "false" },
      ]

      secrets = [
        { name = "DD_API_KEY", valueFrom = aws_secretsmanager_secret.dd_api_key.arn },
      ]

      mountPoints = [{ sourceVolume = "app-logs", containerPath = "/var/log/banking-app", readOnly = true }]

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.dd_agent.name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "dd-agent"
        }
      }
    }
  ])
}

# ── Task Definition 2: error-ingestion-agent ──────────────────────────────────

resource "aws_ecs_task_definition" "ingestion_agent" {
  family                   = "ingestion-agent"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.ingestion_agent_cpu
  memory                   = var.ingestion_agent_memory
  execution_role_arn       = aws_iam_role.ecs_task_execution.arn
  task_role_arn            = aws_iam_role.ecs_task.arn

  container_definitions = jsonencode([{
    name      = "ingestion-agent"
    image     = local.ingestion_agent_image
    essential = true

    environment = [
      { name = "MODE",                       value = "datadog_poll" },
      { name = "DATABASE_URL",               value = local.db_url },
      { name = "DD_SITE",                    value = var.dd_site },
      { name = "DD_INITIAL_LOOKBACK_HOURS",  value = tostring(var.dd_initial_lookback_hours) },
      { name = "POLL_INTERVAL_SECONDS",      value = tostring(var.dd_poll_interval_seconds) },
      { name = "PROJECTS_YAML_PATH",         value = "/app/projects.yaml" },
      { name = "SERVICE_NAME",               value = "banking-app" },
      { name = "ENVIRONMENT",                value = var.environment },
    ]

    secrets = [
      { name = "GEMINI_API_KEY", valueFrom = aws_secretsmanager_secret.gemini_api_key.arn },
      { name = "DD_API_KEY",     valueFrom = aws_secretsmanager_secret.dd_api_key.arn },
      { name = "DD_APP_KEY",     valueFrom = aws_secretsmanager_secret.dd_app_key.arn },
    ]

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.ingestion_agent.name
        "awslogs-region"        = var.aws_region
        "awslogs-stream-prefix" = "ingestion-agent"
      }
    }
  }])
}

# ── Task Definition 3: rca-agent ─────────────────────────────────────────────

resource "aws_ecs_task_definition" "rca_agent" {
  family                   = "rca-agent"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.rca_agent_cpu
  memory                   = var.rca_agent_memory
  execution_role_arn       = aws_iam_role.ecs_task_execution.arn
  task_role_arn            = aws_iam_role.ecs_task.arn

  container_definitions = jsonencode([{
    name      = "rca-agent"
    image     = local.rca_agent_image
    essential = true

    portMappings = [{ containerPort = 8000, protocol = "tcp" }]

    environment = [
      { name = "DATABASE_URL",              value = local.db_url },
      { name = "GITHUB_ORG",               value = var.github_org },
      { name = "OBSERVABILITY_ADAPTER",    value = "local" },
      { name = "CICD_ADAPTER",             value = "mock" },
      { name = "RCA_POLL_ENABLED",         value = "true" },
      { name = "RCA_POLL_INTERVAL_SECONDS", value = "30" },
      { name = "MODEL",                    value = "claude-sonnet-4-6" },
      { name = "MAX_REACT_ITERATIONS",     value = "20" },
    ]

    secrets = [
      { name = "ANTHROPIC_API_KEY", valueFrom = aws_secretsmanager_secret.anthropic_api_key.arn },
      { name = "GITHUB_PAT",        valueFrom = aws_secretsmanager_secret.github_pat.arn },
    ]

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.rca_agent.name
        "awslogs-region"        = var.aws_region
        "awslogs-stream-prefix" = "rca-agent"
      }
    }
  }])
}

# ── ECS Services ──────────────────────────────────────────────────────────────

resource "aws_ecs_service" "banking_app" {
  name            = "banking-app"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.banking_app.arn
  desired_count   = 1
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.ecs_tasks.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.banking_app.arn
    container_name   = "banking-app"
    container_port   = 8080
  }

  depends_on = [aws_lb_listener.http]
}

resource "aws_ecs_service" "ingestion_agent" {
  name            = "ingestion-agent"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.ingestion_agent.arn
  desired_count   = 1
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.ecs_tasks.id]
    assign_public_ip = false
  }
  # No load balancer — ingestion agent has no inbound HTTP in poll mode
}

resource "aws_ecs_service" "rca_agent" {
  name            = "rca-agent"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.rca_agent.arn
  desired_count   = 1
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.ecs_tasks.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.rca_agent.arn
    container_name   = "rca-agent"
    container_port   = 8000
  }

  depends_on = [aws_lb_listener.http]
}
