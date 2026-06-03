package com.demo.order.dto;

import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import lombok.*;

import java.time.LocalDateTime;

public class OrderDto {

    /* ── CREATE ────────────────────────────────────────────────────────────── */
    @Getter @Setter @NoArgsConstructor @AllArgsConstructor @Builder
    public static class CreateRequest {
        @NotBlank(message = "customerId is required")
        private String customerId;

        @NotBlank(message = "sku is required")
        private String sku;

        @Min(value = 1, message = "quantity must be >= 1")
        private int quantity;

        /** standard | premium | vip */
        private String customerTier = "standard";
    }

    /* ── RESPONSE ──────────────────────────────────────────────────────────── */
    @Getter @Setter @NoArgsConstructor @AllArgsConstructor @Builder
    public static class Response {
        private String orderId;
        private String customerId;
        private String sku;
        private int    quantity;
        private double unitPrice;
        private double discountApplied;
        private double totalPrice;
        private String status;
        private LocalDateTime createdAt;
    }
}
