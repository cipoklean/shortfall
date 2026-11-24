import { kvs } from '@forge/kvs';
import { runMigrations, query } from './storage/schema';
import { getSettings } from './settings';
import { probeGraph } from './graph';
import {
  createJiraWorkItem,
  recordTemporaryChange,
  resolveSiteHref,
  FDA_HUMAN_SHORTAGES_URL,
} from './respond';
import { OPENFDA_DISCLAIMER } from './types';
import { fdaSourceUrl } from './match';

export { OPENFDA_DISCLAIMER };

type ActionInputs = Record<string, string | number | boolean | undefined>;

function inputsOf(req: unknown): ActionInputs {
  const r = req as { inputs?: ActionInputs };
  return r?.inputs ?? (req as ActionInputs) ?? {};
}

/** Placeholder/synthetic keys (e.g. SAMPLE-REV-BUM, HIST-2025-CEF) are not real Jira issues. */
export function isPlaceholderJiraKey(key?: string | null): boolean {
  const k = (key ?? '').trim();
  if (!k) return true;
  return k.startsWith('SAMPLE-') || k.startsWith('HIST-');
}

/** Human-readable status label for temporary_change rows (never expose raw DB enums). */
export function formatReversalStatusLabel(
  rawState?: string | null,
  fdaStatus?: string | null,
): string {
  const s = (rawState ?? '').trim().toLowerCase();
  if (s === 'reversal_open') return 'Reversal in progress';
  if (s === 'reversed') return 'Reversed';
  if (s === 'open') {
    return (fdaStatus ?? '').trim().toLowerCase() === 'resolved'
      ? 'Reversal due'
      : 'Open (shortage active)';
  }
  return 'Unknown';
}

function isHumanOwnerName(name?: string | null): boolean {
  const n = (name ?? '').trim();
  return Boolean(n) && n.toLowerCase() !== 'shortfall';
}

async function getStoredSiteUrl(): Promise<string> {
  try {
    const raw = (await kvs.get('siteUrl')) as string | undefined;
    return raw ? String(raw).replace(/\/+$/, '') : '';
  } catch {
    return '';
  }
}

function toFullUrl(pathOrUrl: string | null | undefined, siteUrl: string): string | undefined {
  return resolveSiteHref(pathOrUrl, siteUrl) ?? (pathOrUrl || undefined);
}

async function reducedMode(): Promise<string[]> {
  const graph = await probeGraph();
  const missing = [...graph.missingScopes];
  if (!graph.available && graph.note) missing.push(graph.note);
  return missing;
}

export async function actionGetActiveShortages(req: unknown) {
  await runMigrations();
  const { ingredient } = inputsOf(req);
  const params: unknown[] = [];
  let filter = '';
  if (ingredient) {
    filter = 'AND LOWER(s.generic_name) LIKE ?';
    params.push(`%${String(ingredient).toLowerCase()}%`);
  }
  const rows = await query<{
    shortage_key: string;
    generic_name: string;
    presentation: string;
    package_ndc: string;
    status: string;
    update_date: string;
    company_name: string;
  }>(
    `SELECT DISTINCT s.shortage_key, s.generic_name, s.presentation, s.package_ndc, s.status, s.update_date, s.company_name
     FROM shortage s
     JOIN \`match\` m ON m.shortage_key = s.shortage_key AND m.superseded = 0
     WHERE s.status IN ('Current', 'To Be Discontinued') ${filter}
     ORDER BY CASE s.status WHEN 'Current' THEN 0 ELSE 1 END, s.update_date DESC
     LIMIT 500`,
    params,
  );
  return {
    disclaimer: OPENFDA_DISCLAIMER,
    fdaDatabaseUrl: FDA_HUMAN_SHORTAGES_URL,
    reducedMode: await reducedMode(),
    shortages: rows.map((r) => ({
      shortageId: r.shortage_key,
      genericName: r.generic_name,
      presentation: r.presentation,
      packageNdc: r.package_ndc,
      status: r.status,
      updateDate: r.update_date,
      company: r.company_name,
      fdaDatabaseUrl: FDA_HUMAN_SHORTAGES_URL,
      source: fdaSourceUrl(r.package_ndc),
      sourceLabel: 'openFDA record (raw data)',
    })),
  };
}

