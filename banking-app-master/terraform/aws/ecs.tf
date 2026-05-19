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
    # Disabled to avoid CloudWatch custom-metrics charges above the free tier.
    # Re-enable for production with: value = "enabled"
    name  = "containerInsights"
    value = "disabled"
  }
}

data "aws_ssm_parameter" "ecs_ami" {
  name = "/aws/service/ecs/optimized-ami/amazon-linux-2/recommended/image_id"
}

resource "aws_iam_role" "ecs_instance" {
  name = "banking-app-ecs-instance-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ec2.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "ecs_instance_role" {
  role       = aws_iam_role.ecs_instance.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonEC2ContainerServiceforEC2Role"
}

resource "aws_iam_role_policy_attachment" "ecs_instance_ecr" {
  role       = aws_iam_role.ecs_instance.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly"
}

resource "aws_iam_instance_profile" "ecs_instance" {
  name = "banking-app-ecs-instance-profile"
  role = aws_iam_role.ecs_instance.name
}

resource "aws_instance" "ecs_instance" {
  count                     = var.ecs_instance_count
  ami                       = data.aws_ssm_parameter.ecs_ami.value
  instance_type             = var.ecs_instance_type
  subnet_id                 = aws_subnet.public[0].id
  associate_public_ip_address = true
  iam_instance_profile      = aws_iam_instance_profile.ecs_instance.name
  vpc_security_group_ids    = [aws_security_group.ecs_tasks.id]

  user_data = <<-EOF
    #!/bin/bash
    # Write cluster config before the ECS agent starts to avoid a timing race
    echo "ECS_CLUSTER=${aws_ecs_cluster.main.name}" > /etc/ecs/ecs.config
    # Restart the agent to ensure it picks up the config even if it started first
    systemctl restart ecs
  EOF

  tags = {
    Name = "banking-app-ecs-instance"
  }
}

# ── Locals: image URIs ────────────────────────────────────────────────────────

data "aws_caller_identity" "current" {}

locals {
  ecr_base = "${data.aws_caller_identity.current.account_id}.dkr.ecr.${var.aws_region}.amazonaws.com"

  banking_app_image     = "${local.ecr_base}/${aws_ecr_repository.banking_app.name}:${var.image_tag_banking_app}"
  dd_agent_image        = "${local.ecr_base}/${aws_ecr_repository.dd_agent.name}:${var.image_tag_dd_agent}"
  ingestion_agent_image = "${local.ecr_base}/${aws_ecr_repository.ingestion_agent.name}:${var.image_tag_ingestion_agent}"
  rca_agent_image       = "${local.ecr_base}/${aws_ecr_repository.rca_agent.name}:${var.image_tag_rca_agent}"
  # DATABASE_URL is injected via the database-url SSM parameter (secrets[]) —
  # see aws_ssm_parameter.database_url in secrets.tf. No plaintext local needed.
}

# ── Task Definition 1: banking-app + dd-agent sidecar ────────────────────────

resource "aws_ecs_task_definition" "banking_app" {
  family                   = "banking-app"
  requires_compatibilities = ["EC2"]
  network_mode             = "bridge"
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
        { name = "DD_API_KEY", valueFrom = aws_ssm_parameter.dd_api_key.arn },
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
        { name = "DD_API_KEY", valueFrom = aws_ssm_parameter.dd_api_key.arn },
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
  requires_compatibilities = ["EC2"]
  network_mode             = "bridge"
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
      { name = "DD_SITE",                    value = var.dd_site },
      { name = "DD_INITIAL_LOOKBACK_HOURS",  value = tostring(var.dd_initial_lookback_hours) },
      { name = "POLL_INTERVAL_SECONDS",      value = tostring(var.dd_poll_interval_seconds) },
      { name = "PROJECTS_YAML_PATH",         value = "/app/projects.yaml" },
      { name = "SERVICE_NAME",               value = "banking-app" },
      { name = "ENVIRONMENT",                value = var.environment },
    ]

    secrets = [
      # DATABASE_URL contains the password — inject as a secret, not plaintext env var
      { name = "DATABASE_URL",   valueFrom = aws_ssm_parameter.database_url.arn },
      { name = "GEMINI_API_KEY", valueFrom = aws_ssm_parameter.gemini_api_key.arn },
      { name = "DD_API_KEY",     valueFrom = aws_ssm_parameter.dd_api_key.arn },
      { name = "DD_APP_KEY",     valueFrom = aws_ssm_parameter.dd_app_key.arn },
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
  requires_compatibilities = ["EC2"]
  network_mode             = "bridge"
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
      { name = "GITHUB_ORG",                value = var.github_org },
      { name = "OBSERVABILITY_ADAPTER",     value = "local" },
      { name = "CICD_ADAPTER",              value = "mock" },
      { name = "RCA_POLL_ENABLED",          value = "true" },
      { name = "RCA_POLL_INTERVAL_SECONDS", value = "30" },
      { name = "MODEL",                     value = "claude-sonnet-4-6" },
      { name = "MAX_REACT_ITERATIONS",      value = "20" },
    ]

    secrets = [
      # DATABASE_URL contains the password — inject as a secret, not plaintext env var
      { name = "DATABASE_URL",      valueFrom = aws_ssm_parameter.database_url.arn },
      { name = "ANTHROPIC_API_KEY", valueFrom = aws_ssm_parameter.anthropic_api_key.arn },
      { name = "GITHUB_PAT",        valueFrom = aws_ssm_parameter.github_pat.arn },
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
  launch_type     = "EC2"
}

resource "aws_ecs_service" "ingestion_agent" {
  name            = "ingestion-agent"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.ingestion_agent.arn
  desired_count   = 1
  launch_type     = "EC2"
  # No load balancer — ingestion agent has no inbound HTTP in poll mode
}

resource "aws_ecs_service" "rca_agent" {
  name            = "rca-agent"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.rca_agent.arn
  desired_count   = 1
  launch_type     = "EC2"
}
