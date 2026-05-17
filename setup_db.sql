-- ═══════════════════════════════════════════════════════════════
--  RCA Agent — Full Database Setup
--  Run this in MySQL Workbench or mysql CLI as root.
--  mysql -u root -p < setup_db.sql
-- ═══════════════════════════════════════════════════════════════

-- 1. Database
CREATE DATABASE IF NOT EXISTS rca_db
    CHARACTER SET utf8mb4
    COLLATE utf8mb4_unicode_ci;

-- 2. App user  (password matches MYSQL_PASSWORD in .env)
CREATE USER IF NOT EXISTS 'rca'@'localhost' IDENTIFIED BY 'myuser';
GRANT ALL PRIVILEGES ON rca_db.* TO 'rca'@'localhost';
FLUSH PRIVILEGES;

USE rca_db;

-- 3. Tables ──────────────────────────────────────────────────────

-- error_logs: one row per ingested error, updated by RCA agent
CREATE TABLE IF NOT EXISTS error_logs (
    id               CHAR(36)     NOT NULL PRIMARY KEY,
    service_name     VARCHAR(255) NOT NULL,
    environment      VARCHAR(100) NOT NULL,
    error_type       VARCHAR(500) NOT NULL,
    error_message    TEXT         NOT NULL,
    stack_trace      JSON         NOT NULL,
    severity         VARCHAR(50)  NOT NULL,
    occurred_at      DATETIME     NOT NULL,
    request_id       VARCHAR(255),
    user_id          VARCHAR(255),
    metadata         JSON,
    rca_status       VARCHAR(50)  NOT NULL DEFAULT 'pending',
    rca_started_at   DATETIME,
    rca_completed_at DATETIME,
    rca_result       JSON,
    rca_error        TEXT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- service_repo_map: maps service name → GitHub org/repo
CREATE TABLE IF NOT EXISTS service_repo_map (
    service_name   VARCHAR(255) NOT NULL PRIMARY KEY,
    github_org     VARCHAR(255) NOT NULL,
    github_repo    VARCHAR(255) NOT NULL,
    default_branch VARCHAR(100) NOT NULL DEFAULT 'main',
    language       VARCHAR(100),
    onboarded_at   DATETIME DEFAULT NOW(),
    onboarded_by   VARCHAR(255),
    notes          TEXT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- service_context_cache: caches GitHub file content across RCA runs
CREATE TABLE IF NOT EXISTS service_context_cache (
    id             INT          NOT NULL AUTO_INCREMENT PRIMARY KEY,
    service_name   VARCHAR(255) NOT NULL,
    cache_key      VARCHAR(500) NOT NULL,
    content        JSON         NOT NULL,
    commit_sha     VARCHAR(40),
    created_at     DATETIME     DEFAULT NOW(),
    last_used_at   DATETIME     DEFAULT NOW(),
    invalidated_at DATETIME,
    UNIQUE KEY uq_cache (service_name, cache_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- rca_reports: completed RCA reports (also stored inside error_logs.rca_result)
CREATE TABLE IF NOT EXISTS rca_reports (
    rca_id        VARCHAR(36)  NOT NULL PRIMARY KEY,
    error_log_id  CHAR(36),
    service_name  VARCHAR(255) NOT NULL,
    generated_at  VARCHAR(50)  NOT NULL,
    report        JSON         NOT NULL,
    created_at    DATETIME     DEFAULT NOW(),
    CONSTRAINT fk_rca_error_log
        FOREIGN KEY (error_log_id) REFERENCES error_logs(id)
        ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 4. Indexes ─────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_error_logs_service  ON error_logs(service_name);
CREATE INDEX IF NOT EXISTS idx_error_logs_occurred ON error_logs(occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_error_logs_status   ON error_logs(rca_status);
CREATE INDEX IF NOT EXISTS idx_cache_service       ON service_context_cache(service_name);

-- ── Verify ──────────────────────────────────────────────────────
SHOW TABLES;
SELECT 'rca_db setup complete' AS status;
