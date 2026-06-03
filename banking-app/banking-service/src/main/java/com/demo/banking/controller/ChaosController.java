package com.demo.banking.controller;

import com.demo.banking.dto.TransactionDto;
import com.demo.banking.service.AccountService;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.math.BigDecimal;
import java.time.LocalDateTime;
import java.util.List;
import java.util.Map;

/**
 * ChaosController — thin HTTP trigger layer for RCA scenario testing.
 *
 * Each endpoint immediately delegates to AccountService so that exceptions
 * and their stack traces originate in the real business layer, NOT here.
 *
 * RULE: zero business logic in this class. Construct the minimal input
 * needed to exercise the planted bug, then call AccountService and return.
 */
@RestController
@RequestMapping("/chaos")
@RequiredArgsConstructor
@Slf4j
public class ChaosController {

    private final AccountService accountService;

    private static final List<Map<String, String>> SCENARIOS = List.of(
        Map.of(
            "id",          "null-pointer",
            "name",        "NullPointerException in AccountService.getAccountEnrichment",
            "description", "Calls getAccountEnrichment(1) — enrichment cache miss → NPE inside AccountService",
            "severity",    "ERROR"
        ),
        Map.of(
            "id",          "insufficient-funds",
            "name",        "InsufficientFundsException in AccountService.withdraw",
            "description", "Withdraws $9,999,999.99 from account 1 — InsufficientFundsException inside AccountService",
            "severity",    "ERROR"
        ),
        Map.of(
            "id",          "db-connection",
            "name",        "RuntimeException in AccountService.processBatchStatement",
            "description", "Triggers secondary JDBC pool exhaustion → RuntimeException inside AccountService",
            "severity",    "ERROR"
        ),
        Map.of(
            "id",          "account-not-found",
            "name",        "AccountNotFoundException in AccountService",
            "description", "Looks up account id=999999999 → AccountNotFoundException inside AccountService.findAccountById",
            "severity",    "ERROR"
        )
    );

    @GetMapping("/scenarios")
    public ResponseEntity<Map<String, Object>> listScenarios() {
        return ResponseEntity.ok(Map.of(
            "scenarios", SCENARIOS,
            "count",     SCENARIOS.size(),
            "timestamp", LocalDateTime.now().toString()
        ));
    }

    /**
     * Delegates to AccountService.getAccountEnrichment — NullPointerException
     * originates there when the enrichment cache returns null for account 1.
     */
    @PostMapping("/null-pointer")
    public ResponseEntity<Void> triggerNullPointer() {
        log.info("CHAOS: triggering null-pointer via AccountService.getAccountEnrichment(1)");
        accountService.getAccountEnrichment(1L);
        return ResponseEntity.ok().build();
    }

    /**
     * Delegates to AccountService.withdraw — InsufficientFundsException
     * originates there when the requested amount exceeds account balance.
     */
    @PostMapping("/insufficient-funds")
    public ResponseEntity<Void> triggerInsufficientFunds() {
        log.info("CHAOS: triggering insufficient-funds via AccountService.withdraw(1, 9999999.99)");
        TransactionDto.MoneyRequest req = TransactionDto.MoneyRequest.builder()
                .amount(new BigDecimal("9999999.99"))
                .description("chaos: large withdrawal test")
                .build();
        accountService.withdraw(1L, req);
        return ResponseEntity.ok().build();
    }

    /**
     * Delegates to AccountService.processBatchStatement — RuntimeException
     * originates there when the secondary JDBC pool is exhausted.
     */
    @PostMapping("/db-connection")
    public ResponseEntity<Void> triggerDbConnection() {
        log.info("CHAOS: triggering db-connection via AccountService.processBatchStatement");
        accountService.processBatchStatement("BATCH-CHAOS-001");
        return ResponseEntity.ok().build();
    }

    /**
     * Delegates to AccountService.getAccountById — AccountNotFoundException
     * originates there when no account with id=999999999 exists.
     */
    @PostMapping("/account-not-found")
    public ResponseEntity<Void> triggerAccountNotFound() {
        log.info("CHAOS: triggering account-not-found via AccountService.getAccountById(999999999)");
        accountService.getAccountById(999_999_999L);
        return ResponseEntity.ok().build();
    }
}
