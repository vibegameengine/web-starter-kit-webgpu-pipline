import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const [url, out] = process.argv.slice(2);
if (!url || !out) {
  console.error('usage: node scripts/fetch-reference.mjs <url> <outFile>');
  process.exit(1);
}

const response = await fetch(url, { redirect: 'follow' });
if (!response.ok) {
  console.error(`HTTP ${response.status} for ${url}`);
  process.exit(1);
}
const bytes = Buffer.from(await response.arrayBuffer());
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, bytes);
console.log(`${out} ${(bytes.length / 1e6).toFixed(2)} MB from ${response.url}`);
