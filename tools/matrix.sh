#!/usr/bin/env bash
# tools/matrix.sh ROM FLOPPY: boot the floppy package on every machine and RAM
# size, report phystop/memctrl and whether MagiC loaded its desktop.
set -uo pipefail
rom="$1"; floppy="$2"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
printf '%-8s %-6s %-10s %-8s %s\n' machine ram phystop memctrl desktop
for machine in st megast ste megaste; do
  for ram in 512 1024 2048 4096; do
    out=$(python3 "$here/hatari_boot.py" "$rom" --disk-a "$floppy" --machine "$machine" --memsize "$ram" \
      --shots 40 --label "mx-$machine-$ram" --extra "--trace gemdos" \
      --debug-at-end 'm $42e 4;m $424 1' 2>&1)
    run=$(echo "$out" | sed -n 's/^run: //p')
    phystop=$(grep -a -m1 '^0000042E:' "$run/stderr.txt" | awk '{print $2$3$4$5}')
    memctrl=$(grep -a -m1 '^00000424:' "$run/stderr.txt" | awk '{print $2}')
    if grep -a -q 'Pexec(0, "MAGXDESK.APP"' "$run/stderr.txt" && ! grep -a -q 'MCMD.TOS' "$run/stderr.txt"; then desk=PASS; else desk=FAIL; fi
    printf '%-8s %-6s %-10s %-8s %s  %s\n' "$machine" "$ram" "$phystop" "$memctrl" "$desk" "$run/shots/shot-040s.png"
  done
done
