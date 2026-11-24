import api, { route } from '@forge/api';
import { query, execute } from './storage/schema';
import { getSettings } from './settings';
import { probeGraph } from './graph';
import { baseIngredientName, normalizeDrugName, stripSalts } from './match';

export interface ImpactResult {
  pages: number;
  jiraItems: number;
  reducedMode: boolean;
  missing: string[];
}

interface ShortageRow {
  shortage_key: string;
  generic_name: string;
  openfda_json: string;
}

interface DiscoveredItem {
  kind: 'page' | 'jira';
  refId: string;
  title: string;
  url: string;
  ownerAccountId?: string;
  ownerName?: string;
  spaceKey?: string;
  foundVia: string;
}

interface PendingImpactRow {
  shortageKey: string;
  kind: 'page' | 'jira';
  refId: string;
  title: string;
  url: string;
  ownerAccountId: string | null;
  ownerName: string | null;
  foundVia: string;
  spaceKey: string | null;
}

const MAX_TERMS_PER_QUERY = 6;
const MAX_TERM_LENGTH = 60;
const SQL_IN_CHUNK = 100;
const INSERT_CHUNK = 40;

/** Normalize Confluence webui links so relative paths always include the /wiki prefix. */
export function normalizeConfluenceUrl(webui?: string | null): string {
  if (!webui) return '';
  if (webui.startsWith('/') && !webui.startsWith('/wiki/')) {
    return `/wiki${webui}`;
  }
  return webui;
}

/**
 * Compute concise, deduplicated search terms for a shortage:
 * baseIngredientName(generic_name) + openfda.brand_name + stripped openfda.substance_name.
 * Keeps concise terms of length >= 3, capped at 6 terms per query.
 */
