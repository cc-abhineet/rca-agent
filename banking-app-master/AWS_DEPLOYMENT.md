# AWS_DEPLOYMENT.md — Deploying the RCA Platform to AWS

This guide walks through deploying the full banking-app RCA pipeline to AWS ECS Fargate using the Terraform configuration in `terraform/aws/`.

**Architecture:** VPC → ALB → ECS Fargate (private subnets) → RDS MySQL (private subnets). All secrets in AWS Secrets Manager. No CI/CD pipeline — images are built and pushed manually.

**Services deployed:**
- `banking-app` — Spring Boot (H2 in-memory) + Datadog agent sidecar, on ALB port 80
- `ingestion-agent` — Python, MODE=datadog_poll (polls Datadog Logs API → RDS)
- `rca-agent` — Python FastAPI + poll loop (RCA_POLL_ENABLED=true), on ALB /rca* paths

---

## Prerequisites

- AWS CLI configured (`aws configure`) with permissions for ECS, ECR, RDS, ALB, VPC, IAM, Secrets Manager
- Terraform >= 1.6
- Docker (for building and pushing images)
- Real Datadog credentials (DD_API_KEY, DD_APP_KEY)
- Anthropic API key, GitHub PAT, Google Gemini API key

---

## Step 1 — Terraform Init & Apply

```bash
cd terraform/aws

# Create your tfvars file
cp terraform.tfvars.example terraform.tfvars
# Edit terraform.tfvars — fill in aws_region, environment, github_org, dd_site

terraform init
terraform plan -var-file=terraform.tfvars
terraform apply -var-file=terraform.tfvars
```

This creates (in order):
1. VPC, subnets, NAT gateway, security groups
2. RDS MySQL instance (takes ~5 minutes)
3. ECR repositories (4 repos)
4. Secrets Manager secrets (empty placeholders)
5. ECS cluster, task definitions, and services
6. ALB with target groups and routing rules

Note the outputs — you'll need them in the next steps:
```bash
terraform output alb_dns_name    # entry point for all traffic
terraform output rds_endpoint    # for constructing DATABASE_URL
terraform output ecr_*_uri       # for docker push commands
terraform output secret_arns     # for populating secrets
```

---

## Step 2 — Populate Secrets Manager

After apply, the secrets exist but are empty. Populate them before starting ECS services:

```bash
# Helper function
function put_secret() {
  aws secretsmanager put-secret-value \
    --secret-id "$1" \
    --secret-string "{\"value\":\"$2\"}"
}

# Get secret ARNs from terraform output
ANTHROPIC_ARN=$(terraform output -raw secret_arns | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['anthropic_api_key'])")

# Set each secret
put_secret "banking-app/production/anthropic-api-key" "sk-ant-..."
put_secret "banking-app/production/github-pat"         "ghp_..."
put_secret "banking-app/production/gemini-api-key"     "AIza..."
put_secret "banking-app/production/dd-api-key"         "<your-dd-api-key>"
put_secret "banking-app/production/dd-app-key"         "<your-dd-app-key>"
put_secret "banking-app/production/rds-password"       "<strong-password>"
```

> **Security:** These commands are run once after deploy. The secrets are referenced by ARN in ECS task definitions — not stored in any file or image.

---

## Step 3 — Build and Push Images to ECR

```bash
# Authenticate Docker with ECR
AWS_ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
AWS_REGION=us-east-1
ECR_BASE="${AWS_ACCOUNT}.dkr.ecr.${AWS_REGION}.amazonaws.com"

aws ecr get-login-password --region ${AWS_REGION} \
  | docker login --username AWS --password-stdin ${ECR_BASE}

# From the banking-app-master root:
cd banking-app-master

# 1. banking-app (Spring Boot + Java)
docker build -t banking-app .
docker tag banking-app:latest ${ECR_BASE}/banking-app:latest
docker push ${ECR_BASE}/banking-app:latest

# 2. error-ingestion-agent (context = repo root so projects.yaml can be baked in)
docker build -f error-ingestion-agent/Dockerfile -t ingestion-agent .
docker tag ingestion-agent:latest ${ECR_BASE}/banking-app/ingestion-agent:latest
docker push ${ECR_BASE}/banking-app/ingestion-agent:latest

# 3. rca-agent
docker build -t rca-agent ./rca-agent
docker tag rca-agent:latest ${ECR_BASE}/banking-app/rca-agent:latest
docker push ${ECR_BASE}/banking-app/rca-agent:latest

# 4. Datadog agent sidecar (custom image with banking-app log config baked in)
docker build -t dd-agent ./datadog
docker tag dd-agent:latest ${ECR_BASE}/banking-app/dd-agent:latest
docker push ${ECR_BASE}/banking-app/dd-agent:latest
```

> **Note:** After every code change, rebuild the affected image and push to ECR, then force a new ECS deployment:
> ```bash
> aws ecs update-service --cluster banking-app-cluster \
>   --service <service-name> --force-new-deployment
> ```

---

## Step 4 — Run Alembic Migrations

The `rca-agent` Dockerfile already runs `alembic upgrade head` in its CMD. On first deploy, ECS will run migrations automatically when the task starts.

If you need to run migrations manually (e.g., after a schema change):

