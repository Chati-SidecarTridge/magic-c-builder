// From an Atari MagiC release (the MAGIC.A tree of Atari-MagiC-*.zip),
// produce the localised kernel and the file sets that go with the ROM:
// a minimal boot floppy (system drive A:) and the full hard disk tree
// (system drive C:).

export const LANGUAGES = [
  { code: 'EN', name: 'English' },
  { code: 'DE', name: 'Deutsch' },
  { code: 'FR', name: 'Fran\u00e7ais' },
];

// What LANG/<code>.BAT copies over the root tree. The German help files
// are used for every language: no translation exists.
const LOCALISE_RULES = [
  { dir: 'EXTRAS', ext: ['INF', 'ACC'] },
  { dir: 'EXTRAS/AES_LUPE', ext: ['TXT'] },
  { dir: 'GEMSYS/GEMDESK', ext: ['RSC', 'TXT', 'TOS'] },
  { dir: 'GEMSYS/GEMDESK/HELP', ext: ['HLP'], from: 'DE' },
  { dir: 'GEMSYS/MAGIC/XTENSION', ext: ['SYS', 'SLB'] },
];

// Files that only make sense for a RAM-loaded MagiC, left out next to a ROM.
const RAM_ONLY = ['AUTO/MAGXBOOT.TOS', 'AUTO/MAGXBOOT.PRG', 'MAGIC.RAM'];

// The boot floppy: what MagiC needs to reach its desktop on ST/STE video
// (2, 4 and 16 colour drivers), plus the small desktop tools.
const FLOPPY_FILES = [
  'MAGX.INF',
  'GEMSYS/MFA2.SYS', 'GEMSYS/MFA4.SYS', 'GEMSYS/MFA16.SYS',
  'GEMSYS/OFF002.OSD', 'GEMSYS/OFF004IP.OSD', 'GEMSYS/OFF016IP.OSD',
  'GEMSYS/MAGIC/XTENSION/*.SLB', 'GEMSYS/MAGIC/XTENSION/*.SYS',
  'GEMSYS/MAGIC/XTENSION/*.RSC', 'GEMSYS/MAGIC/XTENSION/*.DEV',
  'GEMSYS/MAGIC/START/*',
  'GEMSYS/GEMDESK/MAGXDESK.APP', 'GEMSYS/GEMDESK/MAGXDESK.RSC', 'GEMSYS/GEMDESK/MAGXDESL.RSC',
  'GEMSYS/GEMDESK/RSC/MAGICICN.RSC',
  'GEMSYS/GEMDESK/VT52.PRG', 'GEMSYS/GEMDESK/VT52.RSC', 'GEMSYS/GEMDESK/MCMD.TOS',
  'GEMSYS/GEMDESK/CHGRES.PRG', 'GEMSYS/GEMDESK/CHGRES.RSC',
  'GEMSYS/GEMDESK/SHUTDOWN.PRG', 'GEMSYS/GEMDESK/SHUTDOWN.INF',
  'GEMSYS/GEMDESK/MGEDIT.APP', 'GEMSYS/GEMDESK/MGEDIT.RSC',
  'GEMSYS/GEMDESK/MGVIEW.APP',
  'GEMSYS/GEMDESK/MGCOPY.APP', 'GEMSYS/GEMDESK/MGCOPY.RSC',
  'GEMSYS/GEMDESK/MGFORMAT.PRG', 'GEMSYS/GEMDESK/MGFORMAT.RSC',
  'GEMSYS/GEMDESK/MGSEARCH.APP', 'GEMSYS/GEMDESK/MGSEARCH.RSC',
  'GEMSYS/GEMDESK/PAT/16/*',
  'GEMSYS/GEMSCRAP/*',
  'GEMSYS/HOME/*',
];

function extOf(path) {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot + 1).toUpperCase();
}

function dirOf(path) {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? '' : path.slice(0, slash);
}

// Map keys from readZip() -> Map of paths relative to MAGIC.A, upper case.
export function releaseTree(zipFiles) {
  let prefix = null;
  for (const path of zipFiles.keys()) {
    const m = /^(.*?)LANG\/EN\/MAGIC\.RAM$/i.exec(path);
    if (m) {
      prefix = m[1];
      break;
    }
  }
  if (prefix === null) {
    throw new Error('This does not look like an Atari MagiC release: LANG/EN/MAGIC.RAM is missing.');
  }
  const tree = new Map();
  for (const [path, data] of zipFiles) {
    if (!path.toUpperCase().startsWith(prefix.toUpperCase())) continue;
    const rel = path.slice(prefix.length).toUpperCase();
    if (rel.endsWith('.DS_STORE') || rel.startsWith('__MACOSX/')) continue;
    tree.set(rel, data);
  }
  return tree;
}

export function kernelFor(tree, lang) {
  const kernel = tree.get(`LANG/${lang}/MAGIC.RAM`);
  if (!kernel) throw new Error(`The release has no ${lang} kernel (LANG/${lang}/MAGIC.RAM).`);
  return kernel;
}

// The root tree as LANG/<lang>.BAT leaves it, without LANG/ and the files
// a ROM does not need. `report`, when given, receives what each rule did.
export function localisedTree(tree, lang, report = null) {
  const out = new Map();
  const dropped = [];
  for (const [path, data] of tree) {
    if (path.startsWith('LANG/')) continue;
    if (RAM_ONLY.includes(path)) {
      dropped.push(path);
      continue;
    }
    out.set(path, data);
  }
  const rules = [];
  for (const rule of LOCALISE_RULES) {
    const from = rule.from || lang;
    const src = `LANG/${from}/${rule.dir}/`;
    let count = 0;
    for (const [path, data] of tree) {
      if (!path.startsWith(src) || path.slice(src.length).includes('/')) continue;
      if (!rule.ext.includes(extOf(path))) continue;
      out.set(rule.dir + '/' + path.slice(src.length), data);
      count++;
    }
    rules.push({ dir: rule.dir, ext: rule.ext, from, count });
  }
  if (report) Object.assign(report, { rules, dropped });
  return out;
}

function matches(pattern, path) {
  if (pattern.endsWith('/*')) {
    return dirOf(path) === pattern.slice(0, -2);
  }
  if (pattern.includes('*.')) {
    const [dir, ext] = pattern.split('/*.');
    return dirOf(path) === dir && extOf(path) === ext;
  }
  return pattern === path;
}

// Point every C:\ path in MAGX.INF at another drive (keeps CR/LF).
export function retargetInf(data, drive) {
  const text = new TextDecoder('latin1').decode(data);
  const out = text.replace(/\b[Cc]:\\/g, `${drive}:\\`);
  return Uint8Array.from(out, (ch) => ch.charCodeAt(0));
}

export function countDrivePaths(data, drive) {
  const text = new TextDecoder('latin1').decode(data);
  return (text.match(new RegExp(`\\b${drive}:\\\\`, 'gi')) || []).length;
}

function sorted(map) {
  return [...map.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([path, data]) => ({ path, data }));
}

export function floppyFiles(localised) {
  const picked = new Map();
  for (const [path, data] of localised) {
    if (FLOPPY_FILES.some((p) => matches(p, path))) picked.set(path, data);
  }
  if (!picked.has('MAGX.INF')) throw new Error('The release has no MAGX.INF.');
  picked.set('MAGX.INF', retargetInf(picked.get('MAGX.INF'), 'A'));
  return sorted(picked);
}

export function hardDiskFiles(localised) {
  return sorted(localised);
}
