terraform {
  required_providers {
    datadog = {
      source  = "DataDog/datadog"
      version = "~> 3.0"
    }
  }

  # Uncomment to store state in S3 (recommended for team use)
  # backend "s3" {
  #   bucket = "oscorpai-terraform-state"
  #   key    = "rca-agent/datadog-monitor/terraform.tfstate"
  #   region = "us-east-1"
  # }
}

provider "datadog" {
  api_key = var.datadog_api_key
  app_key = var.datadog_app_key
}

# ── APM Error Rate Monitor ─────────────────────────────────────────────────

resource "datadog_monitor" "banking_app_errors" {
  name    = "Banking App - Error Rate Spike"
  type    = "metric alert"
  message = <<-EOT
    ## Error Rate Spike Detected

    Service **banking-app** in environment **production** has exceeded the error threshold.

    - **Alert value**: {{value}} errors in last 5 minutes
    - **Threshold**: {{threshold}} errors

    Triggering RCA analysis automatically. @webhook-rca-agent

    Notify: @platform-team
  EOT

  query = "sum(last_5m):sum:trace.servlet.request.errors{service:banking-app,env:production}.as_count() > 5"

  monitor_thresholds {
    critical          = 5
    critical_recovery = 2
    warning           = 2
    warning_recovery  = 1
  }

  # Only alert if condition persists for 1 evaluation window
  require_full_window = false
  notify_no_data      = false
  renotify_interval   = 60   # re-notify every 60 minutes if still firing

  # Prevent alert storms — wait 300s before re-triggering
  new_group_delay = 300

  tags = [
    "env:production",
    "service:banking-app",
    "team:platform",
    "managed-by:terraform",
    "rca-agent:enabled",
  ]
}

# ── RCA Agent Webhook ──────────────────────────────────────────────────────

resource "datadog_webhook" "rca_agent" {
  name    = "rca-agent"
  url     = var.rca_agent_webhook_url
  encode_as = "json"

  custom_headers = jsonencode({
    "Content-Type" = "application/json"
    "X-RCA-Source" = "datadog"
    "X-RCA-Version" = "0.3"
  })

  # Payload maps Datadog template variables to our ErrorIngestionAgent schema.
  # These map to DatadogAlertPayload fields in error-ingestion-agent/datadog_webhook.py
  payload = jsonencode({
    service     = "$HOSTNAME"
    environment = "$ENV"
    alert_id    = "$ALERT_ID"
    alert_title = "$ALERT_TITLE"
    metric      = "$METRIC_NAMESPACE"
    value       = "$ALERT_METRIC"
    timestamp   = "$LAST_UPDATED"
    tags        = "$TAGS"
    body        = "$EVENT_MSG"
  })
}

# ── Outputs ────────────────────────────────────────────────────────────────

output "monitor_id" {
  description = "Datadog monitor ID — add to projects.yaml under datadog.monitor_ids"
  value       = datadog_monitor.banking_app_errors.id
}

output "webhook_name" {
  description = "Datadog webhook name (reference in monitor messages as @webhook-<name>)"
  value       = datadog_webhook.rca_agent.name
}

output "rca_webhook_url" {
  description = "The RCA agent endpoint configured as the webhook target"
  value       = var.rca_agent_webhook_url
}
