import api, { route, Route } from '@forge/api';
import { kvs } from '@forge/kvs';
import type { UpdateQueryResponse } from '@forge/sql';
import { sql, query, execute } from './storage/schema';
import { RxNavClient, mapWithConcurrency } from './rxnav';
import { normalizeDrugName, stripSalts, normalizeNdc } from './match';
import { FormularyItem } from './types';
import { getSettings, saveSettings } from './settings';

/**
 * Sample hospital: creates realistic fictional content through the same
 * product APIs a real customer flow uses, and removes exactly what it
 * created. No patient data anywhere — content is about medications only.
 */

interface SampleDrug {
  id: string;
  displayName: string;
  ingredients: string[];
  packageNdcs: string[];
  dosageForms: string[];
}

/**
 * Drugs chosen to exercise the matcher against the real FDA list: several
 * presentations of currently-shorted injectables, a resolved one, and
 * common drugs expected not to match.
 */
export const SAMPLE_DRUGS: SampleDrug[] = [
  { id: 'sample-cefazolin-2g', displayName: 'cefazolin in dextrose 2 g/100 mL premix', ingredients: ['cefazolin'], packageNdcs: ['0338-3508-41'], dosageForms: ['injection'] },
  { id: 'sample-cefazolin-3g', displayName: 'cefazolin in dextrose 3 g/150 mL premix', ingredients: ['cefazolin'], packageNdcs: ['0338-0096-06'], dosageForms: ['injection'] },
  { id: 'sample-ropivacaine', displayName: 'ropivacaine HCl injection', ingredients: ['ropivacaine'], packageNdcs: ['70069-062-25'], dosageForms: ['injection'] },
  { id: 'sample-bupi-epi', displayName: 'bupivacaine HCl/epinephrine injection', ingredients: ['bupivacaine', 'epinephrine'], packageNdcs: ['63323-462-17'], dosageForms: ['injection'] },
  { id: 'sample-rocuronium', displayName: 'rocuronium bromide injection', ingredients: ['rocuronium'], packageNdcs: ['25021-687-05'], dosageForms: ['injection'] },
  { id: 'sample-lidocaine', displayName: 'lidocaine HCl injection', ingredients: ['lidocaine'], packageNdcs: [], dosageForms: ['injection'] },
  { id: 'sample-heparin', displayName: 'heparin sodium 1,000 units/mL injection', ingredients: ['heparin'], packageNdcs: [], dosageForms: ['injection'] },
  { id: 'sample-bumetanide', displayName: 'bumetanide injection', ingredients: ['bumetanide'], packageNdcs: ['72205-102-07'], dosageForms: ['injection'] },
  { id: 'sample-furosemide-tab', displayName: 'furosemide 40 mg tablet', ingredients: ['furosemide'], packageNdcs: [], dosageForms: ['tablet'] },
  { id: 'sample-acetaminophen', displayName: 'acetaminophen 500 mg tablet', ingredients: ['acetaminophen'], packageNdcs: [], dosageForms: ['tablet'] },
  { id: 'sample-ondansetron', displayName: 'ondansetron 4 mg/2 mL injection', ingredients: ['ondansetron'], packageNdcs: [], dosageForms: ['injection'] },
  { id: 'sample-tranexamic-acid', displayName: 'tranexamic acid 1,000 mg/10 mL injection', ingredients: ['tranexamic acid'], packageNdcs: [], dosageForms: ['injection'] },
];

const SPACE_KEY = 'SHOSP';
const KVS_KEY = 'sampleHospital';

const HIST_SHORTAGE_KEY = 'sample-hist:cefazolin-2025';
const HIST_ISSUE_KEY = 'HIST-2025-CEF';
const REV_SHORTAGE_KEY = 'ndc:72205010207';
const REV_ISSUE_KEY = 'SAMPLE-REV-BUM';

interface SampleRefs {
  spaceKey?: string;
  pageIds: string[];
  formularyIds: string[];
  responseIds?: number[];
  tempChangeIds?: number[];
  projectKey?: string;
}