export async function actionGetShortageImpact(req: unknown) {
  await runMigrations();
  const { shortageId } = inputsOf(req);
  if (!shortageId) return { error: 'shortageId is required' };
  const [rows, siteUrl] = await Promise.all([
    query<{
      kind: string;
      ref_id: string;
      title: string;
      url: string;
      owner_name: string;
      team_name: string;
      found_via: string;
      hop: number | null;
      space_key: string | null;
    }>(
      `SELECT kind, ref_id, title, url, owner_name, team_name, found_via, COALESCE(hop, 1) AS hop, space_key
       FROM impact_item
       WHERE shortage_key = ?
       ORDER BY COALESCE(hop, 1), kind, title`,
      [String(shortageId)],
    ),
    getStoredSiteUrl(),
  ]);
  return {
    reducedMode: await reducedMode(),
    impact: rows.map((r) => ({
      kind: r.kind,
      ref: r.ref_id,
      title: r.title,
      url: toFullUrl(r.url, siteUrl) ?? r.url,
      owner: isHumanOwnerName(r.owner_name) ? r.owner_name : 'Unassigned',
      team: r.team_name,
      foundVia: r.found_via,
      hop: Number(r.hop ?? 1),
      spaceKey: r.space_key ?? '',
    })),
  };
}

export async function actionGetPastResponses(req: unknown) {
  await runMigrations();
  const { ingredient } = inputsOf(req);
  if (!ingredient) return { error: 'ingredient is required' };
  const [rows, siteUrl, logPages] = await Promise.all([
    query<{
      shortage_key: string;
      ingredient: string;
      jira_issue_key: string | null;
      state: string;
      opened_at: string;
      resolved_at: string;
      decision_summary: string | null;
    }>(
      `SELECT shortage_key, ingredient, jira_issue_key, state, opened_at, resolved_at, decision_summary
       FROM response
       WHERE LOWER(ingredient) LIKE ?
       ORDER BY opened_at DESC
       LIMIT 50`,
      [`%${String(ingredient).toLowerCase()}%`],
    ),
    getStoredSiteUrl(),
    query<{ title: string; url: string; owner_name: string | null }>(
      `SELECT DISTINCT title, url, owner_name
       FROM impact_item
       WHERE kind = 'page'
         AND (LOWER(title) LIKE '%response log%' OR LOWER(title) LIKE '%p&t minutes%')
       LIMIT 5`,
    ),
  ]);

  const sampleLogPage = logPages[0]
    ? {
        title: logPages[0].title,
        url: toFullUrl(logPages[0].url, siteUrl),
        owner: isHumanOwnerName(logPages[0].owner_name) ? logPages[0].owner_name : undefined,
      }
    : undefined;

  return {
    responses: rows.map((r) => {
      const placeholder = isPlaceholderJiraKey(r.jira_issue_key);
      return {
        shortageId: r.shortage_key,
        ingredient: r.ingredient,
        ...(placeholder
          ? {
              isSampleData: true,
              sourceAttribution:
                'Sample hospital historical record (documented in Confluence; no Jira ticket).',
              sourcePage: sampleLogPage,
            }
          : {
              jiraWorkItem: r.jira_issue_key ?? undefined,
              url: toFullUrl(`/browse/${r.jira_issue_key}`, siteUrl),
            }),
        status: r.state === 'resolved' ? 'Resolved' : r.state === 'superseded' ? 'Superseded' : 'Open',
        openedAt: r.opened_at,
        resolvedAt: r.resolved_at,
        decisionSummary: r.decision_summary ?? undefined,
      };
    }),
  };
}

