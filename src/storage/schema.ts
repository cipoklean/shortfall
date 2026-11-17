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

/** Apply pending migrations. Idempotent; safe to call at every job start. */
export async function runMigrations(): Promise<string[]> {
  return migrationRunner.run();
}

export { sql };
