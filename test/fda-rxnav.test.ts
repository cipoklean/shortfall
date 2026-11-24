import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { fetchShortages, fetchStatusCounts } from '../src/fda';
import { RxNavClient, mapWithConcurrency } from '../src/rxnav';
import { FdaShortageRecord, OPENFDA_DISCLAIMER } from '../src/types';

const fx = (name: string) =>
  JSON.parse(readFileSync(join(__dirname, 'fixtures', name), 'utf8'));

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function makeRecords(count: number, offset = 0): FdaShortageRecord[] {
  return Array.from({ length: count }, (_, i) => ({
    package_ndc: `0338-${String(1000 + offset + i).padStart(4, '0')}-01`,
    generic_name: `Drug ${offset + i} Injection`,
    status: 'Current',
  }));
}

describe('fetchShortages', () => {
  it('pages through all results, passes AbortSignal, forwards api_key, and reports progress', async () => {
    const total = 250;
    const requestedUrls: string[] = [];
    const signals: (AbortSignal | undefined)[] = [];
    const progressCalls: [number, number][] = [];
    const sleeps: number[] = [];

    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const urlStr = String(input);
      requestedUrls.push(urlStr);
      signals.push(init?.signal ?? undefined);
      const url = new URL(urlStr);
      const skip = Number(url.searchParams.get('skip') ?? '0');
      const limit = Number(url.searchParams.get('limit') ?? '100');
      const remaining = Math.max(0, total - skip);
      const count = Math.min(limit, remaining);
      return jsonResponse({
        meta: {
          disclaimer: OPENFDA_DISCLAIMER,
          last_updated: '2026-11-13',
          results: { skip, limit, total },
        },
        results: makeRecords(count, skip),
      });
    }) as unknown as typeof fetch;

    const result = await fetchShortages({
      apiKey: 'test-key',
      fetchImpl,
      onProgress: (done, t) => progressCalls.push([done, t]),
      sleepImpl: async (ms) => {
        sleeps.push(ms);
      },
    });

    expect(result.complete).toBe(true);
    expect(result.records).toHaveLength(250);
    expect(result.total).toBe(250);
    expect(result.nextSkip).toBe(250);
    expect(result.lastUpdated).toBe('2026-11-13');
    expect(result.disclaimer).toBe(OPENFDA_DISCLAIMER);

    expect(requestedUrls).toHaveLength(3);
    expect(new URL(requestedUrls[0]).searchParams.get('skip')).toBe('0');
    expect(new URL(requestedUrls[1]).searchParams.get('skip')).toBe('100');
    expect(new URL(requestedUrls[2]).searchParams.get('skip')).toBe('200');
    expect(new URL(requestedUrls[0]).searchParams.get('api_key')).toBe('test-key');
    expect(signals.every((s) => s instanceof AbortSignal)).toBe(true);
    expect(progressCalls).toEqual([
      [100, 250],
      [200, 250],
      [250, 250],
    ]);
    expect(sleeps).toEqual([250, 250]);
  });

  it('stops early when shouldStop returns true and resumes via startSkip', async () => {
    const total = 200;
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      const skip = Number(url.searchParams.get('skip') ?? '0');
      const limit = Number(url.searchParams.get('limit') ?? '100');
      const count = Math.min(limit, Math.max(0, total - skip));
      return jsonResponse({
        meta: {
          disclaimer: OPENFDA_DISCLAIMER,
          last_updated: '2026-11-13',
          results: { skip, limit, total },
        },
        results: makeRecords(count, skip),
      });
    }) as unknown as typeof fetch;

    const first = await fetchShortages({
      fetchImpl,
      shouldStop: () => true,
      sleepImpl: async () => {},
    });
    expect(first.complete).toBe(false);
    expect(first.records).toHaveLength(100);
    expect(first.nextSkip).toBe(100);

    const resumed = await fetchShortages({
      fetchImpl,
      startSkip: first.nextSkip,
      sleepImpl: async () => {},
    });
    expect(resumed.complete).toBe(true);
    expect(resumed.records).toHaveLength(100);
    expect(resumed.nextSkip).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('retries HTTP 429 and 5xx with exponential backoff and succeeds', async () => {
    const sleeps: number[] = [];
    const responses = [
      jsonResponse({}, 429),
      jsonResponse({}, 503),
      jsonResponse({
        meta: {
          disclaimer: OPENFDA_DISCLAIMER,
          last_updated: '2026-11-13',
          results: { skip: 0, limit: 100, total: 2 },
        },
        results: makeRecords(2),
      }),
    ];
    let idx = 0;
    const fetchImpl = vi.fn(async () => responses[idx++]) as unknown as typeof fetch;

    const res = await fetchShortages({
      fetchImpl,
      sleepImpl: async (ms) => {
        sleeps.push(ms);
      },
    });

    expect(res.complete).toBe(true);
    expect(res.records).toHaveLength(2);
    expect(sleeps).toEqual([1000, 2000]);
  });

  it('throws after maxRetries is exhausted on persistent 429 and caps backoff at 16000ms', async () => {
    const sleeps: number[] = [];
    const fetchImpl = vi.fn(async () => jsonResponse({}, 429)) as unknown as typeof fetch;

    await expect(
      fetchShortages({
        fetchImpl,
        maxRetries: 6,
        sleepImpl: async (ms) => {
          sleeps.push(ms);
        },
      }),
    ).rejects.toThrow(/HTTP 429 after 6 retries/);

    expect(fetchImpl).toHaveBeenCalledTimes(7); // initial + 6 retries
    expect(sleeps).toEqual([1000, 2000, 4000, 8000, 16000, 16000]);
  });

  it('throws immediately on non-retryable 4xx without sleeping', async () => {
    const sleeps: number[] = [];
    const fetchImpl = vi.fn(async () => jsonResponse({}, 404)) as unknown as typeof fetch;

    await expect(
      fetchShortages({
        fetchImpl,
        sleepImpl: async (ms) => {
          sleeps.push(ms);
        },
      }),
    ).rejects.toThrow(/HTTP 404/);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
  });
});