export async function actionGetResponseStatus(req: unknown) {
  await runMigrations();
  const { shortageId } = inputsOf(req);
  if (!shortageId) return { error: 'shortageId is required' };
  const [resp, siteUrl, fdaRows] = await Promise.all([
    query<{
      id: number;
      jira_issue_key: string | null;
      state: string;
      opened_at: string;
      resolved_at: string;
      decision_summary: string | null;
    }>(
      `SELECT id, jira_issue_key, state, opened_at, resolved_at, decision_summary
       FROM response
       WHERE shortage_key = ?
       LIMIT 1`,
      [String(shortageId)],
    ),
    getStoredSiteUrl(),
    query<{ status: string | null; package_ndc: string | null }>(
      `SELECT status, package_ndc FROM shortage WHERE shortage_key = ? LIMIT 1`,
      [String(shortageId)],
    ),
  ]);
  const r = resp[0];
  if (!r) return { found: false, shortageId };
  const fda = fdaRows[0];
  const [changes, pageRows] = await Promise.all([
    query<{
      id: number;
      description: string;
      state: string;
      reversal_issue_key: string | null;
    }>(
      `SELECT id, description, state, reversal_issue_key
       FROM temporary_change
       WHERE response_id = ?
       ORDER BY id ASC`,
      [r.id],
    ),
    query<{ title: string; url: string; owner_name: string | null; hop: number }>(
      `SELECT DISTINCT title, url, owner_name, COALESCE(hop, 1) AS hop
       FROM impact_item
       WHERE shortage_key = ? AND kind = 'page'
       ORDER BY hop, title
       LIMIT 5`,
      [String(shortageId)],
    ),
  ]);
  const placeholder = isPlaceholderJiraKey(r.jira_issue_key);
  const primaryPage = pageRows[0]
    ? {
        title: pageRows[0].title,
        url: toFullUrl(pageRows[0].url, siteUrl),
        owner: isHumanOwnerName(pageRows[0].owner_name) ? pageRows[0].owner_name : undefined,
      }
    : undefined;

  return {
    found: true,
    shortageId,
    ...(placeholder
      ? {
          isSampleData: true,
          sourceAttribution:
            'Sample hospital demonstration data (no parent Jira shortage response ticket).',
          sourcePage: primaryPage,
        }
      : {
          jiraWorkItem: r.jira_issue_key ?? undefined,
          url: toFullUrl(`/browse/${r.jira_issue_key}`, siteUrl),
        }),
    status: r.state === 'resolved' ? 'Resolved' : r.state === 'superseded' ? 'Superseded' : 'Open',
    openedAt: r.opened_at,
    resolvedAt: r.resolved_at,
    decisionSummary: r.decision_summary ?? undefined,
    openFdaRecordUrl: fdaSourceUrl(fda?.package_ndc),
    fdaDatabaseUrl: FDA_HUMAN_SHORTAGES_URL,
    disclaimer: OPENFDA_DISCLAIMER,
    temporaryChanges: changes.map((c) => ({
      id: c.id,
      description: c.description,
      status: formatReversalStatusLabel(c.state, fda?.status),
      reversalWorkItem: !isPlaceholderJiraKey(c.reversal_issue_key)
        ? c.reversal_issue_key ?? undefined
        : undefined,
      reversalWorkItemUrl: !isPlaceholderJiraKey(c.reversal_issue_key)
        ? toFullUrl(`/browse/${c.reversal_issue_key}`, siteUrl)
        : undefined,
    })),
  };
}

