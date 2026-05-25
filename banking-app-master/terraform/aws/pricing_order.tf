# ─────────────────────────────────────────────────────────────────────────────
# terraform/aws/pricing_order.tf
#
# Two independently deployable Java Spring Boot services for the RCA demo.
#
# Each service gets its own dedicated EC2 host (t3.small) and dd-agent sidecar
# so either can run alone or together:
#
#   Single-service demo (Bug B — off-by-one, no upstream needed):
#     → Deploy order-service only.  Leave pricing_service_url = "" in tfvars.
#       Bug B fires when quantity=1.  The RCA agent investigates order-service
#       alone and finds the off-by-one in resolveQuantity (commit d3adb33f).
#
#   Cross-service demo (Bug A — NPE from stale discount field):
#     → Deploy both.  After first `terraform apply`, copy the
#       pricing_service_private_ip output into pricing_service_url in tfvars,
#       then `terraform apply` again.  Bug A fires on any order creation.
#       The RCA agent crosses service boundaries to find the rename in
#       pricing-service (commit abc1234f, Alice Chen).
#
# Architecture (extends the existing 3-host platform):
#
#   ┌─ host_pricing_service  (t3.small, NEW)
#   │    pricing-service v2.1.0 + dd-agent sidecar
#   │    port 8081 — exposed publicly for demos
#   │
#   ├─ host_order_service    (t3.small, NEW)
#   │    order-service v1.3.0 + dd-agent sidecar
#   │    port 8082 — exposed publicly for demos
#   │    PRICING_SERVICE_URL → pricing-service private IP (when configured)
#   │
#   ├─ host_ingestion_agent  (unchanged)
#   └─ host_rca_agent        (unchanged)
#
# ── Instance sizing ──────────────────────────────────────────────────────────
# t3.small (2 GiB) is the minimum that reliably fits a Spring Boot service
# alongside the Datadog agent sidecar:
#
#   ECS-optimized AMI overhead  ≈  700 MiB  (OS + Docker + ECS agent)
#   Spring Boot app container   =  512 MiB  (JVM baseline)
#   dd-agent sidecar            =  256 MiB
#   ─────────────────────────────────────────
#   Total                       ≈  1468 MiB  →  fits t3.small (2048 MiB)
#                                            →  does NOT fit t3.micro (1024 MiB)
#
# ── How to deploy ────────────────────────────────────────────────────────────
#
# 1. Push images to ECR:
#
#      ACCT=$(aws sts get-caller-identity --query Account --output text)
#      REGION=us-east-1
#      aws ecr get-login-password --region $REGION | \
#        docker login --username AWS --password-stdin $ACCT.dkr.ecr.$REGION.amazonaws.com
#
#      # pricing-service
#      cd banking-app-master/pricing-service
#      docker build -t pricing-service .
#      docker tag pricing-service:latest \
#        $ACCT.dkr.ecr.$REGION.amazonaws.com/pricing-service:latest
#      docker push $ACCT.dkr.ecr.$REGION.amazonaws.com/pricing-service:latest
#
#      # order-service
#      cd ../order-service
#      docker build -t order-service .
#      docker tag order-service:latest \
#        $ACCT.dkr.ecr.$REGION.amazonaws.com/order-service:latest
#      docker push $ACCT.dkr.ecr.$REGION.amazonaws.com/order-service:latest
#
# 2. terraform apply  (pricing_service_url = "" for first run)
#
# 3. For the cross-service demo, add to terraform.tfvars:
#      pricing_service_url = "http://<pricing_service_private_ip output>:8081"
#    then: terraform apply  (updates the order-service task definition)
#
# 4. Trigger bugs via chaos endpoints:
#      Bug A: curl -X POST http://<order-public-ip>:8082/chaos/cross-service-npe
#      Bug B: curl -X POST http://<order-public-ip>:8082/chaos/quantity-off-by-one
#
# ── Seed data ────────────────────────────────────────────────────────────────
#   python demo-repos/demo_seed_data.py --scenario cross-service
#
# ─────────────────────────────────────────────────────────────────────────────

# ── Variable: pricing-service URL for order-service ───────────────────────────
# Leave empty ("") for single-service demo — order-service will use the
# application.yml default (http://localhost:8081) and start fine.  Set to
# the pricing-service private IP for the cross-service demo.

variable "pricing_service_url" {
  description = <<-EOT
    URL of the pricing-service as seen by order-service (private IP, e.g.
    "http://10.0.1.42:8081").  Leave empty for single-service demo — Bug B
    (off-by-one) works without pricing-service running.  Set after the first
    terraform apply when pricing_service_private_ip is known.
  EOT
  type    = string
  default = ""
}

