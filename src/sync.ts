import { createHash } from 'node:crypto';
import { Queue } from '@forge/events';
import type { UpdateQueryResponse } from '@forge/sql';
import {
  sql,
  query,
  execute,
  runMigrations,
  resetSqlStatementCount,
  getSqlStatementCount,
  recordSqlStatement,
} from './storage/schema';
import { fetchShortages } from './fda';
import { RxNavClient, mapWithConcurrency } from './rxnav';
import { matchShortages, shortageKey } from './match';
import { getSettings } from './settings';
import { kvs } from '@forge/kvs';
import { FdaShortageRecord, FormularyItem, IngredientIndex } from './types';
import { runImpactMapping } from './impact';
import {
  createResponsesForNewMatches,
  openReversalTasks,
  closeSupersededResponses,
  syncOwnerTasksForOpenResponses,
} from './respond';

const syncQueue = new Queue({ key: 'sync-queue' });

const SHORTAGE_BATCH_SIZE = 50;
const MATCH_BATCH_SIZE = 50;
const STALE_ID_BATCH_SIZE = 100;
const RXNAV_CONCURRENCY = 5;
const FDA_SWEEP_HASH_KEY = 'shortfall:fdaSweepHash';

interface SyncProgress {
  fdaDone: number;
  fdaTotal: number;
  matched: number;
  impactDone: number;
  impactTotal: number;
}

interface StatusTransition {
  from: string;
  to: string;
  at: string;
}

function extractInsertId(rows: unknown): number | undefined {
  if (!rows) return undefined;
  if (Array.isArray(rows)) {
    const first = rows[0] as { insertId?: number } | undefined;
    return first?.insertId;
  }
  return (rows as { insertId?: number }).insertId;
}

function trunc(s: string | undefined | null, max: number): string {
  return (s ?? '').slice(0, max);
}

function parseHistory(raw: string | null | undefined): StatusTransition[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as StatusTransition[]) : [];
  } catch {
    return [];
  }
}

async function startSyncRun(kind: string): Promise<number> {
  recordSqlStatement();
  const res = await sql
    .prepare<UpdateQueryResponse>(
      `INSERT INTO sync_run (kind, state, started_at) VALUES (?, 'running', NOW())`,
    )
    .bindParams(kind)
    .execute();
  const id = extractInsertId(res.rows);
  if (id) return id;
  const lookup = await query<{ id: number }>(
    `SELECT id FROM sync_run WHERE state = 'running' ORDER BY id DESC LIMIT 1`,
  );
  return lookup[0]?.id ?? 0;
}

async function updateSyncRun(
  id: number,
  patch: Partial<{ state: string; resumeCursor: string; progress: SyncProgress; result: string }>,
): Promise<void> {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (patch.state !== undefined) {
    sets.push('state = ?');
    params.push(patch.state);
  }
  if (patch.resumeCursor !== undefined) {
    sets.push('resume_cursor = ?');
    params.push(patch.resumeCursor);
  }
  if (patch.progress !== undefined) {
    sets.push('progress = ?');
    params.push(JSON.stringify(patch.progress));
  }
  if (patch.result !== undefined) {
    sets.push('result = ?');
    params.push(patch.result);
  }
  if (!sets.length) return;
  const finishedClause =
    patch.state === 'done' || patch.state === 'error' ? ', finished_at = NOW()' : '';
  params.push(id);
  await execute(`UPDATE sync_run SET ${sets.join(', ')}${finishedClause} WHERE id = ?`, params);
}

/**
 * Enqueue a sync job. Clears stale locks older than 20 minutes first, then
 * skips if another run is actively executing.
 */
export async function enqueueSync(
  kind: 'scheduled' | 'manual' | 'impact',
): Promise<{ queued: boolean }> {
  await runMigrations();
  await execute(
    `UPDATE sync_run
     SET state = 'error', finished_at = NOW(), result = 'Stale lock cleared (>20m)'
     WHERE state = 'running' AND started_at < NOW() - INTERVAL 20 MINUTE`,
  );
  const running = await query<{ id: number }>(
    `SELECT id FROM sync_run WHERE state = 'running' LIMIT 1`,
  );
  if (running.length) return { queued: false };
  await syncQueue.push({ body: { kind } });
  return { queued: true };
}

async function loadFormulary(): Promise<FormularyItem[]> {
  const rows = await query<{
    id: string;
    display_name: string;
    ingredient_names: string;
    ingredient_rxcuis: string;
    package_ndcs: string;
    dosage_forms: string;
  }>(
    `SELECT id, display_name, ingredient_names, ingredient_rxcuis, package_ndcs, dosage_forms
     FROM formulary_item WHERE active = 1`,
  );
  return rows.map((r) => ({
    id: r.id,
    displayName: r.display_name,
    ingredientNames: JSON.parse(r.ingredient_names ?? '[]'),
    ingredientRxcuis: JSON.parse(r.ingredient_rxcuis ?? '[]'),
    packageNdcs: JSON.parse(r.package_ndcs ?? '[]'),
    dosageForms: JSON.parse(r.dosage_forms ?? '[]'),
  }));
}

