import Resolver from '@forge/resolver';
import api, { route } from '@forge/api';
import { kvs } from '@forge/kvs';
import { runMigrations, query, execute } from './storage/schema';
import { getSettings, saveSettings, AppSettings } from './settings';
import { enqueueSync } from './sync';
import { probeGraph, pageOwners, pageCreator, userTeams, linkedPages } from './graph';
import { FormularyItem, OPENFDA_DISCLAIMER } from './types';
import {
  normalizeDrugName,
  stripSalts,
  normalizeNdc,
  fdaSourceUrl,
  baseIngredientName,
} from './match';
import {
  createResponseForShortage,
  recordTemporaryChange,
  markTemporaryChangeReversed,
  openReversalTasksForResolvedResponses,
} from './respond';
import { RxNavClient } from './rxnav';
import { loadSampleHospital, removeSampleHospital, getSampleState } from './sample';

const resolver = new Resolver();

interface ReqContext {
  accountId?: string;
  cloudId?: string;
  installContext?: string;
  siteUrl?: string;
  issueKey?: string;
  extension?: {
    content?: { id?: string };
    issue?: { key?: string };
  };
}

/** Capture the calling user's identity, cloudId, and siteUrl in KVS. */
async function captureContext(ctx?: ReqContext): Promise<{ cloudId?: string; siteUrl?: string }> {
  const accountId = ctx?.accountId;
  if (accountId) await kvs.set('graphUserId', accountId);
  const cloudId =
    ctx?.cloudId ?? String(ctx?.installContext ?? '').match(/[0-9a-f-]{36}/i)?.[0];
  if (cloudId) await kvs.set('cloudId', cloudId);
  const siteUrl = ctx?.siteUrl ? String(ctx.siteUrl).replace(/\/+$/, '') : undefined;
  if (siteUrl) await kvs.set('siteUrl', siteUrl);
  return { cloudId, siteUrl };
}

/** Extract siteUrl from resolver context (falling back to stored KVS value). */
async function getSiteUrl(ctx?: ReqContext): Promise<string> {
  const { siteUrl } = await captureContext(ctx);
  if (siteUrl) return siteUrl;
  const stored = (await kvs.get('siteUrl')) as string | undefined;
  return stored ? stored.replace(/\/+$/, '') : '';
}

/** Verify the calling user has Jira ADMINISTER permission before changing settings. */
async function assertAdmin(): Promise<void> {
  let havePermission: boolean | undefined;
  try {
    const res = await api
      .asUser()
      .requestJira(route`/rest/api/3/mypermissions?permissions=ADMINISTER`, {
        headers: { Accept: 'application/json' },
      });
    if (res.ok) {
      const body = (await res.json()) as {
        permissions?: { ADMINISTER?: { havePermission?: boolean } };
      };
      havePermission = body?.permissions?.ADMINISTER?.havePermission;
    }
  } catch {
    // Non-Jira context or dev environment without Jira permissions endpoint; allow gracefully.
    return;
  }
  if (havePermission === false) {
    throw new Error('Admin permission is required to modify Shortfall settings.');
  }
}

function parseDateMs(raw: string | Date | null | undefined): number | null {
  if (!raw) return null;
  if (raw instanceof Date) {
    const t = raw.getTime();
    return Number.isFinite(t) ? t : null;
  }
  const s = String(raw).trim();
  if (!s) return null;
  const mdy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (mdy) {
    const t = Date.UTC(Number(mdy[3]), Number(mdy[1]) - 1, Number(mdy[2]));
    return Number.isFinite(t) ? t : null;
  }
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(s)
    ? `${s.replace(' ', 'T')}Z`
    : s;
  const t = Date.parse(normalized);
  return Number.isFinite(t) ? t : null;
}

