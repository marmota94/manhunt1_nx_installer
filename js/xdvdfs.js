// SPDX-License-Identifier: LGPL-2.1-only
// Reader for the Xbox DVD file system (XDVDFS).
//
// An xiso holds only the game partition, so the volume descriptor is at
// byte 0x10000. A full XGD1 (Redump) image starts with the video partition and
// the game partition begins at byte 0x18300000.

export const SECTOR = 2048;
export const LAYOUTS = [
  { name: 'xiso', offset: 0 },
  { name: 'XGD1 (Redump)', offset: 0x18300000 },
];
const MAGIC = 'MICROSOFT*XBOX*MEDIA';
const ATTR_DIRECTORY = 0x10;
const MAX_ENTRIES = 100000;
const MAX_DEPTH = 32;

function hasMagic(b, at) {
  for (let i = 0; i < MAGIC.length; i++) if (b[at + i] !== MAGIC.charCodeAt(i)) return false;
  return true;
}

// read(offset, length) must resolve to a Uint8Array of exactly that length.
// Returns { layout, partitionOffset, files: [{ path, offset, size }] } with
// '/'-separated paths in the image's own spelling and absolute byte offsets.
export async function readXdvdfs(read, imageSize) {
  for (const layout of LAYOUTS) {
    const vdAt = layout.offset + 32 * SECTOR;
    if (vdAt + SECTOR > imageSize) continue;
    const vd = await read(vdAt, SECTOR);
    if (!hasMagic(vd, 0) || !hasMagic(vd, 0x7ec)) continue;
    const dv = new DataView(vd.buffer, vd.byteOffset, vd.byteLength);
    const rootSector = dv.getUint32(0x14, true);
    const rootSize = dv.getUint32(0x18, true);
    const files = await walk(read, imageSize, layout.offset, rootSector, rootSize);
    return { layout: layout.name, partitionOffset: layout.offset, files };
  }
  throw new Error('Not an Xbox disc image: no XDVDFS volume found (tried xiso and full XGD1 layouts).');
}

async function walk(read, imageSize, base, rootSector, rootSize) {
  const files = [];
  const seenTables = new Set();
  let count = 0;
  const stack = [{ sector: rootSector, size: rootSize, prefix: '', depth: 0 }];
  while (stack.length) {
    const dir = stack.pop();
    if (dir.size === 0) continue;
    if (dir.depth > MAX_DEPTH) throw new Error('XDVDFS: directories nested too deeply.');
    const tableAt = base + dir.sector * SECTOR;
    if (seenTables.has(tableAt)) throw new Error('XDVDFS: directory loop.');
    seenTables.add(tableAt);
    if (tableAt + dir.size > imageSize) throw new Error('XDVDFS: directory table past end of image (truncated image?).');
    const t = await read(tableAt, dir.size);
    const dv = new DataView(t.buffer, t.byteOffset, t.byteLength);
    if (t.length < 14 || dv.getUint16(0, true) === 0xffff) continue; // empty directory
    const pending = [0];
    const visited = new Set();
    while (pending.length) {
      const at = pending.pop();
      if (visited.has(at)) throw new Error('XDVDFS: directory tree loop.');
      visited.add(at);
      if (++count > MAX_ENTRIES) throw new Error('XDVDFS: too many entries.');
      if (at + 14 > t.length) throw new Error('XDVDFS: directory entry out of range.');
      const left = dv.getUint16(at, true);
      const right = dv.getUint16(at + 2, true);
      const sector = dv.getUint32(at + 4, true);
      const size = dv.getUint32(at + 8, true);
      const attrs = t[at + 12];
      const nameLen = t[at + 13];
      if (nameLen === 0 || at + 14 + nameLen > t.length) throw new Error('XDVDFS: bad entry name.');
      let name = '';
      for (let i = 0; i < nameLen; i++) name += String.fromCharCode(t[at + 14 + i]);
      if (name === '.' || name === '..' || /[\/\\\0]/.test(name)) throw new Error(`XDVDFS: invalid name "${name}".`);
      const path = dir.prefix + name;
      if (attrs & ATTR_DIRECTORY) {
        stack.push({ sector, size, prefix: path + '/', depth: dir.depth + 1 });
      } else {
        const offset = base + sector * SECTOR;
        if (offset + size > imageSize) throw new Error(`XDVDFS: ${path} runs past the end of the image (truncated image?).`);
        files.push({ path, offset, size });
      }
      if (left && left !== 0xffff) pending.push(left * 4);
      if (right && right !== 0xffff) pending.push(right * 4);
    }
  }
  return files;
}
