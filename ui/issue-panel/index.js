import { invoke, view } from '@forge/bridge';

const el = document.getElementById('panel');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

(async () => {
  try {
    const ctx = await view.getContext();
    const issueKey = ctx?.extension?.issue?.key ?? ctx?.issueKey;
    const data = await invoke('getIssuePanelData', { context: { issueKey } });
    if (!data?.found) {
      el.innerHTML = '<p>This work item is not linked to a Shortfall shortage response.</p>';
      return;
    }
    const s = data.shortage ?? {};
    const rows = (data.impact ?? [])
      .map((i) => `<li>${esc(i.kind)}: <a href="${esc(i.url)}" target="_blank" rel="noopener">${esc(i.title)}</a> ${i.owner_name ? `— ${esc(i.owner_name)}` : ''}</li>`)
      .join('');
    el.innerHTML = `
      <p><strong>${esc(s.generic_name)}</strong> — ${esc(s.presentation)} · FDA status: <strong>${esc(s.status)}</strong> · NDC ${esc(s.package_ndc)}</p>
      <p>${esc(s.company_name)} · updated ${esc(s.update_date)} ${s.availability ? '· ' + esc(s.availability) : ''}</p>
      <h4>Impact (${(data.impact ?? []).length})</h4>
      <ul>${rows || '<li>No affected pages or work items found.</li>'}</ul>
      <p class="fine">Do not rely on openFDA to make decisions regarding medical care.</p>`;
  } catch (e) {
    el.innerHTML = `<p>Shortage panel failed to load (${esc(e?.message ?? e)}).</p>`;
  }
})();
