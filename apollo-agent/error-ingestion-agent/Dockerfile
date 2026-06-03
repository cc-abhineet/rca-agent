# ─────────────────────────────────────────────────────────────────────────────
# error-ingestion-agent Dockerfile
#
# Build context: banking-app-master/ (repository root)
# This is required so that projects.yaml can be baked into the image for
# MODE=datadog_poll.  When building locally without docker compose use:
#
#   docker build -f error-ingestion-agent/Dockerfile -t ingestion-agent .
#
# ─────────────────────────────────────────────────────────────────────────────
FROM python:3.11-slim

WORKDIR /app

# No native PostgreSQL libs needed — aiomysql is pure Python
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc \
    && rm -rf /var/lib/apt/lists/*

# Install Python dependencies first (better layer caching)
COPY error-ingestion-agent/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy agent source code
COPY error-ingestion-agent/ .

# Bake projects.yaml into the image (used by MODE=datadog_poll to load the
# service list without a volume mount — swapping the monitored application
# is a projects.yaml edit + image rebuild, not a config map change).
# In AWS: image is rebuilt in CI and pushed to ECR; no secret in this file.
COPY projects.yaml /app/projects.yaml

# Create log directory for MODE=db (file-watcher mode)
RUN mkdir -p /var/log/banking-app

ENV MODE=db
ENV SERVICE_NAME=banking-app
ENV ENVIRONMENT=production

EXPOSE 8001

CMD ["python", "main.py"]
