#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { createHash, createPublicKey, verify } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const reportPath = path.join(root, 'target/update-release-review/release-tools.json');
const checks = [];
let temporary;
let lockProcess;

function check(name, condition) {
  assert.ok(condition, name);
  checks.push(name);
}
function run(executable, args, options = {}) {
  const result = spawnSync(executable, args, {
    cwd: root, encoding: 'utf8', timeout: 120000, maxBuffer: 256 * 1024,
    env: { ...process.env, NIMLO_RELEASE_SOURCE_ROOT: root }, ...options,
  });
  if (result.error) throw result.error;
  return result;
}
function required(executable, args, options) {
  const result = run(executable, args, options);
  assert.equal(result.status, 0, `${path.basename(executable)} failed: ${result.stderr || result.stdout}`);
  return result;
}
function invoke(args, succeeds, name, errorText) {
  const result = run(path.join(temporary, 'update-release'), args);
  check(name, (result.status === 0) === succeeds);
  if (errorText) check(`${name}: diagnostic`, result.stderr.includes(errorText));
  return result;
}
function signature(data) { return createHash('sha256').update(data).digest('hex'); }
function cleanup() {
  if (lockProcess && lockProcess.exitCode === null) lockProcess.kill('SIGTERM');
  if (temporary) fs.rmSync(temporary, { recursive: true, force: true });
}
function plist(info, field, value) {
  required('/usr/libexec/PlistBuddy', ['-c', `Delete :${field}`, info]);
  if (value !== undefined) required('/usr/libexec/PlistBuddy', ['-c', `Add :${field} string ${value}`, info]);
}
function setPlist(info, field, value) {
  const remove = run('/usr/libexec/PlistBuddy', ['-c', `Delete :${field}`, info]);
  assert.ok(remove.status === 0 || remove.stderr.includes('Does Not Exist') || remove.stdout.includes('Does Not Exist'), 'unexpected plist edit failure');
  if (value !== undefined) required('/usr/libexec/PlistBuddy', ['-c', `Add :${field} string ${value}`, info]);
}
async function heldLock(location, operation) {
  lockProcess = spawn(path.join(temporary, 'hold-lock'), [location], { stdio: ['pipe', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timed out starting output lock fixture.')), 10000);
    const finish = error => { clearTimeout(timeout); error ? reject(error) : resolve(); };
    lockProcess.once('error', finish);
    lockProcess.stdout.once('data', data => finish(data.toString().includes('locked') ? undefined : new Error('Lock fixture did not acquire the lock.')));
    lockProcess.once('exit', code => { if (code !== 0) finish(new Error(`Lock fixture exited: ${code}`)); });
  });
  try { operation(); }
  finally {
    const stopped = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Lock fixture did not stop.')), 10000);
      lockProcess.once('exit', code => { clearTimeout(timeout); code === 0 ? resolve() : reject(new Error(`Lock fixture exited: ${code}`)); });
    });
    lockProcess.stdin.end('x');
    await stopped;
    lockProcess = undefined;
  }
}
async function main() {
  assert.equal(process.platform, 'darwin', 'Release fixture requires macOS.');
  const builtApp = path.join(root, 'target/desktop/Nimlo.app');
  assert.ok(fs.existsSync(builtApp), 'Build target/desktop/Nimlo.app before running release checks.');
  temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'nimlo-release-check-'));
  fs.chmodSync(temporary, 0o700);
  const target = `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macosx13.3`;
  required('/usr/bin/xcrun', ['swiftc', '-O', '-target', target, path.join(root, 'scripts/UpdateRelease.swift'), '-o', path.join(temporary, 'update-release'), '-framework', 'Foundation', '-framework', 'CryptoKit']);
  const helperSource = path.join(temporary, 'HoldLock.swift');
  fs.writeFileSync(helperSource, `import Darwin\nlet fd = open(CommandLine.arguments[1], O_WRONLY | O_CREAT, 0o600)\nguard fd >= 0, flock(fd, LOCK_EX | LOCK_NB) == 0 else { exit(1) }\nprint("locked")\nfflush(stdout)\nvar byte: UInt8 = 0\n_ = read(STDIN_FILENO, &byte, 1)\nclose(fd)\n`);
  required('/usr/bin/xcrun', ['swiftc', '-O', '-target', target, helperSource, '-o', path.join(temporary, 'hold-lock')]);
  const key = path.join(temporary, 'private/update.key');
  const publicKey = path.join(temporary, 'public.txt');
  invoke(['keygen', '--private-key', key, '--public-key', publicKey], true, 'temporary key generation succeeds');
  check('private key has 32 raw bytes', fs.statSync(key).size === 32);
  check('private key mode is 0600', (fs.statSync(key).mode & 0o777) === 0o600);
  check('private key directory mode is 0700', (fs.statSync(path.dirname(key)).mode & 0o777) === 0o700);
  const publicText = fs.readFileSync(publicKey, 'utf8').trim();
  check('public key has 32 decoded bytes', Buffer.from(publicText, 'base64').length === 32);
  const originalKeyHash = signature(fs.readFileSync(key));
  invoke(['keygen', '--private-key', key, '--public-key', publicKey], false, 'existing key cannot be overwritten');
  check('existing private key is unchanged', signature(fs.readFileSync(key)) === originalKeyHash);
  const forbidden = path.join(root, 'target', `forbidden-release-key-${process.pid}-${Date.now()}`);
  invoke(['keygen', '--private-key', forbidden, '--public-key', path.join(temporary, 'forbidden-public.txt')], false, 'repository private key is refused');
  check('refused key was not created in repository', !fs.existsSync(forbidden));
  const app = path.join(temporary, 'Nimlo.app');
  required('/usr/bin/ditto', [builtApp, app]);
  const info = path.join(app, 'Contents/Info.plist');
  const sign = () => required('/usr/bin/codesign', ['--force', '--sign', '-', app]);
  setPlist(info, 'NimloUpdatePublicKey', publicText);
  setPlist(info, 'NimloUpdateFeedURL', 'https://feed.example.invalid/stable/latest.json');
  sign();
  const notes = path.join(temporary, 'notes.txt');
  fs.writeFileSync(notes, 'A release fixture.\nUnicode: fox 🦊.\n');
  const output = path.join(temporary, 'release');
  const args = ['prepare', '--app', app, '--private-key', key, '--base-url', 'https://assets.example.invalid/nimlo/stable/', '--notes', notes, '--output', output];
  plist(info, 'NimloUpdatePublicKey', undefined); sign();
  invoke([...args, '--local-preview'], false, 'preview rejects missing app key pin', 'NimloUpdatePublicKey must match');
  invoke([...args, '--unnotarized-release'], false, 'unnotarized release rejects missing app key pin', 'NimloUpdatePublicKey must match');
  setPlist(info, 'NimloUpdatePublicKey', Buffer.alloc(32, 120).toString('base64')); sign();
  invoke([...args, '--local-preview'], false, 'preview rejects mismatched app key pin', 'NimloUpdatePublicKey must match');
  setPlist(info, 'NimloUpdatePublicKey', publicText);
  plist(info, 'NimloUpdateFeedURL', undefined); sign();
  invoke(args, false, 'production rejects missing app feed', 'nonempty HTTPS NimloUpdateFeedURL');
  invoke([...args, '--unnotarized-release'], false, 'unnotarized release still requires HTTPS feed', 'nonempty HTTPS NimloUpdateFeedURL');
  setPlist(info, 'NimloUpdateFeedURL', 'http://feed.example.invalid/stable/latest.json'); sign();
  invoke(args, false, 'production rejects insecure app feed', 'NimloUpdateFeedURL must be a valid HTTPS URL');
  setPlist(info, 'NimloUpdateFeedURL', 'https://feed.example.invalid/stable/latest.json'); sign();
  invoke(args, false, 'production rejects ad-hoc distribution', 'Developer ID Application');
  check('failed production preparation creates no manifest', !fs.existsSync(path.join(output, 'latest.json')));
  invoke([...args, '--local-preview', '--unnotarized-release'], false, 'preview and unnotarized release flags conflict', 'mutually exclusive');
  const publicOutput = path.join(temporary, 'unnotarized-release');
  const publicArgs = [...args]; publicArgs[publicArgs.indexOf('--output') + 1] = publicOutput;
  invoke([...publicArgs, '--unnotarized-release'], true, 'explicit unnotarized release packages ad-hoc app');
  const publicManifest = path.join(publicOutput, 'latest.json');
  const publicEnvelope = JSON.parse(fs.readFileSync(publicManifest));
  const publicPayload = Buffer.from(publicEnvelope.payload, 'base64');
  check('unnotarized distribution is authenticated in signed payload', JSON.parse(publicPayload).distribution === 'unnotarized');
  const publicSPKI = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(publicText, 'base64')]);
  check('independent signature verification accepts unnotarized release', verify(null, publicPayload, createPublicKey({ key: publicSPKI, type: 'spki', format: 'der' }), Buffer.from(publicEnvelope.signature, 'base64')));
  invoke(['verify', '--manifest', publicManifest, '--public-key', publicKey], true, 'unnotarized release verifies');
  // Empty feed is allowed only for an explicit preview; release key pin remains mandatory.
  setPlist(info, 'NimloUpdateFeedURL', ''); sign();
  invoke([...args, '--local-preview'], true, 'explicit preview packages without production feed');
  const manifest = path.join(output, 'latest.json');
  const manifestBytes = fs.readFileSync(manifest);
  const envelope = JSON.parse(manifestBytes);
  const payload = Buffer.from(envelope.payload, 'base64');
  const release = JSON.parse(payload);
  check('private preview is not marked as a publishable unnotarized release', release.distribution === undefined);
  check('signed payload contains the exact release schema', JSON.stringify(Object.keys(release).sort()) === JSON.stringify(['schema', 'bundleIdentifier', 'version', 'build', 'publishedAt', 'minimumSystemVersion', 'architecture', 'url', 'size', 'sha256', 'releaseNotes'].sort()));
  check('Unicode release notes are preserved', release.releaseNotes === fs.readFileSync(notes, 'utf8'));
  const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(publicText, 'base64')]);
  check('independent Ed25519 verification accepts exact payload', verify(null, payload, createPublicKey({ key: spki, type: 'spki', format: 'der' }), Buffer.from(envelope.signature, 'base64')));
  const archive = path.join(output, path.basename(new URL(release.url).pathname));
  check('archive size matches signed metadata', fs.statSync(archive).size === release.size);
  check('archive digest matches signed metadata', signature(fs.readFileSync(archive)) === release.sha256);
  const entries = required('/usr/bin/unzip', ['-Z1', archive]).stdout.split('\n');
  check('archive contains Nimlo.app', entries.some(name => name.startsWith('Nimlo.app/Contents/')));
  check('archive does not contain temporary private key', !entries.some(name => name.endsWith('update.key')));
  invoke(['verify', '--manifest', manifest, '--public-key', publicKey], true, 'valid release verifies');
  invoke([...args, '--local-preview'], false, 'same build cannot replace latest release');
  check('same-build refusal leaves existing manifest unchanged', fs.readFileSync(manifest).equals(manifestBytes));
  await heldLock(path.join(output, '.prepare.lock'), () => invoke([...args, '--local-preview'], false, 'concurrent output preparation is refused', 'Another release preparation'));
  const leak = path.join(app, 'Contents/Resources/accidental-private-file');
  fs.copyFileSync(key, leak);
  invoke([...args, '--local-preview'], false, 'copied private signing key is refused', 'contains the private update signing key');
  fs.unlinkSync(leak); fs.symlinkSync(key, leak);
  invoke([...args, '--local-preview'], false, 'external bundle symlink is refused', 'symlink outside');
  fs.unlinkSync(leak);
  const tampered = path.join(temporary, 'tampered.json');
  const changed = { ...release, build: release.build + 1 };
  fs.writeFileSync(tampered, JSON.stringify({ ...envelope, payload: Buffer.from(JSON.stringify(changed)).toString('base64') }));
  invoke(['verify', '--manifest', tampered, '--public-key', publicKey], false, 'tampered payload signature is rejected');
  const otherKey = path.join(temporary, 'other-private/update.key');
  const otherPublic = path.join(temporary, 'other-public.txt');
  invoke(['keygen', '--private-key', otherKey, '--public-key', otherPublic], true, 'second independent temporary key generation succeeds');
  invoke(['verify', '--manifest', manifest, '--public-key', otherPublic], false, 'wrong public key is rejected');
  const oversized = path.join(temporary, 'oversized.json'); fs.writeFileSync(oversized, Buffer.alloc(65537, 32));
  invoke(['verify', '--manifest', oversized, '--public-key', publicKey], false, 'oversized manifest is rejected');
  fs.chmodSync(key, 0o644);
  invoke([...args, '--local-preview'], false, 'exposed private key permissions are rejected');
  fs.chmodSync(key, 0o600);
  for (const [url, name] of [['http://assets.example.invalid/', 'HTTP archive base is refused'], ['https://user:pass@assets.example.invalid/', 'credential-bearing archive base is refused']]) {
    const insecure = [...args]; insecure[insecure.indexOf('--base-url') + 1] = url;
    invoke([...insecure, '--local-preview'], false, name);
  }
  const report = { status: 'passed', count: checks.length, checks, temporaryFixturesOnly: true, productionPrivateKeyRead: false, actualAppChanged: false };
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
}
main().catch(error => {
  const report = { status: 'failed', count: checks.length, checks, error: error.message };
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
  console.error(error.stack || error.message);
  process.exitCode = 1;
}).finally(cleanup);
