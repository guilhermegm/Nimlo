#!/usr/bin/env node
'use strict';

// Real release PTY + phone-browser regression for both-axis output retention.
// node scripts/resize-check.cjs
// Optional: NIMLO_BINARY, PLAYWRIGHT_PATH, NIMLO_WS_MODULE, CHROME_PATH.
// All commands run in a disposable fixture; no AI inference is requested.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { chromium } = require(process.env.PLAYWRIGHT_PATH || path.resolve(__dirname, '../../mini_gym/node_modules/playwright'));
const WebSocket = require(process.env.NIMLO_WS_MODULE || path.resolve(__dirname, '../../mini_gym/node_modules/ws'));
const repo = path.resolve(__dirname, '..');
const binary = path.resolve(process.env.NIMLO_BINARY || path.join(repo, 'target/release/nimlo-editor'));
let child, browser, socket, temp, token;
const checks = [];
const startedAt = new Date().toISOString();
let binarySha256;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, message) {
  const end = Date.now() + 10000;
  while (Date.now() < end) { if (await predicate()) return; await sleep(20); }
  throw new Error(message);
}
async function check(name, fn) {
  const started = Date.now();
  try {
    const evidence = await fn();
    checks.push({ name, status: 'pass', milliseconds: Date.now() - started, evidence });
    console.log(`PASS ${name}`);
  } catch (error) {
    checks.push({ name, status: 'fail', error: redact(error), milliseconds: Date.now() - started });
    throw error;
  }
}
function redact(error) {
  let message = error instanceof Error ? error.message : String(error);
  if (token) message = message.split(token).join('[REDACTED]');
  return message.replace(/([?#&](?:token|invite)=|nimlo_session=)[^\s;&]+/g, '$1[REDACTED]');
}
const text = lines => lines.map(line => line.runs.map(run => run.text).join('')).join('\n');
function inputModes(snapshot) {
  assert.equal(snapshot.bracketed_paste, true);
  assert.equal(snapshot.application_cursor, true);
  assert.equal(snapshot.application_keypad, true);
  assert.equal(snapshot.cursor.visible, false);
}

async function main() {
  binarySha256 = crypto.createHash('sha256').update(fs.readFileSync(binary)).digest('hex');
  temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nimlo-resize-'));
  const workspace = path.join(temp, 'workspace');
  fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace, 'note.txt'), 'Resize fixture.\n');
  child = spawn(binary, ['--workspace', workspace, '--state-dir', path.join(temp, 'state'), '--listen', '127.0.0.1:0'], {
    cwd: workspace, env: { ...process.env, SHELL: '/bin/sh' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const launchUrl = await new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error('Host startup timed out.')), 10000);
    child.on('error', reject);
    child.stdout.on('data', chunk => {
      output = (output + chunk.toString()).slice(-16384);
      const match = output.match(/http:\/\/[^\s]+\/#token=([a-zA-Z0-9_-]+)/);
      if (match) { token = match[1]; clearTimeout(timeout); resolve(match[0]); output = ''; }
    });
    child.stderr.on('data', () => {});
  });
  const origin = new URL(launchUrl).origin;
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await context.addInitScript(() => {
    const NativeWebSocket = window.WebSocket;
    window.__resizeSockets = [];
    window.__resizeState = {};
    window.WebSocket = class extends NativeWebSocket {
      constructor(...args) {
        super(...args);
        window.__resizeSockets.push(this);
        this.addEventListener('message', event => {
          const value = JSON.parse(event.data);
          if (value.type === 'bootstrap') window.__resizeState.clientId = value.clientId;
          if (value.type === 'bootstrap' || value.type === 'control') {
            window.__resizeState.controllerId = value.controllerId;
            window.__resizeState.generation = value.generation;
          }
        });
      }
    };
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(redact(error)));
  await page.goto(launchUrl);
  await page.waitForFunction(() => document.getElementById('app').dataset.connected === 'yes' && !document.getElementById('new-file').disabled);
  await page.click('#mobile-terminal');
  await page.waitForFunction(() => !document.getElementById('terminal-command').disabled);
  const cookie = (await context.cookies(origin)).find(value => value.name === 'nimlo_session');
  assert.ok(cookie);
  const cookieHeader = `nimlo_session=${cookie.value}`;
  socket = new WebSocket(origin.replace('http:', 'ws:') + '/ws?clientId=resize-fixture-controller', { headers: { Origin: origin, Cookie: cookieHeader } });
  const pending = new Map();
  let sequence = 0;
  let generation;
  socket.on('error', () => {});
  socket.on('message', bytes => {
    const value = JSON.parse(bytes.toString());
    if (value.generation !== undefined) generation = value.generation;
    const callback = pending.get(value.requestId);
    if (callback) { pending.delete(value.requestId); clearTimeout(callback.timer); callback.resolve(value); }
  });
  await until(() => socket.readyState === WebSocket.OPEN && generation !== undefined, 'Fixture WebSocket did not bootstrap.');
  function command(command) {
    const requestId = `resize-fixture-${++sequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`No response to ${command.type}.`)); }, 8000);
      pending.set(requestId, { resolve, timer });
      socket.send(JSON.stringify({ ...command, generation, requestId }));
    });
  }
  async function browserCommand(fields) {
    return page.evaluate(fields => new Promise((resolve, reject) => {
      const ws = window.__resizeSockets.at(-1), requestId = 'resize-browser-' + crypto.randomUUID();
      const listener = event => {
        const value = JSON.parse(event.data);
        if (value.requestId === requestId) { clearTimeout(timer); ws.removeEventListener('message', listener); resolve(value); }
      };
      const timer = setTimeout(() => { ws.removeEventListener('message', listener); reject(new Error('Browser fixture command timed out.')); }, 8000);
      ws.addEventListener('message', listener);
      ws.send(JSON.stringify({ ...fields, generation: window.__resizeState.generation, requestId }));
    }), fields);
  }
  const startingGeneration = generation;
  const ownership = await command({ type: 'claim_control' });
  assert.equal(ownership.type, 'control');
  assert.equal(ownership.generation, startingGeneration);
  await page.waitForFunction(() => window.__resizeState.controllerId === 'resize-fixture-controller');
  async function snapshot() {
    const response = await fetch(origin + '/api/bootstrap', { headers: { Cookie: cookieHeader }, signal: AbortSignal.timeout(8000) });
    assert.equal(response.status, 200);
    return (await response.json()).terminal;
  }
  async function retained() {
    const active = await snapshot();
    const history = await command({ type: 'terminal_history', limit: 200 });
    assert.equal(history.type, 'terminal_history');
    assert.ok(history.lines.length <= 200);
    return { active, history: history.lines, lines: [...history.lines, ...active.lines] };
  }
  async function resize(cols, rows) {
    const value = await command({ type: 'terminal_resize', cols, rows });
    assert.equal(value.type, 'terminal_state');
    assert.equal(value.terminal.cols, cols);
    assert.equal(value.terminal.rows, rows);
    return value.terminal;
  }
  async function run(data, marker, visible) {
    assert.equal((await command({ type: 'terminal_input', data: `${data}; printf done > ${marker}\r` })).type, 'ack');
    await until(() => fs.existsSync(path.join(workspace, marker)), 'Terminal fixture command did not complete.');
    if (visible) await until(async () => text((await snapshot()).lines).includes(visible), 'Fixture output did not reach the canonical screen.');
  }
  await check('passive phone resize preserves the active terminal viewport and phone access', async () => {
    await resize(80, 24);
    const passive = await browserCommand({ type: 'terminal_resize', cols: 42, rows: 28 });
    assert.equal(passive.type, 'ack');
    assert.equal(passive.ignored, true);
    const current = await snapshot();
    assert.deepEqual([current.cols, current.rows], [80, 24]);
    assert.equal(await page.locator('#terminal-command').isEnabled(), true);
    assert.equal(await page.locator('#new-file').isEnabled(), true);
    return { activeDimensions: [80, 24], passiveResizeIgnored: true, phoneWritable: true };
  });
  await check('focusing the phone terminal takes viewport ownership without a generation change', async () => {
    await page.locator('#files-toggle').focus();
    await page.locator('#terminal-command').focus();
    await page.waitForFunction(() => window.__resizeState.controllerId === window.__resizeState.clientId);
    assert.equal(await page.evaluate(() => window.__resizeState.generation), startingGeneration);
    const passive = await command({ type: 'terminal_resize', cols: 160, rows: 8 });
    assert.equal(passive.type, 'ack');
    assert.equal(passive.ignored, true);
    const returned = await command({ type: 'claim_control' });
    assert.equal(returned.type, 'control');
    assert.equal(returned.generation, startingGeneration);
    await page.waitForFunction(() => window.__resizeState.controllerId === 'resize-fixture-controller');
    return { automaticFocusOwnership: true, generationUnchanged: true, otherViewportResizeIgnored: true };
  });
  await run("stty -echo; PS1=''", 'ready');
  await resize(42, 28);
  await run("printf '\\033[2J\\033[H'; i=0; while [ \"$i\" -lt 24 ]; do printf '\\033[1;3;4;38;2;12;34;56mROW-%02d 界é\\033[0m\\r\\n' \"$i\"; i=$((i+1)); done; printf 'PHONE_DONE\\r\\n\\033[?2004h\\033[?1h\\033=\\033[?25l'", 'phone.done', 'PHONE_DONE');
  await check('real phone output exists before shrinking either axis', async () => {
    const before = await snapshot();
    for (let i = 0; i < 24; i++) assert.ok(text(before.lines).includes(`ROW-${String(i).padStart(2, '0')}`));
    inputModes(before);
    return { dimensions: [42, 28], retainedRows: 24, styledUnicode: true, inputModes: true };
  });
  await check('phone to desktop preserves pre-shrink output, styles, Unicode and input modes', async () => {
    const small = await resize(160, 8);
    const all = await retained();
    inputModes(small);
    for (let i = 0; i < 24; i++) assert.ok(text(all.lines).includes(`ROW-${String(i).padStart(2, '0')}`));
    for (const line of all.lines.filter(line => text([line]).includes('ROW-'))) {
      const wide = line.runs.find(run => run.text === '界');
      assert.ok(wide);
      assert.equal(wide.cols, 2);
      assert.equal(wide.fg, '#0c2238');
      assert.ok(wide.bold && wide.italic && wide.underline);
      assert.ok(line.runs.some(run => run.text === 'é'));
    }
    return { dimensions: [160, 8], retainedRows: 24, historyRows: all.history.length, styledUnicode: true, inputModes: true };
  });
  await run("printf '\\033[2;121H\\033[1;3;4;38;2;50;60;70mWIDE_KEEP_界é\\033[0m\\033[8;1HPROMPT_KEPT'", 'wide.done', 'WIDE_KEEP_');
  await check('desktop to phone preserves output beyond the new 42-column width', async () => {
    const phone = await resize(42, 28);
    inputModes(phone);
    const all = await retained();
    const wideLine = all.history.find(line => text([line]).includes('WIDE_KEEP_'));
    assert.ok(wideLine);
    const wide = wideLine.runs.find(run => run.text === '界' && run.col > 42);
    assert.ok(wide);
    assert.equal(wide.cols, 2);
    assert.equal(wide.fg, '#323c46');
    assert.ok(wide.bold && wide.italic && wide.underline);
    assert.ok(wideLine.runs.some(run => run.text === 'é'));
    for (let i = 0; i < 24; i++) assert.ok(text(all.lines).includes(`ROW-${String(i).padStart(2, '0')}`));
    return { dimensions: [42, 28], sentinelOriginalColumn: 120, styledUnicode: true, inputModes: true, historyRows: all.history.length };
  });
  await check('actual phone browser exposes archived wide output with horizontal scrolling', async () => {
    await until(async () => page.evaluate(() => document.getElementById('terminal-screen').textContent.includes('WIDE_KEEP_')), 'Phone did not render wide archived output.');
    const measured = await page.evaluate(() => {
      const wrap = document.getElementById('terminal-screen-wrap');
      return { viewportWidth: innerWidth, clientWidth: wrap.clientWidth, scrollWidth: wrap.scrollWidth };
    });
    assert.equal(measured.viewportWidth, 390);
    assert.ok(measured.scrollWidth > measured.clientWidth * 2);
    return measured;
  });
  await resize(160, 28);
  await run("printf '\\033[2J\\033[24;1HOFF_CURSOR_BOTTOM\\033[H'", 'off-cursor.done', 'OFF_CURSOR_BOTTOM');
  await check('vertical shrink preserves output below a cursor moved home', async () => {
    assert.equal((await snapshot()).cursor.row, 0);
    await resize(160, 8);
    const all = await retained();
    assert.ok(text(all.lines).includes('OFF_CURSOR_BOTTOM'));
    inputModes(all.active);
    return { dimensions: [160, 8], cursorBeforeShrink: [0, 0], bottomOutputRetained: true, historyRows: all.history.length };
  });
  await run("i=0; while [ \"$i\" -lt 300 ]; do printf 'BOUNDED-%03d\\r\\n' \"$i\"; i=$((i+1)); done", 'bounded.done', 'BOUNDED-299');
  await check('retained history stays bounded after output and resize archival', async () => {
    await resize(42, 28);
    await resize(160, 8);
    const all = await retained();
    assert.equal(all.history.length, 200);
    assert.ok(text(all.lines).includes('BOUNDED-299'));
    inputModes(all.active);
    return { maxHistoryRows: 200, actualHistoryRows: all.history.length, latestOutputRetained: true };
  });
  await check('phone browser has no uncaught page errors', async () => {
    assert.deepEqual(pageErrors, []);
    return { errors: 0 };
  });
}

(async () => {
  let failure;
  try { await main(); } catch (error) { failure = redact(error); }
  if (socket) socket.terminate();
  if (browser) await browser.close();
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGINT');
    try { await until(() => child.exitCode !== null || child.signalCode !== null, 'Host did not stop.'); }
    catch { child.kill('SIGKILL'); }
  }
  if (temp) fs.rmSync(temp, { recursive: true, force: true });
  const report = { startedAt, finishedAt: new Date().toISOString(), status: failure ? 'fail' : 'pass', binary: path.relative(repo, binary), binarySha256, platform: `${process.platform}/${process.arch}`, transport: 'real PTY, WebSocket and Chromium phone viewport', aiInferenceRequests: 0, credentialsRedacted: true, checks, ...(failure ? { failure } : {}) };
  fs.mkdirSync(path.join(repo, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'tests/resize.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`${report.status.toUpperCase()}: ${checks.filter(check => check.status === 'pass').length}/${checks.length} resize checks; report tests/resize.json`);
  if (failure) { console.error(failure); process.exitCode = 1; }
})().catch(error => { console.error(redact(error)); process.exitCode = 1; });
