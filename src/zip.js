// Minimal ZIP support: read stored/deflated archives (the MagiC release),
// write stored archives (the hard disk file set). Inflate uses the
// platform's DecompressionStream, available in browsers and Node 18+.

let CRC_TABLE = null;

export function crc32(data) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function readLE16(buf, off) {
  return buf[off] | (buf[off + 1] << 8);
}

function readLE32(buf, off) {
  return (buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16) | (buf[off + 3] << 24)) >>> 0;
}

async function inflateRaw(data) {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// Returns a Map of path -> Uint8Array for every file in the archive.
// Directory entries are skipped; paths use forward slashes.
export async function readZip(bytes) {
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (readLE32(bytes, i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Not a ZIP archive (no end-of-central-directory record).');
  const count = readLE16(bytes, eocd + 10);
  let p = readLE32(bytes, eocd + 16);
  const files = new Map();
  for (let n = 0; n < count; n++) {
    if (readLE32(bytes, p) !== 0x02014b50) throw new Error('Corrupt ZIP central directory.');
    const method = readLE16(bytes, p + 10);
    const crc = readLE32(bytes, p + 16);
    const compSize = readLE32(bytes, p + 20);
    const size = readLE32(bytes, p + 24);
    const nameLen = readLE16(bytes, p + 28);
    const extraLen = readLE16(bytes, p + 30);
    const commentLen = readLE16(bytes, p + 32);
    const local = readLE32(bytes, p + 42);
    const name = new TextDecoder('latin1').decode(bytes.subarray(p + 46, p + 46 + nameLen)).replace(/\\/g, '/');
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    if (readLE32(bytes, local) !== 0x04034b50) throw new Error(`Corrupt ZIP entry ${name}.`);
    const start = local + 30 + readLE16(bytes, local + 26) + readLE16(bytes, local + 28);
    const raw = bytes.subarray(start, start + compSize);
    let data;
    if (method === 0) data = raw.slice();
    else if (method === 8) data = await inflateRaw(raw);
    else throw new Error(`ZIP entry ${name} uses unsupported compression method ${method}.`);
    if (data.length !== size || crc32(data) !== crc) throw new Error(`ZIP entry ${name} failed its CRC check.`);
    files.set(name, data);
  }
  return files;
}

// MS-DOS date/time fields for a { year, month, day, hour, minute } stamp.
export function dosDateTime(stamp) {
  const date = ((stamp.year - 1980) << 9) | (stamp.month << 5) | stamp.day;
  const time = (stamp.hour << 11) | (stamp.minute << 5);
  return { date, time };
}

// files: array of { path, data }; every entry gets the same timestamp so
// the archive is reproducible. Stored (uncompressed): the payload is small.
export function writeZip(files, stamp) {
  const { date, time } = dosDateTime(stamp);
  const enc = new TextEncoder();
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.path);
    const crc = crc32(f.data);
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(10, time, true);
    lv.setUint16(12, date, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, f.data.length, true);
    lv.setUint32(22, f.data.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(12, time, true);
    cv.setUint16(14, date, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, f.data.length, true);
    cv.setUint32(24, f.data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);
    locals.push(local, f.data);
    centrals.push(central);
    offset += local.length + f.data.length;
  }
  const centralSize = centrals.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  const out = new Uint8Array(offset + centralSize + 22);
  let p = 0;
  for (const part of [...locals, ...centrals, end]) {
    out.set(part, p);
    p += part.length;
  }
  return out;
}