# ── Locals ────────────────────────────────────────────────────────────────────
# Reuse local.ecr_base and local.dd_agent_image from ecs.tf.

locals {
  pricing_port      = 8081
  order_port        = 8082
  pricing_image_tag = "latest"
  order_image_tag   = "latest"

  pricing_image = "${local.ecr_base}/pricing-service:${local.pricing_image_tag}"
  order_image   = "${local.ecr_base}/order-service:${local.order_image_tag}"

  # PRICING_SERVICE_URL injected only when the variable is non-empty.
  # When empty, the env var is absent and Spring Boot uses its application.yml
  # default: ${PRICING_SERVICE_URL:http://localhost:8081}
  order_pricing_env = var.pricing_service_url != "" ? [
    { name = "PRICING_SERVICE_URL", value = var.pricing_service_url }
  ] : []
}

# ── ECR repositories ──────────────────────────────────────────────────────────

resource "aws_ecr_repository" "pricing_service" {
  name                 = "pricing-service"
  image_tag_mutability = "MUTABLE"
  force_delete         = true

  image_scanning_configuration { scan_on_push = true }

  tags = { Service = "pricing-service" }
}

resource "aws_ecr_repository" "order_service" {
  name                 = "order-service"
  image_tag_mutability = "MUTABLE"
  force_delete         = true

  image_scanning_configuration { scan_on_push = true }

  tags = { Service = "order-service" }
}

# Shared lifecycle policy — keep last 3 tagged images, evict untagged immediately
resource "aws_ecr_lifecycle_policy" "pricing_service" {
  repository = aws_ecr_repository.pricing_service.name
  policy = jsonencode({
    rules = [
      { rulePriority = 1, description = "Evict untagged", selection = { tagStatus = "untagged", countType = "sinceImagePushed", countUnit = "days", countNumber = 1 }, action = { type = "expire" } },
      { rulePriority = 2, description = "Keep 3 tagged",  selection = { tagStatus = "tagged", tagPrefixList = ["latest", "v"], countType = "imageCountMoreThan", countNumber = 3 }, action = { type = "expire" } },
    ]
  })
}

resource "aws_ecr_lifecycle_policy" "order_service" {
  repository = aws_ecr_repository.order_service.name
  policy = jsonencode({
    rules = [
      { rulePriority = 1, description = "Evict untagged", selection = { tagStatus = "untagged", countType = "sinceImagePushed", countUnit = "days", countNumber = 1 }, action = { type = "expire" } },
      { rulePriority = 2, description = "Keep 3 tagged",  selection = { tagStatus = "tagged", tagPrefixList = ["latest", "v"], countType = "imageCountMoreThan", countNumber = 3 }, action = { type = "expire" } },
    ]
  })
}

# ── Security groups ───────────────────────────────────────────────────────────
# Each service gets its own SG so port rules stay scoped to the right host.

resource "aws_security_group" "pricing_service" {
  name        = "pricing-service-sg"
  description = "pricing-service host: port 8081 public + unrestricted egress"
  vpc_id      = aws_vpc.main.id

  # Public inbound on the app port — chaos triggering and health checks from CI
  ingress {
    description = "pricing-service HTTP"
    from_port   = local.pricing_port
    to_port     = local.pricing_port
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  # Unrestricted egress: ECR, SSM, CloudWatch Logs, Datadog
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "pricing-service-sg" }
}

resource "aws_security_group" "order_service" {
  name        = "order-service-sg"
  description = "order-service host: port 8082 public + unrestricted egress"
  vpc_id      = aws_vpc.main.id

  # Public inbound on the app port
  ingress {
    description = "order-service HTTP"
    from_port   = local.order_port
    to_port     = local.order_port
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  # Unrestricted egress — order-service calls pricing-service via private IP,
  # plus ECR, SSM, CloudWatch Logs, Datadog
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "order-service-sg" }
}

# ── EC2 hosts ─────────────────────────────────────────────────────────────────
# One t3.small per service.  user_data sets the ECS module attribute so the
# placement constraint in each ECS service pins the task to the right host.

resource "aws_instance" "host_pricing_service" {
  ami                    = data.aws_ssm_parameter.ecs_ami.value
  instance_type          = "t3.small"
  subnet_id              = aws_subnet.public[0].id
  vpc_security_group_ids = [aws_security_group.pricing_service.id]
  iam_instance_profile   = aws_iam_instance_profile.ecs_instance.name

  user_data = base64encode(<<-EOF
    #!/bin/bash
    cat >> /etc/ecs/ecs.config <<'ECSEOF'
    ECS_CLUSTER=${aws_ecs_cluster.main.name}
    ECS_INSTANCE_ATTRIBUTES={"module":"pricing-service"}
    ECSEOF
  EOF
  )

  tags = {
    Name   = "pricing-service-host"
    Module = "pricing-service"
  }
}

