import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

const ROUTE = '/__gui_settings';
const MAX_BYTES = 1024 * 1024;
const SCENE_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

export function guiSettingsPlugin({ directory = 'config' } = {}) {
  let root;
  return {
    name: 'project-gui-settings',
    configResolved(config) { root = path.join(config.root, directory); },
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const [route, query] = (req.url ?? '').split('?');
        if (route !== ROUTE) return next();
        const scene = new URLSearchParams(query ?? '').get('scene');
        if (scene !== null && !SCENE_PATTERN.test(scene)) { res.statusCode = 400; res.end('Invalid scene'); return; }
        const target = path.join(root, scene ? `gui-settings.${scene}.json` : 'gui-settings.json');
        if (req.method === 'GET') return serve(target, res);
        if (req.method === 'PUT') return store(target, req, res);
        if (req.method === 'DELETE') return drop(target, req, res);
        res.statusCode = 405; res.end();
      });
    },
  };
}

async function serve(target, res) {
  try {
    const body = await readFile(target);
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    res.end(body);
  } catch (error) {
    res.statusCode = error.code === 'ENOENT' ? 204 : 500;
    res.end(error.code === 'ENOENT' ? undefined : String(error));
  }
}

async function store(target, req, res) {
  if (req.headers.origin !== `http://${req.headers.host}` || !String(req.headers['content-type']).startsWith('application/json')) {
    res.statusCode = 403; res.end(); return;
  }
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    const settings = validate(JSON.parse(await readBody(req)));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`);
    await rename(temporary, target);
    res.statusCode = 204; res.end();
  } catch (error) {
    await unlink(temporary).catch(() => {});
    res.statusCode = 400; res.end(String(error));
  }
}

async function drop(target, req, res) {
  if (req.headers.origin !== `http://${req.headers.host}`) { res.statusCode = 403; res.end(); return; }
  try {
    await unlink(target);
    res.statusCode = 204; res.end();
  } catch (error) {
    res.statusCode = error.code === 'ENOENT' ? 204 : 500;
    res.end(error.code === 'ENOENT' ? undefined : String(error));
  }
}

async function readBody(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BYTES) throw new Error('GUI settings exceed 1 MiB');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function validate(node, depth = 0) {
  if (depth > 8 || typeof node !== 'object' || node === null) throw new Error('Invalid GUI settings');
  const controllers = node.controllers ?? {};
  for (const value of Object.values(controllers)) {
    if (!['number', 'string', 'boolean'].includes(typeof value)) throw new Error('GUI settings hold a non-scalar value');
  }
  const folders = {};
  for (const [title, child] of Object.entries(node.folders ?? {})) folders[title] = validate(child, depth + 1);
  return { controllers, folders };
}
