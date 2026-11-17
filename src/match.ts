import {
  FdaShortageRecord,
  FormularyItem,
  IngredientIndex,
  MatchResult,
} from './types';

/** Salt suffixes stripped when falling back to name matching. */
const SALT_WORDS = new Set([
  'sodium', 'hydrochloride', 'hcl', 'bitartrate', 'sulfate', 'phosphate',
  'acetate', 'maleate', 'tartrate', 'bromide', 'chloride', 'potassium',
  'calcium', 'meglumine', 'mesylate', 'besylate', 'succinate', 'citrate',
  'lactobionate', 'pamoate', 'hydrobromide', 'disodium', 'monosodium',
]);

/** Normalize a package NDC to its 11-digit digit-only form. */
export function normalizeNdc(ndc: string | undefined): string | null {
  if (!ndc) return null;
  const digits = ndc.replace(/\D/g, '');
  return digits.length === 0 ? null : digits;
}

/** Lowercase, collapse whitespace, strip punctuation. */
export function normalizeDrugName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Remove common salt-form words from an already-normalized name. */
export function stripSalts(normalizedName: string): string {
  const words = normalizedName.split(' ').filter((w) => !SALT_WORDS.has(w));
  return words.join(' ').trim();
}

export function normalizeDosageForm(form: string | undefined): string {
  return normalizeDrugName(form ?? '');
}

/** Stable key for a shortage record: its package NDC when present. */
export function shortageKey(record: FdaShortageRecord): string {
  const ndc = normalizeNdc(record.package_ndc);
  if (ndc) return `ndc:${ndc}`;
  const base = [
    record.generic_name ?? '',
    record.presentation ?? '',
    record.company_name ?? '',
  ].join('|');
  return `rec:${normalizeDrugName(base)}`;
}

/** All candidate names for a record: generic name plus openfda names. */
export function candidateNames(record: FdaShortageRecord): string[] {
  const names = new Set<string>();
  if (record.generic_name) names.add(normalizeDrugName(record.generic_name));
  for (const n of record.openfda?.generic_name ?? []) names.add(normalizeDrugName(n));
  for (const n of record.openfda?.substance_name ?? []) names.add(normalizeDrugName(n));
  for (const n of record.openfda?.brand_name ?? []) names.add(normalizeDrugName(n));
  names.delete('');
  return [...names];
}

/** Ingredient refs for every rxcui on the record, from the provided index. */
export function recordIngredients(
  record: FdaShortageRecord,
  index: IngredientIndex,
): { rxcui: string; name: string }[] {
  const found = new Map<string, string>();
  for (const rxcui of record.openfda?.rxcui ?? []) {
    for (const ref of index.get(rxcui) ?? []) found.set(ref.rxcui, ref.name);
  }
  return [...found.entries()].map(([rxcui, name]) => ({ rxcui, name }));
}

function dosageFormCompatible(record: FdaShortageRecord, item: FormularyItem): boolean {
  if (item.dosageForms.length === 0) return true;
  const form = normalizeDosageForm(record.dosage_form);
  if (!form) return true;
  return item.dosageForms.some((f) => form === f || form.includes(f) || f.includes(form));
}

/**
 * Match shortage records to formulary items.
 *
 * Order per the product spec: by package NDC first, then by RxNorm ingredient
 * plus dosage form, then a name fallback for records with empty openfda.
 * Every returned match records why it was made. Presentations are never
 * merged: each record is matched independently.
 */
export function matchShortages(
  records: FdaShortageRecord[],
  formulary: FormularyItem[],
  ingredientIndex: IngredientIndex,
): MatchResult[] {
  const matches: MatchResult[] = [];
  const seen = new Set<string>();

  const itemNdcIndex = new Map<string, FormularyItem[]>();
  for (const item of formulary) {
    for (const ndc of item.packageNdcs) {
      const list = itemNdcIndex.get(ndc) ?? [];
      list.push(item);
      itemNdcIndex.set(ndc, list);
    }
  }

  for (const record of records) {
    const key = shortageKey(record);
    const push = (item: FormularyItem, reason: MatchResult['reason'], detail: string) => {
      const id = `${key}:${item.id}:${reason}`;
      if (seen.has(id)) return;
      seen.add(id);
      matches.push({ shortageKey: key, formularyItemId: item.id, reason, detail });
    };

    // 1. NDC match. Only the record's own package_ndc counts: the openfda
    // package_ndc list covers the whole product family and would over-mark
    // sibling presentations, which the product keeps separate.
    const recordNdcs = new Set<string>();
    const pkgNdc = normalizeNdc(record.package_ndc);
    if (pkgNdc) recordNdcs.add(pkgNdc);
    let ndcMatched = false;
    for (const ndc of recordNdcs) {
      for (const item of itemNdcIndex.get(ndc) ?? []) {
        push(item, 'ndc', `package NDC ${record.package_ndc ?? ndc} is on the formulary`);
        ndcMatched = true;
      }
    }
    if (ndcMatched) continue;

    // 2. RxNorm ingredient + dosage form.
    const ingredients = recordIngredients(record, ingredientIndex);
    let ingredientMatched = false;
    for (const item of formulary) {
      const hit = ingredients.find(
        (ing) =>
          item.ingredientRxcuis.includes(ing.rxcui) ||
          item.ingredientNames.includes(stripSalts(ing.name)),
      );
      if (hit && dosageFormCompatible(record, item)) {
        push(
          item,
          'ingredient_rxcui',
          `RxNorm ingredient ${hit.name} (${hit.rxcui}) matches formulary item "${item.displayName}"` +
            (record.dosage_form ? `, dosage form ${record.dosage_form}` : ''),
        );
        ingredientMatched = true;
      }
    }
    if (ingredientMatched) continue;

    // 3. Name fallback (empty openfda, unmapped rxcuis). Salts stripped.
    for (const item of formulary) {
      for (const name of candidateNames(record)) {
        const base = stripSalts(name);
        if (
          base.length > 2 &&
          item.ingredientNames.some(
            (n) => base === n || base.includes(n) || n.includes(base),
          ) &&
          dosageFormCompatible(record, item)
        ) {
          push(
            item,
            'ingredient_name',
            `name "${name}" matches formulary ingredient of "${item.displayName}"`,
          );
          break;
        }
      }
    }
  }

  return matches;
}
