# MagiC ROM Builder

A browser tool that turns Andreas Kromke's [MagiC for Atari](https://gitlab.com/AndreasK/Atari-Mac-MagiC-Sources)
into a 256 KB ROM image that boots in place of TOS, together with the files MagiC loads its desktop
from:

- **Floppy target:** the ROM plus a 720 KB `.ST` boot floppy (system drive `A:`).
- **Hard disk target:** the ROM plus a ZIP with the full MagiC tree for the root of `C:`.

The ROM is mapped at `$E00000`. It runs in the
[SidecarTridge TOS Emulator](https://sidecartridge.com/products/sidecartridge-tos-atari-st/) on an STE
or Mega STE, on an ST or Mega ST with the [SidecarTridge 256 KB Decoder](https://sidecartridge.com/products/sidecartridge-256kb-decoder-atari-st/), and in Hatari. Languages: English, German,
French. Everything runs in the browser; nothing is uploaded.

## What is MagiC, and why a ROM?

MagiC (Mag!X when it started in 1990) is Andreas Kromke's multitasking replacement for TOS on the
Atari ST family: several GEM programs run at once, with the MVDI graphics library by Sven and Wilfried
Behne, long file names and the MAGXDESK desktop, while TOS software keeps working. Kromke published
the sources under the GPLv3 in 2018 and released MagiC 6.30 for Atari computers in 2026.

MagiC normally boots from disk: TOS starts, then `AUTO\MAGXBOOT` loads `MAGIC.RAM` into RAM. As a
ROM it needs no TOS and no loader, boots faster, and leaves the ~240 KB the kernel would take in RAM
to programs. With the SidecarTridge TOS Emulator, switching between MagiC and TOS is a ROM selection.

## Using it

Live at <https://magic.sidecartridge.com/>. To run it locally, open `index.html` over HTTP (GitHub Pages, or `python3 -m http.server` locally: the bundled release
is fetched, which `file://` does not allow). Pick the release (bundled, or your own
`Atari-MagiC-*.zip`), the language and the boot target, then **Build** and download.

From the command line, the same build:

```sh
node tools/mkall.mjs assets/Atari-MagiC-2026-10-17.zip out EN
```

## How the ROM is made

`MAGIC.RAM` is a GEMDOS executable whose TEXT starts with a TOS-style OS header. Normally
`MAGXBOOT` loads it under a running TOS, relocates it to RAM and jumps in. The builder instead:

1. relocates the kernel's TEXT+DATA to `$E00000`, so its own OS header becomes the ROM header;
2. turns the kernel's `resvalid` check into a branch (as `MAGXBOOT` and MAGICROM do), so a reset
   vector left by a RAM-loaded MagiC cannot take over;
3. sets the system drive word in the AES variables (`A:` or `C:`), from which the VDI loads its
   drivers and the AES its `MAGX.INF` and desktop;
4. appends a small boot stub (`stub/romboot.s`) and points the reset vector at it. The stub does the
   part of the TOS reset that `MAGXBOOT` takes for granted (memory controller sizing for ST/STE,
   `phystop`, `memvalid`), stores the checksum the kernel checks after a crash, and jumps into the
   kernel.

The kernel runs in place from ROM, so it leaves all RAM to programs.

## Development

```sh
npm run build          # src/ -> index.html (committed)
npm test               # unit tests (node:test, no dependencies)
npm run stub           # reassemble stub/romboot.s with vasm via stcmd
npm run browser-check -- out EN DE FR   # page in headless Chrome vs tools/mkall.mjs output
tools/hatari_e2e.sh EN # boot both targets in Hatari
tools/matrix.sh ROM FLOPPY             # ST/Mega ST/STE/Mega STE x 512 KB..4 MB
```

## Cookies and analytics

The page uses the same cookie banner and Google Analytics property as sidecartridge.com. Analytics
only load after the visitor accepts them, and only when the page is served from a
sidecartridge.com host; nothing is sent to Google before consent.

## License

GPLv3, like MagiC. The memory sizing in the boot stub is adapted from EmuTOS (GPL v2 or later). The cookie banner is
orestbida/cookieconsent v2.9.2 (MIT), as on sidecartridge.com.
The bundled `assets/Atari-MagiC-*.zip` is Andreas Kromke's unmodified release, GPLv3; its sources
are at <https://gitlab.com/AndreasK/Atari-Mac-MagiC-Sources>.
