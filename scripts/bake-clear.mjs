// Deletes the saved static-lighting bake so the next launch bakes once and saves
// again. This is the only way a bake is ever invalidated: code never decides.
//
//   npm run bake:clear            lists what would go, asks nothing, deletes nothing
//   npm run bake:clear -- --yes   deletes
//   npm run bake:clear -- --dir <path> [--yes]   another bake directory (cef-fsapp `?bakeDir=`)
//
// Refuses any directory that holds files other than bake artefacts (*.bin,
// *.json, *.stream.json, *.tmp, blobs/*.chunk), so a wrong --dir cannot delete a
// project.
import { readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const at = args.indexOf('--dir');
const dir = path.resolve(at >= 0 ? args[at + 1] : 'public/bakes');
const yes = args.includes('--yes');
const bakeFile = /^([a-f0-9]{64}(\.[0-9a-f-]+)?\.(bin|json|stream\.json|tmp))$/;

let entries;
try { entries = readdirSync(dir); } catch { console.log(`${dir}: no such directory, nothing to clear`); process.exit(0); }
const strangers = entries.filter((name) => !(bakeFile.test(name) || (name === 'blobs' && statSync(path.join(dir, name)).isDirectory())));
if (strangers.length) { console.error(`${dir} holds files that are not bake artefacts, refusing: ${strangers.slice(0, 5).join(', ')}`); process.exit(1); }
let bytes = 0, files = 0;
const walk = (d) => { for (const name of readdirSync(d)) { const p = path.join(d, name); const s = statSync(p); if (s.isDirectory()) walk(p); else { bytes += s.size; files++; } } };
walk(dir);
console.log(`${dir}: ${files} files, ${(bytes / 1048576).toFixed(0)} MB`);
if (!files) process.exit(0);
if (!yes) { console.log('dry run — add --yes to delete'); process.exit(0); }
for (const name of entries) rmSync(path.join(dir, name), { recursive: true, force: true });
console.log('deleted; the next launch bakes once and saves');
