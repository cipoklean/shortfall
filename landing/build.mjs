#!/usr/bin/env node
/**
 * Shortfall landing build: copies src/ -> dist/, injects config tokens
 * ({{key}}) from config/site.json, and tries to fetch the live openFDA
 * shortage count so the page has a build-time fallback.
 */
import { readFileSync, writeFileSync, cpSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(join(root, 'config/site.json'), 'utf8'));

// Best-effort build-time fetch for the counter fallback.
try {
  const res = await fetch('https://api.fda.gov/drug/shortages.json?count=status', {
    signal: AbortSignal.timeout(8000),
  });
  if (res.ok) {
    const body = await res.json();
    const current = (body.results ?? []).find((r) => r.term === 'Current');
    if (current) {
      config.fdaCountFallback = String(current.count);
      config.fdaCountFallbackDate = body.meta?.last_updated ?? config.fdaCountFallbackDate;
      console.log(`FDA count fetched at build: ${config.fdaCountFallback} (${config.fdaCountFallbackDate})`);
    }
  }
} catch {
  console.log('FDA fetch failed at build; using configured fallback.');
}

const dist = join(root, 'dist');
mkdirSync(dist, { recursive: true });
cpSync(join(root, 'src'), dist, { recursive: true });

const htmlFiles = ['index.html', 'setup.html', 'privacy.html', 'support.html'];
for (const file of htmlFiles) {
  const path = join(dist, file);
  if (!existsSync(path)) continue;
  let html = readFileSync(path, 'utf8');
  for (const [key, value] of Object.entries(config)) {
    if (key.startsWith('_')) continue;
    html = html.replaceAll(`{{${key}}}`, String(value));
  }
  writeFileSync(path, html);
  if (file !== 'index.html') {
    const cleanDir = join(dist, file.replace(/\.html$/, ''));
    mkdirSync(cleanDir, { recursive: true });
    writeFileSync(join(cleanDir, 'index.html'), html);
  }
}

// Counter fallback also available as JSON for the runtime fetch path.
writeFileSync(
  join(dist, 'fda-count.json'),
  JSON.stringify({ count: config.fdaCountFallback, lastUpdated: config.fdaCountFallbackDate }),
);

console.log(`Built ${htmlFiles.length} pages -> dist/`);
