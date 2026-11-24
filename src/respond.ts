import api, { route } from '@forge/api';
import { kvs } from '@forge/kvs';
import type { UpdateQueryResponse } from '@forge/sql';
import { sql, query, execute } from './storage/schema';
import { getSettings } from './settings';
import { OPENFDA_DISCLAIMER } from './types';
import { fdaSourceUrl, baseIngredientName } from './match';
import { mapWithConcurrency } from './rxnav';

export const FDA_HUMAN_SHORTAGES_URL = 'https://dps.fda.gov/drugshortages';
const MAX_AUTO_RESPONSES_PER_SYNC = 15;

export interface ShortageRow {
  shortage_key: string;
  generic_name: string;
  presentation: string;
  status: string;
  package_ndc: string;
  availability: string;
  company_name: string;
  update_date: string;
}

export interface ImpactOwnerRow {
  kind: string;
  ref_id: string;
  title: string;
  url: string;
  owner_account_id: string | null;
  owner_name: string | null;
  team_name: string | null;
}

type AdfMark = { type: 'strong' } | { type: 'link'; attrs: { href: string } };
type AdfInline = { type: 'text'; text: string; marks?: AdfMark[] };
type AdfParagraph = { type: 'paragraph'; content: AdfInline[] };
type AdfListItem = { type: 'listItem'; content: AdfParagraph[] };
type AdfBulletList = { type: 'bulletList'; content: AdfListItem[] };
export type AdfDoc = {
  type: 'doc';
  version: 1;
  content: (AdfParagraph | AdfBulletList)[];
};

/** Map FDA shortage status to Jira priority. Resolved shortages never open a ticket. */
export function priorityForStatus(status?: string | null): 'High' | 'Medium' | null {
  const s = (status ?? '').trim().toLowerCase();
  if (s === 'resolved') return null;
  if (s === 'to be discontinued') return 'Medium';
  return 'High';
}

function adfText(text: string, marks?: AdfMark[]): AdfInline {
  return marks?.length ? { type: 'text', text, marks } : { type: 'text', text };
}

function adfLink(label: string, href: string): AdfInline {
  return adfText(label, [{ type: 'link', attrs: { href } }]);
}

function adfPara(...content: AdfInline[]): AdfParagraph {
  return { type: 'paragraph', content: content.length ? content : [adfText(' ')] };
}

/** Resolve relative /wiki/... or /browse/... URL against siteUrl when available. */
export function resolveSiteHref(rawUrl: string | null | undefined, siteUrl?: string): string | null {
  const u = (rawUrl ?? '').trim();
  if (!u) return null;
  if (/^https?:\/\//i.test(u)) return u;
  const base = (siteUrl ?? '').replace(/\/+$/, '');
  if (!base) return null;
  if (u.startsWith('/')) return `${base}${u}`;
  return `${base}/${u}`;
}

/** Plain-text to simple ADF helper (for tasks without custom ADF). */
export function buildAdf(text: string): AdfDoc {
  const lines = text
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0);
  const content = (lines.length ? lines : [' ']).map((line) => adfPara(adfText(line)));
  return { type: 'doc', version: 1, content };
}

function isBotOwner(ownerName?: string | null): boolean {
  const norm = (ownerName ?? '').trim().toLowerCase();
  return !norm || norm === 'shortfall';
}

/**
 * Unified full ADF description for every [Shortage] Jira response work item.
 * Includes clickable Confluence/Jira links, human-readable FDA link plus a
 * clearly labeled "openFDA record (raw data)" link, owner triage note when
 * unassigned, and the verbatim openFDA disclaimer.
 */
