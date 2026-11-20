// SPDX-License-Identifier: LGPL-2.1-only
// ZIP CRC-32 (reflected polynomial 0xEDB88320), slicing-by-8.

const T = new Int32Array(256 * 8);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  T[n] = c;
}
for (let n = 0; n < 256; n++) {
  for (let s = 1; s < 8; s++) T[s * 256 + n] = T[(s - 1) * 256 + n] >>> 8 ^ T[T[(s - 1) * 256 + n] & 0xff];
}

// Continues a CRC: pass the previous return value (0 to start).
export function crc32(data, crc = 0) {
  let c = ~crc;
  let i = 0;
  const n = data.length;
  const end8 = n - (n % 8);
  while (i < end8) {
    const a = c ^ (data[i] | data[i + 1] << 8 | data[i + 2] << 16 | data[i + 3] << 24);
    c = T[1792 + (a & 0xff)] ^ T[1536 + (a >>> 8 & 0xff)] ^ T[1280 + (a >>> 16 & 0xff)] ^ T[1024 + (a >>> 24)]
      ^ T[768 + data[i + 4]] ^ T[512 + data[i + 5]] ^ T[256 + data[i + 6]] ^ T[data[i + 7]];
    i += 8;
  }
  while (i < n) c = T[(c ^ data[i++]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}
