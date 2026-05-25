package com.demo.pricing.controller;

import lombok.extern.slf4j.Slf4j;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.time.LocalDateTime;
import java.util.List;
import java.util.Map;

/**
 * ChaosController — intentional error injection for RCA demo testing.
 *
 * Mirrors the pattern in banking-app ChaosController.
 * Each POST /chaos/{scenario} throws an exception that is logged by Logback
 * and shipped to Datadog via the agent sidecar.
 */
@RestController
@RequestMapping("/chaos")
@Slf4j
public class ChaosController {

    private static final List<Map<String, String>> SCENARIOS = List.of(
        Map.of(
            "id",          "null-pointer",
            "name",        "NullPointerException in PricingService",
            "description", "Simulates a null dereference when catalogue lookup returns null unexpectedly",
            "severity",    "ERROR"
        ),
        Map.of(
            "id",          "invalid-sku",
            "name",        "InvalidSkuException",
            "description", "Triggers an InvalidSkuException for a non-existent SKU",
            "severity",    "WARN"
        ),
        Map.of(
            "id",          "arithmetic",
            "name",        "ArithmeticException (divide by zero)",
            "description", "Simulates a divide-by-zero in the discount calculation path",
            "severity",    "ERROR"
        )
    );

    @GetMapping("/scenarios")
    public ResponseEntity<Map<String, Object>> listScenarios() {
        log.info("GET /chaos/scenarios");
        return ResponseEntity.ok(Map.of(
            "scenarios", SCENARIOS,
            "count",     SCENARIOS.size(),
            "timestamp", LocalDateTime.now().toString()
        ));
    }

    @PostMapping("/{scenario}")
    public ResponseEntity<Void> triggerChaos(@PathVariable String scenario) {
        log.warn("CHAOS TRIGGER: scenario={} at {}", scenario, LocalDateTime.now());
        return switch (scenario) {
            case "null-pointer" -> {
                log.error("Simulating NullPointerException in PricingService.calculatePrice");
                String sku = null;
                // deliberate null dereference — real NPE with realistic stack trace
                int len = sku.length();
                yield ResponseEntity.<Void>ok().build();
            }
            case "invalid-sku" -> {
                log.warn("Simulating InvalidSkuException for sku=SKU-CHAOS");
                throw new com.demo.pricing.exception.InvalidSkuException("SKU-CHAOS");
            }
            case "arithmetic" -> {
                log.error("Simulating ArithmeticException in discount calculation");
                int zero = 0;
                int result = 100 / zero;  // ArithmeticException: / by zero
                yield ResponseEntity.<Void>ok().build();
            }
            default -> {
                log.error("Unknown chaos scenario: {}", scenario);
                throw new IllegalArgumentException("Unknown chaos scenario: " + scenario +
                    ". Call GET /chaos/scenarios for available scenarios.");
            }
        };
    }
}
