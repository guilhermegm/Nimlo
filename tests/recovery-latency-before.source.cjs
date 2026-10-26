#!/usr/bin/env node
'use strict';

// Supplemental direct-protocol diagnostic. No browser, native app, AI turn,
// tunnel, user project, source mutation, compilation, or native gate result.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const repo = path.resolve(__dirname, '..');
const opts = {}, args = process.argv.slice(2);
for (let i = 0; i < args.length; i += 2) {
  assert(args[i].startsWith('--') && args[i + 1], 'Arguments are --name value pairs');
  const key = args[i].slice(2);
  assert(['baseline', 'candidate', 'output'].includes(key), 'Unknown argument: ' + key);
  opts[key] = args[i + 1];
}
const baseline = path.resolve(opts.baseline || path.join(repo, 'target/performance-baseline-a811aaf/Relay.app/Contents/Resources/relay-editor'));
const candidate = path.resolve(opts.candidate || path.join(repo, 'target/performance-browser-diagnostics/2026-10-12T18-59-39-628Z-ce10c993/candidate/Relay.app/Contents/Resources/relay-editor'));
const output = path.resolve(opts.output || path.join(repo, 'tests/recovery-latency-before.json'));
const sourceOutput = output.replace(/\.json$/, '') + '.source.cjs';
const WebSocket = require(process.env.RELAY_WS_MODULE || require.resolve('ws', { paths: [repo, path.resolve(repo, '../mini_gym')] }));
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const ordinary = () => ('const value = 123; // bounded ASCII benchmark line with short lines\n').repeat(1000);
const frozenNativeBar = Object.fromEntries(['scripts/native-performance-gate.cjs', 'scripts/native-performance-budget-model.json'].map(name => [name, sha(fs.readFileSync(path.join(repo, name)))]));
const observedSources = Object.fromEntries(['src/main.rs', 'src/workspace.rs', 'src/protocol.rs', 'Cargo.toml', 'Cargo.lock'].map(name => [name, sha(fs.readFileSync(path.join(repo, name)))]));
const secrets = new Set();
let interrupted, activePeer;
const interrupt = () => { interrupted = Error('Direct recovery diagnostic interrupted'); activePeer?.socket.terminate(); };
function safeError(error) {
  let text = String(error.stack || error);
  for (const secret of secrets) text = text.split(secret).join('[private]');
  return text;
}
function processTable() {
  return execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,lstart=,comm='], { encoding: 'utf8', timeout: 5000 }).split('\n').map(line => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+[\d:]+\s+\d+)\s+(.+)$/);
    return match ? { pid: +match[1], ppid: +match[2], startIdentity: match[3], executable: match[4] } : null;
  }).filter(Boolean);
}
function compilerProcesses() {
  return processTable().filter(row => /(?:^|\/)(?:cargo|rustc|swiftc|swift-frontend)$/.test(row.executable));
}
function descendants(pid, rows) {
  const pids = new Set([pid]), children = [];
  for (let prior = -1; prior !== pids.size;) {
    prior = pids.size;
    for (const row of rows) if (pids.has(row.ppid) && !pids.has(row.pid)) { pids.add(row.pid); children.push(row); }
  }
  return children;
}
async function until(fn, label, timeout = 15000, cleanup = false) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (interrupted && !cleanup) throw interrupted;
    const value = fn();
    if (value) return value;
    await pause(15);
  }
  throw Error('Timeout: ' + label);
}
function statistics(samples) {
  const sorted = [...samples].sort((a, b) => a - b), at = p => sorted[Math.ceil(sorted.length * p) - 1];
  return { count: samples.length, p50: at(.50), p95: at(.95), min: sorted[0], max: sorted.at(-1), units: 'milliseconds', quantile: 'nearest rank' };
}
function provenance(binary) {
  const bytes = fs.readFileSync(binary), manifestPath = path.resolve(path.dirname(binary), '../../..', 'manifest.json');
  let sourceAssociation = null;
  if (fs.existsSync(manifestPath)) {
    const manifestBytes = fs.readFileSync(manifestPath), manifest = JSON.parse(manifestBytes);
    assert.equal(manifest.files?.['Contents/Resources/relay-editor']?.sha256, sha(bytes), 'Host differs from its frozen manifest');
    sourceAssociation = { manifest: manifestPath, manifestSha256: sha(manifestBytes), sourceRef: manifest.sourceRef || manifest.commit || null, workingTree: !!manifest.workingTree, sourceDiffSha256: manifest.sourceDiffSha256 || null, recordedSourceSha256: manifest.sourceSha256 || null, limitation: 'Manifest association is not a reproducible-build proof.' };
    if (!manifest.workingTree && sourceAssociation.sourceRef) {
      sourceAssociation.committedRustSourceSha256 = Object.fromEntries(['src/main.rs', 'src/workspace.rs', 'src/protocol.rs'].map(name => [name, sha(execFileSync('git', ['show', sourceAssociation.sourceRef + ':' + name], { cwd: repo, maxBuffer: 2 * 1024 * 1024 }))]));
    }
  }
  return { binary, binarySha256: sha(bytes), binaryBytes: bytes.length, sourceAssociation };
}

