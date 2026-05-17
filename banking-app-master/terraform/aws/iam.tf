# ─────────────────────────────────────────────────────────────────────────────
# terraform/aws/iam.tf — IAM roles and policies for ECS tasks
# ─────────────────────────────────────────────────────────────────────────────

# ── ECS Task Execution Role ───────────────────────────────────────────────────
# Used by the ECS agent to pull images from ECR and inject secrets.

resource "aws_iam_role" "ecs_task_execution" {
  name = "banking-app-ecs-task-execution-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "ecs_task_execution_managed" {
  role       = aws_iam_role.ecs_task_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# Allow ECS to read our specific secrets (least-privilege)
resource "aws_iam_role_policy" "ecs_task_execution_secrets" {
  name = "ecs-read-banking-app-secrets"
  role = aws_iam_role.ecs_task_execution.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "secretsmanager:GetSecretValue",
        "secretsmanager:DescribeSecret",
      ]
      Resource = [
        aws_secretsmanager_secret.anthropic_api_key.arn,
        aws_secretsmanager_secret.github_pat.arn,
        aws_secretsmanager_secret.gemini_api_key.arn,
        aws_secretsmanager_secret.dd_api_key.arn,
        aws_secretsmanager_secret.dd_app_key.arn,
        aws_secretsmanager_secret.rds_password.arn,
      ]
    }]
  })
}

# ── ECS Task Role ─────────────────────────────────────────────────────────────
# Attached to running containers for application-level AWS API calls.
# Currently only needs CloudWatch Logs write permission.

resource "aws_iam_role" "ecs_task" {
  name = "banking-app-ecs-task-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "ecs_task_cloudwatch" {
  name = "ecs-write-cloudwatch-logs"
  role = aws_iam_role.ecs_task.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "logs:CreateLogGroup",
        "logs:CreateLogStream",
        "logs:PutLogEvents",
        "logs:DescribeLogStreams",
      ]
      Resource = "arn:aws:logs:${var.aws_region}:*:log-group:/ecs/banking-app*"
    }]
  })
}

# ── CloudWatch Log Groups ──────────────────────────────────────────────────────

resource "aws_cloudwatch_log_group" "banking_app" {
  name              = "/ecs/banking-app/banking-app"
  retention_in_days = 14
}

resource "aws_cloudwatch_log_group" "dd_agent" {
  name              = "/ecs/banking-app/dd-agent"
  retention_in_days = 7
}

resource "aws_cloudwatch_log_group" "ingestion_agent" {
  name              = "/ecs/banking-app/ingestion-agent"
  retention_in_days = 14
}

resource "aws_cloudwatch_log_group" "rca_agent" {
  name              = "/ecs/banking-app/rca-agent"
  retention_in_days = 30
}
