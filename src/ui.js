// MagiC ROM Builder UI: the four-step accordion (release, options, build,
// download). src/package.js does the work; this file is DOM glue.

import { buildPackage } from './package.js';
import { formatLogHtml } from './log-format.js';
import { ROMBOOT } from './romboot-stub.js';
import { HELP_CONTENT } from './help-content.js';

const BUNDLED_RELEASE = 'assets/Atari-MagiC-2026-10-17.zip';

const INSTALL_HINTS = {
  floppy: 'Select the .img in the TOS Emulator (or as TOS in Hatari, machine STE) and boot with the .st floppy in drive A:.',
  harddisk: 'Select the .img in the TOS Emulator and unpack the ZIP to the root of your boot drive C:.',
};

if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', initUi);
}

function initUi() {
  if (!featureCheck()) return;
  const state = {
    source: 'bundled',
    upload: null,       // { name, bytes }
    outputs: null,      // [{ name, data, kind }]
    blobUrls: [],
    building: false,
  };
  document.getElementById('bundledName').textContent = BUNDLED_RELEASE.split('/').pop();
  wireStep1(state);
  wireStep2(state);
  document.getElementById('buildBtn').addEventListener('click', () => doBuild(state));
  document.getElementById('resetBtn').addEventListener('click', () => invalidateBuild(state, true));
  wireLogToggle();
  wireHelpModal();
  refresh(state);
}

function featureCheck() {
  const ok = typeof File !== 'undefined' && typeof Blob !== 'undefined'
    && typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function'
    && typeof DecompressionStream !== 'undefined';
  if (!ok) document.getElementById('browserWarning').style.display = 'block';
  return ok;
}

// ----- help modal -----

function wireHelpModal() {
  const dialog = document.getElementById('helpModal');
  dialog.querySelector('.modal-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) dialog.close();
  });
  document.getElementById('app').addEventListener('click', (e) => {
    const btn = e.target.closest && e.target.closest('.help-icon[data-help-key]');
    if (!btn) return;
    const entry = HELP_CONTENT[btn.dataset.helpKey];
    if (!entry) return;
    document.getElementById('helpModalTitle').textContent = entry.title;
    document.getElementById('helpModalBody').innerHTML = entry.html;
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
  });
}

// ----- Step 1: release source -----

function wireStep1(state) {
  for (const radio of document.querySelectorAll('input[name="source"]')) {
    radio.addEventListener('change', () => {
      state.source = radio.value;
      invalidateBuild(state, false);
      refresh(state);
    });
  }
  const drop = document.getElementById('dropZone');
  const input = document.getElementById('fileInput');
  input.addEventListener('change', () => {
    if (input.files.length) takeUpload(state, input.files[0]);
    input.value = '';
  });
  drop.addEventListener('dragover', (e) => {
    e.preventDefault();
    drop.classList.add('drag-active');
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('drag-active'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('drag-active');
    if (e.dataTransfer.files.length) takeUpload(state, e.dataTransfer.files[0]);
  });
}

async function takeUpload(state, file) {
  state.upload = { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) };
  invalidateBuild(state, false);
  refresh(state);
}

// ----- Step 2: options -----

function wireStep2(state) {
  for (const radio of document.querySelectorAll('input[name="lang"], input[name="target"]')) {
    radio.addEventListener('change', () => {
      invalidateBuild(state, false);
      refresh(state);
    });
  }
}

function selected(name) {
  return document.querySelector(`input[name="${name}"]:checked`).value;
}

// ----- Step 3: build -----

async function releaseBytes(state, t0) {
  if (state.source === 'upload') {
    appendLog({ kind: 'info', text: `Using ${state.upload.name} (${state.upload.bytes.length.toLocaleString('en-US')} bytes) from your computer.`, at: performance.now() - t0 });
    return state.upload.bytes;
  }
  appendLog({ kind: 'info', text: `Fetching the bundled release ${BUNDLED_RELEASE}...`, at: performance.now() - t0 });
  const resp = await fetch(BUNDLED_RELEASE);
  if (!resp.ok) throw new Error(`Could not fetch the bundled release (HTTP ${resp.status}).`);
  const bytes = new Uint8Array(await resp.arrayBuffer());
  appendLog({ kind: 'info', text: `Fetched ${bytes.length.toLocaleString('en-US')} bytes.`, at: performance.now() - t0 });
  return bytes;
}

