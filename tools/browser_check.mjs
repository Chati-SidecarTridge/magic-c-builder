#!/usr/bin/env node
// End-to-end check of the published page in headless Chrome: serve the repo
// over HTTP, click Build for each language and target, and compare the
// SHA-256 of every download with the files tools/mkall.mjs wrote to OUTDIR.
// The page is loaded from the Mac's LAN address, not localhost: plain HTTP
// on a LAN address is an insecure origin (no crypto.subtle...), like a
// phone or tablet on the local network sees it.
//
//   tools/browser_check.mjs OUTDIR [EN DE FR]
//
// Needs Google Chrome and Node 22+ (built-in WebSocket).
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir, networkInterfaces } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const HTTP_PORT = 8765;
const CDP_PORT = 9333;
const [, , outDir, ...langArgs] = process.argv;
if (!outDir) {
  console.error('usage: tools/browser_check.mjs OUTDIR [EN DE FR]');
  process.exit(2);
}
const langs = langArgs.length ? langArgs : ['EN'];

const LAN_IP = Object.values(networkInterfaces()).flat()
  .find((a) => a && a.family === 'IPv4' && !a.internal)?.address || '127.0.0.1';
const PAGE = `http://${LAN_IP}:${HTTP_PORT}/index.html`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, what, ms = 15000) {
  const end = Date.now() + ms;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {
      // not up yet
    }
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(200);
  }
}

const server = spawn('python3', ['-m', 'http.server', String(HTTP_PORT), '--bind', LAN_IP], { cwd: ROOT, stdio: 'ignore' });
const profile = mkdtempSync(join(tmpdir(), 'mcb-chrome-'));
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore' });

let failed = false;
try {
  await waitFor(() => fetch(PAGE).then((r) => r.ok), 'the HTTP server');
  console.log(`page: ${PAGE}`);
  const target = await waitFor(() => fetch(`http://127.0.0.1:${CDP_PORT}/json/new?about:blank`, { method: 'PUT' }).then((r) => r.json()), 'Chrome');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  let nextId = 1;
  const pending = new Map();
  const consoleLines = [];
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    } else if (msg.method === 'Runtime.exceptionThrown') {
      consoleLines.push(`exception: ${msg.params.exceptionDetails.text} ${msg.params.exceptionDetails.exception?.description || ''}`);
    } else if (msg.method === 'Runtime.consoleAPICalled') {
      consoleLines.push(`console.${msg.params.type}: ${msg.params.args.map((a) => a.value ?? a.description).join(' ')}`);
    }
  };
  const send = (method, params = {}) => new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text);
    return r.result.result.value;
  };

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.navigate', { url: PAGE });
  await waitFor(() => evaluate("document.readyState === 'complete' && !!document.getElementById('buildBtn')"), 'the page');

  for (const lang of langs) {
    for (const tgt of ['floppy', 'harddisk']) {
      const result = await evaluate(`(async () => {
        document.getElementById('resetBtn').click();
        document.querySelector('input[name=lang][value=${lang}]').click();
        document.querySelector('input[name=target][value=${tgt}]').click();
        const btn = document.getElementById('buildBtn');
        if (btn.disabled) throw new Error('Build button is disabled');
        btn.click();
        const end = Date.now() + 60000;
        while (document.querySelectorAll('#downloads a').length < 2) {
          if (document.getElementById('log').textContent.includes('Build failed')) throw new Error(document.getElementById('log').textContent);
          if (Date.now() > end) throw new Error('no downloads after 60 s');
          await new Promise((r) => setTimeout(r, 100));
        }
        const out = [];
        for (const a of document.querySelectorAll('#downloads a')) {
          const buf = new Uint8Array(await (await fetch(a.href)).arrayBuffer());
          let bin = '';
          for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
          out.push({ name: a.download, b64: btoa(bin) });
        }
        return { secure: window.isSecureContext, files: out };
      })()`);
      if (lang === langs[0] && tgt === 'floppy') console.log(`secure context: ${result.secure}`);
      for (const { name, b64 } of result.files) {
        const sha = createHash('sha256').update(Buffer.from(b64, 'base64')).digest('hex');
        const expected = createHash('sha256').update(readFileSync(join(outDir, name))).digest('hex');
        const ok = sha === expected;
        if (!ok) failed = true;
        console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${sha.slice(0, 16)}${ok ? '' : ` (CLI ${expected.slice(0, 16)})`}`);
      }
    }
  }
  if (process.env.SHOT) {
    // Show the whole log, then capture the full page.
    await evaluate("document.getElementById('log').style.height = 'auto'");
    const { layoutViewport, contentSize } = (await send('Page.getLayoutMetrics')).result;
    const shot = await send('Page.captureScreenshot', {
      format: 'png', captureBeyondViewport: true,
      clip: { x: 0, y: 0, width: layoutViewport.clientWidth, height: contentSize.height, scale: 1 },
    });
    (await import('node:fs')).writeFileSync(process.env.SHOT, Buffer.from(shot.result.data, 'base64'));
    console.log(`screenshot: ${process.env.SHOT}`);
  }
  for (const line of consoleLines) console.log(line);
  ws.close();
} catch (err) {
  failed = true;
  console.error(`browser check failed: ${err.message}`);
} finally {
  chrome.kill();
  server.kill();
  await sleep(300);
  rmSync(profile, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
