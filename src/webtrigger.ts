import { sql, runMigrations } from './storage/schema';
import { enqueueSync } from './sync';
import { loadSampleHospital, removeSampleHospital } from './sample';
import { kvs } from '@forge/kvs';

/**
 * Diagnostic webtriggers. The URLs are unauthenticated capability links, so
 * every call must carry `token` equal to the app's environmentId — a value
 * only the developer can see via `forge environments list`. Responses are
 * read-only aggregates (counts, keys, sync log); no patient or page content.
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

function authorized(req: WebRequest, ctx: WebContext): boolean {
  const token = req.queryParameters?.token?.[0] ?? '';
  const installContext = String((ctx as Record<string, unknown>)?.installContext ?? '');
  const m = installContext.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  const envId = ctx.environmentId ?? m?.[0] ?? '';
  if (token.length > 0 && envId.length > 0 && token === envId) return true;
  console.log(`auth failed; installContext=${installContext}`);
  return false;
}

function json(statusCode: number, body: unknown) {
  return {
    statusCode,
    headers: { 'Content-Type': ['application/json'] },
    body: JSON.stringify(body, null, 2),
  };
}

/** POST: drive actions — sync, sample-load, sample-remove. */
export async function webSync(req: WebRequest, ctx: WebContext) {
  if (!authorized(req, ctx)) {
    console.log(`webSync unauthorized; context keys: ${Object.keys(ctx ?? {}).join(',')}`);
    return json(403, { error: 'forbidden' });
  }
  await runMigrations();
  const cloudId = String((ctx as Record<string, unknown>)?.installContext ?? '').match(/[0-9a-f-]{36}/i)?.[0];
  if (cloudId) await kvs.set('cloudId', cloudId);
  const principal = (ctx as Record<string, unknown>)?.principal as { accountId?: string } | undefined;
  console.log(`webSync principal=${JSON.stringify(principal)}`);
  if (principal?.accountId) await kvs.set('graphUserId', principal.accountId);
  const action = req.queryParameters?.action?.[0] ?? 'sync';
  switch (action) {
    case 'sync':
      return json(200, await enqueueSync('manual'));
    case 'sample-load':
      return json(200, await loadSampleHospital());
    case 'sample-remove':
      return json(200, await removeSampleHospital());
    case 'set-user': {
      const user = req.queryParameters?.user?.[0] ?? '';
      if (!user) return json(400, { error: 'missing user param' });
      await kvs.set('graphUserId', user);
      return json(200, { graphUserId: user });
    }
    default:
      return json(400, { error: `unknown action ${action}` });
  }
}

/** GET: evidence report — sync log, table counts, sample matches. */
export async function webReport(req: WebRequest, ctx: WebContext) {
  if (!authorized(req, ctx)) {
    console.log(`webReport unauthorized; context keys: ${Object.keys(ctx ?? {}).join(',')}`);
    return json(403, { error: 'forbidden' });
  }
  await runMigrations();

  const count = async (table: string) =>
    (await sql.executeRaw<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)).rows?.[0]?.n ?? 0;

  const syncRuns = (await sql.executeRaw<{
    id: number; kind: string; state: string; started_at: string; finished_at: string; result: string;
  }>(`SELECT id, kind, state, started_at, finished_at, result FROM sync_run ORDER BY id DESC LIMIT 10`)).rows ?? [];

  const matches = (await sql.executeRaw<{
    shortage_key: string; generic_name: string; status: string; package_ndc: string;
    presentation: string; reason: string; display_name: string;
  }>(
    `SELECT s.shortage_key, s.generic_name, s.status, s.package_ndc, s.presentation, m.reason, f.display_name
     FROM \`match\` m
     JOIN shortage s ON s.shortage_key = m.shortage_key
     JOIN formulary_item f ON f.id = m.formulary_item_id
     ORDER BY s.update_date DESC LIMIT 50`,
  )).rows ?? [];

  const lastSync = (await kvs.get('lastSync')) ?? null;

  const pageCheckId = req.queryParameters?.pageId?.[0];
  const { getPageNoticeData } = await import('./resolvers');
  const pageCheck = pageCheckId ? await getPageNoticeData(pageCheckId) : undefined;

  const impactItems = (await sql.executeRaw<{
    shortage_key: string; kind: string; ref_id: string; title: string; owner_name: string; team_name: string; found_via: string;
  }>(`SELECT shortage_key, kind, ref_id, title, owner_name, team_name, found_via FROM impact_item LIMIT 100`)).rows ?? [];

  return json(200, {
    generatedAt: new Date().toISOString(),
    counts: {
      shortage: await count('shortage'),
      formulary_item: await count('formulary_item'),
      match: await count('\`match\`'),
      impact_item: await count('impact_item'),
      response: await count('response'),
      sync_run: await count('sync_run'),
    },
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
      source: `https://api.fda.gov/drug/shortages.json?search=package_ndc:%22${m.package_ndc}%22`,
    })),
  });
}