function safeJsonParse<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** Dashboard: last sync result, headline counts, exposure by space, and response telemetry. */
resolver.define('getDashboardData', async ({ context }: { context?: ReqContext }) => {
  const siteUrl = await getSiteUrl(context);
  await runMigrations();

  const [
    lastSync,
    settings,
    graph,
    activeRows,
    discontinuedRows,
    resolvedRows,
    formularyRows,
    impactRows,
    directImpactRows,
    linkedImpactRows,
    openResponseRows,
    openTempRows,
    reversalsDueRows,
    exposureRows,
    timingRows,
  ] = await Promise.all([
    kvs.get('lastSync'),
    getSettings(),
    probeGraph(),
    query<{ n: number }>(
      `SELECT COUNT(DISTINCT s.shortage_key) AS n
       FROM shortage s
       JOIN \`match\` m ON m.shortage_key = s.shortage_key AND m.superseded = 0
       WHERE s.status = 'Current'`,
    ),
    query<{ n: number }>(
      `SELECT COUNT(DISTINCT s.shortage_key) AS n
       FROM shortage s
       JOIN \`match\` m ON m.shortage_key = s.shortage_key AND m.superseded = 0
       WHERE s.status = 'To Be Discontinued'`,
    ),
    query<{ n: number }>(
      `SELECT COUNT(DISTINCT s.shortage_key) AS n
       FROM shortage s
       JOIN \`match\` m ON m.shortage_key = s.shortage_key AND m.superseded = 0
       WHERE s.status = 'Resolved'`,
    ),
    query<{ n: number }>(`SELECT COUNT(*) AS n FROM formulary_item WHERE active = 1`),
    query<{ n: number }>(`SELECT COUNT(*) AS n FROM impact_item`),
    query<{ n: number }>(`SELECT COUNT(*) AS n FROM impact_item WHERE COALESCE(hop, 1) = 1`),
    query<{ n: number }>(`SELECT COUNT(*) AS n FROM impact_item WHERE hop = 2`),
    query<{ n: number }>(`SELECT COUNT(*) AS n FROM response WHERE COALESCE(state, 'open') != 'resolved'`),
    query<{ n: number }>(`SELECT COUNT(*) AS n FROM temporary_change WHERE state IN ('open', 'reversal_open')`),
    query<{ n: number }>(
      `SELECT COUNT(*) AS n
       FROM temporary_change tc
       JOIN response r ON r.id = tc.response_id
       JOIN shortage s ON s.shortage_key = r.shortage_key
       WHERE s.status = 'Resolved' AND tc.state = 'open'`,
    ),
    query<{ spaceKey: string; count: number }>(
      `SELECT COALESCE(NULLIF(space_key, ''), 'Jira / Other') AS spaceKey,
              COUNT(DISTINCT ref_id) AS count
       FROM impact_item
       GROUP BY COALESCE(NULLIF(space_key, ''), 'Jira / Other')
       ORDER BY count DESC`,
    ),
    query<{ opened_at: string | Date | null; initial_posting_date: string | null }>(
      `SELECT r.opened_at, s.initial_posting_date
       FROM response r
       JOIN shortage s ON s.shortage_key = r.shortage_key
       WHERE r.opened_at IS NOT NULL AND s.initial_posting_date IS NOT NULL`,
    ),
  ]);

  const hours: number[] = [];
  for (const row of timingRows) {
    const opened = parseDateMs(row.opened_at);
    const posted = parseDateMs(row.initial_posting_date);
    if (opened !== null && posted !== null) {
      const diff = (opened - posted) / 3_600_000;
      if (Number.isFinite(diff) && diff >= 0) hours.push(diff);
    }
  }
  hours.sort((a, b) => a - b);
  let medianResponseHours: number | null = null;
  if (hours.length > 0) {
    const mid = Math.floor(hours.length / 2);
    const med = hours.length % 2 === 1 ? hours[mid] : (hours[mid - 1] + hours[mid]) / 2;
    medianResponseHours = Math.round(med * 10) / 10;
  }

  return {
    lastSync: lastSync ?? null,
    activeMatched: Number(activeRows[0]?.n ?? 0),
    discontinuedMatched: Number(discontinuedRows[0]?.n ?? 0),
    resolvedMatched: Number(resolvedRows[0]?.n ?? 0),
    formularyCount: Number(formularyRows[0]?.n ?? 0),
    impactItems: Number(impactRows[0]?.n ?? 0),
    directImpactItems: Number(directImpactRows[0]?.n ?? 0),
    linkedImpactItems: Number(linkedImpactRows[0]?.n ?? 0),
    openResponses: Number(openResponseRows[0]?.n ?? 0),
    openTemporaryChanges: Number(openTempRows[0]?.n ?? 0),
    reversalsDue: Number(reversalsDueRows[0]?.n ?? 0),
    exposureBySpace: exposureRows.map((r) => ({
      spaceKey: r.spaceKey,
      count: Number(r.count ?? 0),
    })),
    medianResponseHours,
    settings,
    setupComplete: settings.setupComplete,
    autoCreateResponses: settings.autoCreateResponses,
    reducedMode: [
      ...graph.missingScopes,
      ...(graph.note && !graph.available ? [graph.note] : []),
    ],
    siteUrl,
  };
});

