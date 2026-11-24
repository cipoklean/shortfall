import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  matchShortages,
  normalizeNdc,
  normalizeDrugName,
  stripSalts,
  shortageKey,
  candidateNames,
  fdaSourceUrl,
  baseIngredientName,
  matchesIngredientToken,
} from '../src/match';
import {
  FdaShortageRecord,
  FdaShortagesResponse,
  FormularyItem,
  IngredientIndex,
  OPENFDA_DISCLAIMER,
} from '../src/types';

const fx = (name: string) =>
  JSON.parse(readFileSync(join(__dirname, 'fixtures', name), 'utf8'));

const cefazolinResp = fx('fda-shortages-cefazolin.json') as FdaShortagesResponse;
const cefazolin = cefazolinResp.results!;
const resolved = (fx('fda-shortages-resolved.json') as FdaShortagesResponse).results!;
const anesthesia = (fx('fda-shortages-anesthesia.json') as FdaShortagesResponse).results!;

const combo = anesthesia.find((r) => r.generic_name?.includes('Epinephrine'))!;

// Index built from the saved RxNav fixtures: NDC 0338-3508-41 -> rxcui 1665060
// -> ingredient rxcui 2180 (cefazolin). Combination-product rxcuis mapped
// to their real RxNorm ingredients.
const INDEX: IngredientIndex = new Map([
  ['1665060', [{ rxcui: '2180', name: 'cefazolin' }]],
  ['1665050', [{ rxcui: '2180', name: 'cefazolin' }]],
  ['2630753', [{ rxcui: '2180', name: 'cefazolin' }]],
  // Combination product rxcuis -> bupivacaine and epinephrine.
  ...[...combo.openfda!.rxcui!].map(
    (c): [string, { rxcui: string; name: string }[]] => [
      c,
      [
        { rxcui: '3640', name: 'bupivacaine' },
        { rxcui: '3992', name: 'epinephrine' },
      ],
    ],
  ),
]);

const item = (partial: Partial<FormularyItem>): FormularyItem => ({
  id: 'F1',
  displayName: 'item',
  ingredientNames: [],
  ingredientRxcuis: [],
  packageNdcs: [],
  dosageForms: [],
  ...partial,
});

describe('OPENFDA_DISCLAIMER', () => {
  it('matches the canonical openFDA disclaimer text', () => {
    expect(OPENFDA_DISCLAIMER).toBe(cefazolinResp.meta.disclaimer);
  });
});

describe('normalizeNdc', () => {
  it('converts hyphenated FDA 10-digit formats to HIPAA 11-digit (5-4-2)', () => {
    // 4-4-2 -> 0 + a + b + c
    expect(normalizeNdc('0338-3508-41')).toBe('00338350841');
    // 5-3-2 -> a + 0 + b + c
    expect(normalizeNdc('70069-062-25')).toBe('70069006225');
    expect(normalizeNdc('63323-462-17')).toBe('63323046217');
    // 5-4-1 -> a + b + 0 + c
    expect(normalizeNdc('55555-4444-1')).toBe('55555444401');
    // 5-4-2 -> already 11 digits
    expect(normalizeNdc('00338-3508-41')).toBe('00338350841');
  });

  it('preserves raw 11-digit and unhyphenated fallback strings and rejects blanks', () => {
    expect(normalizeNdc('00338350841')).toBe('00338350841');
    expect(normalizeNdc('  0338-3508-41  ')).toBe('00338350841');
    expect(normalizeNdc('0338350841')).toBe('0338350841');
    expect(normalizeNdc('')).toBeNull();
    expect(normalizeNdc('   ')).toBeNull();
    expect(normalizeNdc('---')).toBeNull();
    expect(normalizeNdc(undefined)).toBeNull();
  });
});

describe('fdaSourceUrl', () => {
  it('links to the openFDA NDC search query when packageNdc is present', () => {
    expect(fdaSourceUrl('0338-3508-41')).toBe(
      'https://api.fda.gov/drug/shortages.json?search=package_ndc:%220338-3508-41%22',
    );
    expect(fdaSourceUrl('  70069-062-25  ')).toBe(
      'https://api.fda.gov/drug/shortages.json?search=package_ndc:%2270069-062-25%22',
    );
  });

  it('falls back to the FDA drug shortages portal when packageNdc is absent', () => {
    expect(fdaSourceUrl()).toBe('https://dps.fda.gov/drugshortages');
    expect(fdaSourceUrl(null)).toBe('https://dps.fda.gov/drugshortages');
    expect(fdaSourceUrl('')).toBe('https://dps.fda.gov/drugshortages');
    expect(fdaSourceUrl('   ')).toBe('https://dps.fda.gov/drugshortages');
  });
});

