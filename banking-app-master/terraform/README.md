# Terraform

This directory contains two separate Terraform configurations:

## terraform/aws/ — Full AWS Infrastructure

Deploys the complete RCA platform to AWS ECS on **three EC2 container instances — one per service**. Each service is pinned to its dedicated host via ECS placement constraints (`attribute:module == ...`), and each host is right-sized to its task's memory needs. See `AWS_DEPLOYMENT.md` for the full guide.

Creates: VPC, RDS MySQL, ECS cluster with three EC2 hosts (`monitored-app`, `ingestion-agent`, `rca-agent`), four ECR repos, per-host security groups, SSM Parameter Store secrets, IAM roles.

The **monitored-app slot is fully parameterized** via the `monitored_app` object variable — swap banking-app for any other service by editing one block in `terraform.tfvars` (image, port, sizing, env vars, optional Datadog sidecar). The ingestion-agent and rca-agent hosts are untouched by an app swap.

```bash
cd terraform/aws
cp terraform.tfvars.example terraform.tfvars
terraform init && terraform apply -var-file=terraform.tfvars
```

## terraform/ (root) — Datadog Monitor & Webhook (legacy / optional)

This configuration creates:
1. A **Datadog APM error rate monitor** for the banking-app service
2. A **Datadog webhook** that fires to the rca-agent's public endpoint when the monitor alerts

> **Note:** The primary integration mode is now `MODE=datadog_poll` (ingestion agent polls Datadog Logs API directly). The webhook and monitor in this directory are kept as a reference and fallback — they are not required for the polling architecture.

## Prerequisites

- [Terraform](https://www.terraform.io/downloads) >= 1.5
- Datadog account with APM enabled
- rca-agent deployed to AWS with a public ALB endpoint

## Setup

### 1. Create a tfvars file

```bash
cp prod.tfvars.example prod.tfvars
```

Edit `prod.tfvars`:

```hcl
datadog_api_key       = "your-datadog-api-key"
datadog_app_key       = "your-datadog-app-key"
rca_agent_webhook_url = "https://rca-agent-alb-xxxx.us-east-1.elb.amazonaws.com/rca/ingest/datadog"
```

> **Never commit prod.tfvars** — it contains secrets. It is already in `.gitignore`.

### 2. Initialize and apply

```bash
cd terraform/
terraform init
terraform plan -var-file=prod.tfvars
terraform apply -var-file=prod.tfvars
```

### 3. Update projects.yaml

After apply, copy the `monitor_id` output into `projects.yaml`:

```yaml
datadog:
  service_name: banking-app
  env: production
  monitor_ids:
    - <monitor_id output value>
```

## How it works

```
banking-app (ECS)
    │ APM traces
    ▼
Datadog APM
    │ trace.servlet.request.errors > 5 in 5m
    ▼
datadog_monitor.banking_app_errors fires
    │ @webhook-rca-agent
    ▼
datadog_webhook.rca_agent
    │ POST https://<rca-agent-alb>/rca/ingest/datadog
    ▼
RCA Agent → inserts error_incident → runs Claude analysis → posts result to Datadog Logs
```

## Cleanup

```bash
terraform destroy -var-file=prod.tfvars
```

## Variable Reference

| Variable | Description | Required |
|----------|-------------|----------|
| `datadog_api_key` | Datadog API key | ✓ |
| `datadog_app_key` | Datadog app key | ✓ |
| `rca_agent_webhook_url` | Full URL to rca-agent webhook endpoint | ✓ |
| `datadog_site` | Datadog site (default: datadoghq.com) | — |
| `monitor_critical_threshold` | Error count for CRITICAL (default: 5) | — |
| `monitor_warning_threshold` | Error count for WARNING (default: 2) | — |
