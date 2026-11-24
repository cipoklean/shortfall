import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OPENFDA_DISCLAIMER } from '../src/types';

// In-memory mock store for Forge API, SQL, KVS, and Settings so we can
// deterministically test response capping, owner-task dedup, Jira ticket
// quality (assignee:null, priority, issueLink, clickable ADF links),
// superseded response closing, and dry-run cleanup safety — 100% offline.

interface MockState {
  shortages: Map<string, {
    shortage_key: string;
    generic_name: string;
    presentation: string;
    status: string;
    package_ndc: string;
    availability: string;
    company_name: string;
    update_date: string;
  }>;
  impacts: {
    shortage_key: string;
    kind: string;
    ref_id: string;
    title: string;
    url: string;
    owner_account_id: string | null;
    owner_name: string | null;
    team_name: string | null;
    hop: number;
  }[];
  responses: {
    id: number;
    shortage_key: string;
    ingredient: string;
    jira_issue_key: string;
    jira_issue_id: string;
    state: string;
  }[];
  ownerTasks: {
    id: number;
    response_id: number;
    ingredient_key: string;
    owner_key: string;
    owner_account_id: string | null;
    owner_name: string;
    jira_issue_key: string;
  }[];
  activeMatches: { shortage_key: string }[];
  createdIssues: { key: string; fields: Record<string, unknown> }[];
  createdLinks: { type: { name: string }; inwardIssue: { key: string }; outwardIssue: { key: string } }[];
  deletedIssues: string[];
  procSearchIssues: {
    key: string;
    fields: {
      summary: string;
      created: string;
      status: { name: string };
      priority: { name: string };
      assignee: { displayName: string } | null;
      reporter: { displayName: string; accountType: string };
    };
  }[];
  nextIssueNum: number;
  nextRespId: number;
  nextOwnerTaskId: number;
}

const mockState: MockState = {
  shortages: new Map(),
  impacts: [],
  responses: [],
  ownerTasks: [],
  activeMatches: [],
  createdIssues: [],
  createdLinks: [],
  deletedIssues: [],
  procSearchIssues: [],
  nextIssueNum: 500,
  nextRespId: 1,
  nextOwnerTaskId: 1,
};

function resetState() {
  mockState.shortages.clear();
  mockState.impacts = [];
  mockState.responses = [];
  mockState.ownerTasks = [];
  mockState.activeMatches = [];
  mockState.createdIssues = [];
  mockState.createdLinks = [];
  mockState.deletedIssues = [];
  mockState.procSearchIssues = [];
  mockState.nextIssueNum = 500;
  mockState.nextRespId = 1;
  mockState.nextOwnerTaskId = 1;
}

const mockRequestJira = vi.fn(async (path: { value?: string } | string, init?: { method?: string; body?: string }) => {
  const url = typeof path === 'string' ? path : String(path?.value ?? path);
  const method = init?.method ?? 'GET';

  if (method === 'POST' && url === '/rest/api/3/issue') {
    const parsed = JSON.parse(init?.body ?? '{}') as { fields: Record<string, unknown> };
    const key = `PROC-${mockState.nextIssueNum++}`;
    mockState.createdIssues.push({ key, fields: parsed.fields });
    return {
      ok: true,
      status: 201,
      json: async () => ({ id: String(mockState.nextIssueNum), key }),
      text: async () => JSON.stringify({ key }),
    };
  }

  if (method === 'POST' && url === '/rest/api/3/issueLink') {
    const parsed = JSON.parse(init?.body ?? '{}');
    mockState.createdLinks.push(parsed);
    return { ok: true, status: 201, json: async () => ({}), text: async () => '' };
  }

  if (method === 'DELETE' && url.startsWith('/rest/api/3/issue/')) {
    const key = url.split('/').pop()!;
    mockState.deletedIssues.push(key);
    return { ok: true, status: 204, json: async () => ({}), text: async () => '' };
  }

  if (method === 'GET' && url.startsWith('/rest/api/3/search/jql')) {
    return {
      ok: true,
      status: 200,
      json: async () => ({ issues: mockState.procSearchIssues, isLast: true }),
      text: async () => JSON.stringify({ issues: mockState.procSearchIssues }),
    };
  }

  return { ok: false, status: 404, json: async () => ({}), text: async () => 'not mocked' };
});

