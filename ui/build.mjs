#!/usr/bin/env node
/* Bundles ui/<name>/index.js -> static/<name>/app.js (Custom UI resources). */
import { build } from 'esbuild';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url)) + '/..';
for (const name of ['dashboard', 'byline', 'issue-panel']) {
  await build({
    entryPoints: [join(root, 'ui', name, 'index.js')],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    outfile: join(root, 'static', name, 'app.js'),
    logLevel: 'warning',
  });
  console.log(`bundled ui/${name} -> static/${name}/app.js`);
}
