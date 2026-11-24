import { migrationRunner, sql } from '@forge/sql';

/**
 * Versioned schema migrations, applied by the sync worker before it touches
 * any table. Each migration is applied at most once per installation
 * (migrationRunner tracks applied versions).
 */

// One row per FDA presentation. first_seen/last_seen bracket the period the
// presentation appeared on the FDA list; status_history is a JSON list of
// {status, from, to} transitions.
migrationRunner.enqueue(
  '001-shortage',
  `CREATE TABLE IF NOT EXISTS shortage (
    shortage_key   VARCHAR(64) PRIMARY KEY,
    generic_name   VARCHAR(512),
    status         VARCHAR(64),
    presentation   VARCHAR(512),
    package_ndc    VARCHAR(32),
    dosage_form    VARCHAR(128),
    therapeutic_category VARCHAR(512),
    company_name   VARCHAR(256),
    availability   VARCHAR(128),
    update_type    VARCHAR(64),
    update_date    VARCHAR(32),
    initial_posting_date VARCHAR(32),
    related_info   TEXT,
    discontinued_date VARCHAR(32),
    openfda_json   MEDIUMTEXT,
    status_history MEDIUMTEXT,
    first_seen     DATETIME,
    last_seen      DATETIME
  )`,
);

// The site's drug list, imported via paste/CSV or the sample hospital.
migrationRunner.enqueue(
  '002-formulary-item',
  `CREATE TABLE IF NOT EXISTS formulary_item (
    id              VARCHAR(64) PRIMARY KEY,
    display_name    VARCHAR(512),
    ingredient_names   MEDIUMTEXT,
    ingredient_rxcuis  MEDIUMTEXT,
    package_ndcs    MEDIUMTEXT,
    dosage_forms    MEDIUMTEXT,
    active          TINYINT DEFAULT 1
  )`,
);

// Why each shortage matched a formulary item.
migrationRunner.enqueue(
  '003-match',
  `CREATE TABLE IF NOT EXISTS \`match\` (
    id              BIGINT AUTO_INCREMENT PRIMARY KEY,
    shortage_key    VARCHAR(64),
    formulary_item_id VARCHAR(64),
    reason          VARCHAR(32),
    detail          VARCHAR(1024),
    created_at      DATETIME,
    superseded      TINYINT DEFAULT 0,
    INDEX idx_match_shortage (shortage_key),
    INDEX idx_match_item (formulary_item_id)
  )`,
);

// A Jira work item created for a shortage, plus lifecycle state.
migrationRunner.enqueue(
  '004-response',
  `CREATE TABLE IF NOT EXISTS response (
    id              BIGINT AUTO_INCREMENT PRIMARY KEY,
    shortage_key    VARCHAR(64),
    ingredient      VARCHAR(256),
    jira_issue_key  VARCHAR(32),
    jira_issue_id   VARCHAR(32),
    state           VARCHAR(32),
    opened_at       DATETIME,
    resolved_at     DATETIME,
    reversal_needed TINYINT DEFAULT 0,
    INDEX idx_response_shortage (shortage_key),
    INDEX idx_response_ingredient (ingredient)
  )`,
);

// A page or work item affected by a matched shortage.
migrationRunner.enqueue(
  '005-impact-item',
  `CREATE TABLE IF NOT EXISTS impact_item (
    id              BIGINT AUTO_INCREMENT PRIMARY KEY,
    shortage_key    VARCHAR(64),
    kind            VARCHAR(16),
    ref_id          VARCHAR(64),
    title           VARCHAR(1024),
    url             VARCHAR(1024),
    owner_account_id VARCHAR(64),
    owner_name      VARCHAR(256),
    team_name       VARCHAR(256),
    found_via       VARCHAR(64),
    detail          VARCHAR(1024),
    created_at      DATETIME,
    INDEX idx_impact_shortage (shortage_key),
    INDEX idx_impact_ref (ref_id)
  )`,
);

// A temporary change made for a response, needing reversal on resolution.
migrationRunner.enqueue(
  '006-temporary-change',
  `CREATE TABLE IF NOT EXISTS temporary_change (
    id              BIGINT AUTO_INCREMENT PRIMARY KEY,
    response_id     BIGINT,
    description     VARCHAR(1024),
    impact_item_id  BIGINT,
    reversal_issue_key VARCHAR(32),
    state           VARCHAR(32) DEFAULT 'open',
    created_at      DATETIME,
    reversed_at     DATETIME,
    INDEX idx_temp_response (response_id)
  )`,
);

