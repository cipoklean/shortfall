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

/** Dosage-form and route words stripped by `baseIngredientName`. */
const DOSAGE_FORM_WORDS = new Set([
  'injection', 'injections', 'injectable',
  'tablet', 'tablets', 'tab', 'tabs',
  'capsule', 'capsules', 'cap', 'caps',
  'solution', 'solutions',
  'suspension', 'suspensions',
  'powder', 'powders',
  'concentrate', 'concentrates',
  'emulsion', 'emulsions',
  'syrup', 'elixir', 'lozenge', 'lozenges',
  'cream', 'ointment', 'gel', 'jelly', 'lotion', 'foam', 'paste',
  'spray', 'patch', 'suppository', 'suppositories', 'drops', 'enema',
  'oral', 'topical', 'ophthalmic', 'otic', 'nasal', 'inhalation',
  'intravenous', 'intramuscular', 'subcutaneous', 'rectal', 'vaginal',
  'extended', 'delayed', 'immediate', 'sustained', 'controlled', 'release',
  'chewable', 'effervescent', 'lyophilized', 'reconstitution', 'for', 'sterile',
  'premix', 'premixed', 'infusion', 'irrigant', 'irrigation',
]);

/**
 * Normalize a package NDC to its HIPAA 11-digit (5-4-2) digit-only form.
 * Hyphenated FDA 10-digit formats (4-4-2, 5-3-2, 5-4-1) are zero-padded into
 * the proper segment; 5-4-2 is concatenated directly; unhyphenated inputs
 * fall back to stripping non-digits.
 */
export function normalizeNdc(ndc: string | undefined): string | null {
  if (!ndc) return null;
  const trimmed = ndc.trim();
  if (!trimmed) return null;
  const parts = /^(\d+)-(\d+)-(\d+)$/.exec(trimmed);
  if (parts) {
    const [, a, b, c] = parts;
    if (a.length === 4 && b.length === 4 && c.length === 2) return `0${a}${b}${c}`;
    if (a.length === 5 && b.length === 3 && c.length === 2) return `${a}0${b}${c}`;
    if (a.length === 5 && b.length === 4 && c.length === 1) return `${a}${b}0${c}`;
    if (a.length === 5 && b.length === 4 && c.length === 2) return `${a}${b}${c}`;
  }
  const digits = trimmed.replace(/\D/g, '');
  return digits.length === 0 ? null : digits;
}

