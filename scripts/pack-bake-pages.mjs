import { createHash, randomUUID } from 'node:crypto';
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';
import { mkdir, writeFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { createLightmapPages } from '../src/shared/render/virtualTexture/lightmapPages.ts';

const compress = promisify(gzip);
const sha = data => createHash('sha256').update(data).digest('hex');

/** Publish immutable compressed chunks first, then atomically replace the manifest. */
export async function packBakePages(directory, key, data) {
  const header = Array.from({ length: 8 }, (_, i) => data.readUInt32LE(i * 4));
  const [magic, version, size, capacity, count, spatial, moments, depth] = header;
  const lengths = [size * size * 4, spatial, moments, depth, count * 72];
  const end = 32 + lengths.reduce((a, b) => a + b * 4, 0);
  if (magic !== 0x42474957 || version !== 2 || size < 2 || size > 4096 || !Number.isInteger(Math.log2(size)) || count < 1 || count > capacity || capacity > 1048576 || spatial !== count * 8 || moments !== count * 20 || depth !== count * 64 || end + 32 !== data.length || sha(data.subarray(0, end)) !== data.subarray(end).toString('hex')) throw new Error('Invalid source bake for page packing');
  const blobDirectory = path.join(directory, 'blobs');
  await mkdir(blobDirectory, { recursive: true });
  async function blob(raw) {
    const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
    const hash = sha(bytes), compressed = await compress(bytes, { level: 6 });
    const temporary = path.join(blobDirectory, `${hash}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, compressed);
      await rename(temporary, path.join(blobDirectory, `${hash}.chunk`));
    } finally { await unlink(temporary).catch(() => {}); }
    return { hash, bytes: compressed.length, rawBytes: bytes.length };
  }
  let offset = 32;
  const chunks = lengths.map(length => { const chunk = data.subarray(offset, offset + length * 4); offset += length * 4; return chunk; });
  const pixels = new Float32Array(chunks[0].buffer, chunks[0].byteOffset, lengths[0]);
  const pageSize = Math.min(128, size / 2);
  const source = createLightmapPages(pixels, size, pageSize, pageSize);
  const manifest = { version: 3, key, size, pageSize, gutter: source.gutter, fallbackMip: source.fallbackMip, capacity, count,
    fallback: await blob(source.fallback), surfels: {}, pages: {} };
  for (const [i, name] of ['spatial', 'moments', 'depth', 'guiding'].entries()) manifest.surfels[name] = await blob(chunks[i + 1]);
  for (let mip = 0; mip < source.fallbackMip; mip++) {
    const side = size / 2 ** mip / pageSize;
    for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) manifest.pages[`${mip}/${x}/${y}`] = await blob(await source.load({ mip, x, y }));
  }
  const temporary = path.join(directory, `${key}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify(manifest));
    await rename(temporary, path.join(directory, `${key}.stream.json`));
  } finally { await unlink(temporary).catch(() => {}); }
  return manifest;
}
