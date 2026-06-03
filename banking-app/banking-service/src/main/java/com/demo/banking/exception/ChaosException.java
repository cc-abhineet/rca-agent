package com.demo.banking.exception;

/**
 * Exception thrown by ChaosController to simulate specific failure scenarios.
 * Carries the scenario name and a human-readable description for logging.
 */
public class ChaosException extends RuntimeException {

    private final String scenario;
    private final String scenarioDescription;

    public ChaosException(String scenario, String scenarioDescription, String message) {
        super(message);
        this.scenario = scenario;
        this.scenarioDescription = scenarioDescription;
    }

    public ChaosException(String scenario, String scenarioDescription, String message, Throwable cause) {
        super(message, cause);
        this.scenario = scenario;
        this.scenarioDescription = scenarioDescription;
    }

    public String getScenario() {
        return scenario;
    }

    public String getScenarioDescription() {
        return scenarioDescription;
    }
}
