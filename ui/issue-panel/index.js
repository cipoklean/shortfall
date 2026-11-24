import { invoke, view, router } from '@forge/bridge';

const OPENFDA_DISCLAIMER =
  'Do not rely on openFDA to make decisions regarding medical care. While we make every effort to ensure that data is accurate, you should assume all results are unvalidated. We may limit or otherwise restrict your access to the API in line with our Terms of Service.';

const SHELF_GAP_SVG = `<svg viewBox="0 0 40 40" aria-hidden="true"><rect x="9" y="7" width="22" height="26" fill="none" stroke="#d9820b" stroke-width="2.6" stroke-dasharray="5 3.5"/><line x1="4" y1="36" x2="36" y2="36" stroke="currentColor" stroke-width="3"/></svg>`;

const el = document.getElementById('panel');
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));

let siteUrl = '';
let issueKey = '';
let flashMessage = null;

function setSiteUrl(url) {
  if (!url) return;
  siteUrl = String(url).replace(/\/+$/, '');
}

function resolveUrl(href) {
  if (!href) return '';
  const raw = String(href).trim();
  if (/^https?:\/\//i.test(raw)) return raw;
  if (raw.startsWith('/')) return siteUrl ? `${siteUrl}${raw}` : raw;
  return raw;
}

function jiraIssueUrl(key) {
  return resolveUrl(`/browse/${encodeURIComponent(key)}`);
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
  const target = resolveUrl(href);
  if (target) router.open(target);
});

function statusSticker(status) {
  const s = status || 'Unknown';
  let cls = 'sticker-plain';
  if (s === 'Current') cls = 'sticker-current';
  else if (s === 'To Be Discontinued') cls = 'sticker-discontinued';
  else if (s === 'Resolved') cls = 'sticker-resolved';
  return `<span class="sticker ${cls}">${esc(s)}</span>`;
}