/**
 * Build the rxcui -> ingredient index needed by the matcher. Resolves unique
 * rxcuis concurrently with bounded parallelism and catches per-rxcui failures
 * so a single RxNav hiccup never aborts sync.
 */
async function buildIngredientIndex(
  records: { openfda?: { rxcui?: string[] } }[],
  rxnav: RxNavClient,
): Promise<IngredientIndex> {
  const index: IngredientIndex = new Map();
  const rxcuis = new Set<string>();
  for (const r of records) {
    for (const c of r.openfda?.rxcui ?? []) rxcuis.add(c);
  }
  await mapWithConcurrency([...rxcuis], RXNAV_CONCURRENCY, async (rxcui) => {
    try {
      index.set(rxcui, await rxnav.ingredientsForRxcui(rxcui));
    } catch {
      index.set(rxcui, []);
    }
  });
  return index;
}

/** Compute a deterministic content hash across all fetched FDA records. */
function computeFdaSweepHash(deduped: Map<string, FdaShortageRecord>): string {
  const hash = createHash('sha256');
  const sortedKeys = [...deduped.keys()].sort();
  for (const key of sortedKeys) {
    const r = deduped.get(key)!;
    hash.update(
      `${key}|${r.status ?? ''}|${r.presentation ?? ''}|${r.package_ndc ?? ''}|${r.dosage_form ?? ''}|${r.company_name ?? ''}|${r.availability ?? ''}|${r.update_date ?? ''}|${r.discontinued_date ?? ''}|${r.contact_info ?? ''}|${r.related_info ?? ''}\n`,
    );
  }
  return hash.digest('hex');
}

