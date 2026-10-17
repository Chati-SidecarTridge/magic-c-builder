// Unit tests: node --test tests/
// The release fixture is the bundled assets/Atari-MagiC-*.zip.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { readZip, writeZip, crc32 } from '../src/zip.js';
import { sha256Hex } from '../src/sha256.js';
import { createHash } from 'node:crypto';
import { buildFloppy, shortName } from '../src/fat12.js';
import { buildMagicRom, parseMagicRam } from '../src/magic-rom.js';
import { releaseTree, kernelFor, localisedTree, floppyFiles, retargetInf } from '../src/rootfs.js';
import { buildPackage } from '../src/package.js';

const ASSETS = new URL('../assets/', import.meta.url);
const RELEASE = readFileSync(new URL(readdirSync(ASSETS).find((f) => /^Atari-MagiC-.*\.zip$/.test(f)), ASSETS));
const STUB = new Uint8Array(readFileSync(new URL('../src/stubs/romboot.bin', import.meta.url)));
const STAMP = { year: 2026, month: 9, day: 13, hour: 12, minute: 0 };
const be32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const be16 = (b, o) => (b[o] << 8) | b[o + 1];
const le16 = (b, o) => b[o] | (b[o + 1] << 8);

const tree = releaseTree(await readZip(RELEASE));

test('zip: write then read gives the same files', async () => {
  const files = [{ path: 'A/B.TXT', data: new TextEncoder().encode('hello') }, { path: 'C.BIN', data: new Uint8Array(1000).fill(7) }];
  const back = await readZip(writeZip(files, STAMP));
  assert.deepEqual([...back.keys()], ['A/B.TXT', 'C.BIN']);
  assert.deepEqual(back.get('C.BIN'), files[1].data);
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
});

test('release: three kernels and the localisation rules', () => {
  for (const lang of ['EN', 'DE', 'FR']) {
    const k = parseMagicRam(kernelFor(tree, lang));
    assert.equal(k.entry, 0x30);
    const loc = localisedTree(tree, lang);
    assert.equal(loc.has('MAGIC.RAM'), false);
    assert.equal(loc.has('AUTO/MAGXBOOT.TOS'), false);
    assert.equal([...loc.keys()].some((p) => p.startsWith('LANG/')), false);
    assert.deepEqual(loc.get('GEMSYS/GEMDESK/MAGXDESK.RSC'), tree.get(`LANG/${lang}/GEMSYS/GEMDESK/MAGXDESK.RSC`));
    assert.deepEqual(loc.get('GEMSYS/GEMDESK/HELP/DIR.HLP'), tree.get('LANG/DE/GEMSYS/GEMDESK/HELP/DIR.HLP'));
  }
});

test('rom: kernel at $E00000, reset vector on the stub, patches applied', () => {
  const kernel = kernelFor(tree, 'EN');
  const k = parseMagicRam(kernel);
  for (const sysDrive of [0, 2]) {
    const { rom, info } = buildMagicRom(kernel, STUB, { sysDrive });
    assert.equal(rom.length, 256 * 1024);
    assert.equal(be16(rom, 0), 0x602e);
    assert.equal(be32(rom, 8), 0xe00000, 'os_beg, which Hatari checks');
    assert.equal(be32(rom, 4), info.stubAt);
    const stubOff = info.stubAt - 0xe00000;
    assert.deepEqual(rom.subarray(stubOff, stubOff + STUB.length - 8), STUB.subarray(0, STUB.length - 8));
    assert.equal(be32(rom, stubOff + STUB.length - 4), 0xe00000 + k.entry);
    // Every relocated long points into the ROM, everything else is the kernel as linked.
    const relocated = new Set();
    for (const r of k.relocs) {
      if (r !== 4) assert.equal(be32(rom, r), (be32(k.seg, r) + 0xe00000) >>> 0);
      for (let i = 0; i < 4; i++) relocated.add(r + i);
    }
    const gem = be32(k.seg, 0x14);
    const patched = new Set([4, 5, 6, 7, info.resvalidPatchAt - 0xe00000, gem + 0x78, gem + 0x79]);
    for (let i = 0; i < k.segLen; i++) {
      if (!relocated.has(i) && !patched.has(i)) assert.equal(rom[i], k.seg[i], `byte $${i.toString(16)}`);
    }
    assert.equal(rom[info.resvalidPatchAt - 0xe00000], 0x60, 'bne turned into bra');
    assert.equal(be16(rom, gem + 0x78), sysDrive);
    // The checksum the kernel recomputes after a crash.
    let sum = 0;
    for (let o = 0; o < k.segLen; o += 4) sum = (sum + be32(rom, o)) >>> 0;
    assert.equal(be32(rom, stubOff + STUB.length - 8), sum);
  }
});

