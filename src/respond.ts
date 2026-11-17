import api, { route } from '@forge/api';
import { sql } from './storage/schema';
import { getSettings } from './settings';

interface ShortageFacts {
  key: string;
  genericName: string;
  presentation: string;
  status: string;
  impactCount: number;
}

async function shortageFacts(key: string): Promise<ShortageFacts | null> {
  const rows = await sql.executeRaw<{ generic_name: string; presentation: string; status: string }>(
    `SELECT generic_name, presentation, status FROM shortage WHERE shortage_key = '${key}'`,
  );
  const r = rows.rows?.[0];
  if (!r) return null;
  const impact = await sql.executeRaw<{ n: number }>(
    `SELECT COUNT(*) AS n FROM impact_item WHERE shortage_key = '${key}'`,
  );
  return { key, genericName: r.generic_name, presentation: r.presentation, status: r.status, impactCount: impact.rows?.[0]?.n ?? 0 };
}

export async function createJiraWorkItem(projectKey: string, summary: string, descriptionText: string) {
  const res = await api.asApp().requestJira(route`/rest/api/3/issue`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fields: {
        project: { key: projectKey },
        summary,
        description: {
          type: 'doc', version: 1,
          content: [{ type: 'paragraph', content: [{ type: 'text', text: descriptionText }] }],
        },
        issuetype: { name: 'Task' },
      },
    }),
  });
  if (!res.ok) throw new Error(`Jira create failed: HTTP ${res.status} ${await res.text()}`);
  return (await res.json()) as { id: string; key: string };
}

/**
 * Create one Jira work item per newly matched shortage, listing the impact
 * map. Only called when the admin enabled automatic creation in settings.
 */
export async function createResponsesForNewMatches(
  newShortageKeys: string[],
): Promise<{ created: number; skipped?: string; errors?: string[] }> {
  const settings = await getSettings();
  if (!settings.responseProjectKey) return { created: 0, skipped: 'no response project configured' };
  const errors: string[] = [];
  let created = 0;

  for (const key of newShortageKeys) {
    const facts = await shortageFacts(key);
    if (!facts || facts.status === 'Resolved') continue;
    const existing = await sql.executeRaw<{ id: number }>(
      `SELECT id FROM response WHERE shortage_key = '${key}' LIMIT 1`,
    );
    if (existing.rows?.length) continue; // idempotent
    try {
      const issue = await createJiraWorkItem(
        settings.responseProjectKey,
        `[Shortage] ${facts.genericName} — ${facts.presentation}`,
        `FDA drug shortage: ${facts.genericName} (${facts.presentation}). ${facts.impactCount} site item(s) name this drug. Details in the Shortfall panel.`,
      );
      await sql.executeRaw(
        `INSERT INTO response (shortage_key, ingredient, jira_issue_key, jira_issue_id, state, opened_at)
         VALUES ('${key}', '${facts.genericName.replace(/'/g, "''")}', '${issue.key}', '${issue.id}', 'open', NOW())`,
      );
      created++;
    } catch (e) {
      errors.push(`${key}: ${String(e)}`);
    }
  }
  return { created, errors: errors.length ? errors : undefined };
}

/**
 * When FDA marks a shortage resolved, open one reversal task per temporary
 * change and let the page notices clear via the byline resolver.
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
    const resp = await sql.executeRaw<{ id: number; jira_issue_key: string }>(
      `SELECT id, jira_issue_key FROM response WHERE shortage_key = '${key}'`,
    );
    const responseId = resp.rows?.[0]?.id;
    if (!responseId) continue;
    const changes = await sql.executeRaw<{ id: number; description: string }>(
      `SELECT id, description FROM temporary_change WHERE response_id = ${responseId} AND state = 'open'`,
    );
    for (const change of changes.rows ?? []) {
      try {
        const issue = await createJiraWorkItem(
          settings.responseProjectKey,
          `[Reversal] ${change.description}`,
          `The related shortage is resolved on the FDA list. Reverse this temporary change and confirm the page notice cleared.`,
        );
        await sql.executeRaw(
          `UPDATE temporary_change SET reversal_issue_key = '${issue.key}', state = 'reversal_open' WHERE id = ${change.id}`,
        );
        opened++;
      } catch (e) {
        errors.push(`${key}/${change.id}: ${String(e)}`);
      }
    }
    await sql.executeRaw(
      `UPDATE response SET state = 'resolved', resolved_at = NOW(), reversal_needed = 0 WHERE id = ${responseId}`,
    );
  }
  return { opened, errors: errors.length ? errors : undefined };
}