// Audit log of every sync run.
migrationRunner.enqueue(
  '007-sync-run',
  `CREATE TABLE IF NOT EXISTS sync_run (
    id              BIGINT AUTO_INCREMENT PRIMARY KEY,
    kind            VARCHAR(32),
    state           VARCHAR(32),
    resume_cursor   VARCHAR(128),
    progress        MEDIUMTEXT,
    started_at      DATETIME,
    finished_at     DATETIME,
    result          MEDIUMTEXT
  )`,
);

// App-level settings mirror (the authoritative store is KVS; the table backs
// reporting queries such as dashboard rollups).
migrationRunner.enqueue(
  '008-settings',
  `CREATE TABLE IF NOT EXISTS settings (
    k               VARCHAR(128) PRIMARY KEY,
    v               MEDIUMTEXT,
    updated_at      DATETIME
  )`,
);

// Repair: an early version inserted a new match row per sync, duplicating
// pairs. Keep the lowest-id row per active (shortage, formulary item) pair.
migrationRunner.enqueue(
  '009-match-dedupe',
  `DELETE m1 FROM \`match\` m1
   INNER JOIN \`match\` m2
     ON m1.shortage_key = m2.shortage_key
    AND m1.formulary_item_id = m2.formulary_item_id
    AND m2.superseded = 0
    AND m1.id > m2.id
   WHERE m1.superseded = 0`,
);

// Track 1st-hop vs 2nd-hop Teamwork Graph blast-radius impact items.
migrationRunner.enqueue(
  '010-impact-hop',
  `ALTER TABLE impact_item ADD COLUMN hop TINYINT DEFAULT 1`,
);

// Record the Confluence space key on impacted pages for space-level grouping.
migrationRunner.enqueue(
  '011-impact-space',
  `ALTER TABLE impact_item ADD COLUMN space_key VARCHAR(64)`,
);

// Capture P&T / clinical decision summary on shortage responses for institutional memory.
migrationRunner.enqueue(
  '012-response-decision',
  `ALTER TABLE response ADD COLUMN decision_summary TEXT`,
);

// Persist manufacturer contact info from openFDA shortage records.
migrationRunner.enqueue(
  '013-shortage-contact',
  `ALTER TABLE shortage ADD COLUMN contact_info VARCHAR(512)`,
);

// Clean legacy 10-digit ndc:XXXXXXXXXX keys so 11-digit normalized keys replace them cleanly.
migrationRunner.enqueue(
  '014-match-unique-clean',
  `DELETE FROM shortage WHERE shortage_key LIKE 'ndc:%' AND CHAR_LENGTH(shortage_key) = 14`,
);

migrationRunner.enqueue(
  '015-match-clean-10digit',
  `DELETE FROM \`match\` WHERE shortage_key LIKE 'ndc:%' AND CHAR_LENGTH(shortage_key) = 14`,
);

migrationRunner.enqueue(
  '016-impact-clean-10digit',
  `DELETE FROM impact_item WHERE shortage_key LIKE 'ndc:%' AND CHAR_LENGTH(shortage_key) = 14`,
);

// Track per-owner Jira review tasks so at most one task is created per owner
// per shorted ingredient response (idempotent across runs, cleanable).
migrationRunner.enqueue(
  '017-owner-task',
  `CREATE TABLE IF NOT EXISTS owner_task (
    id                BIGINT AUTO_INCREMENT PRIMARY KEY,
    response_id       BIGINT,
    ingredient_key    VARCHAR(256),
    owner_key         VARCHAR(128),
    owner_account_id  VARCHAR(64),
    owner_name        VARCHAR(256),
    jira_issue_key    VARCHAR(32),
    jira_issue_id     VARCHAR(32),
    created_at        DATETIME,
    UNIQUE KEY uq_owner_task_ing_owner (ingredient_key, owner_key),
    INDEX idx_owner_task_response (response_id)
  )`,
);

/** Execute a parameterized SELECT query and return its rows. */
export async function query<T = Record<string, unknown>>(
  statement: string,
  params: unknown[] = [],
): Promise<T[]> {
  const safeParams = params.map((p) => (p === undefined ? null : p));
  const res = await sql.prepare<T>(statement).bindParams(...safeParams).execute();
  return Array.isArray(res.rows) ? (res.rows as T[]) : [];
}

/** Execute a parameterized INSERT / UPDATE / DELETE statement. */
export async function execute(statement: string, params: unknown[] = []): Promise<void> {
  const safeParams = params.map((p) => (p === undefined ? null : p));
  await sql.prepare(statement).bindParams(...safeParams).execute();
}

/** Apply pending migrations. Idempotent; safe to call at every job start. */
export async function runMigrations(): Promise<string[]> {
  return migrationRunner.run();
}

export { sql };