export function buildResponseAdf(
  s: ShortageRow,
  impacts: ImpactOwnerRow[],
  siteUrl?: string,
): AdfDoc {
  const presentationLabel = s.presentation || s.package_ndc || s.shortage_key;
  const rawApiUrl = fdaSourceUrl(s.package_ndc);
  const hasHumanOwner = impacts.some((i) => !isBotOwner(i.owner_name));

  const content: (AdfParagraph | AdfBulletList)[] = [
    adfPara(
      adfText('FDA drug shortage: ', [{ type: 'strong' }]),
      adfText(`${s.generic_name} (${presentationLabel})`),
    ),
    adfPara(
      adfText(
        `FDA status: ${s.status || 'Unknown'} | Package NDC: ${s.package_ndc || 'N/A'} | Manufacturer: ${s.company_name || 'N/A'} | Updated: ${s.update_date || 'N/A'}`,
      ),
    ),
  ];

  if (s.availability) {
    content.push(adfPara(adfText(`Availability: ${s.availability}`)));
  }

  content.push(
    adfPara(
      adfText('FDA sources: ', [{ type: 'strong' }]),
      adfLink('FDA Drug Shortages Database', FDA_HUMAN_SHORTAGES_URL),
      adfText(' · '),
      adfLink('openFDA record (raw data)', rawApiUrl),
    ),
  );

  content.push(adfPara(adfText(`Affected site items (${impacts.length}):`, [{ type: 'strong' }])));

  if (impacts.length > 0) {
    const items: AdfListItem[] = impacts.slice(0, 15).map((item) => {
      const inline: AdfInline[] = [adfText(`[${item.kind}] `)];
      const href = resolveSiteHref(item.url, siteUrl);
      if (href) {
        inline.push(adfLink(item.title, href));
      } else {
        inline.push(adfText(item.title));
      }
      if (!isBotOwner(item.owner_name)) {
        inline.push(adfText(` — owner: ${item.owner_name}`));
      }
      if (item.team_name) {
        inline.push(adfText(` [team: ${item.team_name}]`));
      }
      return { type: 'listItem', content: [adfPara(...inline)] };
    });
    if (impacts.length > 15) {
      items.push({
        type: 'listItem',
        content: [adfPara(adfText(`...and ${impacts.length - 15} more item(s) in Shortfall.`))],
      });
    }
    content.push({ type: 'bulletList', content: items });
  } else {
    content.push(adfPara(adfText('No affected pages or work items mapped yet.')));
  }

  if (!hasHumanOwner) {
    content.push(
      adfPara(
        adfText('Owner assignment note: ', [{ type: 'strong' }]),
        adfText('No human page owner was resolved automatically — left unassigned for pharmacy triage.'),
      ),
    );
  }

  content.push(
    adfPara(adfText('Disclaimer: ', [{ type: 'strong' }]), adfText(OPENFDA_DISCLAIMER)),
  );

  return { type: 'doc', version: 1, content };
}