export async function actionDraftClinicianMessage(req: unknown) {
  await runMigrations();
  const { shortageId } = inputsOf(req);
  if (!shortageId) return { error: 'shortageId is required' };
  const shortage = await query<{
    generic_name: string;
    presentation: string;
    status: string;
    update_date: string;
    availability: string;
    related_info: string;
    company_name: string;
    package_ndc: string;
  }>(
    `SELECT generic_name, presentation, status, update_date, availability, related_info, company_name, package_ndc
     FROM shortage
     WHERE shortage_key = ?
     LIMIT 1`,
    [String(shortageId)],
  );
  const s = shortage[0];
  if (!s) return { error: `unknown shortageId ${shortageId}` };
  const [impact, past] = await Promise.all([
    actionGetShortageImpact(req),
    actionGetPastResponses({ inputs: { ingredient: s.generic_name } }),
  ]);
  return {
    disclaimer: OPENFDA_DISCLAIMER,
    note: 'Structured facts only — a person must approve any drafted message before it is sent.',
    fdaDatabaseUrl: FDA_HUMAN_SHORTAGES_URL,
    source: fdaSourceUrl(s.package_ndc),
    sourceLabel: 'openFDA record (raw data)',
    fdaFacts: s,
    impact: 'impact' in impact ? impact.impact : [],
    pastResponses: 'responses' in past ? past.responses : [],
  };
}

export async function actionCreateResponseTask(req: unknown) {
  await runMigrations();
  const { shortageId, ownerAccountId, summary } = inputsOf(req);
  if (!shortageId || !ownerAccountId || !summary) {
    return { error: 'shortageId, ownerAccountId and summary are required' };
  }
  const settings = await getSettings();
  if (!settings.responseProjectKey) {
    return { error: 'No response Jira project configured in Shortfall settings.' };
  }
  const siteUrl = await getStoredSiteUrl();
  const issue = await createJiraWorkItem(
    settings.responseProjectKey,
    String(summary),
    `Response task for drug shortage ${shortageId}. Created by Shortfall at a person's request.`,
    { assigneeAccountId: String(ownerAccountId), asUser: true },
  );
  return {
    created: true,
    jiraWorkItem: issue.key,
    url: toFullUrl(`/browse/${issue.key}`, siteUrl),
  };
}