vi.mock('@forge/api', () => ({
  default: {
    asApp: () => ({ requestJira: mockRequestJira }),
    asUser: () => ({ requestJira: mockRequestJira }),
  },
  route: (strings: TemplateStringsArray, ...vals: unknown[]) => ({
    value: strings.reduce((acc, s, i) => acc + s + (vals[i] ?? ''), ''),
  }),
}));

vi.mock('@forge/kvs', () => ({
  kvs: {
    get: vi.fn(async (key: string) => {
      if (key === 'siteUrl') return 'https://one-atlas-ojjg.atlassian.net';
      if (key === 'settings') {
        return {
          clinicalSpaceKeys: ['SHOSP'],
          autoCreateResponses: true,
          responseProjectKey: 'PROC',
          setupComplete: true,
        };
      }
      return undefined;
    }),
    set: vi.fn(async () => undefined),
  },
}));

async function handleMockSql(stmt: string, params: unknown[]) {
  const s = stmt.replace(/\s+/g, ' ').trim();

  if (s.startsWith('SELECT shortage_key, generic_name, presentation')) {
    const key = String(params[0]);
    const row = mockState.shortages.get(key);
    return { rows: row ? [row] : [] };
  }
  if (s.startsWith('SELECT status, generic_name FROM shortage WHERE shortage_key = ?')) {
    const row = mockState.shortages.get(String(params[0]));
    return { rows: row ? [{ status: row.status, generic_name: row.generic_name }] : [] };
  }
  if (s.startsWith('SELECT id, jira_issue_key FROM response WHERE shortage_key = ?')) {
    const key = String(params[0]);
    return {
      rows: mockState.responses.filter((r) => r.shortage_key === key && r.state === 'open'),
    };
  }
  if (s.startsWith('SELECT id, ingredient, jira_issue_key FROM response WHERE COALESCE(state')) {
    return {
      rows: mockState.responses.filter((r) => r.state === 'open'),
    };
  }
  if (s.startsWith('SELECT ingredient FROM response WHERE COALESCE(state')) {
    return {
      rows: mockState.responses.filter((r) => r.state === 'open').map((r) => ({ ingredient: r.ingredient })),
    };
  }
  if (s.startsWith('SELECT id, shortage_key, ingredient, jira_issue_key FROM response WHERE COALESCE(state')) {
    return {
      rows: mockState.responses.filter((r) => r.state === 'open'),
    };
  }
  if (s.startsWith('SELECT DISTINCT s.generic_name FROM shortage s JOIN')) {
    const rows = mockState.activeMatches
      .map((m) => mockState.shortages.get(m.shortage_key))
      .filter(Boolean)
      .map((r) => ({ generic_name: r!.generic_name }));
    return { rows };
  }
  if (s.startsWith('SELECT kind, ref_id, title, url, owner_account_id')) {
    const key = String(params[0]);
    return { rows: mockState.impacts.filter((i) => i.shortage_key === key) };
  }
  if (s.startsWith('SELECT jira_issue_key FROM owner_task WHERE ingredient_key = ? AND owner_key = ?')) {
    const [ing, owner] = params;
    return {
      rows: mockState.ownerTasks.filter(
        (t) => t.ingredient_key === String(ing) && t.owner_key === String(owner),
      ),
    };
  }
  if (s.startsWith('INSERT INTO response')) {
    const id = mockState.nextRespId++;
    mockState.responses.push({
      id,
      shortage_key: String(params[0]),
      ingredient: String(params[1]),
      jira_issue_key: String(params[2]),
      jira_issue_id: String(params[3]),
      state: 'open',
    });
    return { rows: [{ insertId: id }] };
  }
  if (s.startsWith('INSERT IGNORE INTO owner_task')) {
    const ing = String(params[1]);
    const owner = String(params[2]);
    if (!mockState.ownerTasks.some((t) => t.ingredient_key === ing && t.owner_key === owner)) {
      mockState.ownerTasks.push({
        id: mockState.nextOwnerTaskId++,
        response_id: Number(params[0]),
        ingredient_key: ing,
        owner_key: owner,
        owner_account_id: params[3] ? String(params[3]) : null,
        owner_name: String(params[4]),
        jira_issue_key: String(params[5]),
      });
    }
    return { rows: [] };
  }
  if (s.startsWith("UPDATE response SET state = 'superseded'")) {
    const id = Number(params[0]);
    const row = mockState.responses.find((r) => r.id === id);
    if (row) row.state = 'superseded';
    return { rows: [] };
  }
  if (s.startsWith('SELECT id, jira_issue_key FROM response WHERE jira_issue_key IS NOT NULL')) {
    return { rows: mockState.responses.map((r) => ({ id: r.id, jira_issue_key: r.jira_issue_key })) };
  }
  if (s.startsWith('SELECT id, jira_issue_key FROM owner_task')) {
    return { rows: mockState.ownerTasks.map((t) => ({ id: t.id, jira_issue_key: t.jira_issue_key })) };
  }
  if (s.startsWith('SELECT COUNT(*) AS n FROM impact_item')) {
    return { rows: [{ n: 0 }] };
  }
  return { rows: [] };
}

