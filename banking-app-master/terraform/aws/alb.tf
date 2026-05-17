# ─────────────────────────────────────────────────────────────────────────────
# terraform/aws/alb.tf — Application Load Balancer
#
# Two target groups on port 80:
#   /        → banking-app (port 8080)
#   /rca*    → rca-agent   (port 8000)
#   /demo*   → rca-agent   (port 8000)
#   /health  → rca-agent   (port 8000)
#
# No HTTPS — HTTP only per project requirements.
# ─────────────────────────────────────────────────────────────────────────────

resource "aws_lb" "main" {
  name               = "banking-app-alb"
  internal           = false
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = aws_subnet.public[*].id

  enable_deletion_protection = false

  tags = { Name = "banking-app-alb" }
}

# ── Target groups ─────────────────────────────────────────────────────────────

resource "aws_lb_target_group" "banking_app" {
  name        = "banking-app-tg"
  port        = 8080
  protocol    = "HTTP"
  vpc_id      = aws_vpc.main.id
  target_type = "ip"

  health_check {
    path                = "/actuator/health"
    interval            = 30
    timeout             = 10
    healthy_threshold   = 2
    unhealthy_threshold = 3
    matcher             = "200"
  }

  tags = { Name = "banking-app-tg" }
}

resource "aws_lb_target_group" "rca_agent" {
  name        = "rca-agent-tg"
  port        = 8000
  protocol    = "HTTP"
  vpc_id      = aws_vpc.main.id
  target_type = "ip"

  health_check {
    path                = "/health"
    interval            = 30
    timeout             = 10
    healthy_threshold   = 2
    unhealthy_threshold = 3
    matcher             = "200"
  }

  tags = { Name = "rca-agent-tg" }
}

# ── HTTP listener with path-based routing ─────────────────────────────────────

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.main.arn
  port              = 80
  protocol          = "HTTP"

  # Default: banking-app (the user-facing service)
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.banking_app.arn
  }
}

# Route RCA agent paths to rca-agent target group
resource "aws_lb_listener_rule" "rca_agent" {
  listener_arn = aws_lb_listener.http.arn
  priority     = 10

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.rca_agent.arn
  }

  condition {
    path_pattern {
      values = ["/rca*", "/demo*", "/health", "/openapi.json", "/docs*"]
    }
  }
}
