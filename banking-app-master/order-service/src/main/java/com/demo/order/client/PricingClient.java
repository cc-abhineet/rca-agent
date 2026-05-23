package com.demo.order.client;

import com.demo.order.dto.PricingResponseDto;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClientException;
import org.springframework.web.client.RestTemplate;

import java.util.Map;

/**
 * HTTP client for the internal pricing-service.
 *
 * Makes a POST to pricing-service /api/v1/pricing and deserialises the
 * response into {@link PricingResponseDto}.
 *
 * The response DTO has field 'discount' (stale name).  pricing-service
 * v2.1.0 returns 'discountRate' instead, so PricingResponseDto.getDiscount()
 * returns null — see PricingResponseDto for the full bug description.
 */
@Component
@RequiredArgsConstructor
@Slf4j
public class PricingClient {

    private final RestTemplate restTemplate;

    @Value("${pricing.service.url}")
    private String pricingServiceUrl;

    public PricingResponseDto getPrice(String sku, int quantity, String customerTier) {
        String url = pricingServiceUrl + "/api/v1/pricing";
        Map<String, Object> request = Map.of(
                "sku",          sku,
                "quantity",     quantity,
                "customerTier", customerTier
        );

        log.info("Calling pricing-service: url={} sku={} qty={} tier={}", url, sku, quantity, customerTier);

        try {
            PricingResponseDto response = restTemplate.postForObject(url, request, PricingResponseDto.class);
            log.info("Pricing response received: sku={} basePrice={} discount={} finalPrice={}",
                    sku,
                    response != null ? response.getBasePrice() : "null",
                    response != null ? response.getDiscount() : "null",  // will be null post-rename
                    response != null ? response.getFinalPrice() : "null");
            return response;
        } catch (RestClientException ex) {
            log.error("Failed to call pricing-service: {}", ex.getMessage());
            throw new RuntimeException("Pricing service unavailable: " + ex.getMessage(), ex);
        }
    }
}
