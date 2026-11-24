import Resolver from '@forge/resolver';
import api, { route } from '@forge/api';
import { kvs } from '@forge/kvs';
import {
  runMigrations,
  query,
  execute,
  resetSqlStatementCount,
  getSqlStatementCount,
} from './storage/schema';
import { getSettings, saveSettings, AppSettings } from './settings';
import { enqueueSync } from './sync';
import { probeGraph, pageOwners, pageCreator, pageContributors, userTeams, linkedPages } from './graph';
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
  createOwnerTasksForResponse,
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

/** Shared KPI computation using 2-3 aggregate SQL queries instead of one per KPI. */
export async function computeDashboardMetrics() {
  const settings = await getSettings();
  const clinicalSpaces = settings.clinicalSpaceKeys.filter(Boolean);
  const respProj = settings.responseProjectKey?.trim() || '';

  // Exclude Shortfall's own generated Jira response/reversal tickets from impact KPIs.
  const impactWhereParts = [
    `(kind != 'jira' OR (title NOT LIKE '[Shortage]%' AND title NOT LIKE '[Owner Review]%' AND title NOT LIKE '[Reversal]%'))`,
  ];
  const impactParams: unknown[] = [];
  if (respProj) {
    impactWhereParts.push(`(kind != 'jira' OR ref_id NOT LIKE ?)`);
    impactParams.push(`${respProj}-%`);
  }
  if (clinicalSpaces.length > 0) {
    const ph = clinicalSpaces.map(() => '?').join(',');
    impactWhereParts.push(
      `(kind != 'page' OR space_key IS NULL OR space_key = '' OR space_key IN (${ph}))`,
    );
    impactParams.push(...clinicalSpaces);
  }
  const impactWhere = impactWhereParts.join(' AND ');

  // 1. Single aggregate query for ALL 10 scalar KPIs (replaces 10 separate queries).
  const scalarSql = `SELECT
    (SELECT COUNT(DISTINCT s.shortage_key) FROM shortage s JOIN \`match\` m ON m.shortage_key = s.shortage_key AND m.superseded = 0 WHERE s.status = 'Current') AS activeMatched,
    (SELECT COUNT(DISTINCT s.shortage_key) FROM shortage s JOIN \`match\` m ON m.shortage_key = s.shortage_key AND m.superseded = 0 WHERE s.status = 'To Be Discontinued') AS discontinuedMatched,
    (SELECT COUNT(DISTINCT s.shortage_key) FROM shortage s JOIN \`match\` m ON m.shortage_key = s.shortage_key AND m.superseded = 0 WHERE s.status = 'Resolved') AS resolvedMatched,
    (SELECT COUNT(*) FROM formulary_item WHERE active = 1) AS formularyCount,
    (SELECT COUNT(DISTINCT CONCAT(kind, ':', ref_id)) FROM impact_item WHERE ${impactWhere}) AS impactItems,
    (SELECT COUNT(DISTINCT CONCAT(kind, ':', ref_id)) FROM impact_item WHERE ${impactWhere} AND COALESCE(hop, 1) = 1) AS directImpactItems,
    (SELECT COUNT(DISTINCT CONCAT(kind, ':', ref_id)) FROM impact_item WHERE ${impactWhere} AND hop = 2) AS linkedImpactItems,
    (SELECT COUNT(DISTINCT r.jira_issue_key) FROM response r LEFT JOIN shortage s ON s.shortage_key = r.shortage_key WHERE COALESCE(r.state, 'open') = 'open' AND r.jira_issue_key IS NOT NULL AND r.jira_issue_key NOT LIKE 'SAMPLE-%' AND r.jira_issue_key NOT LIKE 'HIST-%' AND COALESCE(s.status, 'Current') != 'Resolved') AS openResponses,
    (SELECT COUNT(*) FROM temporary_change WHERE state IN ('open', 'reversal_open')) AS openTemporaryChanges,
    (SELECT COUNT(*) FROM temporary_change tc JOIN response r ON r.id = tc.response_id JOIN shortage s ON s.shortage_key = r.shortage_key WHERE s.status = 'Resolved' AND tc.state = 'open') AS reversalsDue`;
  const scalarParams = [...impactParams, ...impactParams, ...impactParams];

  // 2. Single combined exposure query (clinical Confluence spaces + non-response Jira projects).
  const pageSpaceFilter =
    clinicalSpaces.length > 0
      ? `space_key IN (${clinicalSpaces.map(() => '?').join(',')})`
      : `space_key IS NOT NULL AND space_key != ''`;
  const exposureSql = `
    SELECT space_key AS spaceKey, COUNT(DISTINCT ref_id) AS count, 'space' AS kind
    FROM impact_item
    WHERE kind = 'page' AND ${pageSpaceFilter}
    GROUP BY space_key
    UNION ALL
    SELECT CONCAT('Jira: ', SUBSTRING_INDEX(ref_id, '-', 1)) AS spaceKey, COUNT(DISTINCT ref_id) AS count, 'jira' AS kind
    FROM impact_item
    WHERE kind = 'jira'
      AND title NOT LIKE '[Shortage]%'
      AND title NOT LIKE '[Owner Review]%'
      AND title NOT LIKE '[Reversal]%'
      ${respProj ? 'AND ref_id NOT LIKE ?' : ''}
    GROUP BY CONCAT('Jira: ', SUBSTRING_INDEX(ref_id, '-', 1))
    ORDER BY count DESC`;
  const exposureParams: unknown[] = [
    ...clinicalSpaces,
    ...(respProj ? [`${respProj}-%`] : []),
  ];

  const [scalarRows, exposureRows] = await Promise.all([
    query<{
      activeMatched: number;
      discontinuedMatched: number;
      resolvedMatched: number;
      formularyCount: number;
      impactItems: number;
      directImpactItems: number;
      linkedImpactItems: number;
      openResponses: number;
      openTemporaryChanges: number;
      reversalsDue: number;
    }>(scalarSql, scalarParams),
    query<{ spaceKey: string; count: number; kind: 'space' | 'jira' }>(exposureSql, exposureParams),
  ]);

  const s = scalarRows[0];
  const openResponses = Number(s?.openResponses ?? 0);

  // 3. Only run response-timing query when open responses exist.
  let medianResponseHours: number | null = null;
  if (openResponses > 0) {
    const timingRows = await query<{
      opened_at: string | Date | null;
      initial_posting_date: string | null;
    }>(
      `SELECT r.opened_at, s.initial_posting_date
       FROM response r
       JOIN shortage s ON s.shortage_key = r.shortage_key
       WHERE r.opened_at IS NOT NULL
         AND s.initial_posting_date IS NOT NULL
         AND r.jira_issue_key NOT LIKE 'SAMPLE-%'`,
    );
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
    if (hours.length > 0) {
      const mid = Math.floor(hours.length / 2);
      const med = hours.length % 2 === 1 ? hours[mid] : (hours[mid - 1] + hours[mid]) / 2;
      medianResponseHours = Math.round(med * 10) / 10;
    }
  }

  const activeMatched = Number(s?.activeMatched ?? 0);
  const discontinuedMatched = Number(s?.discontinuedMatched ?? 0);
  const resolvedMatched = Number(s?.resolvedMatched ?? 0);

  return {
    settings,
    activeMatched,
    discontinuedMatched,
    resolvedMatched,
    totalMatched: activeMatched + discontinuedMatched + resolvedMatched,
    formularyCount: Number(s?.formularyCount ?? 0),
    impactItems: Number(s?.impactItems ?? 0),
    directImpactItems: Number(s?.directImpactItems ?? 0),
    linkedImpactItems: Number(s?.linkedImpactItems ?? 0),
    openResponses,
    openTemporaryChanges: Number(s?.openTemporaryChanges ?? 0),
    reversalsDue: Number(s?.reversalsDue ?? 0),
    exposureBySpace: exposureRows
      .filter((r) => r.spaceKey && Number(r.count ?? 0) > 0)
      .map((r) => ({
        spaceKey: r.spaceKey,
        count: Number(r.count ?? 0),
        kind: r.kind,
      })),
    medianResponseHours,
  };
}

