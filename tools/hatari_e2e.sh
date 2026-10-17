#!/usr/bin/env bash
#
# tools/hatari_e2e.sh [LANG]: build both targets from the bundled release and
# boot them in Hatari (STE, 4 MB). PASS when MagiC starts MAGXDESK.APP and
# never falls back to MCMD. The hard disk target boots from an ACSI image
# with the ICD driver, made by tools/make_hd.sh (needs ../atari-hd); Return dismisses the
# clock panel the release's accessories open on machines without a clock.
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/.." && pwd)"
lang="${1:-EN}"
out="$repo/out/e2e"
rm -rf "$out"
node "$here/mkall.mjs" "$repo"/assets/Atari-MagiC-*.zip "$out" "$lang" >/dev/null || exit 1
base="$out/MagiC-6.30-$lang"
status=0

check() {
  local label="$1"; shift
  local run
  run=$(python3 "$here/hatari_boot.py" "$@" --label "e2e-$label" --extra "--trace gemdos ${EXTRA:-}" | sed -n 's/^run: //p')
  if grep -a -q 'Pexec(0, "MAGXDESK.APP"' "$run/stderr.txt" && ! grep -a -q 'MCMD.TOS' "$run/stderr.txt"; then
    echo "PASS $label  $run/shots"
  else
    echo "FAIL $label  $run/shots"
    status=1
  fi
}

check "floppy-$lang" "$base-floppy.img" --disk-a "$base-floppy.st" --shots 40
"$here/make_hd.sh" "$base-harddisk.zip" "$out/hd.img" >/dev/null || exit 1
EXTRA="--acsi 0=$out/hd.img" check "harddisk-$lang" "$base-harddisk.img" --shots 70 --keys 50:0x1c
exit $status