// Order matters: dependent pages and P&T minutes are created so that links
// between direct drug protocols and dependent order sets / P&T minutes resolve
// cleanly via <ac:link><ri:page .../></ac:link> for Teamwork Graph 2nd-hop
// blast-radius traversal.
const SAMPLE_PAGES: { title: string; body: string }[] = [
  {
    title: 'Orthopedic arthroplasty admission order set',
    body: `<p>Fictional sample order set for elective total hip and knee arthroplasty admissions at Sample Hospital.</p><p>Preoperative antimicrobial prophylaxis follows the institutional surgical antibiotic prophylaxis protocol prior to skin incision.</p><p>Postoperative mobilization, DVT prophylaxis, and multimodal analgesia follow standard orthopedic care pathways.</p>`,
  },
  {
    title: 'ED airway escalation checklist',
    body: `<p>Fictional sample emergency department airway escalation checklist at Sample Hospital.</p><p>Before induction, confirm backup video laryngoscopy, supraglottic airway kit, and medication readiness per the <ac:link><ri:page ri:content-title="Rapid sequence intubation order set" /></ac:link>.</p>`,
  },
  {
    title: 'P&T minutes — 2025-09 cefazolin',
    body: `<p>Fictional Pharmacy &amp; Therapeutics committee minutes (September 2025) at Sample Hospital. No patient data.</p><p><strong>Decision — Cefazolin injection shortage (2025-09):</strong> Approved temporary conservation of premixed cefazolin 2 g bags exclusively for OR surgical prophylaxis; floor stock converted to pharmacy-compounded syringes for non-OR indications.</p><p><strong>Reversal (2025-11):</strong> Supply restored on the FDA drug shortages list; premix restriction lifted and floor stock returned to baseline.</p>`,
  },
  {
    title: 'ICU diuretic protocol — loop diuretic infusions',
    body: `<p>Fictional sample ICU diuretic guideline at Sample Hospital. No patient data.</p><p>Continuous and intermittent loop diuretic therapy includes furosemide and bumetanide injection (IV bumetanide 1 mg to 2 mg bolus or continuous infusion per ICU titration order set).</p><p>During supply constraints, temporary IV bumetanide vial conservation alerts are posted on this protocol and reversed once FDA marks supply resolved.</p>`,
  },
  {
    title: 'Cefazolin surgical prophylaxis protocol',
    body: `<p>Fictional sample protocol. For surgical antibiotic prophylaxis, cefazolin is the first-line agent for most procedures at Sample Hospital.</p><p>Adult dosing: cefazolin 2 g IV within 60 minutes of incision; redose every 4 hours intraoperatively.</p><p>Documented alternative per P&amp;T: clindamycin 900 mg IV or vancomycin per weight-based protocol for patients with severe beta-lactam allergy.</p><p>Dependent order sets referencing this protocol: <ac:link><ri:page ri:content-title="Orthopedic arthroplasty admission order set" /></ac:link>.</p>`,
  },
  {
    title: 'Perioperative nerve block guideline',
    body: `<p>Fictional sample guideline. Regional anesthesia for orthopedic surgery uses ropivacaine HCl injection 0.5% for peripheral nerve blockade, or bupivacaine HCl with epinephrine where a longer duration is required.</p><p>Maximum dose limits and aspiration precautions are listed in the anesthesia workstation checklist.</p>`,
  },
  {
    title: 'Rapid sequence intubation order set',
    body: `<p>Fictional sample order set. RSI paralytic: rocuronium bromide 1.2 mg/kg IV is the default neuromuscular blocker. Succinylcholine is restricted to specific indications per the airway committee.</p><p>Linked bedside checklist: <ac:link><ri:page ri:content-title="ED airway escalation checklist" /></ac:link>.</p>`,
  },
  {
    title: 'Local anesthetic maximum dosing quick reference',
    body: `<p>Fictional sample reference. Lidocaine HCl injection without epinephrine: max 4.5 mg/kg. With epinephrine: max 7 mg/kg. Bupivacaine: max 2.5 mg/kg.</p>`,
  },
  {
    title: 'Anticoagulation standard — heparin infusions',
    body: `<p>Fictional sample standard. Therapeutic unfractionated heparin sodium infusions are prepared per pharmacy standard concentrations and titrated by the aPTT protocol.</p>`,
  },
  {
    title: 'Drug shortage response log',
    body: `<p>Fictional running log of past shortage responses at Sample Hospital.</p><p><strong>2025-09 — cefazolin injection shortage:</strong> consented to conserve premixed bags to OR cases only; floor stock converted to pharmacy-compounded syringes. Restriction documented on <ac:link><ri:page ri:content-title="P&amp;T minutes — 2025-09 cefazolin" /></ac:link>. Reversed 2025-11 when supply returned.</p><p><strong>2025-04 — lidocaine injection shortage:</strong> restricted to code carts and procedures; topical jelly substituted for bedside use.</p>`,
  },
];

