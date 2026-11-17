import { invoke, view } from '@forge/bridge';

const el = document.getElementById('notice');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

(async () => {
  try {
    const ctx = await view.getContext();
    const pageId = ctx?.extension?.content?.id;
    const data = await invoke('fn-byline-data', { pageId });
    if (!data?.affected) {
      el.innerHTML = '<strong>Shortfall</strong><p>This page is not linked to a drug on the FDA shortage list.</p>';
      return;
    }
    const links = (data.shortages ?? [])
      .map((s) => `<li>${esc(s.name)} <code>${esc(s.shortageId)}</code></li>`)
      .join('');
    el.innerHTML = `
      <span class="st">SHORT SUPPLY</span>
      <p><strong>This page names a drug on the FDA shortage list:</strong></p>
      <ul>${links}</ul>
      ${data.responseWorkItem ? `<p>Response: <a href="/browse/${esc(data.responseWorkItem)}">${esc(data.responseWorkItem)}</a></p>` : '<p>No response work item opened yet.</p>'}
      <p class="fine">Source: openFDA drug shortages. Do not rely on openFDA to make decisions regarding medical care.</p>`;
  } catch (e) {
    el.innerHTML = `<strong>Shortfall</strong><p>Could not load shortage status (${esc(e?.message ?? e)}).</p>`;
  }
})();