/** Live Confluence spaces and Jira projects for the setup wizard. */
resolver.define('getSetupOptions', async ({ context }: { context?: ReqContext }) => {
  await captureContext(context);
  await runMigrations();

  const [settings, formularyRows, spaces, projects] = await Promise.all([
    getSettings(),
    query<{ n: number }>(`SELECT COUNT(*) AS n FROM formulary_item WHERE active = 1`),
    (async (): Promise<{ key: string; name: string; id: string }[]> => {
      try {
        const res = await api
          .asApp()
          .requestConfluence(route`/wiki/api/v2/spaces?limit=50`, {
            headers: { Accept: 'application/json' },
          });
        if (!res.ok) return [];
        const body = (await res.json()) as {
          results?: { id?: string; key?: string; name?: string }[];
        };
        return (body.results ?? [])
          .filter((s) => Boolean(s.key))
          .map((s) => ({
            id: String(s.id ?? ''),
            key: String(s.key ?? ''),
            name: String(s.name ?? s.key ?? ''),
          }));
      } catch {
        return [];
      }
    })(),
    (async (): Promise<{ key: string; name: string }[]> => {
      try {
        const res = await api
          .asApp()
          .requestJira(route`/rest/api/3/project/search?maxResults=50`, {
            headers: { Accept: 'application/json' },
          });
        if (!res.ok) return [];
        const body = (await res.json()) as {
          values?: { key?: string; name?: string }[];
        };
        return (body.values ?? [])
          .filter((p) => Boolean(p.key))
          .map((p) => ({
            key: String(p.key ?? ''),
            name: String(p.name ?? p.key ?? ''),
          }));
      } catch {
        return [];
      }
    })(),
  ]);

  return {
    spaces,
    projects,
    settings,
    formularyCount: Number(formularyRows[0]?.n ?? 0),
  };
});

/** Setup wizard state. */
resolver.define('getSetupState', async () => {
  await runMigrations();
  const settings = await getSettings();
  const formulary = await query<{ n: number }>(
    `SELECT COUNT(*) AS n FROM formulary_item WHERE active = 1`,
  );
  return { settings, formularyCount: Number(formulary[0]?.n ?? 0) };
});

resolver.define('saveSettings', async ({ payload }: { payload: Partial<AppSettings> }) => {
  await assertAdmin();
  return { settings: await saveSettings(payload) };
});

/** Import formulary rows (paste/CSV parsed client-side into FormularyItem[]). */
resolver.define('importFormulary', async ({ payload }: { payload: { items: FormularyItem[] } }) => {
  await assertAdmin();
  await runMigrations();

  const rxnav = new RxNavClient({
    cacheGet: (k) => kvs.get(k),
    cacheSet: (k, v) => kvs.set(k, v),
  });

  let count = 0;
  for (const item of payload.items ?? []) {
    const ingredientNames = (item.ingredientNames ?? [])
      .map((n) => stripSalts(normalizeDrugName(n)))
      .filter(Boolean);
    const packageNdcs = (item.packageNdcs ?? [])
      .map((n) => normalizeNdc(n))
      .filter((n): n is string => Boolean(n));
    const dosageForms = (item.dosageForms ?? [])
      .map((d) => normalizeDrugName(d))
      .filter(Boolean);

    const rxcuiSet = new Set<string>(
      (item.ingredientRxcuis ?? []).map((c) => String(c).trim()).filter(Boolean),
    );
    if (rxcuiSet.size === 0 && ingredientNames.length > 0) {
      for (const ing of ingredientNames.slice(0, 3)) {
        try {
          const rxcui = await rxnav.nameToRxcui(ing);
          if (rxcui) {
            const ingredients = await rxnav.ingredientsForRxcui(rxcui);
            if (ingredients.length > 0) {
              for (const ref of ingredients) rxcuiSet.add(ref.rxcui);
            } else {
              rxcuiSet.add(rxcui);
            }
          }
        } catch {
          // Best-effort RxNav enrichment; never fail formulary import.
        }
      }
    }

    await execute(
      `INSERT INTO formulary_item (id, display_name, ingredient_names, ingredient_rxcuis, package_ndcs, dosage_forms, active)
       VALUES (?, ?, ?, ?, ?, ?, 1)
       ON DUPLICATE KEY UPDATE
         display_name = VALUES(display_name),
         ingredient_names = VALUES(ingredient_names),
         ingredient_rxcuis = VALUES(ingredient_rxcuis),
         package_ndcs = VALUES(package_ndcs),
         dosage_forms = VALUES(dosage_forms),
         active = 1`,
      [
        item.id,
        item.displayName,
        JSON.stringify(ingredientNames),
        JSON.stringify([...rxcuiSet]),
        JSON.stringify(packageNdcs),
        JSON.stringify(dosageForms),
      ],
    );
    count++;
  }
  return { imported: count };
});

