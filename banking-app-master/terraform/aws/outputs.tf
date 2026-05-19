# ─────────────────────────────────────────────────────────────────────────────
# terraform/aws/outputs.tf
# ─────────────────────────────────────────────────────────────────────────────

output "ecs_cluster_name" {
  description = "ECS cluster name for the deployed services"
  value       = aws_ecs_cluster.main.name
}

output "ecs_instance_public_ip" {
  description = "Public IP address of the ECS EC2 container instance"
  value       = aws_instance.ecs_instance[0].public_ip
}

output "rds_endpoint" {
  description = "RDS MySQL endpoint — use this to construct DATABASE_URL"
  value       = aws_db_instance.rca_db.address
}

output "ecr_banking_app_uri" {
  description = "ECR URI for banking-app — use in docker push commands"
  value       = aws_ecr_repository.banking_app.repository_url
}

output "ecr_ingestion_agent_uri" {
  description = "ECR URI for ingestion-agent"
  value       = aws_ecr_repository.ingestion_agent.repository_url
}

output "ecr_rca_agent_uri" {
  description = "ECR URI for rca-agent"
  value       = aws_ecr_repository.rca_agent.repository_url
}

output "ecr_dd_agent_uri" {
  description = "ECR URI for dd-agent sidecar"
  value       = aws_ecr_repository.dd_agent.repository_url
}

output "ssm_parameter_names" {
  description = "SSM Parameter Store paths. rds_password and database_url are auto-populated by Terraform. The other five need manual overwrite (see Step 2 in AWS_DEPLOYMENT.md)."
  value = {
    # ── Auto-populated by Terraform (do NOT overwrite) ──
    rds_password  = aws_ssm_parameter.rds_password.name
    database_url  = aws_ssm_parameter.database_url.name
    # ── Set manually after terraform apply ──
    anthropic_api_key = aws_ssm_parameter.anthropic_api_key.name
    github_pat        = aws_ssm_parameter.github_pat.name
    gemini_api_key    = aws_ssm_parameter.gemini_api_key.name
    dd_api_key        = aws_ssm_parameter.dd_api_key.name
    dd_app_key        = aws_ssm_parameter.dd_app_key.name
  }
}

output "next_steps" {
  description = "Post-apply checklist"
  value = <<-EOT
    ── Post-apply checklist ──────────────────────────────────────────────────
    1. Populate SSM Parameter Store (see ssm_parameter_names output above):
         aws ssm put-parameter --name <name> --value <secret> --type SecureString --overwrite
       Parameters to set manually: anthropic_api_key, github_pat, gemini_api_key, dd_api_key, dd_app_key
       (rds_password and database_url are auto-populated by Terraform — do NOT overwrite)

    2. Build and push images to ECR (see AWS_DEPLOYMENT.md for full commands):
         aws ecr get-login-password | docker login --username AWS --password-stdin <ecr_base>
         docker build -t banking-app . && docker push <ecr_banking_app_uri>:latest
         docker build -f error-ingestion-agent/Dockerfile -t ingestion-agent . && docker push <ecr_ingestion_agent_uri>:latest
         docker build -t rca-agent ./rca-agent && docker push <ecr_rca_agent_uri>:latest
         docker build -t dd-agent ./datadog && docker push <ecr_dd_agent_uri>:latest

    3. Seed service_repo_map in RDS:
         python demo-repos/demo_seed_data.py --db-url mysql+pymysql://rcaadmin:<password>@<rds_endpoint>:3306/rca_db

    4. Run alembic migrations (from inside the rca-agent container or via ECS exec):
         alembic upgrade head

    5. Trigger a chaos scenario and watch the RCA report appear:
         # Find the public IP for the rca-agent task in the ECS console or with AWS CLI.
         # The rca-agent listens on port 8000 and the banking app listens on port 8080.
    ─────────────────────────────────────────────────────────────────────────
  EOT
}
