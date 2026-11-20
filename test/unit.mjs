// SPDX-License-Identifier: LGPL-2.1-only
// node --test test/unit.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { inflateRawSync, crc32 as zlibCrc32 } from 'node:zlib';

import { Sha256, sha256Hex } from '../js/sha256.js';
import { crc32 } from '../js/crc32.js';
import { readXdvdfs, SECTOR } from '../js/xdvdfs.js';
import { localHeader, centralHeader, endRecords, readCentralDirectory, entryDataOffset } from '../js/zip.js';
import { parseAssetManifest, preflight, folderSources, checkManifest, safeRelativePath } from '../js/release.js';

const ascii = (s) => new TextEncoder().encode(s);

// ---------- SHA-256 ----------

test('SHA-256 FIPS 180-4 vectors', () => {
  assert.equal(sha256Hex(ascii('')), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(sha256Hex(ascii('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(sha256Hex(ascii('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')),
    '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
  assert.equal(sha256Hex(ascii('abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu')),
    'cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1');
});

test('SHA-256 one million "a" fed in uneven chunks', () => {
  const h = new Sha256();
  const a = new Uint8Array(1000).fill(0x61);
  let left = 1_000_000;
  for (let n = 1; left > 0; n = (n * 7 + 3) % 1000 || 1) {
    const take = Math.min(n, left);
    h.update(a.subarray(0, take));
    left -= take;
  }
  assert.equal(h.hex(), 'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0');
});

test('SHA-256 matches node:crypto around block boundaries', () => {
  for (let len = 0; len <= 260; len++) {
    const data = randomBytes(len);
    const want = createHash('sha256').update(data).digest('hex');
    assert.equal(sha256Hex(data), want, `one-shot, length ${len}`);
    const split = len >> 1;
    assert.equal(new Sha256().update(data.subarray(0, split)).update(data.subarray(split)).hex(), want, `split, length ${len}`);
  }
  const big = randomBytes(3 * 512 * 1024 + 17);
  const h = new Sha256();
  for (let p = 0; p < big.length; p += 512 * 1024) h.update(big.subarray(p, p + 512 * 1024));
  assert.equal(h.hex(), createHash('sha256').update(big).digest('hex'));
});

// ---------- CRC-32 ----------

test('CRC-32 check value and incremental use', () => {
  assert.equal(crc32(ascii('123456789')), 0xcbf43926);
  assert.equal(crc32(new Uint8Array(0)), 0);
  for (const len of [1, 7, 8, 9, 63, 64, 1000, 65537]) {
    const d = randomBytes(len);
    assert.equal(crc32(d), zlibCrc32(d) >>> 0, `length ${len}`);
    const s = len >> 1;
    assert.equal(crc32(d.subarray(s), crc32(d.subarray(0, s))), zlibCrc32(d) >>> 0);
  }
});

// ---------- virtual sparse images ----------

// A sparse byte space: written segments over zeros. read() never allocates more
// than the requested length.
class Sparse {
  constructor(size) { this.size = size; this.segs = []; }
  write(offset, bytes) { this.segs.push({ offset, bytes }); }
  read = async (offset, length) => {
    if (offset < 0 || offset + length > this.size) throw new Error(`read past end: ${offset}+${length}`);
    const out = new Uint8Array(length);
    for (const { offset: o, bytes } of this.segs) {
      const a = Math.max(o, offset), b = Math.min(o + bytes.length, offset + length);
      if (a < b) out.set(bytes.subarray(a - o, b - o), a - offset);
    }
    return out;
  };
}

// ---------- XDVDFS ----------

// Writes an XDVDFS tree into a Sparse at partition offset `base`. Directory
// entries form a balanced binary tree sorted by upper-case name, as on discs.
function buildXdvdfs(img, base, tree) {
  let nextSector = 33;
  const alloc = (bytes) => { const s = nextSector; nextSector += Math.max(1, Math.ceil(bytes / SECTOR)); return s; };

  function writeDir(node) {
    const names = Object.keys(node).sort((a, b) => (a.toUpperCase() < b.toUpperCase() ? -1 : 1));
    if (names.length === 0) return { sector: 0, size: 0 };
    const kids = names.map((name) => {
      const v = node[name];
      if (v instanceof Uint8Array) {
        const sector = v.length ? alloc(v.length) : 0;
        if (v.length) img.write(base + sector * SECTOR, v);
        return { name, sector, size: v.length, attrs: 0x20 };
      }
      const d = writeDir(v);
      return { name, sector: d.sector, size: d.size, attrs: 0x10 };
    });
    // Lay out entries in tree order: root first, then subtrees, padding with
    // 0xFF so no entry crosses a sector boundary.
    const order = [];
    const place = (lo, hi) => {
      if (lo > hi) return null;
      const mid = (lo + hi) >> 1;
      const rec = { k: kids[mid] };
      order.push(rec);
      rec.left = place(lo, mid - 1);
      rec.right = place(mid + 1, hi);
      return rec;
    };
    place(0, kids.length - 1);
    let p = 0;
    for (const r of order) {
      const len = (14 + r.k.name.length + 3) & ~3;
      if ((p % SECTOR) + len > SECTOR) p += SECTOR - (p % SECTOR);
      r.at = p;
      p += len;
    }
    const size = p;
    const table = new Uint8Array(Math.ceil(size / SECTOR) * SECTOR).fill(0xff);
    const dv = new DataView(table.buffer);
    for (const r of order) {
      dv.setUint16(r.at, r.left ? r.left.at / 4 : 0, true);
      dv.setUint16(r.at + 2, r.right ? r.right.at / 4 : 0, true);
      dv.setUint32(r.at + 4, r.k.sector, true);
      dv.setUint32(r.at + 8, r.k.size, true);
      table[r.at + 12] = r.k.attrs;
      table[r.at + 13] = r.k.name.length;
      table.set(ascii(r.k.name), r.at + 14);
    }
    const sector = alloc(table.length);
    img.write(base + sector * SECTOR, table);
    return { sector, size };
  }

  const root = writeDir(tree);
  const vd = new Uint8Array(SECTOR);
  vd.set(ascii('MICROSOFT*XBOX*MEDIA'), 0);
  vd.set(ascii('MICROSOFT*XBOX*MEDIA'), 0x7ec);
  new DataView(vd.buffer).setUint32(0x14, root.sector, true);
  new DataView(vd.buffer).setUint32(0x18, root.size, true);
  img.write(base + 32 * SECTOR, vd);
  return base + nextSector * SECTOR;
}

function sampleTree() {
  const levels = {};
  for (let i = 0; i < 40; i++) levels[`level${String(i).padStart(2, '0')}`] = { 'scene1.bsp': ascii(`scene ${i}`), 'Pak': { 'X.TXD': ascii(`txd ${i}`) } };
  return {
    'default.xbe': randomBytes(5000),
    audio: { xbox: { SFX: { 'sfx.RAW': randomBytes(SECTOR * 3 + 1) } } },
    levels,
    empty: {},
    'zero.bin': new Uint8Array(0),
  };
}

function flatten(tree, prefix = '') {
  const out = {};
  for (const [k, v] of Object.entries(tree)) {
    if (v instanceof Uint8Array) out[prefix + k] = v;
    else Object.assign(out, flatten(v, prefix + k + '/'));
  }
  return out;
}

for (const [layout, base] of [['xiso', 0], ['XGD1 (Redump)', 0x18300000]]) {
  test(`XDVDFS ${layout} layout`, async () => {
    const tree = sampleTree();
    const img = new Sparse(0);
    img.size = buildXdvdfs(img, base, tree) + SECTOR;
    if (base) img.size = Math.max(img.size, 7_825_162_240); // full XGD1 image size
    const res = await readXdvdfs(img.read, img.size);
    assert.equal(res.layout, layout);
    assert.equal(res.partitionOffset, base);
    const want = flatten(tree);
    assert.equal(res.files.length, Object.keys(want).length);
    for (const f of res.files) {
      assert.ok(want[f.path], `unexpected ${f.path}`);
      assert.equal(f.size, want[f.path].length);
      assert.deepEqual(await img.read(f.offset, f.size), new Uint8Array(want[f.path]));
    }
  });
}

test('XDVDFS rejects non-images, truncated images and loops', async () => {
  const blank = new Sparse(1 << 20);
  await assert.rejects(readXdvdfs(blank.read, blank.size), /Not an Xbox disc image/);

  const img = new Sparse(0);
  const end = buildXdvdfs(img, 0, { 'default.xbe': randomBytes(10000) });
  img.size = end - 4096;
  await assert.rejects(readXdvdfs(img.read, img.size), /past the end|past end/);

  const loop = new Sparse(0);
  loop.size = buildXdvdfs(loop, 0, { a: { b: ascii('x') } });
  const res = await readXdvdfs(loop.read, loop.size);
  // Point the subdirectory back at the root table.
  const vd = await loop.read(32 * SECTOR, SECTOR);
  const rootSector = new DataView(vd.buffer).getUint32(0x14, true);
  const rootTable = await loop.read(rootSector * SECTOR, SECTOR);
  new DataView(rootTable.buffer).setUint32(4, rootSector, true);
  loop.write(rootSector * SECTOR, rootTable);
  assert.equal(res.files.length, 1);
  await assert.rejects(readXdvdfs(loop.read, loop.size), /loop/);
});

// ---------- ZIP ----------

// Assembles an archive in a Sparse the way the worker does.
function writeZip(img, files) {
  let pos = 0;
  const written = [];
  for (const f of files) {
    const e = { name: f.name, method: 0, crc: f.crc, compSize: f.size, size: f.size, offset: pos };
    const lh = localHeader(e);
    img.write(pos, lh);
    pos += lh.length;
    if (f.data) img.write(pos, f.data);
    pos += f.size;
    written.push(e);
  }
  const cdOffset = pos;
  for (const e of written) { const c = centralHeader(e); img.write(pos, c); pos += c.length; }
  const end = endRecords({ count: written.length, cdOffset, cdSize: pos - cdOffset });
  img.write(pos, end);
  img.size = pos + end.length;
  return { written, cdOffset };
}

test('ZIP round trip without ZIP64', async () => {
  const img = new Sparse(0);
  const a = ascii('hello');
  writeZip(img, [{ name: 'switch/a.txt', size: a.length, crc: crc32(a), data: a }]);
  const all = await img.read(0, img.size);
  const entries = await readCentralDirectory(img.read, img.size);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].crc, zlibCrc32(a) >>> 0);
  const at = await entryDataOffset(img.read, entries[0]);
  assert.equal(new TextDecoder().decode(all.subarray(at, at + 5)), 'hello');
  // No ZIP64 records: the file ends with a plain 22-byte EOCD after the CD.
  assert.equal(new DataView(all.buffer).getUint32(all.length - 22, true), 0x06054b50);
  assert.equal(all.length, 30 + 12 + 5 + 46 + 12 + 22);
});

test('ZIP64 with a virtual sparse 5 GiB entry', async () => {
  const FIVE_GIB = 5 * 1024 ** 3;
  const img = new Sparse(0);
  const small = ascii('before');
  const after = ascii('after');
  const { written, cdOffset } = writeZip(img, [
    { name: 'switch/manhunt1_nx/game/a.bin', size: small.length, crc: crc32(small), data: small },
    { name: 'switch/manhunt1_nx/game/huge.bin', size: FIVE_GIB, crc: 0x12345678 }, // data never allocated
    { name: 'switch/manhunt1_nx/game/z.bin', size: after.length, crc: crc32(after), data: after },
  ]);
  assert.ok(cdOffset > 0xffffffff);

  // Local header of the huge entry carries the ZIP64 extra field.
  const lh = await img.read(written[1].offset, 30 + written[1].name.length + 20);
  const ldv = new DataView(lh.buffer);
  assert.equal(ldv.getUint16(4, true), 45);
  assert.equal(ldv.getUint32(18, true), 0xffffffff);
  assert.equal(ldv.getUint32(22, true), 0xffffffff);
  assert.equal(ldv.getUint16(30 + written[1].name.length, true), 0x0001);

  // The end of the file has a ZIP64 end record, its locator and an EOCD with
  // the offset field saturated.
  const tail = await img.read(img.size - 98, 98);
  const tdv = new DataView(tail.buffer);
  assert.equal(tdv.getUint32(0, true), 0x06064b50);
  assert.equal(tdv.getUint32(56, true), 0x07064b50);
  assert.equal(tdv.getUint32(76, true), 0x06054b50);
  assert.equal(tdv.getUint32(76 + 16, true), 0xffffffff);

  const entries = await readCentralDirectory(img.read, img.size);
  assert.deepEqual(entries.map((e) => [e.name, e.size, e.compSize, e.localOffset, e.crc]),
    written.map((e) => [e.name, e.size, e.compSize, e.offset, e.crc >>> 0]));
  assert.ok(entries[2].localOffset > 0xffffffff);
  const at = await entryDataOffset(img.read, entries[2]);
  assert.equal(new TextDecoder().decode(await img.read(at, after.length)), 'after');
});

test('ZIP64 end records for 65535+ entries', () => {
  const end = endRecords({ count: 70000, cdOffset: 1000, cdSize: 500 });
  const dv = new DataView(end.buffer);
  assert.equal(end.length, 98);
  assert.equal(dv.getUint32(24, true), 70000);
  assert.equal(dv.getUint16(76 + 10, true), 0xffff);
});

// ---------- release metadata and preflight ----------

const ASSETS = [
  '# sha256  size  path',
  `${'a'.repeat(64)}  5  DEFAULT.xbe`,
  `${'b'.repeat(64)}  3  audio/xbox/SFX/sfx.RAW`,
  `${'c'.repeat(64)}  0  levels/Scrap2/Scene1.bsp`,
  '',
].join('\n');

test('asset manifest parsing', () => {
  const a = parseAssetManifest(ASSETS);
  assert.equal(a.length, 3);
  assert.deepEqual(a[1], { sha256: 'b'.repeat(64), size: 3, path: 'audio/xbox/SFX/sfx.RAW' });
  assert.throws(() => parseAssetManifest(`${'a'.repeat(64)}  1  ../x`), /unsafe/);
  assert.throws(() => parseAssetManifest(`${'a'.repeat(64)} 1 x`), /bad format/);
  assert.throws(() => parseAssetManifest(`${'a'.repeat(64)}  1  A\n${'a'.repeat(64)}  1  a`), /duplicate/);
  assert.ok(!safeRelativePath('a//b') && !safeRelativePath('/a') && safeRelativePath('a/b.c'));
});

test('preflight matches paths ignoring case and reports problems', () => {
  const assets = parseAssetManifest(ASSETS);
  const ok = preflight(assets, [
    { path: 'default.XBE', size: 5 },
    { path: 'AUDIO/xbox/sfx/SFX.raw', size: 3 },
    { path: 'levels/scrap2/scene1.BSP', size: 0 },
    { path: 'extra/ignored.txt', size: 9 },
  ]);
  assert.deepEqual(ok.missing, []);
  assert.deepEqual(ok.wrongSize, []);
  assert.deepEqual(ok.plan.map((p) => p.path), ['DEFAULT.xbe', 'audio/xbox/SFX/sfx.RAW', 'levels/Scrap2/Scene1.bsp']);
  assert.equal(ok.plan[1].sourcePath, 'AUDIO/xbox/sfx/SFX.raw');

  const bad = preflight(assets, [{ path: 'DEFAULT.xbe', size: 5 }, { path: 'audio/xbox/SFX/sfx.RAW', size: 4 }]);
  assert.deepEqual(bad.missing, ['levels/Scrap2/Scene1.bsp']);
  assert.deepEqual(bad.wrongSize, [{ path: 'audio/xbox/SFX/sfx.RAW', expected: 3, actual: 4 }]);
});

test('folder selection finds the game root', () => {
  const f = (rel, size = 1) => ({ webkitRelativePath: rel, name: rel.split('/').pop(), size });
  const s = folderSources([f('Games/Manhunt/DEFAULT.xbe'), f('Games/Manhunt/audio/a.rib'), f('Games/other.txt')]);
  assert.deepEqual(s.map((x) => x.path), ['DEFAULT.xbe', 'audio/a.rib']);
});

test('staged release: manifest and asset manifest', { skip: !existsSync(new URL('../release/manifest.json', import.meta.url)) }, async () => {
  const manifest = checkManifest(JSON.parse(readFileSync(new URL('../release/manifest.json', import.meta.url))));
  const zip = new Uint8Array(readFileSync(new URL(`../release/manhunt1-nx-v${manifest.version}.zip`, import.meta.url)));
  const read = async (o, n) => zip.subarray(o, o + n);
  const entries = await readCentralDirectory(read, zip.length);
  const am = entries.find((e) => e.name === 'switch/manhunt1_nx/' + manifest.game.asset_manifest);
  const at = await entryDataOffset(read, am);
  const text = inflateRawSync(zip.subarray(at, at + am.compSize)).toString('utf8');
  const assets = parseAssetManifest(text);
  assert.equal(assets.length, 836);
  assert.equal(assets.find((a) => a.path === 'DEFAULT.xbe').sha256, manifest.game.default_xbe_sha256);
  assert.equal(manifest.game.default_xbe_sha256, 'af69e803695e29c3f99b38d6a759fac4c9300c9a540a2c244e4e7a07fb96afde');
});
