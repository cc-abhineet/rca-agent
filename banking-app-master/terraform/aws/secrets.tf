# ─────────────────────────────────────────────────────────────────────────────
# terraform/aws/secrets.tf — AWS Secrets Manager secrets
#
# Secrets are created as EMPTY placeholders by Terraform.
# After terraform apply, populate each secret's value in the AWS Console or
# with the AWS CLI before starting ECS services:
#
#   aws secretsmanager put-secret-value \
#     --secret-id banking-app/production/anthropic-api-key \
#     --secret-string '{"value":"sk-ant-..."}'
#
# ECS tasks reference secrets via their ARN — values are injected as env vars
# at task start time.  Rotating a secret does NOT require a new image.
# ─────────────────────────────────────────────────────────────────────────────

locals {
  secret_prefix = "banking-app/${var.environment}"
}

resource "aws_secretsmanager_secret" "anthropic_api_key" {
  name                    = "${local.secret_prefix}/anthropic-api-key"
  description             = "Anthropic Claude API key for rca-agent"
  recovery_window_in_days = 0  # instant delete — OK for non-prod; set to 7+ for prod
}

resource "aws_secretsmanager_secret" "github_pat" {
  name                    = "${local.secret_prefix}/github-pat"
  description             = "GitHub Personal Access Token (repo:read) for rca-agent"
  recovery_window_in_days = 0
}

resource "aws_secretsmanager_secret" "gemini_api_key" {
  name                    = "${local.secret_prefix}/gemini-api-key"
  description             = "Google Gemini API key for error-ingestion-agent (analyze node)"
  recovery_window_in_days = 0
}

resource "aws_secretsmanager_secret" "dd_api_key" {
  name                    = "${local.secret_prefix}/dd-api-key"
  description             = "Datadog API key for ingestion-agent and dd-agent sidecar"
  recovery_window_in_days = 0
}

resource "aws_secretsmanager_secret" "dd_app_key" {
  name                    = "${local.secret_prefix}/dd-app-key"
  description             = "Datadog Application key for ingestion-agent Logs API polling"
  recovery_window_in_days = 0
}

resource "aws_secretsmanager_secret" "rds_password" {
  name                    = "${local.secret_prefix}/rds-password"
  description             = "RDS MySQL master password"
  recovery_window_in_days = 0
}
