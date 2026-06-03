package com.demo.order.service;

import com.demo.order.client.PricingClient;
import com.demo.order.dto.OrderDto;
import com.demo.order.dto.PricingResponseDto;
import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.Timer;
import jakarta.annotation.PostConstruct;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import java.time.LocalDateTime;
import java.util.UUID;

@Service
@RequiredArgsConstructor
@Slf4j
public class OrderService {

    private final PricingClient pricingClient;
    private final MeterRegistry meterRegistry;

    private Counter orderCreatedCounter;
    private Counter orderFailedCounter;
    private Timer   orderTimer;

    @PostConstruct
    void initMetrics() {
        orderCreatedCounter = Counter.builder("orders.created.total")
                .description("Total orders successfully created")
                .register(meterRegistry);

        orderFailedCounter = Counter.builder("orders.failed.total")
                .description("Total orders that failed processing")
                .register(meterRegistry);

        orderTimer = Timer.builder("orders.create.duration")
                .description("Time to create an order end-to-end")
                .register(meterRegistry);
    }

    // ── Public API ───────────────────────────────────────────────────────────

    public OrderDto.Response createOrder(OrderDto.CreateRequest req) {
        return orderTimer.record(() -> {
            log.info("Creating order: customerId={} sku={} qty={} tier={}",
                    req.getCustomerId(), req.getSku(), req.getQuantity(), req.getCustomerTier());

            // BUG B lives in _resolveQuantity — called before the pricing fetch.
            int resolvedQty = resolveQuantity(req.getQuantity());

            // Call pricing-service — response.getDiscount() will be null (BUG A).
            PricingResponseDto pricing = pricingClient.getPrice(
                    req.getSku(), resolvedQty, req.getCustomerTier());

            double totalPrice = calculateTotal(pricing.getBasePrice(), pricing.getDiscount(), resolvedQty);

            OrderDto.Response response = OrderDto.Response.builder()
                    .orderId(UUID.randomUUID().toString())
                    .customerId(req.getCustomerId())
                    .sku(req.getSku())
                    .quantity(resolvedQty)
                    .unitPrice(pricing.getBasePrice())
                    .discountApplied(pricing.getDiscount() != null ? pricing.getDiscount() : 0.0)
                    .totalPrice(totalPrice)
                    .status("confirmed")
                    .createdAt(LocalDateTime.now())
                    .build();

            orderCreatedCounter.increment();
            log.info("Order created: orderId={} total={}", response.getOrderId(), totalPrice);
            return response;
        });
    }

    // ── Private helpers ──────────────────────────────────────────────────────

    /**
     * Validate and normalise the requested item quantity.
     *
     * BUG B — Off-by-one (Scenario B, single-service)
     * ────────────────────────────────────────────────
     * Introduced in commit d3adb33f (2025-01-10, Carlos Rivera):
     * "refactor: normalise cart quantity to 0-indexed internal array"
     *
     * The refactor subtracted 1 from the requested quantity to convert from
     * 1-indexed (user-facing) to 0-indexed (internal).  The conversion was
     * never actually needed — the downstream inventory system is 1-indexed.
     *
     * Effect:
     *   - quantity=1 → resolvedQty=0 → IllegalArgumentException logged as ERROR
     *   - quantity=5 → resolvedQty=4 → silent under-shipment, no error surfaced
     *
     * Fix: remove the `- 1` on line 84.  Change: resolved = quantity - 1  →  resolved = quantity
     */
    private int resolveQuantity(int quantity) {
        if (quantity <= 0) {
            throw new IllegalArgumentException(
                    "Requested quantity " + quantity + " must be > 0");
        }
        // ── BUG B ──────────────────────────────────────────────────────────
        int resolved = quantity - 1;   // ← off-by-one; should be: int resolved = quantity;
        // Fix: int resolved = quantity;
        // ───────────────────────────────────────────────────────────────────
        if (resolved <= 0) {
            throw new IllegalArgumentException(
                    "Order quantity " + resolved + " is invalid after normalisation " +
                    "(original=" + quantity + "). Bug d3adb33f — quantity should not be decremented.");
        }
        return resolved;
    }

    /**
     * Apply a fractional discount to the unit price and multiply by quantity.
     *
     * BUG A — NullPointerException when discount is null (Scenario A, cross-service)
     * ────────────────────────────────────────────────────────────────────────────────
     * {@code discount} is null when pricing-service returns 'discountRate' but this
     * service's DTO still has the old field name 'discount' (see PricingResponseDto).
     *
     * The call to {@code discount.doubleValue()} on line 54 throws:
     *   java.lang.NullPointerException: Cannot invoke "java.lang.Double.doubleValue()"
     *   because the return value of "com.demo.order.dto.PricingResponseDto.getDiscount()"
     *   is null
     *
     * Stack trace (production):
     *   at com.demo.order.service.OrderService.calculateTotal(OrderService.java:116)
     *   at com.demo.order.service.OrderService.createOrder(OrderService.java:54)
     *   at com.demo.order.controller.OrderController.createOrder(OrderController.java:38)
     */
    private double calculateTotal(double unitPrice, Double discount, int quantity) {
        // ── BUG A ──────────────────────────────────────────────────────────
        // discount is null because pricing-service v2.1.0 renamed the field.
        // discount.doubleValue() throws NullPointerException here.
        double discountedUnit = unitPrice * (1.0 - discount.doubleValue()); // NullPointerException
        // Fix: update PricingResponseDto to use field name 'discountRate'.
        // ───────────────────────────────────────────────────────────────────
        return Math.round(discountedUnit * quantity * 100.0) / 100.0;
    }
}