vi.mock('../src/storage/schema', () => ({
  query: vi.fn(async (stmt: string, params: unknown[] = []) => (await handleMockSql(stmt, params)).rows),
  execute: vi.fn(async (stmt: string, params: unknown[] = []) => {
    await handleMockSql(stmt, params);
  }),
  sql: {
    prepare: (stmt: string) => ({
      bindParams: (...params: unknown[]) => ({
        execute: () => handleMockSql(stmt, params),
      }),
    }),
  },
  runMigrations: vi.fn(async () => []),
}));

import {
  priorityForStatus,
  buildResponseAdf,
  createResponseForShortage,
  createResponsesForNewMatches,
  closeSupersededResponses,
  cleanupShortfallProcIssues,
  FDA_HUMAN_SHORTAGES_URL,
} from '../src/respond';

describe('respond — priority, ADF links, per-ingredient cap, owner-task dedup, cleanup', () => {
  beforeEach(() => {
    resetState();
    vi.clearAllMocks();
  });

  it('maps FDA status to priority (Current=High, To Be Discontinued=Medium, Resolved=null)', () => {
    expect(priorityForStatus('Current')).toBe('High');
    expect(priorityForStatus('To Be Discontinued')).toBe('Medium');
    expect(priorityForStatus('Resolved')).toBeNull();
  });

  it('enforces at most 1 response per shorted ingredient across 65 lidocaine + 49 ropivacaine + 27 rocuronium NDCs', async () => {
    const keys: string[] = [];
    const addBatch = (prefix: string, name: string, count: number) => {
      for (let i = 0; i < count; i++) {
        const key = `ndc:${prefix}${String(i).padStart(5, '0')}`;
        keys.push(key);
        mockState.shortages.set(key, {
          shortage_key: key,
          generic_name: name,
          presentation: `${name} presentation #${i}`,
          status: 'Current',
          package_ndc: `00409-${String(i).padStart(4, '0')}-01`,
          availability: 'Limited',
          company_name: 'Hospira',
          update_date: '11/20/2026',
        });
      }
    };
    addBatch('100001', 'Lidocaine Hydrochloride Injection', 65);
    addBatch('200002', 'Ropivacaine Hydrochloride Injection', 49);
    addBatch('300003', 'Rocuronium Bromide Injection', 27);

    const res = await createResponsesForNewMatches(keys);
    // MUST fail if more than 1 response per shorted ingredient is created!
    expect(res.created).toBe(3);
    expect(mockState.responses).toHaveLength(3);
    expect(mockState.createdIssues).toHaveLength(3);

    // Re-running must create 0 additional tickets (idempotent).
    const res2 = await createResponsesForNewMatches(keys);
    expect(res2.created).toBe(0);
    expect(mockState.responses).toHaveLength(3);
  });

  it('creates at most 1 owner task per owner per ingredient, links it via real issueLink, and sets priority + assignee', async () => {
    const key = 'ndc:66794022941';
    mockState.shortages.set(key, {
      shortage_key: key,
      generic_name: 'Rocuronium Bromide Injection',
      presentation: 'Rocuronium Bromide 100 mg/10 mL',
      status: 'Current',
      package_ndc: '66794-229-41',
      availability: 'Limited',
      company_name: 'Fresenius Kabi',
      update_date: '11/20/2026',
    });
    // Same owner on 3 affected pages -> must yield ONLY 1 [Owner Review] task.
    for (let i = 1; i <= 3; i++) {
      mockState.impacts.push({
        shortage_key: key,
        kind: 'page',
        ref_id: `445644${i}`,
        title: `Protocol page ${i}`,
        url: `/wiki/spaces/SHOSP/pages/445644${i}`,
        owner_account_id: '712020:human-owner-1',
        owner_name: 'Dr. Jane Doe',
        team_name: 'Clinical Pharmacy',
        hop: 1,
      });
    }

    const r1 = await createResponseForShortage(key);
    expect(r1.created).toBe(true);
    expect(r1.ownerTasks).toHaveLength(1);

    // Parent response: High priority, explicit assignee: null (never project default).
    const parent = mockState.createdIssues[0];
    expect(parent.fields.priority).toEqual({ name: 'High' });
    expect(parent.fields.assignee).toBeNull();

    // Owner task: assigned to resolved human owner, High priority, real Jira issueLink!
    const child = mockState.createdIssues[1];
    expect(child.fields.assignee).toEqual({ accountId: '712020:human-owner-1' });
    expect(child.fields.priority).toEqual({ name: 'High' });
    expect(mockState.createdLinks).toHaveLength(1);
    expect(mockState.createdLinks[0]).toEqual({
      type: { name: 'Relates' },
      inwardIssue: { key: child.key },
      outwardIssue: { key: parent.key },
    });

    // Repeat call is idempotent — no duplicate response or owner task.
    const r2 = await createResponseForShortage(key);
    expect(r2.created).toBe(false);
    expect(r2.alreadyExists).toBe(true);
    expect(mockState.createdIssues).toHaveLength(2);
  });

  it('leaves parent unassigned with triage note when no human owner exists, and refuses Resolved shortages', async () => {
    const discKey = 'ndc:00338350841';
    mockState.shortages.set(discKey, {
      shortage_key: discKey,
      generic_name: 'Cefazolin in Dextrose Injection',
      presentation: 'Cefazolin 2 g premix',
      status: 'To Be Discontinued',
      package_ndc: '0338-3508-41',
      availability: '',
      company_name: 'Baxter',
      update_date: '10/30/2026',
    });
    mockState.impacts.push({
      shortage_key: discKey,
      kind: 'page',
      ref_id: '4390913',
      title: 'Cefazolin surgical prophylaxis protocol',
      url: '/wiki/spaces/SHOSP/pages/4390913',
      owner_account_id: null,
      owner_name: 'shortfall', // app bot -> ignored
      team_name: null,
      hop: 1,
    });

    const r = await createResponseForShortage(discKey);
    expect(r.created).toBe(true);
    expect(r.ownerTasks).toHaveLength(0);
    const parent = mockState.createdIssues[0];
    expect(parent.fields.priority).toEqual({ name: 'Medium' });
    expect(parent.fields.assignee).toBeNull();
    expect(JSON.stringify(parent.fields.description)).toContain('left unassigned for pharmacy triage');

    // Resolved shortage must NEVER create a ticket.
    const resKey = 'ndc:72205010207';
    mockState.shortages.set(resKey, {
      shortage_key: resKey,
      generic_name: 'Bumetanide Injection',
      presentation: 'Bumetanide 0.25 mg/mL',
      status: 'Resolved',
      package_ndc: '72205-102-07',
      availability: 'Available',
      company_name: 'Avenacy',
      update_date: '11/01/2026',
    });
    const rRes = await createResponseForShortage(resKey);
    expect(rRes.created).toBe(false);
    expect(mockState.createdIssues).toHaveLength(1);
  });

  it('builds clickable ADF links for Confluence pages, human FDA DB, and labeled openFDA raw data', () => {
    const adf = buildResponseAdf(
      {
        shortage_key: 'ndc:00338350841',
        generic_name: 'Cefazolin in Dextrose Injection',
        presentation: 'Cefazolin 2 g',
        status: 'To Be Discontinued',
        package_ndc: '0338-3508-41',
        availability: '',
        company_name: 'Baxter',
        update_date: '10/30/2026',
      },
      [
        {
          kind: 'page',
          ref_id: '4390913',
          title: 'Cefazolin surgical prophylaxis protocol',
          url: '/wiki/spaces/SHOSP/pages/4390913',
          owner_account_id: 'u1',
          owner_name: 'Dr. Jane Doe',
          team_name: 'Pharmacy',
        },
      ],
      'https://one-atlas-ojjg.atlassian.net',
    );
    const serialized = JSON.stringify(adf);
    expect(serialized).toContain('https://one-atlas-ojjg.atlassian.net/wiki/spaces/SHOSP/pages/4390913');
    expect(serialized).toContain(FDA_HUMAN_SHORTAGES_URL);
    expect(serialized).toContain('FDA Drug Shortages Database');
    expect(serialized).toContain('openFDA record (raw data)');
    expect(serialized).toContain(OPENFDA_DISCLAIMER);
  });

  it('closes open responses whose match was superseded / dropped out', async () => {
    mockState.shortages.set('ndc:66794022941', {
      shortage_key: 'ndc:66794022941',
      generic_name: 'Rocuronium Bromide Injection',
      presentation: 'Rocuronium',
      status: 'Current',
      package_ndc: '66794-229-41',
      availability: '',
      company_name: '',
      update_date: '',
    });
    mockState.responses.push(
      { id: 1, shortage_key: 'ndc:66794022941', ingredient: 'Rocuronium Bromide Injection', jira_issue_key: 'PROC-141', jira_issue_id: '141', state: 'open' },
      { id: 2, shortage_key: 'ndc:4970220548', ingredient: 'Lamivudine Tablet', jira_issue_key: 'PROC-133', jira_issue_id: '133', state: 'open' },
    );
    mockState.activeMatches = [{ shortage_key: 'ndc:66794022941' }];

    const out = await closeSupersededResponses(new Set(['ndc:66794022941']));
    expect(out.closed).toBe(1);
    expect(mockState.responses[0].state).toBe('open');
    expect(mockState.responses[1].state).toBe('superseded');
  });

  it('cleanupShortfallProcIssues defaults to dry-run and never touches non-Shortfall PROC issues', async () => {
    mockState.procSearchIssues = [
      {
        key: 'PROC-1',
        fields: {
          summary: 'Purchase Request — New Laptops',
          created: '2026-10-01T00:00:00Z',
          status: { name: 'Requested' },
          priority: { name: 'Medium' },
          assignee: { displayName: 'Kevin Campbell' },
          reporter: { displayName: 'Alice Admin', accountType: 'atlassian' },
        },
      },
      {
        key: 'PROC-2',
        fields: {
          summary: 'Corporate Credit Card Renewal',
          created: '2026-10-02T00:00:00Z',
          status: { name: 'Requested' },
          priority: { name: 'Low' },
          assignee: null,
          reporter: { displayName: 'Bob Buyer', accountType: 'atlassian' },
        },
      },
      {
        key: 'PROC-141',
        fields: {
          summary: '[Shortage] Rocuronium Bromide Injection — 100 mg/10 mL',
          created: '2026-11-24T10:26:00Z',
          status: { name: 'Requested' },
          priority: { name: 'Critical' },
          assignee: { displayName: 'Kevin Campbell' },
          reporter: { displayName: 'shortfall', accountType: 'app' },
        },
      },
      {
        key: 'PROC-392',
        fields: {
          summary: '[Owner Review] Rocuronium Bromide Injection — Kevin Campbell',
          created: '2026-11-24T10:26:05Z',
          status: { name: 'Requested' },
          priority: { name: 'Critical' },
          assignee: { displayName: 'Kevin Campbell' },
          reporter: { displayName: 'shortfall', accountType: 'app' },
        },
      },
    ];

    const dry = await cleanupShortfallProcIssues({ confirm: false });
    expect(dry.dryRun).toBe(true);
    expect(dry.totalProjectIssues).toBe(4);
    expect(dry.preservedOtherProcIssues).toBe(2);
    expect(dry.matchedCount).toBe(2);
    expect(dry.breakdown).toEqual({ shortage: 1, ownerReview: 1, reversal: 0 });
    expect(dry.matchedIssues.map((i) => i.key)).toEqual(['PROC-141', 'PROC-392']);
    expect(mockState.deletedIssues).toHaveLength(0);
  });
});
