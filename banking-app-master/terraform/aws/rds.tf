# ─────────────────────────────────────────────────────────────────────────────
# terraform/aws/rds.tf — RDS MySQL (shared rca_db)
# ─────────────────────────────────────────────────────────────────────────────

resource "aws_db_subnet_group" "main" {
  name       = "banking-app-db-subnet-group"
  subnet_ids = aws_subnet.private[*].id

  tags = { Name = "banking-app-db-subnet-group" }
}

resource "aws_db_instance" "rca_db" {
  identifier        = "banking-app-rca-db"
  engine            = "mysql"
  engine_version    = "8.0"
  instance_class    = var.rds_instance_class
  allocated_storage = var.rds_allocated_storage_gb
  storage_type      = "gp3"
  storage_encrypted = true

  db_name  = var.rds_db_name
  username = var.rds_username
  # Password is injected from Secrets Manager at apply time.
  # The ECS tasks read it via the same secret at runtime.
  password = jsondecode(aws_secretsmanager_secret_version.rds_password.secret_string)["value"]

  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.rds.id]
  publicly_accessible    = false

  # Backups — keep 7 days in production
  backup_retention_period = 7
  backup_window           = "03:00-04:00"
  maintenance_window      = "Mon:04:00-Mon:05:00"

  # Prevent accidental deletion
  deletion_protection = false  # set to true after initial testing

  # Don't take a final snapshot on destroy (speeds up tear-down in dev)
  skip_final_snapshot = true

  tags = { Name = "banking-app-rca-db" }

  # Wait for the secret version to exist before reading it
  depends_on = [aws_secretsmanager_secret_version.rds_password]
}

# The actual secret value must be set manually after terraform apply.
# We create an initial placeholder here so the resource exists.
resource "aws_secretsmanager_secret_version" "rds_password" {
  secret_id     = aws_secretsmanager_secret.rds_password.id
  secret_string = jsonencode({ value = "REPLACE_ME_BEFORE_FIRST_DEPLOY" })

  lifecycle {
    # Ignore future changes — the real password is managed outside Terraform
    # (set via AWS Console or CLI, not tracked in state to avoid secrets leak)
    ignore_changes = [secret_string]
  }
}

# Convenience local for ECS task database URL construction
locals {
  database_url = "mysql+pymysql://${var.rds_username}:REPLACE_WITH_SECRET@${aws_db_instance.rca_db.address}:3306/${var.rds_db_name}"
}
