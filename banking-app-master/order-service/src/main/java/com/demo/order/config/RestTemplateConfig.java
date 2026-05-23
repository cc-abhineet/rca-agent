package com.demo.order.config;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.client.SimpleClientHttpRequestFactory;
import org.springframework.web.client.RestTemplate;

import java.time.Duration;

@Configuration
public class RestTemplateConfig {

    // RestTemplateBuilder.connectTimeout(Duration) / readTimeout(Duration) were
    // removed in Spring Boot 3.0.  Configure timeouts directly on the request
    // factory instead — SimpleClientHttpRequestFactory is already on the
    // classpath via spring-web, so no extra dependency is required.
    @Bean
    public RestTemplate restTemplate() {
        SimpleClientHttpRequestFactory factory = new SimpleClientHttpRequestFactory();
        factory.setConnectTimeout((int) Duration.ofSeconds(5).toMillis());
        factory.setReadTimeout((int) Duration.ofSeconds(10).toMillis());
        return new RestTemplate(factory);
    }
}
