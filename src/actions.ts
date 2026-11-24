import { runMigrations, query } from './storage/schema';
import { getSettings } from './settings';
import { probeGraph } from './graph';
import { createJiraWorkItem, recordTemporaryChange } from './respond';
import { OPENFDA_DISCLAIMER } from './types';
import { fdaSourceUrl } from './match';

export { OPENFDA_DISCLAIMER };

type ActionInputs = Record<string, string | number | boolean | undefined>;

function inputsOf(req: unknown): ActionInputs {
  const r = req as { inputs?: ActionInputs };
  return r?.inputs ?? (req as ActionInputs) ?? {};
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
    reducedMode: await reducedMode(),
    shortages: rows.map((r) => ({
      shortageId: r.shortage_key,
      genericName: r.generic_name,
      presentation: r.presentation,
      packageNdc: r.package_ndc,
      status: r.status,
      updateDate: r.update_date,
      company: r.company_name,
      source: fdaSourceUrl(r.package_ndc),
    })),
  };
}

export async function actionGetShortageImpact(req: unknown) {
  await runMigrations();
  const { shortageId } = inputsOf(req);
  if (!shortageId) return { error: 'shortageId is required' };
  const rows = await query<{
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
  );
  return {
    reducedMode: await reducedMode(),
    impact: rows.map((r) => ({
      kind: r.kind,
      ref: r.ref_id,
      title: r.title,
      url: r.url,
      owner: r.owner_name,
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
  const rows = await query<{
    shortage_key: string;
    ingredient: string;
    jira_issue_key: string;
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
  );
  return {
    responses: rows.map((r) => ({
      shortageId: r.shortage_key,
      ingredient: r.ingredient,
      jiraWorkItem: r.jira_issue_key,
      url: r.jira_issue_key ? `/browse/${r.jira_issue_key}` : undefined,
      state: r.state,
      openedAt: r.opened_at,
      resolvedAt: r.resolved_at,
      decisionSummary: r.decision_summary ?? undefined,
    })),
  };
}

export async function actionGetResponseStatus(req: unknown) {
  await runMigrations();
  const { shortageId } = inputsOf(req);
  if (!shortageId) return { error: 'shortageId is required' };
  const resp = await query<{
    id: number;
    jira_issue_key: string;
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
  );
  const r = resp[0];
  if (!r) return { found: false, shortageId };
  const changes = await query<{
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
  );
  return {
    found: true,
    shortageId,
    jiraWorkItem: r.jira_issue_key,
    url: r.jira_issue_key ? `/browse/${r.jira_issue_key}` : undefined,
    state: r.state,
    openedAt: r.opened_at,
    resolvedAt: r.resolved_at,
    decisionSummary: r.decision_summary ?? undefined,
    temporaryChanges: changes.map((c) => ({
      id: c.id,
      description: c.description,
      state: c.state,
      reversalWorkItem: c.reversal_issue_key,
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
    source: fdaSourceUrl(s.package_ndc),
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
  const issue = await createJiraWorkItem(
    settings.responseProjectKey,
    String(summary),
    `Response task for drug shortage ${shortageId}. Created by Shortfall at a person's request.`,
    { assigneeAccountId: String(ownerAccountId), asUser: true },
  );
  return { created: true, jiraWorkItem: issue.key, url: `/browse/${issue.key}` };
}

export async function actionGetReversalChecklist(req: unknown) {
  await runMigrations();
  const { state } = inputsOf(req);
  const rawState = String(state ?? 'open').toLowerCase();
  const validStates = new Set(['open', 'reversal_open', 'reversed', 'all']);
  const filterState = validStates.has(rawState) ? rawState : 'open';

  const params: unknown[] = [];
  let whereClause = '';
  if (filterState !== 'all') {
    whereClause = 'WHERE tc.state = ?';
    params.push(filterState);
  }

  const rows = await query<{
    change_id: number;
    description: string;
    change_state: string;
    reversal_issue_key: string | null;
    jira_issue_key: string | null;
    shortage_key: string;
    generic_name: string | null;
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
            r.ingredient,
            s.status AS fda_status
     FROM temporary_change tc
     JOIN response r ON r.id = tc.response_id
     LEFT JOIN shortage s ON s.shortage_key = r.shortage_key
     ${whereClause}
     ORDER BY CASE WHEN s.status = 'Resolved' AND tc.state = 'open' THEN 0 ELSE 1 END, tc.id DESC
     LIMIT 200`,
    params,
  );

  return {
    disclaimer: OPENFDA_DISCLAIMER,
    items: rows.map((row) => ({
      changeId: row.change_id,
      description: row.description,
      changeState: row.change_state,
      reversalWorkItem: row.reversal_issue_key ?? undefined,
      responseWorkItem: row.jira_issue_key ?? undefined,
      shortageId: row.shortage_key,
      drug: row.generic_name ?? row.ingredient ?? row.shortage_key,
      fdaStatus: row.fda_status ?? 'Unknown',
      reversalDue: row.fda_status === 'Resolved' && row.change_state === 'open',
    })),
  };
}

export async function actionLogTemporaryChange(req: unknown) {
  await runMigrations();
  const { shortageId, description, impactItemId } = inputsOf(req);
  if (!shortageId || !description) {
    return { error: 'shortageId and description are required' };
  }
  const resp = await query<{ id: number; jira_issue_key: string }>(
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

  return {
    recorded: true,
    changeId: rec.id,
    shortageId: String(shortageId),
    responseWorkItem: r.jira_issue_key,
  };
}
