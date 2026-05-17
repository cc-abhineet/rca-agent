# ─────────────────────────────────────────────────────────────────────────────
# terraform/aws/outputs.tf
# ─────────────────────────────────────────────────────────────────────────────

output "alb_dns_name" {
  description = "ALB DNS name — use this as the entry point for all services"
  value       = aws_lb.main.dns_name
}

output "banking_app_url" {
  description = "Banking app root URL (H2 console disabled in production)"
  value       = "http://${aws_lb.main.dns_name}/"
}

output "rca_demo_url" {
  description = "RCA agent demo UI URL"
  value       = "http://${aws_lb.main.dns_name}/demo"
}

output "rca_health_url" {
  description = "RCA agent health check URL"
  value       = "http://${aws_lb.main.dns_name}/health"
}

output "banking_app_chaos_url" {
  description = "Banking app chaos endpoint (POST /chaos/{scenario})"
  value       = "http://${aws_lb.main.dns_name}/chaos/scenarios"
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

output "secret_arns" {
  description = "Secrets Manager ARNs — populate these before starting ECS services"
  value = {
    anthropic_api_key = aws_secretsmanager_secret.anthropic_api_key.arn
    github_pat        = aws_secretsmanager_secret.github_pat.arn
    gemini_api_key    = aws_secretsmanager_secret.gemini_api_key.arn
    dd_api_key        = aws_secretsmanager_secret.dd_api_key.arn
    dd_app_key        = aws_secretsmanager_secret.dd_app_key.arn
    rds_password      = aws_secretsmanager_secret.rds_password.arn
  }
}

output "next_steps" {
  description = "Post-apply checklist"
  value = <<-EOT
    ── Post-apply checklist ──────────────────────────────────────────────────
    1. Populate Secrets Manager (see secret_arns output above):
         aws secretsmanager put-secret-value --secret-id <arn> --secret-string '{"value":"<secret>"}'
       Secrets to populate: anthropic_api_key, github_pat, gemini_api_key, dd_api_key, dd_app_key, rds_password

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
         curl -X POST http://${aws_lb.main.dns_name}/chaos/null-pointer
         open http://${aws_lb.main.dns_name}/demo
    ─────────────────────────────────────────────────────────────────────────
  EOT
}
