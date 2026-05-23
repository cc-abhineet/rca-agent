package com.demo.pricing.exception;

public class InvalidSkuException extends RuntimeException {
    public InvalidSkuException(String sku) {
        super("Unknown SKU: " + sku + ". Check the product catalogue.");
    }
}
