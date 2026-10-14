// Build helper: copies the non-TypeScript assets into dist/ so the compiled
// tree is runnable on its own. tsc cannot emit these, and the runtime looks
// for them next to the code that reads them:
//   gateway/*.json  read via import.meta.dirname by daemon/proxy/anomaly
//   sandbox/        the docker build context execute.ts points at
// Plain .mjs on purpose: build tooling, not part of the compiled app.
import { cpSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

const ASSETS = [
  'gateway/policy.json',
  'gateway/hooks-settings.json',
  'sandbox',
];

for (const asset of ASSETS) {
  const to = path.join(ROOT, 'dist', asset);
  mkdirSync(path.dirname(to), { recursive: true });
  cpSync(path.join(ROOT, asset), to, { recursive: true });
}
console.log(`copied ${ASSETS.length} asset paths into dist/`);
