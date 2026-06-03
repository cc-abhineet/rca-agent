#!/usr/bin/env python3
"""
setup_db.py
-----------
Run this once to:
  1. Create the `rca_db` database
  2. Create the `rca` user with password `varun`
  3. Grant all privileges on rca_db to rca@localhost
  4. Create all four tables (error_logs, service_repo_map,
     service_context_cache, rca_reports)

Usage:
    python setup_db.py --root-password YOUR_MYSQL_ROOT_PASSWORD

    # Or if root has no password:
    python setup_db.py --root-password ""
"""
import argparse
import sys

try:
    import pymysql
except ImportError:
    print("PyMySQL not installed. Run:  pip install PyMySQL")
    sys.exit(1)


DB_NAME   = "rca_db"
APP_USER  = "myuser"
APP_PASS  = "mypassword"        # matches MYSQL_PASSWORD in .env
APP_HOST  = "localhost"

DDL = [
    # -- error_logs ----------------------------------------------------------
    """
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
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    """,

    # -- service_repo_map ----------------------------------------------------
    """
    CREATE TABLE IF NOT EXISTS service_repo_map (
        service_name   VARCHAR(255) NOT NULL PRIMARY KEY,
        github_org     VARCHAR(255) NOT NULL,
        github_repo    VARCHAR(255) NOT NULL,
        default_branch VARCHAR(100) NOT NULL DEFAULT 'main',
        language       VARCHAR(100),
        onboarded_at   DATETIME DEFAULT NOW(),
        onboarded_by   VARCHAR(255),
        notes          TEXT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    """,

    # -- service_context_cache -----------------------------------------------
    """
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
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    """,

    # -- rca_reports ---------------------------------------------------------
    """
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
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    """,

]

# Indexes are separate -- MySQL has no CREATE INDEX IF NOT EXISTS,
# so we catch error 1061 (Duplicate key name) and skip silently.
INDEXES = [
    "CREATE INDEX idx_error_logs_service  ON error_logs(service_name)",
    "CREATE INDEX idx_error_logs_occurred ON error_logs(occurred_at DESC)",
    "CREATE INDEX idx_error_logs_status   ON error_logs(rca_status)",
    "CREATE INDEX idx_cache_service       ON service_context_cache(service_name)",
]


def run(root_password: str, root_host: str, root_port: int):
    print("\n" + "-"*55)
    print("  RCA Agent -- Database Setup")
    print("-"*55)

    # -- Step 1: connect as root (no database selected yet) ------------------
    print(f"\n[1/4] Connecting to MySQL as root @ {root_host}:{root_port} ...")
    try:
        root_conn = pymysql.connect(
            host=root_host,
            port=root_port,
            user="root",
            password=root_password,
            charset="utf8mb4",
        )
    except pymysql.err.OperationalError as e:
        print(f"      ERROR: {e}")
        print("      Check your root password with --root-password flag.")
        sys.exit(1)
    print("      Connected.")

    with root_conn.cursor() as cur:

        # -- Step 2: create database -----------------------------------------
        print(f"\n[2/4] Creating database `{DB_NAME}` ...")
        cur.execute(
            f"CREATE DATABASE IF NOT EXISTS `{DB_NAME}` "
            f"CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
        )
        print(f"      Database `{DB_NAME}` ready.")

        # -- Step 3: create user + grant -------------------------------------
        print(f"\n[3/4] Creating user `{APP_USER}`@`{APP_HOST}` ...")
        cur.execute(
            f"CREATE USER IF NOT EXISTS '{APP_USER}'@'{APP_HOST}' "
            f"IDENTIFIED BY '{APP_PASS}'"
        )
        cur.execute(
            f"GRANT ALL PRIVILEGES ON `{DB_NAME}`.* "
            f"TO '{APP_USER}'@'{APP_HOST}'"
        )
        cur.execute("FLUSH PRIVILEGES")
        print(f"      User `{APP_USER}` granted full access to `{DB_NAME}`.")

    root_conn.commit()
    root_conn.close()

    # -- Step 4: connect as app user and create tables -----------------------
    print(f"\n[4/4] Creating tables in `{DB_NAME}` ...")
    app_conn = pymysql.connect(
        host=root_host,
        port=root_port,
        user=APP_USER,
        password=APP_PASS,
        database=DB_NAME,
        charset="utf8mb4",
    )
    with app_conn.cursor() as cur:
        # Create tables
        for sql in DDL:
            cur.execute(sql.strip())
        app_conn.commit()

        # Create indexes -- skip if already exist (error 1061)
        for sql in INDEXES:
            try:
                cur.execute(sql.strip())
                app_conn.commit()
            except pymysql.err.OperationalError as e:
                if e.args[0] == 1061:   # Duplicate key name
                    pass
                else:
                    raise

        # Verify
        cur.execute("SHOW TABLES")
        created = [row[0] for row in cur.fetchall()]

    app_conn.close()

    print("\n" + "-"*55)
    print("  Tables created:")
    for t in created:
        print(f"    *  {t}")

    print("\n" + "-"*55)
    print("  Setup complete! Add these to your .env files:\n")

    print("  banking-app-master/rca-agent/.env")
    print(f"    DATABASE_URL=mysql+pymysql://{APP_USER}:{APP_PASS}@{root_host}:{root_port}/{DB_NAME}")

    print()
    print("  banking-app-master/error-ingestion-agent/.env  (if running separately)")
    print(f"    DATABASE_URL=mysql+pymysql://{APP_USER}:{APP_PASS}@{root_host}:{root_port}/{DB_NAME}")
    print("-"*55 + "\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Create rca_db MySQL database and tables")
    parser.add_argument("--root-password", required=True, help="MySQL root password")
    parser.add_argument("--host", default="localhost", help="MySQL host (default: localhost)")
    parser.add_argument("--port", type=int, default=3306, help="MySQL port (default: 3306)")
    args = parser.parse_args()

    run(args.root_password, args.host, args.port)