describe('name handling', () => {
  it('strips salts', () => {
    expect(stripSalts(normalizeDrugName('CEFAZOLIN SODIUM'))).toBe('cefazolin');
    expect(stripSalts(normalizeDrugName('bupivacaine hydrochloride'))).toBe('bupivacaine');
    expect(stripSalts(normalizeDrugName('lidocaine'))).toBe('lidocaine');
  });

  it('derives clean baseIngredientName values', () => {
    expect(baseIngredientName('Cefazolin in Dextrose Injection')).toBe('cefazolin');
    expect(baseIngredientName('Rocuronium Bromide Injection')).toBe('rocuronium');
    expect(baseIngredientName('Heparin Sodium Injection')).toBe('heparin');
    expect(baseIngredientName('Heparin Sodium in 0.9% Sodium Chloride Injection')).toBe('heparin');
    expect(baseIngredientName('Heparin Sodium in Sodium Chloride Injection')).toBe('heparin');
    expect(baseIngredientName('Clonazepam Tablet')).toBe('clonazepam');
    expect(baseIngredientName('Amoxicillin Capsule')).toBe('amoxicillin');
    expect(baseIngredientName('Albuterol Sulfate Inhalation Solution')).toBe('albuterol');
    expect(baseIngredientName('Budesonide Inhalation Suspension')).toBe('budesonide');
    expect(baseIngredientName('Sodium Chloride Injection')).toBe('sodium chloride');
    expect(baseIngredientName('')).toBe('');
  });

  it('collects candidate names from record and openfda', () => {
    const names = candidateNames(cefazolin[0]);
    expect(names).toContain('cefazolin in dextrose injection');
    expect(names).toContain('cefazolin sodium');
    expect(names).toContain('cefazolin'); // brand_name CEFAZOLIN
  });

  it('enforces whole-word boundaries in matchesIngredientToken', () => {
    expect(matchesIngredientToken('norepinephrine injection', 'epinephrine')).toBe(false);
    expect(matchesIngredientToken('epinephrine injection', 'norepinephrine')).toBe(false);
    expect(matchesIngredientToken('hydromorphone injection', 'morphine')).toBe(false);
    expect(matchesIngredientToken('insulin', 'insulin glargine')).toBe(false);
    expect(matchesIngredientToken('insulin lispro injection', 'insulin glargine')).toBe(false);
    expect(matchesIngredientToken('insulin glargine injection', 'insulin glargine')).toBe(true);
    expect(matchesIngredientToken('bupivacaine epinephrine injection', 'epinephrine')).toBe(true);
    expect(matchesIngredientToken('ab', 'ab')).toBe(false);
  });
});

describe('shortageKey', () => {
  it('uses normalized 11-digit package NDC and keeps presentations separate', () => {
    const keys = new Set(cefazolin.map(shortageKey));
    expect(keys.size).toBe(3); // 3 presentations -> 3 keys, never merged
    expect(shortageKey(cefazolin[0])).toBe('ndc:00338350841');
  });

  it('falls back to a record key when package NDC is missing', () => {
    const noNdc = { ...cefazolin[0], package_ndc: undefined };
    expect(shortageKey(noNdc)).toMatch(/^rec:/);
  });
});

