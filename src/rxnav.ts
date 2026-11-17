import { IngredientRef } from './types';
import { normalizeNdc } from './match';

const BASE = 'https://rxnav.nlm.nih.gov/REST';

export interface RxNavClientOptions {
  fetchImpl?: typeof fetch;
  /** Cache get/set injected so tests stay offline; production uses Forge KVS. */
  cacheGet?: (key: string) => Promise<unknown | undefined>;
  cacheSet?: (key: string, value: unknown) => Promise<void>;
}

export class RxNavClient {
  constructor(private opts: RxNavClientOptions = {}) {}

  private get f() {
    return this.opts.fetchImpl ?? fetch;
  }

  private async cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    const hit = (await this.opts.cacheGet?.(key)) as T | undefined;
    if (hit !== undefined) return hit;
    const value = await load();
    await this.opts.cacheSet?.(key, value);
    return value;
  }

  /** Resolve a package NDC to its RxNorm concept, or null when unknown. */
  async ndcToConcept(
    ndc: string,
  ): Promise<{ rxcui: string; conceptName: string } | null> {
    const ndc11 = normalizeNdc(ndc);
    if (!ndc11) return null;
    return this.cached(`rxnav:ndc:${ndc11}`, async () => {
      const res = await this.f(`${BASE}/ndcstatus.json?ndc=${encodeURIComponent(ndc)}`);
      if (!res.ok) return null;
      const body = (await res.json()) as {
        ndcStatus?: { rxcui?: string; conceptName?: string };
      };
      const s = body.ndcStatus;
      return s?.rxcui ? { rxcui: s.rxcui, conceptName: s.conceptName ?? '' } : null;
    });
  }

  /** Ingredient concepts (TTY=IN) for an rxcui. */
  async ingredientsForRxcui(rxcui: string): Promise<IngredientRef[]> {
    const out = await this.cached(`rxnav:in:${rxcui}`, async () => {
      const res = await this.f(`${BASE}/rxcui/${rxcui}/related.json?tty=IN`);
      if (!res.ok) return [];
      const body = (await res.json()) as {
        relatedGroup?: {
          conceptGroup?: {
            tty: string;
            conceptProperties?: { rxcui: string; name: string }[];
          }[];
        };
      };
      const refs: IngredientRef[] = [];
      for (const g of body.relatedGroup?.conceptGroup ?? []) {
        if (g.tty !== 'IN') continue;
        for (const p of g.conceptProperties ?? []) refs.push({ rxcui: p.rxcui, name: p.name });
      }
      return refs;
    });
    return out ?? [];
  }
}