/** Source URL for an FDA shortage record (openFDA NDC search, or FDA portal). */
export function fdaSourceUrl(packageNdc?: string | null): string {
  const trimmed = packageNdc?.trim();
  if (trimmed) {
    return `https://api.fda.gov/drug/shortages.json?search=package_ndc:%22${encodeURIComponent(trimmed)}%22`;
  }
  return 'https://dps.fda.gov/drugshortages';
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

/**
 * Derive a clean base ingredient key from an FDA generic name by stripping
 * diluent phrases ("in dextrose", "in sodium chloride", "in water"), dosage
 * form words, and salt suffixes.
 */
export function baseIngredientName(genericName: string): string {
  const withoutDiluent = genericName
    .toLowerCase()
    .replace(
      /\bin\s+(?:\d+(?:\.\d+)?\s*%?\s+)?(?:dextrose|sodium\s+chloride|water(?:\s+for\s+injection)?|lactated\s+ringer\S*|ringer\S*)\b/g,
      ' ',
    );
  const normalized = normalizeDrugName(withoutDiluent);
  if (!normalized) return '';
  const withoutForms = normalized
    .split(' ')
    .filter((w) => w && !DOSAGE_FORM_WORDS.has(w))
    .join(' ')
    .trim();
  const withoutSalts = stripSalts(withoutForms);
  return withoutSalts || withoutForms || normalizeDrugName(genericName);
}

export function normalizeDosageForm(form: string | undefined): string {
  return normalizeDrugName(form ?? '');
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Whole-word boundary check that `haystackBase` contains `needleBase`.
 * Prevents substring false positives (e.g. "norepinephrine" matching
 * "epinephrine", "hydromorphone" matching "morphine") and avoids reversing
 * specificity ("insulin" matching "insulin glargine").
 */
export function matchesIngredientToken(haystackBase: string, needleBase: string): boolean {
  const haystack = haystackBase.trim();
  const needle = needleBase.trim();
  if (needle.length <= 2 || haystack.length <= 2) return false;
  const pattern = new RegExp(`(?:^|\\s)${escapeRegex(needle)}(?:$|\\s)`);
  return pattern.test(haystack);
}

function normalizeIngredientKey(name: string): string {
  const norm = normalizeDrugName(name);
  return stripSalts(norm) || norm;
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
    for (const rawNdc of item.packageNdcs) {
      const ndc = normalizeNdc(rawNdc);
      if (!ndc) continue;
      const list = itemNdcIndex.get(ndc) ?? [];
      if (!list.includes(item)) list.push(item);
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
    // Combination formulary items (multiple ingredients) must match ALL of
    // their ingredients against the record; single-ingredient items match any
    // record containing that ingredient.
    const ingredients = recordIngredients(record, ingredientIndex);
    let ingredientMatched = false;
    if (ingredients.length > 0) {
      const recByRxcui = new Map(ingredients.map((ing) => [ing.rxcui, ing]));
      const recByBaseName = new Map(
        ingredients.map((ing) => [normalizeIngredientKey(ing.name), ing]),
      );

      for (const item of formulary) {
        if (!dosageFormCompatible(record, item)) continue;
        const itemRxcuis = [...new Set(item.ingredientRxcuis.filter(Boolean))];
        const itemNames = [
          ...new Set(item.ingredientNames.map(normalizeIngredientKey).filter(Boolean)),
        ];
        if (itemRxcuis.length === 0 && itemNames.length === 0) continue;

        let matchedRefs: { rxcui: string; name: string }[] | null = null;
        if (
          itemRxcuis.length > 0 &&
          itemRxcuis.length >= itemNames.length &&
          itemRxcuis.every((c) => recByRxcui.has(c))
        ) {
          matchedRefs = itemRxcuis.map((c) => recByRxcui.get(c)!);
        } else if (
          itemNames.length > 0 &&
          itemNames.length >= itemRxcuis.length &&
          itemNames.every((n) => recByBaseName.has(n))
        ) {
          matchedRefs = itemNames.map((n) => recByBaseName.get(n)!);
        }

        if (matchedRefs && matchedRefs.length > 0) {
          const desc =
            matchedRefs.length === 1
              ? `RxNorm ingredient ${matchedRefs[0].name} (${matchedRefs[0].rxcui}) matches`
              : `RxNorm ingredients ${matchedRefs.map((h) => `${h.name} (${h.rxcui})`).join(' + ')} match`;
          push(
            item,
            'ingredient_rxcui',
            `${desc} formulary item "${item.displayName}"` +
              (record.dosage_form ? `, dosage form ${record.dosage_form}` : ''),
          );
          ingredientMatched = true;
        }
      }
    }
    if (ingredientMatched) continue;

    // 3. Name fallback (empty openfda, unmapped rxcuis). Salts stripped,
    // whole-word boundaries, and combination items must match every ingredient.
    const candidates = candidateNames(record).map((name) => ({
      name,
      base: normalizeIngredientKey(name),
    }));
    for (const item of formulary) {
      const itemNames = [
        ...new Set(item.ingredientNames.map(normalizeIngredientKey).filter(Boolean)),
      ];
      if (itemNames.length === 0) continue;
      if (!dosageFormCompatible(record, item)) continue;

      const matchedNames: string[] = [];
      let allMatched = true;
      for (const needle of itemNames) {
        const hit = candidates.find((c) => matchesIngredientToken(c.base, needle));
        if (!hit) {
          allMatched = false;
          break;
        }
        if (!matchedNames.includes(hit.name)) matchedNames.push(hit.name);
      }

      if (allMatched) {
        push(
          item,
          'ingredient_name',
          `name "${matchedNames.join(' / ')}" matches formulary ingredient of "${item.displayName}"`,
        );
      }
    }
  }

  return matches;
}
