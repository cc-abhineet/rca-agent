package com.demo.pricing.config;

import io.micrometer.core.aop.TimedAspect;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.config.MeterFilter;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.actuate.autoconfigure.metrics.MeterRegistryCustomizer;
import org.springframework.context.annotation.*;

/**
 * Wires Micrometer tags into every metric so Datadog can filter by
 * service, env, and version — mirrors banking-app DatadogObservabilityConfig.
 */
@Configuration
public class DatadogObservabilityConfig {

    @Value("${spring.application.name}")
    private String appName;

    @Value("${DD_ENV:dev}")
    private String env;

    @Value("${DD_VERSION:2.1.0}")
    private String version;

    @Bean
    public MeterRegistryCustomizer<MeterRegistry> metricsCommonTags() {
        return registry -> registry.config()
                .commonTags(
                        "service", appName,
                        "env",     env,
                        "version", version
                )
                .meterFilter(MeterFilter.denyNameStartsWith("jvm.gc.pause"));
    }

    @Bean
    public TimedAspect timedAspect(MeterRegistry registry) {
        return new TimedAspect(registry);
    }
}