async function upsertShortages(
  records: FdaShortageRecord[],
): Promise<{ keys: string[]; newKeys: string[]; resolvedKeys: string[]; upsertedCount: number; skippedUnchanged: boolean }> {
  // Deduplicate within the batch by shortageKey (last wins).
  const deduped = new Map<string, FdaShortageRecord>();
  for (const r of records) {
    deduped.set(shortageKey(r), r);
  }
  const keys = [...deduped.keys()];

  // Fast path: if the full FDA content hash matches the last completed sweep
  // (and the shortage table already has those rows), do 0 SQL writes.
  const sweepHash = computeFdaSweepHash(deduped);
  const prevSweep = (await kvs.get(FDA_SWEEP_HASH_KEY)) as
    | { hash?: string; count?: number }
    | undefined;
  if (prevSweep?.hash === sweepHash && prevSweep?.count === deduped.size && deduped.size > 0) {
    return {
      keys,
      newKeys: [],
      resolvedKeys: [],
      upsertedCount: 0,
      skippedUnchanged: true,
    };
  }

  const existingRows = await query<{
    shortage_key: string;
    status: string | null;
    presentation: string | null;
    availability: string | null;
    update_date: string | null;
    status_history: string | null;
  }>(
    `SELECT shortage_key, status, presentation, availability, update_date, status_history FROM shortage`,
  );
  const existingMap = new Map(existingRows.map((r) => [r.shortage_key, r]));

  const newKeys: string[] = [];
  const resolvedKeys: string[] = [];
  const nowIso = new Date().toISOString();

  interface PreparedShortage {
    key: string;
    record: FdaShortageRecord;
    statusHistoryJson: string | null;
  }

  // Only batch-upsert rows that are brand-new or whose core FDA fields changed.
  const dirtyRows: PreparedShortage[] = [];
  for (const [key, r] of deduped.entries()) {
    const prevRow = existingMap.get(key);
    const prevStatus = prevRow?.status ?? null;
    const nextStatus = r.status ?? '';

    if (!prevRow) {
      newKeys.push(key);
    } else {
      const unchanged =
        (prevRow.status ?? '') === nextStatus &&
        (prevRow.presentation ?? '') === trunc(r.presentation, 512) &&
        (prevRow.availability ?? '') === trunc(r.availability, 128) &&
        (prevRow.update_date ?? '') === trunc(r.update_date, 32);
      if (unchanged) continue;
    }

    if (nextStatus === 'Resolved' && prevStatus && prevStatus !== 'Resolved') {
      resolvedKeys.push(key);
    }

    const history = parseHistory(prevRow?.status_history);
    if (prevStatus && prevStatus !== nextStatus) {
      history.push({ from: prevStatus, to: nextStatus, at: nowIso });
    }
    const statusHistoryJson = history.length ? JSON.stringify(history) : null;
    dirtyRows.push({ key, record: r, statusHistoryJson });
  }

  for (let i = 0; i < dirtyRows.length; i += SHORTAGE_BATCH_SIZE) {
    const chunk = dirtyRows.slice(i, i + SHORTAGE_BATCH_SIZE);
    const placeholders = chunk
      .map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())')
      .join(', ');
    const params: unknown[] = [];
    for (const { key, record: r, statusHistoryJson } of chunk) {
      const category = Array.isArray(r.therapeutic_category)
        ? r.therapeutic_category.join('; ')
        : '';
      params.push(
        trunc(key, 64),
        trunc(r.generic_name, 512),
        trunc(r.status, 64),
        trunc(r.presentation, 512),
        trunc(r.package_ndc, 32),
        trunc(r.dosage_form, 128),
        trunc(category, 512),
        trunc(r.company_name, 256),
        trunc(r.availability, 128),
        trunc(r.update_type, 64),
        trunc(r.update_date, 32),
        trunc(r.initial_posting_date, 32),
        trunc(r.contact_info, 512),
        r.related_info ?? '',
        trunc(r.discontinued_date, 32),
        JSON.stringify(r.openfda ?? {}),
        statusHistoryJson,
      );
    }

    recordSqlStatement();
    await sql
      .prepare(
        `INSERT INTO shortage (
           shortage_key, generic_name, status, presentation, package_ndc, dosage_form,
           therapeutic_category, company_name, availability, update_type, update_date,
           initial_posting_date, contact_info, related_info, discontinued_date,
           openfda_json, status_history, first_seen, last_seen
         ) VALUES ${placeholders}
         ON DUPLICATE KEY UPDATE
           generic_name = VALUES(generic_name),
           status = VALUES(status),
           presentation = VALUES(presentation),
           package_ndc = VALUES(package_ndc),
           dosage_form = VALUES(dosage_form),
           therapeutic_category = VALUES(therapeutic_category),
           company_name = VALUES(company_name),
           availability = VALUES(availability),
           update_type = VALUES(update_type),
           update_date = VALUES(update_date),
           initial_posting_date = VALUES(initial_posting_date),
           contact_info = VALUES(contact_info),
           related_info = VALUES(related_info),
           discontinued_date = VALUES(discontinued_date),
           openfda_json = VALUES(openfda_json),
           status_history = VALUES(status_history),
           last_seen = NOW()`,
      )
      .bindParams(...params)
      .execute();
  }

  await kvs.set(FDA_SWEEP_HASH_KEY, { hash: sweepHash, count: deduped.size });
  return {
    keys,
    newKeys,
    resolvedKeys,
    upsertedCount: dirtyRows.length,
    skippedUnchanged: false,
  };
}

