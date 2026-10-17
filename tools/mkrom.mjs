#!/usr/bin/env node
// Command-line front end for the ROM builder: mkrom.mjs MAGIC.RAM OUT.IMG
import { readFileSync, writeFileSync } from 'node:fs';
import { buildMagicRom } from '../src/magic-rom.js';

const [, , input, output] = process.argv;
if (!input || !output) {
  console.error('usage: tools/mkrom.mjs MAGIC.RAM OUT.IMG [A|C]');
  process.exit(2);
}
const stub = readFileSync(new URL('../src/stubs/romboot.bin', import.meta.url));
const sysDrive = (process.argv[4] || 'C').toUpperCase().charCodeAt(0) - 65;
const { rom, info } = buildMagicRom(readFileSync(input), stub, { sysDrive });
writeFileSync(output, rom);
const hex = (v) => '$' + v.toString(16).toUpperCase();
console.log(`kernel ${info.kernelBytes} bytes, ${info.relocations} relocations, `
  + `version ${hex(info.version)}, date ${hex(info.osDate)}`);
console.log(`entry ${hex(info.kernelEntry)}, stub at ${hex(info.stubAt)}, `
  + `checksum ${hex(info.checksum)}, ${info.freeBytes} bytes free`);
console.log(`wrote ${output}`);