function extractInsertId(rows: unknown): number | undefined {
  if (!rows) return undefined;
  if (Array.isArray(rows)) {
    const first = rows[0] as { insertId?: number } | undefined;
    return first?.insertId;
  }
  return (rows as { insertId?: number }).insertId;
}

async function getRefs(): Promise<SampleRefs> {
  const stored = (await kvs.get(KVS_KEY)) as Partial<SampleRefs> | undefined;
  return {
    spaceKey: stored?.spaceKey,
    pageIds: stored?.pageIds ?? [],
    formularyIds: stored?.formularyIds ?? [],
    responseIds: stored?.responseIds ?? [],
    tempChangeIds: stored?.tempChangeIds ?? [],
    projectKey: stored?.projectKey,
  };
}

async function confluenceRequest(
  path: Route,
  init: { method?: string; body?: string; preferUser?: boolean } = {},
) {
  const opts = {
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    method: init.method ?? 'GET',
    ...(init.body !== undefined ? { body: init.body } : {}),
  };
  if (init.preferUser) {
    try {
      const userRes = await api.asUser().requestConfluence(path, opts);
      if (userRes.ok || userRes.status < 500) return userRes;
    } catch {
      // No user session (e.g. background/diagnostic call) — fall back to asApp().
    }
  }
  return api.asApp().requestConfluence(path, opts);
}

async function ensureSpace(): Promise<{ key: string; id: string }> {
  const list = await confluenceRequest(route`/wiki/api/v2/spaces?keys=${SPACE_KEY}`);
  const listBody = await list.text();
  console.log(`v2 spaces lookup: HTTP ${list.status} ${listBody.slice(0, 400)}`);
  if (list.ok) {
    const data = JSON.parse(listBody) as { results?: { id: string; key: string }[] };
    const hit = data.results?.find((s) => s.key === SPACE_KEY) ?? data.results?.[0];
    if (hit) return { key: SPACE_KEY, id: String(hit.id) };
  }
  const res = await confluenceRequest(route`/wiki/rest/api/space`, {
    method: 'POST',
    body: JSON.stringify({
      key: SPACE_KEY,
      name: 'Sample Hospital',
      description: {
        plain: {
          value: 'Fictional sample content created by Shortfall for demonstration. No patient data.',
          representation: 'plain',
        },
      },
    }),
  });
  if (!res.ok) throw new Error(`space create failed: HTTP ${res.status} ${await res.text()}`);
  const created = (await res.json()) as { id: number };
  return { key: SPACE_KEY, id: String(created.id) };
}

async function listExistingPagesInSpace(
  spaceId: string,
): Promise<Map<string, { id: string; version: number; title: string }>> {
  const byTitle = new Map<string, { id: string; version: number; title: string }>();

  // 1. Primary lookup via Confluence v2 Pages API.
  const res = await confluenceRequest(route`/wiki/api/v2/spaces/${spaceId}/pages?limit=100`);
  if (res.ok) {
    const data = (await res.json()) as {
      results?: { id: string; title: string; status?: string; version?: { number?: number } }[];
    };
    for (const p of data.results ?? []) {
      if (!p.status || p.status === 'current') {
        byTitle.set(p.title.trim().toLowerCase(), {
          id: String(p.id),
          version: Number(p.version?.number ?? 1),
          title: p.title,
        });
      }
    }
  }

  // 2. Fallback via CQL search so existing pages are never missed if v2 scope lags.
  if (byTitle.size === 0) {
    const cql = `space = "${SPACE_KEY}" AND type = page`;
    const cqlRes = await confluenceRequest(
      route`/wiki/rest/api/content/search?cql=${cql}&limit=100&expand=version`,
    );
    if (cqlRes.ok) {
      const data = (await cqlRes.json()) as {
        results?: { id: string; title: string; version?: { number?: number } }[];
      };
      for (const p of data.results ?? []) {
        byTitle.set(p.title.trim().toLowerCase(), {
          id: String(p.id),
          version: Number(p.version?.number ?? 1),
          title: p.title,
        });
      }
    }
  }

  return byTitle;
}

