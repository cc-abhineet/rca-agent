# ─────────────────────────────────────────────────────────────────────────────
# terraform/aws/ecs.tf — ECS cluster, task definitions, services, and the
# three EC2 container instances that back them.
#
# Topology: one ECS cluster, three EC2 hosts, one service per host.
#
#   ┌─ host_monitored_app  (var.monitored_app.instance_type — default t3.small)
#   │    attribute:module == monitored-app
#   │    runs the swappable monitored app (banking-app today) + dd-agent sidecar
#   │
#   ├─ host_ingestion_agent (var.ingestion_instance_type — default t3.micro)
#   │    attribute:module == ingestion-agent
#   │    runs the Python poller; no inbound traffic
#   │
#   └─ host_rca_agent       (var.rca_instance_type — default t3.small)
#        attribute:module == rca-agent
#        runs FastAPI + Claude ReAct loop on port 8000
#
# Each ECS service uses a `memberOf(attribute:module == X)` placement
# constraint, so tasks are pinned to the host that matches the module
# attribute the user_data writes into /etc/ecs/ecs.config.
#
# All secrets injected from SSM Parameter Store via ECS secrets[] references.
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

# ── IAM for the EC2 container instances ──────────────────────────────────────
# Shared across all three hosts — the same role/profile is fine because every
# host needs the same set of permissions (register with ECS, pull from ECR).

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

# SSM access — lets you `aws ssm start-session` into each host for debugging
# when ECS Exec into a task isn't possible (e.g. tasks failing to start).
resource "aws_iam_role_policy_attachment" "ecs_instance_ssm" {
  role       = aws_iam_role.ecs_instance.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_instance_profile" "ecs_instance" {
  name = "banking-app-ecs-instance-profile"
  role = aws_iam_role.ecs_instance.name
}

# ── user_data template ──────────────────────────────────────────────────────
# Writes ECS_CLUSTER and ECS_INSTANCE_ATTRIBUTES into /etc/ecs/ecs.config
# before the ECS agent starts. The attributes are how `placement_constraints`
# below pins each ECS service to its dedicated host.

locals {
  user_data = {
    monitored_app    = <<-EOT
      #!/bin/bash
      set -x
      exec > /var/log/user-data.log 2>&1
      mkdir -p /etc/ecs
      cat >> /etc/ecs/ecs.config <<CFG
      ECS_CLUSTER=${aws_ecs_cluster.main.name}
      ECS_INSTANCE_ATTRIBUTES={"module":"monitored-app"}
      ECS_ENABLE_TASK_IAM_ROLE=true
      CFG
      systemctl enable --now ecs || start ecs || true
    EOT
    ingestion_agent  = <<-EOT
      #!/bin/bash
      set -x
      exec > /var/log/user-data.log 2>&1
      mkdir -p /etc/ecs
      cat >> /etc/ecs/ecs.config <<CFG
      ECS_CLUSTER=${aws_ecs_cluster.main.name}
      ECS_INSTANCE_ATTRIBUTES={"module":"ingestion-agent"}
      ECS_ENABLE_TASK_IAM_ROLE=true
      CFG
      systemctl enable --now ecs || start ecs || true
    EOT
    rca_agent        = <<-EOT
      #!/bin/bash
      set -x
      exec > /var/log/user-data.log 2>&1
      mkdir -p /etc/ecs
      cat >> /etc/ecs/ecs.config <<CFG
      ECS_CLUSTER=${aws_ecs_cluster.main.name}
      ECS_INSTANCE_ATTRIBUTES={"module":"rca-agent"}
      ECS_ENABLE_TASK_IAM_ROLE=true
      CFG
      systemctl enable --now ecs || start ecs || true
    EOT
  }
}

# ── EC2 container instances — one per service ────────────────────────────────

resource "aws_instance" "host_monitored_app" {
  ami                         = data.aws_ssm_parameter.ecs_ami.value
  instance_type               = var.monitored_app.instance_type
  subnet_id                   = aws_subnet.public[0].id
  associate_public_ip_address = true
  iam_instance_profile        = aws_iam_instance_profile.ecs_instance.name
  vpc_security_group_ids      = [aws_security_group.monitored_app.id]
  user_data                   = local.user_data.monitored_app

  tags = {
    Name   = "banking-app-host-monitored-app"
    Module = "monitored-app"
  }
}

resource "aws_instance" "host_ingestion_agent" {
  ami                         = data.aws_ssm_parameter.ecs_ami.value
  instance_type               = var.ingestion_instance_type
  subnet_id                   = aws_subnet.public[0].id
  associate_public_ip_address = true
  iam_instance_profile        = aws_iam_instance_profile.ecs_instance.name
  vpc_security_group_ids      = [aws_security_group.ingestion_agent.id]
  user_data                   = local.user_data.ingestion_agent

  tags = {
    Name   = "banking-app-host-ingestion-agent"
    Module = "ingestion-agent"
  }
}

resource "aws_instance" "host_rca_agent" {
  ami                         = data.aws_ssm_parameter.ecs_ami.value
  instance_type               = var.rca_instance_type
  subnet_id                   = aws_subnet.public[0].id
  associate_public_ip_address = true
  iam_instance_profile        = aws_iam_instance_profile.ecs_instance.name
  vpc_security_group_ids      = [aws_security_group.rca_agent.id]
  user_data                   = local.user_data.rca_agent

  tags = {
    Name   = "banking-app-host-rca-agent"
    Module = "rca-agent"
  }
}