// The observer retains one scalar bootstrap, one pending request, and counters.
// Received document objects are only transient; no full-document/event history.
class Peer {
  constructor(socket, recovered) {
    this.socket = socket;
    this.bootstrap = null;
    this.pending = null;
    this.sequence = 0;
    this.counters = { messages: 0, incomingBytes: 0, unsolicitedMessages: 0 };
    socket.on('error', () => {});
    socket.on('message', raw => {
      const receivedAt = process.hrtime.bigint();
      try {
        const value = JSON.parse(raw);
        this.counters.messages++;
        this.counters.incomingBytes += raw.length;
        if (value.type === 'bootstrap') {
          this.bootstrap = { projectId: value.projectId, generation: value.generation, sessionId: value.sessionId, textPatchVersion: value.textPatchVersion || 0, openFileCount: (value.openFiles || []).length };
          if (recovered) recovered(value.openFiles || []);
        }
        if (value.type === 'control' && this.bootstrap) this.bootstrap.generation = value.generation;
        if (this.pending && !value.requestId && ['file_state', 'file_patch'].includes(value.type) && value.file?.path === this.pending.path) {
          this.pending.broadcast = { revision: value.file.revision, receivedAt };
        }
        if (this.pending && value.requestId === this.pending.requestId) {
          const pending = this.pending;
          clearTimeout(pending.timer);
          this.pending = null;
          const broadcast = pending.broadcast?.revision === value.file?.revision ? pending.broadcast : null;
          pending.resolve({ value, milliseconds: Number(receivedAt - pending.startedAt) / 1e6, sentBytes: pending.sentBytes, receivedBytes: raw.length, broadcastToReplyMilliseconds: broadcast ? Number(receivedAt - broadcast.receivedAt) / 1e6 : null, sendToBroadcastMilliseconds: broadcast ? Number(broadcast.receivedAt - pending.startedAt) / 1e6 : null });
        } else this.counters.unsolicitedMessages++;
      } catch (error) { this.fail(error); }
    });
    socket.on('close', () => this.fail(Error('Owned diagnostic peer closed')));
  }
  fail(error) {
    this.error = error;
    if (this.pending) { clearTimeout(this.pending.timer); this.pending.reject(error); this.pending = null; }
  }
  request(type, fields = {}) {
    assert(!this.pending, 'Serial requests only');
    if (this.error) return Promise.reject(this.error);
    const requestId = 'recovery-' + (++this.sequence);
    const wire = JSON.stringify({ type, requestId, projectId: this.bootstrap.projectId, generation: this.bootstrap.generation, ...fields });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending = null; reject(Error('Timeout: ' + type)); }, 15000);
      this.pending = { requestId, resolve, reject, timer, path: fields.path, sentBytes: Buffer.byteLength(wire), startedAt: process.hrtime.bigint() };
      this.socket.send(wire, error => { if (error) this.fail(error); });
    });
  }
}

