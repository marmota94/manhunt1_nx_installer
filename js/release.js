// SPDX-License-Identifier: LGPL-2.1-only
// Port release metadata and the preflight check of the user's game files.

export const PORT_ROOT = 'switch/manhunt1_nx/';
const HEX64 = /^[0-9a-f]{64}$/;
const VERSION = /^\d+\.\d+\.\d+$/;
const SAFE_SEGMENT = /^[A-Za-z0-9_.\- ]+$/;

export function safeRelativePath(p) {
  if (typeof p !== 'string' || p === '' || p.length > 1024) return false;
  return p.split('/').every((s) => SAFE_SEGMENT.test(s) && s !== '.' && s !== '..');
}

export function checkManifest(m) {
  const fail = (what) => { throw new Error(`Release manifest: ${what}`); };
  if (!m || typeof m !== 'object') fail('not an object');
  if (typeof m.version !== 'string' || !VERSION.test(m.version)) fail('bad version');
  if (!m.nro || !safeRelativePath(m.nro.path)) fail('bad nro.path');
  if (!HEX64.test(m.nro.sha256 ?? '')) fail('bad nro.sha256');
  if (!Number.isSafeInteger(m.nro.bytes) || m.nro.bytes <= 0) fail('bad nro.bytes');
  const g = m.game;
  if (!g || !SAFE_SEGMENT.test(g.install_dir ?? '') || g.install_dir === '.' || g.install_dir === '..') fail('bad game.install_dir');
  if (!safeRelativePath(g.asset_manifest)) fail('bad game.asset_manifest');
  if (!HEX64.test(g.default_xbe_sha256 ?? '')) fail('bad game.default_xbe_sha256');
  return m;
}

export function archiveName(version) {
  return `manhunt1-nx-v${version}.zip`;
}
export function outputName(version) {
  return `manhunt1-nx-v${version}-sd.zip`;
}

// Lines: "<sha256>  <bytes>  <path>". Lines starting with '#' are comments.
export function parseAssetManifest(text) {
  const assets = [];
  const seen = new Set();
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, '');
    if (line.trim() === '' || line.startsWith('#')) continue;
    const m = /^([0-9a-f]{64}) {2}(\d+) {2}(.+)$/.exec(line);
    if (!m) throw new Error(`Asset manifest line ${i + 1}: bad format`);
    const size = Number(m[2]);
    const path = m[3];
    if (!Number.isSafeInteger(size)) throw new Error(`Asset manifest line ${i + 1}: bad size`);
    if (!safeRelativePath(path)) throw new Error(`Asset manifest line ${i + 1}: unsafe path`);
    const key = path.toLowerCase();
    if (seen.has(key)) throw new Error(`Asset manifest: duplicate path ${path}`);
    seen.add(key);
    assets.push({ sha256: m[1], size, path });
  }
  if (assets.length === 0) throw new Error('Asset manifest is empty');
  return assets;
}

export function xbeAsset(assets) {
  return assets.find((a) => a.path.toLowerCase() === 'default.xbe');
}

// sources: [{ path, size, ...anything }] with '/' separators, relative to the
// game root. Paths are matched ignoring case; files the manifest does not list
// are ignored. Returns the plan in manifest order and the problems found.
export function preflight(assets, sources) {
  const byKey = new Map();
  const ambiguous = [];
  for (const s of sources) {
    const key = s.path.toLowerCase();
    if (byKey.has(key)) ambiguous.push(s.path);
    else byKey.set(key, s);
  }
  const plan = [];
  const missing = [];
  const wrongSize = [];
  for (const a of assets) {
    const s = byKey.get(a.path.toLowerCase());
    if (!s) { missing.push(a.path); continue; }
    if (s.size !== a.size) { wrongSize.push({ path: a.path, expected: a.size, actual: s.size }); continue; }
    plan.push({ ...s, path: a.path, size: a.size, sha256: a.sha256, sourcePath: s.path });
  }
  const assetKeys = new Set(assets.map((a) => a.path.toLowerCase()));
  return {
    plan,
    missing,
    wrongSize,
    ambiguous: ambiguous.filter((p) => assetKeys.has(p.toLowerCase())),
  };
}

// Folder input: webkitRelativePath is "<picked folder>/<...>". The game root is
// the shallowest folder that holds DEFAULT.xbe, so picking a parent works too.
export function folderSources(files) {
  const all = files.map((f) => ({ file: f, rel: (f.webkitRelativePath || f.name).replace(/\\/g, '/') }));
  let root = null;
  for (const { rel } of all) {
    const parts = rel.split('/');
    if (parts[parts.length - 1].toLowerCase() !== 'default.xbe') continue;
    const dir = parts.slice(0, -1).join('/');
    if (root === null || dir.split('/').length < root.split('/').length) root = dir;
  }
  if (root === null) root = all.length ? all[0].rel.split('/')[0] : '';
  const prefix = root ? root + '/' : '';
  return all
    .filter(({ rel }) => rel.startsWith(prefix))
    .map(({ file, rel }) => ({ path: rel.slice(prefix.length), size: file.size, file, offset: 0 }));
}

export async function inflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
