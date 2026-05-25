# pricing-service

Internal pricing microservice — returns base price and discount rate for a given SKU and customer tier.

Used by `order-service` to calculate order totals. Part of the RCA multi-service demo.

---

## ⚠️ Breaking Change — v2.1.0 (commit `abc1234f`, 2024-11-15)

The `discount` field in `PricingDto.Response` was **renamed** to `discountRate` to align with Finance team naming conventions (ADR-0042).

| Version | Response field |
|---------|---------------|
| v2.0.x  | `"discount": 0.10` |
| v2.1.0+ | `"discountRate": 0.10` |

Downstream consumers reading `response.getDiscount()` or `response["discount"]` will receive `null` after upgrading to v2.1.0, causing `NullPointerException` in any calculation that multiplies or formats the value.

**order-service is the known broken consumer.** See `order-service/README.md`.

---

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/v1/pricing` | Calculate price for a SKU |
| `GET`  | `/api/v1/pricing/health` | Liveness check |
| `GET`  | `/actuator/health` | Spring Boot health |
| `GET`  | `/chaos/scenarios` | List chaos scenarios |
| `POST` | `/chaos/{scenario}` | Trigger a chaos scenario |

### Request / Response

```bash
curl -X POST http://localhost:8081/api/v1/pricing \
  -H "Content-Type: application/json" \
  -d '{"sku": "SKU-001", "quantity": 2, "customerTier": "premium"}'
```

```json
{
  "sku": "SKU-001",
  "basePrice": 100.0,
  "currency": "USD",
  "discountRate": 0.1,
  "finalPrice": 90.0,
  "campaignId": null
}
```

---

## Local Setup

### Prerequisites
- Java 17 + Maven 3.9, or Docker

### Run with Maven
```bash
cd pricing-service
mvn spring-boot:run
# Listening on http://localhost:8081
```

### Run with Docker (standalone)
```bash
cd pricing-service
docker build -t pricing-service .
docker run -p 8081:8081 pricing-service
```

### Run with Docker Compose (both services together)
```bash
# From banking-app-master/
docker compose --profile pricing up --build -d
```

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `SERVER_PORT` | `8081` | HTTP port |
| `DD_API_KEY` | _(required for Datadog)_ | Datadog API key |
| `DD_SITE` | `datadoghq.com` | Datadog site |
| `DD_ENV` | `dev` | Environment tag |
| `DD_VERSION` | `2.1.0` | Version tag |
| `LOGGING_FILE_NAME` | `/var/log/pricing-service/app.log` | Log file path |

---

## AWS Deployment

This service deploys as the `monitored_app` in the existing Terraform stack.

```hcl
# terraform.tfvars
monitored_app = {
  service_name     = "pricing-service"
  image_repo_name  = "pricing-service"
  image_tag        = "latest"
  port             = 8081
  task_cpu         = 512
  task_memory      = 768
  instance_type    = "t3.small"
  needs_dd_sidecar = true
  extra_env = {
    LOGGING_FILE_NAME = "/var/log/pricing-service/app.log"
    DD_VERSION        = "2.1.0"
    DD_LOGS_INJECTION = "true"
  }
}
```

For running **both** pricing-service and order-service simultaneously on AWS, use the Terraform config in `terraform/aws/pricing_order.tf`.

---

## Git History (for RCA agent)

After cloning / creating this repo, run the git history setup script so the RCA agent can `git blame` and find the breaking commit:

```bash
cd banking-app-master/demo-repos
bash setup_git_history.sh        # creates commits for pricing-service
bash push_to_github.sh           # pushes to GitHub org
```

The RCA agent will find commit `abc1234f` (author: Alice Chen, 2024-11-15) as the root cause when investigating order-service NPEs.

---

## Triggering Errors

```bash
# NullPointerException in PricingService (visible in Datadog)
curl -X POST http://localhost:8081/chaos/null-pointer

# InvalidSkuException (WARN level)
curl -X POST http://localhost:8081/chaos/invalid-sku

# See all chaos scenarios
curl http://localhost:8081/chaos/scenarios
```