/** Dashboard: last sync result, headline counts, exposure by space, syncLog & latest run in one round-trip. */
resolver.define('getDashboardData', async ({ context }: { context?: ReqContext }) => {
  resetSqlStatementCount();
  const siteUrl = await getSiteUrl(context);
  await runMigrations();

  const [lastSync, graph, metrics, syncLog] = await Promise.all([
    kvs.get('lastSync'),
    probeGraph(),
    computeDashboardMetrics(),
    query<{
      id: number;
      kind: string;
      state: string;
      progress: string | null;
      started_at: string;
      finished_at: string | null;
      result: string | null;
    }>(
      `SELECT id, kind, state, progress, started_at, finished_at, result
       FROM sync_run
       ORDER BY started_at DESC, id DESC
       LIMIT 10`,
    ),
  ]);

  const latest = syncLog[0];
  const latestSyncProgress = latest
    ? {
        state: latest.state,
        progress: safeJsonParse(latest.progress, null),
        startedAt: latest.started_at,
        result: latest.result,
      }
    : { state: 'none' };

  return {
    lastSync: lastSync ?? null,
    activeMatched: metrics.activeMatched,
    discontinuedMatched: metrics.discontinuedMatched,
    resolvedMatched: metrics.resolvedMatched,
    totalMatched: metrics.totalMatched,
    formularyCount: metrics.formularyCount,
    impactItems: metrics.impactItems,
    directImpactItems: metrics.directImpactItems,
    linkedImpactItems: metrics.linkedImpactItems,
    openResponses: metrics.openResponses,
    openTemporaryChanges: metrics.openTemporaryChanges,
    reversalsDue: metrics.reversalsDue,
    exposureBySpace: metrics.exposureBySpace,
    medianResponseHours: metrics.medianResponseHours,
    settings: metrics.settings,
    setupComplete: metrics.settings.setupComplete,
    autoCreateResponses: metrics.settings.autoCreateResponses,
    syncLog,
    latestSyncProgress,
    sqlStatements: getSqlStatementCount(),
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
    `SELECT s.shortage_key,
            MAX(s.generic_name) AS generic_name,
            MAX(s.status) AS status,
            MAX(s.package_ndc) AS package_ndc,
            MAX(s.presentation) AS presentation,
            MAX(s.dosage_form) AS dosage_form,
            MAX(s.company_name) AS company_name,
            MAX(s.update_date) AS update_date,
            MAX(s.initial_posting_date) AS initial_posting_date,
            MIN(m.reason) AS reason,
            MIN(f.display_name) AS display_name,
            COALESCE(MAX(ic.impact_count), 0) AS impact_count,
            MAX(r.jira_issue_key) AS jira_issue_key,
            MAX(r.state) AS response_state
     FROM \`match\` m
     JOIN shortage s ON s.shortage_key = m.shortage_key
     JOIN formulary_item f ON f.id = m.formulary_item_id
     LEFT JOIN (
       SELECT shortage_key, COUNT(DISTINCT CONCAT(kind, ':', ref_id)) AS impact_count
       FROM impact_item
       WHERE kind != 'jira'
          OR (title NOT LIKE '[Shortage]%' AND title NOT LIKE '[Owner Review]%' AND title NOT LIKE '[Reversal]%')
       GROUP BY shortage_key
     ) ic ON ic.shortage_key = s.shortage_key
     LEFT JOIN (
       SELECT shortage_key, MAX(jira_issue_key) AS jira_issue_key, MAX(state) AS state
       FROM response
       WHERE jira_issue_key NOT LIKE 'SAMPLE-%' AND jira_issue_key NOT LIKE 'HIST-%'
       GROUP BY shortage_key
     ) r ON r.shortage_key = s.shortage_key
     WHERE m.superseded = 0
     GROUP BY s.shortage_key
     ORDER BY CASE MAX(s.status) WHEN 'Current' THEN 0 WHEN 'To Be Discontinued' THEN 1 ELSE 2 END,
              MAX(s.update_date) DESC
     LIMIT 2000`,
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

/** Create missing [Owner Review] Jira tasks (with real Relates links) for an existing open response. */
resolver.define(
  'createOwnerTasks',
  async ({ payload }: { payload: { shortageKey?: string; shortageId?: string } }) => {
    await runMigrations();
    const key = payload?.shortageKey ?? payload?.shortageId;
    if (!key) throw new Error('shortageKey is required');
    return createOwnerTasksForResponse(key, { asUser: true });
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
  }>(`SELECT id, kind, state, started_at, finished_at, result FROM sync_run ORDER BY started_at DESC, id DESC LIMIT 10`);
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
    `SELECT state, progress, started_at, result FROM sync_run ORDER BY started_at DESC, id DESC LIMIT 1`,
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
 * Resolve a Confluence accountId to a human Atlassian user, returning null if
 * the account is an app/bot (e.g. Shortfall's own app account).
 */
async function resolveHumanConfluenceUser(
  accountId: string,
  cache: Map<string, { name: string; accountId: string } | null>,
): Promise<{ name: string; accountId: string } | null> {
  if (!accountId) return null;
  if (cache.has(accountId)) return cache.get(accountId) ?? null;
  try {
    const userRes = await api
      .asUser()
      .requestConfluence(route`/wiki/rest/api/user?accountId=${accountId}`, {
        headers: { Accept: 'application/json' },
      });
    if (userRes.ok) {
      const userData = (await userRes.json()) as {
        displayName?: string;
        publicName?: string;
        accountType?: string;
      };
      const name = (userData.displayName ?? userData.publicName ?? '').trim();
      if (userData.accountType !== 'app' && name && name.toLowerCase() !== 'shortfall') {
        const hit = { name, accountId };
        cache.set(accountId, hit);
        return hit;
      }
    }
  } catch {
    // Ignore lookup failure.
  }
  cache.set(accountId, null);
  return null;
}

/**
 * Foreground Teamwork Graph enrichment: fill human owners, teams, and 2nd-hop
 * linked Confluence pages on impact items using the calling user's context.
 * Batches 2nd-hop inserts and skips unchanged owner/team UPDATEs to keep SQL minimal.
 */
resolver.define('enrichImpact', async ({ context }: { context?: ReqContext }) => {
  resetSqlStatementCount();
  const captured = await captureContext(context);
  await runMigrations();
  const cloudId = captured.cloudId ?? ((await kvs.get('cloudId')) as string | undefined);

  // Single SELECT loads all impact_item rows for both direct-page grouping and deduping.
  const allImpactRows = await query<{
    shortage_key: string;
    kind: string;
    ref_id: string;
    space_key: string | null;
    hop: number | null;
    owner_name: string | null;
    owner_account_id: string | null;
    team_name: string | null;
  }>(
    `SELECT shortage_key, kind, ref_id, space_key, COALESCE(hop, 1) AS hop,
            owner_name, owner_account_id, team_name
     FROM impact_item`,
  );

  const existingSet = new Set(
    allImpactRows.map((r) => `${r.shortage_key}|${r.kind}|${r.ref_id}`),
  );

  const pageGroups = new Map<
    string,
    {
      shortageKeys: Set<string>;
      spaceKey: string | null;
      existingOwnerName: string;
      existingOwnerAcct: string;
      existingTeamName: string;
    }
  >();
  for (const row of allImpactRows) {
    if (row.kind !== 'page' || Number(row.hop ?? 1) !== 1) continue;
    let group = pageGroups.get(row.ref_id);
    if (!group) {
      const existingOwner = (row.owner_name ?? '').trim();
      group = {
        shortageKeys: new Set<string>(),
        spaceKey: row.space_key,
        existingOwnerName: existingOwner.toLowerCase() === 'shortfall' ? '' : existingOwner,
        existingOwnerAcct: (row.owner_account_id ?? '').trim(),
        existingTeamName: (row.team_name ?? '').trim(),
      };
      pageGroups.set(row.ref_id, group);
    }
    group.shortageKeys.add(row.shortage_key);
    if (!group.spaceKey && row.space_key) group.spaceKey = row.space_key;
  }

  let enrichedOwners = 0;
  let discoveredLinkedPages = 0;
  const missing: string[] = [];
  const userCache = new Map<string, { name: string; accountId: string } | null>();
  const pendingLinkedRows: {
    shortageKey: string;
    refId: string;
    title: string;
    url: string;
    spaceKey: string;
    detail: string;
  }[] = [];

  for (const [refId, group] of pageGroups.entries()) {
    const pageAri = cloudId
      ? `ari:cloud:confluence:${cloudId}:page/${refId}`
      : `ari:cloud:confluence::page/${refId}`;

    // 1. Human owner: TWG pageOwners -> pageCreator -> pageContributors -> Confluence REST v2
    //    (ownerId -> authorId -> version.authorId -> page version history). Never accept app accounts.
    const ownersRes = await pageOwners(pageAri);
    if (ownersRes.error) missing.push(ownersRes.error);
    let ownerNodes = ownersRes.nodes.filter(
      (n) => (n.name ?? n.displayName ?? '').trim().toLowerCase() !== 'shortfall',
    );
    if (!ownerNodes.length) {
      const creatorRes = await pageCreator(pageAri);
      if (creatorRes.error) missing.push(creatorRes.error);
      ownerNodes = creatorRes.nodes.filter(
        (n) => (n.name ?? n.displayName ?? '').trim().toLowerCase() !== 'shortfall',
      );
    }
    if (!ownerNodes.length) {
      const contribRes = await pageContributors(pageAri);
      if (contribRes.error) missing.push(contribRes.error);
      ownerNodes = contribRes.nodes.filter(
        (n) => (n.name ?? n.displayName ?? '').trim().toLowerCase() !== 'shortfall',
      );
    }

    let ownerName = ownerNodes
      .map((n) => n.name ?? n.displayName ?? '')
      .filter(Boolean)
      .join(', ');
    let ownerUserAri = ownerNodes[0]?.id;
    let ownerAccountId = ownerUserAri ? ownerUserAri.split('/').pop() ?? '' : '';

    // Confluence REST v2 fallback: checks ownerId, authorId, latest editor (version.authorId),
    // and recent version history to find a real human contributor on app-created pages.
    if (!ownerName) {
      try {
        const pageRes = await api
          .asUser()
          .requestConfluence(route`/wiki/api/v2/pages/${refId}`, {
            headers: { Accept: 'application/json' },
          });
        if (pageRes.ok) {
          const pageData = (await pageRes.json()) as {
            ownerId?: string;
            authorId?: string;
            version?: { authorId?: string };
          };
          const candidates = [
            pageData.ownerId,
            pageData.authorId,
            pageData.version?.authorId,
          ].filter((id): id is string => Boolean(id));

          for (const candidateId of [...new Set(candidates)]) {
            const human = await resolveHumanConfluenceUser(candidateId, userCache);
            if (human) {
              ownerName = human.name;
              ownerAccountId = human.accountId;
              ownerUserAri = `ari:cloud:identity::user/${human.accountId}`;
              break;
            }
          }

          if (!ownerName) {
            const verRes = await api
              .asUser()
              .requestConfluence(route`/wiki/api/v2/pages/${refId}/versions?limit=10`, {
                headers: { Accept: 'application/json' },
              });
            if (verRes.ok) {
              const verBody = (await verRes.json()) as {
                results?: { authorId?: string }[];
              };
              for (const v of verBody.results ?? []) {
                if (!v.authorId) continue;
                const human = await resolveHumanConfluenceUser(v.authorId, userCache);
                if (human) {
                  ownerName = human.name;
                  ownerAccountId = human.accountId;
                  ownerUserAri = `ari:cloud:identity::user/${human.accountId}`;
                  break;
                }
              }
            }
          }
        }
      } catch {
        // Best-effort REST fallback.
      }
    }

    // 2. Teams for the resolved human owner via Teamwork Graph.
    let teamName = '';
    if (ownerUserAri) {
      const teamsRes = await userTeams(ownerUserAri);
      if (teamsRes.error) missing.push(teamsRes.error);
      teamName = teamsRes.nodes
        .map((n) => n.name ?? n.displayName ?? '')
        .filter(Boolean)
        .join(', ');
    }

    // Single combined UPDATE per page ONLY when owner or team actually changed.
    const ownerChanged =
      Boolean(ownerName || ownerAccountId) &&
      (ownerName !== group.existingOwnerName || ownerAccountId !== group.existingOwnerAcct);
    const teamChanged = Boolean(teamName) && teamName !== group.existingTeamName;
    if (ownerChanged || teamChanged) {
      await execute(
        `UPDATE impact_item
         SET owner_name = COALESCE(NULLIF(?, ''), owner_name),
             owner_account_id = COALESCE(NULLIF(?, ''), owner_account_id),
             team_name = COALESCE(NULLIF(?, ''), team_name)
         WHERE kind = 'page' AND ref_id = ?`,
        [ownerName, ownerAccountId, teamName, refId],
      );
    }
    if (ownerName || ownerAccountId) {
      enrichedOwners++;
    }

    // 3. 2nd-hop Teamwork Graph linked Confluence pages (collected for batch INSERT).
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
        pendingLinkedRows.push({
          shortageKey,
          refId: linkedPageId,
          title,
          url: rawUrl,
          spaceKey,
          detail: `Linked via Teamwork Graph from page ${refId}`,
        });
        discoveredLinkedPages++;
      }
    }
  }

  // Batch INSERT all discovered 2nd-hop rows in chunks of 40 (replaces 30+ individual INSERTs).
  const CHUNK = 40;
  for (let i = 0; i < pendingLinkedRows.length; i += CHUNK) {
    const chunk = pendingLinkedRows.slice(i, i + CHUNK);
    const placeholders = chunk
      .map(() => `(?, 'page', ?, ?, ?, 'teamwork-graph-link', 2, ?, ?, NOW())`)
      .join(', ');
    const params: unknown[] = [];
    for (const r of chunk) {
      params.push(r.shortageKey, r.refId, r.title, r.url, r.spaceKey, r.detail);
    }
    await execute(
      `INSERT INTO impact_item
         (shortage_key, kind, ref_id, title, url, found_via, hop, space_key, detail, created_at)
       VALUES ${placeholders}`,
      params,
    );
  }

  return {
    enrichedOwners,
    discoveredLinkedPages,
    sqlStatements: getSqlStatementCount(),
    missing: [...new Set(missing)].slice(0, 15),
  };
});

export const uiResolver = resolver.getDefinitions();
