package com.demo.banking.controller;

import com.demo.banking.exception.ChaosException;
import com.demo.banking.exception.InsufficientFundsException;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.annotation.*;

import java.math.BigDecimal;
import java.time.LocalDateTime;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeoutException;

/**
 * ChaosController — intentional error injection for demo and RCA testing.
 *
 * Each POST /chaos/{scenario} throws an exception that propagates through
 * GlobalExceptionHandler and is logged by Datadog APM / the Error Ingestion Agent.
 *
 * GET /chaos/scenarios returns the full catalogue of available scenarios.
 */
@RestController
@RequestMapping("/chaos")
@Slf4j
public class ChaosController {

    // ── Scenario catalogue ─────────────────────────────────────────────────

    private static final List<Map<String, String>> SCENARIOS = List.of(
        Map.of(
            "id",          "null-pointer",
            "name",        "NullPointerException",
            "description", "Triggers a NullPointerException in the account service layer",
            "severity",    "ERROR"
        ),
        Map.of(
            "id",          "db-connection",
            "name",        "Database Connection Failure",
            "description", "Simulates a database connection pool exhaustion / timeout",
            "severity",    "ERROR"
        ),
        Map.of(
            "id",          "insufficient-funds",
            "name",        "Insufficient Funds",
            "description", "Triggers an InsufficientFundsException for chaos account CHAOS-001",
            "severity",    "WARN"
        ),
        Map.of(
            "id",          "timeout",
            "name",        "Request Timeout",
            "description", "Sleeps for 35 seconds then throws a TimeoutException",
            "severity",    "ERROR"
        ),
        Map.of(
            "id",          "validation",
            "name",        "Validation Failure",
            "description", "Triggers a MethodArgumentNotValidException with malformed account data",
            "severity",    "WARN"
        )
    );

    // ── List scenarios ─────────────────────────────────────────────────────

    /**
     * GET /chaos/scenarios
     * Returns all available chaos scenarios with IDs and descriptions.
     */
    @GetMapping("/scenarios")
    public ResponseEntity<Map<String, Object>> listScenarios() {
        log.info("GET /chaos/scenarios - returning {} scenarios", SCENARIOS.size());
        return ResponseEntity.ok(Map.of(
            "scenarios",  SCENARIOS,
            "count",      SCENARIOS.size(),
            "timestamp",  LocalDateTime.now().toString()
        ));
    }

    // ── Trigger endpoint ───────────────────────────────────────────────────

    /**
     * POST /chaos/{scenario}
     * Triggers the specified chaos scenario by throwing an appropriate exception.
     * The exception propagates through GlobalExceptionHandler for consistent formatting.
     */
    @PostMapping("/{scenario}")
    public ResponseEntity<Void> triggerChaos(@PathVariable String scenario) throws Exception {
        log.warn("CHAOS TRIGGER: scenario={} at {}", scenario, LocalDateTime.now());

        return switch (scenario) {
            case "null-pointer"        -> triggerNullPointer();
            case "db-connection"       -> triggerDbConnection();
            case "insufficient-funds"  -> triggerInsufficientFunds();
            case "timeout"             -> triggerTimeout();
            case "validation"          -> triggerValidation();
            default -> {
                log.error("Unknown chaos scenario requested: {}", scenario);
                throw new ChaosException(
                    scenario,
                    "Unknown scenario",
                    "No chaos scenario found with id='" + scenario + "'. "
                    + "Call GET /chaos/scenarios for the full list."
                );
            }
        };
    }

    // ── Individual scenario implementations ───────────────────────────────

    /**
     * Simulates a NullPointerException — the classic unhandled null dereference.
     * Represents a code defect where an optional value was not guarded.
     */
    private ResponseEntity<Void> triggerNullPointer() {
        log.error("Simulating NullPointerException in account lookup");
        String accountId = null;
        // Deliberate null dereference to produce a real NPE with realistic stack trace
        int length = accountId.length(); // NullPointerException here
        return ResponseEntity.ok().build(); // unreachable
    }

    /**
     * Simulates a database connection failure.
     * Represents infrastructure-level dependency failures (pool exhaustion, network timeout).
     */
    private ResponseEntity<Void> triggerDbConnection() {
        log.error("Simulating database connection failure — pool exhausted");
        throw new RuntimeException(
            "Unable to acquire JDBC Connection from pool. "
            + "Connection pool exhausted after 30000ms. "
            + "com.zaxxer.hikari.pool.HikariPool$PoolInitializationException: "
            + "Failed to initialize pool: Connection to rca-db.us-east-1.rds.amazonaws.com:5432 refused. "
            + "Check that the hostname and port are correct and that the postmaster is accepting TCP/IP connections."
        );
    }

    /**
     * Simulates an InsufficientFundsException for the chaos test account.
     * Represents a business logic error path.
     */
    private ResponseEntity<Void> triggerInsufficientFunds() {
        log.warn("Simulating InsufficientFundsException for chaos account CHAOS-001");
        BigDecimal available  = new BigDecimal("0.01");
        BigDecimal requested  = new BigDecimal("10000.00");
        throw new InsufficientFundsException(available, requested);
    }

    /**
     * Simulates a slow external dependency causing a request timeout.
     * Sleeps for 35 seconds (beyond typical 30s gateway timeout) then throws.
     */
    private ResponseEntity<Void> triggerTimeout() throws Exception {
        log.error("Simulating timeout — downstream service payments-gateway did not respond");
        throw new TimeoutException(
            "Request processing exceeded deadline of 30000ms. "
            + "Downstream service payments-gateway did not respond in time."
        );
    }

    /**
     * Simulates a validation failure on account creation.
     * Throws IllegalArgumentException with detailed field validation message
     * (GlobalExceptionHandler formats this consistently).
     */
    private ResponseEntity<Void> triggerValidation() {
        log.warn("Simulating validation failure for malformed account data");
        throw new IllegalArgumentException(
            "Validation failed for AccountDto.CreateRequest: "
            + "field 'ownerName' must not be blank; "
            + "field 'initialBalance' must be >= 0; "
            + "field 'accountType' must be one of [CHECKING, SAVINGS, BUSINESS]"
        );
    }
}
