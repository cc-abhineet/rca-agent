-- ─────────────────────────────────────────────────────────────────────────────
-- data.sql — H2 in-memory seed data for banking-app
--
-- Loaded automatically by Spring Boot when spring.jpa.hibernate.ddl-auto
-- is set to create-drop (the default for H2 in application.yml).
-- Spring creates the schema from the JPA entity definitions first, then
-- executes this file.
--
-- Accounts here are used by:
--   - Normal banking endpoints (GET /accounts, GET /accounts/{id})
--   - Chaos scenarios (the insufficient-funds scenario references CHAOS-001
--     in its log message, though the exception is thrown synthetically)
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO accounts (owner_name, account_number, account_type, balance, status)
VALUES
    -- Standard demo accounts
    ('Alice Johnson',  'ACC-1001', 'SAVINGS',        10000.00, 'ACTIVE'),
    ('Bob Smith',      'ACC-1002', 'CHECKING',         2500.50, 'ACTIVE'),
    ('Carol Williams', 'ACC-1003', 'FIXED_DEPOSIT',   50000.00, 'ACTIVE'),

    -- Frozen account — for testing status-check error paths
    ('Dave Brown',     'ACC-1004', 'SAVINGS',           150.00, 'FROZEN'),

    -- Chaos test account — referenced in ChaosController insufficient-funds scenario.
    -- Balance intentionally near-zero to make the scenario realistic.
    ('Chaos Test',     'CHAOS-001', 'CHECKING',          0.01, 'ACTIVE');
