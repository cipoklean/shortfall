import { FdaShortageRecord, FdaShortagesResponse } from './types';

const BASE = 'https://api.fda.gov/drug/shortages.json';
const PAGE_LIMIT = 100; // openFDA allows up to 1000; keep pages small for resumability.
const REQUEST_DELAY_MS = 250;
const DEFAULT_MAX_RETRIES = 5;
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_BACKOFF_MS = 16_000;

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
  /** Maximum retries on HTTP 429 or 5xx responses. Defaults to 5. */
  maxRetries?: number;
  /** Per-request timeout in ms (0 disables AbortSignal). Defaults to 15000. */
  timeoutMs?: number;
  /** Injected sleep for fast unit tests. */
  sleepImpl?: (ms: number) => Promise<void>;
}

export interface FdaFetchResult {
  records: FdaShortageRecord[];
  total: number;
  nextSkip: number;
  complete: boolean;
  lastUpdated?: string;
  disclaimer?: string;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

async function fetchWithRetry(
  url: string,
  label: string,
  opts: {
    fetchImpl?: typeof fetch;
    maxRetries?: number;
    timeoutMs?: number;
    sleepImpl?: (ms: number) => Promise<void>;
  },
): Promise<Response> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const sleep = opts.sleepImpl ?? defaultSleep;

  for (let attempt = 0; ; attempt++) {
    const res =
      timeoutMs > 0
        ? await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) })
        : await fetchImpl(url);

    if (res.ok) return res;

    if (isRetryableStatus(res.status)) {
      if (attempt >= maxRetries) {
        throw new Error(
          `openFDA ${label} fetch failed: HTTP ${res.status} after ${maxRetries} retries`,
        );
      }
      const backoffMs = Math.min(1000 * 2 ** attempt, MAX_BACKOFF_MS);
      await sleep(backoffMs);
      continue;
    }

    throw new Error(`openFDA ${label} fetch failed: HTTP ${res.status}`);
  }
}

/**
 * Page through the openFDA drug shortages endpoint. Resumable via nextSkip.
 * openFDA paging: `skip` + `limit`, results capped at 25,000 records —
 * the shortage set is ~1,600 so a full sweep fits comfortably.
 */
export async function fetchShortages(opts: FdaClientOptions = {}): Promise<FdaFetchResult> {
  const sleep = opts.sleepImpl ?? defaultSleep;
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

    const res = await fetchWithRetry(url.toString(), 'shortages', opts);
    const body = (await res.json()) as FdaShortagesResponse;
    total = body.meta.results?.total ?? 0;
    lastUpdated = body.meta.last_updated ?? lastUpdated;
    disclaimer = body.meta.disclaimer ?? disclaimer;

    const page = body.results ?? [];
    records.push(...page);
    skip += page.length;
    opts.onProgress?.(records.length, total);

    if (page.length < PAGE_LIMIT || skip >= total) {
      return { records, total, nextSkip: skip, complete: true, lastUpdated, disclaimer };
    }
    if (opts.shouldStop?.()) {
      return { records, total, nextSkip: skip, complete: false, lastUpdated, disclaimer };
    }
    await sleep(REQUEST_DELAY_MS);
  }
}

export async function fetchStatusCounts(
  opts: {
    apiKey?: string;
    fetchImpl?: typeof fetch;
    maxRetries?: number;
    timeoutMs?: number;
    sleepImpl?: (ms: number) => Promise<void>;
  } = {},
): Promise<{ counts: Record<string, number>; lastUpdated?: string; disclaimer?: string }> {
  const url = new URL(BASE);
  url.searchParams.set('count', 'status');
  if (opts.apiKey) url.searchParams.set('api_key', opts.apiKey);
  const res = await fetchWithRetry(url.toString(), 'count', opts);
  const body = (await res.json()) as {
    meta: { disclaimer: string; last_updated?: string };
    results?: { term: string; count: number }[];
  };
  const counts: Record<string, number> = {};
  for (const r of body.results ?? []) counts[r.term] = r.count;
  return { counts, lastUpdated: body.meta.last_updated, disclaimer: body.meta.disclaimer };
}
