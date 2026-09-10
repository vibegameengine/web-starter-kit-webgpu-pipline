
export interface FrozenSurfelData {
  capacity: number;
  count: number;
  spatial: Float32Array;
  moments: Float32Array;
  depth: Float32Array;
  guiding: Float32Array;
}
export interface PersistedProbes {
  min: [number, number, number];
  spacing: number;
  dims: [number, number, number];
  irradiance: Float32Array;
  irradianceSun: Float32Array;
  distance: Float32Array;
  probeData: Float32Array;
  bakedSunIntensity: number;
}
export interface PersistedBake { size: number; pixels: Float32Array; surfels: FrozenSurfelData; probes?: PersistedProbes }
const PROBE_BLOCK_MAGIC = 0x32425250;
const PROBE_HEADER_WORDS = 16;
const BAKE_VERSION = 3;
const digest = async (data: Uint8Array<ArrayBuffer>) => new Uint8Array(await crypto.subtle.digest('SHA-256', data));
const hex = (data: Uint8Array) => Array.from(data, v => v.toString(16).padStart(2, '0')).join('');

/**
 * The bake's name: one scene, one bake. The user's rule (2026-09-08): a saved bake
 * is loaded, a missing one is baked and saved, and nothing in code ever decides to
 * rebake — a person deletes the file (`npm run bake:clear`) when a change touched
 * the light. The key used to hash every source file and every static mesh, so
 * every edit anywhere rebaked the scene and saved another 60–130 MB bundle: 42 GB
 * of them by the day this was written. The name is still spelled as 64 hex digits
 * because the manifest, the dev-server routes and the packer check that shape.
 */
export async function bakeKey(sceneName: string): Promise<string> {
  return hex(await digest(new TextEncoder().encode(`bake:${sceneName}`)));
}

function encodeProbeBlock(probes: PersistedProbes): ArrayBuffer {
  const arrays = [probes.irradiance, probes.distance, probes.probeData, probes.irradianceSun];
  const words = PROBE_HEADER_WORDS + arrays.reduce((n, a) => n + a.length, 0);
  const buffer = new ArrayBuffer(words * 4);
  const header = new Uint32Array(buffer, 0, PROBE_HEADER_WORDS);
  header.set([PROBE_BLOCK_MAGIC, ...probes.dims, ...arrays.map((a) => a.length)]);
  new Float32Array(buffer, 32, 5).set([...probes.min, probes.spacing, probes.bakedSunIntensity]);
  const body = new Float32Array(buffer, PROBE_HEADER_WORDS * 4);
  let at = 0;
  for (const array of arrays) { body.set(array, at); at += array.length; }
  return buffer;
}

function decodeProbeBlock(buffer: ArrayBuffer, offset: number, end: number): PersistedProbes | undefined {
  const header = new Uint32Array(buffer, offset, PROBE_HEADER_WORDS);
  if (header[0] !== PROBE_BLOCK_MAGIC) { console.warn('[bake-cache] probe block from an older format; probes will be baked again'); return undefined; }
  const [minX, minY, minZ, spacing, bakedSunIntensity] = new Float32Array(buffer, offset + 32, 5);
  const lengths = [header[4], header[5], header[6], header[7]];
  if (offset + (PROBE_HEADER_WORDS + lengths.reduce((a, b) => a + b, 0)) * 4 !== end) throw new Error('Truncated probe block');
  let at = offset + PROBE_HEADER_WORDS * 4;
  const arrays = lengths.map((length) => { const array = new Float32Array(buffer, at, length); at += length * 4; return array; });
  return { min: [minX, minY, minZ], spacing, dims: [header[1], header[2], header[3]], irradiance: arrays[0], distance: arrays[1], probeData: arrays[2], irradianceSun: arrays[3], bakedSunIntensity };
}

export async function encodeBake(bake: PersistedBake): Promise<ArrayBuffer> {
  const { surfels: s } = bake;
  const probeBlock = bake.probes ? new Float32Array(encodeProbeBlock(bake.probes)) : new Float32Array(0);
  const chunks = [bake.pixels, s.spatial, s.moments, s.depth, s.guiding, probeBlock];
  const size = 32 + chunks.reduce((n, a) => n + a.byteLength, 0);
  const buffer = new ArrayBuffer(size + 32);
  new Uint32Array(buffer, 0, 8).set([0x42474957, BAKE_VERSION, bake.size, s.capacity, s.count, s.spatial.length, s.moments.length, s.depth.length]);
  let offset = 32;
  for (const chunk of chunks) { new Uint8Array(buffer, offset, chunk.byteLength).set(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)); offset += chunk.byteLength; }
  new Uint8Array(buffer, size).set(await digest(new Uint8Array(buffer, 0, size)));
  return buffer;
}

