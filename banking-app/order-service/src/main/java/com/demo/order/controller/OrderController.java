package com.demo.order.controller;

import com.demo.order.dto.OrderDto;
import com.demo.order.service.OrderService;
import io.micrometer.core.annotation.Timed;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/v1/orders")
@RequiredArgsConstructor
@Slf4j
@Timed(value = "orders.api.requests", extraTags = {"controller", "orders"})
public class OrderController {

    private final OrderService orderService;

    /**
     * POST /api/v1/orders
     *
     * Creates an order by calling pricing-service for the SKU price and
     * applying the customer-tier discount.
     *
     * Throws NullPointerException (BUG A) when pricing-service v2.1.0+
     * is running — the discount field has been renamed upstream.
     *
     * Throws IllegalArgumentException (BUG B) when quantity=1 is requested
     * — the off-by-one in resolveQuantity() reduces it to 0.
     */
    @PostMapping
    @ResponseStatus(HttpStatus.CREATED)
    public ResponseEntity<OrderDto.Response> createOrder(
            @Valid @RequestBody OrderDto.CreateRequest request) {
        log.info("POST /api/v1/orders customerId={} sku={} qty={}",
                request.getCustomerId(), request.getSku(), request.getQuantity());
        OrderDto.Response response = orderService.createOrder(request);
        return ResponseEntity.status(HttpStatus.CREATED).body(response);
    }

    @GetMapping("/health")
    public ResponseEntity<String> health() {
        return ResponseEntity.ok("order-service OK");
    }
}
