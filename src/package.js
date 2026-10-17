// One build: a MagiC release ZIP in, a ROM image plus the files that boot
// it out. Shared by the web page and tools/mkall.mjs.
//
// The log is meant to be read: every step says what it does and why, so
// the knowledge behind the ROM (how MagiC boots, what the ROM changes) is
// kept with the tool that applies it. Entries are structured; see
// log-format.js for how they are shown.
import { readZip, writeZip } from './zip.js';
import { sha256Hex } from './sha256.js';
import { buildFloppy } from './fat12.js';
import { buildMagicRom, parseMagicRam, ROM_BASE, ROM_SIZE } from './magic-rom.js';
import {
  releaseTree, kernelFor, localisedTree, floppyFiles, hardDiskFiles, countDrivePaths,
} from './rootfs.js';

export const TARGETS = {
  floppy: { sysDrive: 0, suffix: 'floppy', label: 'floppy, system on A:' },
  harddisk: { sysDrive: 2, suffix: 'harddisk', label: 'hard disk, system on C:' },
};

const hex = (v, digits = 0) => '$' + (v >>> 0).toString(16).toUpperCase().padStart(digits, '0');
const drive = (n) => String.fromCharCode(65 + n) + ':';
const bytes = (n) => `${n.toLocaleString('en-US')} bytes`;
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

function be16(b, o) {
  return (b[o] << 8) | b[o + 1];
}

// MagiC version from the AES variables (word at +$30 of the GEM block).
function magicVersion(k) {
  const v = be16(k.seg, k.gemBlock + 0x30);
  return `${(v >> 8).toString(16)}.${(v & 0xff).toString(16).padStart(2, '0')}`;
}

// GEMDOS-format date at OS header +$1E: the kernel build date, used for
// every file timestamp so a build is reproducible.
function kernelStamp(k) {
  const d = be16(k.seg, 0x1e);
  return { year: 1980 + (d >> 9), month: (d >> 5) & 15, day: d & 31, hour: 12, minute: 0 };
}

// Numbered steps with their start time; the durations go in the summary.
function narrator(log, t0) {
  const steps = [];
  const at = () => now() - t0;
  return {
    at,
    steps,
    start(text) {
      log({ kind: 'start', text });
    },
    step(title) {
      const t = at();
      if (steps.length) steps[steps.length - 1].ms = t - steps[steps.length - 1].at;
      steps.push({ n: steps.length + 1, title, at: t });
      log({ kind: 'step', n: steps.length, title, at: t });
    },
    say(text) {
      log({ kind: 'say', text });
    },
    item(text) {
      log({ kind: 'item', text });
    },
    table(headers, rows, align) {
      log({ kind: 'table', headers, rows, align });
    },
  };
}

