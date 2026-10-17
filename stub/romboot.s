; romboot.s - cold/warm boot stub for a MagiC kernel running from ROM
;
; Copyright (C) 2026 Diego Parrilla Santamaria
; ST/STE memory controller detection adapted from EmuTOS bios/memory.S,
; Copyright (C) 2001-2025 by the EmuTOS authors, GPL v2 or later.
;
; This file is distributed under the GNU GPL, version 3 or later.
;
; MAGXBOOT loads MAGIC.RAM under a running TOS, so the kernel expects the
; memory controller to be configured and phystop/memvalid to be set already.
; In ROM nothing ran before it: this stub does that part of the TOS reset
; sequence, stores the checksum the kernel compares on a crash, and jumps
; into the kernel.
;
; The builder appends the stub after the relocated kernel, points the ROM
; header's reset vector at its first byte and fills the two longs at the end:
;   os_sum      checksum of the kernel TEXT+DATA, as MAGXBOOT computes it
;   kernel_go   address of the kernel's reset code (syshdr_code)
;
; Position independent: assemble with
;   vasmm68k_mot -quiet -Fbin -m68000 -no-opt -o romboot.bin romboot.s

memvalid  equ $420
memctrl   equ $424
resvalid  equ $426
phystop   equ $42e
memval2   equ $43a
_hz_200   equ $4ba
os_chksum equ $486
memval3   equ $51a

clear_beg equ $400                 ; cold boot: clear system variables
clear_end equ $10000               ;  and the low RAM the kernel uses

        section text

start:
        move.w  #$2700,sr
        reset

; Diagnostic cartridge, as TOS and the kernel do
        cmp.l   #$fa52235f,$fa0000
        bne.s   nodiag
        lea     nodiag(pc),a6
        jmp     $fa0004
nodiag:

; PSG: port A as output, both floppies deselected
        lea     $ffff8800.w,a0
        move.b  #7,(a0)
        move.b  #$c0,2(a0)
        move.b  #14,(a0)
        move.b  #$07,2(a0)

; Reuse a valid memory configuration on a warm reset
        cmp.l   #$752019f3,memvalid.w
        bne.s   memconf
        cmp.l   #$237698aa,memval2.w
        bne.s   memconf
        cmp.l   #$5555aaaa,memval3.w
        bne.s   memconf
        move.b  memctrl.w,d6
        move.l  phystop.w,d5
        move.b  d6,$ffff8001.w
        bra     memdone

; ==== memconf: size the ST/STE RAM banks (from EmuTOS) =====================
; Out: d6.b = value for $ffff8001, d5.l = end of ST-RAM (phystop)
memconf:
        move.b  #$a,$ffff8001.w         ; 2 banks of 2 MB

        movea.w #$0008,a0               ; test pattern in bank 0
        lea     $200008,a1              ;  and bank 1
        moveq   #0,d0
init_pattern_loop:
        move.w  d0,(a0)+
        move.w  d0,(a1)+
        add.w   #$fa54,d0
        cmpa.l  #$200,a0
        bne.s   init_pattern_loop

        move.l  #$200000,d1             ; begin with bank 1
        moveq   #0,d5
        moveq   #0,d6

test_128k:
        lsr.w   #2,d6
        move.l  #$20000,d4              ; 128 KB bank
        movea.l #$40008,a0              ; STE
        lea     test_128k_st(pc),a5
        bra     check_test_pattern
test_128k_st:
        beq     bank_test_end
        movea.w #$208,a0                ; ST
        lea     test_512k(pc),a5
        bra     check_test_pattern

test_512k:
        beq     bank_test_end
        move.l  #$80000,d4              ; 512 KB bank
        movea.l #$80008,a0              ; STE
        lea     test_512k_st(pc),a5
        bra     check_test_pattern
test_512k_st:
        beq     bank_test_end_512k
        movea.w #$408,a0                ; ST
        lea     test_2m(pc),a5
        bra     check_test_pattern

test_2m:
        beq     bank_test_end_512k
        movea.w #$008,a0                ; 2 MB or nothing
        lea     last_return(pc),a5
        moveq   #0,d4
        bra     check_test_pattern
last_return:
        bne.s   bank_test_end           ; no RAM in this bank
        move.l  #$200000,d4
        addq.w  #4,d6
bank_test_end_512k:
        addq.w  #4,d6
bank_test_end:
        add.l   d4,d5
        sub.l   #$200000,d1
        beq     test_128k               ; now bank 0

        move.b  d6,$ffff8001.w

; Emulators may not mirror banks: make sure the top of RAM is writable
        move.l  #$ff0055aa,d0
mem_sanity_loop:
        move.l  d5,a0
        subq.l  #4,a0
        move.l  d0,(a0)
        cmp.l   (a0),d0
        beq.s   mem_sanity_done
        sub.l   #512*1024,d5
        bra.s   mem_sanity_loop
mem_sanity_done:

; Cold boot: clear the system variables and low RAM, then mark it valid
        lea     clear_beg.w,a0
        move.l  #clear_end,a1
        moveq   #0,d0
clear_loop:
        move.l  d0,(a0)+
        move.l  d0,(a0)+
        move.l  d0,(a0)+
        move.l  d0,(a0)+
        cmpa.l  a1,a0
        bcs.s   clear_loop

        move.b  d6,memctrl.w
        move.l  d5,phystop.w
        move.l  #$752019f3,memvalid.w
        move.l  #$237698aa,memval2.w
        move.l  #$5555aaaa,memval3.w
        bra.s   memdone

; In:  d1 = bank base, a0 = test offset, a5 = return address
; Out: Z set if the whole pattern is found
check_test_pattern:
        adda.l  d1,a0
        moveq   #0,d0
        lea     $1f8(a0),a1
check_test_pattern_loop:
        cmp.w   (a0)+,d0
        bne.s   end_check_test_pattern
        add.w   #$fa54,d0
        cmpa.l  a0,a1
        bne.s   check_test_pattern_loop
end_check_test_pattern:
        jmp     (a5)

; ==== hand over to the kernel ==============================================
memdone:
        move.l  os_sum(pc),os_chksum.w
        clr.l   _hz_200.w
        move.l  kernel_go(pc),a0
        jmp     (a0)

        cnop    0,4
os_sum:
        dc.l    0
kernel_go:
        dc.l    0
