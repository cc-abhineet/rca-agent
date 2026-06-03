# ─────────────────────────────────────────────────────────────────────────────
# Datadog Agent — custom image with banking-app log config baked in
#
# This image is used as the sidecar container in the banking-app ECS task.
# It shares an ephemeral volume with the banking-app container to tail
# /var/log/banking-app/app.log and ship logs to Datadog.
#
# Build context: banking-app-master/datadog/
#
#   docker build -t dd-agent-banking ./datadog
#
# In AWS, this image is pushed to ECR alongside the other service images.
# Required env vars at runtime (injected from ECS Secrets Manager):
#   DD_API_KEY   — Datadog API key
#   DD_SITE      — Datadog site (default: datadoghq.com)
# ─────────────────────────────────────────────────────────────────────────────
FROM datadog/agent:7

# Bake the banking-app log collection configuration into the image.
# This config is read on agent start — no volume mount needed for config.
COPY conf.d/banking-app.d/conf.yaml \
     /etc/datadog-agent/conf.d/banking-app.d/conf.yaml

# Enable log collection globally (can also be set via DD_LOGS_ENABLED=true env)
ENV DD_LOGS_ENABLED=true
ENV DD_LOGS_CONFIG_CONTAINER_COLLECT_ALL=false

# The shared log volume is mounted at runtime by ECS / docker compose.
# The path /var/log/banking-app must be writable by banking-app and
# readable by this sidecar (both containers share the same ephemeral volume).
VOLUME ["/var/log/banking-app"]