// t0: when the build started (performance.now() clock), so time spent
// before buildPackage (fetching the release) counts too.
export async function buildPackage(zipBytes, { lang, target, stub, log = () => {}, t0 = now() }) {
  const t = TARGETS[target];
  if (!t) throw new Error(`Unknown target "${target}".`);
  const n = narrator(log, t0);
  n.start(`MagiC ROM build, ${lang}, ${t.label}, started ${new Date().toLocaleString('en-GB')}`);

  // ---------------------------------------------------------------------
  n.step('Read the MagiC release');
  const zipFiles = await readZip(zipBytes);
  const tree = releaseTree(zipFiles);
  n.say(`The archive holds ${zipFiles.size} files (${bytes(zipBytes.length)}). Its MAGIC.A folder is the root of a MagiC boot drive as Andreas Kromke ships it:`);
  n.table(['Folder', 'What it holds'], [
    ['GEMSYS', 'screen drivers, the MAGXDESK desktop, shared libraries, desktop patterns'],
    ['AUTO', 'MAGXBOOT.TOS (the loader of the RAM version) and the accessories'],
    ['BIN, EXTRAS', 'command line tools, extra programs and documentation'],
    ['LANG/DE, LANG/EN, LANG/FR', 'a kernel (MAGIC.RAM) and the translated files for each language'],
  ]);

  // ---------------------------------------------------------------------
  n.step(`Take the ${lang} kernel, LANG/${lang}/MAGIC.RAM`);
  const kernel = kernelFor(tree, lang);
  const k = parseMagicRam(kernel);
  const version = magicVersion(k);
  const stamp = kernelStamp(k);
  const date = `${stamp.year}-${String(stamp.month).padStart(2, '0')}-${String(stamp.day).padStart(2, '0')}`;
  n.table(['Field', 'Value', 'Meaning'], [
    ['MagiC version', version, 'from the AES variables, GEM block + $30'],
    ['Build date', date, 'GEMDOS date in the OS header at +$1E'],
    ['Format', '$601A', 'GEMDOS executable'],
    ['TEXT', bytes(k.textLen), 'code, starting with a TOS-style OS header'],
    ['DATA', bytes(k.dataLen), 'tables and strings'],
    ['BSS', bytes(k.bssLen), 'empty: no variables inside the kernel image'],
    ['Relocations', k.relocs.length.toLocaleString('en-US'), 'longs that hold an address'],
    ['OS header version', hex(k.version, 4), 'at offset 2'],
    ['Reset entry', hex(k.entry), 'syshdr_code, at offset 4'],
    ['GEM parameter block', hex(k.gemBlock), "$87654321 ... 'MAGX': a MagiC kernel"],
    ['End of BIOS and DOS variables', hex(k.osEnd), 'fixed area in low RAM'],
    ['End of AES variables', hex(k.aesEnd), 'fixed area in low RAM'],
  ], ['l', 'r', 'l']);
  n.say('Normally TOS boots first and AUTO\\MAGXBOOT loads this file, relocates it into RAM above the OS variables and jumps to it; MagiC then replaces TOS until the next cold boot. Here the kernel runs straight from ROM: no TOS is needed and no RAM is spent on the kernel.');
  n.say('This works because the kernel keeps all its variables at fixed addresses in low RAM and its BSS is empty, so its code and data can stay read-only.');

  // ---------------------------------------------------------------------
  n.step('Relocate the kernel to the ROM address $E00000');
  const { rom, info } = buildMagicRom(kernel, stub, { sysDrive: t.sysDrive });
  n.say(`The kernel is linked at address 0. Each of its ${info.relocations.toLocaleString('en-US')} relocation entries marks a long that holds an address, and $E00000 is added to each: what MAGXBOOT does with its load address.`);
  n.say('$E00000 is where the STE and Mega STE decode 256 KB of ROM; an ST or Mega ST needs a 256 KB decoder for it. The kernel does not fit in the 192 KB ROM space at $FC0000.');
  n.say('The kernel\'s own OS header becomes the ROM header: os_beg = $E00000 at offset 8 and the version at offset 2 are what Hatari and TOS-aware programs check in a TOS ROM. On reset the 68000 reads its stack pointer and start address from the first 8 bytes of the ROM, mirrored at address 0, so offset 4 (the reset vector) decides where the machine starts.');

  // ---------------------------------------------------------------------
  n.step('Patch the warm reset path');
  n.say(`At ${hex(info.resvalidPatchAt)} the kernel's reset code does "cmpi.l #$31415926,resvalid / bne": when resvalid holds that magic value, it jumps through resvector. A RAM-loaded MagiC points both at itself, so after one ran (MAGXBOOT under another TOS) a warm reset would restart that old copy instead of the ROM.`);
  n.table(['Address', 'Before', 'After'], [[hex(info.resvalidPatchAt), '$66 bne', '$60 bra']]);
  n.say('The same patch MAGXBOOT\'s MODIFY step and the 1996 MAGICROM converter apply.');

  // ---------------------------------------------------------------------
  n.step(`Set the system drive to ${drive(t.sysDrive)}`);
  n.table(['Address', 'Shipped', 'Set to'], [[hex(info.gemBlock + 0x78), drive(info.shippedSysDrive), drive(t.sysDrive)]]);
  n.say('The word at GEM block + $78 names the drive the VDI loads its screen drivers from (\\GEMSYS\\MFA*.SYS and the *.OSD offscreen drivers). Booted from a floppy with the shipped value, MagiC looks for C:\\GEMSYS\\*.OSD and stops with "Offscreen driver not found" (seen in Hatari).');
  n.say('The AES reads MAGX.INF and starts the desktop from the boot drive (_bootdev), which only a hard disk driver sets to C:. Both must name the same drive.');
  n.say(target === 'floppy'
    ? 'Floppy target: there is no hard disk driver, so the system drive is A:.'
    : 'Hard disk target: C:, for a hard disk driver that boots from C:.');

  // ---------------------------------------------------------------------
  n.step('Append the boot stub and point the reset vector at it');
  n.say(`In RAM mode TOS has done the cold boot work before MAGXBOOT runs; in ROM nothing has, and the kernel does not do it itself. The stub (${bytes(info.stubBytes)}, stub/romboot.s) does it on every reset:`);
  n.item('jumps to a diagnostic cartridge at $FA0000 if one is plugged in, as TOS does;');
  n.item('deselects both floppy drives through port A of the sound chip;');
  n.item('warm reset: when memvalid, memval2 and memval3 hold their magic values, puts memctrl back into the memory controller and keeps phystop;');
  n.item('cold boot: sizes the ST/STE RAM banks by writing test patterns and looking for where they repeat (the algorithm EmuTOS uses), programs the memory controller at $FF8001, clears $400-$FFFF and sets memctrl, phystop, memvalid, memval2 and memval3;');
  n.item(`stores the kernel checksum at $486 (os_chksum), clears the 200 Hz counter and jumps to the kernel at ${hex(info.kernelEntry)}.`);
  n.say('The kernel address and the checksum go into the stub\'s last two longs.');

  // ---------------------------------------------------------------------
  n.step('Compute the kernel checksum');
  n.table(['Checksum', 'Stored at', 'Copied at boot to'], [[hex(info.checksum, 8), hex(info.stubAt + info.stubBytes - 8), '$486 os_chksum']]);
  n.say('The sum of the kernel\'s longs, as MAGXBOOT computes it for the RAM version. After a crash (bombs) the kernel sums itself again and compares with $486 to tell whether a program overwrote the OS; without the value it would always report a corrupted system.');
  const stubEnd = info.stubAt + info.stubBytes;
  n.say('The finished ROM:');
  n.table(['Region', 'From', 'To', 'Size'], [
    ['OS header + kernel TEXT', hex(ROM_BASE, 6), hex(ROM_BASE + info.textBytes - 1, 6), bytes(info.textBytes)],
    ['Kernel DATA', hex(ROM_BASE + info.textBytes, 6), hex(ROM_BASE + info.kernelBytes - 1, 6), bytes(info.dataBytes)],
    ['Boot stub', hex(info.stubAt, 6), hex(stubEnd - 1, 6), bytes(info.stubBytes)],
    ['Free ($FF)', hex(stubEnd, 6), hex(ROM_BASE + ROM_SIZE - 1, 6), bytes(info.freeBytes)],
  ], ['l', 'l', 'l', 'r']);

  // ---------------------------------------------------------------------
  n.step(`Localise the boot drive files for ${lang}`);
  const report = {};
  const localised = localisedTree(tree, lang, report);
  n.say(`The copies LANG/${lang}.BAT makes on an Atari, applied here:`);
  n.table(['Folder', 'Types', 'Files', 'From'], report.rules.map((r) => [
    r.dir, r.ext.map((x) => `*.${x}`).join(' '), String(r.count),
    r.from === lang ? `LANG/${r.from}` : `LANG/${r.from} (only in German)`,
  ]), ['l', 'l', 'r', 'l']);
  n.say(`Left out: ${report.dropped.join(', ')}, which only ${report.dropped.length === 1 ? 'loads' : 'load'} the RAM version that the ROM replaces.`);

  // ---------------------------------------------------------------------
  const base = `MagiC-${version}-${lang}-${t.suffix}`;
  const outputs = [{ name: `${base}.img`, data: rom, kind: 'rom' }];
  if (target === 'floppy') {
    n.step('Build the 720 KB boot floppy');
    const files = floppyFiles(localised);
    const cPaths = countDrivePaths(localised.get('MAGX.INF'), 'C');
    n.say(`${files.length} files: the part of the release MagiC needs to reach its desktop from A:`);
    n.table(['Files', 'Purpose'], [
      ['MFA2/MFA4/MFA16.SYS', 'screen drivers for ST high, medium and low resolution'],
      ['OFF002/OFF004IP/OFF016IP.OSD', 'the matching offscreen drivers (the others are for graphics cards)'],
      ['GEMSYS\\MAGIC\\XTENSION', 'shared libraries and the keyboard table'],
      ['GEMSYS\\MAGIC\\START', 'the write-back daemon'],
      ['GEMSYS\\GEMDESK', 'MAGXDESK and its icons, VT52 and MCMD for TOS programs, CHGRES, the MG* tools'],
      ['GEMSYS\\HOME, GEMSCRAP', 'folders MAGX.INF names'],
      ['MAGX.INF', `${cPaths} paths changed from C:\\ to A:\\`],
    ]);
    n.say('The accessories, BIN and EXTRAS do not fit on the disk.');
    const { image, freeBytes, layout } = buildFloppy(files, { label: 'MAGIC', stamp });
    n.say('Disk format as TOS writes it:');
    n.table(['Field', 'Value'], [
      ['Geometry', `${layout.sectors / layout.spt / layout.heads} tracks, ${layout.heads} sides, ${layout.spt} sectors of ${layout.sectorBytes} bytes`],
      ['File system', `FAT12, ${layout.spc} sectors per cluster, ${layout.spf} sectors per FAT, ${layout.rootEntries} root entries`],
      ['Media byte', hex(layout.media, 2)],
      ['Boot sector word sum', `${hex(layout.bootChecksum, 4)}, not $1234: never executed at boot`],
      ['File dates', `${date}, the kernel date: the same input always gives the same image`],
      ['Free space', bytes(freeBytes)],
    ]);
    outputs.push({ name: `${base}.st`, data: image, kind: 'floppy' });
  } else {
    n.step('Pack the hard disk files');
    const files = hardDiskFiles(localised);
    n.say(`${files.length} files for the root of C:, the whole localised release: MAGX.INF with its C:\\ paths, the accessories in AUTO\\ACCS, the command line tools in BIN, and EXTRAS. Stored uncompressed, every entry dated ${date}.`);
    n.say('Boot from a hard disk driver (AHDI, ICD, HDDRIVER...) so that _bootdev is C:. The clock panel in AUTO\\ACCS asks for the date on machines without a clock.');
    outputs.push({ name: `${base}.zip`, data: writeZip(files, stamp), kind: 'zip' });
  }

  // ---------------------------------------------------------------------
  n.step('Summary');
  const rows = [];
  for (const out of outputs) rows.push([out.name, bytes(out.data.length), sha256Hex(out.data).slice(0, 16)]);
  n.table(['File', 'Size', 'SHA-256 (first 16)'], rows, ['l', 'r', 'l']);
  const total = n.at();
  n.steps[n.steps.length - 1].ms = total - n.steps[n.steps.length - 1].at;
  n.say('Time spent:');
  n.table(['Step', 'Time'], n.steps.slice(0, -1).map((s) => [`${s.n}. ${s.title}`, `${s.ms.toFixed(1)} ms`]), ['l', 'r']);
  log({ kind: 'ok', text: `Build finished in ${total.toFixed(1)} ms.`, at: total });
  return { outputs, info: { ...info, version, lang, target } };
}