function formatDateTime(val) {
  if (!val) return '—';
  const str = String(val);
  const d = new Date(str);
  if (Number.isNaN(d.getTime())) return str;
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

function isSecondHop(item) {
  if (Number(item?.hop) === 2) return true;
  const via = String(item?.found_via ?? item?.foundVia ?? '').toLowerCase();
  return via.includes('graph') || via.includes('2nd') || via.includes('second') || via.includes('linked');
}

function renderImpactItems(items, isGraph) {
  if (!items.length) return '';
  return `<ul class="list">${items
    .map((i) => {
      const href = resolveUrl(i.url || '');
      const titleHtml = href
        ? `<a href="${esc(href)}"><strong>${esc(i.title || i.ref_id || 'Untitled')}</strong></a>`
        : `<strong>${esc(i.title || i.ref_id || 'Untitled')}</strong>`;

      const meta = [];
      if (isGraph) meta.push('<span class="chip-graph">2nd-hop Graph</span>');
      if (i.space_key) meta.push(`<span class="chip-meta">${esc(i.space_key)}</span>`);
      if (i.kind) meta.push(`<span class="chip-meta">${esc(i.kind)}</span>`);
      if (i.owner_name) meta.push(`<span>Owner: <strong>${esc(i.owner_name)}</strong></span>`);
      if (i.team_name) meta.push(`<span class="chip-meta">Team: ${esc(i.team_name)}</span>`);
      if (i.found_via) meta.push(`<span class="mono" style="font-size:10.5px;">via ${esc(i.found_via)}</span>`);

      return `
        <li class="item ${isGraph ? 'is-graph' : ''}">
          <div class="item-top">${titleHtml}</div>
          <div class="item-meta">${meta.join('')}</div>
        </li>`;
    })
    .join('')}</ul>`;
}

function render(data) {
  if (data?.siteUrl) setSiteUrl(data.siteUrl);

  if (!data?.found) {
    el.innerHTML = `
      <div class="empty">
        ${SHELF_GAP_SVG}
        <div>
          <strong>Not linked to a Shortfall shortage</strong>
          <div style="margin-top:2px;font-size:12px;">This work item is not tracked as a Shortfall FDA drug shortage response.</div>
        </div>
      </div>`;
    return;
  }

  const s = data.shortage ?? {};
  const genericName = s.generic_name ?? s.genericName ?? 'Shortage response';
  const presentation = s.presentation ?? '';
  const packageNdc = s.package_ndc ?? s.packageNdc ?? '';
  const status = s.status ?? 'Unknown';
  const company = s.company_name ?? s.company ?? '';
  const updateDate = s.update_date ?? s.updateDate ?? '';
  const availability = s.availability ?? '';
  const relatedInfo = s.related_info ?? s.relatedInfo ?? '';
  const srcUrl = fdaSourceUrl(data.source, packageNdc);

  const headTone =
    status === 'To Be Discontinued'
      ? 'is-discontinued'
      : status === 'Resolved'
        ? 'is-resolved'
        : '';

  // Impact Map
  const impact = Array.isArray(data.impact) ? data.impact : [];
  const direct = impact.filter((i) => !isSecondHop(i));
  const graph = impact.filter((i) => isSecondHop(i));

  let impactHtml = '';
  if (!impact.length) {
    impactHtml = `<p style="margin:0;color:var(--sf-text-subtlest);font-size:12px;">No affected Confluence protocols or work items recorded yet.</p>`;
  } else {
    impactHtml = `
      <div class="subhead">Direct Mentions <span class="chip-meta">${direct.length}</span></div>
      ${
        direct.length
          ? renderImpactItems(direct, false)
          : '<p style="margin:0;color:var(--sf-text-subtlest);font-size:11.5px;">No direct mentions.</p>'
      }
      <div class="subhead" style="margin-top:10px;">2nd-Hop Teamwork Graph <span class="chip-graph">${graph.length}</span></div>
      ${
        graph.length
          ? renderImpactItems(graph, true)
          : '<p style="margin:0;color:var(--sf-text-subtlest);font-size:11.5px;">No 2nd-hop linked protocols discovered yet.</p>'
      }`;
  }

  // Temporary Changes & Reversal
  const resp = data.response ?? null;
  const responseId = resp?.id ?? data.responseId ?? null;
  const tempChanges = Array.isArray(data.temporaryChanges) ? data.temporaryChanges : [];
  const tempHtml = tempChanges.length
    ? `<ul class="list">${tempChanges
        .map((tc) => {
          const isOpen = tc.state !== 'reversed';
          return `
            <li class="item">
              <div class="item-top">
                <span style="font-weight:500;">${esc(tc.description)}</span>
                <div style="display:flex;align-items:center;gap:6px;">
                  ${isOpen ? '<span class="sticker sticker-current">Open</span>' : '<span class="sticker sticker-resolved">Reversed</span>'}
                  ${
                    isOpen
                      ? `<button type="button" class="btn btn-teal" data-mark-reversed="${esc(tc.id)}">Mark reversed</button>`
                      : ''
                  }
                </div>
              </div>
              <div class="item-meta">
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
    : '<p style="margin:0;color:var(--sf-text-subtlest);font-size:12px;">No temporary changes logged yet.</p>';

  const tempFormHtml =
    responseId != null
      ? `<form id="temp-form" class="inline-form" data-response-id="${esc(responseId)}">
          <input type="text" id="temp-input" class="input" placeholder="Log temporary change for reversal tracking…" aria-label="Temporary change description" required>
          <button type="submit" class="btn btn-primary">+ Log change</button>
        </form>`
      : '';

  // Seen Before (Past Responses)
  const past = Array.isArray(data.pastResponses) ? data.pastResponses : [];
  const pastHtml = past.length
    ? `<ul class="list">${past
        .map(
          (p) => `
          <li class="item">
            <div class="item-top">
              <div style="display:flex;align-items:center;gap:6px;">
                <a class="chip-issue" href="${esc(jiraIssueUrl(p.jira_issue_key))}">${esc(p.jira_issue_key)}</a>
                ${p.ingredient ? `<span class="mono" style="font-size:11px;color:var(--sf-text-subtle);">${esc(p.ingredient)}</span>` : ''}
              </div>
              <span class="chip-meta">${esc(p.state || 'closed')}</span>
            </div>
            <div class="item-meta">
              <span>Opened <span class="mono">${esc(formatDateTime(p.opened_at))}</span></span>
              ${p.resolved_at ? `<span>Resolved <span class="mono">${esc(formatDateTime(p.resolved_at))}</span></span>` : ''}
            </div>
            <p style="margin:5px 0 0;font-size:12px;">${esc(p.decision_summary || 'No decision summary recorded.')}</p>
          </li>`,
        )
        .join('')}</ul>`
    : '<p style="margin:0;color:var(--sf-text-subtlest);font-size:12px;">No prior responses recorded for this ingredient.</p>';

  const noticeHtml = flashMessage
    ? `<div class="notice-bar ${flashMessage.isError ? 'is-error' : ''}" role="status">${esc(flashMessage.text)}</div>`
    : '';

  el.innerHTML = `
    <header class="panel-head ${headTone}">
      <div class="head-top">
        <div class="brand-inline">
          ${SHELF_GAP_SVG}
          ${statusSticker(status)}
        </div>
        <a class="chip-meta" href="https://dps.fda.gov/drugshortages" title="Open FDA Drug Shortages Database">FDA Shortages DB</a>
        <a class="chip-meta" href="${esc(srcUrl)}" title="Open openFDA record (raw data)">NDC ${esc(packageNdc || 'source')} (raw data) &rarr;</a>
      </div>
      <h2 class="drug-title">${esc(genericName)}</h2>
      ${presentation ? `<p class="drug-pres">${esc(presentation)}</p>` : ''}
      <div class="meta-strip">
        ${company ? `<span>Company: <strong>${esc(company)}</strong></span>` : ''}
        ${updateDate ? `<span>FDA updated: <strong class="mono">${esc(updateDate)}</strong></span>` : ''}
        ${availability ? `<span>Availability: <strong>${esc(availability)}</strong></span>` : ''}
      </div>
      ${relatedInfo ? `<p style="margin:6px 0 0;font-size:12px;color:var(--sf-text-subtle);"><strong>Related info:</strong> ${esc(relatedInfo)}</p>` : ''}
    </header>

    ${noticeHtml}

    <section class="section">
      <div class="section-head"><span>Impact Map</span><span class="mono">${impact.length}</span></div>
      ${impactHtml}
    </section>

    <section class="section">
      <div class="section-head"><span>Temporary Changes &amp; Reversal</span><span class="mono">${tempChanges.length}</span></div>
      ${tempHtml}
      ${tempFormHtml}
    </section>

    <section class="section">
      <div class="section-head"><span>Seen Before (Past Decisions)</span><span class="mono">${past.length}</span></div>
      ${pastHtml}
    </section>

    <p class="disclaimer">${esc(data.disclaimer || OPENFDA_DISCLAIMER)}</p>`;
}

async function loadPanel() {
  const data = await invoke('getIssuePanelData', { issueKey });
  render(data);
}

el.addEventListener('click', async (e) => {
  const revBtn = e.target.closest('[data-mark-reversed]');
  if (!revBtn) return;
  const changeId = Number(revBtn.dataset.markReversed);
  revBtn.disabled = true;
  revBtn.textContent = 'Marking…';
  try {
    await invoke('markChangeReversed', { changeId });
    flashMessage = { text: 'Temporary change marked as reversed.', isError: false };
    await loadPanel();
  } catch (err) {
    flashMessage = { text: `Could not mark reversed: ${err?.message ?? err}`, isError: true };
    await loadPanel().catch(() => {});
  }
});

el.addEventListener('submit', async (e) => {
  const form = e.target.closest('#temp-form');
  if (!form) return;
  e.preventDefault();
  const input = document.getElementById('temp-input');
  const description = input?.value.trim();
  if (!description) return;
  const responseId = Number(form.dataset.responseId);
  const btn = form.querySelector('button[type="submit"]');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Logging…';
  }
  try {
    await invoke('addTemporaryChange', { responseId, description });
    flashMessage = { text: 'Temporary change logged for reversal tracking.', isError: false };
    await loadPanel();
  } catch (err) {
    flashMessage = { text: `Could not log change: ${err?.message ?? err}`, isError: true };
    if (btn) {
      btn.disabled = false;
      btn.textContent = '+ Log change';
    }
  }
});

(async function init() {
  try {
    await view.theme.enable();
  } catch {
    // Fallback to CSS defaults
  }

  try {
    const ctx = await view.getContext();
    issueKey = ctx?.extension?.issue?.key ?? ctx?.issueKey ?? '';
    setSiteUrl(ctx?.siteUrl ?? '');
    await loadPanel();
  } catch (e) {
    el.innerHTML = `<div class="notice-bar is-error">Shortage panel failed to load: ${esc(e?.message ?? e)}</div>`;
  }
})();
