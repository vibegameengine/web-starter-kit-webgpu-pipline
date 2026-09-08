import type { FrozenSurfelData } from './persistedBake.ts';
import { pageId, type LightmapPageSource } from '../../render/virtualTexture/lightmapPages.ts';

interface Chunk { hash: string; bytes: number; rawBytes: number }
interface Manifest {
  version: number; key: string; size: number; pageSize: number; gutter: number; fallbackMip: number; capacity: number; count: number;
  fallback: Chunk;
  surfels: Record<'spatial' | 'moments' | 'depth' | 'guiding', Chunk>;
  pages: Record<string, Chunk>;
}

function validate(manifest: Manifest, key: string): void {
  const m = manifest;
  if (m.version !== 3 || m.key !== key || m.size < 2 || m.size > 4096 || !Number.isInteger(Math.log2(m.size)) || m.pageSize !== Math.min(128, m.size / 2) || m.gutter !== 2 || m.fallbackMip !== Math.log2(m.size / m.pageSize) || !Number.isInteger(m.count) || m.count < 1 || !Number.isInteger(m.capacity) || m.count > m.capacity || m.capacity > 1048576) throw new Error('Incompatible streamed bake');
  const chunk = (c: Chunk, bytes: number) => {
    if (!c || !/^[a-f0-9]{64}$/.test(c.hash) || !Number.isSafeInteger(c.bytes) || c.bytes < 1 || c.bytes > bytes + 1048576 || c.rawBytes !== bytes) throw new Error('Invalid bake chunk descriptor');
  };
  chunk(m.fallback, m.pageSize ** 2 * 16);
  for (const [name, floats] of Object.entries({ spatial: 8, moments: 20, depth: 64, guiding: 72 })) chunk(m.surfels[name as keyof typeof m.surfels], m.count * floats * 4);
  for (let mip = 0; mip < m.fallbackMip; mip++) {
    const side = m.size / 2 ** mip / m.pageSize;
    for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) chunk(m.pages[pageId({ mip, x, y })], (m.pageSize + m.gutter * 2) ** 2 * 16);
  }
}

async function readChunk(chunk: Chunk, signal?: AbortSignal): Promise<Float32Array> {
  // Keep the payload extension neutral. Some static servers interpret .gz as
  // HTTP Content-Encoding, so Fetch decodes it before our format decoder runs.
  const response = await fetch(`/bakes/blobs/${chunk.hash}.chunk`, { signal });
  if (!response.ok || response.status === 204 || !response.body) throw new Error('Bake chunk unavailable');
  const reader = response.body.pipeThrough(new DecompressionStream('gzip')).getReader();
  const raw = new Uint8Array(chunk.rawBytes);
  let offset = 0;
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      if (offset + value.length > raw.length) throw new Error('Bake chunk exceeds declared size');
      raw.set(value, offset); offset += value.length;
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  if (offset !== raw.length) throw new Error('Truncated bake chunk');
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', raw)), n => n.toString(16).padStart(2, '0')).join('');
  if (hash !== chunk.hash) throw new Error('Bake chunk checksum mismatch');
  return new Float32Array(raw.buffer);
}

/** No full-resolution lightmap or mip chain is fetched or retained on this path. */
export async function loadStreamedBake(key: string, loadParents = true): Promise<{ pages: LightmapPageSource; surfels: FrozenSurfelData | null } | null> {
  const response = await fetch(`/bakes/${key}.stream.json`, { cache: 'no-store' });
  if (!response.ok || response.status === 204 || !response.headers.get('content-type')?.includes('application/json')) return null;
  const manifest = await response.json() as Manifest;
  validate(manifest, key);
  const { size, pageSize, gutter, fallbackMip, capacity, count } = manifest;
  const fallback = await readChunk(manifest.fallback);
  // Legacy surfel transport restores parents. Baked-hit transport reads the shared
  // lightmap and never requests or allocates these four authoring arrays.
  const surfels = loadParents ? { capacity, count,
    spatial: await readChunk(manifest.surfels.spatial), moments: await readChunk(manifest.surfels.moments),
    depth: await readChunk(manifest.surfels.depth), guiding: await readChunk(manifest.surfels.guiding) } : null;
  let pageRequests = 0, decodedPageBytes = 0;
  const pages: LightmapPageSource = {
    size, pageSize, gutter, fallbackMip, fallback,
    async load(key, signal) {
      const chunk = manifest.pages[pageId(key)];
      if (!chunk) throw new Error('Unknown lightmap page');
      pageRequests++;
      const data = await readChunk(chunk, signal); decodedPageBytes += data.byteLength;
      return data;
    },
    stats: () => ({ kind: 'http-gzip', pageRequests, decodedPageBytes, fullAtlasResident: false }),
  };
  return { pages, surfels };
}
