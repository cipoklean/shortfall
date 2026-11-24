import { IngredientRef } from './types';
import { normalizeNdc } from './match';

const BASE = 'https://rxnav.nlm.nih.gov/REST';
const DEFAULT_TIMEOUT_MS = 10_000;

export interface RxNavClientOptions {
  fetchImpl?: typeof fetch;
  /** Cache get/set injected so tests stay offline; production uses Forge KVS. */
  cacheGet?: (key: string) => Promise<unknown | undefined>;
  cacheSet?: (key: string, value: unknown) => Promise<void>;
  /** Per-request timeout in ms (0 disables AbortSignal). Defaults to 10000. */
  timeoutMs?: number;
}

/**
 * Map an async function over `items` with bounded concurrency, preserving
 * input order in the returned array.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const limit = Math.max(1, Math.floor(concurrency));
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  let failed = false;

  const worker = async (): Promise<void> => {
    while (!failed) {
      const idx = nextIndex++;
      if (idx >= items.length) return;
      try {
        results[idx] = await fn(items[idx]);
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  };

  const workerCount = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

export class RxNavClient {
  constructor(private opts: RxNavClientOptions = {}) {}

  private get f() {
    return this.opts.fetchImpl ?? fetch;
  }

  private fetchUrl(url: string): Promise<Response> {
    const timeoutMs = this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    return timeoutMs > 0
      ? this.f(url, { signal: AbortSignal.timeout(timeoutMs) })
      : this.f(url);
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
      const res = await this.fetchUrl(`${BASE}/ndcstatus.json?ndc=${encodeURIComponent(ndc)}`);
      if (!res.ok) return null;
      const body = (await res.json()) as {
        ndcStatus?: { rxcui?: string; conceptName?: string };
      };
      const s = body.ndcStatus;
      return s?.rxcui ? { rxcui: s.rxcui, conceptName: s.conceptName ?? '' } : null;
    });
  }

  /** Look up the RxNorm concept id for a drug name, or null. */
  async nameToRxcui(name: string): Promise<string | null> {
    const key = `rxnav:name:${name.toLowerCase()}`;
    return this.cached(key, async () => {
      const res = await this.fetchUrl(
        `${BASE}/rxcui.json?name=${encodeURIComponent(name)}&search=2`,
      );
      if (!res.ok) return null;
      const body = (await res.json()) as {
        idGroup?: { rxnormId?: string[] };
      };
      return body.idGroup?.rxnormId?.[0] ?? null;
    });
  }

  /** Ingredient concepts (TTY=IN) for an rxcui. */
  async ingredientsForRxcui(rxcui: string): Promise<IngredientRef[]> {
    const out = await this.cached(`rxnav:in:${rxcui}`, async () => {
      const res = await this.fetchUrl(`${BASE}/rxcui/${rxcui}/related.json?tty=IN`);
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