/** "Sync now" button. */
resolver.define('startSync', async ({ context }: { context?: ReqContext }) => {
  await captureContext(context);
  await runMigrations();
  return enqueueSync('manual');
});

/** Matched shortages for the dashboard (joined to formulary, response, and impact counts). */
resolver.define('getMatchedShortages', async () => {
  await runMigrations();
  const rows = await query<{
    shortage_key: string;
    generic_name: string;
    status: string;
    package_ndc: string;
    presentation: string;
    dosage_form: string;
    company_name: string;
    update_date: string;
    initial_posting_date: string;
    reason: string;
    display_name: string;
    impact_count: number | null;
    jira_issue_key: string | null;
    response_state: string | null;
  }>(
    `SELECT s.shortage_key, s.generic_name, s.status, s.package_ndc, s.presentation,
            s.dosage_form, s.company_name, s.update_date, s.initial_posting_date,
            m.reason, f.display_name,
            COALESCE(ic.impact_count, 0) AS impact_count,
            r.jira_issue_key,
            r.state AS response_state
     FROM \`match\` m
     JOIN shortage s ON s.shortage_key = m.shortage_key
     JOIN formulary_item f ON f.id = m.formulary_item_id
     LEFT JOIN (
       SELECT shortage_key, COUNT(*) AS impact_count
       FROM impact_item
       GROUP BY shortage_key
     ) ic ON ic.shortage_key = s.shortage_key
     LEFT JOIN (
       SELECT shortage_key, MAX(jira_issue_key) AS jira_issue_key, MAX(state) AS state
       FROM response
       GROUP BY shortage_key
     ) r ON r.shortage_key = s.shortage_key
     WHERE m.superseded = 0
     ORDER BY CASE s.status WHEN 'Current' THEN 0 WHEN 'To Be Discontinued' THEN 1 ELSE 2 END,
              s.update_date DESC
     LIMIT 200`,
  );
  return rows.map((r) => ({
    shortageId: r.shortage_key,
    genericName: r.generic_name,
    ingredientGroup: baseIngredientName(r.generic_name ?? ''),
    presentation: r.presentation,
    packageNdc: r.package_ndc,
    dosageForm: r.dosage_form,
    company: r.company_name,
    status: r.status,
    updateDate: r.update_date,
    initialPostingDate: r.initial_posting_date,
    matchedTo: r.display_name,
    reason: r.reason,
    source: fdaSourceUrl(r.package_ndc),
    impactCount: Number(r.impact_count ?? 0),
    responseWorkItem: r.jira_issue_key ?? null,
    responseState: r.response_state ?? null,
  }));
});

