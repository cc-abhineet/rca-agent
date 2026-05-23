# order-service

Spring Boot 3.2.x microservice that creates orders by calling **pricing-service** for unit prices and applying customer-tier discounts.

Contains **two intentional bugs** for RCA demo purposes:

| Bug | Scenario | Root Cause | Effect |
|-----|----------|------------|--------|
| **Bug A** — Cross-service NPE | `cross-service-npe` | `PricingResponseDto` still uses field name `discount`; pricing-service v2.1.0 now returns `discountRate`. Jackson leaves `discount` null. `calculateTotal()` calls `discount.doubleValue()` → NPE. | `NullPointerException` on every order creation |
| **Bug B** — Off-by-one | `quantity-off-by-one` | `resolveQuantity()` does `quantity - 1` (commit `d3adb33f`, 2025-01-10, Carlos Rivera). | `IllegalArgumentException` when `quantity=1`; silent under-shipment for `quantity>1` |

---

## Prerequisites

- Java 17 +
- Maven 3.9 +
- Docker / Docker Compose
- pricing-service running (for Bug A scenario)

---

## Local setup — standalone

```bash
# Clone/navigate to this directory
cd banking-app-master/order-service

# Copy env file
cp .env.example .env
# Edit .env — set PRICING_SERVICE_URL if pricing-service isn't on localhost:8081

# Run
mvn spring-boot:run
# Service starts on http://localhost:8082
```

---

## Local setup — docker-compose (with pricing-service)

From the repo root:

```bash
# Start pricing-service + order-service together
docker-compose --profile pricing up --build

# order-service → http://localhost:8082
# pricing-service → http://localhost:8081
```

---

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PRICING_SERVICE_URL` | `http://localhost:8081` | Base URL of pricing-service |
| `DD_API_KEY` | — | Datadog API key (required for metrics/log shipping) |
| `DD_SITE` | `datadoghq.com` | Datadog site |
| `SPRING_PROFILES_ACTIVE` | — | Spring profile override |

---

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/v1/orders` | Create an order (triggers Bug A or B depending on input) |
| `GET` | `/api/v1/orders/health` | Health check |
| `GET` | `/chaos/scenarios` | List available chaos scenarios |
| `POST` | `/chaos/cross-service-npe` | Trigger Bug A (needs pricing-service running) |
| `POST` | `/chaos/quantity-off-by-one` | Trigger Bug B (standalone, no pricing-service needed) |
| `GET` | `/actuator/health` | Spring Boot actuator health |

---

## Triggering the error scenarios

### Bug A — Cross-service NullPointerException

Requires pricing-service to be running.

```bash
# Via chaos endpoint (simplest)
curl -X POST http://localhost:8082/chaos/cross-service-npe

# Or via the normal order endpoint
curl -X POST http://localhost:8082/api/v1/orders \
  -H 'Content-Type: application/json' \
  -d '{"customerId":"demo","sku":"SKU-001","quantity":2,"customerTier":"premium"}'
```

Expected: HTTP 500, stack trace in logs:
```
java.lang.NullPointerException: Cannot invoke "java.lang.Double.doubleValue()"
  because the return value of "...PricingResponseDto.getDiscount()" is null
  at ...OrderService.calculateTotal(OrderService.java:139)
```

### Bug B — Off-by-one quantity

Does NOT need pricing-service (fails before calling it).

```bash
# Via chaos endpoint
curl -X POST http://localhost:8082/chaos/quantity-off-by-one

# Or via normal endpoint with quantity=1
curl -X POST http://localhost:8082/api/v1/orders \
  -H 'Content-Type: application/json' \
  -d '{"customerId":"demo","sku":"SKU-002","quantity":1,"customerTier":"standard"}'
```

Expected: HTTP 400/500, error in logs:
```
ERROR ... Order quantity 0 is invalid after normalisation (resolved=0).
  This is a bug introduced in commit d3adb33f — quantity should not be decremented.
java.lang.IllegalArgumentException: Order quantity 0 is invalid
  at ...OrderService.resolveQuantity(OrderService.java:111)
```

---

## Bug details

### Bug A — `PricingResponseDto` stale field name

**File:** `src/main/java/com/demo/order/dto/PricingResponseDto.java`

pricing-service v2.1.0 (commit `abc1234f`, 2025-01-10, Alice Chen) renamed the JSON field `discount` → `discountRate`. This service's DTO was never updated:

```java
// PricingResponseDto.java  ← stale
private Double discount;      // pricing-service no longer sends this key
// private Double discountRate;  // ← what pricing-service now sends
```

**Fix:** Rename the field (or add `@JsonProperty("discountRate")`) and update `OrderService.calculateTotal()` to use null-safe access.

### Bug B — Off-by-one in `resolveQuantity`

**File:** `src/main/java/com/demo/order/service/OrderService.java`

Commit `d3adb33f` by Carlos Rivera (2025-01-10):

```java
// BUG B: off-by-one
int resolved = quantity - 1;   // ← should be: int resolved = quantity;
```

The subtraction was intended to convert from 1-indexed user input to 0-indexed internal representation, but no downstream system is 0-indexed. Remove the `- 1`.

---

## AWS deployment

See `AWS_DEPLOYMENT.md` in the repo root.

In `terraform/aws/terraform.tfvars`, swap to order-service:

```hcl
monitored_app = {
  service_name    = "order-service"
  image_repo_name = "order-service"
  image_tag       = "latest"
  port            = 8082
  task_cpu        = 512
  task_memory     = 1024
  instance_type   = "t3.small"
  needs_dd_sidecar = true
  extra_env = {
    PRICING_SERVICE_URL = "http://<pricing-service-host>:8081"
  }
}
```

For running both pricing-service and order-service simultaneously, see `terraform/aws/pricing_order.tf`.

---

## Git history (for RCA git-blame)

The order-service bug (Bug B) was introduced in a real commit. Run the setup script to create a local git repo with the correct history:

```bash
cd banking-app-master/demo-repos
bash setup_git_history.sh
```

The script creates two commits on `order-service`:
1. **Initial good commit** — `resolveQuantity` returns `quantity` directly
2. **Bug commit** `d3adb33f` (Carlos Rivera, 2025-01-10) — `quantity - 1` introduced