async function createPage(spaceId: string, title: string, body: string): Promise<string> {
  const res = await confluenceRequest(route`/wiki/api/v2/pages`, {
    method: 'POST',
    preferUser: true,
    body: JSON.stringify({
      spaceId,
      status: 'current',
      title,
      body: { representation: 'storage', value: body },
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const page = (await res.json()) as { id: string };
  return page.id;
}

async function updatePage(
  pageId: string,
  version: number,
  title: string,
  body: string,
): Promise<string> {
  const res = await confluenceRequest(route`/wiki/api/v2/pages/${pageId}`, {
    method: 'PUT',
    preferUser: true,
    body: JSON.stringify({
      id: pageId,
      status: 'current',
      title,
      body: { representation: 'storage', value: body },
      version: { number: version + 1, message: 'Shortfall sample protocol update' },
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return pageId;
}

async function insertFormularyItem(item: FormularyItem): Promise<void> {
  await execute(
    `INSERT INTO formulary_item (id, display_name, ingredient_names, ingredient_rxcuis, package_ndcs, dosage_forms, active)
     VALUES (?, ?, ?, ?, ?, ?, 1)
     ON DUPLICATE KEY UPDATE
       display_name = VALUES(display_name),
       ingredient_names = VALUES(ingredient_names),
       ingredient_rxcuis = VALUES(ingredient_rxcuis),
       package_ndcs = VALUES(package_ndcs),
       dosage_forms = VALUES(dosage_forms),
       active = 1`,
    [
      item.id,
      item.displayName,
      JSON.stringify(item.ingredientNames),
      JSON.stringify(item.ingredientRxcuis),
      JSON.stringify(item.packageNdcs),
      JSON.stringify(item.dosageForms),
    ],
  );
}

async function seedSampleHistoryAndReversal(refs: SampleRefs): Promise<void> {
  const responseIds = new Set<number>(refs.responseIds ?? []);
  const tempChangeIds = new Set<number>(refs.tempChangeIds ?? []);

  // 1. Seed a historical resolved Cefazolin shortage response for "What did we do last time?".
  const existingHist = await query<{ id: number }>(
    `SELECT id FROM response WHERE shortage_key = ? LIMIT 1`,
    [HIST_SHORTAGE_KEY],
  );
  if (existingHist.length) {
    responseIds.add(existingHist[0].id);
  } else {
    const res = await sql
      .prepare<UpdateQueryResponse>(
        `INSERT INTO response (shortage_key, ingredient, jira_issue_key, jira_issue_id, state, opened_at, resolved_at, reversal_needed, decision_summary)
         VALUES (?, ?, ?, ?, 'resolved', '2025-09-10 09:00:00', '2025-11-18 14:30:00', 0, ?)`,
      )
      .bindParams(
        HIST_SHORTAGE_KEY,
        'Cefazolin in Dextrose Injection',
        HIST_ISSUE_KEY,
        'sample-hist-cef',
        '2025-09 P&T decision: Conserved premix 2 g bags for OR surgical prophylaxis only; converted floor stock to pharmacy-compounded syringes. Reversed 2025-11 when FDA marked supply resolved.',
      )
      .execute();
    const id =
      extractInsertId(res.rows) ??
      (
        await query<{ id: number }>(
          `SELECT id FROM response WHERE shortage_key = ? ORDER BY id DESC LIMIT 1`,
          [HIST_SHORTAGE_KEY],
        )
      )[0]?.id;
    if (id) responseIds.add(id);
  }

  // 2. Seed a sample response + open temporary change attached to a Resolved FDA shortage
  // (ndc:72205010207, Bumetanide Injection) so the Reversal Checklist works out of the box.
  let bumResponseId: number | undefined;
  const existingBum = await query<{ id: number }>(
    `SELECT id FROM response WHERE shortage_key = ? AND jira_issue_key = ? LIMIT 1`,
    [REV_SHORTAGE_KEY, REV_ISSUE_KEY],
  );
  if (existingBum.length) {
    bumResponseId = existingBum[0].id;
    responseIds.add(bumResponseId);
  } else {
    const res = await sql
      .prepare<UpdateQueryResponse>(
        `INSERT INTO response (shortage_key, ingredient, jira_issue_key, jira_issue_id, state, opened_at, reversal_needed, decision_summary)
         VALUES (?, ?, ?, ?, 'open', NOW(), 1, ?)`,
      )
      .bindParams(
        REV_SHORTAGE_KEY,
        'Bumetanide Injection',
        REV_ISSUE_KEY,
        'sample-rev-bum',
        'Temporary conservation notice posted for IV bumetanide vials during supply constraint; awaiting reversal confirmation after FDA resolution.',
      )
      .execute();
    bumResponseId =
      extractInsertId(res.rows) ??
      (
        await query<{ id: number }>(
          `SELECT id FROM response WHERE shortage_key = ? AND jira_issue_key = ? ORDER BY id DESC LIMIT 1`,
          [REV_SHORTAGE_KEY, REV_ISSUE_KEY],
        )
      )[0]?.id;
    if (bumResponseId) responseIds.add(bumResponseId);
  }

  if (bumResponseId) {
    const existingChange = await query<{ id: number }>(
      `SELECT id FROM temporary_change WHERE response_id = ? LIMIT 1`,
      [bumResponseId],
    );
    if (existingChange.length) {
      tempChangeIds.add(existingChange[0].id);
    } else {
      const tcRes = await sql
        .prepare<UpdateQueryResponse>(
          `INSERT INTO temporary_change (response_id, description, state, created_at)
           VALUES (?, ?, 'open', NOW())`,
        )
        .bindParams(
          bumResponseId,
          'Remove temporary IV bumetanide vial conservation alert from ICU diuretic order set',
        )
        .execute();
      const tcId =
        extractInsertId(tcRes.rows) ??
        (
          await query<{ id: number }>(
            `SELECT id FROM temporary_change WHERE response_id = ? ORDER BY id DESC LIMIT 1`,
            [bumResponseId],
          )
        )[0]?.id;
      if (tcId) tempChangeIds.add(tcId);
    }
  }

  refs.responseIds = [...responseIds];
  refs.tempChangeIds = [...tempChangeIds];
}

/** Load the sample hospital: space + protocol pages + formulary + sample history/reversal. Idempotent. */
export async function loadSampleHospital(): Promise<{
  spaceKey: string;
  pageIds: string[];
  createdPages: number;
  updatedPages: number;
  reusedPages: number;
  formularyCount: number;
  warnings?: string[];
}> {
  const refs = await getRefs();
  const warnings: string[] = [];

  const space = await ensureSpace();
  refs.spaceKey = space.key;

  const settings = await getSettings();
  if (!settings.clinicalSpaceKeys.includes(SPACE_KEY)) {
    await saveSettings({ clinicalSpaceKeys: [...settings.clinicalSpaceKeys, SPACE_KEY] });
  }

  let createdPages = 0;
  let updatedPages = 0;
  let reusedPages = 0;

  const existingPages = await listExistingPagesInSpace(space.id);
  for (const page of SAMPLE_PAGES) {
    const existing = existingPages.get(page.title.trim().toLowerCase());
    if (existing) {
      try {
        await updatePage(existing.id, existing.version, page.title, page.body);
        updatedPages++;
      } catch {
        // Reuse the existing page cleanly if an update cannot be written.
        reusedPages++;
      }
      if (!refs.pageIds.includes(existing.id)) refs.pageIds.push(existing.id);
    } else {
      try {
        const id = await createPage(space.id, page.title, page.body);
        createdPages++;
        if (!refs.pageIds.includes(id)) refs.pageIds.push(id);
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'request failed';
        warnings.push(`Could not create "${page.title}" (${msg})`);
      }
    }
  }

  const rxnav = new RxNavClient({
    cacheGet: (k) => kvs.get(k),
    cacheSet: (k, v) => kvs.set(k, v),
  });

  await mapWithConcurrency(SAMPLE_DRUGS, 4, async (drug) => {
    const rxcuis: string[] = [];
    for (const ing of drug.ingredients) {
      try {
        const rxcui = await rxnav.nameToRxcui(ing);
        if (rxcui) {
          const ins = await rxnav.ingredientsForRxcui(rxcui);
          rxcuis.push(...(ins.length ? ins.map((i) => i.rxcui) : [rxcui]));
        }
      } catch {
        /* names alone still match via fallback */
      }
    }
    const item: FormularyItem = {
      id: drug.id,
      displayName: drug.displayName,
      ingredientNames: drug.ingredients.map((n) => stripSalts(normalizeDrugName(n))),
      ingredientRxcuis: rxcuis,
      packageNdcs: drug.packageNdcs
        .map((n) => normalizeNdc(n))
        .filter((n): n is string => Boolean(n)),
      dosageForms: drug.dosageForms.map(normalizeDrugName),
    };
    await insertFormularyItem(item);
    if (!refs.formularyIds.includes(drug.id)) refs.formularyIds.push(drug.id);
  });

  // Remove any retired sample formulary entries (e.g. insulin glargine / metformin replaced by surgical staples).
  const currentSampleIds = new Set(SAMPLE_DRUGS.map((d) => d.id));
  const retiredIds = refs.formularyIds.filter((id) => !currentSampleIds.has(id));
  if (retiredIds.length > 0) {
    const ph = retiredIds.map(() => '?').join(',');
    await execute(`DELETE FROM \`match\` WHERE formulary_item_id IN (${ph})`, retiredIds);
    await execute(`DELETE FROM formulary_item WHERE id IN (${ph})`, retiredIds);
    refs.formularyIds = refs.formularyIds.filter((id) => currentSampleIds.has(id));
  }

  await seedSampleHistoryAndReversal(refs);

  await kvs.set(KVS_KEY, refs);
  return {
    spaceKey: space.key,
    pageIds: refs.pageIds,
    createdPages,
    updatedPages,
    reusedPages,
    formularyCount: refs.formularyIds.length,
    warnings: warnings.length ? warnings : undefined,
  };
}

/** Remove everything loadSampleHospital created, including sample history, matches, and orphaned impacts. */
export async function removeSampleHospital(): Promise<{
  removedPages: number;
  removedFormulary: number;
  warnings?: string[];
}> {
  const refs = await getRefs();
  const warnings: string[] = [];
  let removedPages = 0;

  for (const id of refs.pageIds) {
    const del = await confluenceRequest(route`/wiki/api/v2/pages/${id}`, { method: 'DELETE' });
    if (del.ok || del.status === 404) removedPages++;
    else warnings.push(`delete page ${id}: HTTP ${del.status}`);
    await execute(`DELETE FROM impact_item WHERE kind = 'page' AND ref_id = ?`, [id]);
  }

  // Delete sample temporary changes and sample responses.
  for (const tcId of refs.tempChangeIds ?? []) {
    await execute(`DELETE FROM temporary_change WHERE id = ?`, [tcId]);
  }
  for (const respId of refs.responseIds ?? []) {
    await execute(`DELETE FROM temporary_change WHERE response_id = ?`, [respId]);
    await execute(`DELETE FROM response WHERE id = ?`, [respId]);
  }
  // Safety-net cleanup by known sample keys in case refs were partially recorded.
  const leftoverSampleResponses = await query<{ id: number }>(
    `SELECT id FROM response WHERE shortage_key = ? OR jira_issue_key IN (?, ?)`,
    [HIST_SHORTAGE_KEY, HIST_ISSUE_KEY, REV_ISSUE_KEY],
  );
  for (const r of leftoverSampleResponses) {
    await execute(`DELETE FROM temporary_change WHERE response_id = ?`, [r.id]);
    await execute(`DELETE FROM response WHERE id = ?`, [r.id]);
  }

  let removedFormulary = 0;
  for (const id of refs.formularyIds) {
    await execute(`DELETE FROM \`match\` WHERE formulary_item_id = ?`, [id]);
    await execute(`DELETE FROM formulary_item WHERE id = ?`, [id]);
    removedFormulary++;
  }

  // Delete orphaned impact_item rows no longer referenced by any active match.
  await execute(
    `DELETE FROM impact_item
     WHERE shortage_key NOT IN (SELECT DISTINCT shortage_key FROM \`match\` WHERE superseded = 0)`,
  );

  // Remove SHOSP from clinicalSpaceKeys.
  const settings = await getSettings();
  if (settings.clinicalSpaceKeys.includes(SPACE_KEY)) {
    await saveSettings({
      clinicalSpaceKeys: settings.clinicalSpaceKeys.filter((k) => k !== SPACE_KEY),
    });
  }

  await kvs.set(KVS_KEY, {
    pageIds: [],
    formularyIds: [],
    responseIds: [],
    tempChangeIds: [],
  });

  // Note: Confluence exposes no space-delete API; the empty Sample Hospital
  // space shell is left behind if it was created.
  return {
    removedPages,
    removedFormulary,
    warnings: warnings.length ? warnings : undefined,
  };
}

export async function getSampleState() {
  return getRefs();
}
