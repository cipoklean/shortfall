import api, { route, Route } from '@forge/api';
import { kvs } from '@forge/kvs';
import { sql } from './storage/schema';
import { RxNavClient } from './rxnav';
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
const SAMPLE_DRUGS: SampleDrug[] = [
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
  { id: 'sample-insulin-glargine', displayName: 'insulin glargine 100 units/mL injection', ingredients: ['insulin glargine'], packageNdcs: [], dosageForms: ['injection'] },
  { id: 'sample-metformin', displayName: 'metformin 500 mg tablet', ingredients: ['metformin'], packageNdcs: [], dosageForms: ['tablet'] },
];

const SPACE_KEY = 'SHOSP';
const KVS_KEY = 'sampleHospital';

interface SampleRefs {
  spaceKey?: string;
  pageIds: string[];
  formularyIds: string[];
  projectKey?: string;
}

const SAMPLE_PAGES: { title: string; body: string }[] = [
  {
    title: 'Cefazolin surgical prophylaxis protocol',
    body: `<p>Fictional sample protocol. For surgical antibiotic prophylaxis, cefazolin is the first-line agent for most procedures at Sample Hospital.</p><p>Adult dosing: cefazolin 2 g IV within 60 minutes of incision; redose every 4 hours intraoperatively.</p><p>Documented alternative per P&amp;T: clindamycin 900 mg IV or vancomycin per weight-based protocol for patients with severe beta-lactam allergy.</p>`,
  },
  {
    title: 'Perioperative nerve block guideline',
    body: `<p>Fictional sample guideline. Regional anesthesia for orthopedic surgery uses ropivacaine HCl injection 0.5% for peripheral nerve blockade, or bupivacaine HCl with epinephrine where a longer duration is required.</p><p>Maximum dose limits and aspiration precautions are listed in the anesthesia workstation checklist.</p>`,
  },
  {
    title: 'Rapid sequence intubation order set',
    body: `<p>Fictional sample order set. RSI paralytic: rocuronium bromide 1.2 mg/kg IV is the default neuromuscular blocker. Succinylcholine is restricted to specific indications per the airway committee.</p>`,
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
    body: `<p>Fictional running log of past shortage responses at Sample Hospital.</p><p><strong>2025-09 — cefazolin injection shortage:</strong> consented to conserve premixed bags to OR cases only; floor stock converted to pharmacy-compounded syringes. Restriction documented on the P&amp;T minutes page. Reversed 2025-11 when supply returned.</p><p><strong>2025-04 — lidocaine injection shortage:</strong> restricted to code carts and procedures; topical jelly substituted for bedside use.</p>`,
  },
];

async function getRefs(): Promise<SampleRefs> {
  return (await kvs.get(KVS_KEY)) as SampleRefs ?? { pageIds: [], formularyIds: [] };
}

async function confluenceRequest(path: Route, init: { method?: string; body?: string } = {}) {
  const res = await api.asApp().requestConfluence(path, {
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    method: init.method ?? 'GET',
    ...(init.body !== undefined ? { body: init.body } : {}),
  });
  return res;
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
      description: { plain: { value: 'Fictional sample content created by Shortfall for demonstration. No patient data.', representation: 'plain' } },
    }),
  });
  if (!res.ok) throw new Error(`space create failed: HTTP ${res.status} ${await res.text()}`);
  const created = (await res.json()) as { id: number };
  return { key: SPACE_KEY, id: String(created.id) };
}

async function createPage(spaceId: string, title: string, body: string): Promise<string> {
  const res = await confluenceRequest(route`/wiki/api/v2/pages`, {
    method: 'POST',
    body: JSON.stringify({
      spaceId,
      status: 'current',
      title,
      body: { representation: 'storage', value: body },
    }),
  });
  if (!res.ok) throw new Error(`page create failed: HTTP ${res.status} ${await res.text()}`);
  const page = (await res.json()) as { id: string };
  return page.id;
}

