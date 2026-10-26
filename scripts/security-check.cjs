#!/usr/bin/env node
'use strict';

// Run after cargo build --release:
//   node scripts/security-check.cjs [--binary PATH] [--out PATH]
// Requires Node 20+ and ws. Set NIMLO_WS_MODULE to a ws package path when
// it is not installed locally. No AI inference requests are sent.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const assert = require('node:assert/strict');

const repo = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
function option(name, fallback) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  if (!args[index + 1]) throw new Error(`${name} requires a path`);
  return path.resolve(args[index + 1]);
}
const binary = option('--binary', path.join(repo, 'target/release/nimlo-editor'));
const output = option('--out', path.join(repo, 'tests/security.json'));
const secrets = new Set();
const peers = new Set();
const hosts = new Set();
const checks = [];
const startedAt = new Date().toISOString();
let temp;
let WebSocket;

function safe(error) {
  let text = error instanceof Error ? error.message : String(error);
  for (const secret of secrets) text = text.split(secret).join('[REDACTED]');
  return text.replace(/([?#&](?:token|invite)=|nimlo_session=)[^\s;&]+/g, '$1[REDACTED]');
}
function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
async function until(predicate, message, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(25);
  }
  throw new Error(message);
}
async function check(name, action) {
  const start = Date.now();
  try {
    const evidence = await action();
    checks.push({ name, status: 'pass', milliseconds: Date.now() - start, evidence });
    console.log(`PASS ${name}`);
  } catch (error) {
    checks.push({ name, status: 'fail', milliseconds: Date.now() - start, error: safe(error) });
    throw error;
  }
}
function loadWs() {
  const candidates = [
    process.env.NIMLO_WS_MODULE,
    'ws',
    path.join(repo, '../mini_gym/node_modules/ws'),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try { return require(candidate); } catch { /* Try the next supported path. */ }
  }
  throw new Error('Install ws or set NIMLO_WS_MODULE to its package path.');
}
async function randomPort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}
async function startHost(workspace, state) {
  const port = await randomPort();
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(binary, ['--workspace', workspace, '--state-dir', state, '--listen', `127.0.0.1:${port}`], {
    cwd: workspace,
    env: { ...process.env, SHELL: '/bin/sh' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const host = { child, origin, token: null, startupError: null };
  hosts.add(host);
  let window = '';
  child.stdout.on('data', chunk => {
    window = (window + chunk.toString('utf8')).slice(-16384);
    const match = window.match(/#token=([a-zA-Z0-9_-]+)/);
    if (match) {
      host.token = match[1];
      secrets.add(host.token);
      window = '';
    }
  });
  // Provider auth probes may print account information; never retain output.
  child.stderr.on('data', () => {});
  child.on('error', error => { host.startupError = error; });
  await until(() => {
    if (host.startupError) throw host.startupError;
    if (child.exitCode !== null) throw new Error(`Host exited during startup (${child.exitCode}).`);
    return Boolean(host.token);
  }, 'Host did not print its private launch link.');
  return host;
}
async function stopHost(host, signal = 'SIGINT') {
  if (host.child.exitCode !== null || host.child.signalCode !== null) return;
  host.child.kill(signal);
  await until(() => host.child.exitCode !== null || host.child.signalCode !== null,
    'Host did not stop within its deadline.');
  hosts.delete(host);
}
async function http(host, pathname, { cookie, token, origin, method = 'GET', body } = {}) {
  const url = new URL(pathname, host.origin);
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (cookie) headers.Cookie = cookie;
  if (origin) headers.Origin = origin;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(url, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
  const value = await response.json();
  return { status: response.status, value, cookie: response.headers.get('set-cookie')?.split(';')[0] };
}
class Peer {
  constructor(ws) {
    this.ws = ws;
    this.events = [];
    this.pending = new Map();
    this.sequence = 0;
    ws.on('message', data => {
      const message = JSON.parse(data.toString());
      this.events.push(message);
      if (this.events.length > 128) this.events.shift();
      const pending = this.pending.get(message.requestId);
      if (pending) {
        this.pending.delete(message.requestId);
        clearTimeout(pending.timer);
        pending.resolve(message);
      }
    });
    ws.on('error', () => {});
    ws.on('close', () => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error('WebSocket closed before acknowledging the command.'));
      }
      this.pending.clear();
    });
    peers.add(this);
  }
  async initial() {
    await until(() => this.events.some(event => event.type === 'bootstrap'), 'No WebSocket bootstrap arrived.');
    return this.events.find(event => event.type === 'bootstrap');
  }
  request(command) {
    const requestId = `security-${++this.sequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`No response to ${command.type}.`));
      }, 8000);
      this.pending.set(requestId, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ ...command, requestId }));
    });
  }
  async close() {
    if (this.ws.readyState === WebSocket.CLOSED) return;
    this.ws.close();
    await until(() => this.ws.readyState === WebSocket.CLOSED, 'WebSocket did not close.', 2000);
    peers.delete(this);
  }
}
function wsAddress(host, clientId) {
  const url = new URL('/ws', host.origin);
  url.protocol = 'ws:';
  url.searchParams.set('clientId', clientId);
  url.searchParams.set('name', 'Security fixture');
  return url.toString();
}
async function connect(host, clientId, cookie) {
  const ws = new WebSocket(wsAddress(host, clientId), { headers: { Origin: host.origin, Cookie: cookie } });
  const peer = new Peer(ws);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WebSocket open timed out.')), 8000);
    ws.once('open', () => { clearTimeout(timer); resolve(); });
    ws.once('error', () => { clearTimeout(timer); reject(new Error('WebSocket connection failed.')); });
  });
  await peer.initial();
  return peer;
}
async function rejectedUpgrade(host, clientId, cookie, status, origin = host.origin) {
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(wsAddress(host, clientId), { headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}) } });
    const timer = setTimeout(() => { ws.terminate(); reject(new Error('Rejected upgrade timed out.')); }, 8000);
    ws.on('error', () => {});
    ws.on('open', () => {
      clearTimeout(timer);
      ws.terminate();
      reject(new Error('Forbidden WebSocket unexpectedly opened.'));
    });
    ws.on('unexpected-response', (_request, response) => {
      clearTimeout(timer);
      response.resume();
      ws.terminate();
      try { assert.equal(response.statusCode, status); resolve(); } catch (error) { reject(error); }
    });
  });
}
function expectError(response, code) {
  assert.equal(response.type, 'error');
  assert.equal(response.code, code);
}
function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

async function main() {
  WebSocket = loadWs();
  assert.equal(fs.statSync(binary).isFile(), true);
  temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nimlo-security-'));
  const workspace = path.join(temp, 'workspace');
  const state = path.join(temp, 'private-state');
  fs.mkdirSync(workspace);
  fs.mkdirSync(state, { mode: 0o700 });
  fs.mkdirSync(path.join(temp, 'outside-dir'));
  const saved = 'Saved fixture content.\n';
  const draft = 'Durable unsaved fixture: λ and 🌱.\n';
  fs.writeFileSync(path.join(workspace, 'note.txt'), saved);
  fs.writeFileSync(path.join(workspace, 'binary.bin'), Buffer.from([0, 255, 1]));
  fs.writeFileSync(path.join(temp, 'outside.txt'), 'Outside fixture must remain untouched.\n');
  fs.writeFileSync(path.join(temp, 'outside-dir/secret.txt'), 'Outside directory fixture.\n');
  fs.symlinkSync(path.join(temp, 'outside.txt'), path.join(workspace, 'escape.txt'));
  fs.symlinkSync(path.join(temp, 'outside-dir'), path.join(workspace, 'escape-dir'));

  let host = await startHost(workspace, state);
  await check('unauthenticated bootstrap returns 401', async () => {
    assert.equal((await http(host, '/api/bootstrap')).status, 401);
    return { httpStatus: 401 };
  });
  await check('cross-origin authenticated bootstrap returns 403', async () => {
    assert.equal((await http(host, '/api/bootstrap', { token: host.token, origin: 'https://foreign.example' })).status, 403);
    return { httpStatus: 403 };
  });
  await check('unauthenticated WebSocket upgrade returns 401', async () => {
    await rejectedUpgrade(host, 'security-untrusted', null, 401);
    return { httpStatus: 401, transport: 'real WebSocket upgrade' };
  });
  const rootBootstrap = await http(host, '/api/bootstrap', { token: host.token });
  assert.equal(rootBootstrap.status, 200);
  const rootCookie = rootBootstrap.cookie;
  secrets.add(rootCookie.slice('nimlo_session='.length));
  let controller = await connect(host, 'security-controller', rootCookie);
  let generation = (await controller.initial()).generation;
  await check('cross-origin WebSocket upgrade returns 403', async () => {
    await rejectedUpgrade(host, 'security-cross-origin', rootCookie, 403, 'https://foreign.example');
    return { httpStatus: 403 };
  });
  const opened = await controller.request({ type: 'open_file', path: 'note.txt' });
  assert.equal(opened.type, 'file_state');
  let revision = opened.file.revision;

  for (const [name, badPath, code] of [
    ['file traversal is refused', '../outside.txt', 'path'],
    ['absolute file path is refused', path.join(temp, 'outside.txt'), 'path'],
    ['file symlink is refused', 'escape.txt', 'path'],
    ['directory symlink is refused', 'escape-dir/secret.txt', 'path'],
    ['binary file is refused', 'binary.bin', 'encoding'],
  ]) {
    await check(name, async () => {
      expectError(await controller.request({ type: 'open_file', path: badPath }), code);
      return { errorCode: code };
    });
  }
  await check('file creation cannot traverse or follow a directory symlink', async () => {
    for (const badPath of ['../created-outside.txt', 'escape-dir/created.txt']) {
      expectError(await controller.request({ type: 'create_file', path: badPath, content: 'forbidden', generation }), 'path');
    }
    assert.equal(fs.existsSync(path.join(temp, 'created-outside.txt')), false);
    assert.equal(fs.existsSync(path.join(temp, 'outside-dir/created.txt')), false);
    return { errorCode: 'path', outsideWrites: false };
  });

  const invitation = await controller.request({ type: 'pair_create', generation });
  const pairCode = invitation.code; secrets.add(invitation.invite);
  secrets.add(pairCode);
  const pairing = await http(host, '/api/pair', { method: 'POST', origin: host.origin, body: { code: pairCode, invite: invitation.invite } });
  assert.equal(pairing.status, 200);
  const phoneCookie = pairing.cookie;
  secrets.add(phoneCookie.slice('nimlo_session='.length));
  await check('pairing code is single use', async () => {
    assert.equal((await http(host, '/api/pair', { method: 'POST', origin: host.origin, body: { code: pairCode, invite: invitation.invite } })).status, 401);
    return { httpStatusAfterReuse: 401 };
  });
  let phone = await connect(host, 'security-phone', phoneCookie);
  await check('paired phone cannot copy another device ID in a WebSocket upgrade', async () => {
    await rejectedUpgrade(host, 'security-controller', phoneCookie, 403);
    return { httpStatus: 403, transport: 'real WebSocket upgrade', controllerStillConnected: true };
  });
  await check('paired phone immediately creates, edits and saves without taking control', async () => {
    assert.equal((await phone.initial()).access, 'shared');
    assert.equal((await controller.initial()).access, 'shared');
    assert.equal((await phone.initial()).controllerId, 'security-controller');
    const created = await phone.request({ type: 'create_file', path: 'shared.txt', content: 'Created from phone.\n', generation });
    assert.equal(created.type, 'file_state');
    const edited = await phone.request({ type: 'edit_file', path: 'shared.txt', baseRevision: created.file.revision, content: 'Saved from phone.\n', generation });
    assert.equal(edited.type, 'file_state');
    assert.equal(edited.file.dirty, true);
    const response = await phone.request({ type: 'save_file', path: 'shared.txt', revision: edited.file.revision, generation });
    assert.equal(response.type, 'file_state');
    assert.equal(response.file.dirty, false);
    assert.equal(fs.readFileSync(path.join(workspace, 'shared.txt'), 'utf8'), 'Saved from phone.\n');
    return { create: true, edit: true, save: true, controlRequested: false };
  });
  await check('simultaneous paired edits reject the stale revision instead of overwriting', async () => {
    const base = await controller.request({ type: 'open_file', path: 'shared.txt' });
    const responses = await Promise.all([
      controller.request({ type: 'edit_file', path: 'shared.txt', baseRevision: base.file.revision, content: 'Desktop concurrent edit.\n', generation }),
      phone.request({ type: 'edit_file', path: 'shared.txt', baseRevision: base.file.revision, content: 'Phone concurrent edit.\n', generation }),
    ]);
    const winner = responses.find(response => response.type === 'file_state');
    const loser = responses.find(response => response.type === 'error');
    assert.ok(winner);
    expectError(loser, 'stale_revision');
    expectError(await phone.request({ type: 'save_file', path: 'shared.txt', revision: base.file.revision, generation }), 'stale_revision');
    expectError(await phone.request({ type: 'close_file', path: 'shared.txt', discard: true, revision: base.file.revision, generation }), 'stale_revision');
    expectError(await phone.request({ type: 'close_file', path: 'shared.txt', discard: true, generation }), 'revision_required');
    assert.equal((await controller.request({ type: 'open_file', path: 'shared.txt' })).file.content, winner.file.content);
    assert.equal((await phone.request({ type: 'save_file', path: 'shared.txt', revision: winner.file.revision, generation })).type, 'file_state');
    return { acceptedEdits: 1, rejectedEdits: 1, staleSaveRejected: true, staleDiscardRejected: true, unversionedDiscardRejected: true, errorCode: 'stale_revision' };
  });
  await check('terminal viewport ownership does not change generation or revoke desktop editing', async () => {
    const claimed = await phone.request({ type: 'claim_control' });
    assert.equal(claimed.type, 'control');
    assert.equal(claimed.controllerId, 'security-phone');
    assert.equal(claimed.generation, generation);
    const base = await controller.request({ type: 'open_file', path: 'shared.txt' });
    const edited = await controller.request({ type: 'edit_file', path: 'shared.txt', baseRevision: base.file.revision, content: 'Desktop remains writable.\n', generation });
    assert.equal(edited.type, 'file_state');
    assert.equal((await controller.request({ type: 'save_file', path: 'shared.txt', revision: edited.file.revision, generation })).type, 'file_state');
    const returned = await controller.request({ type: 'claim_control' });
    assert.equal(returned.type, 'control');
    assert.equal(returned.generation, generation);
    return { generationUnchanged: true, desktopEditAndSave: true };
  });
  await check('closing and reopening a shared file does not reuse its earlier revision', async () => {
    const previous = await controller.request({ type: 'open_file', path: 'shared.txt' });
    assert.equal(previous.type, 'file_state');
    assert.equal((await phone.request({ type: 'close_file', path: 'shared.txt', revision: previous.file.revision, generation })).type, 'file_closed');
    const reopened = await phone.request({ type: 'open_file', path: 'shared.txt' });
    assert.equal(reopened.type, 'file_state');
    assert.ok(reopened.file.revision > previous.file.revision);
    expectError(await controller.request({ type: 'edit_file', path: 'shared.txt', baseRevision: previous.file.revision, content: 'Stale pre-close edit.', generation }), 'stale_revision');
    assert.equal((await controller.request({ type: 'open_file', path: 'shared.txt' })).file.content, reopened.file.content);
    return { revisionIncreased: true, preCloseEditRejected: true, bufferUnchanged: true };
  });
  await check('file broadcasts arrive before create, edit, save, close and reopen acknowledgements', async () => {
    async function ordered(fields) {
      const offset = phone.events.length;
      const response = await phone.request({ ...fields, generation });
      const events = phone.events.slice(offset);
      const acknowledgement = events.findIndex(event => event.requestId === response.requestId);
      assert.ok(acknowledgement >= 0);
      assert.ok(events.slice(0, acknowledgement).some(event => !event.requestId && event.type === response.type &&
        (response.file ? JSON.stringify(event.file) === JSON.stringify(response.file) : event.path === response.path)),
      `${fields.type} acknowledgement arrived before its matching broadcast.`);
      return response;
    }
    const created = await ordered({ type: 'create_file', path: 'ordered.txt', content: 'Initial ordered state.\n' });
    assert.equal(created.type, 'file_state');
    const edited = await ordered({ type: 'edit_file', path: 'ordered.txt', baseRevision: created.file.revision, content: 'Saved ordered state.\n' });
    assert.equal(edited.file.dirty, true);
    const savedFile = await ordered({ type: 'save_file', path: 'ordered.txt', revision: edited.file.revision });
    assert.equal(savedFile.file.dirty, false);
    assert.equal((await ordered({ type: 'close_file', path: 'ordered.txt', revision: savedFile.file.revision })).type, 'file_closed');
    const reopened = await ordered({ type: 'open_file', path: 'ordered.txt' });
    assert.equal(reopened.file.dirty, false);
    assert.equal(reopened.file.content, 'Saved ordered state.\n');
    assert.ok(reopened.file.revision > savedFile.file.revision);
    return { operations: ['create', 'edit', 'save', 'close', 'reopen'], broadcastsBeforeAcknowledgements: true, reopenedClean: true };
  });
  await check('paired phone reads shared AI settings while only the host can change them', async () => {
    const current = await phone.request({ type: 'ai_settings_get' });
    assert.equal(current.type, 'ai_settings');
    const settings = { ...current.settings, codex: { ...current.settings.codex, model: 'security-fixture-model' } };
    expectError(await phone.request({ type: 'ai_settings_set', settings, generation }), 'permission_denied');
    const changed = await controller.request({ type: 'ai_settings_set', settings, generation });
    assert.equal(changed.type, 'ai_settings');
    assert.equal(changed.settings.codex.model, 'security-fixture-model');
    assert.equal((await phone.request({ type: 'ai_settings_get' })).settings.codex.model, 'security-fixture-model');
    expectError(await phone.request({ type: 'ai_start', provider: 'security-unsupported', prompt: 'Isolated validation fixture.', generation }), 'ai');
    return { settingsShared: true, invalidProviderRejected: true, aiInferenceRequests: 0 };
  });
  await check('only the host attaches a new project and invalidates earlier workspace commands', async () => {
    const otherWorkspace = path.join(temp, 'other-workspace');
    fs.mkdirSync(otherWorkspace);
    const oldGeneration = generation;
    expectError(await phone.request({ type: 'open_project', path: otherWorkspace, generation }), 'permission_denied');
    const switched = await controller.request({ type: 'open_project', path: otherWorkspace, generation });
    assert.equal(switched.type, 'project_opened');
    assert.ok(switched.generation > oldGeneration);
    generation = switched.generation;
    expectError(await controller.request({ type: 'create_file', path: 'stale.txt', content: 'forbidden', generation: oldGeneration }), 'stale_generation');
    assert.equal(fs.existsSync(path.join(otherWorkspace, 'stale.txt')), false);
    const returned = await controller.request({ type: 'open_project', path: workspace, generation });
    assert.equal(returned.type, 'project_opened');
    generation = returned.generation;
    assert.ok(generation > switched.generation);
    const note = await controller.request({ type: 'open_file', path: 'note.txt' });
    assert.equal(note.type, 'file_state');
    assert.equal(note.file.content, saved);
    revision = note.file.revision;
    return { pairedProjectSwitchDenied: true, desktopProjectSwitch: true, errorCode: 'stale_generation', staleWritePrevented: true };
  });
  await check('same-device reconnect replaces its previous connection without changing access generation', async () => {
    const previous = phone;
    phone = await connect(host, 'security-phone', phoneCookie);
    assert.equal((await phone.initial()).generation, generation);
    await until(() => previous.ws.readyState === WebSocket.CLOSED, 'Superseded device connection stayed open.');
    const created = await phone.request({ type: 'create_file', path: 'reconnected.txt', content: 'Replacement connection is writable.\n', generation });
    assert.equal(created.type, 'file_state');
    assert.equal(fs.readFileSync(path.join(workspace, 'reconnected.txt'), 'utf8'), created.file.content);
    return { previousConnectionClosed: true, replacementWritable: true, generationUnchanged: true };
  });

  let draftRevision;
  await check('acknowledged edit is unsaved and does not alter the project file', async () => {
    const response = await controller.request({ type: 'edit_file', path: 'note.txt', baseRevision: revision, content: draft, generation });
    assert.equal(response.type, 'file_state');
    assert.equal(response.file.dirty, true);
    assert.equal(response.file.content, draft);
    draftRevision = response.file.revision;
    assert.equal(fs.readFileSync(path.join(workspace, 'note.txt'), 'utf8'), saved);
    return { dirty: true, projectFileUnchanged: true };
  });
  let shellPid;
  await check('paired phone starts the host terminal while desktop input remains enabled', async () => {
    const response = await phone.request({ type: 'terminal_start', generation });
    assert.equal(response.terminal.running, true);
    assert.equal((await phone.request({ type: 'terminal_input', generation, data: "printf paired > phone-terminal.txt\r" })).type, 'ack');
    await until(() => fs.existsSync(path.join(workspace, 'phone-terminal.txt')), 'Paired terminal command did not run.');
    assert.equal((await controller.request({ type: 'terminal_input', generation, data: "printf '%s\\n' \"$$\" > terminal.pid; printf 'NIMLO_TERMINAL_OK\\n'\r" })).type, 'ack');
    await until(() => {
      try { return /^[1-9][0-9]*\n$/.test(fs.readFileSync(path.join(workspace, 'terminal.pid'), 'utf8')); }
      catch { return false; }
    }, 'Terminal fixture command did not finish writing its PID.');
    shellPid = Number(fs.readFileSync(path.join(workspace, 'terminal.pid'), 'utf8').trim());
    assert.ok(Number.isSafeInteger(shellPid) && shellPid > 1);
    assert.equal(processAlive(shellPid), true);
    return { shell: '/bin/sh', running: true, pairedInput: true, desktopInput: true };
  });
  await controller.close();
  await phone.close();
  await check('browser disconnect leaves terminal and acknowledged drafts in the host', async () => {
    const snapshot = await http(host, '/api/bootstrap', { cookie: rootCookie });
    assert.equal(snapshot.value.terminal.running, true);
    assert.equal(processAlive(shellPid), true);
    const document = snapshot.value.openFiles.find(file => file.path === 'note.txt');
    assert.equal(document.content, draft);
    assert.equal(document.revision, draftRevision);
    return { terminalRunning: true, draftRetained: true };
  });
  await check('paired phone cannot copy another disconnected device ID', async () => {
    await rejectedUpgrade(host, 'security-controller', phoneCookie, 403);
    return { httpStatus: 403, controllerDisconnected: true };
  });
  controller = await connect(host, 'security-controller', rootCookie);
  assert.equal((await controller.initial()).terminal.running, true);
  await check('host shutdown stops its terminal process', async () => {
    await stopHost(host);
    await until(() => !processAlive(shellPid), 'Terminal shell survived host shutdown.', 4000);
    return { hostSignal: 'SIGINT', terminalStopped: true };
  });
  host = await startHost(workspace, state);
  await check('host restart revokes prior launch and paired sessions', async () => {
    assert.equal((await http(host, '/api/bootstrap', { cookie: rootCookie })).status, 401);
    assert.equal((await http(host, '/api/bootstrap', { cookie: phoneCookie })).status, 401);
    await rejectedUpgrade(host, 'security-phone', phoneCookie, 401);
    return { oldCookiesHttpStatus: 401, oldCookieWebSocketStatus: 401 };
  });
  let recovered;
  await check('host restart recovers the durable unsaved buffer without restarting the terminal', async () => {
    recovered = await http(host, '/api/bootstrap', { token: host.token });
    assert.equal(recovered.status, 200);
    const document = recovered.value.openFiles.find(file => file.path === 'note.txt');
    assert.equal(document.content, draft);
    assert.equal(document.revision, draftRevision);
    assert.equal(document.dirty, true);
    assert.equal(recovered.value.terminal.running, false);
    assert.equal(fs.readFileSync(path.join(workspace, 'note.txt'), 'utf8'), saved);
    return { draftRecovered: true, dirty: true, projectFileUnchanged: true, terminalRunning: false };
  });
  const recoveredPeer = await connect(host, 'security-recovered', recovered.cookie);
  const recoveredGeneration = (await recoveredPeer.initial()).generation;
  const crashDraft = 'Acknowledged immediately before forced termination.\n';
  const crashEdit = await recoveredPeer.request({ type: 'edit_file', path: 'note.txt', baseRevision: draftRevision, content: crashDraft, generation: recoveredGeneration });
  assert.equal(crashEdit.type, 'file_state');
  // Kill immediately after acknowledgment, with no recovery delay or Save.
  await stopHost(host, 'SIGKILL');
  host = await startHost(workspace, state);
  await check('an acknowledged draft survives immediate forced host termination', async () => {
    const snapshot = await http(host, '/api/bootstrap', { token: host.token });
    const document = snapshot.value.openFiles.find(file => file.path === 'note.txt');
    assert.equal(document.content, crashDraft);
    assert.equal(document.revision, crashEdit.file.revision);
    assert.equal(document.dirty, true);
    assert.equal(snapshot.value.terminal.running, false);
    assert.equal(fs.readFileSync(path.join(workspace, 'note.txt'), 'utf8'), saved);
    return { hostSignal: 'SIGKILL', draftRecovered: true, projectFileUnchanged: true, terminalRunning: false };
  });
  await check('outside fixtures remain unchanged', async () => {
    assert.equal(fs.readFileSync(path.join(temp, 'outside.txt'), 'utf8'), 'Outside fixture must remain untouched.\n');
    assert.equal(fs.readFileSync(path.join(temp, 'outside-dir/secret.txt'), 'utf8'), 'Outside directory fixture.\n');
    return { outsideFilesUnchanged: true };
  });
}

(async () => {
  let failure;
  try { await main(); } catch (error) { failure = safe(error); }
  for (const peer of peers) peer.ws.terminate();
  for (const host of [...hosts]) {
    try { await stopHost(host); } catch { host.child.kill('SIGKILL'); }
  }
  if (temp) fs.rmSync(temp, { recursive: true, force: true });
  const report = {
    startedAt,
    finishedAt: new Date().toISOString(),
    status: failure ? 'fail' : 'pass',
    platform: `${process.platform}/${process.arch}`,
    node: process.version,
    binary: path.relative(repo, binary),
    binarySha256: fs.existsSync(binary) ? crypto.createHash('sha256').update(fs.readFileSync(binary)).digest('hex') : null,
    isolatedTemporaryWorkspace: true,
    randomLoopbackPorts: true,
    aiInferenceRequests: 0,
    credentialsRedacted: true,
    checks,
    ...(failure ? { failure, remainingChecks: 'blocked by the first failed prerequisite' } : {}),
  };
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  console.log(`${report.status.toUpperCase()}: ${checks.filter(item => item.status === 'pass').length}/${checks.length} checks; report ${path.relative(repo, output)}`);
  if (failure) { console.error(failure); process.exitCode = 1; }
})().catch(error => { console.error(safe(error)); process.exitCode = 1; });