```bash
# Connect to the rca-agent task via ECS Exec
aws ecs execute-command \
  --cluster banking-app-cluster \
  --task <task-id> \
  --container rca-agent \
  --interactive \
  --command "alembic upgrade head"
```

---

## Step 5 — Seed service_repo_map

The RCA agent needs to know which GitHub repo to search for each service. Run the seed script once after initial deploy:

```bash
# Get the RDS endpoint from terraform output
RDS_ENDPOINT=$(terraform -chdir=terraform/aws output -raw rds_endpoint)
RDS_PASSWORD="<password you set in Secrets Manager>"

python demo-repos/demo_seed_data.py \
  --org oscorpAI \
  --db-url "mysql+pymysql://rcaadmin:${RDS_PASSWORD}@${RDS_ENDPOINT}:3306/rca_db"
```

This inserts `banking-app`, `payment-service`, and `order-service` into `service_repo_map`.

---

## Step 6 — Verify the Deployment

```bash
ALB=$(terraform -chdir=terraform/aws output -raw alb_dns_name)

# 1. Check rca-agent health
curl http://${ALB}/health

# 2. Check banking-app health
curl http://${ALB}/actuator/health

# 3. List available chaos scenarios
curl http://${ALB}/chaos/scenarios | python3 -m json.tool

# 4. Trigger a NullPointerException
curl -X POST http://${ALB}/chaos/null-pointer

# 5. Wait 30-60 seconds, then check for pending RCA reports
curl http://${ALB}/demo
# Open in browser — the report should appear automatically
```

---

## Environment Variable Reference

### banking-app (ECS task)

| Env Var | Value | Source |
|---|---|---|
| SPRING_DATASOURCE_URL | jdbc:h2:mem:bankingdb... | Terraform (hardcoded H2) |
| LOGGING_FILE_NAME | /var/log/banking-app/app.log | Terraform |
| DD_API_KEY | Secrets Manager | ECS secrets[] |
| DD_ENV | production | Terraform variable |
| DD_SERVICE | banking-app | Terraform |

### ingestion-agent (ECS task)

| Env Var | Value | Source |
|---|---|---|
| MODE | datadog_poll | Terraform |
| DATABASE_URL | mysql+pymysql://... | Terraform (RDS endpoint) |
| GEMINI_API_KEY | Secrets Manager | ECS secrets[] |
| DD_API_KEY | Secrets Manager | ECS secrets[] |
| DD_APP_KEY | Secrets Manager | ECS secrets[] |
| DD_SITE | datadoghq.com | Terraform variable |
| POLL_INTERVAL_SECONDS | 30 | Terraform variable |
| PROJECTS_YAML_PATH | /app/projects.yaml | Terraform (baked into image) |

### rca-agent (ECS task)

| Env Var | Value | Source |
|---|---|---|
| DATABASE_URL | mysql+pymysql://... | Terraform (RDS endpoint) |
| ANTHROPIC_API_KEY | Secrets Manager | ECS secrets[] |
| GITHUB_PAT | Secrets Manager | ECS secrets[] |
| GITHUB_ORG | oscorpAI | Terraform variable |
| RCA_POLL_ENABLED | true | Terraform |
| RCA_POLL_INTERVAL_SECONDS | 30 | Terraform |

---

## Swapping the Monitored Application

The system is application-agnostic. To monitor a different application:

1. Update `projects.yaml` — add a new entry with `observability_mode: datadog`
2. Rebuild and push the ingestion-agent image (projects.yaml is baked in)
3. Force a new ECS deployment for `ingestion-agent`
4. Seed the new service in `service_repo_map`

No code changes required. Credentials stay in Secrets Manager.

---

## Cost Estimate (us-east-1, approximate)

| Resource | Spec | ~$/month |
|---|---|---|
| RDS MySQL db.t3.micro | 20 GB gp3 | ~$15 |
| ECS Fargate (3 tasks) | 256-1024 CPU, 512-2048 MB | ~$25 |
| ALB | 1 ALB + 2 target groups | ~$20 |
| NAT Gateway | 1 AZ | ~$35 |
| Secrets Manager | 6 secrets | ~$3 |
| ECR | 4 repos, ~1 GB | ~$1 |
| **Total** | | **~$100/month** |

> Tip: Stop ECS services when not demoing to reduce Fargate costs. RDS can be stopped for up to 7 days.

---

## Tearing Down

```bash
cd terraform/aws

# Stop ECS services first (avoids dependency issues during destroy)
aws ecs update-service --cluster banking-app-cluster --service banking-app --desired-count 0
aws ecs update-service --cluster banking-app-cluster --service ingestion-agent --desired-count 0
aws ecs update-service --cluster banking-app-cluster --service rca-agent --desired-count 0

# Destroy all infrastructure
terraform destroy -var-file=terraform.tfvars
```

> Secrets Manager secrets with `recovery_window_in_days = 0` are deleted immediately.
> ECR images must be deleted manually before the repositories can be destroyed — or set `force_delete = true` in the ECR resource.

---

## CI/CD (Not Implemented)

The project does not have a CI/CD pipeline. To deploy a code change:

1. Build the updated image locally
2. Push to ECR with a new tag (or `latest`)
3. Run `aws ecs update-service ... --force-new-deployment`

For a production setup, a GitHub Actions workflow would automate steps 1-3 on push to `main`. This is tracked as a future improvement.
