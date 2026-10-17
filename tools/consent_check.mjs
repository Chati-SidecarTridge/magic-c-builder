#!/usr/bin/env node
// Check the cookie banner and the consent-gated analytics in headless Chrome.
//
//   tools/consent_check.mjs [SCREENSHOT.png]
//
// The repo is served locally and opened under sidecartridge.com host names
// (Chrome's host resolver maps them to 127.0.0.1) and under the LAN address.
// Google's hosts are mapped to a dead port, so no hit ever leaves the
// machine: the check only looks at whether the page tries to reach them.
//
// The main site is simulated with its own banner include, unchanged, from
// the sibling ../sidecartridge-website (_includes/framework/cookie-consent.html),
// to prove that a choice made on one site is honoured on the other.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir, networkInterfaces } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WEBSITE = join(ROOT, '..', 'sidecartridge-website');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const HTTP_PORT = 8768;
const CDP_PORT = 9334;
const LAN_IP = Object.values(networkInterfaces()).flat()
  .find((a) => a && a.family === 'IPv4' && !a.internal)?.address || '127.0.0.1';
const MAGIC = `http://magic.sidecartridge.com:${HTTP_PORT}/index.html`;
const MAIN = `http://sidecartridge.com:${HTTP_PORT}/out/consent-sim/main.html`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, what, ms = 15000) {
  const end = Date.now() + ms;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {
      // not ready
    }
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(200);
  }
}

// A page with the main site's banner include as Jekyll renders it.
function writeMainSim() {
  const include = join(WEBSITE, '_includes', 'framework', 'cookie-consent.html');
  if (!existsSync(include)) return false;
  const body = readFileSync(include, 'utf8')
    .replace("{{ '/assets/css/cookieconsent.css' | relative_url }}", '/src/vendor/cookieconsent.css')
    .replace("{{ '/assets/js/cookieconsent.js' | relative_url }}", '/src/vendor/cookieconsent.js');
  mkdirSync(join(ROOT, 'out', 'consent-sim'), { recursive: true });
  writeFileSync(join(ROOT, 'out', 'consent-sim', 'main.html'),
    `<!DOCTYPE html><html><head><meta charset="utf-8"><title>main site simulation</title>${body}</head><body><h1>sidecartridge.com</h1></body></html>\n`);
  return true;
}

const server = spawn('python3', ['-m', 'http.server', String(HTTP_PORT), '--bind', '0.0.0.0'], { cwd: ROOT, stdio: 'ignore' });
const profile = mkdtempSync(join(tmpdir(), 'mcb-consent-'));
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--window-size=1200,900',
  '--host-resolver-rules=MAP sidecartridge.com 127.0.0.1, MAP magic.sidecartridge.com 127.0.0.1, '
    + 'MAP *.google-analytics.com 127.0.0.1:9, MAP www.googletagmanager.com 127.0.0.1:9, MAP *.google.com 127.0.0.1:9',
  'about:blank'], { stdio: 'ignore' });

let failed = false;
const check = (ok, what) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${what}`);
  if (!ok) failed = true;
};

let browser;

async function cdp() {
  const target = await waitFor(() => fetch(`http://127.0.0.1:${CDP_PORT}/json/new?about:blank`, { method: 'PUT' }).then((r) => r.json()), 'Chrome');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  let nextId = 1;
  const pending = new Map();
  const google = [];
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    } else if (msg.method === 'Network.requestWillBeSent' && /google/.test(msg.params.request.url)) {
      google.push(msg.params.request.url);
    }
  };
  const send = (method, params = {}) => new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result.result.value;
  await send('Network.enable');
  await send('Page.enable');
  return { ws, send, evaluate, google };
}

// Open url in a fresh tab; report whether the banner appears; optionally
// accept all; return the Google requests seen and the cookies.
async function visit(url, { accept = false, shot = null } = {}) {
  const tab = await cdp();
  browser = tab;
  await tab.send('Page.navigate', { url });
  await waitFor(() => tab.evaluate("document.readyState === 'complete'"), url);
  let banner = false;
  try {
    await waitFor(() => tab.evaluate("!!document.getElementById('cm') && getComputedStyle(document.getElementById('cm')).visibility === 'visible'"), 'the banner', 4000);
    banner = true;
  } catch {
    banner = false;
  }
  if (shot) {
    await sleep(500);
    const r = await tab.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(shot, Buffer.from(r.result.data, 'base64'));
    console.log(`screenshot: ${shot}`);
  }
  await sleep(800);
  const before = [...tab.google];
  if (accept) {
    await tab.evaluate("document.getElementById('c-p-bn').click()");
    await sleep(1500);
  }
  const cookies = (await tab.send('Network.getCookies', { urls: [url] })).result.cookies.filter((c) => c.name === 'cc_cookie');
  tab.ws.close();
  return { banner, before, after: tab.google, cookies };
}

async function clearCookies() {
  const tab = await cdp();
  await tab.send('Network.clearBrowserCookies');
  tab.ws.close();
}

try {
  await waitFor(() => fetch(`http://127.0.0.1:${HTTP_PORT}/index.html`).then((r) => r.ok), 'the HTTP server');

  // The MagiC page on its own.
  let v = await visit(MAGIC, { accept: true, shot: process.argv[2] });
  check(v.banner, 'MagiC page: banner on first visit');
  check(v.before.length === 0, 'MagiC page: nothing sent to Google before consent');
  check(v.after.some((u) => u.includes('googletagmanager.com/gtag/js?id=G-6VT9RXTJ2N')), 'MagiC page: gtag requested after Accept all');
  check(v.cookies.length === 1 && v.cookies[0].domain === '.sidecartridge.com', `MagiC page: consent stored for .sidecartridge.com (${v.cookies.map((c) => c.domain).join(', ')})`);

  await clearCookies();
  v = await visit(`http://${LAN_IP}:${HTTP_PORT}/index.html`, { accept: true });
  check(v.banner, `${LAN_IP}: banner on first visit`);
  check(v.after.length === 0, `${LAN_IP}: no Google requests even after Accept all`);

  if (writeMainSim()) {
    // Main site first, then the MagiC page.
    await clearCookies();
    v = await visit(MAIN, { accept: true });
    check(v.banner, 'main site (its own include, unchanged): banner on first visit');
    check(v.cookies.length === 1 && v.cookies[0].domain === '.sidecartridge.com', `main site: consent stored for .sidecartridge.com (${v.cookies.map((c) => c.domain).join(', ')})`);
    v = await visit(MAGIC);
    check(!v.banner, 'MagiC page after accepting on the main site: no banner');
    check(v.before.some((u) => u.includes('gtag/js?id=G-6VT9RXTJ2N')), 'MagiC page after accepting on the main site: analytics run');

    // MagiC page first, then the main site.
    await clearCookies();
    v = await visit(MAGIC, { accept: true });
    v = await visit(MAIN);
    check(!v.banner, 'main site after accepting on the MagiC page: no banner');
    check(v.cookies.length === 1, 'main site: a single cc_cookie, no duplicate');
  } else {
    console.log(`SKIP cross-site checks: no ${WEBSITE}`);
  }
} catch (err) {
  failed = true;
  console.error(`consent check failed: ${err.message}`);
} finally {
  chrome.kill();
  server.kill();
  await sleep(300);
  rmSync(profile, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
