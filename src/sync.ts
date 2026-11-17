import { Queue } from '@forge/events';
import { sql, runMigrations } from './storage/schema';
import { fetchShortages } from './fda';
import { RxNavClient } from './rxnav';
import { matchShortages, shortageKey } from './match';
import { getSettings } from './settings';
import { kvs } from '@forge/kvs';
import { FdaShortageRecord, FormularyItem, IngredientIndex } from './types';
import { runImpactMapping } from './impact';
import { createResponsesForNewMatches, openReversalTasks } from './respond';

const syncQueue = new Queue({ key: 'sync-queue' });

interface SyncProgress {
  fdaDone: number;
  fdaTotal: number;
  matched: number;
  impactDone: number;
  impactTotal: number;
}

async function startSyncRun(kind: string): Promise<number> {
  const res = await sql.executeRaw<{ insertId: number }>(
    `INSERT INTO sync_run (kind, state, started_at) VALUES ('${kind}', 'running', NOW())`,
  );
  // Forge SQL returns insertId via rows for inserts where available; fall back to a lookup.
  const id = res.rows?.[0]?.insertId;
  if (id) return id;
  const lookup = await sql.executeRaw<{ id: number }>(
    `SELECT id FROM sync_run WHERE state = 'running' ORDER BY id DESC LIMIT 1`,
  );
  return lookup.rows?.[0]?.id ?? 0;
}

async function updateSyncRun(id: number, patch: Partial<{ state: string; resumeCursor: string; progress: SyncProgress; result: string }>): Promise<void> {
  const sets: string[] = [];
  if (patch.state) sets.push(`state = '${patch.state}'`);
  if (patch.resumeCursor) sets.push(`resume_cursor = '${patch.resumeCursor}'`);
  if (patch.progress) sets.push(`progress = '${JSON.stringify(patch.progress).replace(/'/g, "''")}'`);
  if (patch.result !== undefined) sets.push(`result = '${patch.result.replace(/'/g, "''")}'`);
  if (!sets.length) return;
  await sql.executeRaw(`UPDATE sync_run SET ${sets.join(', ')}${patch.state === 'done' || patch.state === 'error' ? ', finished_at = NOW()' : ''} WHERE id = ${id}`);
}

/** Enqueue a sync job. Idempotent: skipped when a run is already active. */
export async function enqueueSync(kind: 'scheduled' | 'manual' | 'impact'): Promise<{ queued: boolean }> {
  const running = await sql.executeRaw<{ id: number }>(
    `SELECT id FROM sync_run WHERE state = 'running' LIMIT 1`,
  );
  if (running.rows?.length) return { queued: false };
  await syncQueue.push({ body: { kind } });
  return { queued: true };
}

async function loadFormulary(): Promise<FormularyItem[]> {
  const res = await sql.executeRaw<{
    id: string; display_name: string; ingredient_names: string;
    ingredient_rxcuis: string; package_ndcs: string; dosage_forms: string;
  }>(`SELECT id, display_name, ingredient_names, ingredient_rxcuis, package_ndcs, dosage_forms FROM formulary_item WHERE active = 1`);
  return (res.rows ?? []).map((r) => ({
    id: r.id,
    displayName: r.display_name,
    ingredientNames: JSON.parse(r.ingredient_names ?? '[]'),
    ingredientRxcuis: JSON.parse(r.ingredient_rxcuis ?? '[]'),
    packageNdcs: JSON.parse(r.package_ndcs ?? '[]'),
    dosageForms: JSON.parse(r.dosage_forms ?? '[]'),
  }));
}

/**
 * Build the rxcui→ingredient index needed by the matcher. Only rxcuis that
 * actually appear on fetched shortage records are resolved, so RxNav calls
 * stay bounded; results are cached in KVS.
 */
async function buildIngredientIndex(records: { openfda?: { rxcui?: string[] } }[], rxnav: RxNavClient): Promise<IngredientIndex> {
  const index: IngredientIndex = new Map();
  const rxcuis = new Set<string>();
  for (const r of records) for (const c of r.openfda?.rxcui ?? []) rxcuis.add(c);
  for (const rxcui of rxcuis) {
    index.set(rxcui, await rxnav.ingredientsForRxcui(rxcui));
  }
  return index;
}

