# ─────────────────────────────────────────────────────────────────────────────
# terraform/aws/main.tf
#
# AWS infrastructure for the banking-app RCA platform.
#
# Services deployed:
#   banking-app        — Spring Boot app (H2 in-memory) + Datadog agent sidecar
#   ingestion-agent    — Python poller (MODE=datadog_poll)
#   rca-agent          — Python FastAPI (RCA_POLL_ENABLED=true)
#   MySQL (RDS)        — Shared rca_db for error_logs, service_repo_map, etc.
#
# All credentials are stored in AWS Secrets Manager and injected at task start.
# No secrets are baked into images or committed to source control.
#
# Apply:
#   cd terraform/aws
#   terraform init
#   terraform plan -var-file=terraform.tfvars
#   terraform apply -var-file=terraform.tfvars
#
# Prerequisite: push images to ECR first (see AWS_DEPLOYMENT.md).
# ─────────────────────────────────────────────────────────────────────────────

terraform {
  required_version = ">= 1.6"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  # Uncomment to store state in S3 — recommended for team use.
  # Create the bucket manually before running terraform init.
  # backend "s3" {
  #   bucket         = "oscorpai-terraform-state"
  #   key            = "banking-app/aws/terraform.tfstate"
  #   region         = "us-east-1"
  #   dynamodb_table = "terraform-locks"
  #   encrypt        = true
  # }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project     = "banking-app-rca"
      ManagedBy   = "terraform"
      Environment = var.environment
    }
  }
}
