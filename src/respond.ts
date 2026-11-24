import api, { route } from '@forge/api';
import type { UpdateQueryResponse } from '@forge/sql';
import { sql, query, execute } from './storage/schema';
import { getSettings } from './settings';
import { OPENFDA_DISCLAIMER } from './types';
import { fdaSourceUrl, baseIngredientName } from './match';
import { mapWithConcurrency } from './rxnav';

interface ShortageRow {
  shortage_key: string;
  generic_name: string;
  presentation: string;
  status: string;
  package_ndc: string;
  availability: string;
  company_name: string;
  update_date: string;
}

interface ImpactOwnerRow {
  kind: string;
  ref_id: string;
  title: string;
  url: string;
  owner_account_id: string | null;
  owner_name: string | null;
  team_name: string | null;
}

function buildAdf(text: string) {
  const lines = text
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0);
  const content = (lines.length ? lines : ['']).map((line) => ({
    type: 'paragraph',
    content: [{ type: 'text', text: line }],
  }));
  return { type: 'doc', version: 1, content };
}

function extractInsertId(rows: unknown): number | undefined {
  if (!rows) return undefined;
  if (Array.isArray(rows)) {
    const first = rows[0] as { insertId?: number } | undefined;
    return first?.insertId;
  }
  return (rows as { insertId?: number }).insertId;
}

