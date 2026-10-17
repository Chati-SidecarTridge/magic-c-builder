// Help texts for the ? icons, keyed by data-help-key. Author-controlled
// HTML, rendered with innerHTML.

export const HELP_CONTENT = {
  release: {
    title: 'Step 1. MagiC release',
    html: `
      <p>The builder starts from an official <em>MagiC for Atari</em> release by Andreas Kromke: the
      <code>Atari-MagiC-YYYY-MM-DD.zip</code> files in <code>MagiC/Releases/</code> of his GitLab repository.
      A copy of the latest one is bundled with this page.</p>
      <p>To use another release, pick <em>My own</em> and drop its ZIP. The archive must hold the
      <code>MAGIC.A</code> tree with <code>LANG/EN</code>, <code>LANG/DE</code> and <code>LANG/FR</code>.
      Nothing is uploaded: the file is read by your browser.</p>
    `,
  },

  options: {
    title: 'Step 2. Options',
    html: `
      <h4>Language</h4>
      <p>Picks the kernel (<code>LANG/xx/MAGIC.RAM</code>) and localises the desktop files the same way the
      release's <code>LANG/xx.BAT</code> does. The command line help files are German in every language,
      as in the release.</p>
      <h4>Boot from</h4>
      <p>MagiC loads its screen drivers, <code>MAGX.INF</code> and its desktop from a system drive. The ROM
      has that drive built in, so the choice here decides both the ROM and the files that go with it.</p>
    `,
  },

  target: {
    title: 'Boot from',
    html: `
      <h4>Floppy, system on A:</h4>
      <p>You get the ROM and a 720&nbsp;KB <code>.ST</code> floppy image with the files MagiC needs to reach its
      desktop: screen drivers for ST low, medium and high resolution, the desktop and its tools. No hard disk
      is needed. Write the image to a floppy, or use it in a floppy emulator or in Hatari.</p>
      <h4>Hard disk, system on C:</h4>
      <p>You get the ROM and a ZIP with the full MagiC tree for the root of drive <code>C:</code>
      (accessories, command line tools, extras). Your hard disk driver must boot from <code>C:</code> so that
      MagiC finds <code>C:\\MAGX.INF</code>.</p>
    `,
  },

  install: {
    title: 'Using the ROM',
    html: `
      <h4>SidecarTridge TOS Emulator</h4>
      <p>Copy the <code>.img</code> file to the emulator's USB drive and select it as you would any TOS image.
      MagiC needs the 256&nbsp;KB ROM space at <code>$E00000</code>: STE and Mega STE have it, an ST or
      Mega ST needs the <a href="https://sidecartridge.com/products/sidecartridge-256kb-decoder-atari-st/" target="_blank" rel="noopener">SidecarTridge 256&nbsp;KB Decoder</a>.</p>
      <h4>Floppy</h4>
      <p>Insert the boot floppy in drive A: and switch on. MagiC reads <code>A:\\MAGX.INF</code> and starts
      its desktop from <code>A:\\GEMSYS\\GEMDESK</code>.</p>
      <h4>Hard disk</h4>
      <p>Unpack the ZIP to the root of <code>C:</code>, keeping its folders. A boot from the hard disk driver
      (AHDI, ICD, HDDRIVER...) then starts MagiC from <code>C:</code>. The accessories in
      <code>C:\\AUTO\\ACCS</code> include a clock panel that asks for the date on machines without a clock.</p>
      <h4>Hatari</h4>
      <p>Select the <code>.img</code> as TOS image (machine STE, fast boot off) and the floppy as drive A:.
      Hatari's GEMDOS drive does not boot, so use the floppy target, or an ACSI image with a driver for the
      hard disk target.</p>
    `,
  },
};