resource "aws_instance" "host_order_service" {
  ami                    = data.aws_ssm_parameter.ecs_ami.value
  instance_type          = "t3.small"
  subnet_id              = aws_subnet.public[0].id
  vpc_security_group_ids = [aws_security_group.order_service.id]
  iam_instance_profile   = aws_iam_instance_profile.ecs_instance.name

  user_data = base64encode(<<-EOF
    #!/bin/bash
    cat >> /etc/ecs/ecs.config <<'ECSEOF'
    ECS_CLUSTER=${aws_ecs_cluster.main.name}
    ECS_INSTANCE_ATTRIBUTES={"module":"order-service"}
    ECSEOF
  EOF
  )

  tags = {
    Name   = "order-service-host"
    Module = "order-service"
  }
}

# ── CloudWatch log groups ─────────────────────────────────────────────────────

resource "aws_cloudwatch_log_group" "pricing_service" {
  name              = "/ecs/pricing-service"
  retention_in_days = 7

  tags = { Service = "pricing-service" }
}

resource "aws_cloudwatch_log_group" "order_service" {
  name              = "/ecs/order-service"
  retention_in_days = 7

  tags = { Service = "order-service" }
}

# ── ECS task definition: pricing-service ─────────────────────────────────────
# Two containers: pricing-service app + dd-agent sidecar.
# Shared Docker volume (task-scoped) so the agent can tail the app log file.

resource "aws_ecs_task_definition" "pricing_service" {
  family                   = "pricing-service"
  network_mode             = "bridge"
  requires_compatibilities = ["EC2"]
  task_role_arn            = aws_iam_role.ecs_task.arn
  execution_role_arn       = aws_iam_role.ecs_task_execution.arn

  volume {
    name = "pricing-logs"
    docker_volume_configuration {
      scope  = "task"
      driver = "local"
    }
  }

  container_definitions = jsonencode([
    {
      name      = "pricing-service"
      image     = local.pricing_image
      essential = true
      cpu       = 384
      memory    = 512

      portMappings = [
        { containerPort = local.pricing_port, hostPort = local.pricing_port, protocol = "tcp" }
      ]

      environment = [
        { name = "DD_ENV",             value = var.environment },
        { name = "DD_SERVICE",         value = "pricing-service" },
        { name = "DD_VERSION",         value = "2.1.0" },
        { name = "DD_SITE",            value = var.dd_site },
        { name = "DD_LOGS_INJECTION",  value = "true" },
        { name = "LOGGING_FILE_NAME",  value = "/var/log/pricing-service/app.log" },
      ]

      secrets = [
        { name = "DD_API_KEY", valueFrom = aws_ssm_parameter.dd_api_key.arn },
      ]

      mountPoints = [
        { sourceVolume = "pricing-logs", containerPath = "/var/log/pricing-service", readOnly = false }
      ]

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.pricing_service.name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "pricing-service"
        }
      }

      healthCheck = {
        command     = ["CMD-SHELL", "curl -sf http://localhost:${local.pricing_port}/api/v1/pricing/health || exit 1"]
        interval    = 30
        timeout     = 5
        retries     = 3
        startPeriod = 60
      }
    },

    # dd-agent sidecar — tails /var/log/pricing-service/app.log and ships to Datadog
    {
      name      = "dd-agent"
      image     = local.dd_agent_image
      essential = false
      cpu       = 128
      memory    = 256

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

      mountPoints = [
        { sourceVolume = "pricing-logs", containerPath = "/var/log/pricing-service", readOnly = true }
      ]

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.pricing_service.name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "dd-agent-pricing"
        }
      }
    }
  ])

  tags = { Service = "pricing-service" }
}

# ── ECS task definition: order-service ───────────────────────────────────────
# PRICING_SERVICE_URL is injected only when var.pricing_service_url is set.
# When absent, Spring Boot uses the application.yml default (localhost:8081).

