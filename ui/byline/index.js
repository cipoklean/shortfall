import { invoke, view, router } from '@forge/bridge';

const OPENFDA_DISCLAIMER =
  'Do not rely on openFDA to make decisions regarding medical care. While we make every effort to ensure that data is accurate, you should assume all results are unvalidated. We may limit or otherwise restrict your access to the API in line with our Terms of Service.';

const SHELF_GAP_SVG = `<svg viewBox="0 0 40 40" aria-hidden="true"><rect x="9" y="7" width="22" height="26" fill="none" stroke="#d9820b" stroke-width="2.6" stroke-dasharray="5 3.5"/><line x1="4" y1="36" x2="36" y2="36" stroke="currentColor" stroke-width="3"/></svg>`;

const el = document.getElementById('notice');
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));

let siteUrl = '';

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
  const s = status || 'Current';
  let cls = 'sticker-plain';
  if (s === 'Current') cls = 'sticker-current';
  else if (s === 'To Be Discontinued') cls = 'sticker-discontinued';
  else if (s === 'Resolved') cls = 'sticker-resolved';
  return `<span class="sticker ${cls}">${esc(s)}</span>`;
}

function isSecondHop(item) {
  if (Number(item?.hop) === 2 || item?.viaGraph === true || item?.linkedViaGraph === true) return true;
  const via = String(item?.found_via ?? item?.foundVia ?? '').toLowerCase();
  return via.includes('graph') || via.includes('2nd') || via.includes('second') || via.includes('linked');
}

(async function init() {
  try {
    await view.theme.enable();
  } catch {
    // Non-fatal fallback
  }

  try {
    const ctx = await view.getContext();
    const pageId = ctx?.extension?.content?.id;
    setSiteUrl(ctx?.siteUrl ?? '');

    const data = await invoke('getPageNotice', { pageId });
    if (data?.siteUrl) setSiteUrl(data.siteUrl);

    if (!data?.affected) {
      el.innerHTML = `
        <div class="empty">
          ${SHELF_GAP_SVG}
          <div>
            <strong>No active FDA shortage linked to this page</strong>
            <p>Shortfall checks clinical pages against FDA drug shortages matched to your hospital formulary.</p>
          </div>
        </div>`;
      return;
    }

    const shortages = Array.isArray(data.shortages) ? data.shortages : [];
    const anySecondHop = isSecondHop(data) || shortages.some((s) => isSecondHop(s));

    // Keep every distinct NDC presentation as its own card (never merge!)
    const cardsHtml = shortages
      .map((s) => {
        const name = s.genericName ?? s.generic_name ?? s.name ?? 'Matched shortage';
        const presentation = s.presentation ?? '';
        const ndc = s.packageNdc ?? s.package_ndc ?? '';
        const status = s.status ?? 'Current';
        const src = fdaSourceUrl(s.source, ndc);
        const hop2 = isSecondHop(s);
        const idLabel = ndc || s.shortageId || s.shortage_key || 'FDA record';

        return `
          <li class="pres-card ${hop2 ? 'is-graph' : ''}">
            <div class="pres-top">
              <span class="pres-name">${esc(name)}</span>
              ${statusSticker(status)}
            </div>
            ${presentation ? `<p class="pres-detail">${esc(presentation)}</p>` : ''}
            <div class="pres-meta">
              <a class="mono" href="${esc(src)}" title="Open openFDA source record">NDC ${esc(idLabel)} &rarr;</a>
              ${hop2 ? '<span class="chip-graph">2nd-hop Graph</span>' : ''}
            </div>
          </li>`;
      })
      .join('');

    // Jira response links (supports single responseWorkItem or array responses)
    const responseKeys = [];
    if (data.responseWorkItem) responseKeys.push(data.responseWorkItem);
    if (Array.isArray(data.responses)) {
      for (const r of data.responses) {
        const k = typeof r === 'string' ? r : r?.jira_issue_key ?? r?.issueKey;
        if (k && !responseKeys.includes(k)) responseKeys.push(k);
      }
    }

    const responseHtml = responseKeys.length
      ? `<div class="section-box">
          <span class="section-label">Jira Shortage Response</span>
          <div style="display:flex;flex-wrap:wrap;gap:6px;">
            ${responseKeys
              .map((k) => `<a class="chip-issue" href="${esc(jiraIssueUrl(k))}">${esc(k)} &rarr;</a>`)
              .join('')}
          </div>
        </div>`
      : `<div class="section-box">
          <span class="section-label">Jira Shortage Response</span>
          <span style="font-size:12px;color:var(--sf-text-subtle);">No Jira response work item opened yet.</span>
        </div>`;

    // Open temporary changes (handle array or count + temporaryChanges array)
    const tempList = Array.isArray(data.openTemporaryChanges)
      ? data.openTemporaryChanges
      : Array.isArray(data.temporaryChanges)
        ? data.temporaryChanges.filter((t) => t?.state !== 'reversed')
        : [];
    const tempCount =
      typeof data.openTemporaryChanges === 'number'
        ? data.openTemporaryChanges
        : tempList.length;

    let tempHtml = '';
    if (tempCount > 0 || tempList.length > 0) {
      tempHtml = `
        <div class="section-box">
          <span class="section-label">Open Temporary Changes (${tempCount})</span>
          ${
            tempList.length
              ? `<ul class="temp-list">${tempList
                  .map((tc) => `<li>${esc(typeof tc === 'string' ? tc : tc.description)}</li>`)
                  .join('')}</ul>`
              : `<span style="font-size:12px;color:var(--sf-text-subtle);">${tempCount} temporary change${tempCount === 1 ? '' : 's'} awaiting reversal when supply returns.</span>`
          }
        </div>`;
    }

    el.innerHTML = `
      <div class="header">
        <div class="brand">
          ${SHELF_GAP_SVG}
          <span class="sticker sticker-current">SHORT SUPPLY</span>
        </div>
        ${anySecondHop ? '<span class="chip-graph">2nd-hop Graph</span>' : ''}
      </div>

      <p class="lead">
        ${
          anySecondHop
            ? 'This protocol is linked to an affected FDA shortage presentation (including Teamwork Graph 2nd-hop links):'
            : 'This page references an active FDA drug shortage presentation:'
        }
      </p>

      <ul class="pres-list">${cardsHtml}</ul>

      ${responseHtml}
      ${tempHtml}

      <p class="disclaimer">${esc(data.disclaimer || OPENFDA_DISCLAIMER)}</p>`;
  } catch (e) {
    el.innerHTML = `<div class="err"><strong>Shortfall</strong> — could not load shortage status (${esc(e?.message ?? e)}).</div>`;
  }
})();