async function trial(label, source, mode) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'relay-recovery-latency-')));
  const workspace = path.join(base, 'workspace'), state = path.join(base, 'state'), bin = path.join(base, 'bin'), binary = path.join(base, 'relay-editor'), probeLog = path.join(base, 'probes.jsonl');
  for (const dir of [workspace, state, bin]) fs.mkdirSync(dir, { mode: 0o700 });
  fs.copyFileSync(source.binary, binary); fs.chmodSync(binary, 0o700);
  assert.equal(sha(fs.readFileSync(binary)), source.binarySha256);
  let expected = ordinary();
  const initialSha256 = sha(expected);
  fs.writeFileSync(path.join(workspace, 'ordinary.txt'), expected, { mode: 0o600 });
  const fake = '#!' + process.execPath + '\nconst fs=require("node:fs"),path=require("node:path");const args=process.argv.slice(2),provider=path.basename(process.argv[1]);const allowed=provider==="codex"?JSON.stringify(args)===JSON.stringify(["login","status"]):JSON.stringify(args)===JSON.stringify(["auth","status"]);fs.appendFileSync(process.env.RELAY_RECOVERY_PROBES,JSON.stringify({provider,args,pid:process.pid,ppid:process.ppid,allowed})+"\\n");if(!allowed)process.exit(72);console.log(provider==="claude"?JSON.stringify({loggedIn:true,authMethod:"claude.ai"}):"Logged in using subscription");\n';
  for (const name of ['codex', 'claude']) fs.writeFileSync(path.join(bin, name), fake, { mode: 0o700 });
  const row = { label, mode, status: 'running', ...source, serialEditCount: 32, samples: [], checks: [], ownership: { owned: [], cleanup: [] }, probeCalls: [], observerCounters: [], ports: [] };
  let host, peer, hostIdentity;
  const probes = () => fs.existsSync(probeLog) ? fs.readFileSync(probeLog, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  async function start(recovered) {
    let origin, token, buffer = '';
    host = spawn(binary, ['--workspace', workspace, '--state-dir', state, '--listen', '127.0.0.1:0'], { cwd: base, env: { ...process.env, PATH: bin + ':/usr/bin:/bin:/usr/sbin:/sbin', SHELL: '/bin/sh', RELAY_RECOVERY_PROBES: probeLog }, stdio: ['ignore', 'pipe', 'pipe'] });
    host.stderr.on('data', () => {});
    host.stdout.on('data', chunk => {
      buffer = (buffer + chunk).slice(-8192);
      const match = buffer.match(/(http:\/\/[^\s]+)\/#token=([a-f0-9]{64})/);
      if (match) { origin = match[1]; token = match[2]; secrets.add(token); buffer = ''; }
    });
    host.on('error', error => { host.startError = error; });
    hostIdentity = await until(() => { if (host.startError) throw host.startError; if (host.exitCode !== null || host.signalCode !== null) throw Error('Owned host exited before startup'); return processTable().find(value => value.pid === host.pid); }, 'owned host PID identity');
    row.ownership.owned.push({ ...hostIdentity, role: 'rustHost', executableSha256: source.binarySha256 });
    await until(() => { if (host.startError) throw host.startError; if (host.exitCode !== null || host.signalCode !== null) throw Error('Owned host exited before readiness'); return origin; }, 'owned host ready');
    const port = +new URL(origin).port;
    assert(![8765, 8767, 8742].includes(port), 'Reserved user port');
    assert.equal(new URL(origin).hostname, '127.0.0.1'); row.ports.push(port);
    const requiredProbes = row.ports.length * 2;
    await until(() => { const calls = probes(); assert(calls.every(call => call.allowed), 'Only fake CLI auth probes allowed'); return calls.length >= requiredProbes && descendants(host.pid, processTable()).length === 0; }, 'fake CLI probes exited');
    const response = await fetch(origin + '/api/bootstrap', { headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(8000) });
    assert.equal(response.status, 200);
    const cookie = response.headers.get('set-cookie')?.split(';')[0]; assert(cookie); secrets.add(cookie);
    const socket = new WebSocket(origin.replace(/^http/, 'ws') + '/ws?clientId=recovery-probe&patches=1', { headers: { Origin: origin, Cookie: cookie } });
    peer = activePeer = new Peer(socket, recovered);
    await until(() => { if (peer.error) throw peer.error; return peer.bootstrap; }, 'authenticated WebSocket bootstrap');
    if (mode === 'patch_file') assert.equal(peer.bootstrap.textPatchVersion, 1);
    assert.equal(compilerProcesses().length, 0, 'Compilation invalidates direct latency diagnostic');
    return peer;
  }
  async function stop(signal) {
    if (!host) return;
    const child = host, identity = hostIdentity;
    if (child.exitCode === null && child.signalCode === null) {
      const current = processTable().find(value => value.pid === child.pid);
      assert(current && current.startIdentity === identity.startIdentity && current.executable === identity.executable, 'Refusing to signal a changed PID identity');
      child.kill(signal);
      await until(() => child.exitCode !== null || child.signalCode !== null, 'owned host exit', 15000, true);
    }
    await until(() => !processTable().some(value => value.pid === child.pid && value.startIdentity === identity.startIdentity), 'owned PID identity gone', 15000, true);
    peer?.socket.terminate(); activePeer = null;
    row.ownership.cleanup.push({ ...identity, signal, exited: true });
    if (peer) row.observerCounters.push({ ...peer.counters });
    peer = null; host = null;
  }
  try {
    await start();
    const opened = (await peer.request('open_file', { path: 'ordinary.txt' })).value;
    assert.equal(opened.type, 'file_state'); assert(opened.file.content === expected, 'Opened fixture text differs');
    let revision = opened.file.revision;
    row.initialRevision = revision;
    row.checks.push('Exact identical 68,000-byte / 1,000-line disposable source opened');
    for (let index = 0; index < 32; index++) {
      if (interrupted) throw interrupted;
      const insert = index % 2 === 0 ? 'x' : 'y';
      expected = insert + expected.slice(1);
      const fields = mode === 'edit_file' ? { path: 'ordinary.txt', baseRevision: revision, content: expected } : { path: 'ordinary.txt', baseRevision: revision, start: 0, deleteCount: 1, insert };
      const reply = await peer.request(mode, fields), value = reply.value;
      assert.notEqual(value.type, 'error', value.message);
      assert.equal(value.type, mode === 'edit_file' ? 'file_state' : 'file_patch');
      assert.equal(value.file.path, 'ordinary.txt'); assert.equal(value.file.revision, revision + 1); assert.equal(value.file.dirty, true); assert.equal(value.file.conflict, null);
      if (mode === 'edit_file') assert(value.file.content === expected, 'Whole-edit reply text differs');
      else { assert.equal(value.file.content, undefined); assert.equal(value.baseRevision, revision); assert.deepEqual(value.patch, { start: 0, deleteCount: 1, insert }); }
      row.samples.push({ index, baseRevision: revision, revision: value.file.revision, milliseconds: reply.milliseconds, sentBytes: reply.sentBytes, receivedBytes: reply.receivedBytes, sendToBroadcastMilliseconds: reply.sendToBroadcastMilliseconds, broadcastToReplyMilliseconds: reply.broadcastToReplyMilliseconds, acknowledged: true });
      revision = value.file.revision;
    }
    row.latency = statistics(row.samples.map(value => value.milliseconds));
    const gaps = row.samples.map(value => value.broadcastToReplyMilliseconds).filter(value => value !== null);
    if (gaps.length) row.broadcastToReplyLatency = statistics(gaps);
    row.finalRevision = revision; row.expectedTextSha256 = sha(expected);
    row.checks.push('32 serial correlated durable replies advance revisions identically and preserve exact text/patch semantics');
    // Kill directly after the last durable reply; do not flush or close first.
    await stop('SIGKILL');
    let recovered;
    await start(files => {
      assert.equal(files.length, 1);
      const file = files[0];
      assert.equal(file.path, 'ordinary.txt'); assert(file.content === expected, 'Recovered text differs from last acknowledged edit'); assert.equal(file.revision, revision); assert.equal(file.dirty, true); assert.equal(file.conflict, null);
      recovered = { exactText: true, textSha256: sha(file.content), revision: file.revision, dirty: file.dirty, bytes: Buffer.byteLength(file.content) };
    });
    assert(recovered, 'Recovery bootstrap must contain acknowledged file');
    row.recovery = recovered;
    assert.equal(sha(fs.readFileSync(path.join(workspace, 'ordinary.txt'))), initialSha256, 'Unsaved edits must not change fixture disk');
    row.checks.push('Owned-host abrupt exit/restart recovers the exact last acknowledged text/revision and leaves fixture disk unchanged');
    assert.equal(sha(fs.readFileSync(source.binary)), source.binarySha256, 'Frozen host changed');
    assert.equal(compilerProcesses().length, 0, 'Compilation invalidates direct latency diagnostic');
    row.status = 'pass';
  } catch (error) { row.status = 'fail'; row.error = safeError(error); }
  finally {
    try { await stop('SIGTERM'); }
    catch (error) { row.status = 'fail'; row.cleanupError = safeError(error); }
    row.probeCalls = probes();
    const after = processTable();
    row.ownership.allOwnedExited = row.ownership.owned.every(owned => !after.some(value => value.pid === owned.pid && value.startIdentity === owned.startIdentity));
    if (!row.ownership.allOwnedExited) { row.status = 'fail'; row.cleanupError ||= 'Owned host identity remained alive'; }
    fs.rmSync(base, { recursive: true, force: true });
  }
  return row;
}

async function main() {
  assert.equal(process.platform, 'darwin', 'PID/start identity parser requires macOS ps');
  assert(!fs.existsSync(output) && !fs.existsSync(sourceOutput), 'Raw evidence and measured source must not be overwritten');
  assert.equal(compilerProcesses().length, 0, 'Wait for a compiler-free diagnostic window');
  const baselineSource = provenance(baseline), candidateSource = provenance(candidate);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const sourceBytes = fs.readFileSync(__filename);
  fs.writeFileSync(sourceOutput, sourceBytes, { flag: 'wx', mode: 0o400 });
  const result = { schemaVersion: 1, status: 'running', kind: 'Direct WebSocket send-to-durable-reply diagnostic; not native gate evidence', startedAt: new Date().toISOString(), diagnosticSha256: sha(sourceBytes), measuredSource: sourceOutput, workspaceObservedSourceSha256: observedSources, sourceObservationLimitation: 'Observed working-tree hashes are metadata, not proof that a frozen binary was built from this source.', frozenNativeBar, workload: { ordinaryBytes: Buffer.byteLength(ordinary()), ordinaryLines: 1000, initialTextSha256: sha(ordinary()), serialEditsPerSeries: 32, sameLength: true, changedAsciiCharactersPerEdit: 1, utf16Start: 0, utf16DeleteCount: 1, replacementCycle: ['x', 'y'], expectedFinalRevision: 33 }, method: { timing: 'Monotonic hrtime immediately before ws.send of pre-serialized RPC through arrival of its request-correlated durable reply; arrival stamped before JSON parsing. No browser, debounce or additional pacing.', observer: 'Only scalar metadata, timing/byte counters and one pending request retained. One expected fixture string is used for correctness; no event/document history.', durability: 'Reply follows host persistence; abrupt process SIGKILL/restart validates last acknowledged recovery. This does not simulate hardware power loss.', order: 'Baseline edit_file, candidate edit_file, candidate patch_file, each in a fresh identical disposable fixture.' }, browserLaunched: false, nativeAppLaunched: false, nativeGateVerdict: false, realInferenceRequests: 0, tunnelStarted: false, series: [] };
  process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
  try {
    for (const [label, source, mode] of [['baseline-whole', baselineSource, 'edit_file'], ['candidate-whole', candidateSource, 'edit_file'], ['candidate-patch', candidateSource, 'patch_file']]) {
      const row = await trial(label, source, mode); result.series.push(row);
      console.log(label + ': ' + row.status + (row.latency ? '; p50 ' + row.latency.p50.toFixed(2) + 'ms; p95 ' + row.latency.p95.toFixed(2) + 'ms' : ''));
      if (row.status !== 'pass') throw Error(row.error || row.cleanupError || 'Series failed');
    }
    const revisions = result.series.map(row => row.samples.map(value => [value.baseRevision, value.revision]));
    assert.deepEqual(revisions[0], revisions[1]); assert.deepEqual(revisions[0], revisions[2]);
    assert(result.series.every(row => row.expectedTextSha256 === result.series[0].expectedTextSha256));
    for (const [name, hash] of Object.entries(frozenNativeBar)) assert.equal(sha(fs.readFileSync(path.join(repo, name))), hash, 'Native quality bar changed');
    result.comparison = { matchingRevisions: true, matchingExpectedText: true, matchingFixtureAndChecks: true, candidateWholeP50Ratio: result.series[1].latency.p50 / result.series[0].latency.p50, candidateWholeP95Ratio: result.series[1].latency.p95 / result.series[0].latency.p95, candidatePatchP50Ratio: result.series[2].latency.p50 / result.series[0].latency.p50, candidatePatchP95Ratio: result.series[2].latency.p95 / result.series[0].latency.p95 };
    result.status = 'pass';
  } catch (error) { result.status = 'fail'; result.error = safeError(error); process.exitCode = 1; }
  finally {
    result.completedAt = new Date().toISOString();
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
    fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o400 });
    console.log(result.status.toUpperCase() + ' ' + output);
  }
}
main().catch(error => { console.error(safeError(error)); process.exitCode = 1; });
