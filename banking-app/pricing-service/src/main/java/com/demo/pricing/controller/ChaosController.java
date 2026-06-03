package com.demo.pricing.controller;

import com.demo.pricing.dto.PricingDto;
import com.demo.pricing.service.PricingService;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.time.LocalDateTime;
import java.util.List;
import java.util.Map;

/**
 * ChaosController — thin HTTP trigger layer for RCA scenario testing.
 *
 * Each endpoint immediately delegates to PricingService so that exceptions
 * and stack traces originate in the real business layer, NOT here.
 *
 * RULE: zero business logic in this class.
 */
@RestController
@RequestMapping("/chaos")
@RequiredArgsConstructor
@Slf4j
public class ChaosController {

    private final PricingService pricingService;

    private static final List<Map<String, String>> SCENARIOS = List.of(
        Map.of(
            "id",          "null-pointer",
            "name",        "NullPointerException in PricingService.computeDynamicPricing",
            "description", "Calls computeDynamicPricing(null, 'us-east-1') — Map.of() rejects null key → NPE inside PricingService",
            "severity",    "ERROR"
        ),
        Map.of(
            "id",          "invalid-sku",
            "name",        "InvalidSkuException in PricingService.calculatePrice",
            "description", "Calls calculatePrice with SKU-CHAOS-999 → InvalidSkuException inside PricingService",
            "severity",    "WARN"
        ),
        Map.of(
            "id",          "arithmetic",
            "name",        "ArithmeticException in PricingService.computeDiscountedVolume",
            "description", "Calls computeDiscountedVolume('SKU-001', 1) — 10/(1-1) = divide-by-zero → ArithmeticException inside PricingService",
            "severity",    "ERROR"
        )
    );

    @GetMapping("/scenarios")
    public ResponseEntity<Map<String, Object>> listScenarios() {
        return ResponseEntity.ok(Map.of(
            "scenarios", SCENARIOS,
            "count",     SCENARIOS.size(),
            "timestamp", LocalDateTime.now().toString()
        ));
    }

    /**
     * Delegates to PricingService.computeDynamicPricing — NullPointerException
     * originates there when sku=null is passed to Map.of().get().
     */
    @PostMapping("/null-pointer")
    public ResponseEntity<Void> triggerNullPointer() {
        log.info("CHAOS: triggering null-pointer via PricingService.computeDynamicPricing(null, 'us-east-1')");
        pricingService.computeDynamicPricing(null, "us-east-1");
        return ResponseEntity.ok().build();
    }

    /**
     * Delegates to PricingService.calculatePrice — InvalidSkuException
     * originates there when the SKU is not found in the catalogue.
     */
    @PostMapping("/invalid-sku")
    public ResponseEntity<Void> triggerInvalidSku() {
        log.info("CHAOS: triggering invalid-sku via PricingService.calculatePrice(SKU-CHAOS-999)");
        PricingDto.Request req = PricingDto.Request.builder()
                .sku("SKU-CHAOS-999")
                .quantity(1)
                .customerTier("standard")
                .build();
        pricingService.calculatePrice(req);
        return ResponseEntity.ok().build();
    }

    /**
     * Delegates to PricingService.computeDiscountedVolume — ArithmeticException
     * originates there when volume=1 causes division by zero.
     */
    @PostMapping("/arithmetic")
    public ResponseEntity<Void> triggerArithmetic() {
        log.info("CHAOS: triggering arithmetic-error via PricingService.computeDiscountedVolume('SKU-001', 1)");
        pricingService.computeDiscountedVolume("SKU-001", 1);
        return ResponseEntity.ok().build();
    }
}
