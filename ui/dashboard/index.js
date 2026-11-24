import { invoke, view, router, rovo } from '@forge/bridge';

const OPENFDA_DISCLAIMER =
  'Do not rely on openFDA to make decisions regarding medical care. While we make every effort to ensure that data is accurate, you should assume all results are unvalidated. We may limit or otherwise restrict your access to the API in line with our Terms of Service.';

const SHELF_GAP_SVG = `<svg viewBox="0 0 40 40" aria-hidden="true"><rect x="9" y="7" width="22" height="26" fill="none" stroke="#d9820b" stroke-width="2.6" stroke-dasharray="5 3.5"/><line x1="4" y1="36" x2="36" y2="36" stroke="currentColor" stroke-width="3"/></svg>`;

const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));

const state = {
  siteUrl: '',
  dash: null,
  matches: [],
  syncLog: [],
  sample: null,
  setupOptions: null,
  activeTab: 'shortages',
  initialTabChosen: false,
  statusFilter: 'All',
  searchQuery: '',
  openDrawerKey: null,
  lastFocusedEl: null,
  parsedCsvItems: [],
  pollTimer: null,
};

/* ---------- URL & Navigation (Forge Custom UI router.open) ---------- */

function setSiteUrl(url) {
  if (!url) return;
  state.siteUrl = String(url).replace(/\/+$/, '');
}

