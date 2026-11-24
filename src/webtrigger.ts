import { timingSafeEqual } from 'node:crypto';
import {
  query,
  runMigrations,
  resetSqlStatementCount,
  getSqlStatementCount,
} from './storage/schema';
import { enqueueSync } from './sync';
import { loadSampleHospital, removeSampleHospital } from './sample';
import {
  createResponseForShortage,
  openReversalTasksForResolvedResponses,
  cleanupShortfallProcIssues,
} from './respond';
import { actionGetActiveShortages, actionGetReversalChecklist } from './actions';
import { saveSettings } from './settings';
import { fdaSourceUrl } from './match';
import { kvs } from '@forge/kvs';
import api, { route } from '@forge/api';

/**
 * Developer diagnostic webtriggers. Completely disabled (HTTP 404) unless
 * `SHORTFALL_DIAG_TOKEN` is explicitly configured in the Forge environment
 * variables, and even then requires a matching `?token=` query parameter.
 * Responses contain operational aggregates only; no patient data.
 */

interface WebRequest {
  queryParameters?: Record<string, string[]>;
  body?: string;
  method?: string;
}

interface WebContext {
  environmentId?: string;
  installContext?: string;
  cloudId?: string;
}

function json(statusCode: number, body: unknown) {
  return {
    statusCode,
    headers: { 'Content-Type': ['application/json'] },
    body: JSON.stringify(body, null, 2),
  };
}

function authError(req: WebRequest): ReturnType<typeof json> | null {
  const expected = process.env.SHORTFALL_DIAG_TOKEN;
  if (!expected) {
    return json(404, { error: 'not found' });
  }
  const provided = req.queryParameters?.token?.[0] ?? '';
  const expectedBuf = Buffer.from(expected);
  const providedBuf = Buffer.from(provided);
  if (expectedBuf.length !== providedBuf.length || !timingSafeEqual(expectedBuf, providedBuf)) {
    return json(403, { error: 'forbidden' });
  }
  return null;
}