/** Full shortage detail drawer: FDA facts, status history, matches, impact, response, temp changes, precedents. */
resolver.define(
  'getShortageDetail',
  async ({ payload }: { payload: { shortageKey?: string; shortageId?: string } }) => {
    await runMigrations();
    const key = payload?.shortageKey ?? payload?.shortageId;
    if (!key) return { found: false, disclaimer: OPENFDA_DISCLAIMER };

    const [shortageRows, matches, impact, responseRows] = await Promise.all([
      query<{
        shortage_key: string;
        generic_name: string;
        status: string;
        presentation: string;
        package_ndc: string;
        dosage_form: string;
        therapeutic_category: string;
        company_name: string;
        availability: string;
        update_type: string;
        update_date: string;
        initial_posting_date: string;
        contact_info: string | null;
        related_info: string;
        discontinued_date: string;
        status_history: string | null;
      }>(
        `SELECT shortage_key, generic_name, status, presentation, package_ndc, dosage_form,
                therapeutic_category, company_name, availability, update_type, update_date,
                initial_posting_date, contact_info, related_info, discontinued_date, status_history
         FROM shortage
         WHERE shortage_key = ?
         LIMIT 1`,
        [key],
      ),
      query<{
        id: number;
        formulary_item_id: string;
        reason: string;
        detail: string;
        created_at: string;
        display_name: string | null;
      }>(
        `SELECT m.id, m.formulary_item_id, m.reason, m.detail, m.created_at, f.display_name
         FROM \`match\` m
         LEFT JOIN formulary_item f ON f.id = m.formulary_item_id
         WHERE m.shortage_key = ? AND m.superseded = 0
         ORDER BY m.id ASC`,
        [key],
      ),
      query<{
        id: number;
        kind: string;
        ref_id: string;
        title: string;
        url: string;
        owner_account_id: string | null;
        owner_name: string | null;
        team_name: string | null;
        found_via: string;
        hop: number;
        space_key: string | null;
        detail: string | null;
      }>(
        `SELECT id, kind, ref_id, title, url, owner_account_id, owner_name, team_name,
                found_via, COALESCE(hop, 1) AS hop, space_key, detail
         FROM impact_item
         WHERE shortage_key = ?
         ORDER BY COALESCE(hop, 1), kind, title`,
        [key],
      ),
      query<{
        id: number;
        shortage_key: string;
        ingredient: string;
        jira_issue_key: string;
        jira_issue_id: string;
        state: string;
        opened_at: string;
        resolved_at: string | null;
        reversal_needed: number;
        decision_summary: string | null;
      }>(
        `SELECT id, shortage_key, ingredient, jira_issue_key, jira_issue_id, state,
                opened_at, resolved_at, reversal_needed, decision_summary
         FROM response
         WHERE shortage_key = ?
         ORDER BY id DESC
         LIMIT 1`,
        [key],
      ),
    ]);

    const shortage = shortageRows[0] ?? null;
    const response = responseRows[0] ?? null;
    const statusHistory = safeJsonParse<{ status: string; from?: string; to?: string }[]>(
      shortage?.status_history,
      [],
    );

    const temporaryChanges = response
      ? await query<{
          id: number;
          response_id: number;
          description: string;
          impact_item_id: number | null;
          reversal_issue_key: string | null;
          state: string;
          created_at: string;
          reversed_at: string | null;
        }>(
          `SELECT id, response_id, description, impact_item_id, reversal_issue_key, state, created_at, reversed_at
           FROM temporary_change
           WHERE response_id = ?
           ORDER BY id ASC`,
          [response.id],
        )
      : [];

    const baseIng = baseIngredientName(shortage?.generic_name ?? response?.ingredient ?? '');
    const pastResponses = baseIng
      ? await query<{
          id: number;
          shortage_key: string;
          ingredient: string;
          jira_issue_key: string;
          state: string;
          opened_at: string;
          resolved_at: string | null;
          decision_summary: string | null;
        }>(
          `SELECT id, shortage_key, ingredient, jira_issue_key, state, opened_at, resolved_at, decision_summary
           FROM response
           WHERE LOWER(ingredient) LIKE ? AND shortage_key != ?
           ORDER BY opened_at DESC
           LIMIT 20`,
          [`%${baseIng.toLowerCase()}%`, key],
        )
      : [];

    return {
      shortage,
      statusHistory,
      matches,
      impact,
      response,
      temporaryChanges,
      pastResponses,
      source: fdaSourceUrl(shortage?.package_ndc),
      disclaimer: OPENFDA_DISCLAIMER,
    };
  },
);

/** Create a Jira response work item (and per-owner tasks) for a shortage at user request. */
resolver.define(
  'createResponse',
  async ({ payload }: { payload: { shortageKey?: string; shortageId?: string } }) => {
    await runMigrations();
    const key = payload?.shortageKey ?? payload?.shortageId;
    if (!key) throw new Error('shortageKey is required');
    return createResponseForShortage(key, { createOwnerTasks: true, asUser: true });
  },
);

/** Record a temporary protocol/order-set change against an active response. */
resolver.define(
  'addTemporaryChange',
  async ({
    payload,
  }: {
    payload: { responseId: number; description: string; impactItemId?: number | null };
  }) => {
    await runMigrations();
    if (!payload?.responseId || !payload?.description) {
      throw new Error('responseId and description are required');
    }
    return recordTemporaryChange(
      Number(payload.responseId),
      String(payload.description),
      payload.impactItemId != null ? Number(payload.impactItemId) : null,
    );
  },
);

/** Mark a temporary change as reversed. */
resolver.define(
  'markChangeReversed',
  async ({ payload }: { payload: { changeId: number } }) => {
    await runMigrations();
    if (!payload?.changeId) throw new Error('changeId is required');
    await markTemporaryChangeReversed(Number(payload.changeId));
    return { ok: true };
  },
);

