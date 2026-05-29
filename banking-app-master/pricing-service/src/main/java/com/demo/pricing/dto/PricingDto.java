package com.demo.pricing.dto;

import lombok.*;

public class PricingDto {

    @Getter @Setter @NoArgsConstructor @AllArgsConstructor @Builder
    public static class Request {
        private String sku;
        private int    quantity;
        private String customerTier;
    }

    /**
     * Pricing response DTO — v2.1.0.
     *
     * BREAKING CHANGE (commit abc1234f, 2025-01-10, Alice Chen):
     * Field renamed from 'discount' to 'discountRate' to align with the
     * internal pricing taxonomy.  Consumers must update their DTOs accordingly.
     *
     * Was:  "discount": 0.10
     * Now:  "discountRate": 0.10
     */
    @Getter @Setter @NoArgsConstructor @AllArgsConstructor @Builder
    public static class Response {
        private String sku;
        private double basePrice;
        /** Fractional discount rate (0.0 = no discount, 0.10 = 10% off).
         *  Renamed from 'discount' in v2.1.0. */
        private double discountRate;
        private double finalPrice;
        private String customerTier;
        private String currency;
    }
}
