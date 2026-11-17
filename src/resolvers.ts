import Resolver from '@forge/resolver';
import { kvs } from '@forge/kvs';
import { sql, runMigrations } from './storage/schema';
import { getSettings, saveSettings, AppSettings } from './settings';
import { enqueueSync } from './sync';
import { probeGraph } from './graph';
import { FormularyItem } from './types';
import { normalizeDrugName, stripSalts } from './match';

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
  const graph = await probeGraph();
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
resolver.define('startSync', async () => {
  await runMigrations();
  return enqueueSync('manual');
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

export const uiResolver = resolver.getDefinitions();
