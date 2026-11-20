// SPDX-License-Identifier: LGPL-2.1-only
import { sha256Hex } from './sha256.js';
import { crc32 } from './crc32.js';
import { readCentralDirectory, entryDataOffset } from './zip.js';
import { readXdvdfs } from './xdvdfs.js';
import {
  PORT_ROOT, checkManifest, archiveName, outputName, parseAssetManifest, xbeAsset,
  preflight, folderSources, inflateRaw,
} from './release.js';
import {
  newSessionId, isSessionId, holdSession, sessionLock, reclaimStaging, removeOwnStaging, stagingDirName,
} from './staging.js';

const $ = (id) => document.getElementById(id);
const ui = {
  release: $('release-status'),
  iso: $('iso-input'),
  folder: $('folder-input'),
  preflight: $('preflight'),
  build: $('build'),
  cancel: $('cancel'),
  progressBox: $('progress-box'),
  progress: $('progress'),
  pct: $('progress-pct'),
  file: $('progress-file'),
  buildStatus: $('build-status'),
  save: $('save'),
  discard: $('discard'),
};

const state = {
  sessionId: newSessionId(),
  release: null, // { manifest, assets, xbe, zipBytes, entries }
  plan: null,
  xbeBytes: null,
  worker: null,
  selection: 0,
};

// ---------- small DOM helpers (no innerHTML, no inline styles) ----------

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
function show(target, ...nodes) {
  target.replaceChildren(...nodes);
}
function line(cls, text) {
  return el('p', cls, text);
}
function list(items) {
  const ul = el('ul');
  for (const it of items) ul.append(typeof it === 'string' ? el('li', null, it) : it);
  return ul;
}
function formatBytes(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + ' GB';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + ' MB';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + ' kB';
  return n + ' bytes';
}

// ---------- start-up ----------

function unsupportedBrowser() {
  const missing = [];
  if (!window.isSecureContext) missing.push('a secure (https) page');
  if (!('serviceWorker' in navigator)) missing.push('service workers');
  if (!navigator.storage?.getDirectory) missing.push('the origin-private file system');
  // Sync access handles exist only inside workers; the worker reports if they fail.
  if (typeof FileSystemFileHandle === 'undefined') missing.push('file system handles');
  if (!navigator.locks) missing.push('Web Locks');
  if (typeof DecompressionStream === 'undefined') missing.push('DecompressionStream');
  return missing;
}

async function reclaim() {
  // A reopened tab first frees the staging directory of its earlier session.
  let prev = null;
  try {
    prev = sessionStorage.getItem('manhunt1-nx-session');
    sessionStorage.setItem('manhunt1-nx-session', state.sessionId);
  } catch { /* storage blocked */ }
  if (prev && isSessionId(prev) && prev !== state.sessionId) {
    try {
      await navigator.locks.request(sessionLock(prev), { signal: AbortSignal.timeout(3000) }, async () => {
        const root = await navigator.storage.getDirectory();
        await root.removeEntry(stagingDirName(prev), { recursive: true }).catch(() => {});
      });
    } catch { /* still held; reclaimStaging retries on a later visit */ }
  }
  await reclaimStaging(state.sessionId);
}

async function fetchOk(url, cache) {
  const r = await fetch(url, { cache });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r;
}

async function loadRelease() {
  const manifest = checkManifest(await (await fetchOk('release/manifest.json', 'no-cache')).json());
  const zipBytes = new Uint8Array(await (await fetchOk('release/' + archiveName(manifest.version), 'no-cache')).arrayBuffer());
  const read = async (o, n) => {
    if (o + n > zipBytes.length) throw new Error('Port ZIP is truncated');
    return zipBytes.subarray(o, o + n);
  };
  const entries = await readCentralDirectory(read, zipBytes.length);
  const contents = new Map();
  for (const e of entries) {
    if (!e.name.startsWith(PORT_ROOT) || e.name.includes('..') || e.name.includes('\\')) throw new Error(`Port ZIP: unexpected entry ${e.name}`);
    if (e.flags & 1) throw new Error(`Port ZIP: ${e.name} is encrypted`);
    if (e.method !== 0 && e.method !== 8) throw new Error(`Port ZIP: ${e.name} uses an unsupported compression method`);
    if (e.name.endsWith('/')) continue;
    const at = await entryDataOffset(read, e);
    const raw = await read(at, e.compSize);
    const data = e.method === 8 ? await inflateRaw(raw) : raw;
    if (data.length !== e.size || crc32(data) !== e.crc) throw new Error(`Port ZIP: ${e.name} is damaged (CRC or size mismatch)`);
    contents.set(e.name, data);
  }
  const nro = contents.get(PORT_ROOT + manifest.nro.path);
  if (!nro) throw new Error('Port ZIP: the NRO is missing');
  if (nro.length !== manifest.nro.bytes) throw new Error(`NRO size is ${nro.length} bytes, the manifest says ${manifest.nro.bytes}`);
  const nroHash = sha256Hex(nro);
  if (nroHash !== manifest.nro.sha256) throw new Error(`NRO SHA-256 mismatch: got ${nroHash}, the manifest says ${manifest.nro.sha256}`);
  const inner = contents.get(PORT_ROOT + 'manifest.json');
  if (inner) {
    const m = JSON.parse(new TextDecoder().decode(inner));
    if (m.version !== manifest.version || m.nro?.sha256 !== manifest.nro.sha256 || m.game?.default_xbe_sha256 !== manifest.game.default_xbe_sha256) {
      throw new Error('The manifest inside the port ZIP does not match release/manifest.json');
    }
  }
  const am = contents.get(PORT_ROOT + manifest.game.asset_manifest);
  if (!am) throw new Error('Port ZIP: the asset manifest is missing');
  const assets = parseAssetManifest(new TextDecoder().decode(am));
  const xbe = xbeAsset(assets);
  if (!xbe || xbe.sha256 !== manifest.game.default_xbe_sha256) throw new Error('The asset manifest and release manifest disagree on DEFAULT.xbe');
  return { manifest, assets, xbe, zipBytes, entries: entries.filter((e) => !e.name.endsWith('/')) };
}

