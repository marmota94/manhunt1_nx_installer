// SPDX-License-Identifier: LGPL-2.1-only
// Minimal ZIP reader and writer with ZIP64 support. The writer only builds
// headers; callers place them and the entry data in the output.

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_LOCATOR64 = 0x07064b50;
const MAX32 = 0xffffffff;
const MAX16 = 0xffff;

// 2026-01-01 00:00:00, the timestamp the port release uses.
export const DOS_TIME = 0;
export const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;

const enc = new TextEncoder();
const dec = new TextDecoder();

function u64(dv, at) {
  const lo = dv.getUint32(at, true);
  const hi = dv.getUint32(at + 4, true);
  if (hi >= 0x200000) throw new Error('ZIP: 64-bit value too large');
  return hi * 0x100000000 + lo;
}
function setU64(dv, at, v) {
  dv.setUint32(at, v >>> 0, true);
  dv.setUint32(at + 4, Math.floor(v / 0x100000000), true);
}

// ---------- reader ----------

// read(offset, length) resolves to a Uint8Array. Returns the entries in
// central directory order.
export async function readCentralDirectory(read, size) {
  const tailLen = Math.min(size, 22 + 0xffff);
  const tail = await read(size - tailLen, tailLen);
  const tdv = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  let e = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tdv.getUint32(i, true) === SIG_EOCD && i + 22 + tdv.getUint16(i + 20, true) === tail.length) { e = i; break; }
  }
  if (e < 0) throw new Error('ZIP: end of central directory not found');
  const eocdAt = size - tailLen + e;
  let count = tdv.getUint16(e + 10, true);
  let cdSize = tdv.getUint32(e + 12, true);
  let cdOffset = tdv.getUint32(e + 16, true);
  if (tdv.getUint16(e + 4, true) !== 0 || tdv.getUint16(e + 6, true) !== 0) throw new Error('ZIP: multi-disk archives are not supported');
  if (count === MAX16 || cdSize === MAX32 || cdOffset === MAX32) {
    if (eocdAt < 20) throw new Error('ZIP: ZIP64 locator missing');
    const loc = await read(eocdAt - 20, 20);
    const ldv = new DataView(loc.buffer, loc.byteOffset, 20);
    if (ldv.getUint32(0, true) !== SIG_LOCATOR64) throw new Error('ZIP: ZIP64 locator missing');
    const z64At = u64(ldv, 8);
    const z = await read(z64At, 56);
    const zdv = new DataView(z.buffer, z.byteOffset, 56);
    if (zdv.getUint32(0, true) !== SIG_EOCD64) throw new Error('ZIP: bad ZIP64 end record');
    count = u64(zdv, 32);
    cdSize = u64(zdv, 40);
    cdOffset = u64(zdv, 48);
  }
  if (cdOffset + cdSize > size) throw new Error('ZIP: central directory out of range');
  const cd = await read(cdOffset, cdSize);
  const dv = new DataView(cd.buffer, cd.byteOffset, cd.byteLength);
  const entries = [];
  let p = 0;
  for (let n = 0; n < count; n++) {
    if (p + 46 > cd.length || dv.getUint32(p, true) !== SIG_CENTRAL) throw new Error('ZIP: bad central directory entry');
    const madeBy = dv.getUint16(p + 4, true);
    const flags = dv.getUint16(p + 8, true);
    const method = dv.getUint16(p + 10, true);
    const time = dv.getUint16(p + 12, true);
    const date = dv.getUint16(p + 14, true);
    const crc = dv.getUint32(p + 16, true);
    let compSize = dv.getUint32(p + 20, true);
    let size_ = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const externalAttrs = dv.getUint32(p + 38, true);
    let localOffset = dv.getUint32(p + 42, true);
    const name = dec.decode(cd.subarray(p + 46, p + 46 + nameLen));
    let x = p + 46 + nameLen;
    const xEnd = x + extraLen;
    while (x + 4 <= xEnd) {
      const id = dv.getUint16(x, true);
      const len = dv.getUint16(x + 2, true);
      if (id === 0x0001) {
        let q = x + 4;
        if (size_ === MAX32) { size_ = u64(dv, q); q += 8; }
        if (compSize === MAX32) { compSize = u64(dv, q); q += 8; }
        if (localOffset === MAX32) { localOffset = u64(dv, q); q += 8; }
      }
      x += 4 + len;
    }
    entries.push({ name, madeBy, flags, method, time, date, crc, compSize, size: size_, externalAttrs, localOffset });
    p = xEnd + commentLen;
  }
  return entries;
}

// Offset of the entry's data, after checking its local header.
export async function entryDataOffset(read, entry) {
  const h = await read(entry.localOffset, 30);
  const dv = new DataView(h.buffer, h.byteOffset, 30);
  if (dv.getUint32(0, true) !== SIG_LOCAL) throw new Error(`ZIP: bad local header for ${entry.name}`);
  const nameLen = dv.getUint16(26, true);
  const extraLen = dv.getUint16(28, true);
  const n = await read(entry.localOffset + 30, nameLen);
  if (dec.decode(n) !== entry.name) throw new Error(`ZIP: local and central names differ for ${entry.name}`);
  return entry.localOffset + 30 + nameLen + extraLen;
}

