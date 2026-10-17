// Turn a MagiC kernel (MAGIC.RAM) into a ROM image that runs in place.
//
// MAGIC.RAM is a GEMDOS executable whose TEXT starts with a TOS-style OS
// header, linked at address 0 and relocated by MAGXBOOT. Here the kernel is
// relocated to the ROM base instead, so its own header becomes the ROM
// header, and the boot stub (stub/romboot.s) is appended after it. The
// header's reset vector is pointed at the stub, which configures memory as
// TOS would before MAGXBOOT runs, then jumps into the kernel.

export const ROM_BASE = 0xe00000;
export const ROM_SIZE = 256 * 1024;
const ROM_FILL = 0xff;

const PRG_MAGIC = 0x601a;
const OS_ENTRY = 0x602e;        // bra.b over the 0x30-byte OS header
const GEM_MAGIC = 0x87654321;
const MAGX_ID = 0x4d414758;     // 'MAGX'

// cmpi.l #$31415926,resvalid / bne.w : the kernel's reset path jumps through
// resvector when resvalid is set. MAGXBOOT's MODIFY step and MAGICROM turn
// the bne into a bra, so a resvector left by an earlier RAM-loaded MagiC
// cannot take over the ROM kernel.
const RESVALID_CHECK = [0x0c, 0xb8, 0x31, 0x41, 0x59, 0x26, 0x04, 0x26, 0x66, 0x00];

function readBE16(buf, off) {
  return (buf[off] << 8) | buf[off + 1];
}

function readBE32(buf, off) {
  return ((buf[off] << 24) | (buf[off + 1] << 16) | (buf[off + 2] << 8) | buf[off + 3]) >>> 0;
}

function writeBE32(buf, off, v) {
  buf[off] = (v >>> 24) & 0xff;
  buf[off + 1] = (v >>> 16) & 0xff;
  buf[off + 2] = (v >>> 8) & 0xff;
  buf[off + 3] = v & 0xff;
}

export function parseMagicRam(file) {
  if (file.length < 0x1c + 0x30 || readBE16(file, 0) !== PRG_MAGIC) {
    throw new Error('Not a GEMDOS executable (no $601A header).');
  }
  const textLen = readBE32(file, 2);
  const dataLen = readBE32(file, 6);
  const bssLen = readBE32(file, 10);
  const symLen = readBE32(file, 14);
  const segLen = textLen + dataLen;
  if (0x1c + segLen + symLen > file.length) {
    throw new Error('Truncated executable: TEXT+DATA run past the end of the file.');
  }
  const seg = file.subarray(0x1c, 0x1c + segLen);
  if (readBE16(seg, 0) !== OS_ENTRY) {
    throw new Error('No OS header at the start of TEXT: this is not a MagiC kernel.');
  }
  const gemBlock = readBE32(seg, 0x14);
  if (gemBlock + 16 > segLen || readBE32(seg, gemBlock) !== GEM_MAGIC
      || readBE32(seg, gemBlock + 12) !== MAGX_ID) {
    throw new Error('GEM parameter block with the MAGX signature not found: not a MagiC kernel.');
  }

  // GEMDOS relocation stream: first offset as a long, then byte deltas,
  // 1 = skip 254 bytes, 0 = end. A first long of 0 means no fixups.
  const relocs = [];
  let p = 0x1c + segLen + symLen;
  if (p + 4 <= file.length) {
    let off = readBE32(file, p);
    p += 4;
    if (off !== 0) {
      relocs.push(off);
      while (p < file.length) {
        const c = file[p++];
        if (c === 0) break;
        if (c === 1) {
          off += 254;
        } else {
          off += c;
          relocs.push(off);
        }
      }
    }
  }
  for (const r of relocs) {
    if (r & 1 || r + 4 > segLen) {
      throw new Error(`Bad relocation offset $${r.toString(16)}.`);
    }
  }

  return {
    textLen, dataLen, bssLen, segLen, seg, relocs, gemBlock,
    osEnd: readBE32(seg, 0x0c),
    aesEnd: readBE32(seg, gemBlock + 4),
    version: readBE16(seg, 2),
    entry: readBE32(seg, 4),
    osDate: readBE32(seg, 0x18),
    osConf: readBE16(seg, 0x1c),
  };
}

