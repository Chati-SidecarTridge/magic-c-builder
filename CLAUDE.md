# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

See also: `README.md` (user-facing usage and how the ROM is made).

## What this is

A single-file browser tool (`index.html`) that builds a **MagiC ROM** for the SidecarTridge TOS Emulator:
a 256 KB image mapped at `$E00000` that boots MagiC 6.30 in place of TOS, plus the files MagiC loads
its desktop from (720 KB boot floppy for system drive A:, or a ZIP for C:). Input is an official
`Atari-MagiC-*.zip` release from Andreas Kromke's GitLab (`MagiC/Releases/`); a copy is bundled in
`assets/`. Sibling of `../USM-web`, same structure and conventions.

## Commands

```sh
npm run build          # src/ -> index.html; also regenerates src/romboot-stub.js. Commit both.
npm test               # node:test unit tests, no dependencies
node --test --test-name-pattern='floppy' 'tests/*.test.mjs'   # one test
npm run stub           # vasm via stcmd: stub/romboot.s -> src/stubs/romboot.bin
node tools/mkall.mjs assets/Atari-MagiC-*.zip out EN         # CLI build of everything the page builds
npm run consent-check  # cookie banner shown, no Google request before consent, gtag only on *.sidecartridge.com
npm run browser-check -- out EN DE FR   # page in headless Chrome from the LAN address (insecure
                                        # origin, like a tablet on plain HTTP), downloads vs mkall output
tools/hatari_e2e.sh EN # boot both targets in Hatari: PASS = Pexec of MAGXDESK.APP, no MCMD fallback
tools/matrix.sh ROM FLOPPY   # ST/Mega ST/STE/Mega STE x 512K..4M, prints phystop/memctrl
# Note: Hatari maps a 256 KB ROM at $E00000 on every machine type. On ST/Mega ST the matrix
# proves the stub's memory sizing, not the ROM mapping: real hardware needs the 256 KB decoder,
# and real-hardware runs (TOS Emulator) are the only check of that.
tools/hatari_boot.py ROM [--disk-a ST] [--keys 50:0x1c] [--extra "--acsi 0=img"] ...  # one boot + shots
```

Homebrew's default `node` on this Mac is broken (missing simdjson); use
`export PATH=/usr/local/opt/node@22/bin:$PATH`. Node 22+ is required (built-in WebSocket for the
browser check, DecompressionStream for ZIP reading).

## Architecture

`build.mjs` concatenates `src/*.js` in `MODULE_ORDER` into one `<script type="module">` (stripping
`import`/`export`, so modules reference each other's top-level names; no `export default` or
`export {}`). The pipeline, `src/package.js` `buildPackage()`, is shared by the page (`ui.js`) and
the CLI (`tools/mkall.mjs`):

