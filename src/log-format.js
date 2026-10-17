// Rendering of the build log. package.js emits structured entries; the page
// turns them into coloured HTML (formatLogHtml) and tools/mkall.mjs into
// terminal text (formatLogText), so both show the same narration.
//
// Entry kinds:
//   { kind: 'start', text }                  build banner
//   { kind: 'step', n, title, at }           numbered step, at = ms since start
//   { kind: 'say', text }                    explanation paragraph
//   { kind: 'item', text }                   bullet
//   { kind: 'table', headers, rows, align }  align: 'l' | 'r' per column
//   { kind: 'info' | 'ok' | 'error', text, at }

// Tokens worth a colour: quoted strings, $hex, paths and file names, sizes.
const TOKEN = new RegExp([
  '("[^"]*")',
  '(\\$[0-9A-F]{2,}\\b)',
  '((?:[A-Z]:)?\\\\?(?:[A-Za-z0-9_*?.{},-]+\\\\)+[A-Za-z0-9_*?.{},-]*'
    + '|\\b[A-Z][A-Z0-9_]*(?:\\/[A-Za-z0-9_*.{},-]+)+'
    + '|\\b[A-Za-z0-9_*-]+\\.(?:RAM|TOS|PRG|APP|SYS|OSD|INF|RSC|SLB|ACC|BAT|HLP|TXT|DEV|ST|st|img|zip|s)\\b)',
  '(\\b\\d[\\d,.]*\\s?(?:bytes|KB|MB|ms|s)\\b|\\b\\d{1,3}(?:,\\d{3})+\\b)',
].join('|'), 'g');
const TOKEN_KIND = ['str', 'hex', 'file', 'num'];

function tokens(text) {
  const out = [];
  let last = 0;
  for (const m of text.matchAll(TOKEN)) {
    if (m.index > last) out.push({ text: text.slice(last, m.index) });
    const group = m.slice(1).findIndex((g) => g !== undefined);
    out.push({ text: m[0], kind: TOKEN_KIND[group] });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

export function formatElapsed(ms) {
  return `+${(ms / 1000).toFixed(3)} s`;
}

// ----- HTML -----

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function richHtml(text) {
  return tokens(String(text)).map((t) => (t.kind ? `<span class="lg-${t.kind}">${esc(t.text)}</span>` : esc(t.text))).join('');
}

export function formatLogHtml(e) {
  switch (e.kind) {
    case 'start':
      return `<div class="lg-start">${richHtml(e.text)}</div>`;
    case 'step':
      return `<div class="lg-step"><span class="lg-time">${formatElapsed(e.at)}</span>`
        + `<span class="lg-n">${e.n}</span>${esc(e.title)}</div>`;
    case 'say':
      return `<div class="lg-say">${richHtml(e.text)}</div>`;
    case 'item':
      return `<div class="lg-item"><span class="lg-bullet">&#9656;</span>${richHtml(e.text)}</div>`;
    case 'table': {
      const align = (i) => ((e.align || [])[i] === 'r' ? ' class="r"' : '');
      const head = e.headers.map((h, i) => `<th${align(i)}>${esc(h)}</th>`).join('');
      const body = e.rows.map((r) => `<tr>${r.map((c, i) => `<td${align(i)}>${richHtml(c)}</td>`).join('')}</tr>`).join('');
      return `<table class="lg-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
    }
    default: {
      const time = e.at !== undefined ? `<span class="lg-time">${formatElapsed(e.at)}</span>` : '';
      return `<div class="lg-${e.kind}">${time}${richHtml(e.text)}</div>`;
    }
  }
}

// ----- terminal -----

const ANSI = {
  str: '\x1b[35m', hex: '\x1b[33m', file: '\x1b[32m', num: '\x1b[36m',
  time: '\x1b[2;36m', step: '\x1b[1;93m', dim: '\x1b[2m', ok: '\x1b[1;32m', error: '\x1b[1;31m',
  start: '\x1b[1;97m', bullet: '\x1b[33m', reset: '\x1b[0m',
};

function paint(color, text, on) {
  return on ? `${ANSI[color]}${text}${ANSI.reset}` : text;
}

function richText(text, on) {
  return tokens(String(text)).map((t) => (t.kind ? paint(t.kind, t.text, on) : t.text)).join('');
}

export function formatLogText(e, color = false) {
  switch (e.kind) {
    case 'start':
      return paint('start', e.text, color);
    case 'step':
      return `\n${paint('time', formatElapsed(e.at).padStart(10), color)}  ${paint('step', `${e.n}. ${e.title}`, color)}`;
    case 'say':
      return `            ${richText(e.text, color)}`;
    case 'item':
      return `            ${paint('bullet', '>', color)} ${richText(e.text, color)}`;
    case 'table': {
      const widths = e.headers.map((h, i) => Math.max(h.length, ...e.rows.map((r) => String(r[i]).length)));
      const cell = (c, i) => {
        const s = String(c);
        const pad = (e.align || [])[i] === 'r' ? s.padStart(widths[i]) : s.padEnd(widths[i]);
        return richText(pad, color);
      };
      const lines = [e.headers.map((h, i) => paint('dim', (e.align || [])[i] === 'r' ? h.padStart(widths[i]) : h.padEnd(widths[i]), color)).join('   ')];
      lines.push(paint('dim', widths.map((w) => '-'.repeat(w)).join('   '), color));
      for (const r of e.rows) lines.push(r.map(cell).join('   '));
      return lines.map((l) => `            ${l}`).join('\n');
    }
    default: {
      const time = e.at !== undefined ? `${paint('time', formatElapsed(e.at).padStart(10), color)}  ` : '';
      return `${time}${paint(e.kind === 'info' ? 'dim' : e.kind, e.text, color)}`;
    }
  }
}