/** Unified ADF description for [Owner Review] tasks with clickable page links. */
export function buildOwnerTaskAdf(
  s: ShortageRow,
  parentKey: string,
  ownerName: string | null,
  ownerItems: { title: string; url: string }[],
  siteUrl?: string,
): AdfDoc {
  const presentationLabel = s.presentation || s.package_ndc || s.shortage_key;
  const rawApiUrl = fdaSourceUrl(s.package_ndc);
  const parentHref = resolveSiteHref(`/browse/${parentKey}`, siteUrl);

  const content: (AdfParagraph | AdfBulletList)[] = [
    adfPara(
      adfText('Parent shortage response: ', [{ type: 'strong' }]),
      parentHref ? adfLink(parentKey, parentHref) : adfText(parentKey),
    ),
    adfPara(
      adfText(
        `FDA drug shortage: ${s.generic_name} (${presentationLabel}) | Status: ${s.status || 'Unknown'} | NDC: ${s.package_ndc || 'N/A'}`,
      ),
    ),
    adfPara(
      adfText('FDA sources: ', [{ type: 'strong' }]),
      adfLink('FDA Drug Shortages Database', FDA_HUMAN_SHORTAGES_URL),
      adfText(' · '),
      adfLink('openFDA record (raw data)', rawApiUrl),
    ),
    adfPara(
      adfText(
        ownerName
          ? `Affected item(s) associated with ${ownerName}:`
          : 'Affected item(s) needing review:',
        [{ type: 'strong' }],
      ),
    ),
  ];

  if (ownerItems.length > 0) {
    content.push({
      type: 'bulletList',
      content: ownerItems.slice(0, 10).map((item) => {
        const href = resolveSiteHref(item.url, siteUrl);
        return {
          type: 'listItem',
          content: [adfPara(href ? adfLink(item.title, href) : adfText(item.title))],
        };
      }),
    });
  }

  if (!ownerName) {
    content.push(
      adfPara(
        adfText('Owner assignment note: ', [{ type: 'strong' }]),
        adfText('No human owner resolved — left unassigned for pharmacy triage.'),
      ),
    );
  }

  content.push(
    adfPara(
      adfText('Please review affected pages/protocols and record any temporary changes in Shortfall.'),
    ),
    adfPara(adfText('Disclaimer: ', [{ type: 'strong' }]), adfText(OPENFDA_DISCLAIMER)),
  );

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

export interface CreateJiraWorkItemOpts {
  assigneeAccountId?: string | null;
  priority?: 'High' | 'Medium' | 'Low' | null;
  parentKey?: string;
  asUser?: boolean;
  descriptionAdf?: AdfDoc;
}

/**
 * Create a Jira Task. Explicitly passes `assignee: null` when no owner
 * accountId is supplied so Jira leaves the ticket Unassigned rather than
 * falling back to the project's default lead.
 */
export async function createJiraWorkItem(
  projectKey: string,
  summary: string,
  descriptionText: string,
  opts?: CreateJiraWorkItemOpts,
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
    description: opts?.descriptionAdf ?? buildAdf(fullDescription),
    issuetype: { name: 'Task' },
    // Explicit null prevents Jira from silently assigning to the project lead.
    assignee: opts?.assigneeAccountId ? { accountId: opts.assigneeAccountId } : null,
  };
  if (opts?.priority) {
    fields.priority = { name: opts.priority };
  }

  const postIssue = () =>
    client.requestJira(route`/rest/api/3/issue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields }),
    });

  let res = await postIssue();
  if (!res.ok && (res.status === 400 || res.status === 403)) {
    const errText = await res.text();
    let retried = false;
    if (opts?.assigneeAccountId && /assignee/i.test(errText)) {
      // Unassignable account -> explicitly leave unassigned (null), never project default.
      fields.assignee = null;
      retried = true;
    }
    if (opts?.priority && /priority/i.test(errText)) {
      delete fields.priority;
      retried = true;
    }
    if (retried) {
      res = await postIssue();
    } else {
      throw new Error(`Jira create failed: HTTP ${res.status} ${errText}`);
    }
  }

  if (!res.ok) {
    throw new Error(`Jira create failed: HTTP ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as { id: string; key: string };
}

/** Create a real Jira issue link (Relates) connecting an owner/reversal task to its parent response. */
export async function linkJiraIssues(
  inwardIssueKey: string,
  outwardIssueKey: string,
  opts?: { asUser?: boolean },
): Promise<boolean> {
  const client = opts?.asUser ? api.asUser() : api.asApp();
  try {
    const res = await client.requestJira(route`/rest/api/3/issueLink`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: { name: 'Relates' },
        inwardIssue: { key: inwardIssueKey },
        outwardIssue: { key: outwardIssueKey },
      }),
    });
    if (res.ok) return true;
    console.log(
      `[shortfall] issueLink ${inwardIssueKey} -> ${outwardIssueKey} failed: HTTP ${res.status}`,
    );
    return false;
  } catch (e) {
    console.log(`[shortfall] issueLink error: ${String(e).slice(0, 160)}`);
    return false;
  }
}

