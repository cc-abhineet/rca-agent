# ── Required variables ─────────────────────────────────────────────────────

variable "datadog_api_key" {
  description = "Datadog API key (from https://app.datadoghq.com/organization-settings/api-keys)"
  type        = string
  sensitive   = true
}

variable "datadog_app_key" {
  description = "Datadog Application key (from https://app.datadoghq.com/organization-settings/application-keys)"
  type        = string
  sensitive   = true
}

variable "rca_agent_webhook_url" {
  description = <<-EOT
    Public URL of the rca-agent ALB + webhook endpoint.
    Format: https://<rca-agent-alb-dns>/rca/ingest/datadog
    Example: https://rca-agent-alb-1234567890.us-east-1.elb.amazonaws.com/rca/ingest/datadog
  EOT
  type        = string

  validation {
    condition     = can(regex("^https?://.+/rca/ingest/datadog$", var.rca_agent_webhook_url))
    error_message = "rca_agent_webhook_url must be a full URL ending in /rca/ingest/datadog"
  }
}

# ── Optional variables ─────────────────────────────────────────────────────

variable "datadog_site" {
  description = "Datadog site (us1=datadoghq.com, eu1=datadoghq.eu, us3=us3.datadoghq.com)"
  type        = string
  default     = "datadoghq.com"
}

variable "monitor_critical_threshold" {
  description = "Number of errors in 5m to trigger CRITICAL alert"
  type        = number
  default     = 5
}

variable "monitor_warning_threshold" {
  description = "Number of errors in 5m to trigger WARNING"
  type        = number
  default     = 2
}

variable "tags" {
  description = "Additional tags to apply to all Datadog resources"
  type        = list(string)
  default     = []
}