describe('fetchStatusCounts', () => {
  it('parses status counts from the saved openFDA fixture', async () => {
    const fixture = fx('fda-count-status.json');
    const fetchImpl = vi.fn(async () => jsonResponse(fixture)) as unknown as typeof fetch;

    const res = await fetchStatusCounts({ fetchImpl, sleepImpl: async () => {} });
    expect(res.counts).toEqual({
      Current: 1114,
      'To Be Discontinued': 407,
      Resolved: 59,
    });
    expect(res.lastUpdated).toBe('2026-11-13');
    expect(res.disclaimer).toBe(OPENFDA_DISCLAIMER);
  });

  it('retries transient 502 errors', async () => {
    const fixture = fx('fda-count-status.json');
    const sleeps: number[] = [];
    let attempt = 0;
    const fetchImpl = vi.fn(async () =>
      attempt++ === 0 ? jsonResponse({}, 502) : jsonResponse(fixture),
    ) as unknown as typeof fetch;

    const res = await fetchStatusCounts({
      fetchImpl,
      sleepImpl: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(res.counts.Current).toBe(1114);
    expect(sleeps).toEqual([1000]);
  });
});

describe('RxNavClient', () => {
  it('resolves ndcToConcept using fixtures and shares HIPAA 11-digit cache key', async () => {
    const ndcFixture = fx('rxnav-ndcstatus-0338350841.json');
    const comboNdcFixture = fx('rxnav-ndcstatus-6332346217.json');
    const cache = new Map<string, unknown>();
    const signals: (AbortSignal | undefined)[] = [];

    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      signals.push(init?.signal ?? undefined);
      const url = String(input);
      if (url.includes('0338-3508-41')) return jsonResponse(ndcFixture);
      if (url.includes('63323-462-17')) return jsonResponse(comboNdcFixture);
      return jsonResponse({}, 404);
    }) as unknown as typeof fetch;

    const client = new RxNavClient({
      fetchImpl,
      cacheGet: async (k) => cache.get(k),
      cacheSet: async (k, v) => {
        cache.set(k, v);
      },
    });

    // Miss on 10-digit hyphenated NDC (4-4-2 -> 00338350841)
    const first = await client.ndcToConcept('0338-3508-41');
    expect(first).toEqual({ rxcui: '1665060', conceptName: 'cefazolin 2000 MG Injection' });
    expect(cache.has('rxnav:ndc:00338350841')).toBe(true);
    expect(signals[0]).toBeInstanceOf(AbortSignal);

    // Hit via raw 11-digit HIPAA NDC — zero extra network calls
    const cached = await client.ndcToConcept('00338350841');
    expect(cached).toEqual(first);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // 5-3-2 NDC -> 63323046217
    const comboConcept = await client.ndcToConcept('63323-462-17');
    expect(comboConcept?.rxcui).toBe('1673296');
    expect(cache.has('rxnav:ndc:63323046217')).toBe(true);

    // Blank NDC returns null without fetching
    expect(await client.ndcToConcept('')).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('caches nameToRxcui case-insensitively and returns null on HTTP failure', async () => {
    const cache = new Map<string, unknown>();
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.toLowerCase().includes('cefazolin')) {
        return jsonResponse({ idGroup: { rxnormId: ['2180'] } });
      }
      return jsonResponse({}, 500);
    }) as unknown as typeof fetch;

    const client = new RxNavClient({
      fetchImpl,
      cacheGet: async (k) => cache.get(k),
      cacheSet: async (k, v) => {
        cache.set(k, v);
      },
    });

    expect(await client.nameToRxcui('Cefazolin')).toBe('2180');
    expect(await client.nameToRxcui('CEFAZOLIN')).toBe('2180');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(cache.get('rxnav:name:cefazolin')).toBe('2180');

    expect(await client.nameToRxcui('unknown-drug')).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('resolves and caches ingredientsForRxcui from saved fixture', async () => {
    const relatedFixture = fx('rxnav-related-1665060.json');
    const cache = new Map<string, unknown>();
    const fetchImpl = vi.fn(async () => jsonResponse(relatedFixture)) as unknown as typeof fetch;

    const client = new RxNavClient({
      fetchImpl,
      cacheGet: async (k) => cache.get(k),
      cacheSet: async (k, v) => {
        cache.set(k, v);
      },
    });

    const first = await client.ingredientsForRxcui('1665060');
    expect(first).toEqual([{ rxcui: '2180', name: 'cefazolin' }]);
    expect(cache.has('rxnav:in:1665060')).toBe(true);

    const second = await client.ingredientsForRxcui('1665060');
    expect(second).toEqual(first);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('mapWithConcurrency', () => {
  it('preserves input order and respects the concurrency bound', async () => {
    const items = [50, 10, 40, 5, 30, 15, 25, 20];
    let inFlight = 0;
    let maxInFlight = 0;

    const out = await mapWithConcurrency(items, 3, async (delayMs) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, delayMs));
      inFlight--;
      return delayMs * 2;
    });

    expect(out).toEqual(items.map((x) => x * 2));
    expect(maxInFlight).toBeLessThanOrEqual(3);
    expect(maxInFlight).toBe(3);
  });

  it('handles empty inputs and clamps concurrency < 1 to 1', async () => {
    expect(await mapWithConcurrency([], 5, async (x) => x)).toEqual([]);

    let inFlight = 0;
    let maxInFlight = 0;
    const out = await mapWithConcurrency(['a', 'b', 'c'], 0, async (s) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return s.toUpperCase();
    });
    expect(out).toEqual(['A', 'B', 'C']);
    expect(maxInFlight).toBe(1);
  });

  it('propagates errors and stops launching new work', async () => {
    const started: number[] = [];
    await expect(
      mapWithConcurrency([1, 2, 3, 4, 5, 6], 2, async (n) => {
        started.push(n);
        await new Promise((r) => setTimeout(r, 5));
        if (n === 2) throw new Error('boom');
        return n;
      }),
    ).rejects.toThrow('boom');
    expect(started.length).toBeLessThan(6);
  });
});