async function doBuild(state) {
  clearLog();
  setProgress(0);
  state.building = true;
  refresh(state);
  const lang = selected('lang');
  const target = selected('target');
  const t0 = performance.now();
  try {
    const bytes = await releaseBytes(state, t0);
    setProgress(30);
    let steps = 0;
    const log = (entry) => {
      appendLog(entry);
      if (entry.kind === 'step') setProgress(Math.min(95, 30 + 6 * ++steps));
    };
    const result = await buildPackage(bytes, { lang, target, stub: ROMBOOT, log, t0 });
    state.outputs = result.outputs;
    setProgress(100);
    showDownloads(state, target);
  } catch (err) {
    appendLog({ kind: 'error', text: `Build failed: ${err.message}`, at: performance.now() - t0 });
    state.outputs = null;
    setProgress(0);
  }
  state.building = false;
  refresh(state);
}

function clearLog() {
  document.getElementById('log').textContent = '';
}

function appendLog(entry) {
  const log = document.getElementById('log');
  log.insertAdjacentHTML('beforeend', formatLogHtml(entry));
  log.scrollTop = log.scrollHeight;
}

function setProgress(pct) {
  document.getElementById('prog').value = pct;
  document.getElementById('progLabel').textContent = `${pct}%`;
}

// ----- Step 4: downloads -----

const KIND_LABEL = {
  rom: 'ROM image',
  floppy: 'Boot floppy (720 KB .ST)',
  zip: 'Files for drive C: (ZIP)',
};

function showDownloads(state, target) {
  const box = document.getElementById('downloads');
  box.textContent = '';
  for (const out of state.outputs) {
    const url = URL.createObjectURL(new Blob([out.data], { type: 'application/octet-stream' }));
    state.blobUrls.push(url);
    const row = document.createElement('div');
    row.style.margin = '6px 0';
    const link = document.createElement('a');
    link.href = url;
    link.download = out.name;
    link.textContent = `Download ${out.name}`;
    link.style.cssText = 'display:inline-block; padding:8px 14px; border-radius:6px; background:#fde047; color:#111827; font-weight:600; text-decoration:none;';
    const label = document.createElement('span');
    label.className = 'hint';
    label.style.marginLeft = '12px';
    label.textContent = `${KIND_LABEL[out.kind]}, ${out.data.length.toLocaleString()} bytes`;
    row.append(link, label);
    box.append(row);
  }
  document.getElementById('installHint').textContent = INSTALL_HINTS[target];
}

function invalidateBuild(state, clear) {
  for (const url of state.blobUrls) URL.revokeObjectURL(url);
  state.blobUrls = [];
  state.outputs = null;
  document.getElementById('downloads').textContent = '';
  document.getElementById('installHint').textContent = '';
  setProgress(0);
  if (clear) clearLog();
  refresh(state);
}

// ----- log pane toggle -----

function wireLogToggle() {
  const btn = document.getElementById('toggleLog');
  const log = document.getElementById('log');
  btn.addEventListener('click', () => {
    const showing = log.style.display !== 'none';
    log.style.display = showing ? 'none' : '';
    btn.textContent = showing ? 'Show process output' : 'Hide process output';
  });
}

// ----- step gating -----

function refresh(state) {
  const haveRelease = state.source === 'bundled' || state.upload !== null;
  const built = state.outputs !== null;
  document.getElementById('dropZone').style.display = state.source === 'upload' ? '' : 'none';
  document.getElementById('step1Hint').textContent = state.source === 'bundled'
    ? 'Uses the release bundled with this page.'
    : (state.upload ? `Loaded ${state.upload.name} (${state.upload.bytes.length.toLocaleString()} bytes).` : 'No release loaded yet.');
  setStep('step1', haveRelease ? 'complete' : 'active');
  setStep('step2', haveRelease ? 'complete' : 'pending');
  setStep('step3', !haveRelease ? 'pending' : (built ? 'complete' : 'active'));
  setStep('step4', built ? 'active' : 'pending');
  document.getElementById('buildBtn').disabled = !haveRelease || built || state.building;
}

function setStep(id, mode) {
  const li = document.getElementById(id);
  li.classList.remove('active', 'complete');
  if (mode === 'active' || mode === 'complete') li.classList.add(mode);
  li.querySelector('.step-status').textContent =
    mode === 'active' ? 'Ready' : mode === 'complete' ? 'Done' : 'Pending';
}