function resolveUrl(href) {
  if (!href) return '';
  const raw = String(href).trim();
  if (/^https?:\/\//i.test(raw)) return raw;
  if (raw.startsWith('/')) {
    return state.siteUrl ? `${state.siteUrl}${raw}` : raw;
  }
  return raw;
}

function jiraIssueUrl(issueKey) {
  return resolveUrl(`/browse/${encodeURIComponent(issueKey)}`);
}

function fdaSourceUrl(source, packageNdc) {
  if (source && /^https?:\/\//i.test(source)) return source;
  if (packageNdc) {
    return `https://api.fda.gov/drug/shortages.json?search=package_ndc:%22${encodeURIComponent(packageNdc)}%22`;
  }
  return 'https://dps.fda.gov/drugshortages';
}

document.addEventListener('click', (e) => {
  const link = e.target.closest('a[href]');
  if (!link) return;
  const href = link.getAttribute('href');
  if (!href || href.startsWith('#')) return;
  e.preventDefault();
  e.stopPropagation();
  const full = resolveUrl(href);
  if (full) router.open(full);
});

/* ---------- Formatting Helpers ---------- */

function statusRank(status) {
  if (status === 'Current') return 0;
  if (status === 'To Be Discontinued') return 1;
  if (status === 'Resolved') return 2;
  return 3;
}

function statusSticker(status) {
  const s = status || 'Unknown';
  let cls = 'sticker-plain';
  if (s === 'Current') cls = 'sticker-current';
  else if (s === 'To Be Discontinued') cls = 'sticker-discontinued';
  else if (s === 'Resolved') cls = 'sticker-resolved';
  return `<span class="sticker ${cls}">${esc(s)}</span>`;
}

function reasonBadge(reason) {
  const map = {
    ndc: 'Exact NDC',
    ingredient_rxcui: 'RxNorm IN',
    ingredient_name: 'Ingredient',
  };
  const label = map[reason] ?? reason ?? 'Matched';
  return `<span class="chip-meta">${esc(label)}</span>`;
}

function formatDateTime(val) {
  if (!val) return '—';
  const str = String(val);
  const d = new Date(str);
  if (Number.isNaN(d.getTime())) return str;
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

function formatHours(val) {
  const num = Number(val);
  if (!Number.isFinite(num)) return '—';
  if (num < 1) return `${Math.round(num * 60)}m`;
  return num >= 10 ? `${Math.round(num)}h` : `${num.toFixed(1)}h`;
}

function isSecondHop(item) {
  if (Number(item?.hop) === 2) return true;
  const via = String(item?.found_via ?? item?.foundVia ?? '').toLowerCase();
  return via.includes('graph') || via.includes('2nd') || via.includes('second') || via.includes('linked');
}

function cleanUserError(err) {
  const raw = String(err?.message ?? err ?? 'Unexpected error');
  // Strip raw JSON payloads so API bodies never spill into UI banners.
  const stripped = raw.replace(/\{[\s\S]*\}/g, '').replace(/\s+/g, ' ').trim();
  return (stripped || 'Request failed').slice(0, 180);
}

function showToast(message, isError = false) {
  const el = $('toast-banner');
  el.classList.toggle('is-error', Boolean(isError));
  $('toast-text').textContent = message;
  el.hidden = false;
}

function hideToast() {
  $('toast-banner').hidden = true;
}

/* ---------- Tabs ---------- */

const TABS = [
  { id: 'shortages', btn: 'tab-shortages', panel: 'panel-shortages' },
  { id: 'setup', btn: 'tab-setup', panel: 'panel-setup' },
  { id: 'audit', btn: 'tab-audit', panel: 'panel-audit' },
];

function selectTab(tabId, focusTab = false) {
  state.activeTab = tabId;
  for (const t of TABS) {
    const active = t.id === tabId;
    const btn = $(t.btn);
    const panel = $(t.panel);
    btn.setAttribute('aria-selected', active ? 'true' : 'false');
    btn.tabIndex = active ? 0 : -1;
    panel.hidden = !active;
    if (active && focusTab) btn.focus();
  }
  if (tabId === 'setup' && !state.setupOptions) {
    loadSetupOptions();
  }
}

for (const t of TABS) {
  const btn = $(t.btn);
  btn.addEventListener('click', () => selectTab(t.id));
  btn.addEventListener('keydown', (e) => {
    const idx = TABS.findIndex((x) => x.id === t.id);
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      selectTab(TABS[(idx + 1) % TABS.length].id, true);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      selectTab(TABS[(idx - 1 + TABS.length) % TABS.length].id, true);
    } else if (e.key === 'Home') {
      e.preventDefault();
      selectTab(TABS[0].id, true);
    } else if (e.key === 'End') {
      e.preventDefault();
      selectTab(TABS[TABS.length - 1].id, true);
    }
  });
}

/* ---------- Rendering: Header, Reduced Mode, KPIs, Exposure ---------- */

function renderHeaderAndKpis() {
  const d = state.dash ?? {};
  const ls = d.lastSync;

  if (ls) {
    const pills = [
      `<span class="meta-pill">Synced <strong>${esc(formatDateTime(ls.finishedAt ?? ls.startedAt))}</strong></span>`,
      `<span class="meta-pill">FDA list <strong>${esc(ls.fdaLastUpdated ?? 'unknown')}</strong></span>`,
    ];
    if (ls.records != null) {
      pills.push(`<span class="meta-pill"><strong>${esc(ls.records)}</strong> FDA records</span>`);
    }
    $('header-sync-meta').innerHTML = pills.join('');
  } else {
    $('header-sync-meta').innerHTML =
      `<span class="meta-pill">Not synced yet — configure formulary and press <strong>Sync now</strong></span>`;
  }

  // Reduced-mode banner: shown ONLY when reducedMode has entries
  const reduced = Array.isArray(d.reducedMode) ? d.reducedMode.filter(Boolean) : [];
  if (reduced.length > 0) {
    $('reduced-list').innerHTML = reduced.map((m) => `<li>${esc(m)}</li>`).join('');
    $('reduced-banner').hidden = false;
  } else {
    $('reduced-banner').hidden = true;
    $('reduced-list').innerHTML = '';
  }

  // Reversal attention button in header
  const reversalsDue = Number(d.reversalsDue ?? 0);
  const revBtn = $('btn-reversals');
  if (reversalsDue > 0) {
    revBtn.hidden = false;
    revBtn.textContent = `Open reversal tasks (${reversalsDue})`;
  } else {
    revBtn.hidden = true;
  }

  // KPI strip
  const active = Number(d.activeMatched ?? 0);
  const discontinued = Number(d.discontinuedMatched ?? 0);
  const resolved = Number(d.resolvedMatched ?? 0);
  $('kpi-active').textContent = String(active);
  const activeSubParts = [`${active} current`];
  if (discontinued > 0) activeSubParts.push(`${discontinued} discontinued`);
  if (resolved > 0) activeSubParts.push(`${resolved} resolved`);
  $('kpi-active-sub').textContent = activeSubParts.join(' · ');

  const direct = Number(d.directImpactItems ?? 0);
  const linked = Number(d.linkedImpactItems ?? 0);
  const totalImpact = d.impactItems != null ? Number(d.impactItems) : direct + linked;
  $('kpi-impact').textContent = String(totalImpact);
  $('kpi-impact-sub').textContent = `${direct} direct · ${linked} 2nd-hop graph`;

  const formularyCount = Number(d.formularyCount ?? 0);
  $('kpi-formulary').textContent = String(formularyCount);
  $('kpi-formulary-sub').textContent = formularyCount > 0 ? 'Active hospital list' : 'No drugs loaded yet';
  $('setup-formulary-count').textContent = String(formularyCount);

  const openResponses = Number(d.openResponses ?? 0);
  const openTemp = Number(d.openTemporaryChanges ?? 0);
  $('kpi-responses').textContent = String(openResponses);
  $('kpi-responses-sub').textContent = `${openTemp} temp change${openTemp === 1 ? '' : 's'} open`;

  $('kpi-reversals').textContent = String(reversalsDue);
  $('kpi-reversals-card').classList.toggle('kpi-red', reversalsDue > 0);
  $('kpi-reversals-sub').textContent = reversalsDue > 0 ? 'Action needed on resolved drugs' : 'All clear';

  $('kpi-median').textContent = d.medianResponseHours != null ? formatHours(d.medianResponseHours) : '—';

  // Exposure by space chips
  const spaces = Array.isArray(d.exposureBySpace) ? d.exposureBySpace.filter((s) => s && s.spaceKey) : [];
  if (spaces.length > 0) {
    $('space-chips').innerHTML = spaces
      .map(
        (s) =>
          `<span class="space-chip">${esc(s.spaceKey)} <span class="count">${esc(s.count)}</span></span>`,
      )
      .join('');
    $('space-strip').hidden = false;
  } else {
    $('space-strip').hidden = true;
  }

  // Setup indicator dot
  $('setup-indicator').hidden = Boolean(d.setupComplete || formularyCount > 0);
}

/* ---------- Rendering: Shortages Tab (Grouped by Ingredient, Never Merging NDCs) ---------- */

function renderShortages() {
  const all = state.matches ?? [];
  $('tab-shortages-count').textContent = String(all.length);

  // Status pill counts
  let cCurrent = 0;
  let cDisc = 0;
  let cRes = 0;
  for (const m of all) {
    if (m.status === 'Current') cCurrent++;
    else if (m.status === 'To Be Discontinued') cDisc++;
    else if (m.status === 'Resolved') cRes++;
  }
  $('count-all').textContent = String(all.length);
  $('count-current').textContent = String(cCurrent);
  $('count-discontinued').textContent = String(cDisc);
  $('count-resolved').textContent = String(cRes);

  const q = state.searchQuery.trim().toLowerCase();
  const filtered = all.filter((m) => {
    if (state.statusFilter !== 'All' && m.status !== state.statusFilter) return false;
    if (!q) return true;
    const hay = [
      m.genericName,
      m.ingredientGroup,
      m.packageNdc,
      m.presentation,
      m.company,
      m.dosageForm,
      m.matchedTo,
      m.responseWorkItem,
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    return hay.includes(q);
  });

  // Group by ingredientGroup (display only — EVERY NDC stays its own row!)
  const groupMap = new Map();
  for (const m of filtered) {
    const key = (m.ingredientGroup || m.genericName || 'Unknown ingredient').trim();
    const normKey = key.toLowerCase();
    if (!groupMap.has(normKey)) {
      groupMap.set(normKey, { label: key, items: [] });
    }
    groupMap.get(normKey).items.push(m);
  }

  const groups = Array.from(groupMap.values());
  for (const g of groups) {
    g.items.sort((a, b) => {
      const sr = statusRank(a.status) - statusRank(b.status);
      if (sr !== 0) return sr;
      return String(b.updateDate ?? '').localeCompare(String(a.updateDate ?? ''));
    });
    g.worstStatus = g.items[0]?.status ?? 'Unknown';
    g.worstRank = statusRank(g.worstStatus);
  }
  groups.sort((a, b) => {
    if (a.worstRank !== b.worstRank) return a.worstRank - b.worstRank;
    return a.label.localeCompare(b.label);
  });

  $('filter-summary').textContent = filtered.length
    ? `${filtered.length} presentation${filtered.length === 1 ? '' : 's'} · ${groups.length} ingredient${groups.length === 1 ? '' : 's'}`
    : '';

  const container = $('shortages-container');

  if (!all.length) {
    const hasFormulary = Number(state.dash?.formularyCount ?? 0) > 0;
    container.innerHTML = `
      <div class="empty-state">
        ${SHELF_GAP_SVG}
        <h3>${hasFormulary ? 'No matched FDA shortages yet' : 'No hospital drug list loaded yet'}</h3>
        <p>${
          hasFormulary
            ? 'Run Sync now to fetch the latest openFDA shortage presentations and match them against your formulary.'
            : 'Import your hospital formulary or load the fictional sample hospital in Setup & Formulary, then press Sync now.'
        }</p>
        ${
          hasFormulary
            ? '<button type="button" class="btn btn-primary" data-empty-action="sync">Sync now</button>'
            : '<button type="button" class="btn btn-primary" data-empty-action="goto-setup">Open Setup &amp; Formulary</button>'
        }
      </div>`;
    return;
  }

  if (!groups.length) {
    container.innerHTML = `
      <div class="empty-state">
        ${SHELF_GAP_SVG}
        <h3>No matching shortage presentations</h3>
        <p>Try clearing the search query or selecting a different FDA status filter.</p>
        <button type="button" class="btn" data-empty-action="reset-filters">Reset filters</button>
      </div>`;
    return;
  }

  container.innerHTML = groups
    .map((g) => {
      const rowsHtml = g.items
        .map((m) => {
          const src = fdaSourceUrl(m.source, m.packageNdc);
          const impactCount = Number(m.impactCount ?? 0);
          const metaLine = [m.dosageForm, m.company, m.updateDate ? `Updated ${m.updateDate}` : '']
            .filter(Boolean)
            .join(' · ');

          const responseCell = m.responseWorkItem
            ? `<div style="display:flex;flex-direction:column;gap:3px;align-items:flex-start;">
                <a class="chip-issue" href="${esc(jiraIssueUrl(m.responseWorkItem))}" title="Open Jira response work item">${esc(m.responseWorkItem)}</a>
                ${m.responseState ? `<span class="mono" style="font-size:10.5px;color:var(--sf-text-subtlest);">${esc(m.responseState)}</span>` : ''}
              </div>`
            : `<span class="mono" style="color:var(--sf-text-subtlest);">—</span>`;

          return `
            <tr class="shortage-row" data-shortage-key="${esc(m.shortageId)}">
              <td>
                <a class="ndc-link" href="${esc(src)}" title="View exact FDA source record">${esc(m.packageNdc || m.shortageId)}</a>
              </td>
              <td>
                <div class="pres-title">${esc(m.presentation || m.genericName)}</div>
                ${metaLine ? `<div class="pres-sub">${esc(metaLine)}</div>` : ''}
              </td>
              <td>
                <div class="match-cell">
                  <span>${esc(m.matchedTo || '—')}</span>
                  ${reasonBadge(m.reason)}
                </div>
              </td>
              <td>
                <span class="impact-pill ${impactCount > 0 ? 'has-impact' : ''}" title="${impactCount} affected protocol(s) or work item(s)">${impactCount}</span>
              </td>
              <td>${responseCell}</td>
              <td>${statusSticker(m.status)}</td>
              <td style="white-space:nowrap;">
                <button type="button" class="btn btn-sm" data-inspect="${esc(m.shortageId)}">Inspect</button>
              </td>
            </tr>`;
        })
        .join('');

      return `
        <article class="ing-group">
          <div class="ing-header">
            <div class="ing-title-wrap">
              <h3 class="ing-name">${esc(g.label)}</h3>
              <span class="chip-meta">${g.items.length} presentation${g.items.length === 1 ? '' : 's'}</span>
            </div>
            ${statusSticker(g.worstStatus)}
          </div>
          <div class="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Package NDC</th>
                  <th>Presentation</th>
                  <th>Matched Formulary</th>
                  <th>Impact</th>
                  <th>Response</th>
                  <th>FDA Status</th>
                  <th><span class="sr-only">Action</span></th>
                </tr>
              </thead>
              <tbody>${rowsHtml}</tbody>
            </table>
          </div>
        </article>`;
    })
    .join('');
}

/* ---------- Rendering: Sync Audit Tab ---------- */

function renderSyncLog() {
  const rows = state.syncLog ?? [];
  $('tab-audit-count').textContent = String(rows.length);
  const tbody = $('sync-log-body');

  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="6" style="color:var(--sf-text-subtle);">No sync runs recorded yet.</td></tr>';
    return;
  }

  tbody.innerHTML = rows
    .map((r) => {
      let stateChip = `<span class="chip-meta">${esc(r.state)}</span>`;
      if (r.state === 'done' || r.state === 'completed' || r.state === 'ok') {
        stateChip = `<span class="sticker sticker-resolved">${esc(r.state)}</span>`;
      } else if (r.state === 'running' || r.state === 'queued') {
        stateChip = `<span class="sticker sticker-current">${esc(r.state)}</span>`;
      } else if (r.state === 'error' || r.state === 'failed') {
        stateChip = `<span class="sticker sticker-discontinued">${esc(r.state)}</span>`;
      }

      const rawResult = typeof r.result === 'string' ? r.result : r.result ? JSON.stringify(r.result) : '—';
      const displayResult = rawResult.length > 260 ? `${rawResult.slice(0, 260)}…` : rawResult;

      return `
        <tr>
          <td class="mono">#${esc(r.id)}</td>
          <td class="mono">${esc(r.kind)}</td>
          <td>${stateChip}</td>
          <td class="mono">${esc(formatDateTime(r.started_at))}</td>
          <td class="mono">${esc(formatDateTime(r.finished_at))}</td>
          <td><code class="result-code">${esc(displayResult)}</code></td>
        </tr>`;
    })
    .join('');
}

/* ---------- Rendering: Setup & Formulary Tab ---------- */

function renderSetupOptions() {
  const opts = state.setupOptions;
  const settings = opts?.settings ?? state.dash?.settings ?? {};
  const selectedSpaces = new Set(Array.isArray(settings.clinicalSpaceKeys) ? settings.clinicalSpaceKeys : []);
  const spaces = Array.isArray(opts?.spaces) ? opts.spaces : [];
  const projects = Array.isArray(opts?.projects) ? opts.projects : [];

  const checklist = $('spaces-checklist');
  if (spaces.length) {
    checklist.innerHTML = spaces
      .map((s) => {
        const checked = selectedSpaces.has(s.key) ? 'checked' : '';
        return `
          <label class="check-row">
            <input type="checkbox" name="clinicalSpace" value="${esc(s.key)}" ${checked}>
            <span><strong class="mono">${esc(s.key)}</strong> — ${esc(s.name || s.key)}</span>
          </label>`;
      })
      .join('');
  } else {
    const currentKeys = [...selectedSpaces].join(', ');
    checklist.innerHTML = `<span class="field-help">No Confluence spaces returned. ${
      currentKeys ? `Current saved keys: <code class="mono">${esc(currentKeys)}</code>` : 'Ensure Confluence space read scopes are granted.'
    }</span>`;
  }

  const selectProj = $('select-project');
  const currentProj = settings.responseProjectKey ?? '';
  if (projects.length) {
    const optsHtml = ['<option value="">— Select Jira project —</option>'].concat(
      projects.map((p) => {
        const sel = p.key === currentProj ? 'selected' : '';
        return `<option value="${esc(p.key)}" ${sel}>${esc(p.key)} — ${esc(p.name || p.key)}</option>`;
      }),
    );
    if (currentProj && !projects.some((p) => p.key === currentProj)) {
      optsHtml.push(`<option value="${esc(currentProj)}" selected>${esc(currentProj)} (saved)</option>`);
    }
    selectProj.innerHTML = optsHtml.join('');
  } else {
    selectProj.innerHTML = currentProj
      ? `<option value="${esc(currentProj)}" selected>${esc(currentProj)} (saved)</option>`
      : '<option value="">No Jira projects available</option>';
  }

  $('chk-autocreate').checked = Boolean(settings.autoCreateResponses);
  $('input-fda-key').value = settings.openfdaApiKey ?? '';

  if (opts?.formularyCount != null) {
    $('setup-formulary-count').textContent = String(opts.formularyCount);
  }
}

function renderSampleState() {
  const s = state.sample;
  const el = $('sample-status');
  if (s?.spaceKey || (s?.formularyIds?.length ?? 0) > 0 || (s?.pageIds?.length ?? 0) > 0) {
    const parts = [];
    if (s.spaceKey) parts.push(`Space ${s.spaceKey}`);
    if (s.pageIds?.length) parts.push(`${s.pageIds.length} sample pages`);
    if (s.formularyIds?.length) parts.push(`${s.formularyIds.length} sample drugs`);
    el.textContent = `Loaded: ${parts.join(' · ')}`;
  } else {
    el.textContent = 'Sample hospital is not currently loaded.';
  }
}

/* ---------- Client-Side Formulary CSV Parser ---------- */

function parseCsvLine(line) {
  const cols = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      cols.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  cols.push(cur.trim());
  return cols;
}

function extractIngredientNames(displayName) {
  const cleaned = displayName
    .toLowerCase()
    .replace(/\b\d[\d.,]*\s*(mg|mcg|g|kg|ml|l|meq|mmol|units?|iu|%)\b(\s*\/\s*\d*[\d.,]*\s*(mg|mcg|g|ml|l|hr|h))?/gi, ' ')
    .replace(/\b(in\s+dextrose|in\s+sodium\s+chloride|in\s+water|premix|injection|injectable|solution|suspension|tablet|tablets|capsule|capsules|cream|ointment|gel|patch|vial|syringe|bag|iv|im|oral|topical|ophthalmic)\b/gi, ' ')
    .replace(/[^a-z0-9/\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const parts = cleaned
    .split('/')
    .map((p) => p.trim())
    .filter((p) => p.length >= 2);

  if (parts.length) return [...new Set(parts)];
  return [displayName.toLowerCase().trim()].filter(Boolean);
}

function slugify(str) {
  return String(str)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 36);
}

function parseFormularyCsv(text) {
  const lines = String(text ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const items = [];
  const seenIds = new Set();

  for (let i = 0; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i]);
    const name = (cols[0] ?? '').trim();
    if (!name) continue;

    // Skip obvious header row
    if (
      i === 0 &&
      /^(drug|name|display[_\s]?name|medication|product|generic[_\s]?name)$/i.test(name) &&
      (!cols[1] || /^(ndc|package[_\s]?ndc|ndcs?)$/i.test(cols[1]))
    ) {
      continue;
    }

    const ndcCol = (cols[1] ?? '').trim();
    const formCol = (cols[2] ?? '').trim();

    const packageNdcs = ndcCol
      ? ndcCol
          .split(/[;|]/)
          .map((x) => x.trim())
          .filter(Boolean)
      : [];

    const dosageForms = formCol
      ? formCol
          .split(/[;|]/)
          .map((x) => x.trim().toLowerCase())
          .filter(Boolean)
      : [];

    const baseSlug = slugify(name) || `item-${i + 1}`;
    const ndcPart = packageNdcs[0] ? `-${packageNdcs[0].replace(/\D/g, '').slice(-6)}` : '';
    let id = `csv-${baseSlug}${ndcPart}`;
    let n = 2;
    while (seenIds.has(id)) {
      id = `csv-${baseSlug}${ndcPart}-${n++}`;
    }
    seenIds.add(id);

    items.push({
      id,
      displayName: name,
      ingredientNames: extractIngredientNames(name),
      ingredientRxcuis: [],
      packageNdcs,
      dosageForms,
    });
  }

  return items;
}

function updateCsvPreview() {
  const items = parseFormularyCsv($('csv-textarea').value);
  state.parsedCsvItems = items;
  $('btn-import-csv').disabled = items.length === 0;

  if (!items.length) {
    $('csv-preview').textContent = 'Paste rows or upload a CSV to preview parsed formulary items.';
    return;
  }

  const withNdc = items.filter((i) => i.packageNdcs.length > 0).length;
  const withForm = items.filter((i) => i.dosageForms.length > 0).length;
  const sampleNames = items
    .slice(0, 4)
    .map((i) => i.displayName)
    .join(', ');
  const more = items.length > 4 ? ` + ${items.length - 4} more` : '';
  $('csv-preview').innerHTML = `<strong>${items.length} formulary item${items.length === 1 ? '' : 's'} ready</strong> (${withNdc} with NDC, ${withForm} with dosage form)<br><span style="color:var(--sf-text-subtlest);">${esc(sampleNames)}${esc(more)}</span>`;
}

/* ---------- Slide-Over Detail Drawer ---------- */

async function openDrawer(shortageKey, triggerEl) {
  state.openDrawerKey = shortageKey;
  if (triggerEl) state.lastFocusedEl = triggerEl;

  const backdrop = $('drawer-backdrop');
  backdrop.hidden = false;
  $('drawer-badges').innerHTML = '';
  $('drawer-title').textContent = 'Loading shortage detail…';
  $('drawer-pres').textContent = '';
  $('drawer-body').innerHTML = '<p style="color:var(--sf-text-subtle);">Fetching FDA record, impact map, and response history…</p>';

  const drawerEl = backdrop.querySelector('.drawer');
  drawerEl.focus();

  try {
    const detail = await invoke('getShortageDetail', { shortageKey });
    if (state.openDrawerKey !== shortageKey) return;
    renderDrawer(shortageKey, detail);
  } catch (e) {
    if (state.openDrawerKey !== shortageKey) return;
    $('drawer-title').textContent = 'Failed to load shortage';
    $('drawer-body').innerHTML = `<div class="banner banner-reduced"><div>${esc(e?.message ?? e)}</div></div>`;
  }
}

function closeDrawer() {
  state.openDrawerKey = null;
  $('drawer-backdrop').hidden = true;
  if (state.lastFocusedEl && typeof state.lastFocusedEl.focus === 'function') {
    state.lastFocusedEl.focus();
  }
  state.lastFocusedEl = null;
}

function renderImpactList(items, isGraph) {
  if (!items.length) return '';
  return `<ul class="item-list">${items
    .map((item) => {
      const href = resolveUrl(item.url || '');
      const titleHtml = href
        ? `<a href="${esc(href)}"><strong>${esc(item.title || item.ref_id || 'Untitled')}</strong></a>`
        : `<strong>${esc(item.title || item.ref_id || 'Untitled')}</strong>`;

      const metaBadges = [];
      if (isGraph) metaBadges.push('<span class="chip-graph">2nd-hop Graph</span>');
      if (item.space_key) metaBadges.push(`<span class="chip-meta">${esc(item.space_key)}</span>`);
      if (item.kind) metaBadges.push(`<span class="chip-meta">${esc(item.kind)}</span>`);
      if (item.owner_name) metaBadges.push(`<span>Owner: <strong>${esc(item.owner_name)}</strong></span>`);
      if (item.team_name) metaBadges.push(`<span class="chip-meta">Team: ${esc(item.team_name)}</span>`);
      if (item.found_via) metaBadges.push(`<span class="mono" style="font-size:10.5px;">via ${esc(item.found_via)}</span>`);

      return `
        <li class="item-card ${isGraph ? 'is-graph' : ''}">
          <div class="item-card-top">${titleHtml}</div>
          <div class="item-card-meta">${metaBadges.join('')}</div>
        </li>`;
    })
    .join('')}</ul>`;
}

function renderDrawer(shortageKey, detail) {
  const s = detail?.shortage ?? {};
  const genericName = s.generic_name ?? s.genericName ?? shortageKey;
  const presentation = s.presentation ?? '';
  const packageNdc = s.package_ndc ?? s.packageNdc ?? '';
  const status = s.status ?? 'Unknown';
  const company = s.company_name ?? s.company ?? '—';
  const dosageForm = s.dosage_form ?? s.dosageForm ?? '—';
  const availability = s.availability ?? '—';
  const updateDate = s.update_date ?? s.updateDate ?? '—';
  const initialDate = s.initial_posting_date ?? s.initialPostingDate ?? '—';
  const relatedInfo = s.related_info ?? s.relatedInfo ?? '';
  const srcUrl = fdaSourceUrl(detail?.source, packageNdc);

  $('drawer-badges').innerHTML = `
    ${statusSticker(status)}
    <a class="chip-meta" href="${esc(srcUrl)}" title="Open openFDA source record">NDC ${esc(packageNdc || shortageKey)}</a>`;
  $('drawer-title').textContent = genericName;
  $('drawer-pres').textContent = presentation;

  // Status history
  const history = Array.isArray(detail?.statusHistory) ? detail.statusHistory : [];
  const historyHtml = history.length
    ? `<div style="margin-top:10px;">
        <div class="impact-subhead">Status History</div>
        <ol class="timeline">
          ${history
            .map(
              (h) =>
                `<li>${h.from ? `<span class="mono">${esc(h.from)}</span> &rarr; ` : ''}${statusSticker(h.to)} <span class="mono" style="margin-left:6px;font-size:11px;color:var(--sf-text-subtlest);">${esc(formatDateTime(h.at))}</span></li>`,
            )
            .join('')}
        </ol>
      </div>`
    : '';

  // Matched formulary items
  const matches = Array.isArray(detail?.matches) ? detail.matches : [];
  const matchesHtml = matches.length
    ? `<div style="margin-top:10px;display:flex;flex-wrap:wrap;gap:6px;align-items:center;">
        <span class="mono" style="font-size:10.5px;color:var(--sf-text-subtlest);text-transform:uppercase;">Matched Formulary:</span>
        ${matches
          .map(
            (m) =>
              `<span class="chip-meta">${esc(m.display_name ?? m.displayName ?? m.formulary_item_id ?? '')} ${m.reason ? `(${esc(m.reason)})` : ''}</span>`,
          )
          .join('')}
      </div>`
    : '';

  // Impact Map split into Direct (hop 1) vs 2nd-hop Teamwork Graph (hop 2)
  const impact = Array.isArray(detail?.impact) ? detail.impact : [];
  const directItems = impact.filter((i) => !isSecondHop(i));
  const graphItems = impact.filter((i) => isSecondHop(i));

  let impactHtml = '';
  if (!impact.length) {
    impactHtml = `<p style="margin:0;color:var(--sf-text-subtle);font-size:12.5px;">No affected Confluence protocols or Jira work items recorded for this presentation yet. Run Sync or Enrich owners &amp; links.</p>`;
  } else {
    impactHtml = `
      <div class="impact-subhead">Direct Mentions <span class="chip-meta">${directItems.length}</span></div>
      ${
        directItems.length
          ? renderImpactList(directItems, false)
          : '<p style="margin:0 0 8px;color:var(--sf-text-subtlest);font-size:12px;">No direct CQL/JQL mentions.</p>'
      }
      <div class="impact-subhead" style="margin-top:12px;">2nd-Hop Linked Protocols via Teamwork Graph <span class="chip-graph">${graphItems.length}</span></div>
      ${
        graphItems.length
          ? renderImpactList(graphItems, true)
          : '<p style="margin:0;color:var(--sf-text-subtlest);font-size:12px;">No 2nd-hop linked protocols discovered yet. Press Enrich owners &amp; links on the dashboard.</p>'
      }`;
  }

  // Response & Owner Tasks
  const resp = detail?.response ?? null;
  const responseHtml = resp
    ? `<div class="item-card">
        <div class="item-card-top">
          <a class="chip-issue" href="${esc(jiraIssueUrl(resp.jira_issue_key))}">${esc(resp.jira_issue_key)}</a>
          <span class="chip-meta">${esc(resp.state || 'open')}</span>
        </div>
        <div class="item-card-meta">
          <span>Opened: <strong class="mono">${esc(formatDateTime(resp.opened_at))}</strong></span>
          ${resp.resolved_at ? `<span>Resolved: <strong class="mono">${esc(formatDateTime(resp.resolved_at))}</strong></span>` : ''}
        </div>
        ${resp.decision_summary ? `<p style="margin:8px 0 0;font-size:12.5px;">${esc(resp.decision_summary)}</p>` : ''}
      </div>`
    : `<div class="item-card">
        <p style="margin:0 0 10px;font-size:12.5px;color:var(--sf-text-subtle);">No Jira response work item opened yet. Creating a response requires explicit confirmation unless auto-create is enabled in Setup.</p>
        <button type="button" class="btn btn-primary btn-sm" id="drawer-create-response" data-shortage-key="${esc(shortageKey)}">Create Jira Response + Owner Tasks</button>
      </div>`;

  // Temporary Changes & Reversal
  const tempChanges = Array.isArray(detail?.temporaryChanges) ? detail.temporaryChanges : [];
  const tempListHtml = tempChanges.length
    ? `<ul class="item-list">${tempChanges
        .map((tc) => {
          const isOpen = tc.state !== 'reversed';
          return `
            <li class="item-card">
              <div class="item-card-top">
                <span style="font-weight:500;">${esc(tc.description)}</span>
                <div style="display:flex;align-items:center;gap:6px;">
                  ${isOpen ? '<span class="sticker sticker-current">Open</span>' : '<span class="sticker sticker-resolved">Reversed</span>'}
                  ${
                    isOpen
                      ? `<button type="button" class="btn btn-sm btn-teal" data-mark-reversed="${esc(tc.id)}">Mark reversed</button>`
                      : ''
                  }
                </div>
              </div>
              <div class="item-card-meta">
                <span>Logged <span class="mono">${esc(formatDateTime(tc.created_at))}</span></span>
                ${tc.reversed_at ? `<span>Reversed <span class="mono">${esc(formatDateTime(tc.reversed_at))}</span></span>` : ''}
                ${
                  tc.reversal_issue_key
                    ? `<a class="chip-issue" href="${esc(jiraIssueUrl(tc.reversal_issue_key))}">Reversal: ${esc(tc.reversal_issue_key)}</a>`
                    : ''
                }
              </div>
            </li>`;
        })
        .join('')}</ul>`
    : '<p style="margin:0;color:var(--sf-text-subtlest);font-size:12.5px;">No temporary protocol or stock changes logged.</p>';

  const tempFormHtml = resp
    ? `<form id="drawer-temp-form" class="inline-form" data-response-id="${esc(resp.id)}">
        <input type="text" id="drawer-temp-input" class="input" placeholder="Log temporary change (e.g., restrict premix bags to OR cases)…" aria-label="Temporary change description" required>
        <button type="submit" class="btn btn-sm btn-primary">+ Log change</button>
      </form>`
    : '<p style="margin:8px 0 0;font-size:11.5px;color:var(--sf-text-subtlest);">Open a Jira response first to log temporary changes for reversal tracking.</p>';

  // Seen Before (Past Decisions)
  const past = Array.isArray(detail?.pastResponses) ? detail.pastResponses : [];
  const pastHtml = past.length
    ? `<ul class="item-list">${past
        .map(
          (p) => `
          <li class="item-card">
            <div class="item-card-top">
              <div style="display:flex;align-items:center;gap:6px;">
                <a class="chip-issue" href="${esc(jiraIssueUrl(p.jira_issue_key))}">${esc(p.jira_issue_key)}</a>
                ${p.ingredient ? `<span class="mono" style="font-size:11px;color:var(--sf-text-subtle);">${esc(p.ingredient)}</span>` : ''}
              </div>
              <span class="chip-meta">${esc(p.state || 'closed')}</span>
            </div>
            <div class="item-card-meta">
              <span>Opened <span class="mono">${esc(formatDateTime(p.opened_at))}</span></span>
              ${p.resolved_at ? `<span>Resolved <span class="mono">${esc(formatDateTime(p.resolved_at))}</span></span>` : ''}
            </div>
            <p style="margin:6px 0 0;font-size:12.5px;color:var(--sf-text);">${esc(p.decision_summary || 'No decision summary recorded.')}</p>
          </li>`,
        )
        .join('')}</ul>`
    : '<p style="margin:0;color:var(--sf-text-subtlest);font-size:12.5px;">No prior responses recorded for this ingredient.</p>';

  $('drawer-body').innerHTML = `
    <section class="drawer-section">
      <h3 class="drawer-section-title">
        <span>FDA Shortage Facts</span>
        <a href="https://dps.fda.gov/drugshortages">FDA Drug Shortages Database &rarr;</a> ·
        <a href="${esc(srcUrl)}">openFDA record (raw data) &rarr;</a>
      </h3>
      <dl class="fact-grid">
        <div class="fact-item"><dt>Package NDC</dt><dd class="mono"><a href="${esc(srcUrl)}">${esc(packageNdc || '—')}</a></dd></div>
        <div class="fact-item"><dt>Dosage Form</dt><dd>${esc(dosageForm)}</dd></div>
        <div class="fact-item"><dt>Company</dt><dd>${esc(company)}</dd></div>
        <div class="fact-item"><dt>Availability</dt><dd>${esc(availability)}</dd></div>
        <div class="fact-item"><dt>Initial Posting</dt><dd class="mono">${esc(initialDate)}</dd></div>
        <div class="fact-item"><dt>Last Updated</dt><dd class="mono">${esc(updateDate)}</dd></div>
      </dl>
      ${relatedInfo ? `<p style="margin:8px 0 0;font-size:12.5px;color:var(--sf-text-subtle);"><strong>Related info:</strong> ${esc(relatedInfo)}</p>` : ''}
      ${matchesHtml}
      ${historyHtml}
    </section>

    <section class="drawer-section">
      <h3 class="drawer-section-title"><span>Impact Map</span><span class="mono">${impact.length} total</span></h3>
      ${impactHtml}
    </section>

    <section class="drawer-section">
      <h3 class="drawer-section-title"><span>Response &amp; Owner Tasks</span></h3>
      ${responseHtml}
    </section>

    <section class="drawer-section">
      <h3 class="drawer-section-title"><span>Temporary Changes &amp; Reversal</span><span class="mono">${tempChanges.length}</span></h3>
      ${tempListHtml}
      ${tempFormHtml}
    </section>

    <section class="drawer-section">
      <h3 class="drawer-section-title"><span>Seen Before (Past Decisions)</span><span class="mono">${past.length}</span></h3>
      ${pastHtml}
    </section>`;

  $('drawer-foot').textContent = detail?.disclaimer || OPENFDA_DISCLAIMER;
}

/* ---------- Data Loading & Sync Polling ---------- */

async function loadSetupOptions() {
  try {
    state.setupOptions = await invoke('getSetupOptions');
    renderSetupOptions();
  } catch (e) {
    showToast(`Could not load spaces/projects: ${e?.message ?? e}`, true);
  }
}

async function refresh() {
  const [dash, matches, syncLog, sample] = await Promise.all([
    invoke('getDashboardData'),
    invoke('getMatchedShortages'),
    invoke('getSyncLog'),
    invoke('getSampleState').catch(() => null),
  ]);

  state.dash = dash ?? {};
  state.matches = Array.isArray(matches) ? matches : [];
  state.syncLog = Array.isArray(syncLog) ? syncLog : [];
  state.sample = sample;

  if (dash?.siteUrl) setSiteUrl(dash.siteUrl);

  renderHeaderAndKpis();
  renderShortages();
  renderSyncLog();
  renderSampleState();

  if (!state.initialTabChosen) {
    state.initialTabChosen = true;
    if (!state.dash.setupComplete && Number(state.dash.formularyCount ?? 0) === 0) {
      selectTab('setup');
    }
  } else if (state.activeTab === 'setup' && !state.setupOptions) {
    loadSetupOptions();
  }
}

async function pollProgress() {
  if (state.pollTimer) {
    clearTimeout(state.pollTimer);
    state.pollTimer = null;
  }
  try {
    const p = await invoke('getSyncProgress');
    if (p?.state === 'running' || p?.state === 'queued') {
      $('progress-banner').hidden = false;
      const prog = p.progress;
      let label = p.state === 'queued' ? 'Queued…' : 'Running…';
      if (prog && typeof prog === 'object') {
        const parts = [];
        if (prog.stage) parts.push(prog.stage);
        if (prog.done != null && prog.total != null) parts.push(`${prog.done}/${prog.total}`);
        else if (prog.fetched != null) parts.push(`${prog.fetched} fetched`);
        if (prog.matched != null) parts.push(`${prog.matched} matched`);
        if (parts.length) label = parts.join(' · ');
      } else if (typeof prog === 'string' && prog) {
        label = prog;
      }
      $('progress-detail').textContent = label;
      state.pollTimer = setTimeout(pollProgress, 2500);
    } else {
      const wasVisible = !$('progress-banner').hidden;
      $('progress-banner').hidden = true;
      if (wasVisible) {
        await refresh();
      }
    }
  } catch {
    $('progress-banner').hidden = true;
  }
}

/* ---------- Event Listeners ---------- */

$('toast-close').addEventListener('click', hideToast);

// Header actions
$('btn-sync').addEventListener('click', async () => {
  const btn = $('btn-sync');
  btn.disabled = true;
  btn.textContent = 'Starting sync…';
  try {
    await invoke('startSync');
    showToast('FDA shortage sync queued. Progress will update automatically.');
    await pollProgress();
    setTimeout(() => refresh().catch(() => {}), 1500);
  } catch (e) {
    showToast(`Sync failed to start: ${e?.message ?? e}`, true);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Sync now';
  }
});

$('btn-enrich').addEventListener('click', async () => {
  const btn = $('btn-enrich');
  const orig = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Enriching via Teamwork Graph…';
  try {
    const r = await invoke('enrichImpact');
    const owners = r?.enrichedOwners ?? r?.enriched ?? 0;
    const linked = r?.discoveredLinkedPages ?? 0;
    const missing = Array.isArray(r?.missing) ? r.missing : [];
    let msg = `Teamwork Graph enrichment complete: ${owners} owner${owners === 1 ? '' : 's'} resolved, ${linked} 2nd-hop linked protocol${linked === 1 ? '' : 's'} discovered.`;
    if (missing.length) msg += ` Missing capabilities: ${missing.join(', ')}.`;
    showToast(msg, missing.length > 0 && owners === 0 && linked === 0);
    await refresh();
    if (state.openDrawerKey) openDrawer(state.openDrawerKey);
  } catch (e) {
    showToast(`Teamwork Graph enrichment failed: ${e?.message ?? e}`, true);
  } finally {
    btn.disabled = false;
    btn.textContent = orig;
  }
});

$('btn-rovo').addEventListener('click', async () => {
  const btn = $('btn-rovo');
  btn.disabled = true;
  try {
    await rovo.open({
      type: 'forge',
      agentKey: 'shortage-agent',
      agentName: 'Shortfall',
      prompt: 'What does the cefazolin shortage affect, what did we do last time, and which temporary changes still need to be reversed?',
    });
  } catch {
    showToast(
      'Open Rovo Chat and select "Shortfall" from the agent picker to query shortages, impact maps, and pending reversals.',
      true,
    );
  } finally {
    btn.disabled = false;
  }
});

$('btn-reversals').addEventListener('click', async () => {
  const btn = $('btn-reversals');
  btn.disabled = true;
  btn.textContent = 'Opening reversal tasks…';
  try {
    const r = await invoke('runReversalCheck');
    const opened = Number(r?.opened ?? 0);
    const errs = Array.isArray(r?.errors) ? r.errors : [];
    showToast(
      errs.length
        ? `Opened ${opened} reversal task(s) with warnings: ${errs.join('; ')}`
        : `Opened ${opened} reversal task${opened === 1 ? '' : 's'} for resolved shortages.`,
      errs.length > 0 && opened === 0,
    );
    await refresh();
  } catch (e) {
    showToast(`Reversal check failed: ${e?.message ?? e}`, true);
  } finally {
    btn.disabled = false;
    renderHeaderAndKpis();
  }
});

// Status filter pills
document.querySelectorAll('.pill-btn[data-status]').forEach((btn) => {
  btn.addEventListener('click', () => {
    state.statusFilter = btn.dataset.status;
    document.querySelectorAll('.pill-btn[data-status]').forEach((b) => {
      b.setAttribute('aria-pressed', b === btn ? 'true' : 'false');
    });
    renderShortages();
  });
});

// Search input
$('search-input').addEventListener('input', (e) => {
  state.searchQuery = e.target.value;
  renderShortages();
});

// Shortages container click delegation (Inspect button, row click, empty-state buttons)
$('shortages-container').addEventListener('click', (e) => {
  const emptyBtn = e.target.closest('[data-empty-action]');
  if (emptyBtn) {
    const act = emptyBtn.dataset.emptyAction;
    if (act === 'sync') $('btn-sync').click();
    else if (act === 'goto-setup') selectTab('setup', true);
    else if (act === 'reset-filters') {
      state.statusFilter = 'All';
      state.searchQuery = '';
      $('search-input').value = '';
      document.querySelectorAll('.pill-btn[data-status]').forEach((b) => {
        b.setAttribute('aria-pressed', b.dataset.status === 'All' ? 'true' : 'false');
      });
      renderShortages();
    }
    return;
  }

  if (e.target.closest('a[href]')) return;

  const inspectBtn = e.target.closest('[data-inspect]');
  if (inspectBtn) {
    openDrawer(inspectBtn.dataset.inspect, inspectBtn);
    return;
  }

  const row = e.target.closest('tr.shortage-row[data-shortage-key]');
  if (row) {
    openDrawer(row.dataset.shortageKey, row);
  }
});

// Drawer close controls + Escape
$('drawer-close').addEventListener('click', closeDrawer);
$('drawer-backdrop').addEventListener('click', (e) => {
  if (e.target === $('drawer-backdrop')) closeDrawer();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && state.openDrawerKey) {
    e.preventDefault();
    closeDrawer();
  }
});

// Drawer interactive actions (createResponse, markChangeReversed, addTemporaryChange)
$('drawer-body').addEventListener('click', async (e) => {
  const createBtn = e.target.closest('#drawer-create-response');
  if (createBtn) {
    const shortageKey = createBtn.dataset.shortageKey;
    createBtn.disabled = true;
    createBtn.textContent = 'Creating Jira response…';
    try {
      const r = await invoke('createResponse', { shortageKey });
      if (r?.error) {
        showToast(`Could not create response: ${r.error}`, true);
      } else {
        const tasks = Array.isArray(r?.ownerTasks) ? r.ownerTasks.length : Number(r?.ownerTasks ?? 0);
        showToast(
          `Opened Jira response ${r?.issueKey ?? ''}${tasks > 0 ? ` and ${tasks} owner task${tasks === 1 ? '' : 's'}` : ''}.`,
        );
      }
      await Promise.all([refresh(), openDrawer(shortageKey)]);
    } catch (err) {
      showToast(`Failed to create response: ${err?.message ?? err}`, true);
      createBtn.disabled = false;
      createBtn.textContent = 'Create Jira Response + Owner Tasks';
    }
    return;
  }

  const revBtn = e.target.closest('[data-mark-reversed]');
  if (revBtn) {
    const changeId = Number(revBtn.dataset.markReversed);
    revBtn.disabled = true;
    revBtn.textContent = 'Marking…';
    try {
      await invoke('markChangeReversed', { changeId });
      showToast('Temporary change marked as reversed.');
      await Promise.all([refresh(), openDrawer(state.openDrawerKey)]);
    } catch (err) {
      showToast(`Could not mark reversed: ${err?.message ?? err}`, true);
      revBtn.disabled = false;
      revBtn.textContent = 'Mark reversed';
    }
  }
});

$('drawer-body').addEventListener('submit', async (e) => {
  const form = e.target.closest('#drawer-temp-form');
  if (!form) return;
  e.preventDefault();
  const input = $('drawer-temp-input');
  const description = input.value.trim();
  if (!description) return;
  const responseId = Number(form.dataset.responseId);
  const btn = form.querySelector('button[type="submit"]');
  btn.disabled = true;
  btn.textContent = 'Logging…';
  try {
    await invoke('addTemporaryChange', { responseId, description });
    showToast('Temporary change logged for reversal tracking.');
    await Promise.all([refresh(), openDrawer(state.openDrawerKey)]);
  } catch (err) {
    showToast(`Could not log temporary change: ${err?.message ?? err}`, true);
    btn.disabled = false;
    btn.textContent = '+ Log change';
  }
});

// Setup: Save Settings
$('settings-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('btn-save-settings');
  btn.disabled = true;
  btn.textContent = 'Saving…';
  try {
    const spaceBoxes = Array.from(document.querySelectorAll('input[name="clinicalSpace"]'));
    const patch = {
      responseProjectKey: $('select-project').value || '',
      autoCreateResponses: $('chk-autocreate').checked,
      openfdaApiKey: $('input-fda-key').value.trim(),
      setupComplete: true,
    };
    if (spaceBoxes.length) {
      patch.clinicalSpaceKeys = spaceBoxes.filter((c) => c.checked).map((c) => c.value);
    }
    await invoke('saveSettings', patch);
    showToast('Clinical scope and response settings saved.');
    await Promise.all([refresh(), loadSetupOptions()]);
  } catch (err) {
    showToast(`Failed to save settings: ${err?.message ?? err}`, true);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save settings';
  }
});

