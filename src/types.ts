/** FDA openFDA drug shortage record (one row per presentation/package NDC). */
export interface FdaShortageRecord {
  generic_name?: string;
  status?: string;
  presentation?: string;
  package_ndc?: string;
  dosage_form?: string;
  therapeutic_category?: string[];
  company_name?: string;
  availability?: string;
  update_type?: string;
  update_date?: string;
  initial_posting_date?: string;
  contact_info?: string;
  related_info?: string;
  discontinued_date?: string;
  openfda?: FdaOpenfdaSection;
}

export interface FdaOpenfdaSection {
  brand_name?: string[];
  generic_name?: string[];
  substance_name?: string[];
  rxcui?: string[];
  product_ndc?: string[];
  package_ndc?: string[];
  route?: string[];
  manufacturer_name?: string[];
  spl_set_id?: string[];
}

export interface FdaShortagesResponse {
  meta: {
    disclaimer: string;
    last_updated?: string;
    results?: { skip: number; limit: number; total: number };
  };
  results?: FdaShortageRecord[];
}

/** A drug on the site's own formulary/drug list. */
export interface FormularyItem {
  id: string;
  displayName: string;
  /** Normalized lowercase base ingredient names (salts stripped). */
  ingredientNames: string[];
  /** RxNorm ingredient concept IDs (TTY=IN). */
  ingredientRxcuis: string[];
  /** Normalized 11-digit package NDCs. */
  packageNdcs: string[];
  /** Normalized dosage forms, e.g. "injection". Empty = any form. */
  dosageForms: string[];
}

export type MatchReason = 'ndc' | 'ingredient_rxcui' | 'ingredient_name';

export interface MatchResult {
  /** Shortage key: normalized package NDC when present, else a stable record key. */
  shortageKey: string;
  formularyItemId: string;
  reason: MatchReason;
  /** Human-readable explanation stored with the match. */
  detail: string;
}

/** Maps an RxNorm concept rxcui to its ingredient concepts (TTY=IN). */
export interface IngredientRef {
  rxcui: string;
  name: string;
}

export type IngredientIndex = Map<string, IngredientRef[]>;