describe('matchShortages', () => {
  it('matches 10-digit FDA package NDC against 11-digit HIPAA formulary NDC', () => {
    const formulary = [
      item({ id: 'cef-2g', displayName: 'cefazolin 2g premix', packageNdcs: ['00338350841'] }),
    ];
    const matches = matchShortages(cefazolin, formulary, INDEX);
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({
      shortageKey: 'ndc:00338350841',
      formularyItemId: 'cef-2g',
      reason: 'ndc',
    });
  });

  it('normalizes hyphenated 10-digit formulary NDCs before matching', () => {
    const formulary = [
      item({ id: 'cef-2g-dash', displayName: 'cefazolin 2g premix', packageNdcs: ['0338-3508-41'] }),
    ];
    const matches = matchShortages(cefazolin, formulary, INDEX);
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({
      shortageKey: 'ndc:00338350841',
      formularyItemId: 'cef-2g-dash',
      reason: 'ndc',
    });
  });

  it('does not match other presentations of the same drug by NDC', () => {
    const formulary = [item({ packageNdcs: ['00338350841'] })];
    const matches = matchShortages(cefazolin, formulary, INDEX);
    const keys = matches.map((m) => m.shortageKey);
    expect(keys).toContain('ndc:00338350841');
    expect(keys).not.toContain('ndc:00338009606');
  });

  it('matches by RxNorm ingredient + dosage form, salts stripped', () => {
    const formulary = [
      item({
        id: 'cefazolin-iv',
        displayName: 'cefazolin injection',
        ingredientRxcuis: ['2180'],
        dosageForms: ['injection'],
      }),
    ];
    const matches = matchShortages(cefazolin, formulary, INDEX);
    expect(matches.length).toBe(3); // all 3 presentations match the ingredient
    expect(matches.every((m) => m.reason === 'ingredient_rxcui')).toBe(true);
  });

  it('does not match a different dosage form', () => {
    const formulary = [
      item({
        id: 'cefazolin-oral',
        ingredientRxcuis: ['2180'],
        dosageForms: ['capsule'],
      }),
    ];
    expect(matchShortages(cefazolin, formulary, INDEX)).toHaveLength(0);
  });

  it('matches combination shortage to single-ingredient formulary items', () => {
    const formulary = [
      item({
        id: 'bupivacaine',
        displayName: 'bupivacaine inj',
        ingredientRxcuis: ['3640'],
        dosageForms: ['injection'],
      }),
      item({
        id: 'epinephrine',
        displayName: 'epinephrine inj',
        ingredientRxcuis: ['3992'],
        dosageForms: ['injection'],
      }),
    ];
    const matches = matchShortages([combo], formulary, INDEX);
    const ids = new Set(matches.map((m) => m.formularyItemId));
    expect(ids).toEqual(new Set(['bupivacaine', 'epinephrine']));
  });

  it('requires ALL ingredients for combination formulary items in RxNorm matching', () => {
    const formulary = [
      item({
        id: 'lido-epi',
        displayName: 'lidocaine + epinephrine inj',
        ingredientRxcuis: ['6387', '3992'],
        ingredientNames: ['lidocaine', 'epinephrine'],
        dosageForms: ['injection'],
      }),
      item({
        id: 'bupi-epi',
        displayName: 'bupivacaine + epinephrine inj',
        ingredientRxcuis: ['3640', '3992'],
        ingredientNames: ['bupivacaine', 'epinephrine'],
        dosageForms: ['injection'],
      }),
      item({
        id: 'lido-epi-partial-rxcui',
        displayName: 'lidocaine + epinephrine (partial rxcui)',
        ingredientRxcuis: ['3992'],
        ingredientNames: ['lidocaine', 'epinephrine'],
        dosageForms: ['injection'],
      }),
      item({
        id: 'bupivacaine-only',
        displayName: 'bupivacaine inj',
        ingredientRxcuis: ['3640'],
        ingredientNames: ['bupivacaine'],
        dosageForms: ['injection'],
      }),
    ];
    const matches = matchShortages([combo], formulary, INDEX);
    const ids = new Set(matches.map((m) => m.formularyItemId));
    expect(ids).toEqual(new Set(['bupi-epi', 'bupivacaine-only']));
    expect(ids).not.toContain('lido-epi');
    expect(ids).not.toContain('lido-epi-partial-rxcui');
  });

  it('requires ALL ingredients for combination formulary items in name fallback', () => {
    const comboNoOpenfda: FdaShortageRecord = {
      ...combo,
      package_ndc: undefined,
      openfda: {},
    };
    const formulary = [
      item({
        id: 'lido-epi',
        displayName: 'lidocaine + epinephrine inj',
        ingredientNames: ['lidocaine', 'epinephrine'],
        dosageForms: ['injection'],
      }),
      item({
        id: 'bupi-epi',
        displayName: 'bupivacaine + epinephrine inj',
        ingredientNames: ['bupivacaine', 'epinephrine'],
        dosageForms: ['injection'],
      }),
      item({
        id: 'bupivacaine-only',
        displayName: 'bupivacaine inj',
        ingredientNames: ['bupivacaine'],
        dosageForms: ['injection'],
      }),
    ];
    const matches = matchShortages([comboNoOpenfda], formulary, INDEX);
    const ids = new Set(matches.map((m) => m.formularyItemId));
    expect(ids).toEqual(new Set(['bupi-epi', 'bupivacaine-only']));
    expect(ids).not.toContain('lido-epi');
    expect(matches.every((m) => m.reason === 'ingredient_name')).toBe(true);
  });

  it('prevents substring false positives in name fallback', () => {
    const records: FdaShortageRecord[] = [
      {
        generic_name: 'Norepinephrine Bitartrate Injection',
        dosage_form: 'Injection',
        openfda: {},
      },
      {
        generic_name: 'Hydromorphone Hydrochloride Injection',
        dosage_form: 'Injection',
        openfda: {},
      },
      {
        generic_name: 'Insulin Injection',
        dosage_form: 'Injection',
        openfda: { substance_name: ['INSULIN'] },
      },
      {
        generic_name: 'Insulin Lispro Injection',
        dosage_form: 'Injection',
        openfda: {},
      },
    ];
    const formulary = [
      item({ id: 'epi', displayName: 'epinephrine', ingredientNames: ['epinephrine'], dosageForms: ['injection'] }),
      item({ id: 'morph', displayName: 'morphine', ingredientNames: ['morphine'], dosageForms: ['injection'] }),
      item({ id: 'glargine', displayName: 'insulin glargine', ingredientNames: ['insulin glargine'], dosageForms: ['injection'] }),
    ];
    expect(matchShortages(records, formulary, new Map())).toHaveLength(0);

    // Specific insulin glargine record still matches insulin glargine formulary item
    const glargineRecord: FdaShortageRecord = {
      generic_name: 'Insulin Glargine Injection',
      dosage_form: 'Injection',
      openfda: {},
    };
    const glargineMatches = matchShortages([glargineRecord], formulary, new Map());
    expect(glargineMatches).toHaveLength(1);
    expect(glargineMatches[0]).toMatchObject({
      formularyItemId: 'glargine',
      reason: 'ingredient_name',
    });
  });

  it('falls back to name matching when openfda is empty', () => {
    const noOpenfda: FdaShortageRecord = {
      ...cefazolin[0],
      package_ndc: undefined,
      openfda: {},
    };
    const formulary = [
      item({
        id: 'cef',
        ingredientNames: ['cefazolin'],
        dosageForms: ['injection'],
      }),
    ];
    const matches = matchShortages([noOpenfda], formulary, INDEX);
    expect(matches).toHaveLength(1);
    expect(matches[0].reason).toBe('ingredient_name');
  });

  it('does not match a resolved-only drug absent from the formulary', () => {
    const formulary = [
      item({ ingredientNames: ['cefazolin'], dosageForms: ['injection'] }),
    ];
    const matches = matchShortages(resolved, formulary, INDEX);
    expect(matches.filter((m) => m.reason !== 'ingredient_name')).toHaveLength(0);
  });

  it('brand names on the record can match a generic formulary entry', () => {
    const formulary = [
      item({ ingredientNames: ['sensorcaine'], dosageForms: [] }),
    ];
    const matches = matchShortages([combo], formulary, INDEX);
    // brand_name SENSORCAINE MPF -> "sensorcaine mpf"; item ingredient
    // "sensorcaine" matches on word boundary -> name match.
    expect(matches.some((m) => m.reason === 'ingredient_name')).toBe(true);
  });

  it('never matches the 10 unrelated non-formulary drugs against the 12-item sample formulary', () => {
    const sampleFormulary: FormularyItem[] = [
      item({ id: 'sample-cefazolin-2g', displayName: 'cefazolin in dextrose 2 g/100 mL premix', ingredientNames: ['cefazolin'], ingredientRxcuis: ['2180'], packageNdcs: ['00338350841'], dosageForms: ['injection'] }),
      item({ id: 'sample-cefazolin-3g', displayName: 'cefazolin in dextrose 3 g/150 mL premix', ingredientNames: ['cefazolin'], ingredientRxcuis: ['2180'], packageNdcs: ['00338009606'], dosageForms: ['injection'] }),
      item({ id: 'sample-ropivacaine', displayName: 'ropivacaine HCl injection', ingredientNames: ['ropivacaine'], ingredientRxcuis: ['35780'], packageNdcs: ['70069006225'], dosageForms: ['injection'] }),
      item({ id: 'sample-bupi-epi', displayName: 'bupivacaine HCl/epinephrine injection', ingredientNames: ['bupivacaine', 'epinephrine'], ingredientRxcuis: ['3640', '3992'], packageNdcs: ['63323046217'], dosageForms: ['injection'] }),
      item({ id: 'sample-rocuronium', displayName: 'rocuronium bromide injection', ingredientNames: ['rocuronium'], ingredientRxcuis: ['68139'], packageNdcs: ['25021068705'], dosageForms: ['injection'] }),
      item({ id: 'sample-lidocaine', displayName: 'lidocaine HCl injection', ingredientNames: ['lidocaine'], ingredientRxcuis: ['6387'], packageNdcs: [], dosageForms: ['injection'] }),
      item({ id: 'sample-heparin', displayName: 'heparin sodium 1,000 units/mL injection', ingredientNames: ['heparin'], ingredientRxcuis: ['5224'], packageNdcs: [], dosageForms: ['injection'] }),
      item({ id: 'sample-bumetanide', displayName: 'bumetanide injection', ingredientNames: ['bumetanide'], ingredientRxcuis: ['1808'], packageNdcs: ['72205010207'], dosageForms: ['injection'] }),
      item({ id: 'sample-furosemide-tab', displayName: 'furosemide 40 mg tablet', ingredientNames: ['furosemide'], ingredientRxcuis: ['4603'], packageNdcs: [], dosageForms: ['tablet'] }),
      item({ id: 'sample-acetaminophen', displayName: 'acetaminophen 500 mg tablet', ingredientNames: ['acetaminophen'], ingredientRxcuis: ['161'], packageNdcs: [], dosageForms: ['tablet'] }),
      item({ id: 'sample-insulin-glargine', displayName: 'insulin glargine 100 units/mL injection', ingredientNames: ['insulin glargine'], ingredientRxcuis: ['274783'], packageNdcs: [], dosageForms: ['injection'] }),
      item({ id: 'sample-metformin', displayName: 'metformin 500 mg tablet', ingredientNames: ['metformin'], ingredientRxcuis: ['6809'], packageNdcs: [], dosageForms: ['tablet'] }),
    ];

    const unrelatedDrugs: FdaShortageRecord[] = [
      { generic_name: 'Lamivudine Tablet', package_ndc: '49702-205-48', dosage_form: 'Tablet', status: 'Current', openfda: { generic_name: ['LAMIVUDINE'], substance_name: ['LAMIVUDINE'] } },
      { generic_name: 'Abacavir Sulfate Tablet', package_ndc: '49702-222-48', dosage_form: 'Tablet', status: 'Current', openfda: { generic_name: ['ABACAVIR SULFATE'], substance_name: ['ABACAVIR'] } },
      { generic_name: 'Olipudase Alfa-rpcp Injection', package_ndc: '58468-005-11', dosage_form: 'Injection', status: 'Current', openfda: { generic_name: ['OLIPUDASE ALFA-RPCP'] } },
      { generic_name: 'Bendamustine Hydrochloride Injection', package_ndc: '42367-521-25', dosage_form: 'Injection', status: 'Current', openfda: { generic_name: ['BENDAMUSTINE HYDROCHLORIDE'] } },
      { generic_name: 'Somatropin Injection', package_ndc: '55566-180-11', dosage_form: 'Injection', status: 'Current', openfda: { generic_name: ['SOMATROPIN'] } },
      { generic_name: 'Demeclocycline Hydrochloride Tablet', package_ndc: '53746-555-48', dosage_form: 'Tablet', status: 'Current', openfda: { generic_name: ['DEMECLOCYCLINE HYDROCHLORIDE'] } },
      { generic_name: 'Oseltamivir Phosphate Capsule', package_ndc: '0004-0822-05', dosage_form: 'Capsule', status: 'Current', openfda: { generic_name: ['OSELTAMIVIR PHOSPHATE'] } },
      { generic_name: 'Medroxyprogesterone Acetate Injection', package_ndc: '0009-0287-01', dosage_form: 'Injection', status: 'Current', openfda: { generic_name: ['MEDROXYPROGESTERONE ACETATE'] } },
      { generic_name: 'Spironolactone Tablet', package_ndc: '0025-1041-31', dosage_form: 'Tablet', status: 'Current', openfda: { generic_name: ['SPIRONOLACTONE'] } },
      { generic_name: 'Propranolol Hydrochloride Tablet', package_ndc: '0228-2778-11', dosage_form: 'Tablet', status: 'Current', openfda: { generic_name: ['PROPRANOLOL HYDROCHLORIDE'] } },
    ];

    const matches = matchShortages(unrelatedDrugs, sampleFormulary, INDEX);
    expect(matches).toHaveLength(0);
  });
});
