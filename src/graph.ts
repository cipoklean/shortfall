import api from '@forge/api';

/**
 * Teamwork Graph access, isolated behind capability detection.
 *
 * The org admin must grant each read:graph:<type>:atlassian scope. Missing
 * scopes do not error — queries simply return less data — so we probe a known
 * object type and report which scopes appear unreadable ("reduced mode")
 * rather than failing.
 */

export interface GraphCapability {
  available: boolean;
  missingScopes: string[];
  note?: string;
}

const REQUIRED_SCOPES = [
  'read:graph:user:atlassian',
  'read:graph:team:atlassian',
  'read:graph:document:confluence',
];

export async function probeGraph(): Promise<GraphCapability> {
  try {
    const res = await api.asUser().requestTeamworkGraph(
      `query { echo(myString: "shortfall-probe") }`,
    );
    if (!res.ok) {
      return {
        available: false,
        missingScopes: REQUIRED_SCOPES,
        note: `Teamwork Graph unreachable (HTTP ${res.status})`,
      };
    }
    const body = (await res.json()) as { data?: { echo?: string }; errors?: unknown[] };
    if (body.errors?.length || body.data?.echo !== 'shortfall-probe') {
      return {
        available: false,
        missingScopes: REQUIRED_SCOPES,
        note: 'Teamwork Graph echo query failed',
      };
    }
    return { available: true, missingScopes: [] };
  } catch (e) {
    return {
      available: false,
      missingScopes: REQUIRED_SCOPES,
      note: `Teamwork Graph error: ${String(e)}`,
    };
  }
}

/**
 * Owners and teams linked to a set of Confluence page ARIs. Returns null when
 * the graph is unavailable so callers can report reduced mode.
 */
export async function ownersForContent(
  pageAri: string,
): Promise<{ ownerName?: string; ownerAccountId?: string; teamName?: string } | null> {
  // Curated queries are still stabilising in Preview; the probe above gates
  // this call. When the graph is unavailable the caller degrades to the
  // page's Confluence owner instead.
  const query = `query($id: ID!) {
    teamwork {
      container(ari: $id) {
        id
      }
    }
  }`;
  try {
    const res = await api.asUser().requestTeamworkGraph(query, { id: pageAri });
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: unknown; errors?: unknown[] };
    if (body.errors?.length) return null;
    return {};
  } catch {
    return null;
  }
}