async function upsertShortages(records: FdaShortageRecord[]): Promise<{ keys: string[]; newKeys: string[]; resolvedKeys: string[] }> {
  const keys: string[] = [];
  const newKeys: string[] = [];
  const resolvedKeys: string[] = [];
  for (const r of records) {
    const key = shortageKey(r);
    keys.push(key);
    const existing = await sql.executeRaw<{ status: string }>(
      `SELECT status FROM shortage WHERE shortage_key = '${key.replace(/'/g, "''")}'`,
    );
    const prev = existing.rows?.[0]?.status;
    const esc = (s: string | undefined) => (s ?? '').replace(/'/g, "''");
    const status = esc(r.status);
    if (!prev) newKeys.push(key);
    if (status === 'Resolved' && prev && prev !== 'Resolved') resolvedKeys.push(key);
    const transition = prev && prev !== status
      ? JSON.stringify([{ from: prev, to: status, at: new Date().toISOString() }])
      : null;
    await sql.executeRaw(
      `INSERT INTO shortage (shortage_key, generic_name, status, presentation, package_ndc, dosage_form, company_name, availability, update_type, update_date, initial_posting_date, related_info, discontinued_date, openfda_json, status_history, first_seen, last_seen)
       VALUES ('${key}', '${esc(r.generic_name)}', '${status}', '${esc(r.presentation)}', '${esc(r.package_ndc)}', '${esc(r.dosage_form)}', '${esc(r.company_name)}', '${esc(r.availability)}', '${esc(r.update_type)}', '${esc(r.update_date)}', '${esc(r.initial_posting_date)}', '${esc(r.related_info)}', '${esc(r.discontinued_date)}', '${JSON.stringify(r.openfda ?? {}).replace(/'/g, "''")}', NULL, NOW(), NOW())
       ON DUPLICATE KEY UPDATE status = VALUES(status), last_seen = NOW(), presentation = VALUES(presentation), availability = VALUES(availability), update_date = VALUES(update_date), openfda_json = VALUES(openfda_json)`,
    );
    if (transition) {
      // Append the transition into the JSON status_history array.
      await sql.executeRaw(
        `UPDATE shortage SET status_history = CONCAT(
           '[', COALESCE(NULLIF(TRIM(BOTH ']' FROM status_history), ''), ''),
           IF(status_history IS NULL OR status_history = '' OR status_history = '[]', '', ','),
           SUBSTRING('${transition.replace(/'/g, "''")}', 2, CHAR_LENGTH('${transition.replace(/'/g, "''")}') - 2),
           ']'
         ) WHERE shortage_key = '${key}'`,
      );
    }
  }
  return { keys, newKeys, resolvedKeys };
}

export async function runSyncJob(kind: string): Promise<void> {
  await runMigrations();
  const runId = await startSyncRun(kind);
  console.log(`[shortfall] sync run ${runId} started (kind=${kind})`);
  const progress: SyncProgress = { fdaDone: 0, fdaTotal: 0, matched: 0, impactDone: 0, impactTotal: 0 };
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

    const { newKeys, resolvedKeys } = await upsertShortages(records);
    const formulary = await loadFormulary();
    const index = await buildIngredientIndex(records, rxnav);
    const matches = matchShortages(records, formulary, index);
    progress.matched = matches.length;
    await updateSyncRun(runId, { progress });

    // Persist matches idempotently: keep one active row per
    // (shortage_key, formulary_item_id); supersede rows no longer valid.
    const matchedKeys = new Set(matches.map((m) => m.shortageKey));
    const active = (await sql.executeRaw<{ id: number; shortage_key: string; formulary_item_id: string }>(
      `SELECT id, shortage_key, formulary_item_id FROM \`match\` WHERE superseded = 0`,
    )).rows ?? [];
    const wanted = new Set(matches.map((m) => `${m.shortageKey}|${m.formularyItemId}`));
    const activePairs = new Set(active.map((r) => `${r.shortage_key}|${r.formulary_item_id}`));
    const staleIds = active.filter((r) => !wanted.has(`${r.shortage_key}|${r.formulary_item_id}`)).map((r) => r.id);
    for (const id of staleIds) {
      await sql.executeRaw(`UPDATE \`match\` SET superseded = 1 WHERE id = ${id}`);
    }
    for (const m of matches) {
      if (activePairs.has(`${m.shortageKey}|${m.formularyItemId}`)) continue;
      await sql.executeRaw(
        `INSERT INTO \`match\` (shortage_key, formulary_item_id, reason, detail, created_at)
         VALUES ('${m.shortageKey}', '${m.formularyItemId}', '${m.reason}', '${m.detail.replace(/'/g, "''")}', NOW())`,
      );
    }

    const impactResult = await runImpactMapping(matchedKeys, progress);
    const responseResult = settings.autoCreateResponses
      ? await createResponsesForNewMatches(newKeys)
      : { created: 0, skipped: 'auto-create disabled' };
    const reversalResult = await openReversalTasks(resolvedKeys);

    await kvs.set('lastSync', {
      finishedAt: new Date().toISOString(),
      fdaLastUpdated: lastUpdated,
      records: records.length,
      matched: matches.length,
      impact: impactResult,
      responses: responseResult,
      reversals: reversalResult,
    });
    await updateSyncRun(runId, {
      state: 'done',
      progress,
      result: JSON.stringify({ records: records.length, matched: matches.length, impact: impactResult }),
    });

    // Evidence for `forge logs`: run summary + table counts after the run.
    const count = async (t: string) =>
      (await sql.executeRaw<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t}`)).rows?.[0]?.n ?? 0;
    console.log('[shortfall] EVIDENCE ' + JSON.stringify({
      runId,
      fdaRecords: records.length,
      fdaLastUpdated: lastUpdated,
      newShortages: newKeys.length,
      resolvedNow: resolvedKeys.length,
      matches: matches.length,
      impact: impactResult,
      responses: responseResult,
      reversals: reversalResult,
      counts: {
        shortage: await count('shortage'),
        formulary_item: await count('formulary_item'),
        match: await count('\`match\`'),
        impact_item: await count('impact_item'),
        response: await count('response'),
        sync_run: await count('sync_run'),
      },
    }));
  } catch (e) {
    console.log(`[shortfall] sync run ${runId} FAILED: ${String(e)}`);
    await updateSyncRun(runId, { state: 'error', result: String(e) });
    throw e;
  }
}