async function insertFormularyItem(item: FormularyItem): Promise<void> {
  const esc = (s: string) => s.replace(/'/g, "''");
  await sql.executeRaw(
    `INSERT INTO formulary_item (id, display_name, ingredient_names, ingredient_rxcuis, package_ndcs, dosage_forms, active)
     VALUES ('${esc(item.id)}', '${esc(item.displayName)}', '${esc(JSON.stringify(item.ingredientNames))}', '${esc(JSON.stringify(item.ingredientRxcuis))}', '${esc(JSON.stringify(item.packageNdcs))}', '${esc(JSON.stringify(item.dosageForms))}', 1)
     ON DUPLICATE KEY UPDATE display_name = VALUES(display_name), ingredient_names = VALUES(ingredient_names), ingredient_rxcuis = VALUES(ingredient_rxcuis), package_ndcs = VALUES(package_ndcs), dosage_forms = VALUES(dosage_forms), active = 1`,
  );
}

/** Load the sample hospital: space + protocol pages + formulary. Idempotent. */
export async function loadSampleHospital(): Promise<{ spaceKey: string; pageIds: string[]; formularyCount: number; warnings?: string[] }> {
  const refs = await getRefs();
  const warnings: string[] = [];

  const space = await ensureSpace();
  refs.spaceKey = space.key;

  // Count the sample space as clinical content unless the admin chose others.
  const settings = await getSettings();
  if (!settings.clinicalSpaceKeys.length || !settings.clinicalSpaceKeys.includes(SPACE_KEY)) {
    await saveSettings({ clinicalSpaceKeys: [...settings.clinicalSpaceKeys, SPACE_KEY] });
  }

  for (const page of SAMPLE_PAGES) {
    try {
      const id = await createPage(space.id, page.title, page.body);
      if (!refs.pageIds.includes(id)) refs.pageIds.push(id);
    } catch (e) {
      warnings.push(`page "${page.title}": ${String(e)}`);
    }
  }

  const rxnav = new RxNavClient({
    cacheGet: (k) => kvs.get(k),
    cacheSet: (k, v) => kvs.set(k, v),
  });
  for (const drug of SAMPLE_DRUGS) {
    const rxcuis: string[] = [];
    for (const ing of drug.ingredients) {
      try {
        const rxcui = await rxnav.nameToRxcui(ing);
        if (rxcui) {
          const ins = await rxnav.ingredientsForRxcui(rxcui);
          rxcuis.push(...(ins.length ? ins.map((i) => i.rxcui) : [rxcui]));
        }
      } catch { /* names alone still match via fallback */ }
    }
    const item: FormularyItem = {
      id: drug.id,
      displayName: drug.displayName,
      ingredientNames: drug.ingredients.map((n) => stripSalts(normalizeDrugName(n))),
      ingredientRxcuis: rxcuis,
      packageNdcs: drug.packageNdcs.map((n) => normalizeNdc(n)!).filter(Boolean),
      dosageForms: drug.dosageForms.map(normalizeDrugName),
    };
    await insertFormularyItem(item);
    if (!refs.formularyIds.includes(drug.id)) refs.formularyIds.push(drug.id);
  }

  await kvs.set(KVS_KEY, refs);
  return { spaceKey: space.key, pageIds: refs.pageIds, formularyCount: refs.formularyIds.length, warnings: warnings.length ? warnings : undefined };
}

/** Remove exactly what loadSampleHospital created. */
export async function removeSampleHospital(): Promise<{ removedPages: number; removedFormulary: number; warnings?: string[] }> {
  const refs = await getRefs();
  const warnings: string[] = [];
  let removedPages = 0;

  for (const id of refs.pageIds) {
    const del = await confluenceRequest(route`/wiki/api/v2/pages/${id}`, { method: 'DELETE' });
    if (del.ok || del.status === 404) removedPages++;
    else warnings.push(`delete page ${id}: HTTP ${del.status}`);
  }

  let removedFormulary = 0;
  for (const id of refs.formularyIds) {
    await sql.executeRaw(`DELETE FROM formulary_item WHERE id = '${id.replace(/'/g, "''")}'`);
    removedFormulary++;
  }

  await kvs.set(KVS_KEY, { pageIds: [], formularyIds: [] });
  const out = { removedPages, removedFormulary, warnings: warnings.length ? warnings : undefined };
  // Note: Confluence exposes no space-delete API; the empty Sample Hospital
  // space shell is left behind if it was created.
  return out;
}

export async function getSampleState() {
  return getRefs();
}
