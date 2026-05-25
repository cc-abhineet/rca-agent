package com.demo.pricing.controller;

import com.demo.pricing.dto.PricingDto;
import com.demo.pricing.service.PricingService;
import io.micrometer.core.annotation.Timed;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/v1/pricing")
@RequiredArgsConstructor
@Slf4j
@Timed(value = "pricing.api.requests", extraTags = {"controller", "pricing"})
public class PricingController {

    private final PricingService pricingService;

    /**
     * POST /api/v1/pricing
     *
     * Returns the price for a SKU including the discountRate for the given customer tier.
     *
     * Response includes field 'discountRate' (renamed from 'discount' in v2.1.0).
     * Downstream consumers that read response.getDiscount() will get null.
     */
    @PostMapping
    public ResponseEntity<PricingDto.Response> getPrice(
            @Valid @RequestBody PricingDto.Request request) {
        log.info("POST /api/v1/pricing sku={} tier={}", request.getSku(), request.getCustomerTier());
        return ResponseEntity.ok(pricingService.calculatePrice(request));
    }

    /** GET /api/v1/pricing/health — lightweight liveness check beyond /actuator/health */
    @GetMapping("/health")
    public ResponseEntity<String> health() {
        return ResponseEntity.ok("pricing-service OK");
    }
}