/**
 * Create a parent Jira response work item for a shortage and (optionally)
 * at most one [Owner Review] task per distinct real owner per ingredient,
 * linked to the parent via a real Jira issueLink. Idempotent across runs.
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

  const shortageRows = await query<ShortageRow>(
    `SELECT shortage_key, generic_name, presentation, status, package_ndc, availability, company_name, update_date
     FROM shortage WHERE shortage_key = ? LIMIT 1`,
    [shortageKey],
  );
  const s = shortageRows[0];
  if (!s) {
    return { created: false, ownerTasks: [], error: `Unknown shortage ${shortageKey}` };
  }

  const priority = priorityForStatus(s.status);
  if (!priority) {
    return {
      created: false,
      ownerTasks: [],
      error: `Shortage ${shortageKey} is Resolved — no response ticket created.`,
    };
  }

  const ingKey = baseIngredientName(s.generic_name ?? '').toLowerCase();

  // Idempotent by shortage_key AND by active open ingredient response (at most 1 per shorted ingredient).
  const existingByKey = await query<{ id: number; jira_issue_key: string }>(
    `SELECT id, jira_issue_key FROM response WHERE shortage_key = ? AND COALESCE(state, 'open') = 'open' LIMIT 1`,
    [shortageKey],
  );
  if (existingByKey.length) {
    return {
      created: false,
      alreadyExists: true,
      issueKey: existingByKey[0].jira_issue_key,
      ownerTasks: [],
    };
  }

  if (ingKey) {
    const openRows = await query<{ id: number; ingredient: string; jira_issue_key: string }>(
      `SELECT id, ingredient, jira_issue_key
       FROM response
       WHERE COALESCE(state, 'open') = 'open'
         AND jira_issue_key IS NOT NULL
         AND jira_issue_key NOT LIKE 'SAMPLE-%'
         AND jira_issue_key NOT LIKE 'HIST-%'`,
    );
    const sameIng = openRows.find(
      (r) => baseIngredientName(r.ingredient ?? '').toLowerCase() === ingKey,
    );
    if (sameIng) {
      return {
        created: false,
        alreadyExists: true,
        issueKey: sameIng.jira_issue_key,
        ownerTasks: [],
      };
    }
  }

  const [impacts, storedSiteUrl] = await Promise.all([
    query<ImpactOwnerRow>(
      `SELECT kind, ref_id, title, url, owner_account_id, owner_name, team_name
       FROM impact_item
       WHERE shortage_key = ?
         AND (kind != 'jira' OR (title NOT LIKE '[Shortage]%' AND title NOT LIKE '[Owner Review]%' AND title NOT LIKE '[Reversal]%'))
       ORDER BY COALESCE(hop, 1), kind, title`,
      [shortageKey],
    ),
    kvs.get('siteUrl') as Promise<string | undefined>,
  ]);

  const siteUrl = storedSiteUrl ? String(storedSiteUrl).replace(/\/+$/, '') : undefined;
  const presentationLabel = s.presentation || s.package_ndc || shortageKey;
  const parentSummary = `[Shortage] ${s.generic_name} — ${presentationLabel}`;
  const parentAdf = buildResponseAdf(s, impacts, siteUrl);

  let issue: { id: string; key: string };
  try {
    issue = await createJiraWorkItem(settings.responseProjectKey, parentSummary, parentSummary, {
      assigneeAccountId: null, // Parent response stays unassigned for pharmacy triage
      priority,
      asUser: opts?.asUser,
      descriptionAdf: parentAdf,
    });
  } catch (e) {
    return { created: false, ownerTasks: [], error: String(e) };
  }

  const insertRes = await sql
    .prepare<UpdateQueryResponse>(
      `INSERT INTO response (shortage_key, ingredient, jira_issue_key, jira_issue_id, state, opened_at)
       VALUES (?, ?, ?, ?, 'open', NOW())`,
    )
    .bindParams(shortageKey, s.generic_name, issue.key, issue.id)
    .execute();

  const responseId =
    extractInsertId(insertRes.rows) ??
    (
      await query<{ id: number }>(
        `SELECT id FROM response WHERE jira_issue_key = ? ORDER BY id DESC LIMIT 1`,
        [issue.key],
      )
    )[0]?.id ??
    0;

  const ownerTasks: string[] = [];
  if (opts?.createOwnerTasks !== false) {
    const byOwner = new Map<
      string,
      { ownerName: string; ownerAccountId?: string; items: { title: string; url: string }[] }
    >();
    for (const item of impacts) {
      const name = (item.owner_name ?? '').trim();
      if (isBotOwner(name)) continue;
      const acct = (item.owner_account_id ?? '').trim() || undefined;
      const ownerKey = acct ? `acct:${acct}` : `name:${name.toLowerCase()}`;
      const entry = byOwner.get(ownerKey);
      if (entry) {
        if (!entry.items.some((x) => x.title === item.title)) {
          entry.items.push({ title: item.title, url: item.url });
        }
      } else {
        byOwner.set(ownerKey, {
          ownerName: name,
          ownerAccountId: acct,
          items: [{ title: item.title, url: item.url }],
        });
      }
    }

    const effectiveIngKey = ingKey || shortageKey;
    for (const [ownerKey, owner] of byOwner.entries()) {
      // Idempotent guard: at most 1 owner task per owner per shorted ingredient.
      const existingTask = await query<{ jira_issue_key: string }>(
        `SELECT jira_issue_key FROM owner_task WHERE ingredient_key = ? AND owner_key = ? LIMIT 1`,
        [effectiveIngKey, ownerKey],
      );
      if (existingTask.length) continue;

      const ownerSummary = `[Owner Review] ${s.generic_name} — ${owner.ownerName}`;
      const ownerAdf = buildOwnerTaskAdf(s, issue.key, owner.ownerName, owner.items, siteUrl);

      try {
        const sub = await createJiraWorkItem(
          settings.responseProjectKey,
          ownerSummary,
          ownerSummary,
          {
            assigneeAccountId: owner.ownerAccountId ?? null,
            priority,
            parentKey: issue.key,
            asUser: opts?.asUser,
            descriptionAdf: ownerAdf,
          },
        );
        await linkJiraIssues(sub.key, issue.key, { asUser: opts?.asUser });
        await execute(
          `INSERT IGNORE INTO owner_task
             (response_id, ingredient_key, owner_key, owner_account_id, owner_name, jira_issue_key, jira_issue_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, NOW())`,
          [
            responseId,
            effectiveIngKey.slice(0, 256),
            ownerKey.slice(0, 128),
            owner.ownerAccountId ?? null,
            owner.ownerName.slice(0, 256),
            sub.key,
            sub.id,
          ],
        );
        ownerTasks.push(sub.key);
      } catch (e) {
        console.log(`[shortfall] owner task failed for ${owner.ownerName}: ${String(e)}`);
      }
    }
  }

  return { created: true, issueKey: issue.key, ownerTasks };
}

/**
 * Create at most one automatic Jira response (plus deduplicated per-owner
 * review tasks) per newly matched non-resolved ingredient so a multi-NDC
 * shortage never floods Jira with duplicate tickets.
 */
