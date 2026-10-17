// Write a 720 KB double-sided Atari ST floppy image (.ST) holding a file
// tree. The geometry and BPB match what TOS formats (80 tracks, 9 sectors,
// 2 sides, 2 sectors per cluster, 5 sectors per FAT, 112 root entries), and
// the boot sector is deliberately not executable.

const SECTOR = 512;
const GEOMETRY = {
  sectors: 1440, spt: 9, heads: 2, spc: 2, reserved: 1, fats: 2, spf: 5, rootEntries: 112, media: 0xf9,
};

function writeLE16(buf, off, v) {
  buf[off] = v & 0xff;
  buf[off + 1] = (v >>> 8) & 0xff;
}

function writeLE32(buf, off, v) {
  writeLE16(buf, off, v & 0xffff);
  writeLE16(buf, off + 2, v >>> 16);
}

// 8.3 directory name, upper case, space padded. Throws on names GEMDOS
// cannot hold, so a bad input never yields a silently renamed file.
export function shortName(name) {
  const upper = name.toUpperCase();
  const m = /^([A-Z0-9_!#$%&'()\-@^{}~]{1,8})(?:\.([A-Z0-9_!#$%&'()\-@^{}~]{1,3}))?$/.exec(upper);
  if (!m) throw new Error(`"${name}" is not a valid 8.3 file name.`);
  return (m[1].padEnd(8, ' ') + (m[2] || '').padEnd(3, ' '));
}

// Build a tree { name, children: Map, data } from [{ path, data }].
function buildTree(files) {
  const root = { name: '', children: new Map() };
  for (const f of files) {
    const parts = f.path.split('/').filter(Boolean);
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const key = parts[i].toUpperCase();
      if (!node.children.has(key)) node.children.set(key, { name: parts[i], children: new Map() });
      node = node.children.get(key);
      if (!node.children) throw new Error(`${f.path}: a file is in the way of a folder.`);
    }
    const key = parts[parts.length - 1].toUpperCase();
    if (node.children.has(key)) throw new Error(`${f.path}: duplicate entry.`);
    node.children.set(key, { name: parts[parts.length - 1], data: f.data });
  }
  return root;
}

function sortedChildren(node) {
  return [...node.children.values()].sort((a, b) => (a.name.toUpperCase() < b.name.toUpperCase() ? -1 : 1));
}

// files: [{ path: 'GEMSYS/MFA2.SYS', data: Uint8Array }]
// stamp: { year, month, day, hour, minute } for every directory entry
// Returns { image, freeBytes }.
export function buildFloppy(files, { label = '', stamp, serial = 0x4d4147 } = {}) {
  const g = GEOMETRY;
  const image = new Uint8Array(g.sectors * SECTOR);
  const rootSectors = (g.rootEntries * 32) / SECTOR;
  const fatStart = g.reserved;
  const rootStart = fatStart + g.fats * g.spf;
  const dataStart = rootStart + rootSectors;
  const clusterBytes = g.spc * SECTOR;
  const clusters = Math.floor((g.sectors - dataStart) / g.spc);
  const fat = new Uint16Array(clusters + 2);
  fat[0] = 0xf00 | g.media;
  fat[1] = 0xfff;
  let nextCluster = 2;
  const date = ((stamp.year - 1980) << 9) | (stamp.month << 5) | stamp.day;
  const time = (stamp.hour << 11) | (stamp.minute << 5);

  function allocate(bytes) {
    const count = Math.max(1, Math.ceil(bytes / clusterBytes));
    if (nextCluster + count > clusters + 2) {
      throw new Error('The files do not fit on a 720 KB floppy.');
    }
    const first = nextCluster;
    for (let i = 0; i < count; i++) fat[first + i] = i === count - 1 ? 0xfff : first + i + 1;
    nextCluster += count;
    return { first, count };
  }

  function clusterOffset(c) {
    return (dataStart + (c - 2) * g.spc) * SECTOR;
  }

  function dirEntry(buf, off, name83, attr, cluster, size) {
    for (let i = 0; i < 11; i++) buf[off + i] = name83.charCodeAt(i);
    buf[off + 11] = attr;
    writeLE16(buf, off + 22, time);
    writeLE16(buf, off + 24, date);
    writeLE16(buf, off + 26, cluster);
    writeLE32(buf, off + 28, size);
  }

  // Lay out a directory's entries into `buf` and recurse into subfolders.
  function writeDir(node, buf, selfCluster, parentCluster, isRoot) {
    let slot = 0;
    const put = (name83, attr, cluster, size) => {
      if ((slot + 1) * 32 > buf.length) throw new Error('Too many entries in one folder.');
      dirEntry(buf, slot * 32, name83, attr, cluster, size);
      slot++;
    };
    if (isRoot && label) put(shortName(label).replace('.', ''), 0x08, 0, 0);
    if (!isRoot) {
      put('.          ', 0x10, selfCluster, 0);
      put('..         ', 0x10, parentCluster, 0);
    }
    for (const child of sortedChildren(node)) {
      if (child.children) {
        const entries = child.children.size + 2;
        const alloc = allocate(entries * 32);
        const sub = new Uint8Array(alloc.count * clusterBytes);
        put(shortName(child.name), 0x10, alloc.first, 0);
        writeDir(child, sub, alloc.first, isRoot ? 0 : selfCluster, false);
        for (let i = 0; i < alloc.count; i++) {
          image.set(sub.subarray(i * clusterBytes, (i + 1) * clusterBytes), clusterOffset(alloc.first + i));
        }
      } else {
        let first = 0;
        if (child.data.length > 0) {
          const alloc = allocate(child.data.length);
          first = alloc.first;
          for (let i = 0; i < alloc.count; i++) {
            image.set(child.data.subarray(i * clusterBytes, (i + 1) * clusterBytes), clusterOffset(first + i));
          }
        }
        put(shortName(child.name), 0x00, first, child.data.length);
      }
    }
  }

  const rootBuf = new Uint8Array(rootSectors * SECTOR);
  writeDir(buildTree(files), rootBuf, 0, 0, true);
  image.set(rootBuf, rootStart * SECTOR);

  // Boot sector: bra.s, loader name, serial, BPB.
  const boot = image.subarray(0, SECTOR);
  boot[0] = 0x60;
  boot[1] = 0x38;
  for (let i = 0; i < 6; i++) boot[2 + i] = 'MAGIC '.charCodeAt(i);
  boot[8] = serial & 0xff;
  boot[9] = (serial >>> 8) & 0xff;
  boot[10] = (serial >>> 16) & 0xff;
  writeLE16(boot, 11, SECTOR);
  boot[13] = g.spc;
  writeLE16(boot, 14, g.reserved);
  boot[16] = g.fats;
  writeLE16(boot, 17, g.rootEntries);
  writeLE16(boot, 19, g.sectors);
  boot[21] = g.media;
  writeLE16(boot, 22, g.spf);
  writeLE16(boot, 24, g.spt);
  writeLE16(boot, 26, g.heads);
  writeLE16(boot, 28, 0);
  // A boot sector whose big-endian word sum is $1234 is executed by TOS.
  let sum = 0;
  for (let i = 0; i < SECTOR; i += 2) sum = (sum + ((boot[i] << 8) | boot[i + 1])) & 0xffff;
  if (sum === 0x1234) {
    boot[SECTOR - 1] ^= 0x01;
    sum = (sum + (boot[SECTOR - 1] & 1 ? 1 : -1)) & 0xffff;
  }

  // FAT12: two entries per three bytes, both copies identical.
  const fatBytes = new Uint8Array(g.spf * SECTOR);
  for (let c = 0; c < fat.length; c += 2) {
    const a = fat[c];
    const b = c + 1 < fat.length ? fat[c + 1] : 0;
    const o = (c * 3) / 2;
    fatBytes[o] = a & 0xff;
    fatBytes[o + 1] = ((a >>> 8) & 0x0f) | ((b & 0x0f) << 4);
    fatBytes[o + 2] = (b >>> 4) & 0xff;
  }
  for (let i = 0; i < g.fats; i++) image.set(fatBytes, (fatStart + i * g.spf) * SECTOR);

  return {
    image,
    freeBytes: (clusters + 2 - nextCluster) * clusterBytes,
    layout: { ...g, sectorBytes: SECTOR, clusters, dataStart, bootChecksum: sum },
  };
}