export function searchTermsFor(shortage: ShortageRow): string[] {
  const byNorm = new Map<string, string>();
  const addTerm = (raw: string | undefined) => {
    if (!raw) return;
    const cleaned = raw.replace(/"/g, '').replace(/\s+/g, ' ').trim();
    const norm = normalizeDrugName(cleaned);
    if (norm.length < 3 || cleaned.length > MAX_TERM_LENGTH) return;
    if (!byNorm.has(norm)) {
      byNorm.set(norm, cleaned);
    }
  };

  if (shortage.generic_name) {
    addTerm(baseIngredientName(shortage.generic_name));
  }

  try {
    const openfda = JSON.parse(shortage.openfda_json ?? '{}') as {
      brand_name?: string[];
      substance_name?: string[];
    };
    for (const brand of openfda.brand_name ?? []) {
      addTerm(brand);
    }
    for (const sub of openfda.substance_name ?? []) {
      addTerm(stripSalts(normalizeDrugName(sub)));
    }
  } catch {
    /* keep generic_name base ingredient only */
  }

  if (byNorm.size === 0 && shortage.generic_name) {
    addTerm(stripSalts(normalizeDrugName(shortage.generic_name)));
  }

  return [...byNorm.values()].slice(0, MAX_TERMS_PER_QUERY);
}

async function searchConfluence(
  terms: string[],
  spaceKeys: string[],
): Promise<{ items: DiscoveredItem[]; error?: string }> {
  if (!terms.length) return { items: [] };
  const safeSpaces = spaceKeys.map((s) => s.replace(/"/g, '').trim()).filter(Boolean);
  const spaceFilter = safeSpaces.length
    ? ` AND space IN (${safeSpaces.map((s) => `"${s}"`).join(',')})`
    : '';
  const textQuery = terms.map((t) => `text ~ "${t.replace(/"/g, '')}"`).join(' OR ');
  const cql = `type = page AND (${textQuery})${spaceFilter}`;
  try {
    const res = await api.asApp().requestConfluence(
      route`/wiki/rest/api/content/search?cql=${cql}&limit=50&expand=version.by,space`,
      { headers: { Accept: 'application/json' } },
    );
    if (!res.ok) return { items: [], error: `CQL ${res.status}` };
    const body = (await res.json()) as {
      results?: {
        id: string;
        title: string;
        _links?: { webui?: string };
        version?: { by?: { displayName?: string; accountId?: string } };
        space?: { key?: string };
      }[];
    };
    return {
      items: (body.results ?? []).map((p) => ({
        kind: 'page',
        refId: p.id,
        title: p.title,
        url: normalizeConfluenceUrl(p._links?.webui),
        ownerAccountId: p.version?.by?.accountId,
        ownerName: p.version?.by?.displayName,
        spaceKey: p.space?.key,
        foundVia: 'confluence-search',
      })),
    };
  } catch (e) {
    return { items: [], error: `CQL error: ${String(e).slice(0, 120)}` };
  }
}

function isShortfallGeneratedSummary(summary?: string | null): boolean {
  const s = (summary ?? '').trim();
  return (
    s.startsWith('[Shortage]') ||
    s.startsWith('[Owner Review]') ||
    s.startsWith('[Reversal]')
  );
}

async function searchJira(
  terms: string[],
  excludeProjectKey?: string,
  excludeKeys: Set<string> = new Set(),
): Promise<{ items: DiscoveredItem[]; error?: string }> {
  if (!terms.length) return { items: [] };
  const textQuery = terms.map((t) => `text ~ "${t.replace(/"/g, '')}"`).join(' OR ');
  const safeProject = excludeProjectKey?.replace(/"/g, '').trim();
  const projectFilter = safeProject ? ` AND project != "${safeProject}"` : '';
  const jql = `(${textQuery}) AND statusCategory != Done${projectFilter} ORDER BY updated DESC`;
  try {
    const res = await api.asApp().requestJira(
      route`/rest/api/3/search/jql?jql=${jql}&maxResults=50&fields=summary,assignee,status,created,project`,
      { headers: { Accept: 'application/json' } },
    );
    if (!res.ok) return { items: [], error: `JQL ${res.status}` };
    const body = (await res.json()) as {
      issues?: {
        id: string;
        key: string;
        fields: {
          summary?: string;
          assignee?: { accountId?: string; displayName?: string };
          status?: { name?: string };
          project?: { key?: string };
        };
      }[];
    };
    return {
      items: (body.issues ?? [])
        .filter((i) => !excludeKeys.has(i.key) && !isShortfallGeneratedSummary(i.fields.summary))
        .map((i) => ({
          kind: 'jira',
          refId: i.key,
          title: i.fields.summary ?? i.key,
          url: `/browse/${i.key}`,
          ownerAccountId: i.fields.assignee?.accountId,
          ownerName: i.fields.assignee?.displayName,
          spaceKey: i.fields.project?.key ?? i.key.split('-')[0],
          foundVia: 'jira-search',
        })),
    };
  } catch (e) {
    return { items: [], error: `JQL error: ${String(e).slice(0, 120)}` };
  }
}

async function fetchMatchedShortages(keys: string[]): Promise<ShortageRow[]> {
  const rows: ShortageRow[] = [];
  for (let i = 0; i < keys.length; i += SQL_IN_CHUNK) {
    const chunk = keys.slice(i, i + SQL_IN_CHUNK);
    const placeholders = chunk.map(() => '?').join(',');
    const batch = await query<ShortageRow>(
      `SELECT shortage_key, generic_name, openfda_json FROM shortage WHERE shortage_key IN (${placeholders})`,
      chunk,
    );
    rows.push(...batch);
  }
  return rows;
}

async function insertImpactBatch(rows: PendingImpactRow[]): Promise<void> {
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    const chunk = rows.slice(i, i + INSERT_CHUNK);
    const placeholders = chunk
      .map(() => '(?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, 1, NOW())')
      .join(', ');
    const params: unknown[] = [];
    for (const r of chunk) {
      params.push(
        r.shortageKey,
        r.kind,
        r.refId,
        r.title.slice(0, 1024),
        r.url.slice(0, 1024),
        r.ownerAccountId,
        r.ownerName,
        r.foundVia,
        r.spaceKey,
      );
    }
    await execute(
      `INSERT INTO impact_item (shortage_key, kind, ref_id, title, url, owner_account_id, owner_name, team_name, found_via, space_key, hop, created_at)
       VALUES ${placeholders}`,
      params,
    );
  }
}

/**
 * Map the impact of each matched shortage: Confluence pages and open Jira
 * work naming the drug. Searches are deduplicated by unique normalized
 * ingredient / search-term group so hundreds of matched NDC presentations
 * collapse to a handful of CQL/JQL calls.
 */
export async function runImpactMapping(
  shortageKeys: Set<string>,
  progress: { impactDone: number; impactTotal: number },
): Promise<ImpactResult> {
  const settings = await getSettings();
  const graph = await probeGraph();
  const missing: string[] = [...graph.missingScopes];
  if (!graph.available && graph.note) missing.push(graph.note);

  progress.impactTotal = shortageKeys.size;
  let pages = 0;
  let jiraItems = 0;

  if (shortageKeys.size === 0) {
    return {
      pages: 0,
      jiraItems: 0,
      reducedMode: missing.length > 0,
      missing: [...new Set(missing)].slice(0, 20),
    };
  }

  // Remove any self-referential Shortfall Jira tickets or out-of-scope spaces
  // that may have been indexed before scope exclusions were configured.
  await execute(
    `DELETE FROM impact_item
     WHERE kind = 'jira'
       AND (
         title LIKE '[Shortage]%'
         OR title LIKE '[Owner Review]%'
         OR title LIKE '[Reversal]%'
         OR ref_id IN (SELECT jira_issue_key FROM response WHERE jira_issue_key IS NOT NULL)
       )`,
  );
  if (settings.responseProjectKey) {
    await execute(
      `DELETE FROM impact_item WHERE kind = 'jira' AND ref_id LIKE ?`,
      [`${settings.responseProjectKey}-%`],
    );
  }
  if (settings.clinicalSpaceKeys.length > 0) {
    const ph = settings.clinicalSpaceKeys.map(() => '?').join(',');
    await execute(
      `DELETE FROM impact_item
       WHERE kind = 'page'
         AND space_key IS NOT NULL
         AND space_key != ''
         AND space_key NOT IN (${ph})`,
      settings.clinicalSpaceKeys,
    );
  }

  const responseKeys = new Set(
    (
      await query<{ jira_issue_key: string }>(
        `SELECT jira_issue_key FROM response WHERE jira_issue_key IS NOT NULL`,
      )
    ).map((r) => r.jira_issue_key),
  );

  // One active impact_item per (shortage_key, kind, ref_id).
  const active = await query<{ shortage_key: string; kind: string; ref_id: string }>(
    `SELECT shortage_key, kind, ref_id FROM impact_item`,
  );
  const seen = new Set(active.map((r) => `${r.shortage_key}|${r.kind}|${r.ref_id}`));

  const shortages = await fetchMatchedShortages([...shortageKeys]);

  // Deduplicate searches by normalized search-term signature.
  const groups = new Map<string, { terms: string[]; shortageKeys: string[] }>();
  for (const shortage of shortages) {
    const terms = searchTermsFor(shortage);
    if (!terms.length) {
      progress.impactDone++;
      continue;
    }
    const sig = terms.map((t) => normalizeDrugName(t)).sort().join('|');
    const existing = groups.get(sig);
    if (existing) {
      existing.shortageKeys.push(shortage.shortage_key);
    } else {
      groups.set(sig, { terms, shortageKeys: [shortage.shortage_key] });
    }
  }

  const pendingInserts: PendingImpactRow[] = [];

  for (const group of groups.values()) {
    const [conf, jira] = await Promise.all([
      searchConfluence(group.terms, settings.clinicalSpaceKeys),
      searchJira(group.terms, settings.responseProjectKey, responseKeys),
    ]);
    if (conf.error) missing.push(`confluence: ${conf.error}`);
    if (jira.error) missing.push(`jira: ${jira.error}`);

    const discovered = [...conf.items, ...jira.items];
    for (const key of group.shortageKeys) {
      for (const item of discovered) {
        const dedupeKey = `${key}|${item.kind}|${item.refId}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        pendingInserts.push({
          shortageKey: key,
          kind: item.kind,
          refId: item.refId,
          title: item.title,
          url: item.url,
          ownerAccountId: item.ownerAccountId ?? null,
          ownerName: item.ownerName ?? null,
          foundVia: item.foundVia,
          spaceKey: item.spaceKey ?? null,
        });
        if (item.kind === 'page') pages++;
        else jiraItems++;
      }
    }
    progress.impactDone += group.shortageKeys.length;
  }

  if (pendingInserts.length) {
    await insertImpactBatch(pendingInserts);
  }

  return {
    pages,
    jiraItems,
    reducedMode: missing.length > 0,
    missing: [...new Set(missing)].slice(0, 20),
  };
}