/** Open reversal tasks for any resolved responses with unreversed temporary changes. */
resolver.define('runReversalCheck', async () => {
  await runMigrations();
  return openReversalTasksForResolvedResponses();
});

/** Recent sync_run rows for the dashboard log view. */
resolver.define('getSyncLog', async () => {
  await runMigrations();
  return query<{
    id: number;
    kind: string;
    state: string;
    started_at: string;
    finished_at: string;
    result: string;
  }>(`SELECT id, kind, state, started_at, finished_at, result FROM sync_run ORDER BY id DESC LIMIT 10`);
});

resolver.define('loadSampleHospital', async ({ context }: { context?: ReqContext }) => {
  await assertAdmin();
  await captureContext(context);
  await runMigrations();
  return loadSampleHospital();
});

resolver.define('removeSampleHospital', async () => {
  await assertAdmin();
  await runMigrations();
  return removeSampleHospital();
});

resolver.define('getSampleState', async () => {
  return getSampleState();
});

resolver.define('getSyncProgress', async () => {
  await runMigrations();
  const rows = await query<{ state: string; progress: string; started_at: string; result: string }>(
    `SELECT state, progress, started_at, result FROM sync_run ORDER BY id DESC LIMIT 1`,
  );
  const r = rows[0];
  if (!r) return { state: 'none' };
  return {
    state: r.state,
    progress: safeJsonParse(r.progress, null),
    startedAt: r.started_at,
    result: r.result,
  };
});

/** Is this Confluence page in the impact map of an active shortage? */
export async function getPageNoticeData(pageId: string | undefined) {
  await runMigrations();
  if (!pageId) return { affected: false as const };
  const items = await query<{
    shortage_key: string;
    title: string;
    generic_name: string;
    presentation: string | null;
    package_ndc: string | null;
    status: string;
    hop: number | null;
  }>(
    `SELECT i.shortage_key, i.title, s.generic_name, s.presentation, s.package_ndc, s.status,
            COALESCE(i.hop, 1) AS hop
     FROM impact_item i
     JOIN shortage s ON s.shortage_key = i.shortage_key
     WHERE i.kind = 'page' AND i.ref_id = ? AND s.status IN ('Current', 'To Be Discontinued')
     ORDER BY COALESCE(i.hop, 1), s.update_date DESC`,
    [String(pageId)],
  );
  if (!items.length) return { affected: false as const };

  const shortageKeys = [...new Set(items.map((i) => i.shortage_key))];
  const placeholders = shortageKeys.map(() => '?').join(', ');
  const respRows = await query<{ id: number; jira_issue_key: string }>(
    `SELECT id, jira_issue_key FROM response WHERE shortage_key IN (${placeholders}) ORDER BY id DESC LIMIT 1`,
    shortageKeys,
  );
  const resp = respRows[0];
  const temporaryChanges = resp
    ? await query<{
        id: number;
        description: string;
        state: string;
        reversal_issue_key: string | null;
      }>(
        `SELECT id, description, state, reversal_issue_key
         FROM temporary_change
         WHERE response_id = ?
         ORDER BY id ASC`,
        [resp.id],
      )
    : [];

  return {
    affected: true as const,
    shortages: items.map((i) => ({
      name: i.generic_name,
      presentation: i.presentation ?? '',
      packageNdc: i.package_ndc ?? '',
      shortageId: i.shortage_key,
      status: i.status,
      hop: Number(i.hop ?? 1),
      source: fdaSourceUrl(i.package_ndc),
    })),
    responseWorkItem: resp?.jira_issue_key ?? null,
    temporaryChanges,
    disclaimer: OPENFDA_DISCLAIMER,
  };
}

/** Byline popup: is this page in the impact map of an active shortage? */
resolver.define(
  'getPageNotice',
  async ({ payload, context }: { payload?: { pageId?: string }; context?: ReqContext }) => {
    return getPageNoticeData(payload?.pageId ?? context?.extension?.content?.id);
  },
);

