#!/usr/bin/env node
'use strict';

// Run after cargo build --release. Uses a disposable cloudflared stand-in and
// real HTTP/WebSocket proxy connections. Opens no public tunnel and sends no AI
// inference requests. This verifies integration, not Internet reachability.
// node scripts/internet-check.cjs [--binary PATH] [--out PATH]
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const net = require('node:net');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const repo = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
function option(name, fallback) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  if (!args[index + 1]) throw new Error(`${name} requires a path`);
  return path.resolve(args[index + 1]);
}
const binary = option('--binary', path.join(repo, 'target/release/nimlo-editor'));
const output = option('--out', path.join(repo, 'tests/internet.json'));
let WebSocket;
for (const candidate of [process.env.NIMLO_WS_MODULE, 'ws', path.resolve(repo, '../mini_gym/node_modules/ws')].filter(Boolean)) {
  try { WebSocket = require(candidate); break; } catch { /* Try the next package. */ }
}
if (!WebSocket) throw new Error('Install ws or set NIMLO_WS_MODULE to its package path.');
const checks = [], peers = new Set(), hosts = new Set(), secrets = new Set();
let scratch, records, modeFile;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
function safe(error) {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of secrets) message = message.split(secret).join('[REDACTED]');
  return message.replace(/([?#&](?:token|invite)=|nimlo_session=)[^\s;&]+/g, '$1[REDACTED]');
}
async function until(predicate, label, milliseconds = 10000) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) { if (await predicate()) return; await delay(25); }
  throw new Error(label);
}
async function check(name, action) {
  const started = Date.now();
  try { const evidence = await action(); checks.push({ name, status: 'pass', milliseconds: Date.now() - started, evidence }); console.log(`PASS ${name}`); }
  catch (error) { checks.push({ name, status: 'fail', error: safe(error) }); throw error; }
}
function starts() {
  if (!fs.existsSync(records)) return [];
  return fs.readFileSync(records, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}
async function port() {
  const server = net.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const value = server.address().port; await new Promise(resolve => server.close(resolve)); return value;
}
function installFixture(directory) {
  const source = `#!${process.execPath}
'use strict';
const fs=require('node:fs'),http=require('node:http'),net=require('node:net');
const args=process.argv.slice(2),target=new URL(args[args.indexOf('--url')+1]);
const records=${JSON.stringify(records)},modeFile=${JSON.stringify(modeFile)};
const count=fs.existsSync(records)?fs.readFileSync(records,'utf8').trim().split('\\n').filter(Boolean).length:0;
const publicOrigin='https://fixture-'+(count+1)+'.trycloudflare.com';
const mode=fs.existsSync(modeFile)?fs.readFileSync(modeFile,'utf8').trim():'ready';
const server=http.createServer((request,response)=>{
 const upstream=http.request({hostname:target.hostname,port:target.port,path:request.url,method:request.method,headers:request.headers},reply=>{
  response.writeHead(reply.statusCode,reply.headers);reply.pipe(response);
 });
 upstream.on('error',()=>{response.writeHead(502);response.end();});request.pipe(upstream);
});
server.on('upgrade',(request,socket,head)=>{
 const upstream=net.connect(Number(target.port),target.hostname,()=>{
  upstream.write(request.method+' '+request.url+' HTTP/'+request.httpVersion+'\\r\\n'+request.rawHeaders.reduce((text,value,index)=>text+value+(index%2?'\\r\\n':': '),'')+'\\r\\n');
  if(head.length)upstream.write(head);socket.pipe(upstream);upstream.pipe(socket);
 });
 upstream.on('error',()=>socket.destroy());socket.on('error',()=>upstream.destroy());socket.on('close',()=>upstream.destroy());
});
server.listen(0,'127.0.0.1',()=>{
 fs.appendFileSync(records,JSON.stringify({pid:process.pid,args,port:server.address().port,publicOrigin,mode,unsafeEnv:Object.keys(process.env).filter(key=>key.startsWith('TUNNEL_')||key.startsWith('CLOUDFLARED_')||key==='NO_TLS_VERIFY')})+'\\n');
 if(mode==='error'){console.error('ERR disposable tunnel fixture failed');process.exit(17);}
 console.error(mode==='malformed'?'https://fixture.trycloudflare.com.attacker.example':publicOrigin);
 console.error('INF Registered tunnel connection connIndex=0 protocol=quic');
});
`;
  fs.writeFileSync(path.join(directory, 'cloudflared'), source, { mode: 0o700 });
}
async function startHost(workspace, state, extra = []) {
  const listenPort = await port(), origin = `http://127.0.0.1:${listenPort}`;
  const child = spawn(binary, ['--workspace', workspace, '--state-dir', state, '--listen', `127.0.0.1:${listenPort}`, ...extra], {
    cwd: workspace, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PATH: `${path.join(scratch, 'bin')}:${process.env.PATH}`, SHELL: '/bin/sh',
      TUNNEL_HTTP_HOST_HEADER: 'attacker.example', TUNNEL_URL: 'http://attacker.example', CLOUDFLARED_DIAGNOSTIC: 'fixture', NO_TLS_VERIFY: 'true' },
  });
  const host = { child, origin, token: null }; hosts.add(host);
  let tail = '', startupError;
  child.on('error', error => { startupError = error; });
  child.stdout.on('data', chunk => {
    tail = (tail + chunk.toString()).slice(-16384);
    const match = tail.match(/#token=([a-zA-Z0-9_-]+)/);
    if (match) { host.token = match[1]; secrets.add(host.token); tail = ''; }
  });
  child.stderr.on('data', () => {});
  await until(() => {
    if (startupError) throw startupError;
    if (child.exitCode !== null) throw new Error(`Host exited during startup (${child.exitCode}).`);
    return host.token;
  }, 'Host startup timed out.');
  return host;
}
async function stopHost(host, signal = 'SIGINT') {
  if (host.child.exitCode === null && host.child.signalCode === null) host.child.kill(signal);
  await until(() => host.child.exitCode !== null || host.child.signalCode !== null, 'Host shutdown timed out.');
  hosts.delete(host);
}
async function request(endpoint, route, { cookie, token, origin, method = 'GET', body, headers = {} } = {}) {
  const target = new URL(endpoint.origin);
  const data = body === undefined ? undefined : JSON.stringify(body);
  const outgoing = { ...headers, ...(endpoint.authority ? { Host: endpoint.authority } : {}), ...(origin ? { Origin: origin } : {}),
    ...(cookie ? { Cookie: cookie } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) };
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: target.hostname, port: target.port, path: route, method, headers: outgoing }, response => {
      let text = ''; response.on('data', chunk => { text += chunk; }); response.on('end', () => {
        let value; try { value = JSON.parse(text); } catch { value = text; }
        const setCookie = response.headers['set-cookie']?.[0];
        if (setCookie) secrets.add(setCookie.split(';')[0].slice('nimlo_session='.length));
        resolve({ status: response.statusCode, value, setCookie, cookie: setCookie?.split(';')[0] });
      });
    });
    req.setTimeout(8000, () => req.destroy(new Error('HTTP request timed out.'))); req.on('error', reject); req.end(data);
  });
}
async function connect(endpoint, id, cookie) {
  const ws = new WebSocket(endpoint.origin.replace('http:', 'ws:') + '/ws?clientId=' + id, {
    headers: { Origin: endpoint.publicOrigin || endpoint.origin, Cookie: cookie, ...(endpoint.authority ? { Host: endpoint.authority } : {}) },
  });
  const events = [], pending = new Map(); let sequence = 0; peers.add(ws);
  ws.on('message', data => {
    const event = JSON.parse(data.toString()); events.push(event); if (events.length > 256) events.shift();
    const item = pending.get(event.requestId); if (item) { clearTimeout(item.timer); pending.delete(event.requestId); item.resolve(event); }
  });
  ws.on('error', () => {});
  ws.on('close', () => { for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error('Peer disconnected.')); } pending.clear(); peers.delete(ws); });
  await until(() => {
    if (ws.readyState === WebSocket.CLOSED) throw new Error('WebSocket closed before bootstrap.');
    return events.some(event => event.type === 'bootstrap');
  }, 'WebSocket bootstrap timed out.');
  return { ws, events, initial: events.find(event => event.type === 'bootstrap'),
    command: fields => new Promise((resolve, reject) => {
      const requestId = `internet-${++sequence}`, timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`No response to ${fields.type}.`)); }, 10000);
      pending.set(requestId, { resolve, reject, timer }); ws.send(JSON.stringify({ ...fields, requestId }));
    }),
  };
}
async function rejectUpgrade(endpoint, status, cookie, origin) {
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(endpoint.origin.replace('http:', 'ws:') + '/ws?clientId=internet-rejected', {
      headers: { ...(endpoint.authority ? { Host: endpoint.authority } : {}), ...(cookie ? { Cookie: cookie } : {}), ...(origin ? { Origin: origin } : {}) },
    });
    const timer = setTimeout(() => { ws.terminate(); reject(new Error('Rejected upgrade timed out.')); }, 8000);
    ws.on('error', () => {});
    ws.on('open', () => { clearTimeout(timer); ws.terminate(); reject(new Error('Forbidden WebSocket unexpectedly opened.')); });
    ws.on('unexpected-response', (_req, response) => {
      clearTimeout(timer); response.resume(); ws.terminate();
      try { assert.equal(response.statusCode, status); resolve(); } catch (error) { reject(error); }
    });
  });
}
function expectError(value, code) { assert.equal(value.type, 'error'); if (code) assert.equal(value.code, code); }
async function main() {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'nimlo-internet-'));
  records = path.join(scratch, 'tunnels.jsonl'); modeFile = path.join(scratch, 'mode');
  const workspace = path.join(scratch, 'workspace'), state = path.join(scratch, 'state'), bin = path.join(scratch, 'bin');
  for (const directory of [workspace, state, bin]) fs.mkdirSync(directory, { mode: 0o700 });
  fs.writeFileSync(path.join(workspace, 'note.txt'), 'Original fixture.\n'); installFixture(bin);
  const host = await startHost(workspace, state);
  const local = await request(host, '/api/bootstrap', { token: host.token });
  assert.equal(local.status, 200); const cookie = local.cookie;
  const pc = await connect(host, 'internet-desktop', cookie); let generation = pc.initial.generation;
  const snapshot = async () => (await request(host, '/api/bootstrap', { cookie })).value.internet;
  await check('Internet access starts off with no tunnel child', async () => {
    assert.equal((await snapshot()).status, 'off'); assert.equal(starts().length, 0);
    assert.ok(!local.setCookie.includes('; Secure')); return { processCount: 0, localCookieSecure: false };
  });
  await check('stale project generation cannot start a tunnel', async () => {
    expectError(await pc.command({ type: 'internet_start', generation: generation - 1 }), 'stale_generation');
    assert.equal(starts().length, 0); return { rejectedBeforeSpawn: true };
  });
  let first, remote;
  await check('starting twice creates one managed loopback proxy and strips unsafe tunnel overrides', async () => {
    const result = await pc.command({ type: 'internet_start', generation }); assert.notEqual(result.type, 'error');
    await until(async () => (await snapshot()).status === 'ready', 'Tunnel never became ready.');
    const again = await pc.command({ type: 'internet_start', generation }); assert.notEqual(again.type, 'error');
    assert.equal(starts().length, 1); first = starts()[0]; assert.ok(alive(first.pid));
    assert.deepEqual(first.unsafeEnv, []); assert.ok(first.args.includes('--no-autoupdate'));
    assert.ok(!first.args.includes('--http-host-header'));
    const origin = (await snapshot()).url; assert.equal(origin, first.publicOrigin);
    remote = { origin: `http://127.0.0.1:${first.port}`, publicOrigin: origin, authority: new URL(origin).host };
    return { processCount: 1, publicAuthority: remote.authority, proxy: 'disposable loopback HTTP/WebSocket fixture', inheritedTunnelOverrides: 0 };
  });
  await check('local and HTTPS public origins stay distinct with per-request cookie security', async () => {
    assert.equal((await request(remote, '/api/bootstrap')).status, 401);
    assert.equal((await request({ ...host, authority: 'unapproved.example' }, '/api/bootstrap', { cookie })).status, 403);
    assert.equal((await request(remote, '/api/bootstrap', { cookie, origin: host.origin })).status, 403);
    assert.equal((await request(host, '/api/bootstrap', { cookie, origin: remote.publicOrigin })).status, 403);
    assert.equal((await request(remote, '/api/bootstrap', { cookie, origin: 'https://foreign.example' })).status, 403);
    const publicResponse = await request(remote, '/api/bootstrap', { token: host.token, origin: remote.publicOrigin });
    assert.equal(publicResponse.status, 401); // The private PC launch token cannot become a public credential.
    const spoofed = await request(host, '/api/bootstrap', { cookie, headers: { 'X-Forwarded-Proto': 'https', 'X-Forwarded-Host': remote.authority } });
    assert.equal(spoofed.status, 401); // Proxy headers deny local launch-token privileges.
    await rejectUpgrade(remote, 401, null, remote.publicOrigin);
    await rejectUpgrade(remote, 403, cookie, host.origin); await rejectUpgrade(remote, 403, cookie);
    return { unauthenticatedBootstrap: 401, unauthenticatedWebSocket: 401, crossedOrigins: 403, privateLaunchPublicDenied: true, localCookieSecure: false };
  });
  let phoneCookie, phone, directRemote;
  await check('public pairing is same-origin and single-use, with proxy clients classified remote', async () => {
    const invitation = await pc.command({ type: 'pair_create', generation, origin: remote.publicOrigin });
    const code = invitation.code, invite = invitation.invite; secrets.add(code); secrets.add(invite);
    assert.equal((await request(remote, '/api/pair', { method: 'POST', body: { code, invite } })).status, 403);
    assert.equal((await request(remote, '/api/pair', { method: 'POST', origin: host.origin, body: { code, invite } })).status, 403);
    const paired = await request(remote, '/api/pair', { method: 'POST', origin: remote.publicOrigin, body: { code, invite } });
    assert.equal(paired.status, 200); assert.ok(paired.setCookie.includes('; Secure')); phoneCookie = paired.cookie;
    assert.equal((await request(remote, '/api/pair', { method: 'POST', origin: remote.publicOrigin, body: { code, invite } })).status, 401);
    phone = await connect(remote, 'internet-phone', phoneCookie); assert.equal(phone.initial.pickerAvailable, false);
    expectError(await phone.command({ type: 'browse_project', generation }));
    directRemote = await connect({ ...host, authority: remote.authority, publicOrigin: remote.publicOrigin }, 'internet-direct-proxy', phoneCookie);
    assert.equal(directRemote.initial.pickerAvailable, false);
    assert.equal(phone.initial.access, 'shared'); assert.equal(pc.initial.access, 'shared');
    return { codeReuse: 401, missingOrWrongOrigin: 403, cookieSecure: true, nativePickerAvailable: false, access: 'shared' };
  });
  await check('paired remote and local PC both edit and save without handing off control', async () => {
    const opened = await phone.command({ type: 'open_file', path: 'note.txt', generation }); assert.equal(opened.type, 'file_state');
    const edited = await phone.command({ type: 'edit_file', path: 'note.txt', baseRevision: opened.file.revision, content: 'Phone over proxy.\n', generation }); assert.equal(edited.type, 'file_state');
    const saved = await phone.command({ type: 'save_file', path: 'note.txt', revision: edited.file.revision, generation }); assert.equal(saved.type, 'file_state');
    const desktopEdit = await pc.command({ type: 'edit_file', path: 'note.txt', baseRevision: saved.file.revision, content: 'Desktop stays usable.\n', generation }); assert.equal(desktopEdit.type, 'file_state');
    assert.equal((await pc.command({ type: 'save_file', path: 'note.txt', revision: desktopEdit.file.revision, generation })).type, 'file_state');
    assert.equal(fs.readFileSync(path.join(workspace, 'note.txt'), 'utf8'), 'Desktop stays usable.\n');
    return { remoteEditSave: true, localEditSave: true, controlRequested: false };
  });
  await check('remote phone uses the host shell while shared settings and project attachment require the PC', async () => {
    assert.equal((await phone.command({ type: 'terminal_start', generation })).terminal.running, true);
    assert.equal((await phone.command({ type: 'terminal_input', data: 'printf remote > remote-shell.txt\r', generation })).type, 'ack');
    await until(() => fs.existsSync(path.join(workspace, 'remote-shell.txt')), 'Remote terminal command did not run.');
    assert.equal(fs.readFileSync(path.join(workspace, 'remote-shell.txt'), 'utf8'), 'remote');
    const current = await phone.command({ type: 'ai_settings_get' });
    const settings = { ...current.settings, codex: { ...current.settings.codex, model: 'internet-fixture-model' } };
    expectError(await phone.command({ type: 'ai_settings_set', settings, generation }), 'permission_denied');
    assert.equal((await pc.command({ type: 'ai_settings_set', settings, generation })).type, 'ai_settings');
    assert.equal((await pc.command({ type: 'ai_settings_get' })).settings.codex.model, 'internet-fixture-model');
    const next = path.join(scratch, 'other-project'); fs.mkdirSync(next);
    expectError(await phone.command({ type: 'open_project', path: next, generation }), 'permission_denied');
    const changed = await pc.command({ type: 'open_project', path: next, generation }); assert.equal(changed.type, 'project_opened'); generation = changed.generation;
    const restored = await pc.command({ type: 'open_project', path: workspace, generation }); assert.equal(restored.type, 'project_opened'); generation = restored.generation;
    assert.equal((await snapshot()).url, remote.publicOrigin);
    return { hostShellCommand: true, settingsShared: true, settingsHostOnly: true, projectSwitch: true, projectAttachmentHostOnly: true, pairingRetainedAcrossProjects: true, aiInferenceRequests: 0 };
  });
  await check('stop reaps the tunnel, disconnects its phone, and keeps the local PC working', async () => {
    assert.notEqual((await pc.command({ type: 'internet_stop', generation })).type, 'error');
    await until(async () => (await snapshot()).status === 'off', 'Internet access did not turn off.');
    await until(() => !alive(first.pid), 'Stopped tunnel child survived.');
    await until(() => phone.ws.readyState === WebSocket.CLOSED, 'Phone proxy WebSocket survived stop.');
    await until(() => directRemote.ws.readyState === WebSocket.CLOSED, 'Admitted public WebSocket survived authority revocation.');
    assert.equal((await request({ ...host, authority: remote.authority }, '/api/bootstrap', { cookie: phoneCookie })).status, 403);
    assert.equal((await pc.command({ type: 'ping' })).type, 'pong');
    return { childReaped: true, remoteDisconnected: true, directPublicSocketFenced: true, oldAuthority: 403, desktopConnected: true };
  });
  let restarted;
  await check('restart gets a fresh authority and unexpected child exit clears remote access', async () => {
    assert.notEqual((await pc.command({ type: 'internet_start', generation })).type, 'error');
    await until(async () => (await snapshot()).status === 'ready', 'Restarted tunnel did not become ready.');
    restarted = starts().at(-1); assert.notEqual(restarted.publicOrigin, first.publicOrigin); assert.equal(starts().length, 2);
    assert.equal((await request({ ...host, authority: remote.authority }, '/api/bootstrap', { cookie })).status, 403);
    process.kill(restarted.pid, 'SIGKILL');
    await until(async () => (await snapshot()).status === 'error', 'Tunnel death was not reported.');
    await until(() => !alive(restarted.pid), 'Failed child was not reaped.');
    assert.equal((await request({ ...host, authority: new URL(restarted.publicOrigin).host }, '/api/bootstrap', { cookie })).status, 403);
    assert.equal((await pc.command({ type: 'ping' })).type, 'pong');
    return { newAuthority: true, unexpectedExitReported: true, staleAuthority: 403, desktopConnected: true };
  });
  await check('startup failure remains recoverable and does not leave a process', async () => {
    fs.writeFileSync(modeFile, 'error'); await pc.command({ type: 'internet_start', generation });
    await until(() => starts().length === 3, 'Failure fixture was not started.');
    await until(async () => (await snapshot()).status === 'error', 'Startup failure was not reported.');
    const failed = starts().at(-1); await until(() => !alive(failed.pid), 'Startup failure left a child.');
    assert.equal((await snapshot()).url, null); fs.writeFileSync(modeFile, 'ready');
    await pc.command({ type: 'internet_start', generation });
    await until(async () => (await snapshot()).status === 'ready', 'Recovery after startup failure did not connect.');
    return { failureReported: true, failedProcessReaped: true, retrySucceeded: true };
  });
  await check('host shutdown reaps an active tunnel and closes clients', async () => {
    const active = starts().at(-1); await stopHost(host); await until(() => !alive(active.pid), 'Host shutdown leaked its tunnel child.');
    assert.equal(pc.ws.readyState, WebSocket.CLOSED); return { activeTunnelReaped: true, clientsClosed: true };
  });
  await check('configured stable HTTPS origin preserves local access without spawning a tunnel', async () => {
    const stable = await startHost(workspace, state, ['--origin', 'https://stable.example.test']);
    const initialCount = starts().length;
    const direct = await request(stable, '/api/bootstrap', { token: stable.token }); assert.equal(direct.status, 200); assert.ok(!direct.setCookie.includes('; Secure'));
    const stablePc = await connect(stable, 'stable-pc-device', direct.cookie);
    const invitation = await stablePc.command({ type: 'pair_create', generation: stablePc.initial.generation, origin: 'https://stable.example.test' });
    secrets.add(invitation.invite); secrets.add(invitation.code);
    const publicResponse = await request({ ...stable, authority: 'stable.example.test' }, '/api/pair', { method:'POST', body:{code:invitation.code,invite:invitation.invite}, origin: 'https://stable.example.test' });
    assert.equal(publicResponse.status, 200); assert.ok(publicResponse.setCookie.includes('; Secure'));
    assert.equal(starts().length, initialCount); await stopHost(stable);
    return { localAccess: true, securePublicCookie: true, spawnedTunnelProcesses: 0 };
  });
  if (process.platform !== 'win32') for (const signal of ['SIGTERM', 'SIGHUP']) {
    await check(`${signal} closes the host and reaps its active tunnel`, async () => {
      const closing = await startHost(workspace, state);
      const auth = await request(closing, '/api/bootstrap', { token: closing.token });
      const client = await connect(closing, 'internet-signal-test', auth.cookie);
      await client.command({ type: 'internet_start', generation: client.initial.generation });
      await until(async () => (await request(closing, '/api/bootstrap', { cookie: auth.cookie })).value.internet.status === 'ready', 'Signal fixture did not become ready.');
      const active = starts().at(-1); await stopHost(closing, signal);
      await until(() => !alive(active.pid), `${signal} leaked its tunnel child.`);
      assert.equal(client.ws.readyState, WebSocket.CLOSED);
      return { signal, childReaped: true, clientClosed: true, hostExitCode: closing.child.exitCode };
    });
  }
}
main().catch(error => { console.error(safe(error)); process.exitCode = 1; }).finally(async () => {
  for (const ws of peers) ws.terminate();
  for (const host of hosts) await stopHost(host).catch(error => { console.error(safe(error)); host.child.kill('SIGKILL'); process.exitCode = 1; });
  if (records) for (const item of starts()) if (alive(item.pid)) { process.kill(item.pid, 'SIGKILL'); process.exitCode = 1; }
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify({ status: process.exitCode ? 'fail' : 'pass', date: new Date().toISOString(), binary,
    binarySha256: crypto.createHash('sha256').update(fs.readFileSync(binary)).digest('hex'),
    transport: 'Real loopback HTTP and WebSocket reverse proxy with fake cloudflared lifecycle; no public tunnel or Internet reachability claim.',
    aiInferenceRequests: 0, checks }, null, 2) + '\n');
  if (scratch && !process.exitCode) fs.rmSync(scratch, { recursive: true, force: true });
  else if (scratch) console.error('Retained disposable fixture: ' + scratch);
});
