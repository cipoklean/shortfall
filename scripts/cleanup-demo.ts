#!/usr/bin/env node
/**
 * Safe cleanup CLI for Shortfall-created Jira issues in PROC (and matching
 * Forge SQL rows). Dry-run is the DEFAULT; passes confirm=1 ONLY when the
 * caller explicitly provides `--confirm`.
 *
 * Usage:
 *   SHORTFALL_DIAG_TOKEN=<secret> SHORTFALL_SYNC_URL=<url> \
 *     node --experimental-strip-types scripts/cleanup-demo.ts [--dry-run] [--confirm] [--project PROC]
 *
 * Never touches non-Shortfall issues in PROC (Purchase Requests, Corporate
 * Credit Card, etc.) — matches ONLY issues whose reporter is the Shortfall
 * app AND whose summary starts with [Shortage], [Owner Review], or [Reversal].
 */

interface CleanupResponse {
  dryRun: boolean;
  projectKey: string;
  totalProjectIssues: number;
  preservedOtherProcIssues: number;
  matchedCount: number;
  breakdown: { shortage: number; ownerReview: number; reversal: number };
  matchedIssues: {
    key: string;
    kind: string;
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
  error?: string;
}

function parseArgs(argv: string[]) {
  const confirm = argv.includes('--confirm') && !argv.includes('--dry-run');
  const projectIdx = argv.indexOf('--project');
  const project = projectIdx >= 0 && argv[projectIdx + 1] ? argv[projectIdx + 1] : 'PROC';
  return { confirm, project };
}

async function callCleanup(
  syncUrl: string,
  token: string,
  project: string,
  confirm: boolean,
): Promise<CleanupResponse> {
  const url = new URL(syncUrl);
  url.searchParams.set('token', token);
  url.searchParams.set('action', 'cleanup-shortfall');
  url.searchParams.set('project', project);
  url.searchParams.set('max', '80');
  if (confirm) url.searchParams.set('confirm', '1');

  const res = await fetch(url.toString(), { method: 'POST' });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  return JSON.parse(text) as CleanupResponse;
}

async function main() {
  const { confirm, project } = parseArgs(process.argv.slice(2));
  const token = process.env.SHORTFALL_DIAG_TOKEN ?? '';
  const syncUrl = process.env.SHORTFALL_SYNC_URL ?? '';

  if (!token || !syncUrl) {
    console.error(
      'Missing SHORTFALL_DIAG_TOKEN or SHORTFALL_SYNC_URL environment variables.',
    );
    process.exit(2);
  }

  console.log(
    `Shortfall demo cleanup — mode: ${confirm ? 'CONFIRM (DELETING)' : 'DRY-RUN (no changes)'} | project: ${project}`,
  );

  if (!confirm) {
    const out = await callCleanup(syncUrl, token, project, false);
    console.log(`\nProject ${out.projectKey}: ${out.totalProjectIssues} total issues`);
    console.log(`  Preserved non-Shortfall issues (untouched): ${out.preservedOtherProcIssues}`);
    console.log(`  Matched Shortfall issues to delete:         ${out.matchedCount}`);
    console.log(
      `    - [Shortage]:     ${out.breakdown.shortage}\n    - [Owner Review]: ${out.breakdown.ownerReview}\n    - [Reversal]:     ${out.breakdown.reversal}`,
    );
    console.log(
      `  Matching Forge SQL rows to clear:           response=${out.sqlRowsMatched.response}, owner_task=${out.sqlRowsMatched.ownerTask}, self_impact=${out.sqlRowsMatched.selfImpact}`,
    );
    console.log(`\nMatched keys (${out.matchedIssues.length}):`);
    for (const item of out.matchedIssues) {
      console.log(
        `  ${item.key.padEnd(10)} [${item.kind}] priority=${item.priority} assignee=${item.assignee} | ${item.summary}`,
      );
    }
    console.log('\nDry run complete. Re-run with --confirm to delete these issues and clear SQL rows.');
    return;
  }

  let totalDeleted = 0;
  let totalErrors = 0;
  let totalRespCleared = 0;
  let totalOwnerCleared = 0;
  let round = 0;

  while (round < 20) {
    round++;
    const out = await callCleanup(syncUrl, token, project, true);
    totalDeleted += out.deletedJiraIssues;
    totalErrors += out.jiraDeleteErrors;
    totalRespCleared += out.clearedSqlRows.response;
    totalOwnerCleared += out.clearedSqlRows.ownerTask;
    console.log(
      `Round ${round}: deleted=${out.deletedJiraIssues}, errors=${out.jiraDeleteErrors}, remaining=${out.remainingToDelete}, preserved_other=${out.preservedOtherProcIssues}`,
    );
    if (out.remainingToDelete === 0 || out.deletedJiraIssues === 0) break;
  }

  console.log(
    `\nCleanup finished: deleted ${totalDeleted} Shortfall Jira issues (${totalErrors} errors); cleared SQL response=${totalRespCleared}, owner_task=${totalOwnerCleared}.`,
  );
}

main().catch((err) => {
  console.error('Cleanup failed:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