export async function createJiraWorkItem(
  projectKey: string,
  summary: string,
  descriptionText: string,
  opts?: { assigneeAccountId?: string; parentKey?: string; asUser?: boolean },
): Promise<{ id: string; key: string }> {
  const client = opts?.asUser ? api.asUser() : api.asApp();
  const safeSummary = summary.replace(/\s+/g, ' ').trim().slice(0, 240);
  const fullDescription =
    opts?.parentKey && !descriptionText.includes(opts.parentKey)
      ? `${descriptionText}\n\nRelated shortage response: ${opts.parentKey}`
      : descriptionText;

  const fields: Record<string, unknown> = {
    project: { key: projectKey },
    summary: safeSummary,
    description: buildAdf(fullDescription),
    issuetype: { name: 'Task' },
  };
  if (opts?.assigneeAccountId) {
    fields.assignee = { accountId: opts.assigneeAccountId };
  }

  const postIssue = () =>
    client.requestJira(route`/rest/api/3/issue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields }),
    });

  let res = await postIssue();
  if (!res.ok && opts?.assigneeAccountId && (res.status === 400 || res.status === 403)) {
    // Graceful retry without assignee if the account is unassignable in this project.
    delete fields.assignee;
    res = await postIssue();
  }

  if (!res.ok) {
    throw new Error(`Jira create failed: HTTP ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as { id: string; key: string };
}

function isBotOwner(ownerName: string): boolean {
  const norm = ownerName.trim().toLowerCase();
  return !norm || norm === 'shortfall';
}

/**
 * Create a parent Jira response work item for a shortage and (optionally)
 * one [Owner Review] task per distinct affected content owner. Idempotent.
 */
export async function createResponseForShortage(
  shortageKey: string,
  opts?: { createOwnerTasks?: boolean; asUser?: boolean },
): Promise<{
  created: boolean;
  alreadyExists?: boolean;
  issueKey?: string;
  ownerTasks: string[];
  error?: string;
}> {
  const settings = await getSettings();
  if (!settings.responseProjectKey) {
    return {
      created: false,
      ownerTasks: [],
      error: 'No response Jira project configured in Shortfall settings.',
    };
  }

  const existing = await query<{ id: number; jira_issue_key: string }>(
    `SELECT id, jira_issue_key FROM response WHERE shortage_key = ? LIMIT 1`,
    [shortageKey],
  );
  if (existing.length) {
    return {
      created: false,
      alreadyExists: true,
      issueKey: existing[0].jira_issue_key,
      ownerTasks: [],
    };
  }

  const shortageRows = await query<ShortageRow>(
    `SELECT shortage_key, generic_name, presentation, status, package_ndc, availability, company_name, update_date
     FROM shortage WHERE shortage_key = ? LIMIT 1`,
    [shortageKey],
  );
  const s = shortageRows[0];
  if (!s) {
    return { created: false, ownerTasks: [], error: `Unknown shortage ${shortageKey}` };
  }

  const impacts = await query<ImpactOwnerRow>(
    `SELECT kind, ref_id, title, url, owner_account_id, owner_name, team_name
     FROM impact_item WHERE shortage_key = ? ORDER BY hop, kind, title`,
    [shortageKey],
  );

  const sourceUrl = fdaSourceUrl(s.package_ndc);
  const impactLines = impacts.slice(0, 15).map((item) => {
    const owner = item.owner_name && !isBotOwner(item.owner_name) ? ` (owner: ${item.owner_name})` : '';
    const team = item.team_name ? ` [team: ${item.team_name}]` : '';
    return `- [${item.kind}] ${item.title}${owner}${team}`;
  });
  const moreLine =
    impacts.length > 15 ? `- ...and ${impacts.length - 15} more item(s) in Shortfall.` : '';

  const presentationLabel = s.presentation || s.package_ndc || shortageKey;
  const parentSummary = `[Shortage] ${s.generic_name} — ${presentationLabel}`;
  const parentDescription = [
    `FDA drug shortage: ${s.generic_name} (${presentationLabel}).`,
    `FDA status: ${s.status || 'Unknown'} | Package NDC: ${s.package_ndc || 'N/A'} | Manufacturer: ${s.company_name || 'N/A'} | Updated: ${s.update_date || 'N/A'}`,
    s.availability ? `Availability: ${s.availability}` : '',
    `FDA source: ${sourceUrl}`,
    '',
    `Affected site items (${impacts.length}):`,
    ...(impactLines.length ? impactLines : ['- No affected pages or work items mapped yet.']),
    moreLine,
    '',
    `Disclaimer: ${OPENFDA_DISCLAIMER}`,
  ]
    .filter((line) => line !== undefined)
    .join('\n');

  let issue: { id: string; key: string };
  try {
    issue = await createJiraWorkItem(
      settings.responseProjectKey,
      parentSummary,
      parentDescription,
      { asUser: opts?.asUser },
    );
  } catch (e) {
    return { created: false, ownerTasks: [], error: String(e) };
  }

  await execute(
    `INSERT INTO response (shortage_key, ingredient, jira_issue_key, jira_issue_id, state, opened_at)
     VALUES (?, ?, ?, ?, 'open', NOW())`,
    [shortageKey, s.generic_name, issue.key, issue.id],
  );

  const ownerTasks: string[] = [];
  if (opts?.createOwnerTasks !== false) {
    const byOwner = new Map<
      string,
      { ownerName: string; ownerAccountId?: string; titles: string[] }
    >();
    for (const item of impacts) {
      const name = (item.owner_name ?? '').trim();
      if (isBotOwner(name)) continue;
      const acct = (item.owner_account_id ?? '').trim() || undefined;
      const ownerKey = acct ? `acct:${acct}` : `name:${name.toLowerCase()}`;
      const entry = byOwner.get(ownerKey);
      if (entry) {
        if (!entry.titles.includes(item.title)) entry.titles.push(item.title);
      } else {
        byOwner.set(ownerKey, { ownerName: name, ownerAccountId: acct, titles: [item.title] });
      }
    }

    for (const owner of byOwner.values()) {
      const ownerSummary = `[Owner Review] ${s.generic_name} — ${owner.ownerName}`;
      const ownerDescription = [
        `Parent shortage response: ${issue.key}`,
        `FDA drug shortage: ${s.generic_name} (${presentationLabel}), status: ${s.status || 'Unknown'}, NDC: ${s.package_ndc || 'N/A'}.`,
        `FDA source: ${sourceUrl}`,
        '',
        `Affected item(s) associated with ${owner.ownerName}:`,
        ...owner.titles.slice(0, 10).map((t) => `- ${t}`),
        '',
        'Please review affected pages/protocols and record any temporary changes in Shortfall.',
        `Disclaimer: ${OPENFDA_DISCLAIMER}`,
      ].join('\n');

      try {
        const sub = await createJiraWorkItem(
          settings.responseProjectKey,
          ownerSummary,
          ownerDescription,
          {
            assigneeAccountId: owner.ownerAccountId,
            parentKey: issue.key,
            asUser: opts?.asUser,
          },
        );
        ownerTasks.push(sub.key);
      } catch (e) {
        console.log(`[shortfall] owner task failed for ${owner.ownerName}: ${String(e)}`);
      }
    }
  }

  return { created: true, issueKey: issue.key, ownerTasks };
}

const MAX_AUTO_RESPONSES_PER_SYNC = 15;

/**
 * Create at most one automatic Jira response (plus per-owner review tasks)
 * per newly matched non-resolved ingredient so a multi-manufacturer shortage
 * (e.g. 27 rocuronium NDCs) does not flood Jira with duplicate tickets, while
 * keeping every NDC presentation distinct in storage and the UI.
 */
export async function createResponsesForNewMatches(
  newMatchedKeys: string[],
): Promise<{ created: number; ownerTasks?: number; skipped?: string; errors?: string[] }> {
  const settings = await getSettings();
  if (!settings.responseProjectKey) {
    return { created: 0, skipped: 'no response project configured' };
  }

  const openResponses = await query<{ ingredient: string }>(
    `SELECT ingredient FROM response WHERE COALESCE(state, 'open') != 'resolved'`,
  );
  const coveredIngredients = new Set(
    openResponses
      .map((r) => baseIngredientName(r.ingredient ?? '').toLowerCase())
      .filter(Boolean),
  );

  const errors: string[] = [];
  let created = 0;
  let ownerTasks = 0;
  const uniqueKeys = [...new Set(newMatchedKeys)];

  for (const key of uniqueKeys) {
    if (created >= MAX_AUTO_RESPONSES_PER_SYNC) break;
    const rows = await query<{ status: string; generic_name: string }>(
      `SELECT status, generic_name FROM shortage WHERE shortage_key = ? LIMIT 1`,
      [key],
    );
    const row = rows[0];
    if (!row || !row.status || row.status === 'Resolved') continue;

    const ingKey = baseIngredientName(row.generic_name ?? '').toLowerCase();
    if (ingKey && coveredIngredients.has(ingKey)) continue;

    const res = await createResponseForShortage(key);
    if (res.created) {
      created++;
      ownerTasks += res.ownerTasks.length;
      if (ingKey) coveredIngredients.add(ingKey);
    } else if (res.error) {
      errors.push(`${key}: ${res.error}`);
    }
  }

  return {
    created,
    ownerTasks,
    errors: errors.length ? errors : undefined,
  };
}

/** Record a temporary mitigation change linked to a shortage response. */
export async function recordTemporaryChange(
  responseId: number,
  description: string,
  impactItemId?: number | null,
): Promise<{ id: number }> {
  const res = await sql
    .prepare<UpdateQueryResponse>(
      `INSERT INTO temporary_change (response_id, description, impact_item_id, state, created_at)
       VALUES (?, ?, ?, 'open', NOW())`,
    )
    .bindParams(responseId, description.slice(0, 1024), impactItemId ?? null)
    .execute();

  await execute(`UPDATE response SET reversal_needed = 1 WHERE id = ?`, [responseId]);

  const insertId = extractInsertId(res.rows);
  if (insertId) return { id: insertId };

  const lookup = await query<{ id: number }>(
    `SELECT id FROM temporary_change WHERE response_id = ? ORDER BY id DESC LIMIT 1`,
    [responseId],
  );
  return { id: lookup[0]?.id ?? 0 };
}

/** Mark a temporary change as reversed after clinical confirmation. */
export async function markTemporaryChangeReversed(changeId: number): Promise<void> {
  await execute(
    `UPDATE temporary_change SET state = 'reversed', reversed_at = NOW() WHERE id = ?`,
    [changeId],
  );
}

async function processReversalsForResponse(
  response: { id: number; shortage_key: string; jira_issue_key: string | null },
  projectKey: string,
  errors: string[],
): Promise<number> {
  let opened = 0;
  const changes = await query<{ id: number; description: string }>(
    `SELECT id, description FROM temporary_change WHERE response_id = ? AND state = 'open'`,
    [response.id],
  );

  for (const change of changes) {
    try {
      const issue = await createJiraWorkItem(
        projectKey,
        `[Reversal] ${change.description}`,
        [
          'The related shortage is marked Resolved on the FDA drug shortages list.',
          `Temporary change to reverse: ${change.description}`,
          response.jira_issue_key ? `Original shortage response: ${response.jira_issue_key}` : '',
          'Confirm reversal and verify the Confluence page notice has cleared.',
          '',
          `Disclaimer: ${OPENFDA_DISCLAIMER}`,
        ]
          .filter(Boolean)
          .join('\n'),
        { parentKey: response.jira_issue_key ?? undefined },
      );
      await execute(
        `UPDATE temporary_change SET reversal_issue_key = ?, state = 'reversal_open' WHERE id = ?`,
        [issue.key, change.id],
      );
      opened++;
    } catch (e) {
      errors.push(`${response.shortage_key}/${change.id}: ${String(e)}`);
    }
  }

  await execute(
    `UPDATE response SET state = 'resolved', resolved_at = NOW(), reversal_needed = 0 WHERE id = ?`,
    [response.id],
  );
  return opened;
}

/**
 * When FDA marks a shortage resolved during sync, open one reversal task per
 * open temporary change and mark the response resolved.
 */
export async function openReversalTasks(
  resolvedKeys: string[],
): Promise<{ opened: number; errors?: string[] }> {
  const settings = await getSettings();
  if (!settings.responseProjectKey || !settings.autoCreateResponses) {
    return { opened: 0 };
  }

  const errors: string[] = [];
  let opened = 0;

  for (const key of resolvedKeys) {
    const responses = await query<{ id: number; shortage_key: string; jira_issue_key: string | null }>(
      `SELECT id, shortage_key, jira_issue_key FROM response WHERE shortage_key = ?`,
      [key],
    );
    for (const resp of responses) {
      opened += await processReversalsForResponse(resp, settings.responseProjectKey, errors);
    }
  }

  return { opened, errors: errors.length ? errors : undefined };
}

/**
 * Check all responses whose shortage is currently Resolved on the FDA list
 * and still have open temporary changes, opening [Reversal] Jira tasks for them.
 * Can be invoked manually by a user even when autoCreateResponses is off.
 */
export async function openReversalTasksForResolvedResponses(): Promise<{
  opened: number;
  errors?: string[];
}> {
  const settings = await getSettings();
  if (!settings.responseProjectKey) {
    return { opened: 0, errors: ['No response Jira project configured in Shortfall settings.'] };
  }

  const responses = await query<{ id: number; shortage_key: string; jira_issue_key: string | null }>(
    `SELECT DISTINCT r.id, r.shortage_key, r.jira_issue_key
     FROM response r
     JOIN shortage s ON s.shortage_key = r.shortage_key
     JOIN temporary_change tc ON tc.response_id = r.id
     WHERE s.status = 'Resolved' AND tc.state = 'open'`,
  );

  const errors: string[] = [];
  let opened = 0;

  for (const resp of responses) {
    opened += await processReversalsForResponse(resp, settings.responseProjectKey, errors);
  }

  return { opened, errors: errors.length ? errors : undefined };
}

/**
 * Safe, idempotent cleanup for duplicate open Jira shortage responses (e.g.
 * from an earlier run before the per-ingredient cap). Keeps at most one open
 * Jira response per distinct base ingredient, skips any response that has
 * temporary_change rows attached, deletes duplicate Jira issues in the
 * response project, and purges self-referential Jira rows from impact_item.
 */
export async function cleanupDuplicateResponses(opts: { maxDeletes?: number } = {}): Promise<{
  kept: { ingredient: string; jiraIssueKey: string; shortageKey: string }[];
  removedDbRows: number;
  deletedJiraIssues: number;
  jiraDeleteErrors: number;
  remainingDuplicates: number;
  cleanedSelfImpactRows: number;
  remainingOpenResponses: number;
  jiraProjectShortageCount: number | null;
}> {
  const settings = await getSettings();
  const maxDeletes = opts.maxDeletes ?? 80;

  const openRows = await query<{
    id: number;
    shortage_key: string;
    ingredient: string;
    jira_issue_key: string;
    shortage_exists: number;
    temp_count: number;
  }>(
    `SELECT r.id,
            r.shortage_key,
            r.ingredient,
            r.jira_issue_key,
            CASE WHEN s.shortage_key IS NOT NULL THEN 1 ELSE 0 END AS shortage_exists,
            (SELECT COUNT(*) FROM temporary_change tc WHERE tc.response_id = r.id) AS temp_count
     FROM response r
     LEFT JOIN shortage s ON s.shortage_key = r.shortage_key
     WHERE COALESCE(r.state, 'open') != 'resolved'
       AND r.jira_issue_key IS NOT NULL
       AND r.jira_issue_key NOT LIKE 'SAMPLE-%'
       AND r.jira_issue_key NOT LIKE 'HIST-%'
     ORDER BY shortage_exists DESC, r.id ASC`,
  );

  // Group by normalized base ingredient; keep 1 primary open response per
  // currently-matched ingredient. Orphaned responses (not matching any current
  // shortage row) without temporary changes are also cleaned up.
  const keptMap = new Map<string, (typeof openRows)[number]>();
  const duplicates: (typeof openRows)[number][] = [];

  for (const row of openRows) {
    if (Number(row.temp_count) > 0) {
      const ingKey = baseIngredientName(row.ingredient ?? '').toLowerCase() || `id:${row.id}`;
      if (!keptMap.has(ingKey)) keptMap.set(ingKey, row);
      continue;
    }
    if (Number(row.shortage_exists) === 0) {
      duplicates.push(row);
      continue;
    }
    const ingKey = baseIngredientName(row.ingredient ?? '').toLowerCase() || `id:${row.id}`;
    if (!keptMap.has(ingKey)) {
      keptMap.set(ingKey, row);
      continue;
    }
    duplicates.push(row);
  }

  const batch = duplicates.slice(0, maxDeletes);
  let deletedJiraIssues = 0;
  let jiraDeleteErrors = 0;
  let removedDbRows = 0;

  await mapWithConcurrency(batch, 6, async (dup) => {
    const key = dup.jira_issue_key;
    let jiraOk = false;
    try {
      const res = await api.asApp().requestJira(route`/rest/api/3/issue/${key}`, {
        method: 'DELETE',
        headers: { Accept: 'application/json' },
      });
      if (res.ok || res.status === 404) {
        deletedJiraIssues++;
        jiraOk = true;
      } else {
        jiraDeleteErrors++;
      }
    } catch {
      jiraDeleteErrors++;
    }
    if (jiraOk) {
      await execute(`DELETE FROM response WHERE id = ?`, [dup.id]);
      removedDbRows++;
    }
  });

  // Clean up any self-referential Jira impact items (Shortfall's own [Shortage] tickets).
  const beforeSelf = (
    await query<{ n: number }>(
      `SELECT COUNT(*) AS n
       FROM impact_item
       WHERE kind = 'jira'
         AND (
           title LIKE '[Shortage]%'
           OR title LIKE '[Owner Review]%'
           OR title LIKE '[Reversal]%'
           OR ref_id IN (SELECT jira_issue_key FROM response WHERE jira_issue_key IS NOT NULL)
           ${settings.responseProjectKey ? 'OR ref_id LIKE ?' : ''}
         )`,
      settings.responseProjectKey ? [`${settings.responseProjectKey}-%`] : [],
    )
  )[0]?.n ?? 0;

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
    await execute(`DELETE FROM impact_item WHERE kind = 'jira' AND ref_id LIKE ?`, [
      `${settings.responseProjectKey}-%`,
    ]);
  }

  const remainingRows = await query<{ n: number }>(
    `SELECT COUNT(*) AS n
     FROM response r
     LEFT JOIN shortage s ON s.shortage_key = r.shortage_key
     WHERE COALESCE(r.state, 'open') != 'resolved'
       AND r.jira_issue_key NOT LIKE 'SAMPLE-%'
       AND r.jira_issue_key NOT LIKE 'HIST-%'
       AND COALESCE(s.status, 'Current') != 'Resolved'`,
  );

  // Confirm live Jira project count of open [Shortage] work items.
  let jiraProjectShortageCount: number | null = null;
  if (settings.responseProjectKey) {
    try {
      const jql = `project = "${settings.responseProjectKey}" AND summary ~ "Shortage" AND statusCategory != Done`;
      const res = await api.asApp().requestJira(
        route`/rest/api/3/search/jql?jql=${jql}&maxResults=100&fields=summary`,
        { headers: { Accept: 'application/json' } },
      );
      if (res.ok) {
        const body = (await res.json()) as {
          issues?: { fields?: { summary?: string } }[];
        };
        jiraProjectShortageCount = (body.issues ?? []).filter((i) =>
          (i.fields?.summary ?? '').trim().startsWith('[Shortage]'),
        ).length;
      }
    } catch {
      jiraProjectShortageCount = null;
    }
  }

  return {
    kept: [...keptMap.entries()].map(([ingredient, r]) => ({
      ingredient,
      jiraIssueKey: r.jira_issue_key,
      shortageKey: r.shortage_key,
    })),
    removedDbRows,
    deletedJiraIssues,
    jiraDeleteErrors,
    remainingDuplicates: Math.max(0, duplicates.length - batch.length),
    cleanedSelfImpactRows: Number(beforeSelf),
    remainingOpenResponses: Number(remainingRows[0]?.n ?? 0),
    jiraProjectShortageCount,
  };
}