// Setup: CSV upload & textarea live parser
$('csv-file-input').addEventListener('change', (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    $('csv-textarea').value = String(reader.result ?? '');
    updateCsvPreview();
  };
  reader.readAsText(file);
  e.target.value = '';
});

$('csv-textarea').addEventListener('input', updateCsvPreview);

$('btn-csv-example').addEventListener('click', () => {
  $('csv-textarea').value = [
    'name, ndc, dosage_form',
    'cefazolin in dextrose 2 g/100 mL premix, 0338-3508-41, injection',
    'ropivacaine HCl injection, 70069-062-25, injection',
    'rocuronium bromide injection, 25021-687-05, injection',
    'lidocaine HCl injection, , injection',
  ].join('\n');
  updateCsvPreview();
});

$('btn-clear-csv').addEventListener('click', () => {
  $('csv-textarea').value = '';
  updateCsvPreview();
});

$('btn-import-csv').addEventListener('click', async () => {
  if (!state.parsedCsvItems.length) return;
  const btn = $('btn-import-csv');
  btn.disabled = true;
  btn.textContent = 'Importing…';
  try {
    const r = await invoke('importFormulary', { items: state.parsedCsvItems });
    const n = r?.imported ?? state.parsedCsvItems.length;
    showToast(`Imported ${n} formulary item${n === 1 ? '' : 's'}. Press Sync now to match against FDA shortages.`);
    $('csv-textarea').value = '';
    updateCsvPreview();
    await Promise.all([refresh(), loadSetupOptions()]);
  } catch (err) {
    showToast(`Formulary import failed: ${err?.message ?? err}`, true);
  } finally {
    btn.textContent = 'Import drug list';
    btn.disabled = state.parsedCsvItems.length === 0;
  }
});

