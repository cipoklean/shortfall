import api from '@forge/api';

/**
 * Teamwork Graph access via curated queries (Preview).
 *
 * The Teamwork Graph API is strictly user-scoped: every call uses
 * `api.asUser()` with NO arguments so it executes in the current user's
 * session (passing a userId triggers offline impersonation and fails with
 * NO_IMPERSONATION_SCOPES_DEFINED). Background workers have no user session
 * and receive AUTH_TYPE_UNAVAILABLE, which we surface cleanly as reduced mode.
 */

export interface GraphCapability {
  available: boolean;
  missingScopes: string[];
  note?: string;
  noUserContext?: boolean;
}

export interface GraphNode {
  id?: string;
  name?: string;
  displayName?: string;
  title?: string;
  url?: string;
}

const REQUIRED_SCOPES = [
  'read:graph:user:atlassian',
  'read:graph:team:atlassian',
  'read:graph:page:confluence',
];

const NO_USER_CONTEXT_NOTE =
  'Background job has no user session — click "Enrich owners" on the dashboard to query Teamwork Graph as your user.';

const MAX_RETRIES = 2;
const BASE_BACKOFF_MS = 250;

interface Connection {
  edges?: { node?: GraphNode }[];
}

interface GraphBody {
  data?: Record<string, Connection | GraphNode | null | undefined>;
  errors?: { message?: string }[];
}

function isAuthTypeUnavailable(err: unknown): boolean {
  if (!err) return false;
  const obj = err as { code?: string; name?: string; message?: string };
  return (
    obj.code === 'AUTH_TYPE_UNAVAILABLE' ||
    obj.name === 'AUTH_TYPE_UNAVAILABLE' ||
    String(err).includes('AUTH_TYPE_UNAVAILABLE')
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryAfterMs(header: string | null, attempt: number): number {
  if (header) {
    const secs = Number(header);
    if (Number.isFinite(secs) && secs >= 0) {
      return Math.min(secs * 1000, 5000);
    }
  }
  return BASE_BACKOFF_MS * 2 ** attempt;
}

async function graphQuery(
  queryStr: string,
  variables?: Record<string, unknown>,
): Promise<{ nodes: GraphNode[]; error?: string; noUserContext?: boolean }> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res =
        variables === undefined
          ? await api.asUser().requestTeamworkGraph(queryStr)
          : await api.asUser().requestTeamworkGraph(queryStr, variables);

      if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES) {
        const retryAfter = res.headers?.get?.('retry-after') ?? null;
        await sleep(parseRetryAfterMs(retryAfter, attempt));
        continue;
      }

      if (!res.ok) {
        return { nodes: [], error: `graph HTTP ${res.status}` };
      }

      const body = (await res.json()) as GraphBody;
      if (body.errors?.length) {
        return {
          nodes: [],
          error: `graph: ${body.errors.map((e) => e.message).join('; ').slice(0, 300)}`,
        };
      }

      const nodes: GraphNode[] = [];
      for (const v of Object.values(body.data ?? {})) {
        if (v && typeof v === 'object' && 'edges' in v) {
          for (const e of (v as Connection).edges ?? []) {
            if (e?.node) nodes.push(e.node);
          }
        } else if (v && typeof v === 'object' && ('id' in v || 'name' in v || 'title' in v)) {
          nodes.push(v as GraphNode);
        }
      }
      return { nodes };
    } catch (e) {
      if (isAuthTypeUnavailable(e)) {
        return { nodes: [], noUserContext: true, error: 'AUTH_TYPE_UNAVAILABLE' };
      }
      if (attempt < MAX_RETRIES) {
        await sleep(BASE_BACKOFF_MS * 2 ** attempt);
        continue;
      }
      return { nodes: [], error: `Teamwork Graph error: ${String(e).slice(0, 200)}` };
    }
  }
  return { nodes: [], error: 'Teamwork Graph: retries exhausted' };
}

/** Probe Teamwork Graph availability in the current user session. */
export async function probeGraph(): Promise<GraphCapability> {
  const res = await graphQuery('query shortfall_echoProbe { echo(myString: "shortfall-probe") }');
  if (res.noUserContext) {
    return {
      available: false,
      missingScopes: [],
      noUserContext: true,
      note: NO_USER_CONTEXT_NOTE,
    };
  }
  if (res.error) {
    return {
      available: false,
      missingScopes: REQUIRED_SCOPES,
      note: `Teamwork Graph: ${res.error}`,
    };
  }
  return { available: true, missingScopes: [] };
}

/** Users who own a Confluence page (curated query confluencePageOwners). */
export async function pageOwners(pageAri: string): Promise<{ nodes: GraphNode[]; error?: string }> {
  const { nodes, error } = await graphQuery(
    `query shortfall_pageOwners($id: ID!) {
      confluencePageOwners(id: $id, first: 10) {
        edges { node { ... on AtlassianUser { id name } } }
      }
    }`,
    { id: pageAri },
  );
  return error ? { nodes, error } : { nodes };
}

/** Fallback owner signal: the page's creator (curated query confluencePageCreator). */
export async function pageCreator(pageAri: string): Promise<{ nodes: GraphNode[]; error?: string }> {
  const { nodes, error } = await graphQuery(
    `query shortfall_pageCreator($id: ID!) {
      confluencePageCreator(id: $id) {
        ... on AtlassianUser { id name }
      }
    }`,
    { id: pageAri },
  );
  return error ? { nodes, error } : { nodes };
}

/** Teams linked to a Confluence space (curated query atlassianTeamsBySpace). */
export async function teamsForSpace(spaceAri: string): Promise<{ nodes: GraphNode[]; error?: string }> {
  const { nodes, error } = await graphQuery(
    `query shortfall_teamsBySpace($spaceAri: ID!) {
      atlassianTeamsBySpace(spaceAri: $spaceAri, first: 10) {
        edges { node { ... on AtlassianTeam { id name } } }
      }
    }`,
    { spaceAri },
  );
  return error ? { nodes, error } : { nodes };
}

/** Teams a user belongs to (curated query atlassianUserInTeams). */
export async function userTeams(userAri: string): Promise<{ nodes: GraphNode[]; error?: string }> {
  const { nodes, error } = await graphQuery(
    `query shortfall_userTeams($userId: ID!) {
      atlassianUserInTeams(userId: $userId, first: 10) {
        edges { node { ... on AtlassianTeam { id name } } }
      }
    }`,
    { userId: userAri },
  );
  return error ? { nodes, error } : { nodes };
}

/** 2nd-hop Confluence pages linked from a page (curated query confluencePageLinkedConfluencePages). */
export async function linkedPages(pageAri: string): Promise<{ nodes: GraphNode[]; error?: string }> {
  const { nodes, error } = await graphQuery(
    `query shortfall_linkedPages($id: ID!) {
      confluencePageLinkedConfluencePages(id: $id, first: 15) {
        edges { node { ... on ConfluencePage { id title } } }
      }
    }`,
    { id: pageAri },
  );
  return error ? { nodes, error } : { nodes };
}
