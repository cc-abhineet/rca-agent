# terraform/aws/alb.tf

# The lower-cost deployment variant removes the Application Load Balancer
# and routes traffic directly to ECS EC2 tasks running on a public container instance.
# This reduces cost by avoiding ALB hourly/load and eliminates the NAT gateway.