// ---------- writer ----------

function nameBytes(name) {
  const b = enc.encode(name);
  if (b.length > MAX16) throw new Error('ZIP: name too long');
  return b;
}
function utf8Flag(name) {
  return /^[\x20-\x7e]*$/.test(name) ? 0 : 0x0800;
}

// e: { name, method, crc, compSize, size, time?, date? }
export function localHeader(e) {
  const nb = nameBytes(e.name);
  const z64 = e.size >= MAX32 || e.compSize >= MAX32;
  const extraLen = z64 ? 20 : 0;
  const out = new Uint8Array(30 + nb.length + extraLen);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, SIG_LOCAL, true);
  dv.setUint16(4, z64 ? 45 : 20, true);
  dv.setUint16(6, utf8Flag(e.name), true);
  dv.setUint16(8, e.method, true);
  dv.setUint16(10, e.time ?? DOS_TIME, true);
  dv.setUint16(12, e.date ?? DOS_DATE, true);
  dv.setUint32(14, e.crc >>> 0, true);
  dv.setUint32(18, z64 ? MAX32 : e.compSize, true);
  dv.setUint32(22, z64 ? MAX32 : e.size, true);
  dv.setUint16(26, nb.length, true);
  dv.setUint16(28, extraLen, true);
  out.set(nb, 30);
  if (z64) {
    const x = 30 + nb.length;
    dv.setUint16(x, 0x0001, true);
    dv.setUint16(x + 2, 16, true);
    setU64(dv, x + 4, e.size);
    setU64(dv, x + 12, e.compSize);
  }
  return out;
}

// Byte offset of the CRC field inside a local header, for patching it later.
export const LOCAL_CRC_OFFSET = 14;

// e: as localHeader plus { offset } (of the local header).
export function centralHeader(e) {
  const nb = nameBytes(e.name);
  const bigSize = e.size >= MAX32;
  const bigComp = e.compSize >= MAX32 || bigSize; // mirror the local header
  const bigOff = e.offset >= MAX32;
  const extraData = (bigSize ? 8 : 0) + (bigComp ? 8 : 0) + (bigOff ? 8 : 0);
  const extraLen = extraData ? 4 + extraData : 0;
  const z64 = extraLen > 0;
  const out = new Uint8Array(46 + nb.length + extraLen);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, SIG_CENTRAL, true);
  dv.setUint16(4, (3 << 8) | (z64 ? 45 : 20), true); // made by: Unix
  dv.setUint16(6, z64 ? 45 : 20, true);
  dv.setUint16(8, utf8Flag(e.name), true);
  dv.setUint16(10, e.method, true);
  dv.setUint16(12, e.time ?? DOS_TIME, true);
  dv.setUint16(14, e.date ?? DOS_DATE, true);
  dv.setUint32(16, e.crc >>> 0, true);
  dv.setUint32(20, bigComp ? MAX32 : e.compSize, true);
  dv.setUint32(24, bigSize ? MAX32 : e.size, true);
  dv.setUint16(28, nb.length, true);
  dv.setUint16(30, extraLen, true);
  dv.setUint32(38, (0o100644 << 16) >>> 0, true); // regular file, rw-r--r--
  dv.setUint32(42, bigOff ? MAX32 : e.offset, true);
  out.set(nb, 46);
  if (z64) {
    let x = 46 + nb.length;
    dv.setUint16(x, 0x0001, true);
    dv.setUint16(x + 2, extraData, true);
    x += 4;
    if (bigSize) { setU64(dv, x, e.size); x += 8; }
    if (bigComp) { setU64(dv, x, e.compSize); x += 8; }
    if (bigOff) { setU64(dv, x, e.offset); x += 8; }
  }
  return out;
}

// End records for a central directory of `count` entries at cdOffset.
export function endRecords({ count, cdOffset, cdSize }) {
  const z64 = count >= MAX16 || cdOffset >= MAX32 || cdSize >= MAX32;
  const out = new Uint8Array((z64 ? 56 + 20 : 0) + 22);
  const dv = new DataView(out.buffer);
  let p = 0;
  if (z64) {
    const z64At = cdOffset + cdSize;
    dv.setUint32(0, SIG_EOCD64, true);
    setU64(dv, 4, 44);
    dv.setUint16(12, (3 << 8) | 45, true);
    dv.setUint16(14, 45, true);
    setU64(dv, 24, count);
    setU64(dv, 32, count);
    setU64(dv, 40, cdSize);
    setU64(dv, 48, cdOffset);
    dv.setUint32(56, SIG_LOCATOR64, true);
    setU64(dv, 64, z64At);
    dv.setUint32(72, 1, true);
    p = 76;
  }
  dv.setUint32(p, SIG_EOCD, true);
  dv.setUint16(p + 8, count >= MAX16 ? MAX16 : count, true);
  dv.setUint16(p + 10, count >= MAX16 ? MAX16 : count, true);
  dv.setUint32(p + 12, cdSize >= MAX32 ? MAX32 : cdSize, true);
  dv.setUint32(p + 16, cdOffset >= MAX32 ? MAX32 : cdOffset, true);
  return out;
}