async function init() {
  const missing = unsupportedBrowser();
  if (missing.length) {
    show(ui.release, line('error', `This browser cannot run the installer. It needs ${missing.join(', ')}. Use a current Chromium-based browser (Chrome, Edge, Brave, Opera).`));
    return;
  }
  holdSession(state.sessionId);
  reclaim().catch(() => {});
  navigator.serviceWorker.register('sw.js', { type: 'module', scope: './' }).catch((err) => {
    show(ui.release, line('error', 'Could not start the download service worker: ' + err.message));
  });
  try {
    state.release = await loadRelease();
  } catch (err) {
    show(ui.release, line('error', 'Could not load the port release. ' + err.message));
    return;
  }
  show(ui.release, line('ok', `Port release v${state.release.manifest.version}`));
  ui.iso.disabled = false;
  ui.folder.disabled = false;
}

// ---------- selection and preflight ----------

function resetBuild() {
  state.plan = null;
  state.xbeBytes = null;
  ui.build.disabled = true;
  ui.save.hidden = true;
  ui.discard.hidden = true;
  ui.progressBox.hidden = true;
  show(ui.buildStatus);
}

async function readRange(file, offset, size) {
  const b = await file.slice(offset, offset + size).arrayBuffer();
  if (b.byteLength !== size) throw new Error('Short read');
  return new Uint8Array(b);
}

async function onIso() {
  const file = ui.iso.files[0];
  if (!file) return;
  ui.folder.value = '';
  const sel = ++state.selection;
  resetBuild();
  show(ui.preflight, line(null, `Reading ${file.name}…`));
  try {
    const img = await readXdvdfs((o, n) => readRange(file, o, n), file.size);
    if (sel !== state.selection) return;
    const sources = img.files.map((f) => ({ path: f.path, size: f.size, offset: f.offset, file }));
    await runPreflight(sources, `${img.layout} image`, sel);
  } catch (err) {
    if (sel === state.selection) show(ui.preflight, line('error', err.message));
  }
}

async function onFolder() {
  const files = [...ui.folder.files];
  if (!files.length) return;
  ui.iso.value = '';
  const sel = ++state.selection;
  resetBuild();
  show(ui.preflight, line(null, `Checking ${files.length} files…`));
  try {
    await runPreflight(folderSources(files), 'folder', sel);
  } catch (err) {
    if (sel === state.selection) show(ui.preflight, line('error', err.message));
  }
}

async function runPreflight(sources, label, sel) {
  const { assets, xbe } = state.release;
  const res = preflight(assets, sources);
  const problems = [];
  if (res.missing.length) {
    problems.push(line('error', `${res.missing.length} missing file${res.missing.length === 1 ? '' : 's'}:`), list(res.missing));
  }
  if (res.wrongSize.length) {
    problems.push(line('error', `${res.wrongSize.length} file${res.wrongSize.length === 1 ? ' has' : 's have'} the wrong size:`),
      list(res.wrongSize.map((w) => `${w.path}: ${w.actual} bytes, expected ${w.expected}`)));
  }
  if (res.ambiguous.length) {
    problems.push(line('error', 'These files appear more than once with different letter case:'), list(res.ambiguous));
  }
  let xbeBytes = null;
  const xbeItem = res.plan.find((p) => p.path === xbe.path);
  if (xbeItem) {
    // Keep the verified bytes so packaging writes exactly this copy.
    xbeBytes = await readRange(xbeItem.file, xbeItem.offset, xbeItem.size);
    if (sel !== state.selection) return;
    const hash = sha256Hex(xbeBytes);
    if (hash !== xbe.sha256) {
      const p = line('error', 'Unsupported DEFAULT.xbe. Its SHA-256 is ');
      p.append(el('span', 'hash', hash), '. The port supports ', el('span', 'hash', xbe.sha256), '.');
      problems.unshift(p);
      xbeBytes = null;
    } else {
      xbeItem.cached = true;
    }
  }
  if (sel !== state.selection) return;
  if (problems.length) {
    show(ui.preflight, ...problems);
    return;
  }
  const total = res.plan.reduce((s, p) => s + p.size, 0);
  show(ui.preflight, line('ok', 'Manhunt (Xbox), supported'),
    line(null, `${res.plan.length} game files, ${formatBytes(total)}, from ${label}.`));
  state.plan = res.plan;
  state.xbeBytes = xbeBytes;
  ui.build.disabled = false;
}