resource "aws_ecs_task_definition" "order_service" {
  family                   = "order-service"
  network_mode             = "bridge"
  requires_compatibilities = ["EC2"]
  task_role_arn            = aws_iam_role.ecs_task.arn
  execution_role_arn       = aws_iam_role.ecs_task_execution.arn

  volume {
    name = "order-logs"
    docker_volume_configuration {
      scope  = "task"
      driver = "local"
    }
  }

  container_definitions = jsonencode([
    {
      name      = "order-service"
      image     = local.order_image
      essential = true
      cpu       = 384
      memory    = 512

      portMappings = [
        { containerPort = local.order_port, hostPort = local.order_port, protocol = "tcp" }
      ]

      # Merge static env vars with the optional PRICING_SERVICE_URL entry.
      # local.order_pricing_env is [] when pricing_service_url is empty, so
      # concat is a no-op — the env var is simply absent and Spring Boot falls
      # back to its application.yml default.
      environment = concat(
        [
          { name = "DD_ENV",            value = var.environment },
          { name = "DD_SERVICE",        value = "order-service" },
          { name = "DD_VERSION",        value = "1.3.0" },
          { name = "DD_SITE",           value = var.dd_site },
          { name = "DD_LOGS_INJECTION", value = "true" },
          { name = "LOGGING_FILE_NAME", value = "/var/log/order-service/app.log" },
        ],
        local.order_pricing_env,
      )

      secrets = [
        { name = "DD_API_KEY", valueFrom = aws_ssm_parameter.dd_api_key.arn },
      ]

      mountPoints = [
        { sourceVolume = "order-logs", containerPath = "/var/log/order-service", readOnly = false }
      ]

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.order_service.name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "order-service"
        }
      }

      healthCheck = {
        command     = ["CMD-SHELL", "curl -sf http://localhost:${local.order_port}/api/v1/orders/health || exit 1"]
        interval    = 30
        timeout     = 5
        retries     = 3
        startPeriod = 60
      }
    },

    # dd-agent sidecar — tails /var/log/order-service/app.log and ships to Datadog
    {
      name      = "dd-agent"
      image     = local.dd_agent_image
      essential = false
      cpu       = 128
      memory    = 256

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

      mountPoints = [
        { sourceVolume = "order-logs", containerPath = "/var/log/order-service", readOnly = true }
      ]

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.order_service.name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "dd-agent-order"
        }
      }
    }
  ])

  tags = { Service = "order-service" }
}

# ── ECS services ──────────────────────────────────────────────────────────────
# Each service is pinned to its dedicated EC2 host via a placement constraint
# that matches the module attribute written into /etc/ecs/ecs.config by user_data.

resource "aws_ecs_service" "pricing_service" {
  name            = "pricing-service"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.pricing_service.arn
  desired_count   = 1
  launch_type     = "EC2"

  placement_constraints {
    type       = "memberOf"
    expression = "attribute:module == pricing-service"
  }

  # Ensure the EC2 host is registered with ECS before the service tries to place a task
  depends_on = [aws_instance.host_pricing_service]

  tags = { Service = "pricing-service" }
}

resource "aws_ecs_service" "order_service" {
  name            = "order-service"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.order_service.arn
  desired_count   = 1
  launch_type     = "EC2"

  placement_constraints {
    type       = "memberOf"
    expression = "attribute:module == order-service"
  }

  depends_on = [aws_instance.host_order_service]

  tags = { Service = "order-service" }
}

# ── Outputs ───────────────────────────────────────────────────────────────────

output "pricing_service_private_ip" {
  description = "Private IP of the pricing-service host. Copy this into pricing_service_url in terraform.tfvars for the cross-service demo, then re-apply."
  value       = aws_instance.host_pricing_service.private_ip
}

output "order_service_private_ip" {
  description = "Private IP of the order-service host."
  value       = aws_instance.host_order_service.private_ip
}

output "pricing_service_ecr_url" {
  description = "ECR repository URL for pricing-service images."
  value       = aws_ecr_repository.pricing_service.repository_url
}

output "order_service_ecr_url" {
  description = "ECR repository URL for order-service images."
  value       = aws_ecr_repository.order_service.repository_url
}

output "pricing_service_chaos_endpoint" {
  description = "Public chaos endpoint for pricing-service."
  value       = "http://${aws_instance.host_pricing_service.public_ip}:${local.pricing_port}/chaos"
}

output "order_service_chaos_endpoint" {
  description = "Public chaos endpoint for order-service."
  value       = "http://${aws_instance.host_order_service.public_ip}:${local.order_port}/chaos"
}

output "cross_service_demo_next_step" {
  description = "After first apply: add this to terraform.tfvars to enable cross-service demo (Bug A)."
  value       = "pricing_service_url = \"http://${aws_instance.host_pricing_service.private_ip}:${local.pricing_port}\""
}