export async function decodeBake(buffer: ArrayBuffer): Promise<PersistedBake> {
  if (buffer.byteLength < 64 || buffer.byteLength % 4) throw new Error('Truncated bake');
  const [magic, version, size, capacity, count, spatial, moments, depth] = new Uint32Array(buffer, 0, 8);
  // `size` 0 is a surfel-only cache: the warmed radiance cache with no lightmap.
  if (magic !== 0x42474957 || (version !== 2 && version !== BAKE_VERSION) || (size !== 0 && (size < 2 || size > 4096 || !Number.isInteger(Math.log2(size)))) || count < 1 || count > capacity || capacity > 1048576 || spatial !== count * 8 || moments !== count * 20 || depth !== count * 64) throw new Error('Incompatible bake header');
  const lengths = [size * size * 4, spatial, moments, depth, count * 72];
  const surfelEnd = 32 + lengths.reduce((a, b) => a + b * 4, 0);
  const end = buffer.byteLength - 32;
  if (end < surfelEnd || hex(await digest(new Uint8Array(buffer, 0, end))) !== hex(new Uint8Array(buffer, end))) throw new Error('Bake checksum mismatch');
  let offset = 32;
  const chunks = lengths.map(length => { const array = new Float32Array(buffer, offset, length); offset += length * 4; return array; });
  const probes = end > surfelEnd ? decodeProbeBlock(buffer, surfelEnd, end) : undefined;
  return { size, pixels: chunks[0], surfels: { capacity, count, spatial: chunks[1], moments: chunks[2], depth: chunks[3], guiding: chunks[4] }, probes };
}

/**
 * The page's own filesystem when it runs inside cef-fsapp (a CEF runtime that binds
 * Node's `fs` into the page as `globalThis.fs`, synchronous, no IPC). Bakes are then
 * read and written as files directly, with no dev server: `?bakeDir=` names the
 * directory, else `<page dir>/bakes`.
 */
type PageFs = { readFileSync(path: string): Uint8Array; writeFileSync(path: string, data: Uint8Array): void; existsSync(path: string): boolean; mkdirSync(path: string, options?: { recursive: boolean }): void; renameSync(from: string, to: string): void; readdirSync(path: string): string[]; unlinkSync(path: string): void };
function pageFs(): { fs: PageFs; dir: string } | null {
  const g = globalThis as unknown as { fs?: PageFs; __dirname?: string };
  if (!g.fs || typeof g.fs.readFileSync !== 'function') return null;
  const dir = new URLSearchParams(location.search).get('bakeDir') ?? `${g.__dirname ?? '.'}/bakes`;
  return { fs: g.fs, dir };
}

export function bakeStorageKind(): 'fs' | 'http' {
  return pageFs() ? 'fs' : 'http';
}

export async function loadBake(key: string): Promise<PersistedBake | null> {
  const local = pageFs();
  if (local) {
    const file = `${local.dir}/${key}.bin`;
    if (!local.fs.existsSync(file)) return null;
    const bytes = local.fs.readFileSync(file);
    const bake = await decodeBake(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
    console.log(`[bake-cache] read ${file} (${(bytes.byteLength / 1048576).toFixed(0)} MB) from the page filesystem`);
    return bake;
  }
  const response = await fetch(`/bakes/${key}.bin`);
  if (!response.ok || response.status === 204 || response.headers.get('content-type')?.includes('text/html')) return null;
  return decodeBake(await response.arrayBuffer());
}
export async function saveBake(key: string, bake: PersistedBake): Promise<void> {
  const encoded = await encodeBake(bake);
  const local = pageFs();
  if (local) {
    // Written whole, then renamed: a launch that dies mid-write leaves no half bake
    // under the real name to be read as corrupt next time.
    local.fs.mkdirSync(local.dir, { recursive: true });
    // One bake of each kind per scene: replace this key's files, leave the other kind.
    for (const name of local.fs.readdirSync(local.dir)) if (name.startsWith(key)) local.fs.unlinkSync(`${local.dir}/${name}`);
    const temporary = `${local.dir}/${key}.${Date.now()}.tmp`;
    local.fs.writeFileSync(temporary, new Uint8Array(encoded));
    local.fs.renameSync(temporary, `${local.dir}/${key}.bin`);
    console.log(`[bake-cache] wrote ${local.dir}/${key}.bin (${(encoded.byteLength / 1048576).toFixed(0)} MB) to the page filesystem`);
    return;
  }
  // Authoring data contains large float arrays. Compress on the wire as well as
  // in the page store; keep the decoded format/checksum unchanged.
  const compressed = new Blob([encoded]).stream().pipeThrough(new CompressionStream('gzip'));
  const body = await new Response(compressed).arrayBuffer();
  const response = await fetch(`/__bake_cache/${key}`, { method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream', 'Content-Encoding': 'gzip' }, body });
  if (!response.ok) throw new Error(`Project bake save unavailable (${response.status})`);
}
