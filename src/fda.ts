import { FdaShortageRecord, FdaShortagesResponse } from './types';

const BASE = 'https://api.fda.gov/drug/shortages.json';
const PAGE_LIMIT = 100; // openFDA allows up to 1000; keep pages small for resumability.
const REQUEST_DELAY_MS = 250;

export interface FdaClientOptions {
  apiKey?: string;
  /** Injected for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Called after each page with (recordsSoFar, total). */
  onProgress?: (done: number, total: number) => void;
  /** Resume from this skip offset. */
  startSkip?: number;
  /** Return true to stop early (used by the 25s UI path). */
  shouldStop?: () => boolean;
}

export interface FdaFetchResult {
  records: FdaShortageRecord[];
  total: number;
  nextSkip: number;
  complete: boolean;
  lastUpdated?: string;
  disclaimer?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Page through the openFDA drug shortages endpoint. Resumable via nextSkip.
 * openFDA paging: `skip` + `limit`, results capped at 25,000 records —
 * the shortage set is ~1,600 so a full sweep fits comfortably.
 */
export async function fetchShortages(opts: FdaClientOptions = {}): Promise<FdaFetchResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  let skip = opts.startSkip ?? 0;
  const records: FdaShortageRecord[] = [];
  let total = 0;
  let lastUpdated: string | undefined;
  let disclaimer: string | undefined;

  for (;;) {
    const url = new URL(BASE);
    url.searchParams.set('limit', String(PAGE_LIMIT));
    url.searchParams.set('skip', String(skip));
    if (opts.apiKey) url.searchParams.set('api_key', opts.apiKey);

    const res = await fetchImpl(url.toString());
    if (res.status === 429) {
      await sleep(2000);
      continue;
    }
    if (!res.ok) {
      throw new Error(`openFDA shortages fetch failed: HTTP ${res.status}`);
    }
    const body = (await res.json()) as FdaShortagesResponse;
    total = body.meta.results?.total ?? 0;
    lastUpdated = body.meta.last_updated ?? lastUpdated;
    disclaimer = body.meta.disclaimer ?? disclaimer;

    const page = body.results ?? [];
    records.push(...page);
    skip += page.length;
    opts.onProgress?.(records.length, total);

    if (page.length < PAGE_LIMIT || records.length >= total) {
      return { records, total, nextSkip: skip, complete: true, lastUpdated, disclaimer };
    }
    if (opts.shouldStop?.()) {
      return { records, total, nextSkip: skip, complete: false, lastUpdated, disclaimer };
    }
    await sleep(REQUEST_DELAY_MS);
  }
}

export async function fetchStatusCounts(
  opts: { apiKey?: string; fetchImpl?: typeof fetch } = {},
): Promise<{ counts: Record<string, number>; lastUpdated?: string; disclaimer?: string }> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const url = new URL(BASE);
  url.searchParams.set('count', 'status');
  if (opts.apiKey) url.searchParams.set('api_key', opts.apiKey);
  const res = await fetchImpl(url.toString());
  if (!res.ok) throw new Error(`openFDA count fetch failed: HTTP ${res.status}`);
  const body = (await res.json()) as {
    meta: { disclaimer: string; last_updated?: string };
    results?: { term: string; count: number }[];
  };
  const counts: Record<string, number> = {};
  for (const r of body.results ?? []) counts[r.term] = r.count;
  return { counts, lastUpdated: body.meta.last_updated, disclaimer: body.meta.disclaimer };
}