// Setup: Sample Hospital
$('btn-load-sample').addEventListener('click', async () => {
  const btn = $('btn-load-sample');
  btn.disabled = true;
  btn.textContent = 'Loading sample hospital…';
  try {
    const r = await invoke('loadSampleHospital');
    const totalPages = r?.pageIds?.length ?? 0;
    const created = Number(r?.createdPages ?? 0);
    const updated = Number(r?.updatedPages ?? 0);
    const reused = Number(r?.reusedPages ?? 0);
    const drugs = r?.formularyCount ?? 0;
    const warnings = Array.isArray(r?.warnings) ? r.warnings : [];
    const detailParts = [];
    if (created > 0) detailParts.push(`${created} created`);
    if (updated > 0) detailParts.push(`${updated} updated`);
    if (reused > 0) detailParts.push(`${reused} reused`);
    const pageDetail = detailParts.length ? ` (${detailParts.join(', ')})` : '';
    if (warnings.length > 0) {
      showToast(
        `Sample hospital ${r?.spaceKey ?? 'SHOSP'} loaded with ${warnings.length} issue${warnings.length === 1 ? '' : 's'}: ${cleanUserError(warnings[0])}`,
        true,
      );
    } else {
      showToast(
        `Sample hospital ready in ${r?.spaceKey ?? 'SHOSP'}: ${totalPages} protocol pages${pageDetail} and ${drugs} formulary items.`,
      );
    }
    await Promise.all([refresh(), loadSetupOptions()]);
  } catch (err) {
    showToast(`Could not load sample hospital: ${cleanUserError(err)}`, true);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Load sample hospital';
  }
});