export async function createResponsesForNewMatches(
  newMatchedKeys: string[],
): Promise<{ created: number; ownerTasks?: number; skipped?: string; errors?: string[] }> {
  const settings = await getSettings();
  if (!settings.responseProjectKey) {
    return { created: 0, skipped: 'no response project configured' };
  }

  const openResponses = await query<{ ingredient: string }>(
    `SELECT ingredient
     FROM response
     WHERE COALESCE(state, 'open') = 'open'
       AND jira_issue_key IS NOT NULL
       AND jira_issue_key NOT LIKE 'SAMPLE-%'
       AND jira_issue_key NOT LIKE 'HIST-%'`,
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
    if (!row || !priorityForStatus(row.status)) continue;

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

/**
 * Close open responses whose match dropped out / was superseded (and no other
 * active match remains for the same ingredient), so stale false matches never
 * linger on the dashboard.
 */
export async function closeSupersededResponses(
  activeMatchedKeys: Set<string>,
): Promise<{ closed: number }> {
  const openResponses = await query<{
    id: number;
    shortage_key: string;
    ingredient: string;
    jira_issue_key: string;
  }>(
    `SELECT id, shortage_key, ingredient, jira_issue_key
     FROM response
     WHERE COALESCE(state, 'open') = 'open'
       AND jira_issue_key IS NOT NULL
       AND jira_issue_key NOT LIKE 'SAMPLE-%'
       AND jira_issue_key NOT LIKE 'HIST-%'`,
  );
  if (!openResponses.length) return { closed: 0 };

  const activeMatchedRows = await query<{ generic_name: string }>(
    `SELECT DISTINCT s.generic_name
     FROM shortage s
     JOIN \`match\` m ON m.shortage_key = s.shortage_key AND m.superseded = 0`,
  );
  const activeIngredients = new Set(
    activeMatchedRows
      .map((r) => baseIngredientName(r.generic_name ?? '').toLowerCase())
      .filter(Boolean),
  );

  let closed = 0;
  for (const resp of openResponses) {
    if (activeMatchedKeys.has(resp.shortage_key)) continue;
    const ingKey = baseIngredientName(resp.ingredient ?? '').toLowerCase();
    if (ingKey && activeIngredients.has(ingKey)) continue;
    await execute(
      `UPDATE response SET state = 'superseded', resolved_at = NOW() WHERE id = ?`,
      [resp.id],
    );
    closed++;
  }
  return { closed };
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
        {
          assigneeAccountId: null,
          priority: 'Medium',
          parentKey: response.jira_issue_key ?? undefined,
        },
      );
      if (response.jira_issue_key && !response.jira_issue_key.startsWith('SAMPLE-')) {
        await linkJiraIssues(issue.key, response.jira_issue_key);
      }
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

interface JiraSearchIssue {
  key: string;
  fields: {
    summary?: string;
    created?: string;
    status?: { name?: string };
    priority?: { name?: string };
    assignee?: { displayName?: string } | null;
    reporter?: { displayName?: string; accountType?: string; accountId?: string } | null;
  };
}

function isShortfallAppReporter(reporter?: JiraSearchIssue['fields']['reporter']): boolean {
  if (!reporter) return false;
  const name = (reporter.displayName ?? '').trim().toLowerCase();
  return reporter.accountType === 'app' || name.includes('shortfall');
}

function classifyShortfallSummary(summary?: string): 'shortage' | 'ownerReview' | 'reversal' | null {
  const s = (summary ?? '').trim();
  if (s.startsWith('[Shortage]')) return 'shortage';
  if (s.startsWith('[Owner Review]')) return 'ownerReview';
  if (s.startsWith('[Reversal]')) return 'reversal';
  return null;
}

/**
 * Safe cleanup for Shortfall-created issues in the configured response project
 * (e.g. PROC). Dry-run by default: only deletes when `confirm: true` is passed.
 * Never touches non-Shortfall issues (Purchase Requests, Corporate Credit Card, etc.).
 */
export async function cleanupShortfallProcIssues(opts: {
  confirm?: boolean;
  projectKey?: string;
  maxDeletes?: number;
} = {}): Promise<{
  dryRun: boolean;
  projectKey: string;
  totalProjectIssues: number;
  preservedOtherProcIssues: number;
  matchedCount: number;
  breakdown: { shortage: number; ownerReview: number; reversal: number };
  matchedIssues: {
    key: string;
    kind: 'shortage' | 'ownerReview' | 'reversal';
    summary: string;
    reporter: string;
    assignee: string;
    priority: string;
    created: string;
  }[];
  sqlRowsMatched: { response: number; ownerTask: number; selfImpact: number };
  deletedJiraIssues: number;
  jiraDeleteErrors: number;
  remainingToDelete: number;
  clearedSqlRows: { response: number; ownerTask: number; selfImpact: number };
}> {
  const settings = await getSettings();
  const projectKey = (opts.projectKey ?? settings.responseProjectKey ?? 'PROC').trim();
  const confirm = opts.confirm === true;
  const maxDeletes = opts.maxDeletes ?? 80;

  // Page through ALL issues in the project via Jira v3 enhanced JQL search.
  const allIssues: JiraSearchIssue[] = [];
  let nextPageToken: string | undefined;
  const jql = `project = "${projectKey}" ORDER BY created ASC`;
  for (let page = 0; page < 20; page++) {
    const res = await api.asApp().requestJira(
      nextPageToken
        ? route`/rest/api/3/search/jql?jql=${jql}&maxResults=100&fields=summary,reporter,created,status,assignee,priority&nextPageToken=${nextPageToken}`
        : route`/rest/api/3/search/jql?jql=${jql}&maxResults=100&fields=summary,reporter,created,status,assignee,priority`,
      { headers: { Accept: 'application/json' } },
    );
    if (!res.ok) {
      throw new Error(`Jira search failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    }
    const body = (await res.json()) as {
      issues?: JiraSearchIssue[];
      nextPageToken?: string;
      isLast?: boolean;
    };
    allIssues.push(...(body.issues ?? []));
    if (body.isLast || !body.nextPageToken || !(body.issues ?? []).length) break;
    nextPageToken = body.nextPageToken;
  }

  const matchedIssues: {
    key: string;
    kind: 'shortage' | 'ownerReview' | 'reversal';
    summary: string;
    reporter: string;
    assignee: string;
    priority: string;
    created: string;
  }[] = [];
  const breakdown = { shortage: 0, ownerReview: 0, reversal: 0 };

  for (const issue of allIssues) {
    const kind = classifyShortfallSummary(issue.fields?.summary);
    if (!kind) continue;
    if (!isShortfallAppReporter(issue.fields?.reporter)) continue;
    breakdown[kind]++;
    matchedIssues.push({
      key: issue.key,
      kind,
      summary: issue.fields?.summary ?? '',
      reporter: issue.fields?.reporter?.displayName ?? 'unknown',
      assignee: issue.fields?.assignee?.displayName ?? 'Unassigned',
      priority: issue.fields?.priority?.name ?? 'None',
      created: issue.fields?.created ?? '',
    });
  }

  const preservedOtherProcIssues = allIssues.length - matchedIssues.length;

  const [respRows, ownerTaskRows, selfImpactRows] = await Promise.all([
    query<{ id: number; jira_issue_key: string }>(
      `SELECT id, jira_issue_key
       FROM response
       WHERE jira_issue_key IS NOT NULL
         AND jira_issue_key LIKE ?`,
      [`${projectKey}-%`],
    ),
    query<{ id: number; jira_issue_key: string }>(
      `SELECT id, jira_issue_key FROM owner_task WHERE jira_issue_key LIKE ?`,
      [`${projectKey}-%`],
    ),
    query<{ n: number }>(
      `SELECT COUNT(*) AS n
       FROM impact_item
       WHERE kind = 'jira'
         AND (
           title LIKE '[Shortage]%'
           OR title LIKE '[Owner Review]%'
           OR title LIKE '[Reversal]%'
           OR ref_id LIKE ?
         )`,
      [`${projectKey}-%`],
    ),
  ]);

  const sqlRowsMatched = {
    response: respRows.length,
    ownerTask: ownerTaskRows.length,
    selfImpact: Number(selfImpactRows[0]?.n ?? 0),
  };

  if (!confirm) {
    return {
      dryRun: true,
      projectKey,
      totalProjectIssues: allIssues.length,
      preservedOtherProcIssues,
      matchedCount: matchedIssues.length,
      breakdown,
      matchedIssues,
      sqlRowsMatched,
      deletedJiraIssues: 0,
      jiraDeleteErrors: 0,
      remainingToDelete: matchedIssues.length,
      clearedSqlRows: { response: 0, ownerTask: 0, selfImpact: 0 },
    };
  }

  const batch = matchedIssues.slice(0, maxDeletes);
  let deletedJiraIssues = 0;
  let jiraDeleteErrors = 0;
  const deletedKeys: string[] = [];

  await mapWithConcurrency(batch, 6, async (item) => {
    try {
      const res = await api.asApp().requestJira(route`/rest/api/3/issue/${item.key}`, {
        method: 'DELETE',
        headers: { Accept: 'application/json' },
      });
      if (res.ok || res.status === 404) {
        deletedJiraIssues++;
        deletedKeys.push(item.key);
      } else {
        jiraDeleteErrors++;
      }
    } catch {
      jiraDeleteErrors++;
    }
  });

  let clearedResp = 0;
  let clearedOwner = 0;
  if (deletedKeys.length > 0) {
    const ph = deletedKeys.map(() => '?').join(',');
    const matchingResp = await query<{ id: number }>(
      `SELECT id FROM response WHERE jira_issue_key IN (${ph})`,
      deletedKeys,
    );
    clearedResp = matchingResp.length;
    if (clearedResp > 0) {
      await execute(`DELETE FROM response WHERE jira_issue_key IN (${ph})`, deletedKeys);
    }
    const matchingOwner = await query<{ id: number }>(
      `SELECT id FROM owner_task WHERE jira_issue_key IN (${ph})`,
      deletedKeys,
    );
    clearedOwner = matchingOwner.length;
    if (clearedOwner > 0) {
      await execute(`DELETE FROM owner_task WHERE jira_issue_key IN (${ph})`, deletedKeys);
    }
  }

  // Also clear any orphaned response/owner_task rows pointing at already-deleted PROC keys.
  const liveKeySet = new Set(allIssues.map((i) => i.key));
  const orphanRespIds = respRows
    .filter((r) => !liveKeySet.has(r.jira_issue_key))
    .map((r) => r.id);
  if (orphanRespIds.length > 0) {
    const ph = orphanRespIds.map(() => '?').join(',');
    await execute(`DELETE FROM response WHERE id IN (${ph})`, orphanRespIds);
    clearedResp += orphanRespIds.length;
  }
  const orphanOwnerIds = ownerTaskRows
    .filter((r) => !liveKeySet.has(r.jira_issue_key))
    .map((r) => r.id);
  if (orphanOwnerIds.length > 0) {
    const ph = orphanOwnerIds.map(() => '?').join(',');
    await execute(`DELETE FROM owner_task WHERE id IN (${ph})`, orphanOwnerIds);
    clearedOwner += orphanOwnerIds.length;
  }

  await execute(
    `DELETE FROM impact_item
     WHERE kind = 'jira'
       AND (
         title LIKE '[Shortage]%'
         OR title LIKE '[Owner Review]%'
         OR title LIKE '[Reversal]%'
         OR ref_id LIKE ?
       )`,
    [`${projectKey}-%`],
  );

  return {
    dryRun: false,
    projectKey,
    totalProjectIssues: allIssues.length,
    preservedOtherProcIssues,
    matchedCount: matchedIssues.length,
    breakdown,
    matchedIssues: batch,
    sqlRowsMatched,
    deletedJiraIssues,
    jiraDeleteErrors,
    remainingToDelete: Math.max(0, matchedIssues.length - batch.length),
    clearedSqlRows: {
      response: clearedResp,
      ownerTask: clearedOwner,
      selfImpact: sqlRowsMatched.selfImpact,
    },
  };
}
