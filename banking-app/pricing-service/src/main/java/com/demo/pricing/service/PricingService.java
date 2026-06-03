package com.demo.pricing.service;

import com.demo.pricing.dto.PricingDto;
import com.demo.pricing.exception.InvalidSkuException;
import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.Timer;
import jakarta.annotation.PostConstruct;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import java.util.Map;

@Service
@RequiredArgsConstructor
@Slf4j
public class PricingService {

    private final MeterRegistry meterRegistry;

    // ── Custom Datadog metrics ───────────────────────────────────────────────
    private Counter pricingRequestCounter;
    private Counter invalidSkuCounter;
    private Timer   pricingTimer;

    @PostConstruct
    void initMetrics() {
        pricingRequestCounter = Counter.builder("pricing.requests.total")
                .description("Total pricing requests")
                .register(meterRegistry);

        invalidSkuCounter = Counter.builder("pricing.requests.invalid_sku")
                .description("Requests for unknown SKUs")
                .register(meterRegistry);

        pricingTimer = Timer.builder("pricing.request.duration")
                .description("Time taken to calculate a price")
                .register(meterRegistry);
    }

    // ── Static catalogue ─────────────────────────────────────────────────────
    // In production this queries a database or a pricing rules engine.
    private static final Map<String, Double> BASE_PRICES = Map.of(
            "SKU-001", 100.00,
            "SKU-002",  49.99,
            "SKU-003", 199.00,
            "SKU-004",  29.99,
            "SKU-005",  79.95
    );

    private static final Map<String, Double> TIER_RATES = Map.of(
            "standard", 0.00,
            "premium",  0.10,
            "vip",      0.20
    );

    // ── Business logic ───────────────────────────────────────────────────────
    public PricingDto.Response calculatePrice(PricingDto.Request req) {
        return pricingTimer.record(() -> {
            pricingRequestCounter.increment();
            log.info("Pricing request: sku={} quantity={} tier={}", req.getSku(), req.getQuantity(), req.getCustomerTier());

            Double basePrice = BASE_PRICES.get(req.getSku());
            if (basePrice == null) {
                invalidSkuCounter.increment();
                log.warn("Unknown SKU requested: {}", req.getSku());
                throw new InvalidSkuException(req.getSku());
            }

            double rate = TIER_RATES.getOrDefault(req.getCustomerTier(), 0.0);
            double finalPrice = Math.round(basePrice * (1 - rate) * 100.0) / 100.0;

            log.info("Pricing result: sku={} basePrice={} discountRate={} finalPrice={}",
                    req.getSku(), basePrice, rate, finalPrice);

            return PricingDto.Response.builder()
                    .sku(req.getSku())
                    .basePrice(basePrice)
                    .currency("USD")
                    // Post-rename field — was 'discount' before v2.1.0 (commit abc1234f)
                    .discountRate(rate)
                    .finalPrice(finalPrice)
                    .build();
        });
    }
}
