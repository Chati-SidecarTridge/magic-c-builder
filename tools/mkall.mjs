#!/usr/bin/env node
// Build everything the web page builds, from the command line:
//   tools/mkall.mjs Atari-MagiC-*.zip OUTDIR [EN|DE|FR]
// Writes MagiC-<version>-<lang>-floppy.{img,st} and
// MagiC-<version>-<lang>-harddisk.{img,zip}, printing the narrated log
// (in colour on a terminal; NO_COLOR=1 turns it off).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { buildPackage } from '../src/package.js';
import { formatLogText } from '../src/log-format.js';

const [, , zipPath, outDir, lang = 'EN'] = process.argv;
if (!zipPath || !outDir) {
  console.error('usage: tools/mkall.mjs Atari-MagiC-*.zip OUTDIR [EN|DE|FR]');
  process.exit(2);
}
const stub = readFileSync(new URL('../src/stubs/romboot.bin', import.meta.url));
mkdirSync(outDir, { recursive: true });
for (const target of ['floppy', 'harddisk']) {
  const color = process.stdout.isTTY && !process.env.NO_COLOR;
  const log = (entry) => console.log(formatLogText(entry, color));
  const result = await buildPackage(readFileSync(zipPath), { lang, target, stub, log });
  for (const out of result.outputs) {
    writeFileSync(join(outDir, out.name), out.data);
    console.log(`wrote ${join(outDir, out.name)} (${out.data.length} bytes)`);
  }
}
