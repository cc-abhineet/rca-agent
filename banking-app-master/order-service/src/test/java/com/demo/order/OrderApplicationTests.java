package com.demo.order;

import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.TestPropertySource;

@SpringBootTest
@ActiveProfiles("test")
@TestPropertySource(properties = {
        "pricing.service.url=http://localhost:8081",
        "management.datadog.metrics.export.enabled=false"
})
class OrderApplicationTests {

    @Test
    void contextLoads() {
        // Verifies the Spring context starts without errors.
        // Note: PricingClient calls will fail in isolation (pricing-service not running),
        // but context load itself should succeed.
    }
}
