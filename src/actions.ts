import { sql, runMigrations } from './storage/schema';
import { getSettings } from './settings';
import { probeGraph } from './graph';
import { createJiraWorkItem } from './respond';

/** openFDA disclaimer — repeated wherever FDA data is returned. */
export const OPENFDA_DISCLAIMER =
  'Do not rely on openFDA to make decisions regarding medical care. While we make every effort to ensure that data is accurate, you should assume all results are unvalidated. We may limit or otherwise restrict your access to the API in line with our Terms of Service.';

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
  const filter = ingredient
    ? `AND LOWER(generic_name) LIKE '%${String(ingredient).toLowerCase().replace(/'/g, "''")}%'`
    : '';
  const rows = await sql.executeRaw<{
    shortage_key: string; generic_name: string; presentation: string;
    package_ndc: string; status: string; update_date: string; company_name: string;
  }>(
    `SELECT s.shortage_key, s.generic_name, s.presentation, s.package_ndc, s.status, s.update_date, s.company_name
     FROM shortage s JOIN \`match\` m ON m.shortage_key = s.shortage_key
     WHERE s.status = 'Current' ${filter}
     ORDER BY s.update_date DESC LIMIT 200`,
  );
  return {
    disclaimer: OPENFDA_DISCLAIMER,
    reducedMode: await reducedMode(),
    shortages: (rows.rows ?? []).map((r) => ({
      shortageId: r.shortage_key,
      genericName: r.generic_name,
      presentation: r.presentation,
      packageNdc: r.package_ndc,
      status: r.status,
      updateDate: r.update_date,
      company: r.company_name,
      source: `https://dps.fda.gov/drugshortages`,
    })),
  };
}

export async function actionGetShortageImpact(req: unknown) {
  await runMigrations();
  const { shortageId } = inputsOf(req);
  if (!shortageId) return { error: 'shortageId is required' };
  const rows = await sql.executeRaw<{
    kind: string; ref_id: string; title: string; url: string;
    owner_name: string; team_name: string; found_via: string;
  }>(
    `SELECT kind, ref_id, title, url, owner_name, team_name, found_via
     FROM impact_item WHERE shortage_key = '${String(shortageId).replace(/'/g, "''")}'
     ORDER BY kind, title`,
  );
  return {
    reducedMode: await reducedMode(),
    impact: (rows.rows ?? []).map((r) => ({
      kind: r.kind,
      ref: r.ref_id,
      title: r.title,
      url: r.url,
      owner: r.owner_name,
      team: r.team_name,
      foundVia: r.found_via,
    })),
  };
}

export async function actionGetPastResponses(req: unknown) {
  await runMigrations();
  const { ingredient } = inputsOf(req);
  if (!ingredient) return { error: 'ingredient is required' };
  const rows = await sql.executeRaw<{
    shortage_key: string; ingredient: string; jira_issue_key: string;
    state: string; opened_at: string; resolved_at: string;
  }>(
    `SELECT shortage_key, ingredient, jira_issue_key, state, opened_at, resolved_at
     FROM response
     WHERE LOWER(ingredient) LIKE '%${String(ingredient).toLowerCase().replace(/'/g, "''")}%'
     ORDER BY opened_at DESC LIMIT 50`,
  );
  return {
    responses: (rows.rows ?? []).map((r) => ({
      shortageId: r.shortage_key,
      ingredient: r.ingredient,
      jiraWorkItem: r.jira_issue_key,
      url: r.jira_issue_key ? `/browse/${r.jira_issue_key}` : undefined,
      state: r.state,
      openedAt: r.opened_at,
      resolvedAt: r.resolved_at,
    })),
  };
}

export async function actionGetResponseStatus(req: unknown) {
  await runMigrations();
  const { shortageId } = inputsOf(req);
  if (!shortageId) return { error: 'shortageId is required' };
  const resp = await sql.executeRaw<{
    id: number; jira_issue_key: string; state: string; opened_at: string; resolved_at: string;
  }>(
    `SELECT id, jira_issue_key, state, opened_at, resolved_at FROM response
     WHERE shortage_key = '${String(shortageId).replace(/'/g, "''")}' LIMIT 1`,
  );
  const r = resp.rows?.[0];
  if (!r) return { found: false, shortageId };
  const changes = await sql.executeRaw<{
    id: number; description: string; state: string; reversal_issue_key: string;
  }>(`SELECT id, description, state, reversal_issue_key FROM temporary_change WHERE response_id = ${r.id}`);
  return {
    found: true,
    shortageId,
    jiraWorkItem: r.jira_issue_key,
    url: `/browse/${r.jira_issue_key}`,
    state: r.state,
    openedAt: r.opened_at,
    resolvedAt: r.resolved_at,
    temporaryChanges: (changes.rows ?? []).map((c) => ({
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
  const shortage = await sql.executeRaw<{
    generic_name: string; presentation: string; status: string; update_date: string;
    availability: string; related_info: string; company_name: string; package_ndc: string;
  }>(
    `SELECT generic_name, presentation, status, update_date, availability, related_info, company_name, package_ndc
     FROM shortage WHERE shortage_key = '${String(shortageId).replace(/'/g, "''")}' LIMIT 1`,
  );
  const s = shortage.rows?.[0];
  if (!s) return { error: `unknown shortageId ${shortageId}` };
  const [impact, past] = await Promise.all([
    actionGetShortageImpact(req),
    actionGetPastResponses({ inputs: { ingredient: s.generic_name } }),
  ]);
  return {
    disclaimer: OPENFDA_DISCLAIMER,
    note: 'Structured facts only — a person must approve any drafted message before it is sent.',
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
  );
  return { created: true, jiraWorkItem: issue.key, url: `/browse/${issue.key}` };
}