export async function actionGetReversalChecklist(req: unknown) {
  await runMigrations();
  const { state } = inputsOf(req);
  const rawState = state ? String(state).toLowerCase() : 'pending';
  const validStates = new Set(['pending', 'open', 'reversal_open', 'reversed', 'all']);
  const filterState = validStates.has(rawState) ? rawState : 'pending';

  const params: unknown[] = [];
  let whereClause = '';
  if (filterState === 'pending') {
    // Default: surface all unreversed temporary changes (both due and reversal in progress).
    whereClause = `WHERE tc.state IN ('open', 'reversal_open')`;
  } else if (filterState !== 'all') {
    whereClause = 'WHERE tc.state = ?';
    params.push(filterState);
  }

  const [rows, siteUrl] = await Promise.all([
    query<{
      change_id: number;
      description: string;
      change_state: string;
      reversal_issue_key: string | null;
      jira_issue_key: string | null;
      shortage_key: string;
      generic_name: string | null;
      package_ndc: string | null;
      ingredient: string | null;
      fda_status: string | null;
    }>(
      `SELECT tc.id AS change_id,
              tc.description,
              tc.state AS change_state,
              tc.reversal_issue_key,
              r.jira_issue_key,
              r.shortage_key,
              s.generic_name,
              s.package_ndc,
              r.ingredient,
              s.status AS fda_status
       FROM temporary_change tc
       JOIN response r ON r.id = tc.response_id
       LEFT JOIN shortage s ON s.shortage_key = r.shortage_key
       ${whereClause}
       ORDER BY CASE WHEN s.status = 'Resolved' AND tc.state IN ('open', 'reversal_open') THEN 0 ELSE 1 END, tc.id DESC
       LIMIT 200`,
      params,
    ),
    getStoredSiteUrl(),
  ]);

  // Fetch affected Confluence pages (with resolved owners) for every shortage in the checklist.
  const shortageKeys = [...new Set(rows.map((r) => r.shortage_key).filter(Boolean))];
  const pagesByShortage = new Map<
    string,
    { title: string; url: string; owner: string | null; team: string | null }[]
  >();
  if (shortageKeys.length > 0) {
    const ph = shortageKeys.map(() => '?').join(',');
    const pageRows = await query<{
      shortage_key: string;
      title: string;
      url: string;
      owner_name: string | null;
      team_name: string | null;
      hop: number;
    }>(
      `SELECT DISTINCT shortage_key, title, url, owner_name, team_name, COALESCE(hop, 1) AS hop
       FROM impact_item
       WHERE kind = 'page' AND shortage_key IN (${ph})
       ORDER BY hop, title`,
      shortageKeys,
    );
    for (const p of pageRows) {
      const list = pagesByShortage.get(p.shortage_key) ?? [];
      list.push({
        title: p.title,
        url: toFullUrl(p.url, siteUrl) ?? p.url,
        owner: isHumanOwnerName(p.owner_name) ? p.owner_name : null,
        team: p.team_name || null,
      });
      pagesByShortage.set(p.shortage_key, list);
    }
  }

  // Fallback Confluence log page if a sample shortage has no direct page hit yet.
  let fallbackSamplePage: { title: string; url: string; owner: string | null } | null = null;
  if (rows.some((r) => isPlaceholderJiraKey(r.jira_issue_key) && !(pagesByShortage.get(r.shortage_key)?.length))) {
    const logRows = await query<{ title: string; url: string; owner_name: string | null }>(
      `SELECT DISTINCT title, url, owner_name
       FROM impact_item
       WHERE kind = 'page'
         AND (LOWER(title) LIKE '%diuretic%' OR LOWER(title) LIKE '%response log%')
       LIMIT 1`,
    );
    if (logRows[0]) {
      fallbackSamplePage = {
        title: logRows[0].title,
        url: toFullUrl(logRows[0].url, siteUrl) ?? logRows[0].url,
        owner: isHumanOwnerName(logRows[0].owner_name) ? logRows[0].owner_name : null,
      };
    }
  }

  const openFdaSources: {
    drug: string;
    packageNdc: string;
    fdaDatabaseUrl: string;
    openFdaRecordUrl: string;
    sourceLabel: string;
  }[] = [];
  const seenSources = new Set<string>();

  const items = rows.map((row) => {
    const drugName = row.generic_name ?? row.ingredient ?? row.shortage_key;
    const statusLabel = formatReversalStatusLabel(row.change_state, row.fda_status);
    const openFdaUrl = fdaSourceUrl(row.package_ndc);

    if (!seenSources.has(openFdaUrl)) {
      seenSources.add(openFdaUrl);
      openFdaSources.push({
        drug: drugName,
        packageNdc: row.package_ndc ?? '',
        fdaDatabaseUrl: FDA_HUMAN_SHORTAGES_URL,
        openFdaRecordUrl: openFdaUrl,
        sourceLabel: 'openFDA record (raw data)',
      });
    }

    const pages = pagesByShortage.get(row.shortage_key) ?? [];
    const primaryPage = pages[0] ?? fallbackSamplePage ?? undefined;
    const ownerName = primaryPage?.owner ?? 'Unassigned — pharmacy triage';
    const hasRealResponse = !isPlaceholderJiraKey(row.jira_issue_key);
    const hasRealReversal = !isPlaceholderJiraKey(row.reversal_issue_key);
    const reversalKey = hasRealReversal ? row.reversal_issue_key! : undefined;
    const reversalUrl = reversalKey ? toFullUrl(`/browse/${reversalKey}`, siteUrl) : undefined;

    const sourcePageRef = primaryPage
      ? { title: primaryPage.title, url: primaryPage.url }
      : undefined;

    const checklist = [
      {
        step: primaryPage
          ? `Remove temporary alert / restore standard protocol on "${primaryPage.title}": ${row.description}`
          : `Reverse temporary workaround: ${row.description}`,
        owner: ownerName,
        sourcePage: sourcePageRef,
        done: row.change_state === 'reversed',
      },
      {
        step: `Confirm normal pharmacy stock levels for ${drugName}${row.package_ndc ? ` (NDC ${row.package_ndc})` : ''} and verify EHR/order-set defaults are restored`,
        owner: ownerName,
        sourcePage: sourcePageRef,
        done: row.change_state === 'reversed',
      },
      {
        step: `Notify affected protocol owner (${ownerName}) that FDA supply is ${row.fda_status ?? 'Resolved'} and confirm the Confluence page shortage notice has cleared`,
        owner: ownerName,
        sourcePage: sourcePageRef,
        done: row.change_state === 'reversed',
      },
      {
        step: reversalKey
          ? `Verify completion, close Jira reversal ticket ${reversalKey}, and mark the temporary change Reversed in Shortfall`
          : 'Open a reversal Jira task and mark the temporary change Reversed in Shortfall once completed',
        owner: ownerName,
        sourcePage: sourcePageRef,
        jiraTask: reversalKey,
        jiraTaskUrl: reversalUrl,
        done: row.change_state === 'reversed',
      },
    ];

    return {
      changeId: row.change_id,
      drug: drugName,
      packageNdc: row.package_ndc ?? undefined,
      shortageId: row.shortage_key,
      fdaStatus: row.fda_status ?? 'Unknown',
      description: row.description,
      status: statusLabel,
      reversalDue: row.fda_status === 'Resolved' && row.change_state === 'open',
      reversalInProgress: row.change_state === 'reversal_open',
      ...(reversalKey ? { reversalWorkItem: reversalKey, reversalWorkItemUrl: reversalUrl } : {}),
      ...(hasRealResponse
        ? {
            responseWorkItem: row.jira_issue_key!,
            responseWorkItemUrl: toFullUrl(`/browse/${row.jira_issue_key}`, siteUrl),
          }
        : {
            isSampleData: true,
            sourceAttribution:
              'Sample hospital demonstration data (documented in Confluence; no parent Jira response ticket).',
          }),
      sourcePage: primaryPage
        ? { title: primaryPage.title, url: primaryPage.url, owner: ownerName }
        : undefined,
      affectedPages: pages.map((p) => ({
        title: p.title,
        url: p.url,
        owner: p.owner ?? 'Unassigned — pharmacy triage',
      })),
      checklist,
      fdaDatabaseUrl: FDA_HUMAN_SHORTAGES_URL,
      openFdaRecordUrl: openFdaUrl,
      openFdaSourceLabel: 'openFDA record (raw data)',
    };
  });

  return {
    disclaimer: OPENFDA_DISCLAIMER,
    fdaDatabaseUrl: FDA_HUMAN_SHORTAGES_URL,
    openFdaSources,
    items,
  };
}

