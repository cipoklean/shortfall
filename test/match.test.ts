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
} from '../src/match';
import {
  FdaShortageRecord,
  FdaShortagesResponse,
  FormularyItem,
  IngredientIndex,
} from '../src/types';

const fx = (name: string) =>
  JSON.parse(readFileSync(join(__dirname, 'fixtures', name), 'utf8'));

const cefazolin = (fx('fda-shortages-cefazolin.json') as FdaShortagesResponse).results!;
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

describe('normalizeNdc', () => {
  it('strips dashes to digits', () => {
    expect(normalizeNdc('0338-3508-41')).toBe('0338350841');
    expect(normalizeNdc('')).toBeNull();
    expect(normalizeNdc(undefined)).toBeNull();
  });
});

describe('name handling', () => {
  it('strips salts', () => {
    expect(stripSalts(normalizeDrugName('CEFAZOLIN SODIUM'))).toBe('cefazolin');
    expect(stripSalts(normalizeDrugName('bupivacaine hydrochloride'))).toBe('bupivacaine');
    expect(stripSalts(normalizeDrugName('lidocaine'))).toBe('lidocaine');
  });

  it('collects candidate names from record and openfda', () => {
    const names = candidateNames(cefazolin[0]);
    expect(names).toContain('cefazolin in dextrose injection');
    expect(names).toContain('cefazolin sodium');
    expect(names).toContain('cefazolin'); // brand_name CEFAZOLIN
  });
});

describe('shortageKey', () => {
  it('uses package NDC and keeps presentations separate', () => {
    const keys = new Set(cefazolin.map(shortageKey));
    expect(keys.size).toBe(3); // 3 presentations -> 3 keys, never merged
    expect(shortageKey(cefazolin[0])).toBe('ndc:0338350841');
  });

  it('falls back to a record key when package NDC is missing', () => {
    const noNdc = { ...cefazolin[0], package_ndc: undefined };
    expect(shortageKey(noNdc)).toMatch(/^rec:/);
  });
});

describe('matchShortages', () => {
  it('matches by package NDC first', () => {
    const formulary = [
      item({ id: 'cef-2g', displayName: 'cefazolin 2g premix', packageNdcs: ['0338350841'] }),
    ];
    const matches = matchShortages(cefazolin, formulary, INDEX);
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ formularyItemId: 'cef-2g', reason: 'ndc' });
  });

  it('does not match other presentations of the same drug by NDC', () => {
    const formulary = [item({ packageNdcs: ['0338350841'] })];
    const matches = matchShortages(cefazolin, formulary, INDEX);
    const keys = matches.map((m) => m.shortageKey);
    expect(keys).toContain('ndc:0338350841');
    expect(keys).not.toContain('ndc:0338009606');
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

  it('matches combination products to each ingredient it contains', () => {
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
    // "sensorcaine" is contained -> name match.
    expect(matches.some((m) => m.reason === 'ingredient_name')).toBe(true);
  });
});