- `zip.js`: read the release (stored/deflate via DecompressionStream), write the stored C: ZIP.
- `rootfs.js`: find the `MAGIC.A` tree, pick `LANG/<xx>/MAGIC.RAM`, localise like `LANG/<xx>.BAT`
  (rule table; German HELP files for every language), drop RAM-only files (`MAGXBOOT`), select the
  floppy set (`FLOPPY_FILES`) and retarget `MAGX.INF` from `C:\` to `A:\`.
- `magic-rom.js`: parse `MAGIC.RAM` (PRG + relocation stream), relocate TEXT+DATA to `$E00000`,
  patch, append the stub, fill the stub's two trailing longs (checksum, kernel entry).
- `fat12.js`: 720 KB `.ST` with a TOS BPB (2 sectors/cluster, 5 sectors/FAT, 112 root entries),
  non-executable boot sector, 8.3 names, fixed timestamps.
- `stub/romboot.s`: the boot stub (diag cart check, PSG, EmuTOS-derived ST/STE memconf or warm-boot
  reuse via memvalid/memval2/memval3, sysvars, `os_chksum` at `$486`, `_hz_200`, jump to kernel).
  Position independent; its last 8 bytes are patch slots.

## Cookie banner and analytics

The page is published on a sidecartridge.com subdomain and shares the main site's cookie banner and
Google Analytics property. `src/consent.html` is the main site's
`_includes/framework/cookie-consent.html` (sibling `../sidecartridge-website`) with absolute
privacy/contact links; `src/vendor/cookieconsent.{js,css}` are verbatim copies of its
orestbida/cookieconsent v2.9.2 (MIT). `build.mjs` inlines them (`{{CONSENT}}`). The GA4 tag
(`G-6VT9RXTJ2N`, same as `_config.yml` there) is a `type="text/plain" data-cookiecategory="analytics"`
script: it runs only after consent, and only loads gtag on `*.sidecartridge.com`. No Google Fonts
(the main site turns them off too): nothing may reach Google before consent.
Consent is shared with the main site: cookieconsent always writes `Domain=<cookie_domain>` and
defaults it to `location.hostname`, so sidecartridge.com's `cc_cookie` already covers subdomains;
this page sets `cookie_domain: 'sidecartridge.com'` on `*.sidecartridge.com` so it reads and writes
that same cookie (no change needed on the main site).
`npm run consent-check` verifies all of it in headless Chrome with Google's hosts blackholed,
including both cross-site directions against the main site's own include from `../sidecartridge-website`.
If the main site changes its banner or GA ID, copy the change here.

## Facts the design depends on (verified in Hatari, see README)

- The kernel's OS header has `os_beg` at offset 8 (Hatari requires `$E00000` there, version word at
  offset 2 between `$100` and `$6FF`). The header's `reseth` (offset 4) is the one relocation the
  builder overwrites (with the stub address).
- **System drive**: VDI drivers (`\GEMSYS\*.OSD`, `MFA*.SYS`) come from the drive in the word at
  GEM parameter block + `$78` (kernel default 2 = C:); `MAGX.INF` comes from `_bootdev`. These must
  agree, which is why a target is floppy (A:, no HD driver) or hard disk (C:, a driver that boots).
  Hatari's GEMDOS folder (`--harddrive`) does not boot MagiC: test C: with an ACSI image
  (`tools/make_hd.sh`: ICD AHDI driver via `../atari-hd`).
- `resvalid` check `0cb8 31415926 0426 6600` must occur exactly once in the kernel; `bne` becomes `bra`.
- On a crash the kernel sums its TEXT+DATA longs and compares with `os_chksum` (`$486`); the stub
  stores the builder's precomputed sum.
- A MAGICROM-built MagiC 6.20 ROM image has the same kernel bytes relocated behind a 19 KB stub;
  the research comparing them lives in the gitignored `docs/research/`.

## Hatari harness gotchas

Hatari runs with a private `HOME` (the user's saved config otherwise leaks in), `--fast-boot false`
(else memvalid is preset and the stub's sizing is skipped), headless SDL. Debugger: `--parse` file
with `b <cond> :once :trace :file <ABSOLUTE path>`; `:file` paths are resolved from the script's
dir. The release's `AUTO\ACCS` clock panel waits for Return on machines without RTC.

## Conventions (from the sibling repos)

- The build log is documentation: `package.js` narrates every step (what it does and why, with the
  facts above) as structured entries that `log-format.js` renders as HTML (page) or ANSI text
  (`tools/mkall.mjs`). A change to the pipeline updates its narration in the same edit; keep the
  statements to what was verified, and say where (Hatari, the sources).
- `index.html` and `src/romboot-stub.js` are generated: edit `src/`, rebuild, commit together.
- `src/stubs/romboot.bin` is vasm output of `stub/romboot.s`: never hand-edit; reassemble with
  `npm run stub`, then rebuild and rerun `tools/hatari_e2e.sh`.
- No bundler, no transpiler, no runtime or dev dependencies. 2-space indent, semicolons, named exports.
- No em dashes in any text, no AI attribution in commits or files.
- `docs/` is private and gitignored (research notes, MagiC sources clone, extracted inputs).
- Do not push or open PRs without explicit approval. `main` is published by GitHub Pages at
  <https://magic.sidecartridge.com/> (`CNAME`; keep the canonical link in `src/template.html` in step).
  No staging: test with `npm run build && python3 -m http.server` before merging.

## Workspace context

This repo lives in `/Users/diego/mister_wkspc`, a folder of ~100 independent checkouts (not a repo).
Relevant siblings: `../USM-web` (template for this project), `../sidecartos` (the TOS Emulator
firmware; ROM catalog rules in `usbdrive/src/builder.c`), `../hatari` (v2.6.1 source, installed at
`/usr/local/bin/hatari`), `../romemul-switcher-rom` (reference Hatari harness for custom ROMs),
`../atari-hd` (bootable ACSI images), `../atarist-toolkit-docker` (`stcmd`).