/** Issue panel on a response work item: full picture for one shortage. */
resolver.define(
  'getIssuePanelData',
  async ({
    payload,
    context,
  }: {
    payload?: { issueKey?: string; context?: { issueKey?: string } };
    context?: ReqContext;
  }) => {
    await runMigrations();
    const siteUrl = await getSiteUrl(context);
    const issueKey =
      payload?.issueKey ??
      payload?.context?.issueKey ??
      context?.extension?.issue?.key ??
      context?.issueKey;
    if (!issueKey) return { found: false };

    const respRows = await query<{
      id: number;
      shortage_key: string;
      ingredient: string;
      jira_issue_key: string;
      state: string;
      opened_at: string;
      resolved_at: string | null;
      decision_summary: string | null;
    }>(
      `SELECT id, shortage_key, ingredient, jira_issue_key, state, opened_at, resolved_at, decision_summary
       FROM response
       WHERE jira_issue_key = ?
       LIMIT 1`,
      [String(issueKey)],
    );
    const resp = respRows[0];
    if (!resp) return { found: false, issueKey };

    const key = resp.shortage_key;
    const [shortageRows, impact, temporaryChanges] = await Promise.all([
      query<{
        shortage_key: string;
        generic_name: string;
        presentation: string;
        status: string;
        package_ndc: string;
        dosage_form: string;
        update_date: string;
        initial_posting_date: string;
        contact_info: string | null;
        company_name: string;
        availability: string;
        related_info: string;
      }>(
        `SELECT shortage_key, generic_name, presentation, status, package_ndc, dosage_form,
                update_date, initial_posting_date, contact_info, company_name, availability, related_info
         FROM shortage
         WHERE shortage_key = ?
         LIMIT 1`,
        [key],
      ),
      query<{
        id: number;
        kind: string;
        ref_id: string;
        title: string;
        url: string;
        owner_account_id: string | null;
        owner_name: string | null;
        team_name: string | null;
        found_via: string;
        hop: number;
        space_key: string | null;
      }>(
        `SELECT id, kind, ref_id, title, url, owner_account_id, owner_name, team_name,
                found_via, COALESCE(hop, 1) AS hop, space_key
         FROM impact_item
         WHERE shortage_key = ?
         ORDER BY COALESCE(hop, 1), kind, title`,
        [key],
      ),
      query<{
        id: number;
        description: string;
        impact_item_id: number | null;
        reversal_issue_key: string | null;
        state: string;
        created_at: string;
        reversed_at: string | null;
      }>(
        `SELECT id, description, impact_item_id, reversal_issue_key, state, created_at, reversed_at
         FROM temporary_change
         WHERE response_id = ?
         ORDER BY id ASC`,
        [resp.id],
      ),
    ]);

    const shortage = shortageRows[0] ?? null;
    const baseIng = baseIngredientName(shortage?.generic_name ?? resp.ingredient ?? '');
    const pastResponses = baseIng
      ? await query<{
          id: number;
          shortage_key: string;
          ingredient: string;
          jira_issue_key: string;
          state: string;
          opened_at: string;
          resolved_at: string | null;
          decision_summary: string | null;
        }>(
          `SELECT id, shortage_key, ingredient, jira_issue_key, state, opened_at, resolved_at, decision_summary
           FROM response
           WHERE LOWER(ingredient) LIKE ? AND shortage_key != ?
           ORDER BY opened_at DESC
           LIMIT 20`,
          [`%${baseIng.toLowerCase()}%`, key],
        )
      : [];

    return {
      found: true,
      responseId: resp.id,
      jiraIssueKey: issueKey,
      responseState: resp.state,
      decisionSummary: resp.decision_summary ?? null,
      shortage,
      source: fdaSourceUrl(shortage?.package_ndc),
      impact,
      temporaryChanges,
      pastResponses,
      disclaimer: OPENFDA_DISCLAIMER,
      siteUrl,
    };
  },
);

/**
 * Foreground Teamwork Graph enrichment: fill owners, teams, and 2nd-hop
 * linked Confluence pages on impact items using the calling user's context.
 */
