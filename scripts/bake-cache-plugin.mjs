import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, readFile, mkdir, rm, writeFile, rename, unlink, stat } from 'node:fs/promises';
import path from 'node:path';
import { packBakePages } from './pack-bake-pages.mjs';
import { gunzip } from 'node:zlib';
import { promisify } from 'node:util';
const decompressBake = promisify(gunzip);

export function bakeCachePlugin() {
  let root;
  return {
    name: 'project-bake-cache',
    async configResolved(config) { root = config.root; },
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const asset = /^\/bakes\/((?:[a-f0-9]{64}\.(?:bin|stream\.json))|(?:blobs\/[a-f0-9]{64}\.chunk))$/.exec(req.url ?? '');
        if (asset && req.method === 'GET') {
          // These files are excluded from HMR. Serve them explicitly because Vite's
          // public-file inventory otherwise misses files written after server start.
          try {
            const file = path.join(root, 'public', 'bakes', asset[1]);
            const info = await stat(file);
            res.setHeader('Content-Type', asset[1].endsWith('.json') ? 'application/json' : 'application/octet-stream');
            res.setHeader('Content-Length', info.size);
            res.setHeader('Cache-Control', asset[1].endsWith('.chunk') ? 'public, max-age=31536000, immutable' : 'no-store');
            createReadStream(file).on('error', () => res.destroy()).pipe(res);
          } catch { res.statusCode = 204; res.end(); }
          return;
        }
        const match = /^\/__bake_cache\/([a-f0-9]{64})$/.exec(req.url ?? '');
        if (!match) return next();
        // This development-only write route is limited to the same browser origin
        // and one content-keyed file inside this checkout. Preview/build are read-only.
        if (req.method !== 'PUT' || req.headers.origin !== `http://${req.headers.host}` || req.headers['content-type'] !== 'application/octet-stream') {
          res.statusCode = 403; res.end(); return;
        }
        const directory = path.join(root, 'public', 'bakes');
        const temporary = path.join(directory, `${match[1]}.${randomUUID()}.tmp`);
        try {
          const chunks = []; let size = 0;
          for await (const chunk of req) {
            size += chunk.length;
            if (size > 128 * 1024 * 1024) throw new Error('Bake exceeds development storage limit');
            chunks.push(chunk);
          }
          const payload = Buffer.concat(chunks);
          const encoding = req.headers['content-encoding'];
          if (encoding && encoding !== 'gzip') throw new Error('Unsupported bake encoding');
          const data = encoding === 'gzip'
            ? await decompressBake(payload, { maxOutputLength: 128 * 1024 * 1024 })
            : payload;
          if (data.length < 32 || data.readUInt32LE(0) !== 0x42474957) throw new Error('Invalid bake');
          // One bake of each kind per scene: this key's files are replaced, the
          // other kind's are left alone. Keeping every key ever produced is how this
          // directory reached 42 GB (2026-09-08).
          await mkdir(directory, { recursive: true });
          for (const name of await readdir(directory)) {
            if (name.startsWith(match[1])) await rm(path.join(directory, name), { recursive: true, force: true });
          }
          // A surfel-only cache declares no lightmap (size 0) and has no pages to pack.
          if (data.readUInt32LE(8) > 0) await packBakePages(directory, match[1], data);
          await writeFile(temporary, data);
          await rename(temporary, path.join(directory, `${match[1]}.bin`));
          await writeFile(path.join(directory, `${match[1]}.json`), JSON.stringify({
            key: match[1], format: 'Webgiya frozen static bake', version: data.readUInt32LE(4),
            atlasSize: data.readUInt32LE(8), capacity: data.readUInt32LE(12), pinnedSurfels: data.readUInt32LE(16),
            bytes: data.length, sha256: createHash('sha256').update(data).digest('hex'),
          }, null, 2));
          res.statusCode = 204; res.end();
        } catch (error) {
          await unlink(temporary).catch(() => {});
          res.statusCode = 500; res.end(String(error));
        }
      });
    },
  };
}