test('rom: rejects what is not a MagiC kernel', () => {
  assert.throws(() => buildMagicRom(new Uint8Array(100), STUB), /\$601A/);
  const prg = new Uint8Array(0x1c + 0x40);
  prg[0] = 0x60;
  prg[1] = 0x1a;
  prg[5] = 0x40;
  assert.throws(() => buildMagicRom(prg, STUB), /OS header/);
});

test('floppy: TOS BPB, not executable, files readable back', () => {
  const files = floppyFiles(localisedTree(tree, 'EN'));
  const { image, freeBytes } = buildFloppy(files, { label: 'MAGIC', stamp: STAMP });
  assert.equal(image.length, 737280);
  assert.ok(freeBytes > 0);
  assert.equal(le16(image, 11), 512);
  assert.equal(image[13], 2);
  assert.equal(le16(image, 17), 112);
  assert.equal(le16(image, 19), 1440);
  assert.equal(le16(image, 22), 5);
  assert.equal(le16(image, 24), 9);
  let sum = 0;
  for (let i = 0; i < 512; i += 2) sum = (sum + be16(image, i)) & 0xffff;
  assert.notEqual(sum, 0x1234);

  // Read every file back through the FAT.
  const fat = image.subarray(512, 512 + 5 * 512);
  const next = (c) => {
    const o = Math.floor((c * 3) / 2);
    const v = fat[o] | (fat[o + 1] << 8);
    return c & 1 ? v >> 4 : v & 0xfff;
  };
  const cluster = (c) => image.subarray((18 + (c - 2) * 2) * 512, (18 + (c - 1) * 2) * 512);
  const readChain = (c, size) => {
    const parts = [];
    for (; c < 0xff8; c = next(c)) parts.push(cluster(c));
    const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let p = 0;
    for (const part of parts) {
      all.set(part, p);
      p += part.length;
    }
    return size === undefined ? all : all.subarray(0, size);
  };
  const lookup = (path) => {
    let dir = image.subarray(11 * 512, 18 * 512);
    const parts = path.split('/');
    for (let i = 0; i < parts.length; i++) {
      const want = shortName(parts[i]);
      let found = null;
      for (let o = 0; o < dir.length; o += 32) {
        if (dir[o] === 0) break;
        if (String.fromCharCode(...dir.subarray(o, o + 11)) === want) found = o;
      }
      assert.notEqual(found, null, `${path} on the floppy`);
      const c = le16(dir, found + 26);
      const size = (dir[found + 28] | (dir[found + 29] << 8) | (dir[found + 30] << 16) | (dir[found + 31] << 24)) >>> 0;
      if (i === parts.length - 1) return size ? readChain(c, size) : new Uint8Array(0);
      dir = readChain(c);
    }
  };
  for (const f of files) assert.deepEqual(lookup(f.path), f.data, f.path);
  assert.ok(new TextDecoder('latin1').decode(lookup('MAGX.INF')).includes('A:\\GEMSYS\\'));
});

test('floppy: overflow is an error, not a truncated disk', () => {
  assert.throws(() => buildFloppy([{ path: 'BIG.BIN', data: new Uint8Array(800 * 1024) }], { stamp: STAMP }), /do not fit/);
});

test('MAGX.INF retargeting keeps CR/LF and only touches C:\\ paths', () => {
  const inf = new TextEncoder().encode('#_ACC C:\\AUTO\\ACCS\\\r\n#_DIC 1 C 2 94\r\n');
  assert.equal(new TextDecoder().decode(retargetInf(inf, 'A')), '#_ACC A:\\AUTO\\ACCS\\\r\n#_DIC 1 C 2 94\r\n');
});

test('package: both targets, deterministic', async () => {
  const a = await buildPackage(RELEASE, { lang: 'EN', target: 'floppy', stub: STUB });
  const b = await buildPackage(RELEASE, { lang: 'EN', target: 'floppy', stub: STUB });
  assert.deepEqual(a.outputs.map((o) => o.name), ['MagiC-6.30-EN-floppy.img', 'MagiC-6.30-EN-floppy.st']);
  assert.deepEqual(a.outputs[1].data, b.outputs[1].data);
  const hd = await buildPackage(RELEASE, { lang: 'FR', target: 'harddisk', stub: STUB });
  assert.deepEqual(hd.outputs.map((o) => o.name), ['MagiC-6.30-FR-harddisk.img', 'MagiC-6.30-FR-harddisk.zip']);
  const files = await readZip(hd.outputs[1].data);
  assert.ok(files.has('MAGX.INF') && files.has('GEMSYS/GEMDESK/MAGXDESK.APP'));
});

test('sha256: matches node:crypto, including block-boundary lengths', () => {
  for (const len of [0, 1, 55, 56, 63, 64, 65, 1000, 262144]) {
    const data = new Uint8Array(len).map((_, i) => (i * 31 + 7) & 0xff);
    assert.equal(sha256Hex(data), createHash('sha256').update(data).digest('hex'), `length ${len}`);
  }
});