resolver.define('enrichImpact', async ({ context }: { context?: ReqContext }) => {
  const captured = await captureContext(context);
  await runMigrations();
  const cloudId = captured.cloudId ?? ((await kvs.get('cloudId')) as string | undefined);

  const [directRows, existingRows] = await Promise.all([
    query<{
      id: number;
      shortage_key: string;
      ref_id: string;
      space_key: string | null;
    }>(
      `SELECT id, shortage_key, ref_id, space_key
       FROM impact_item
       WHERE kind = 'page' AND COALESCE(hop, 1) = 1`,
    ),
    query<{ shortage_key: string; kind: string; ref_id: string }>(
      `SELECT shortage_key, kind, ref_id FROM impact_item`,
    ),
  ]);

  const existingSet = new Set(
    existingRows.map((r) => `${r.shortage_key}|${r.kind}|${r.ref_id}`),
  );

  // Deduplicate direct Confluence pages by ref_id while retaining every shortage_key they touch.
  const pageGroups = new Map<string, { shortageKeys: Set<string>; spaceKey: string | null }>();
  for (const row of directRows) {
    let group = pageGroups.get(row.ref_id);
    if (!group) {
      group = { shortageKeys: new Set<string>(), spaceKey: row.space_key };
      pageGroups.set(row.ref_id, group);
    }
    group.shortageKeys.add(row.shortage_key);
    if (!group.spaceKey && row.space_key) group.spaceKey = row.space_key;
  }

  let enrichedOwners = 0;
  let discoveredLinkedPages = 0;
  const missing: string[] = [];

  for (const [refId, group] of pageGroups.entries()) {
    const pageAri = cloudId
      ? `ari:cloud:confluence:${cloudId}:page/${refId}`
      : `ari:cloud:confluence::page/${refId}`;

    // 1. Page owners (fallback to page creator).
    const ownersRes = await pageOwners(pageAri);
    if (ownersRes.error) missing.push(ownersRes.error);
    let ownerNodes = ownersRes.nodes;
    if (!ownerNodes.length) {
      const creatorRes = await pageCreator(pageAri);
      if (creatorRes.error) missing.push(creatorRes.error);
      ownerNodes = creatorRes.nodes;
    }

    const ownerName = ownerNodes
      .map((n) => n.name ?? n.displayName ?? '')
      .filter(Boolean)
      .join(', ');
    const ownerUserAri = ownerNodes[0]?.id;
    const ownerAccountId = ownerUserAri ? ownerUserAri.split('/').pop() ?? '' : '';

    if (ownerName || ownerAccountId) {
      await execute(
        `UPDATE impact_item
         SET owner_name = COALESCE(NULLIF(?, ''), owner_name),
             owner_account_id = COALESCE(NULLIF(?, ''), owner_account_id)
         WHERE kind = 'page' AND ref_id = ?`,
        [ownerName, ownerAccountId, refId],
      );
      enrichedOwners++;
    }

    // 2. Teams for the page owner.
    if (ownerUserAri) {
      const teamsRes = await userTeams(ownerUserAri);
      if (teamsRes.error) missing.push(teamsRes.error);
      const teamName = teamsRes.nodes
        .map((n) => n.name ?? n.displayName ?? '')
        .filter(Boolean)
        .join(', ');
      if (teamName) {
        await execute(
          `UPDATE impact_item
           SET team_name = ?
           WHERE kind = 'page' AND ref_id = ?`,
          [teamName, refId],
        );
      }
    }

    // 3. 2nd-hop Teamwork Graph linked Confluence pages.
    const linkedRes = await linkedPages(pageAri);
    if (linkedRes.error) missing.push(linkedRes.error);
    for (const node of linkedRes.nodes) {
      const rawId = node.id ?? '';
      const linkedPageId = rawId.includes('/') ? rawId.split('/').pop() ?? '' : rawId;
      if (!linkedPageId || linkedPageId === refId) continue;

      const rec = node as Record<string, unknown>;
      const title =
        node.title ??
        node.name ??
        node.displayName ??
        `Linked Confluence page ${linkedPageId}`;
      const rawUrl =
        (typeof rec.url === 'string' && rec.url) ||
        (typeof rec.webUrl === 'string' && rec.webUrl) ||
        `/wiki/pages/viewpage.action?pageId=${linkedPageId}`;
      const spaceKey =
        (typeof rec.spaceKey === 'string' && rec.spaceKey) || group.spaceKey || '';

      for (const shortageKey of group.shortageKeys) {
        const dedupeKey = `${shortageKey}|page|${linkedPageId}`;
        if (existingSet.has(dedupeKey)) continue;
        existingSet.add(dedupeKey);

        await execute(
          `INSERT INTO impact_item
             (shortage_key, kind, ref_id, title, url, found_via, hop, space_key, detail, created_at)
           VALUES (?, 'page', ?, ?, ?, 'teamwork-graph-link', 2, ?, ?, NOW())`,
          [
            shortageKey,
            linkedPageId,
            title,
            rawUrl,
            spaceKey,
            `Linked via Teamwork Graph from page ${refId}`,
          ],
        );
        discoveredLinkedPages++;
      }
    }
  }

  return {
    enrichedOwners,
    discoveredLinkedPages,
    missing: [...new Set(missing)].slice(0, 15),
  };
});

export const uiResolver = resolver.getDefinitions();
