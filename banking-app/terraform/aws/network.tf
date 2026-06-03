# ─────────────────────────────────────────────────────────────────────────────
# terraform/aws/network.tf — VPC, subnets, IGW, route tables, security groups
#
# Each service runs on its own EC2 host with its own security group so that
# only the port that service actually serves is exposed publicly. The RDS SG
# accepts MySQL from all three app SGs.
# ─────────────────────────────────────────────────────────────────────────────

# ── VPC ───────────────────────────────────────────────────────────────────────

resource "aws_vpc" "main" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = { Name = "banking-app-vpc" }
}

# ── Public subnets ───────────────────────────────────────────────────────────

resource "aws_subnet" "public" {
  count                   = length(var.availability_zones)
  vpc_id                  = aws_vpc.main.id
  cidr_block              = cidrsubnet(var.vpc_cidr, 8, count.index)
  availability_zone       = var.availability_zones[count.index]
  map_public_ip_on_launch = true

  tags = { Name = "banking-app-public-${var.availability_zones[count.index]}" }
}

# ── Internet Gateway ──────────────────────────────────────────────────────────

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = "banking-app-igw" }
}

# ── Public route table ────────────────────────────────────────────────────────

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }

  tags = { Name = "banking-app-public-rt" }
}

resource "aws_route_table_association" "public" {
  count          = length(aws_subnet.public)
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

# ── Security Groups — one per service host ────────────────────────────────────
#
# Each host's SG opens only the port that service serves. All three allow
# unrestricted egress so the tasks can reach ECR, SSM, CloudWatch Logs, GitHub,
# Anthropic, Datadog, etc.

# Monitored-app host — exposes the configurable app port (default 8080)
resource "aws_security_group" "monitored_app" {
  name        = "banking-app-monitored-app-sg"
  description = "Monitored-app EC2 host: public access on the configured app port"
  vpc_id      = aws_vpc.main.id

  ingress {
    from_port   = var.monitored_app.port
    to_port     = var.monitored_app.port
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "banking-app-monitored-app-sg" }
}

# Ingestion-agent host — no inbound (poll-only, no HTTP server)
resource "aws_security_group" "ingestion_agent" {
  name        = "banking-app-ingestion-agent-sg"
  description = "Ingestion-agent EC2 host: poll-only, no inbound traffic"
  vpc_id      = aws_vpc.main.id

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "banking-app-ingestion-agent-sg" }
}

# rca-agent host — exposes port 8000 (FastAPI)
resource "aws_security_group" "rca_agent" {
  name        = "banking-app-rca-agent-sg"
  description = "rca-agent EC2 host: public access on port 8000 (FastAPI)"
  vpc_id      = aws_vpc.main.id

  ingress {
    from_port   = 8000
    to_port     = 8000
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "banking-app-rca-agent-sg" }
}

# RDS — accept MySQL only from the three app SGs
resource "aws_security_group" "rds" {
  name        = "banking-app-rds-sg"
  description = "RDS MySQL: inbound from the three app host SGs only"
  vpc_id      = aws_vpc.main.id

  ingress {
    from_port = 3306
    to_port   = 3306
    protocol  = "tcp"
    security_groups = [
      aws_security_group.monitored_app.id,
      aws_security_group.ingestion_agent.id,
      aws_security_group.rca_agent.id,
    ]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "banking-app-rds-sg" }
}
