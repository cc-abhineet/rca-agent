package com.demo.order.dto;

import lombok.*;

/**
 * DTO for deserialising pricing-service responses.
 *
 * BUG A — Cross-service field mismatch (Scenario A)
 * ─────────────────────────────────────────────────
 * pricing-service v2.1.0 (commit abc1234f, 2024-11-15) renamed the JSON
 * field 'discount' → 'discountRate'.  This DTO still declares the old
 * field name, so Jackson maps the new 'discountRate' to null and leaves
 * 'discount' at its default value of null (Double, not double, so it can
 * hold null).
 *
 * When OrderService calls getDiscount() it receives null, and the arithmetic:
 *
 *     double discounted = unitPrice * (1.0 - discount);   // line 54
 *
 * throws NullPointerException because Double cannot be auto-unboxed from null.
 *
 * Fix: rename field 'discount' to 'discountRate' (and update getter/setter).
 */
@Getter @Setter @NoArgsConstructor @AllArgsConstructor @Builder
public class PricingResponseDto {
    private String sku;
    private double basePrice;
    private String currency;

    // ── BUG A ────────────────────────────────────────────────────────────────
    // pricing-service returns "discountRate" since v2.1.0 (commit abc1234f).
    // Jackson cannot bind "discountRate" to this field, so it stays null.
    // Fix: rename to 'discountRate' to match the upstream response.
    private Double discount;    // ← stale field name; should be 'discountRate'
    // ─────────────────────────────────────────────────────────────────────────

    private double finalPrice;
    private String campaignId;
}
