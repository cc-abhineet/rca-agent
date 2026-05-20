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

# Allow ECS to read SSM Parameter Store parameters (free tier — no per-secret charge)
# SSM SecureString parameters encrypted with the default aws/ssm KMS key
# are readable via ssm:GetParameters without an explicit kms:Decrypt grant.
resource "aws_iam_role_policy" "ecs_task_execution_secrets" {
  name = "ecs-read-banking-app-ssm-params"
  role = aws_iam_role.ecs_task_execution.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "ssm:GetParameters",
        "ssm:GetParameter",
      ]
      Resource = [
        aws_ssm_parameter.database_url.arn,
        aws_ssm_parameter.anthropic_api_key.arn,
        aws_ssm_parameter.github_pat.arn,
        aws_ssm_parameter.gemini_api_key.arn,
        aws_ssm_parameter.dd_api_key.arn,
        aws_ssm_parameter.dd_app_key.arn,
        aws_ssm_parameter.rds_password.arn,
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

resource "aws_cloudwatch_log_group" "monitored_app" {
  name              = "/ecs/banking-app/${var.monitored_app.service_name}"
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
  retention_in_days = 7  # reduced from 30 to limit CloudWatch storage costs
}