$('btn-remove-sample').addEventListener('click', async () => {
  const btn = $('btn-remove-sample');
  btn.disabled = true;
  btn.textContent = 'Removing sample hospital…';
  try {
    const r = await invoke('removeSampleHospital');
    const warnings = Array.isArray(r?.warnings) ? r.warnings : [];
    if (warnings.length > 0) {
      showToast(
        `Removed sample hospital with ${warnings.length} warning${warnings.length === 1 ? '' : 's'}: ${cleanUserError(warnings[0])}`,
        true,
      );
    } else {
      showToast(`Removed sample hospital (${r?.removedPages ?? 0} pages, ${r?.removedFormulary ?? 0} formulary items).`);
    }
    await Promise.all([refresh(), loadSetupOptions()]);
  } catch (err) {
    showToast(`Could not remove sample hospital: ${cleanUserError(err)}`, true);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Remove sample hospital';
  }
});

/* ---------- Startup ---------- */

(async function init() {
  try {
    await view.theme.enable();
  } catch {
    // Non-fatal fallback to CSS custom property defaults
  }

  try {
    const ctx = await view.getContext();
    if (ctx?.siteUrl) setSiteUrl(ctx.siteUrl);
  } catch {
    // siteUrl will also be populated from getDashboardData
  }

  try {
    await refresh();
    await pollProgress();
  } catch (e) {
    showToast(`Failed to load Shortfall dashboard: ${e?.message ?? e}`, true);
    $('shortages-container').innerHTML = `<div class="empty-state">${SHELF_GAP_SVG}<h3>Could not load dashboard</h3><p>${esc(e?.message ?? e)}</p></div>`;
  }
})();