export async function actionLogTemporaryChange(req: unknown) {
  await runMigrations();
  const { shortageId, description, impactItemId } = inputsOf(req);
  if (!shortageId || !description) {
    return { error: 'shortageId and description are required' };
  }
  const resp = await query<{ id: number; jira_issue_key: string | null }>(
    `SELECT id, jira_issue_key
     FROM response
     WHERE shortage_key = ?
     ORDER BY id DESC
     LIMIT 1`,
    [String(shortageId)],
  );
  const r = resp[0];
  if (!r) {
    return {
      error: `No Jira response found for shortage ${shortageId}. Open a shortage response first before logging a temporary change.`,
    };
  }
  const parsedImpactId =
    impactItemId !== undefined && impactItemId !== '' && !Number.isNaN(Number(impactItemId))
      ? Number(impactItemId)
      : null;

  const rec = await recordTemporaryChange(
    r.id,
    String(description),
    parsedImpactId,
  );

  const siteUrl = await getStoredSiteUrl();
  const placeholder = isPlaceholderJiraKey(r.jira_issue_key);
  return {
    recorded: true,
    changeId: rec.id,
    shortageId: String(shortageId),
    ...(placeholder
      ? {
          isSampleData: true,
          sourceAttribution: 'Sample hospital demonstration data (no parent Jira ticket).',
        }
      : {
          responseWorkItem: r.jira_issue_key!,
          responseWorkItemUrl: toFullUrl(`/browse/${r.jira_issue_key}`, siteUrl),
        }),
  };
}
