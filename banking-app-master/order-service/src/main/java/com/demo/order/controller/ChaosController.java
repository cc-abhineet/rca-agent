package com.demo.order.controller;

import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import com.demo.order.dto.OrderDto;
import com.demo.order.service.OrderService;

import java.time.LocalDateTime;
import java.util.List;
import java.util.Map;

/**
 * ChaosController — trigger the two planted bugs directly for RCA demo.
 *
 * Both endpoints bypass request validation so the bugs fire immediately.
 */
@RestController
@RequestMapping("/chaos")
@RequiredArgsConstructor
@Slf4j
public class ChaosController {

    private final OrderService orderService;

    private static final List<Map<String, String>> SCENARIOS = List.of(
        Map.of(
            "id",          "cross-service-npe",
            "name",        "Cross-service NullPointerException (Bug A)",
            "description", "Creates an order for SKU-001 — triggers NPE in calculateTotal because pricing-service returns discountRate but this service reads discount (null).",
            "severity",    "ERROR"
        ),
        Map.of(
            "id",          "quantity-off-by-one",
            "name",        "Off-by-one in resolveQuantity (Bug B)",
            "description", "Creates an order with quantity=1 — resolveQuantity() subtracts 1, producing quantity=0, which throws IllegalArgumentException.",
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
     * POST /chaos/cross-service-npe
     *
     * Triggers Bug A: calls pricing-service with a real SKU and a non-zero
     * quantity so resolveQuantity passes, then hits calculateTotal with a null
     * discount.  Requires pricing-service to be running.
     */
    @PostMapping("/cross-service-npe")
    public ResponseEntity<Void> triggerCrossServiceNpe() {
        log.warn("CHAOS: triggering cross-service NPE scenario (Bug A)");
        OrderDto.CreateRequest req = OrderDto.CreateRequest.builder()
                .customerId("CHAOS-CUSTOMER")
                .sku("SKU-001")
                .quantity(2)       // > 1 so resolveQuantity gives 1 (passes check)
                .customerTier("premium")
                .build();
        orderService.createOrder(req);   // NullPointerException in calculateTotal
        return ResponseEntity.ok().build();
    }

    /**
     * POST /chaos/quantity-off-by-one
     *
     * Triggers Bug B: sends quantity=1 directly to the service.
     * resolveQuantity() subtracts 1 → 0 → IllegalArgumentException.
     * Does NOT need pricing-service running (fails before calling it).
     */
    @PostMapping("/quantity-off-by-one")
    public ResponseEntity<Void> triggerQuantityOffByOne() {
        log.warn("CHAOS: triggering quantity off-by-one scenario (Bug B)");
        OrderDto.CreateRequest req = OrderDto.CreateRequest.builder()
                .customerId("CHAOS-CUSTOMER")
                .sku("SKU-002")
                .quantity(1)       // resolveQuantity(1) → 0 → IllegalArgumentException
                .customerTier("standard")
                .build();
        orderService.createOrder(req);   // IllegalArgumentException: Order quantity 0 is invalid
        return ResponseEntity.ok().build();
    }
}
