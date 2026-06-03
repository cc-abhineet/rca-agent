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

    // ── Regional multiplier table — added v2.2.0 ────────────────────────────────
    // BUG (commit f1a9b3e, 2025-05-20, Alice Chen): "feat: regional pricing multipliers"
    // Map.of() does not support null keys. Calling REGION_MULTIPLIERS.get(null) throws NPE.
    private static final Map<String, Double> REGION_MULTIPLIERS = Map.of(
        "us-east-1", 1.00,
        "eu-west-1", 1.12,
        "ap-south-1", 0.95
    );

    /**
     * Computes region-adjusted dynamic price for a SKU.
     *
     * BUG v2.2.0 (commit f1a9b3e, 2025-05-20, Alice Chen):
     * When {@code sku} is {@code null} (mobile clients omitting the field),
     * {@code BASE_PRICES.get(null)} throws NullPointerException because
     * {@link Map#of} does not permit null keys.
     *
     * Stack trace (production):
     *   java.lang.NullPointerException
     *     at com.demo.pricing.service.PricingService.computeDynamicPricing(PricingService.java)
     */
    public double computeDynamicPricing(String sku, String region) {
        log.info("Computing dynamic price: sku={} region={}", sku, region);
        // BUG: Map.of() throws NullPointerException for null keys — sku=null crashes here
        Double basePrice = BASE_PRICES.get(sku);
        if (basePrice == null) {
            throw new InvalidSkuException(sku);
        }
        Double multiplier = REGION_MULTIPLIERS.getOrDefault(region, 1.00);
        double finalPrice = Math.round(basePrice * multiplier * 100.0) / 100.0;
        log.info("Dynamic price: sku={} region={} multiplier={} finalPrice={}", sku, region, multiplier, finalPrice);
        return finalPrice;
    }

    /**
     * Computes bulk-discounted total for a SKU ordered in {@code volume} units.
     *
     * BUG v2.1.5 (commit 3b8c17d, 2025-04-28, Bob Martinez):
     * "feat: volume discount tiers"
     *
     * Discount tier = {@code 10 / (volume - 1)}. When {@code volume == 1}
     * this is integer division by zero — ArithmeticException in PricingService.
     *
     * Stack trace (production):
     *   java.lang.ArithmeticException: / by zero
     *     at com.demo.pricing.service.PricingService.computeDiscountedVolume(PricingService.java)
     */
    public double computeDiscountedVolume(String sku, int volume) {
        log.info("Computing volume discount: sku={} volume={}", sku, volume);
        Double basePrice = BASE_PRICES.get(sku);
        if (basePrice == null) {
            throw new InvalidSkuException(sku);
        }
        // BUG: ArithmeticException when volume == 1  (10 / (1-1) == 10 / 0)
        int discountBps = 10 / (volume - 1);
        double discountedUnit = basePrice * (1.0 - (discountBps * 0.001));
        double total = Math.round(discountedUnit * volume * 100.0) / 100.0;
        log.info("Volume discount: sku={} volume={} discountBps={} total={}", sku, volume, discountBps, total);
        return total;
    }

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