function findAll(buf, pattern) {
  const hits = [];
  outer:
  for (let i = 0; i + pattern.length <= buf.length; i += 2) {
    for (let j = 0; j < pattern.length; j++) {
      if (buf[i + j] !== pattern[j]) continue outer;
    }
    hits.push(i);
  }
  return hits;
}

// Sum of longs from the kernel start while below the kernel end, exactly as
// MAGXBOOT and the kernel's crash handler compute it (a trailing partial long
// includes the bytes that follow the kernel).
function kernelChecksum(rom, len) {
  let sum = 0;
  for (let off = 0; off < len; off += 4) {
    sum = (sum + readBE32(rom, off)) >>> 0;
  }
  return sum;
}

// Word in the GEM parameter block holding the drive the kernel loads its
// system files from (VDI drivers in \GEMSYS, MAGX.INF, the desktop):
// 0 = A:, 2 = C:. The kernel ships with C:.
const GEM_SYSDRIVE = 0x78;

export function buildMagicRom(magicRam, stub, options = {}) {
  const sysDrive = options.sysDrive ?? 2;
  if (!Number.isInteger(sysDrive) || sysDrive < 0 || sysDrive > 25) {
    throw new Error('System drive must be a drive number from 0 (A:) to 25 (Z:).');
  }
  const k = parseMagicRam(magicRam);
  const stubOff = (k.segLen + 15) & ~15;
  if (stubOff + stub.length > ROM_SIZE) {
    throw new Error(`Kernel too large: ${k.segLen} bytes plus a ${stub.length}-byte boot stub `
      + `do not fit in ${ROM_SIZE / 1024} KB.`);
  }

  const rom = new Uint8Array(ROM_SIZE).fill(ROM_FILL);
  rom.set(k.seg, 0);
  for (const r of k.relocs) {
    writeBE32(rom, r, (readBE32(rom, r) + ROM_BASE) >>> 0);
  }

  const hits = findAll(rom.subarray(0, k.segLen), RESVALID_CHECK);
  if (hits.length !== 1) {
    throw new Error(`Expected one resvalid check in the kernel, found ${hits.length}.`);
  }
  rom[hits[0] + 8] = 0x60;

  const gemBlock = k.gemBlock;
  const shippedSysDrive = readBE16(rom, gemBlock + GEM_SYSDRIVE);
  rom[gemBlock + GEM_SYSDRIVE] = 0;
  rom[gemBlock + GEM_SYSDRIVE + 1] = sysDrive;

  rom.set(stub, stubOff);
  const kernelGo = readBE32(rom, 4);
  writeBE32(rom, 4, ROM_BASE + stubOff);
  writeBE32(rom, stubOff + stub.length - 4, kernelGo);
  // The checksum covers the kernel only; compute it after the stub is in
  // place in case the kernel length is not a multiple of four.
  const sum = kernelChecksum(rom, k.segLen);
  writeBE32(rom, stubOff + stub.length - 8, sum);

  return {
    rom,
    info: {
      kernelBytes: k.segLen,
      textBytes: k.textLen,
      dataBytes: k.dataLen,
      bssBytes: k.bssLen,
      relocations: k.relocs.length,
      gemBlock: ROM_BASE + gemBlock,
      osEnd: k.osEnd,
      aesEnd: k.aesEnd,
      stubBytes: stub.length,
      shippedSysDrive,
      version: k.version,
      osDate: k.osDate,
      osConf: k.osConf,
      stubAt: ROM_BASE + stubOff,
      kernelEntry: kernelGo,
      freeBytes: ROM_SIZE - stubOff - stub.length,
      checksum: sum,
      resvalidPatchAt: ROM_BASE + hits[0] + 8,
      sysDrive,
    },
  };
}
