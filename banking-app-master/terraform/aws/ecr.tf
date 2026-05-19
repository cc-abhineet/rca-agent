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

# Lifecycle policy — keep only the last 3 tagged images and purge untagged ones
# immediately. ECR gives 500 MB free; 4 repos × 3 images each stays well within
# that limit for typical demo-sized images (~100-200 MB each).
resource "aws_ecr_lifecycle_policy" "free_tier" {
  for_each = toset([
    aws_ecr_repository.banking_app.name,
    aws_ecr_repository.ingestion_agent.name,
    aws_ecr_repository.rca_agent.name,
    aws_ecr_repository.dd_agent.name,
  ])
  repository = each.value

  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Expire untagged images immediately"
        selection = {
          tagStatus   = "untagged"
          countType   = "sinceImagePushed"
          countUnit   = "days"
          countNumber = 1
        }
        action = { type = "expire" }
      },
      {
        rulePriority = 2
        description  = "Keep last 3 tagged images to stay within ECR free tier (500 MB)"
        selection = {
          tagStatus   = "tagged"
          tagPrefixList = ["latest", "v"]
          countType   = "imageCountMoreThan"
          countNumber = 3
        }
        action = { type = "expire" }
      }
    ]
  })
}