export async function runSyncJob(kind: string): Promise<void> {
  resetSqlStatementCount();
  await runMigrations();
  const runId = await startSyncRun(kind);
  console.log(`[shortfall] sync run ${runId} started (kind=${kind})`);
  const progress: SyncProgress = {
    fdaDone: 0,
    fdaTotal: 0,
    matched: 0,
    impactDone: 0,
    impactTotal: 0,
  };
  try {
    const settings = await getSettings();
    const rxnav = new RxNavClient({
      cacheGet: (k) => kvs.get(k),
      cacheSet: (k, v) => kvs.set(k, v),
    });

    const { records, lastUpdated } = await fetchShortages({
      apiKey: settings.openfdaApiKey,
      onProgress: async (done, total) => {
        progress.fdaDone = done;
        progress.fdaTotal = total;
      },
    });

    const { newKeys, resolvedKeys, upsertedCount, skippedUnchanged } = await upsertShortages(records);
    const formulary = await loadFormulary();
    const index = await buildIngredientIndex(records, rxnav);
    const matches = matchShortages(records, formulary, index);
    progress.matched = matches.length;
    if (!skippedUnchanged) {
      await updateSyncRun(runId, { progress });
    }

    // Persist matches idempotently: keep one active row per
    // (shortage_key, formulary_item_id); supersede rows no longer valid.
    const matchedKeys = new Set(matches.map((m) => m.shortageKey));
    const active = await query<{ id: number; shortage_key: string; formulary_item_id: string }>(
      `SELECT id, shortage_key, formulary_item_id FROM \`match\` WHERE superseded = 0`,
    );
    const wanted = new Set(matches.map((m) => `${m.shortageKey}|${m.formularyItemId}`));
    const activePairs = new Set(active.map((r) => `${r.shortage_key}|${r.formulary_item_id}`));
    const staleIds = active
      .filter((r) => !wanted.has(`${r.shortage_key}|${r.formulary_item_id}`))
      .map((r) => r.id);

    for (let i = 0; i < staleIds.length; i += STALE_ID_BATCH_SIZE) {
      const chunk = staleIds.slice(i, i + STALE_ID_BATCH_SIZE);
      const placeholders = chunk.map(() => '?').join(',');
      await execute(`UPDATE \`match\` SET superseded = 1 WHERE id IN (${placeholders})`, chunk);
    }

    const toInsert: typeof matches = [];
    const insertedPairs = new Set(activePairs);
    for (const m of matches) {
      const pair = `${m.shortageKey}|${m.formularyItemId}`;
      if (insertedPairs.has(pair)) continue;
      insertedPairs.add(pair);
      toInsert.push(m);
    }

    for (let i = 0; i < toInsert.length; i += MATCH_BATCH_SIZE) {
      const chunk = toInsert.slice(i, i + MATCH_BATCH_SIZE);
      const placeholders = chunk.map(() => '(?, ?, ?, ?, NOW())').join(', ');
      const params: unknown[] = [];
      for (const m of chunk) {
        params.push(
          trunc(m.shortageKey, 64),
          trunc(m.formularyItemId, 64),
          trunc(m.reason, 32),
          trunc(m.detail, 1024),
        );
      }
      await execute(
        `INSERT INTO \`match\` (shortage_key, formulary_item_id, reason, detail, created_at)
         VALUES ${placeholders}`,
        params,
      );
    }

    const supersededResponses = await closeSupersededResponses(matchedKeys);
    const impactResult = await runImpactMapping(matchedKeys, progress);
    const newMatchedKeys = newKeys.filter((k) => matchedKeys.has(k));
    const responseResult = settings.autoCreateResponses
      ? await createResponsesForNewMatches([...matchedKeys])
      : { created: 0, skipped: 'auto-create disabled' };
    const ownerTaskResult = settings.autoCreateResponses
      ? await syncOwnerTasksForOpenResponses()
      : { created: [], skippedExisting: 0 };
    const reversalResult = await openReversalTasks(resolvedKeys);

    // Single aggregate query for EVIDENCE logging (replaces 6 separate COUNT queries).
    const countRow = (
      await query<{
        shortage: number;
        formulary_item: number;
        match_n: number;
        impact_item: number;
        response: number;
        sync_run: number;
      }>(
        `SELECT
           (SELECT COUNT(*) FROM shortage) AS shortage,
           (SELECT COUNT(*) FROM formulary_item) AS formulary_item,
           (SELECT COUNT(*) FROM \`match\`) AS match_n,
           (SELECT COUNT(*) FROM impact_item) AS impact_item,
           (SELECT COUNT(*) FROM response) AS response,
           (SELECT COUNT(*) FROM sync_run) AS sync_run`,
      )
    )[0];

    const sqlStatements = getSqlStatementCount();
    await kvs.set('lastSync', {
      finishedAt: new Date().toISOString(),
      fdaLastUpdated: lastUpdated,
      records: records.length,
      upsertedShortages: upsertedCount,
      skippedUnchanged,
      matched: matches.length,
      impact: impactResult,
      responses: responseResult,
      ownerTasks: ownerTaskResult,
      supersededResponses,
      reversals: reversalResult,
      sqlStatements,
    });
    await updateSyncRun(runId, {
      state: 'done',
      progress,
      result: JSON.stringify({
        records: records.length,
        upserted: upsertedCount,
        skippedUnchanged,
        matched: matches.length,
        impact: impactResult,
        sqlStatements: getSqlStatementCount(),
      }),
    });

    console.log(
      '[shortfall] EVIDENCE ' +
        JSON.stringify({
          runId,
          fdaRecords: records.length,
          fdaLastUpdated: lastUpdated,
          upsertedShortages: upsertedCount,
          skippedUnchanged,
          newShortages: newKeys.length,
          newMatchedShortages: newMatchedKeys.length,
          resolvedNow: resolvedKeys.length,
          matches: matches.length,
          impact: impactResult,
          responses: responseResult,
          reversals: reversalResult,
          sqlStatements: getSqlStatementCount(),
          counts: {
            shortage: Number(countRow?.shortage ?? 0),
            formulary_item: Number(countRow?.formulary_item ?? 0),
            match: Number(countRow?.match_n ?? 0),
            impact_item: Number(countRow?.impact_item ?? 0),
            response: Number(countRow?.response ?? 0),
            sync_run: Number(countRow?.sync_run ?? 0),
          },
        }),
    );
  } catch (e) {
    console.log(`[shortfall] sync run ${runId} FAILED: ${String(e)}`);
    await updateSyncRun(runId, { state: 'error', result: String(e) });
    throw e;
  }
}
