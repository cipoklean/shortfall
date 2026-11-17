import Resolver from '@forge/resolver';
import { kvs } from '@forge/kvs';
import { sql, runMigrations } from './storage/schema';
import { getSettings, saveSettings, AppSettings } from './settings';
import { enqueueSync } from './sync';
import { probeGraph } from './graph';
import { FormularyItem } from './types';
import { normalizeDrugName, stripSalts } from './match';
import { loadSampleHospital, removeSampleHospital, getSampleState } from './sample';

const resolver = new Resolver();

/** Dashboard: last sync result + headline counts. */
resolver.define('getDashboardData', async () => {
  await runMigrations();
  const lastSync = (await kvs.get('lastSync')) ?? null;
  const active = await sql.executeRaw<{ n: number }>(
    `SELECT COUNT(DISTINCT s.shortage_key) AS n FROM shortage s
     JOIN \`match\` m ON m.shortage_key = s.shortage_key WHERE s.status = 'Current'`,
  );
  const impacts = await sql.executeRaw<{ n: number }>(
    `SELECT COUNT(*) AS n FROM impact_item`,
  );
  const settings = await getSettings();
  const graph = await probeGraph((await kvs.get('graphUserId')) as string | undefined);
  return {
    lastSync,
    activeMatched: active.rows?.[0]?.n ?? 0,
    impactItems: impacts.rows?.[0]?.n ?? 0,
    setupComplete: settings.setupComplete,
    autoCreateResponses: settings.autoCreateResponses,
    reducedMode: [...graph.missingScopes, ...(graph.note && !graph.available ? [graph.note] : [])],
  };
});

/** Setup wizard state. */
resolver.define('getSetupState', async () => {
  const settings = await getSettings();
  const formulary = await sql.executeRaw<{ n: number }>(
    `SELECT COUNT(*) AS n FROM formulary_item WHERE active = 1`,
  );
  return { settings, formularyCount: formulary.rows?.[0]?.n ?? 0 };
});

resolver.define('saveSettings', async ({ payload }: { payload: Partial<AppSettings> }) => {
  return { settings: await saveSettings(payload) };
});

