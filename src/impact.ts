import api, { route } from '@forge/api';
import { sql } from './storage/schema';
import { getSettings } from './settings';
import { probeGraph, ownersForContent } from './graph';
import { normalizeDrugName } from './match';

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

/** Search terms for a shortage: generic name + openfda names. */
export function searchTermsFor(shortage: ShortageRow): string[] {
  const terms = new Set<string>();
  if (shortage.generic_name) terms.add(shortage.generic_name);
  try {
    const openfda = JSON.parse(shortage.openfda_json ?? '{}') as {
      generic_name?: string[]; brand_name?: string[]; substance_name?: string[];
    };
    for (const n of openfda.generic_name ?? []) terms.add(n);
    for (const n of openfda.brand_name ?? []) terms.add(n);
    for (const n of openfda.substance_name ?? []) terms.add(n);
  } catch { /* keep generic name only */ }
  return [...terms].filter((t) => normalizeDrugName(t).length > 2);
}

async function searchConfluence(terms: string[], spaceKeys: string[]) {
  const spaceFilter = spaceKeys.length ? ` AND space IN (${spaceKeys.map((s) => `"${s}"`).join(',')})` : '';
  const textQuery = terms.map((t) => `"${t.replace(/"/g, '')}"`).join(' OR ');
  const cql = `type = page AND text ~ (${textQuery})${spaceFilter}`;
  const res = await api.asApp().requestConfluence(
    route`/wiki/rest/api/content/search?cql=${cql}&limit=50&expand=version.by,space`,
    { headers: { Accept: 'application/json' } },
  );
  if (!res.ok) return { items: [] as unknown[], error: `CQL ${res.status}` };
  const body = (await res.json()) as { results?: { id: string; title: string; _links?: { webui?: string }; version?: { by?: { displayName?: string; accountId?: string } }; space?: { key?: string } }[] };
  return {
    items: (body.results ?? []).map((p) => ({
      kind: 'page' as const,
      refId: p.id,
      title: p.title,
      url: p._links?.webui ?? '',
      ownerAccountId: p.version?.by?.accountId,
      ownerName: p.version?.by?.displayName,
      spaceKey: p.space?.key,
      foundVia: 'confluence-search',
    })),
  };
}

async function searchJira(terms: string[]) {
  const textQuery = terms.map((t) => `"${t.replace(/"/g, '')}"`).join(' OR ');
  const jql = `text ~ (${textQuery}) AND statusCategory != Done ORDER BY updated DESC`;
  const res = await api.asApp().requestJira(
    route`/rest/api/3/search/jql?jql=${jql}&maxResults=50&fields=summary,assignee,status,created`,
    { headers: { Accept: 'application/json' } },
  );
  if (!res.ok) return { items: [] as unknown[], error: `JQL ${res.status}` };
  const body = (await res.json()) as {
    issues?: { id: string; key: string; fields: { summary?: string; assignee?: { accountId?: string; displayName?: string }; status?: { name?: string } } }[];
  };
  return {
    items: (body.issues ?? []).map((i) => ({
      kind: 'jira' as const,
      refId: i.key,
      title: i.fields.summary ?? i.key,
      url: `/browse/${i.key}`,
      ownerAccountId: i.fields.assignee?.accountId,
      ownerName: i.fields.assignee?.displayName,
      foundVia: 'jira-search',
    })),
  };
}

/**
 * Map the impact of each matched shortage: Confluence pages and open Jira
 * work naming the drug, with owners where readable. Degrades gracefully —
 * failures are recorded in `missing` rather than thrown.
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

  for (const key of shortageKeys) {
    const rows = await sql.executeRaw<ShortageRow>(
      `SELECT shortage_key, generic_name, openfda_json FROM shortage WHERE shortage_key = '${key}'`,
    );
    const shortage = rows.rows?.[0];
    if (!shortage) continue;
    const terms = searchTermsFor(shortage);

    const [conf, jira] = await Promise.all([searchConfluence(terms, settings.clinicalSpaceKeys), searchJira(terms)]);
    if (conf.error) missing.push(`confluence: ${conf.error}`);
    if (jira.error) missing.push(`jira: ${jira.error}`);

    for (const item of [...conf.items, ...jira.items] as {
      kind: string; refId: string; title: string; url: string;
      ownerAccountId?: string; ownerName?: string; foundVia: string;
    }[]) {
      let teamName: string | undefined;
      if (graph.available && item.kind === 'page') {
        const owner = await ownersForContent(`ari:cloud:confluence::page/${item.refId}`);
        teamName = owner?.teamName;
      }
      const esc = (s: string | undefined) => (s ?? '').replace(/'/g, "''");
      await sql.executeRaw(
        `INSERT INTO impact_item (shortage_key, kind, ref_id, title, url, owner_account_id, owner_name, team_name, found_via, created_at)
         VALUES ('${key}', '${item.kind}', '${esc(item.refId)}', '${esc(item.title)}', '${esc(item.url)}', '${esc(item.ownerAccountId)}', '${esc(item.ownerName)}', '${esc(teamName)}', '${item.foundVia}', NOW())`,
      );
      if (item.kind === 'page') pages++; else jiraItems++;
    }
    progress.impactDone++;
  }

  return { pages, jiraItems, reducedMode: missing.length > 0, missing };
}
