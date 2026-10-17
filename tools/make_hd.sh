#!/usr/bin/env bash
#
# tools/make_hd.sh: build a bootable ACSI hard disk image holding the
# hard disk file set, for testing the harddisk ROM in Hatari (--acsi).
#
# Usage: tools/make_hd.sh <MagiC-*-harddisk.zip> <out.img>
#
# The image (32 MB, one AHDI partition, booted by the ICD Pro 6.5.5 driver
# ICDBOOT.PRG) comes from the sibling ../atari-hd tool; the ZIP's files are
# copied into the partition root with mtools and checked back.
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: $0 <MagiC-*-harddisk.zip> <out.img>" >&2
  exit 2
fi
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
atari_hd="${ATARI_HD:-$here/../../atari-hd}"
[[ -f "$atari_hd/atari_hd.py" ]] || { echo "error: no atari_hd.py in $atari_hd (set ATARI_HD)" >&2; exit 1; }
driver="${ICD_DRIVER:-$atari_hd/drivers/icdp655a/ICDBOOT.PRG}"
[[ -f "$driver" ]] || { echo "error: no ICDBOOT.PRG at $driver (set ICD_DRIVER)" >&2; exit 1; }
for tool in mcopy unzip; do
  command -v "$tool" >/dev/null || { echo "error: $tool not found" >&2; exit 1; }
done
export MTOOLS_SKIP_CHECK=1

zip="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
out="$(cd "$(dirname "$2")" && pwd)/$(basename "$2")"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

mkdir "$work/files"
(cd "$work/files" && unzip -q "$zip")
# Answers: file name, no TOS < 1.04 limits, proceed.
(cd "$work" && printf 'hd.img\nn\ny\n' | python3 -I "$atari_hd/atari_hd.py" --no-tui \
  --ahdi-driver "$driver" --size 32 --auto default --auto-n 1 > atari-hd.log)
# First partition from the AHDI root sector: entry at $1C6 = flag, 'GEM'/'BGM',
# start sector (big-endian long).
lba=$(python3 -I -c 'import sys; d = open(sys.argv[1], "rb").read(512)
assert d[0x1C6] & 1 and d[0x1C7:0x1CA] in (b"GEM", b"BGM"), "no AHDI partition"
print(int.from_bytes(d[0x1CA:0x1CE], "big"))' "$work/hd.img")
img="$work/hd.img@@$((lba * 512))"
(cd "$work/files" && mcopy -s -m -i "$img" ./* ::/)

mkdir "$work/check"
mcopy -s -n -i "$img" ::/ "$work/check/"
rm -f "$work/check/ICDBOOT.SYS"   # the driver, which atari-hd puts on the partition
if ! diff -r "$work/files" "$work/check" >/dev/null; then
  echo "error: the image does not hold the same files as the ZIP" >&2
  exit 1
fi
mv "$work/hd.img" "$out"
echo "wrote $out (partition at LBA $lba, $(cd "$work/files" && find . -type f | wc -l | tr -d ' ') files, checked)"