/** Import formulary rows (paste/CSV parsed client-side into FormularyItem[]). */
resolver.define('importFormulary', async ({ payload }: { payload: { items: FormularyItem[] } }) => {
  await runMigrations();
  let count = 0;
  for (const item of payload.items) {
    const esc = (s: string) => s.replace(/'/g, "''");
    await sql.executeRaw(
      `INSERT INTO formulary_item (id, display_name, ingredient_names, ingredient_rxcuis, package_ndcs, dosage_forms, active)
       VALUES ('${esc(item.id)}', '${esc(item.displayName)}', '${esc(JSON.stringify(item.ingredientNames.map((n) => stripSalts(normalizeDrugName(n)))))}', '${esc(JSON.stringify(item.ingredientRxcuis))}', '${esc(JSON.stringify(item.packageNdcs))}', '${esc(JSON.stringify(item.dosageForms.map(normalizeDrugName)))}', 1)
       ON DUPLICATE KEY UPDATE display_name = VALUES(display_name), ingredient_names = VALUES(ingredient_names), ingredient_rxcuis = VALUES(ingredient_rxcuis), package_ndcs = VALUES(package_ndcs), dosage_forms = VALUES(dosage_forms), active = 1`,
    );
    count++;
  }
  return { imported: count };
});

/** "Sync now" button. */
interface ReqContext { accountId?: string; cloudId?: string; installContext?: string }

/** Capture the calling user's identity + site id for async graph calls. */
async function captureContext(ctx?: ReqContext) {
  const accountId = ctx?.accountId;
  if (accountId) await kvs.set('graphUserId', accountId);
  const cloudId = ctx?.cloudId ?? String(ctx?.installContext ?? '').match(/[0-9a-f-]{36}/i)?.[0];
  if (cloudId) await kvs.set('cloudId', cloudId);
}

resolver.define('startSync', async ({ context }: { context?: ReqContext }) => {
  await captureContext(context);
  await runMigrations();
  return enqueueSync('manual');
});

/** Matched shortages for the dashboard (joined to formulary display names). */
resolver.define('getMatchedShortages', async () => {
  const rows = await sql.executeRaw<{
    shortage_key: string; generic_name: string; status: string; package_ndc: string;
    presentation: string; dosage_form: string; company_name: string; update_date: string;
    initial_posting_date: string; reason: string; display_name: string;
  }>(
    `SELECT s.shortage_key, s.generic_name, s.status, s.package_ndc, s.presentation,
            s.dosage_form, s.company_name, s.update_date, s.initial_posting_date,
            m.reason, f.display_name
     FROM \`match\` m
     JOIN shortage s ON s.shortage_key = m.shortage_key
     JOIN formulary_item f ON f.id = m.formulary_item_id
     ORDER BY CASE s.status WHEN 'Current' THEN 0 WHEN 'To Be Discontinued' THEN 1 ELSE 2 END,
              s.update_date DESC
     LIMIT 200`,
  );
  return (rows.rows ?? []).map((r) => ({
    shortageId: r.shortage_key,
    genericName: r.generic_name,
    presentation: r.presentation,
    packageNdc: r.package_ndc,
    dosageForm: r.dosage_form,
    company: r.company_name,
    status: r.status,
    updateDate: r.update_date,
    initialPostingDate: r.initial_posting_date,
    matchedTo: r.display_name,
    reason: r.reason,
    source: `https://api.fda.gov/drug/shortages.json?search=package_ndc:%22${r.package_ndc}%22`,
  }));
});

/** Recent sync_run rows for the dashboard log view. */
resolver.define('getSyncLog', async () => {
  const rows = await sql.executeRaw<{
    id: number; kind: string; state: string; started_at: string; finished_at: string; result: string;
  }>(`SELECT id, kind, state, started_at, finished_at, result FROM sync_run ORDER BY id DESC LIMIT 10`);
  return rows.rows ?? [];
});

resolver.define('loadSampleHospital', async ({ context }: { context?: ReqContext }) => {
  await captureContext(context);
  await runMigrations();
  return loadSampleHospital();
});

resolver.define('removeSampleHospital', async () => {
  await runMigrations();
  return removeSampleHospital();
});

resolver.define('getSampleState', async () => {
  return getSampleState();
});

resolver.define('getSyncProgress', async () => {
  const rows = await sql.executeRaw<{ state: string; progress: string; started_at: string; result: string }>(
    `SELECT state, progress, started_at, result FROM sync_run ORDER BY id DESC LIMIT 1`,
  );
  const r = rows.rows?.[0];
  if (!r) return { state: 'none' };
  return { state: r.state, progress: r.progress ? JSON.parse(r.progress) : null, startedAt: r.started_at, result: r.result };
});

/** Is this page in the impact map of an active shortage? */
export async function getPageNoticeData(pageId: string | undefined) {
  if (!pageId) return { affected: false as const };
  const rows = await sql.executeRaw<{
    shortage_key: string; title: string; generic_name: string; status: string;
  }>(
    `SELECT i.shortage_key, i.title, s.generic_name, s.status
     FROM impact_item i JOIN shortage s ON s.shortage_key = i.shortage_key
     WHERE i.kind = 'page' AND i.ref_id = '${String(pageId).replace(/'/g, "''")}' AND s.status = 'Current'`,
  );
  const items = rows.rows ?? [];
  if (!items.length) return { affected: false as const };
  const resp = await sql.executeRaw<{ jira_issue_key: string }>(
    `SELECT jira_issue_key FROM response WHERE shortage_key = '${items[0].shortage_key}' LIMIT 1`,
  );
  return {
    affected: true as const,
    shortages: items.map((i) => ({ name: i.generic_name, shortageId: i.shortage_key })),
    responseWorkItem: resp.rows?.[0]?.jira_issue_key,
  };
}

/** Byline popup: is this page in the impact map of an active shortage? */
resolver.define('getPageNotice', async ({ context }: { context: { extension?: { content?: { id?: string } } } }) => {
  return getPageNoticeData(context?.extension?.content?.id);
});

/** Issue panel on a response work item: full picture for one shortage. */
resolver.define('getIssuePanelData', async ({ context }: { context: { issueKey?: string } }) => {
  const issueKey = context?.issueKey;
  if (!issueKey) return { found: false };
  const resp = await sql.executeRaw<{ shortage_key: string }>(
    `SELECT shortage_key FROM response WHERE jira_issue_key = '${String(issueKey).replace(/'/g, "''")}' LIMIT 1`,
  );
  const key = resp.rows?.[0]?.shortage_key;
  if (!key) return { found: false, issueKey };
  const shortage = await sql.executeRaw(
    `SELECT generic_name, presentation, status, package_ndc, update_date, company_name, availability, related_info FROM shortage WHERE shortage_key = '${key}'`,
  );
  const impact = await sql.executeRaw(
    `SELECT kind, ref_id, title, url, owner_name, team_name, found_via FROM impact_item WHERE shortage_key = '${key}' ORDER BY kind, title`,
  );
  return { found: true, shortage: shortage.rows?.[0], impact: impact.rows ?? [] };
});

/**
 * Foreground enrichment: fill owner/team on impact pages via Teamwork Graph.
 * Runs as the calling user (the only context the graph API accepts), so it
 * is invoked from the dashboard rather than the async worker.
 */
resolver.define('enrichImpact', async ({ context }: { context?: ReqContext }) => {
  await captureContext(context);
  const cloudId = (await kvs.get('cloudId')) as string | undefined;
  const rows = (await sql.executeRaw<{ id: number; ref_id: string }>(
    `SELECT id, ref_id FROM impact_item WHERE kind = 'page'`,
  )).rows ?? [];
  const { pageOwners, pageCreator } = await import('./graph');
  let enriched = 0;
  const missing: string[] = [];
  for (const row of rows) {
    const pageAri = cloudId ? `ari:cloud:confluence:${cloudId}:page/${row.ref_id}` : `ari:cloud:confluence::page/${row.ref_id}`;
    const owners = await pageOwners(pageAri);
    if (owners.error) { missing.push(owners.error); continue; }
    const nodes = owners.nodes.length ? owners.nodes : (await pageCreator(pageAri)).nodes;
    const name = nodes.map((n) => n.name ?? n.displayName ?? '').filter(Boolean).join(', ');
    if (name) {
      await sql.executeRaw(`UPDATE impact_item SET owner_name = '${name.replace(/'/g, "''")}' WHERE id = ${row.id}`);
      enriched++;
    }
  }
  return { enriched, missing: [...new Set(missing)].slice(0, 10) };
});

export const uiResolver = resolver.getDefinitions();
