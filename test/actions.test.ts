import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OPENFDA_DISCLAIMER } from '../src/types';

interface MockActionState {
  reversalRows: {
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
  }[];
  impactPages: {
    shortage_key: string;
    title: string;
    url: string;
    owner_name: string | null;
    team_name: string | null;
  }[];
  pastResponseRows: {
    shortage_key: string;
    ingredient: string;
    jira_issue_key: string | null;
    state: string;
    opened_at: string;
    resolved_at: string;
    decision_summary: string | null;
  }[];
}

const mockActionState: MockActionState = {
  reversalRows: [],
  impactPages: [],
  pastResponseRows: [],
};

vi.mock('@forge/kvs', () => ({
  kvs: {
    get: vi.fn(async (key: string) => {
      if (key === 'siteUrl') return 'https://one-atlas-ojjg.atlassian.net';
      return undefined;
    }),
    set: vi.fn(async () => undefined),
  },
}));

vi.mock('../src/graph', () => ({
  probeGraph: vi.fn(async () => ({ available: true, missingScopes: [] })),
}));

vi.mock('../src/storage/schema', () => ({
  runMigrations: vi.fn(async () => []),
  query: vi.fn(async (stmt: string) => {
    const s = stmt.replace(/\s+/g, ' ').trim();
    if (s.startsWith('SELECT tc.id AS change_id')) {
      return mockActionState.reversalRows;
    }
    if (s.startsWith('SELECT DISTINCT shortage_key, title, url, owner_name, team_name')) {
      return mockActionState.impactPages;
    }
    if (s.startsWith('SELECT DISTINCT title, url, owner_name FROM impact_item')) {
      return mockActionState.impactPages;
    }
    if (s.startsWith('SELECT shortage_key, ingredient, jira_issue_key, state')) {
      return mockActionState.pastResponseRows;
    }
    return [];
  }),
  execute: vi.fn(async () => undefined),
}));

import {
  actionGetReversalChecklist,
  actionGetPastResponses,
  formatReversalStatusLabel,
  isPlaceholderJiraKey,
} from '../src/actions';

describe('Rovo actions — reversal checklist & placeholder-key hygiene', () => {
  beforeEach(() => {
    mockActionState.reversalRows = [
      {
        change_id: 1,
        description: 'Remove temporary IV bumetanide vial conservation alert from ICU diuretic order set',
        change_state: 'reversal_open',
        reversal_issue_key: 'PROC-404',
        jira_issue_key: 'SAMPLE-REV-BUM',
        shortage_key: 'ndc:72205010207',
        generic_name: 'Bumetanide Injection',
        package_ndc: '72205-102-07',
        ingredient: 'Bumetanide Injection',
        fda_status: 'Resolved',
      },
    ];
    mockActionState.impactPages = [
      {
        shortage_key: 'ndc:72205010207',
        title: 'ICU diuretic protocol — loop diuretic infusions',
        url: '/wiki/spaces/SHOSP/pages/7307265',
        owner_name: 'aghazie david',
        team_name: null,
      },
    ];
    mockActionState.pastResponseRows = [
      {
        shortage_key: 'sample-hist:cefazolin-2025',
        ingredient: 'Cefazolin in Dextrose Injection',
        jira_issue_key: 'HIST-2025-CEF',
        state: 'resolved',
        opened_at: '2025-09-10 09:00:00',
        resolved_at: '2025-11-18 14:30:00',
        decision_summary: '2025-09 P&T decision: Conserved premix 2 g bags for OR surgical prophylaxis.',
      },
    ];
  });

  it('identifies placeholder Jira keys and maps reversal status enums to human labels', () => {
    expect(isPlaceholderJiraKey('SAMPLE-REV-BUM')).toBe(true);
    expect(isPlaceholderJiraKey('HIST-2025-CEF')).toBe(true);
    expect(isPlaceholderJiraKey('PROC-404')).toBe(false);

    expect(formatReversalStatusLabel('reversal_open', 'Resolved')).toBe('Reversal in progress');
    expect(formatReversalStatusLabel('open', 'Resolved')).toBe('Reversal due');
    expect(formatReversalStatusLabel('reversed', 'Resolved')).toBe('Reversed');
  });

  it('actionGetReversalChecklist omits SAMPLE-REV-BUM, uses human status label, returns full checklist with owner & source page, and links openFDA', async () => {
    const out = await actionGetReversalChecklist({});
    const serialized = JSON.stringify(out);

    // 1. Never return placeholder Jira keys anywhere in action output.
    expect(serialized).not.toContain('SAMPLE-REV-BUM');
    // 2. Never expose raw enum `reversal_open` — use human label "Reversal in progress".
    expect(serialized).not.toContain('reversal_open');

    expect(out.items).toHaveLength(1);
    const item = out.items[0] as Record<string, unknown>;
    expect(item.status).toBe('Reversal in progress');
    expect(item.reversalWorkItem).toBe('PROC-404');
    expect(item.reversalWorkItemUrl).toBe('https://one-atlas-ojjg.atlassian.net/browse/PROC-404');
    expect('responseWorkItem' in item).toBe(false);
    expect(item.isSampleData).toBe(true);
    expect(String(item.sourceAttribution)).toContain('Sample hospital demonstration data');
    expect(item.sourcePage).toEqual({
      title: 'ICU diuretic protocol — loop diuretic infusions',
      url: 'https://one-atlas-ojjg.atlassian.net/wiki/spaces/SHOSP/pages/7307265',
      owner: 'aghazie david',
    });

    // 3. Actionable reversal checklist with owner, source page, and PROC-404 closure step.
    const checklist = item.checklist as {
      step: string;
      owner: string;
      sourcePage?: { title: string; url: string };
      jiraTask?: string;
    }[];
    expect(checklist.length).toBeGreaterThanOrEqual(4);
    for (const step of checklist) {
      expect(step.owner).toBe('aghazie david');
      expect(step.sourcePage?.title).toBe('ICU diuretic protocol — loop diuretic infusions');
      expect(step.sourcePage?.url).toBe(
        'https://one-atlas-ojjg.atlassian.net/wiki/spaces/SHOSP/pages/7307265',
      );
    }
    expect(checklist.some((s) => s.step.includes('PROC-404') && s.jiraTask === 'PROC-404')).toBe(
      true,
    );

    // 4. openFDA source link and verbatim disclaimer present.
    expect(String(item.openFdaRecordUrl)).toContain(
      'https://api.fda.gov/drug/shortages.json?search=package_ndc:',
    );
    expect(item.fdaDatabaseUrl).toBe('https://dps.fda.gov/drugshortages');
    expect(out.openFdaSources).toHaveLength(1);
    expect(out.disclaimer).toBe(OPENFDA_DISCLAIMER);
  });

  it('actionGetPastResponses never leaks placeholder HIST-2025-CEF as a Jira link', async () => {
    const out = await actionGetPastResponses({ inputs: { ingredient: 'cefazolin' } });
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain('HIST-2025-CEF');
    expect(serialized).not.toContain('/browse/HIST-');
    expect('responses' in out && Array.isArray(out.responses) && out.responses[0]).toMatchObject({
      isSampleData: true,
      status: 'Resolved',
    });
  });
});