// ---------- packaging ----------

function setBusy(busy) {
  ui.build.disabled = busy || !state.plan;
  ui.iso.disabled = busy;
  ui.folder.disabled = busy;
  ui.cancel.hidden = !busy;
}

function onProgress(done, total, file) {
  const f = total ? done / total : 1;
  ui.progress.value = f;
  ui.pct.textContent = `${Math.floor(f * 100)}%`;
  ui.file.textContent = file;
}

async function enoughSpace(needed) {
  try {
    const { quota, usage } = await navigator.storage.estimate();
    if (quota !== undefined && quota - (usage || 0) < needed) return quota - (usage || 0);
  } catch { /* unknown; try anyway */ }
  return true;
}

async function onBuild() {
  if (!state.plan || state.worker) return;
  const { manifest, zipBytes, entries } = state.release;
  const outName = outputName(manifest.version);
  resetBuildOutput();
  const needed = state.plan.reduce((s, p) => s + p.size, 0) + zipBytes.length + 64 * 1024 * 1024;
  const space = await enoughSpace(needed);
  if (space !== true) {
    show(ui.buildStatus, line('error', `Not enough browser storage: ${formatBytes(needed)} needed, ${formatBytes(space)} available. Free some disk space and try again.`));
    return;
  }
  await removeOwnStaging(state.sessionId);
  setBusy(true);
  ui.progressBox.hidden = false;
  onProgress(0, 1, 'Starting…');
  const worker = new Worker('js/worker.js', { type: 'module' });
  state.worker = worker;
  const finish = () => {
    worker.terminate();
    state.worker = null;
    setBusy(false);
  };
  worker.onmessage = async (ev) => {
    const m = ev.data;
    if (m.type === 'progress') {
      onProgress(m.done, m.total, m.file);
    } else if (m.type === 'done') {
      finish();
      onProgress(1, 1, '');
      await navigator.serviceWorker.ready;
      ui.save.href = `download/${state.sessionId}/${m.name}`;
      ui.save.textContent = `Save ${m.name}`;
      ui.save.hidden = false;
      ui.discard.hidden = false;
      show(ui.buildStatus, line('ok', `Package ready and verified: ${m.entries} files, ${formatBytes(m.bytes)}.`),
        line(null, 'Save it, then follow the steps below to install it.'));
    } else if (m.type === 'error') {
      finish();
      ui.progressBox.hidden = true;
      show(ui.buildStatus, line('error', 'Packaging failed. ' + m.message));
      await removeOwnStaging(state.sessionId);
    }
  };
  worker.onerror = async (ev) => {
    finish();
    show(ui.buildStatus, line('error', 'Packaging failed. ' + (ev.message || 'The worker stopped.')));
    await removeOwnStaging(state.sessionId);
  };
  worker.postMessage({
    type: 'build',
    sessionId: state.sessionId,
    outName,
    installPrefix: PORT_ROOT + manifest.game.install_dir + '/',
    port: { bytes: zipBytes.slice().buffer, entries },
    xbe: { bytes: state.xbeBytes },
    plan: state.plan.map((p) => ({ path: p.path, size: p.size, sha256: p.sha256, file: p.file, offset: p.offset, cached: !!p.cached })),
  });
}

function resetBuildOutput() {
  ui.save.hidden = true;
  ui.discard.hidden = true;
  show(ui.buildStatus);
}

async function onCancel() {
  if (!state.worker) return;
  state.worker.terminate();
  state.worker = null;
  setBusy(false);
  ui.progressBox.hidden = true;
  show(ui.buildStatus, line(null, 'Cancelled.'));
  // The worker's file handle closes as it shuts down.
  setTimeout(() => removeOwnStaging(state.sessionId), 500);
}

async function onDiscard() {
  await removeOwnStaging(state.sessionId);
  resetBuildOutput();
  ui.progressBox.hidden = true;
  show(ui.buildStatus, line(null, 'The staged package was deleted from browser storage.'));
}

ui.iso.addEventListener('change', onIso);
ui.folder.addEventListener('change', onFolder);
ui.build.addEventListener('click', onBuild);
ui.cancel.addEventListener('click', onCancel);
ui.discard.addEventListener('click', onDiscard);
window.addEventListener('beforeunload', (ev) => {
  if (state.worker) ev.preventDefault();
});

init();