/** POST: drive developer diagnostic actions — sync, sample-load, sample-remove, settings, respond. */
export async function webSync(req: WebRequest, ctx: WebContext) {
  const denied = authError(req);
  if (denied) return denied;

  await runMigrations();
  const cloudId = String(ctx?.installContext ?? '').match(/[0-9a-f-]{36}/i)?.[0];
  if (cloudId) await kvs.set('cloudId', cloudId);

  const action = req.queryParameters?.action?.[0] ?? 'sync';
  switch (action) {
    case 'sync':
      return json(200, await enqueueSync('manual'));
    case 'sample-load':
      return json(200, await loadSampleHospital());
    case 'sample-remove':
      return json(200, await removeSampleHospital());
    case 'settings': {
      const patch: Record<string, unknown> = {};
      if (req.queryParameters?.auto?.[0] === '1') patch.autoCreateResponses = true;
      if (req.queryParameters?.auto?.[0] === '0') patch.autoCreateResponses = false;
      if (req.queryParameters?.project?.[0]) patch.responseProjectKey = req.queryParameters.project[0];
      if (req.queryParameters?.spaces?.[0]) {
        patch.clinicalSpaceKeys = req.queryParameters.spaces[0].split(',').filter(Boolean);
      }
      if (req.queryParameters?.setup?.[0] === '1') patch.setupComplete = true;
      return json(200, await saveSettings(patch));
    }
    case 'projects': {
      const res = await api.asApp().requestJira(route`/rest/api/3/project/search`, {
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) {
        return json(res.status, {
          error: `projects HTTP ${res.status}`,
          body: (await res.text()).slice(0, 300),
        });
      }
      const data = (await res.json()) as { values?: { key: string; name: string }[] };
      return json(200, (data.values ?? []).map((p) => ({ key: p.key, name: p.name })));
    }
    case 'respond': {
      const key = req.queryParameters?.key?.[0] ?? '';
      if (!key) return json(400, { error: 'missing key param' });
      return json(200, await createResponseForShortage(key));
    }
    case 'reversals':
      return json(200, await openReversalTasksForResolvedResponses());
    case 'cleanup-shortfall': {
      const confirm = req.queryParameters?.confirm?.[0] === '1';
      const projectKey = req.queryParameters?.project?.[0];
      const maxDeletes = Number(req.queryParameters?.max?.[0] ?? 80);
      return json(200, await cleanupShortfallProcIssues({ confirm, projectKey, maxDeletes }));
    }
    default:
      return json(400, { error: `unknown action ${action}` });
  }
}

/** GET: diagnostic evidence report — sync log, table counts, sample matches. */
export async function webReport(req: WebRequest, _ctx: WebContext) {
  const denied = authError(req);
  if (denied) return denied;

  await runMigrations();

  const countQuery = async (statement: string) =>
    (await query<{ n: number }>(statement))[0]?.n ?? 0;

  const syncRuns = await query<{
    id: number;
    kind: string;
    state: string;
    started_at: string;
    finished_at: string;
    result: string;
  }>(`SELECT id, kind, state, started_at, finished_at, result FROM sync_run ORDER BY started_at DESC, id DESC LIMIT 10`);

  const matches = await query<{
    shortage_key: string;
    generic_name: string;
    status: string;
    package_ndc: string;
    presentation: string;
    reason: string;
    display_name: string;
  }>(
    `SELECT s.shortage_key, s.generic_name, s.status, s.package_ndc, s.presentation, m.reason, f.display_name
     FROM \`match\` m
     JOIN shortage s ON s.shortage_key = m.shortage_key
     JOIN formulary_item f ON f.id = m.formulary_item_id
     WHERE m.superseded = 0
     ORDER BY s.update_date DESC LIMIT 50`,
  );

  const lastSync = (await kvs.get('lastSync')) ?? null;

  const pageCheckId = req.queryParameters?.pageId?.[0];
  const { getPageNoticeData, computeDashboardMetrics } = await import('./resolvers');
  const pageCheck = pageCheckId ? await getPageNoticeData(pageCheckId) : undefined;
  const kpis = await computeDashboardMetrics();

  const includeRovo = req.queryParameters?.rovo?.[0] === '1';
  const rovoCheck = includeRovo
    ? {
        cefazolin: await actionGetActiveShortages({ inputs: { ingredient: 'cefazolin' } }),
        reversals: await actionGetReversalChecklist({ inputs: { state: 'open' } }),
      }
    : undefined;

  const includeAudit = req.queryParameters?.audit?.[0] === '1';
  let audit: Record<string, unknown> | undefined;
  if (includeAudit) {
    const respProj = kpis.settings.responseProjectKey ?? 'PROC';
    const procIssues: {
      key: string;
      summary: string;
      assignee: string;
      priority: string;
      status: string;
      reporter: string;
      links: { type: string; inward?: string; outward?: string }[];
      hasAdfLinks: boolean;
      hasHumanFdaLink: boolean;
      hasLabeledRawFdaLink: boolean;
    }[] = [];
    let nextPageToken: string | undefined;
    const jql = `project = "${respProj}" ORDER BY created ASC`;
    let totalProc = 0;
    for (let p = 0; p < 10; p++) {
      const res = await api.asApp().requestJira(
        nextPageToken
          ? route`/rest/api/3/search/jql?jql=${jql}&maxResults=100&fields=summary,assignee,priority,status,reporter,issuelinks,description&nextPageToken=${nextPageToken}`
          : route`/rest/api/3/search/jql?jql=${jql}&maxResults=100&fields=summary,assignee,priority,status,reporter,issuelinks,description`,
        { headers: { Accept: 'application/json' } },
      );
      if (!res.ok) break;
      const body = (await res.json()) as {
        issues?: {
          key: string;
          fields: {
            summary?: string;
            assignee?: { displayName?: string } | null;
            priority?: { name?: string } | null;
            status?: { name?: string } | null;
            reporter?: { displayName?: string; accountType?: string } | null;
            issuelinks?: {
              type?: { name?: string };
              inwardIssue?: { key?: string };
              outwardIssue?: { key?: string };
            }[];
            description?: unknown;
          };
        }[];
        nextPageToken?: string;
        isLast?: boolean;
      };
      const items = body.issues ?? [];
      totalProc += items.length;
      for (const issue of items) {
        const sum = (issue.fields?.summary ?? '').trim();
        const isSf =
          (sum.startsWith('[Shortage]') || sum.startsWith('[Owner Review]') || sum.startsWith('[Reversal]')) &&
          (issue.fields?.reporter?.accountType === 'app' ||
            (issue.fields?.reporter?.displayName ?? '').toLowerCase().includes('shortfall'));
        if (!isSf) continue;
        const descJson = JSON.stringify(issue.fields?.description ?? {});
        procIssues.push({
          key: issue.key,
          summary: sum,
          assignee: issue.fields?.assignee?.displayName ?? 'Unassigned',
          priority: issue.fields?.priority?.name ?? 'None',
          status: issue.fields?.status?.name ?? '',
          reporter: issue.fields?.reporter?.displayName ?? '',
          links: (issue.fields?.issuelinks ?? []).map((l) => ({
            type: l.type?.name ?? '',
            inward: l.inwardIssue?.key,
            outward: l.outwardIssue?.key,
          })),
          hasAdfLinks: descJson.includes('"type":"link"'),
          hasHumanFdaLink: descJson.includes('https://dps.fda.gov/drugshortages'),
          hasLabeledRawFdaLink: descJson.includes('openFDA record (raw data)'),
        });
      }
      if (body.isLast || !body.nextPageToken || !items.length) break;
      nextPageToken = body.nextPageToken;
    }

    // List SHOSP pages to verify zero duplicate titles.
    const shospPages: { id: string; title: string }[] = [];
    const spRes = await api.asApp().requestConfluence(route`/wiki/api/v2/spaces?keys=SHOSP`, {
      headers: { Accept: 'application/json' },
    });
    if (spRes.ok) {
      const spBody = (await spRes.json()) as { results?: { id: string }[] };
      const spaceId = spBody.results?.[0]?.id;
      if (spaceId) {
        const pgRes = await api
          .asApp()
          .requestConfluence(route`/wiki/api/v2/spaces/${spaceId}/pages?limit=100`, {
            headers: { Accept: 'application/json' },
          });
        if (pgRes.ok) {
          const pgBody = (await pgRes.json()) as {
            results?: { id: string; title: string; status?: string }[];
          };
          for (const pg of pgBody.results ?? []) {
            if (!pg.status || pg.status === 'current') {
              shospPages.push({ id: String(pg.id), title: pg.title });
            }
          }
        }
      }
    }

    const procImpactCount =
      (
        await query<{ n: number }>(
          `SELECT COUNT(*) AS n FROM impact_item WHERE kind = 'jira' AND ref_id LIKE ?`,
          [`${respProj}-%`],
        )
      )[0]?.n ?? 0;

    const matchedTabCount =
      (
        await query<{ n: number }>(
          `SELECT COUNT(DISTINCT s.shortage_key) AS n
           FROM \`match\` m
           JOIN shortage s ON s.shortage_key = m.shortage_key
           JOIN formulary_item f ON f.id = m.formulary_item_id
           WHERE m.superseded = 0`,
        )
      )[0]?.n ?? 0;

    audit = {
      totalProcIssues: totalProc,
      preservedNonShortfallProcIssues: totalProc - procIssues.length,
      shortfallProcIssues: procIssues,
      procImpactRowsCount: Number(procImpactCount),
      shospPages,
      matchedTabCount: Number(matchedTabCount),
    };
  }

  const impactItems = await query<{
    shortage_key: string;
    kind: string;
    ref_id: string;
    title: string;
    owner_name: string;
    team_name: string;
    found_via: string;
    space_key: string;
    hop: number;
  }>(
    `SELECT shortage_key, kind, ref_id, title, owner_name, team_name, found_via, space_key, hop
     FROM impact_item LIMIT 100`,
  );

  const includeBench = req.queryParameters?.bench?.[0] === '1';
  let sqlBench: Record<string, unknown> | undefined;
  if (includeBench) {
    resetSqlStatementCount();
    await runMigrations();
    await computeDashboardMetrics();
    await query(
      `SELECT id, kind, state, progress, started_at, finished_at, result
       FROM sync_run ORDER BY started_at DESC, id DESC LIMIT 10`,
    );
    await query(
      `SELECT s.shortage_key, MAX(s.generic_name) AS generic_name
       FROM \`match\` m
       JOIN shortage s ON s.shortage_key = m.shortage_key
       JOIN formulary_item f ON f.id = m.formulary_item_id
       WHERE m.superseded = 0
       GROUP BY s.shortage_key
       LIMIT 2000`,
    );
    const dashboardLoadStatements = getSqlStatementCount();
    const lastSyncObj = lastSync as { sqlStatements?: number; skippedUnchanged?: boolean } | null;
    sqlBench = {
      dashboardLoadStatements,
      lastSyncStatements: lastSyncObj?.sqlStatements ?? null,
      lastSyncSkippedUnchanged: lastSyncObj?.skippedUnchanged ?? null,
      combinedNoChangeSyncPlusDashboard:
        lastSyncObj?.sqlStatements != null
          ? lastSyncObj.sqlStatements + dashboardLoadStatements
          : null,
    };
  }

  return json(200, {
    generatedAt: new Date().toISOString(),
    counts: {
      shortage: await countQuery('SELECT COUNT(*) AS n FROM shortage'),
      formulary_item: await countQuery('SELECT COUNT(*) AS n FROM formulary_item'),
      match: await countQuery('SELECT COUNT(*) AS n FROM `match`'),
      impact_item: await countQuery('SELECT COUNT(*) AS n FROM impact_item'),
      response: await countQuery('SELECT COUNT(*) AS n FROM response'),
      temporary_change: await countQuery('SELECT COUNT(*) AS n FROM temporary_change'),
      sync_run: await countQuery('SELECT COUNT(*) AS n FROM sync_run'),
    },
    kpis,
    sqlBench,
    rovoCheck,
    audit,
    syncRuns,
    lastSync,
    pageCheck,
    impactItems,
    matchedShortages: matches.map((m) => ({
      shortageKey: m.shortage_key,
      genericName: m.generic_name,
      presentation: m.presentation,
      packageNdc: m.package_ndc,
      fdaStatus: m.status,
      matchedTo: m.display_name,
      matchReason: m.reason,
      source: fdaSourceUrl(m.package_ndc),
    })),
  });
}
