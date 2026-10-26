#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const { generateKeyPairSync, sign } = require('node:crypto');
const { inspectZIP, releaseEnvelope, validatedIndex, parseArgs, validateProduction } = require('./deploy-updates.cjs');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const checks = [];
function check(name, fn) { fn(); checks.push(name); }
function rejects(name, fn) { check(name, () => assert.throws(fn)); }
function zip(entries, prefix = Buffer.alloc(0)) {
  const local = [prefix], central = []; let offset = prefix.length;
  for (const entry of entries) {
    const name = Buffer.from(entry.name), body = Buffer.from(entry.body || 'fixture');
    const extra = entry.extra || Buffer.alloc(0), flags = entry.flags || 0, method = entry.method || 0, expanded = entry.expanded ?? body.length;
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(flags, 6); header.writeUInt16LE(method, 8); header.writeUInt32LE(body.length, 18); header.writeUInt32LE(expanded, 22); header.writeUInt16LE(name.length, 26); header.writeUInt16LE(extra.length, 28);
    local.push(header, name, extra, body);
    const record = Buffer.alloc(46); record.writeUInt32LE(0x02014b50); record.writeUInt16LE((3 << 8) | 20, 4); record.writeUInt16LE(20, 6); record.writeUInt16LE(flags, 8); record.writeUInt16LE(method, 10); record.writeUInt32LE(body.length, 20); record.writeUInt32LE(expanded, 24); record.writeUInt16LE(name.length, 28); record.writeUInt16LE(extra.length, 30); record.writeUInt32LE(((entry.mode || 0o100644) * 65536) >>> 0, 38); record.writeUInt32LE(offset, 42);
    central.push(record, name, extra); offset += header.length + name.length + extra.length + body.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
const requiredEntries = [{ name: 'Nimlo.app/Contents/Info.plist' }, { name: 'Nimlo.app/Contents/MacOS/Nimlo' }];
check('safe bounded ZIP directory accepted', () => inspectZIP(zip(requiredEntries)));
rejects('ZIP traversal rejected', () => inspectZIP(zip([...requiredEntries, { name: '../escape' }])));
rejects('ZIP absolute path rejected', () => inspectZIP(zip([...requiredEntries, { name: '/tmp/escape' }])));
rejects('ZIP backslash path rejected', () => inspectZIP(zip([...requiredEntries, { name: 'Nimlo.app/..\\escape' }])));
rejects('ZIP alternate stream path rejected', () => inspectZIP(zip([...requiredEntries, { name: 'Nimlo.app/Contents:escape' }])));
rejects('ZIP symlink rejected', () => inspectZIP(zip([...requiredEntries, { name: 'Nimlo.app/link', mode: 0o120777 }])));
rejects('ZIP setuid file rejected', () => inspectZIP(zip([...requiredEntries, { name: 'Nimlo.app/setuid', mode: 0o104755 }])));
rejects('ZIP case-colliding path rejected', () => inspectZIP(zip([...requiredEntries, { name: 'Nimlo.app/contents/info.plist' }])));
rejects('ZIP hidden local bytes rejected', () => inspectZIP(zip(requiredEntries, Buffer.from('hidden'))));
rejects('ZIP unrelated metadata path rejected', () => inspectZIP(zip([...requiredEntries, { name: '__MACOSX/unrelated' }])));
rejects('ZIP encrypted flag rejected', () => inspectZIP(zip([{ ...requiredEntries[0], flags: 1 }, requiredEntries[1]])));
const unicodeExtra = Buffer.from([0x75, 0x70, 0, 0]);
rejects('ZIP alternate Unicode path field rejected', () => inspectZIP(zip([{ ...requiredEntries[0], extra: unicodeExtra }, requiredEntries[1]])));
rejects('ZIP missing required app file rejected', () => inspectZIP(zip([requiredEntries[0]])));
const entryBoundary = [...requiredEntries, ...Array.from({ length: 4094 }, (_, i) => ({ name: `Nimlo.app/Contents/Resources/bound-${i}`, body: Buffer.alloc(0) }))];
check('ZIP at client entry limit accepted', () => inspectZIP(zip(entryBoundary)));
rejects('ZIP exceeding client 4096-entry limit rejected', () => inspectZIP(zip([...entryBoundary, { name: 'Nimlo.app/Contents/Resources/one-too-many' }])));
const expansionBoundary = requiredEntries.map(entry => ({ ...entry, body: Buffer.alloc(150 * 1024), method: 8, expanded: 256 * 1024 * 1024 }));
check('ZIP metadata at client expansion limit accepted', () => inspectZIP(zip(expansionBoundary)));
rejects('ZIP metadata exceeding client 512-MiB expansion limit rejected', () => inspectZIP(zip(expansionBoundary.map((entry, i) => ({ ...entry, expanded: entry.expanded + i })))));
const keys = generateKeyPairSync('ed25519');
const publicText = keys.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64');
const project = 'nimlo-project', site = 'nimlo-updates';
const release = { schema: 1, bundleIdentifier: 'dev.nimlo.editor', version: '0.2.0', build: 2, publishedAt: '2026-10-15T00:00:00Z', minimumSystemVersion: '13.3', architecture: 'arm64', url: `https://${site}.web.app/stable/Nimlo-0.2.0-2-macos-arm64.zip`, size: 123, sha256: 'a'.repeat(64), releaseNotes: 'Fixture only.' };
function envelope(value) { const bytes = Buffer.from(JSON.stringify(value)); return { payload: bytes.toString('base64'), signature: sign(null, bytes, keys.privateKey).toString('base64') }; }
const signed = envelope(release);
check('valid site-bound signed manifest accepted', () => releaseEnvelope(Buffer.from(JSON.stringify(signed)), publicText, site));
check('signed unnotarized distribution is accepted', () => releaseEnvelope(Buffer.from(JSON.stringify(envelope({ ...release, distribution: 'unnotarized' }))), publicText, site));
check('explicit notarized distribution is accepted', () => releaseEnvelope(Buffer.from(JSON.stringify(envelope({ ...release, distribution: 'notarized' }))), publicText, site));
rejects('unknown signed distribution is rejected', () => releaseEnvelope(Buffer.from(JSON.stringify(envelope({ ...release, distribution: 'unsigned-automatic' }))), publicText, site));
rejects('tampered manifest rejected', () => releaseEnvelope(Buffer.from(JSON.stringify({ ...signed, payload: Buffer.from(JSON.stringify({ ...release, build: 3 })).toString('base64') })), publicText, site));
rejects('foreign archive site rejected', () => releaseEnvelope(Buffer.from(JSON.stringify(envelope({ ...release, url: release.url.replace(site, 'another-site') }))), publicText, site));
rejects('unsafe release notes rejected', () => releaseEnvelope(Buffer.from(JSON.stringify(envelope({ ...release, releaseNotes: '\0' }))), publicText, site));
const index = { schema: 1, kind: 'nimlo-update-hosting', project, site, publicKey: publicText, latestBuild: 2, releases: [signed] };
check('signed cumulative history accepted', () => validatedIndex(Buffer.from(JSON.stringify(index)), publicText, project, site));
rejects('duplicate historical builds rejected', () => validatedIndex(Buffer.from(JSON.stringify({ ...index, releases: [signed, signed] })), publicText, project, site));
rejects('foreign project history rejected', () => validatedIndex(Buffer.from(JSON.stringify({ ...index, project: 'other-project' })), publicText, project, site));
rejects('unrecognized existing content rejected', () => validatedIndex(Buffer.from('{"website":"other"}'), publicText, project, site));
check('explicit project/site arguments accepted', () => assert.equal(parseArgs(['--project', project, '--site', site, '--release-dir', '/tmp/fixture']).deploy, false));
check('unnotarized publishing requires explicit parsed flag', () => assert.equal(parseArgs(['--project', project, '--site', site, '--release-dir', '/tmp/fixture', '--unnotarized-release']).unnotarized, true));
rejects('implicit project selection rejected', () => parseArgs(['--site', site, '--release-dir', '/tmp/fixture']));
rejects('implicit site selection rejected', () => parseArgs(['--project', project, '--release-dir', '/tmp/fixture']));
rejects('unknown Firebase argument rejected', () => parseArgs(['--project', project, '--site', site, '--release-dir', '/tmp/fixture', '--force']));
const builtApp = path.join(__dirname, '../target/desktop/Nimlo.app');
if (process.platform === 'darwin' && fs.existsSync(builtApp)) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'nimlo-deploy-guard-'));
  fs.chmodSync(temporary, 0o700);
  const run = (exe, args) => {
    const result = spawnSync(exe, args, { encoding: 'utf8', timeout: 120000 });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout;
  };
  try {
    const app = path.join(temporary, 'Nimlo.app');
    run('/usr/bin/ditto', [builtApp, app]);
    const infoPath = path.join(app, 'Contents/Info.plist');
    for (const [field, value] of [['NimloUpdatePublicKey', publicText], ['NimloUpdateFeedURL', `https://${site}.web.app/stable/latest.json`]]) {
      spawnSync('/usr/libexec/PlistBuddy', ['-c', `Delete :${field}`, infoPath]);
      run('/usr/libexec/PlistBuddy', ['-c', `Add :${field} string ${value}`, infoPath]);
    }
    run('/usr/bin/codesign', ['--force', '--sign', '-', app]);
    const archive = path.join(temporary, 'fixture.zip');
    run('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, archive]);
    const data = fs.readFileSync(archive), info = JSON.parse(run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', infoPath]));
    const metadata = { ...release, version: info.CFBundleShortVersionString, build: Number(info.CFBundleVersion), minimumSystemVersion: info.LSMinimumSystemVersion, size: data.length, sha256: createHash('sha256').update(data).digest('hex') };
    const record = { release: metadata, filename: 'fixture.zip' };
    check('actual ditto app archive passes safe ZIP inspection', () => inspectZIP(data));
    check('ad-hoc signed app is refused before any Firebase operation', () => {
      assert.throws(() => validateProduction(archive, record, publicText, site, temporary), /Only Developer ID signed production archives/);
    });
    const unnotarized = { ...record, release: { ...metadata, distribution: 'unnotarized' } };
    check('unnotarized manifest without explicit deploy flag is rejected', () => assert.throws(() => validateProduction(archive, unnotarized, publicText, site, temporary), /signed distribution marker and explicit/));
    check('notarized manifest with unnotarized deploy flag is rejected', () => assert.throws(() => validateProduction(archive, record, publicText, site, temporary, true), /signed distribution marker and explicit/));
    const manualWork = path.join(temporary, 'manual'); fs.mkdirSync(manualWork);
    check('explicit signed unnotarized app passes full archive integrity validation', () => validateProduction(archive, unnotarized, publicText, site, manualWork, true));
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}
const report = { status: 'passed', count: checks.length, checks, networkUsed: false, deployed: false };
const reportPath = path.join(__dirname, '../target/update-release-review/firebase-deploy-guards.json');
fs.mkdirSync(path.dirname(reportPath), { recursive: true }); fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));
