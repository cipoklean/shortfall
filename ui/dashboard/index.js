import { invoke } from '@forge/bridge';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const STATUS_CLASS = { Current: 'amber', 'To Be Discontinued': 'red', Resolved: 'teal' };

function sticker(status) {
  return `<span class="st sticker-${STATUS_CLASS[status] ?? 'plain'}">${esc(status)}</span>`;
}

function row(cells) {
  return `<tr>${cells.map((c) => `<td>${c}</td>`).join('')}</tr>`;
}

async function refresh() {
  $('status').textContent = 'Loading…';
  const [dash, matches, syncLog, sample] = await Promise.all([
    invoke('getDashboardData'),
    invoke('getMatchedShortages'),
    invoke('getSyncLog'),
    invoke('getSampleState'),
  ]);

  $('status').textContent = '';
  $('kpi-active').textContent = dash.activeMatched ?? 0;
  $('kpi-impact').textContent = dash.impactItems ?? 0;
  $('kpi-formulary').textContent = (sample.formularyIds ?? []).length;
  $('kpi-space').textContent = sample.spaceKey ?? '—';

  const ls = dash.lastSync;
  $('last-sync').innerHTML = ls
    ? `Last sync: <strong>${esc(ls.finishedAt ?? '')}</strong> · FDA list dated <strong>${esc(ls.fdaLastUpdated ?? '?')}</strong> · ${esc(ls.records)} records · ${esc(ls.matched)} matches`
    : 'No sync has run yet. Load a drug list and press Sync now.';

  if (dash.reducedMode?.length) {
    $('reduced').hidden = false;
    $('reduced-list').innerHTML = dash.reducedMode.map((m) => `<li>${esc(m)}</li>`).join('');
  }

  $('matches').innerHTML = matches.length
    ? matches.map((m) => row([
        `<a href="${esc(m.source)}" target="_blank" rel="noopener">${esc(m.packageNdc || '—')}</a>`,
        esc(m.genericName),
        esc(m.presentation),
        esc(m.matchedTo),
        esc(m.reason),
        sticker(m.status),
      ])).join('')
    : row([{ toString: () => '<em>No matched shortages yet.</em>', colSpan: 6 }].map(String)).replace('<td>', '<td colspan="6">');

  $('sync-log').innerHTML = syncLog.length
    ? syncLog.map((r) => row([r.id, esc(r.kind), esc(r.state), esc(r.started_at), esc(r.finished_at ?? '—'), `<code>${esc((r.result ?? '').slice(0, 160))}</code>`])).join('')
    : row(['<td colspan="6"><em>No sync runs recorded.</em></td>']);
}

async function runAction(name, label) {
  const btn = $(name);
  btn.disabled = true;
  btn.textContent = 'Working…';
  try {
    const result = await invoke(name === 'btn-sync' ? 'startSync' : name === 'btn-sample' ? 'loadSampleHospital' : 'removeSampleHospital');
    $('action-out').textContent = label + ': ' + JSON.stringify(result);
  } catch (e) {
    $('action-out').textContent = label + ' failed: ' + String(e?.message ?? e);
  } finally {
    btn.disabled = false;
    btn.textContent = label;
    setTimeout(refresh, 1500);
  }
}

async function pollProgress() {
  const p = await invoke('getSyncProgress');
  if (p.state === 'running') {
    $('progress').hidden = false;
    $('progress-detail').textContent = JSON.stringify(p.progress ?? {});
    setTimeout(pollProgress, 3000);
  } else {
    $('progress').hidden = true;
    if (p.state !== 'none') refresh();
  }
}

$('btn-sync').addEventListener('click', async () => {
  await runAction('btn-sync', 'Sync now');
  pollProgress();
});
$('btn-sample').addEventListener('click', () => runAction('btn-sample', 'Load sample hospital'));
$('btn-remove').addEventListener('click', () => runAction('btn-remove', 'Remove sample hospital'));
$('btn-enrich').addEventListener('click', async () => {
  $('btn-enrich').disabled = true;
  try {
    const r = await invoke('enrichImpact');
    $('action-out').textContent = 'Owner/team enrichment: ' + JSON.stringify(r);
  } catch (e) {
    $('action-out').textContent = 'Enrichment failed: ' + String(e?.message ?? e);
  } finally {
    $('btn-enrich').disabled = false;
    refresh();
  }
});

refresh().then(pollProgress).catch((e) => {
  $('status').textContent = 'Failed to load dashboard: ' + String(e?.message ?? e);
});
