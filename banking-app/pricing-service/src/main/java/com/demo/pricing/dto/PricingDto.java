package com.demo.pricing.dto;

import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import lombok.*;

public class PricingDto {

    /* ── REQUEST ───────────────────────────────────────────────────────────── */
    @Getter @Setter @NoArgsConstructor @AllArgsConstructor @Builder
    public static class Request {
        @NotBlank(message = "sku is required")
        private String sku;

        @Min(value = 1, message = "quantity must be >= 1")
        private int quantity;

        /** standard | premium | vip */
        private String customerTier = "standard";
    }

    /* ── RESPONSE ──────────────────────────────────────────────────────────── */
    /**
     * PricingResponse v2.1.0
     *
     * BREAKING CHANGE — commit abc1234f (2024-11-15, Alice Chen):
     *   Field 'discount' was renamed to 'discountRate' to align with
     *   Finance team naming conventions (ADR-0042).
     *
     *   Any downstream consumer reading response.getDiscount() or
     *   response["discount"] will receive null after this change is deployed,
     *   causing NullPointerException or silent pricing errors.
     *
     *   Before (v2.0.x): { "discount": 0.10, ... }
     *   After  (v2.1.0): { "discountRate": 0.10, ... }
     */
    @Getter @Setter @NoArgsConstructor @AllArgsConstructor @Builder
    public static class Response {
        private String sku;
        private double basePrice;
        private String currency;

        // ── BREAKING CHANGE (commit abc1234f, 2024-11-15) ─────────────────
        // Was: private double discount;
        // Now: discountRate  (renamed to match Finance convention ADR-0042)
        // Downstream consumers MUST update their field access.
        private double discountRate;  // 0.0 = no discount; 1.0 = 100% off
        // ──────────────────────────────────────────────────────────────────

        private double finalPrice;
        private String campaignId;
    }
}
