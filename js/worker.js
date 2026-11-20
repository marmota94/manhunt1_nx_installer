// SPDX-License-Identifier: LGPL-2.1-only
// Builds the SD-card ZIP in the origin-private file system (OPFS).

import { Sha256 } from './sha256.js';
import { crc32 } from './crc32.js';
import {
  localHeader, centralHeader, endRecords, readCentralDirectory, entryDataOffset, LOCAL_CRC_OFFSET,
} from './zip.js';
import { stagingDirName } from './staging.js';

const SLICE = 512 * 1024;

self.onmessage = async (ev) => {
  if (ev.data?.type !== 'build') return;
  let handle = null;
  try {
    const result = await build(ev.data, (h) => { handle = h; });
    self.postMessage({ type: 'done', ...result });
  } catch (err) {
    try { handle?.close(); } catch { /* already closed */ }
    self.postMessage({ type: 'error', message: err?.message || String(err) });
  }
};

async function build(job, setHandle) {
  const { sessionId, outName, port, xbe, plan, installPrefix } = job;
  const root = await navigator.storage.getDirectory();
  const dir = await root.getDirectoryHandle(stagingDirName(sessionId), { create: true });
  const partName = outName + '.part';
  for (const name of [partName, outName]) {
    try { await dir.removeEntry(name); } catch { /* not there */ }
  }
  const fh = await dir.getFileHandle(partName, { create: true });
  const ah = await fh.createSyncAccessHandle();
  setHandle(ah);
  ah.truncate(0);

  const total = port.entries.reduce((s, e) => s + e.compSize, 0) + plan.reduce((s, f) => s + f.size, 0);
  let done = 0;
  let lastPost = 0;
  const progress = (file, force = false) => {
    const now = Date.now();
    if (force || now - lastPost > 100) {
      lastPost = now;
      self.postMessage({ type: 'progress', done, total, file });
    }
  };

  let pos = 0;
  const write = (bytes) => {
    const n = ah.write(bytes, { at: pos });
    if (n !== bytes.length) throw new Error('Could not write to browser storage (disk full?)');
    pos += n;
  };
  const written = [];

  // 1. The port release, copied through with its original compressed bytes.
  const portBytes = new Uint8Array(port.bytes);
  const portRead = async (o, n) => portBytes.subarray(o, o + n);
  for (const e of port.entries) {
    progress(e.name, true);
    const dataAt = await entryDataOffset(portRead, e);
    const entry = { name: e.name, method: e.method, crc: e.crc, compSize: e.compSize, size: e.size, time: e.time, date: e.date, offset: pos };
    write(localHeader(entry));
    write(portBytes.subarray(dataAt, dataAt + e.compSize));
    written.push(entry);
    done += e.compSize;
  }

  // 2. The game files, stored, each hashed while it is copied.
  for (const f of plan) {
    const name = installPrefix + f.path;
    progress(f.path, true);
    const entry = { name, method: 0, crc: 0, compSize: f.size, size: f.size, offset: pos };
    write(localHeader(entry));
    const sha = new Sha256();
    let crc = 0;
    let got = 0;
    const source = f.cached ? xbe.bytes : null;
    for await (const chunk of slices(f, source)) {
      sha.update(chunk);
      crc = crc32(chunk, crc);
      write(chunk);
      got += chunk.length;
      done += chunk.length;
      progress(f.path);
    }
    if (got !== f.size) throw new Error(`${f.path}: read ${got} bytes, expected ${f.size}`);
    const digest = sha.hex();
    if (digest !== f.sha256) {
      throw new Error(`${f.path}: SHA-256 mismatch. Expected ${f.sha256}, got ${digest}. The file is damaged or from a different version of the game.`);
    }
    entry.crc = crc;
    const crcBytes = new Uint8Array(4);
    new DataView(crcBytes.buffer).setUint32(0, crc, true);
    if (ah.write(crcBytes, { at: entry.offset + LOCAL_CRC_OFFSET }) !== 4) throw new Error('Could not write to browser storage');
    written.push(entry);
  }

  // 3. Central directory and end records (ZIP64 when needed).
  progress('Central directory', true);
  const cdOffset = pos;
  for (const e of written) write(centralHeader(e));
  write(endRecords({ count: written.length, cdOffset, cdSize: pos - cdOffset }));
  ah.truncate(pos);
  ah.flush();

  // 4. Read the staged archive back and check its structure.
  progress('Verifying', true);
  const read = async (o, n) => {
    const b = new Uint8Array(n);
    if (ah.read(b, { at: o }) !== n) throw new Error('Verification: short read');
    return b;
  };
  const back = await readCentralDirectory(read, ah.getSize());
  if (back.length !== written.length) throw new Error('Verification: entry count differs');
  for (let i = 0; i < back.length; i++) {
    const a = back[i], b = written[i];
    if (a.name !== b.name || a.crc !== b.crc >>> 0 || a.size !== b.size || a.compSize !== b.compSize || a.localOffset !== b.offset) {
      throw new Error(`Verification: central directory differs for ${b.name}`);
    }
    const dataAt = await entryDataOffset(read, a);
    const lh = await read(a.localOffset, 30);
    if (new DataView(lh.buffer).getUint32(LOCAL_CRC_OFFSET, true) !== a.crc) throw new Error(`Verification: local CRC differs for ${b.name}`);
    if (dataAt + a.compSize > cdOffset) throw new Error(`Verification: ${b.name} overlaps the central directory`);
  }
  const bytes = ah.getSize();
  ah.close();
  setHandle(null);
  await fh.move(outName);
  return { bytes, entries: written.length, name: outName };
}

// Yields the file's bytes in 512 KiB slices, reading the next slice while the
// current one is hashed.
async function* slices(f, cached) {
  const read = (p) => {
    const end = Math.min(p + SLICE, f.size);
    if (cached) return Promise.resolve(cached.subarray(p, end));
    return f.file.slice(f.offset + p, f.offset + end).arrayBuffer().then((b) => {
      if (b.byteLength !== end - p) throw new Error(`${f.path}: short read (file changed or image truncated?)`);
      return new Uint8Array(b);
    });
  };
  let p = 0;
  let next = f.size > 0 ? read(0) : null;
  while (p < f.size) {
    const cur = await next;
    p += cur.length;
    next = p < f.size ? read(p) : null;
    yield cur;
  }
}
