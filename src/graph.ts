import api from '@forge/api';

/**
 * Teamwork Graph access via curated queries (Preview). The API is user-
 * scoped only: every call goes through `api.asUser(accountId)` where the
 * accountId is captured from a live user context (dashboard resolver call)
 * and stored in KVS by sync.ts. Missing read:graph:* scopes return less
 * data without erroring, so callers report reduced mode instead.
 */

export interface GraphCapability {
  available: boolean;
  missingScopes: string[];
  note?: string;
}

const REQUIRED_SCOPES = [
  'read:graph:user:atlassian',
  'read:graph:team:atlassian',
  'read:graph:page:confluence',
];

interface GraphNode {
  id?: string;
  name?: string;
  displayName?: string;
  title?: string;
}

interface Connection {
  edges?: { node?: GraphNode }[];
}

interface GraphBody {
  data?: Record<string, Connection | GraphNode | null | undefined>;
  errors?: { message?: string }[];
}

async function graphQuery(userId: string | undefined, query: string, variables: Record<string, unknown>): Promise<{ nodes: GraphNode[]; error?: string }> {
  try {
    const res = await api.asUser(userId).requestTeamworkGraph(query, variables);
    if (!res.ok) return { nodes: [], error: `graph HTTP ${res.status}` };
    const body = (await res.json()) as GraphBody;
    if (body.errors?.length) {
      return { nodes: [], error: `graph: ${body.errors.map((e) => e.message).join('; ').slice(0, 300)}` };
    }
    const nodes: GraphNode[] = [];
    for (const v of Object.values(body.data ?? {})) {
      if (v && typeof v === 'object' && 'edges' in v) {
        for (const e of (v as Connection).edges ?? []) {
          if (e?.node) nodes.push(e.node);
        }
      } else if (v && typeof v === 'object' && ('id' in v || 'name' in v)) {
        nodes.push(v as GraphNode);
      }
    }
    return { nodes };
  } catch (e) {
    return { nodes: [], error: `Teamwork Graph error: ${String(e).slice(0, 200)}` };
  }
}

export async function probeGraph(userId?: string): Promise<GraphCapability> {
  if (!userId) {
    return {
      available: false,
      missingScopes: REQUIRED_SCOPES,
      note: 'no user identity captured yet (open the dashboard once as a site user)',
    };
  }
  const { error } = await graphQuery(userId, `query { echo(myString: "shortfall-probe") }`, {});
  if (error) {
    return { available: false, missingScopes: REQUIRED_SCOPES, note: `Teamwork Graph: ${error}` };
  }
  return { available: true, missingScopes: [] };
}

/** Users who own a Confluence page (curated query confluencePageOwners). */
export async function pageOwners(pageAri: string, userId?: string): Promise<{ nodes: GraphNode[]; error?: string }> {
  return graphQuery(
    userId,
    `query pageOwners($id: ID!) {
      confluencePageOwners(id: $id, first: 10) {
        edges { node { ... on AtlassianUser { id name } } }
      }
    }`,
    { id: pageAri },
  );
}

/** Fallback owner signal: the page's creator. */
export async function pageCreator(pageAri: string, userId?: string): Promise<{ nodes: GraphNode[]; error?: string }> {
  return graphQuery(
    userId,
    `query pageCreator($id: ID!) {
      confluencePageCreator(id: $id) {
        ... on AtlassianUser { id name }
      }
    }`,
    { id: pageAri },
  );
}

/** Teams linked to a Confluence space (curated query atlassianTeamsBySpace). */
export async function teamsForSpace(spaceAri: string, userId?: string): Promise<{ nodes: GraphNode[]; error?: string }> {
  return graphQuery(
    userId,
    `query teamsBySpace($spaceAri: ID!) {
      atlassianTeamsBySpace(spaceAri: $spaceAri, first: 10) {
        edges { node { ... on AtlassianTeam { id name } } }
      }
    }`,
    { spaceAri },
  );
}
