# ─────────────────────────────────────────────────────────────────────────────
# terraform/aws/ecr.tf — ECR repositories for all service images
# ─────────────────────────────────────────────────────────────────────────────

resource "aws_ecr_repository" "banking_app" {
  name                 = "banking-app"
  image_tag_mutability = "MUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  tags = { Service = "banking-app" }
}

resource "aws_ecr_repository" "ingestion_agent" {
  name                 = "banking-app/ingestion-agent"
  image_tag_mutability = "MUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  tags = { Service = "ingestion-agent" }
}

resource "aws_ecr_repository" "rca_agent" {
  name                 = "banking-app/rca-agent"
  image_tag_mutability = "MUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  tags = { Service = "rca-agent" }
}

resource "aws_ecr_repository" "dd_agent" {
  name                 = "banking-app/dd-agent"
  image_tag_mutability = "MUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  tags = { Service = "dd-agent" }
}

# Lifecycle policy — keep only the last 10 images to control storage costs
resource "aws_ecr_lifecycle_policy" "keep_last_10" {
  for_each   = toset([
    aws_ecr_repository.banking_app.name,
    aws_ecr_repository.ingestion_agent.name,
    aws_ecr_repository.rca_agent.name,
    aws_ecr_repository.dd_agent.name,
  ])
  repository = each.value

  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep last 10 images"
      selection = {
        tagStatus   = "any"
        countType   = "imageCountMoreThan"
        countNumber = 10
      }
      action = { type = "expire" }
    }]
  })
}