# ── Locals: image URIs ────────────────────────────────────────────────────────

data "aws_caller_identity" "current" {}

locals {
  ecr_base = "${data.aws_caller_identity.current.account_id}.dkr.ecr.${var.aws_region}.amazonaws.com"

  monitored_app_image   = "${local.ecr_base}/${var.monitored_app.image_repo_name}:${var.monitored_app.image_tag}"
  dd_agent_image        = "${local.ecr_base}/${aws_ecr_repository.dd_agent.name}:${var.image_tag_dd_agent}"
  ingestion_agent_image = "${local.ecr_base}/${aws_ecr_repository.ingestion_agent.name}:${var.image_tag_ingestion_agent}"
  rca_agent_image       = "${local.ecr_base}/${aws_ecr_repository.rca_agent.name}:${var.image_tag_rca_agent}"
  # DATABASE_URL is injected via the database-url SSM parameter (secrets[]) —
  # see aws_ssm_parameter.database_url in secrets.tf. No plaintext local needed.

  # Merge platform-mandated env vars with whatever the app needs.
  monitored_app_env = concat(
    [
      { name = "DD_ENV",     value = var.environment },
      { name = "DD_SERVICE", value = var.monitored_app.service_name },
    ],
    [for k, v in var.monitored_app.extra_env : { name = k, value = v }],
  )

  # The dd-agent sidecar is conditionally appended to the monitored-app task.
  # Keep the attribute shape identical to the monitored-app container above so
  # `concat()` can unify the two objects without type drift.
  dd_agent_container = {
    name      = "dd-agent"
    image     = local.dd_agent_image
    essential = false  # the monitored app keeps running if dd-agent dies

    portMappings = []

    environment = [
      { name = "DD_SITE",                              value = var.dd_site },
      { name = "DD_LOGS_ENABLED",                      value = "true" },
      { name = "DD_LOGS_CONFIG_CONTAINER_COLLECT_ALL", value = "false" },
      { name = "DD_APM_ENABLED",                       value = "false" },
      { name = "DD_PROCESS_AGENT_ENABLED",             value = "false" },
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
}

# ── Task Definition 1: monitored app (+ optional dd-agent sidecar) ───────────

resource "aws_ecs_task_definition" "monitored_app" {
  family                   = var.monitored_app.service_name
  requires_compatibilities = ["EC2"]
  network_mode             = "bridge"
  cpu                      = var.monitored_app.task_cpu
  memory                   = var.monitored_app.task_memory
  execution_role_arn       = aws_iam_role.ecs_task_execution.arn
  task_role_arn            = aws_iam_role.ecs_task.arn

  # Shared ephemeral volume: the monitored app writes logs here; dd-agent reads.
  # Declared unconditionally so the task definition stays shape-stable across
  # apps that don't use the sidecar — an unmounted volume costs nothing.
  volume {
    name = "app-logs"
  }

  container_definitions = jsonencode(concat(
    [
      {
        name      = var.monitored_app.service_name
        image     = local.monitored_app_image
        essential = true

        portMappings = [{ containerPort = var.monitored_app.port, protocol = "tcp" }]

        environment = local.monitored_app_env

        secrets = [
          { name = "DD_API_KEY", valueFrom = aws_ssm_parameter.dd_api_key.arn },
        ]

        mountPoints = [{ sourceVolume = "app-logs", containerPath = "/var/log/banking-app" }]

        logConfiguration = {
          logDriver = "awslogs"
          options = {
            "awslogs-group"         = aws_cloudwatch_log_group.monitored_app.name
            "awslogs-region"        = var.aws_region
            "awslogs-stream-prefix" = var.monitored_app.service_name
          }
        }
      },
    ],
    var.monitored_app.needs_dd_sidecar ? [local.dd_agent_container] : [],
  ))
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
      { name = "SERVICE_NAME",               value = var.monitored_app.service_name },
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

# ── ECS Services — pinned to dedicated hosts via placement_constraints ───────

resource "aws_ecs_service" "monitored_app" {
  name            = var.monitored_app.service_name
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.monitored_app.arn
  desired_count   = 1
  launch_type     = "EC2"

  placement_constraints {
    type       = "memberOf"
    expression = "attribute:module == monitored-app"
  }

  # Ensure the EC2 host has registered with the cluster before ECS tries to
  # schedule a task that depends on its attribute.
  depends_on = [aws_instance.host_monitored_app]
}

resource "aws_ecs_service" "ingestion_agent" {
  name            = "ingestion-agent"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.ingestion_agent.arn
  desired_count   = 1
  launch_type     = "EC2"
  # No load balancer — ingestion agent has no inbound HTTP in poll mode

  placement_constraints {
    type       = "memberOf"
    expression = "attribute:module == ingestion-agent"
  }

  depends_on = [aws_instance.host_ingestion_agent]
}

resource "aws_ecs_service" "rca_agent" {
  name            = "rca-agent"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.rca_agent.arn
  desired_count   = 1
  launch_type     = "EC2"

  placement_constraints {
    type       = "memberOf"
    expression = "attribute:module == rca-agent"
  }

  depends_on = [aws_instance.host_rca_agent]
}
