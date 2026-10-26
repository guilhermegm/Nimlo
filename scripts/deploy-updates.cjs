#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { createHash, createPublicKey, verify } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const archiveLimit = 256 * 1024 * 1024;
const indexLimit = 8 * 1024 * 1024;
function fail(message) { throw new Error(message); }
function run(executable, args, cwd) {
  const result = spawnSync(executable, args, { cwd: cwd || root, encoding: 'utf8', timeout: 120000, maxBuffer: 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) fail(`${path.basename(executable)} failed: ${(result.stderr || result.stdout).trim()}`);
  return result.stdout + (executable.endsWith('codesign') ? result.stderr : '');
}
function boundedFile(location, limit) {
  const info = fs.lstatSync(location);
  assert.ok(info.isFile() && info.size <= limit, `${path.basename(location)} must be a bounded regular file.`);
  return fs.readFileSync(location);
}
function base64(text, size) {
  assert.ok(typeof text === 'string' && /^[A-Za-z0-9+/]*={0,2}$/.test(text), 'Invalid base64 encoding.');
  const bytes = Buffer.from(text, 'base64');
  assert.ok(bytes.toString('base64') === text && (size === undefined || bytes.length === size), 'Invalid base64 length or encoding.');
  return bytes;
}
function keyObject(publicText) {
  return createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), base64(publicText, 32)]), type: 'spki', format: 'der' });
}
function releaseEnvelope(bytes, publicText, site) {
  assert.ok(bytes.length <= 65536, 'Manifest is too large.');
  const envelope = JSON.parse(bytes.toString('utf8'));
  const payload = base64(envelope.payload);
  assert.ok(payload.length <= 32768 && verify(null, payload, keyObject(publicText), base64(envelope.signature, 64)), 'Manifest signature is invalid.');
  const release = JSON.parse(payload.toString('utf8'));
  assert.ok(release.schema === 1 && release.bundleIdentifier === 'dev.nimlo.editor' && Number.isSafeInteger(release.build) && release.build > 0, 'Invalid release identity/build.');
  assert.ok(release.distribution === undefined || ['notarized', 'unnotarized'].includes(release.distribution), 'Unknown release distribution.');
  assert.ok(typeof release.version === 'string' && /^\d+(\.\d+){1,3}$/.test(release.version) && release.version.length <= 32, 'Invalid release version.');
  assert.ok(['arm64', 'x86_64', 'universal'].includes(release.architecture) && /^\d+(\.\d+){1,2}$/.test(release.minimumSystemVersion), 'Invalid release compatibility.');
  assert.ok(Number.isSafeInteger(release.size) && release.size > 0 && release.size <= archiveLimit && /^[0-9a-f]{64}$/.test(release.sha256), 'Invalid archive metadata.');
  assert.ok(typeof release.releaseNotes === 'string' && Buffer.byteLength(release.releaseNotes) <= 16384 && !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(release.releaseNotes) && Number.isFinite(Date.parse(release.publishedAt)), 'Invalid release notes/date.');
  const filename = `Nimlo-${release.version}-${release.build}-macos-${release.architecture}.zip`;
  assert.equal(release.url, `https://${site}.web.app/stable/${filename}`, 'This Hosting helper requires archive URLs on the selected dedicated site at /stable/.');
  return { envelope, release, filename };
}
function validatedIndex(bytes, publicText, project, site) {
  assert.ok(bytes.length <= indexLimit, 'Managed release history is too large.');
  const index = JSON.parse(bytes);
  assert.ok(index.schema === 1 && index.kind === 'nimlo-update-hosting' && index.project === project && index.site === site && index.publicKey === publicText && Array.isArray(index.releases), 'Site is not managed by this release channel/key.');
  let previous = 0;
  const releases = index.releases.map(envelope => {
    const record = releaseEnvelope(Buffer.from(JSON.stringify(envelope)), publicText, site);
    assert.ok(record.release.build > previous, 'Release history contains duplicate or unordered builds.');
    previous = record.release.build;
    return record;
  });
  assert.ok(releases.length > 0 && index.latestBuild === previous, 'Managed release history has no valid latest build.');
  return releases;
}
async function responseBytes(url, limit, missing = false) {
  const response = await fetch(url, { redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(20000) });
  if (response.status === 404 && missing) return null;
  assert.ok(response.ok, `Cannot read ${url}: HTTP ${response.status}.`);
  const chunks = []; let total = 0;
  for await (const chunk of response.body) {
    total += chunk.length;
    assert.ok(total <= limit, `Remote metadata exceeds ${limit} bytes.`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
function sameEnvelope(a, b) { return a.payload === b.payload && a.signature === b.signature; }
function inspectZIP(data) {
  assert.ok(data.length >= 22 && data.length <= archiveLimit, 'Invalid ZIP size.');
  let end = -1;
  for (let i = data.length - 22; i >= Math.max(0, data.length - 65557); --i) {
    if (data.readUInt32LE(i) === 0x06054b50 && i + 22 + data.readUInt16LE(i + 20) === data.length) { end = i; break; }
  }
  assert.ok(end >= 0, 'ZIP directory is missing.');
  const count = data.readUInt16LE(end + 10), offset = data.readUInt32LE(end + 16), length = data.readUInt32LE(end + 12);
  assert.ok(data.readUInt16LE(end + 4) === 0 && data.readUInt16LE(end + 6) === 0 && data.readUInt16LE(end + 8) === count && count > 0 && count <= 4096 && offset + length === end, 'Unsupported ZIP layout.');
  function extras(start, size) {
    const stop = start + size;
    for (let i = start; i < stop;) {
      assert.ok(i + 4 <= stop, 'Truncated ZIP extra field.');
      const tag = data.readUInt16LE(i), count = data.readUInt16LE(i + 2);
      assert.ok([0x5455, 0x5855, 0x7855, 0x7875].includes(tag) && count <= 32 && i + 4 + count <= stop, 'Unsupported ZIP path/link/ZIP64 extra field.');
      i += 4 + count;
    }
  }
  let at = offset, total = 0; const names = new Set(), ranges = [];
  for (let n = 0; n < count; n++) {
    assert.ok(at + 46 <= end && data.readUInt32LE(at) === 0x02014b50, 'Invalid ZIP central entry.');
    const flags = data.readUInt16LE(at + 8), method = data.readUInt16LE(at + 10), crc = data.readUInt32LE(at + 16), compressed = data.readUInt32LE(at + 20), expanded = data.readUInt32LE(at + 24);
    const nameLength = data.readUInt16LE(at + 28), extraLength = data.readUInt16LE(at + 30), commentLength = data.readUInt16LE(at + 32), local = data.readUInt32LE(at + 42);
    const unixMode = data.readUInt32LE(at + 38) >>> 16, mode = unixMode & 0o170000;
    assert.ok(!(flags & ~0x080e) && [0, 8].includes(method) && data.readUInt16LE(at + 34) === 0 && ![compressed, expanded, local].includes(0xffffffff) && nameLength > 0 && nameLength <= 1024 && at + 46 + nameLength + extraLength + commentLength <= end, 'Unsupported ZIP entry.');
    const raw = data.subarray(at + 46, at + 46 + nameLength), name = raw.toString('utf8');
    const parts = name.replace(/\/$/, '').split('/');
    assert.ok(Buffer.from(name).equals(raw) && !name.includes('\\') && !name.includes(':') && !/[\x00-\x1f\x7f]/.test(name) && !parts.some(part => !part || part === '.' || part === '..') && (parts[0] === 'Nimlo.app' || (parts[0] === '__MACOSX' && ((parts.length === 1 && name.endsWith('/')) || parts[1] === 'Nimlo.app'))), 'Unsafe ZIP path.');
    assert.ok((mode === 0 || mode === 0o100000 || (mode === 0o040000 && name.endsWith('/'))) && !(unixMode & 0o6000) && (!name.endsWith('/') || expanded === 0) && (method !== 0 || compressed === expanded), 'ZIP links or special files are unsupported.');
    const normalized = name.replace(/\/$/, '').normalize('NFC').toLowerCase();
    assert.ok(!names.has(normalized), 'Duplicate ZIP path.'); names.add(normalized);
    extras(at + 46 + nameLength, extraLength);
    assert.ok(local + 30 <= offset && data.readUInt32LE(local) === 0x04034b50 && data.readUInt16LE(local + 6) === flags && data.readUInt16LE(local + 8) === method, 'Invalid ZIP local header.');
    const localNameLength = data.readUInt16LE(local + 26), localExtraLength = data.readUInt16LE(local + 28);
    let finish = local + 30 + localNameLength + localExtraLength + compressed;
    assert.ok(finish <= offset && localNameLength === nameLength && data.subarray(local + 30, local + 30 + localNameLength).equals(raw), 'ZIP entry overruns or mismatched filename.');
    extras(local + 30 + localNameLength, localExtraLength);
    if (flags & 8) {
      const descriptor = finish + (finish + 4 <= offset && data.readUInt32LE(finish) === 0x08074b50 ? 4 : 0);
      assert.ok(descriptor + 12 <= offset && data.readUInt32LE(descriptor) === crc && data.readUInt32LE(descriptor + 4) === compressed && data.readUInt32LE(descriptor + 8) === expanded, 'Invalid ZIP streaming descriptor.');
      finish = descriptor + 12;
    } else assert.ok(data.readUInt32LE(local + 14) === crc && data.readUInt32LE(local + 18) === compressed && data.readUInt32LE(local + 22) === expanded, 'Inconsistent ZIP local sizes.');
    ranges.push([local, finish]);
    total += expanded;
    assert.ok(total <= 512 * 1024 * 1024 && expanded <= Math.max(1, compressed) * 2000, 'ZIP extraction limits exceeded.');
    at += 46 + nameLength + extraLength + commentLength;
  }
  assert.equal(at, end, 'Invalid ZIP directory size.');
  assert.ok(names.has('nimlo.app/contents/info.plist') && names.has('nimlo.app/contents/macos/nimlo'), 'ZIP is missing required Nimlo files.');
  ranges.sort((a, b) => a[0] - b[0]);
  let position = 0;
  for (const range of ranges) { assert.equal(range[0], position, 'ZIP has hidden or overlapping local records.'); position = range[1]; }
  assert.equal(position, offset, 'ZIP has unlisted local data.');
}
function validateArchive(archive, record) {
  const data = boundedFile(archive, archiveLimit);
  assert.ok(data.length === record.release.size && createHash('sha256').update(data).digest('hex') === record.release.sha256, `Archive bytes do not match the signed release: ${record.filename}.`);
  return data;
}
function validateProduction(archive, record, publicText, site, work, unnotarizedRelease = false) {
  assert.equal(record.release.distribution === 'unnotarized', unnotarizedRelease, 'Unnotarized releases require both the signed distribution marker and explicit --unnotarized-release.');
  inspectZIP(validateArchive(archive, record));
  const extracted = path.join(work, 'extracted'); fs.mkdirSync(extracted, { mode: 0o700 });
  run('/usr/bin/ditto', ['-x', '-k', archive, extracted]);
  const app = path.join(extracted, 'Nimlo.app');
  const entries = fs.readdirSync(extracted); assert.ok(entries.every(name => ['Nimlo.app', '__MACOSX'].includes(name)), 'Unexpected extracted content.');
  const info = JSON.parse(run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path.join(app, 'Contents/Info.plist')]));
  assert.ok(info.CFBundleIdentifier === 'dev.nimlo.editor' && info.CFBundleShortVersionString === record.release.version && String(info.CFBundleVersion) === String(record.release.build) && info.LSMinimumSystemVersion === record.release.minimumSystemVersion && info.NimloUpdatePublicKey === publicText, 'Archive app does not match signed metadata or update key.');
  assert.equal(info.NimloUpdateFeedURL, `https://${site}.web.app/stable/latest.json`, 'Archive app must follow this dedicated site feed.');
  assert.ok(/^[A-Za-z0-9 _-]+$/.test(info.CFBundleExecutable), 'Invalid native executable name.');
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
  const host = path.join(app, 'Contents/Resources/nimlo-editor');
  const helper = path.join(app, 'Contents/Helpers/nimlo-update-helper');
  const executables = [path.join(app, 'Contents/MacOS', info.CFBundleExecutable), host, helper];
  for (const executable of executables) {
    run('/usr/bin/codesign', ['--verify', '--strict', executable]);
    const architectures = run('/usr/bin/lipo', ['-archs', executable]).trim().split(/\s+/).sort();
    assert.equal(architectures.join(' '), record.release.architecture === 'universal' ? 'arm64 x86_64' : record.release.architecture, 'Archive executable architecture does not match manifest.');
  }
  if (unnotarizedRelease) return;
  const team = file => {
    const output = run('/usr/bin/codesign', ['--display', '--verbose=4', file]);
    const found = output.match(/^TeamIdentifier=([A-Z0-9]{10})$/m);
    assert.ok(output.includes('Authority=Developer ID Application:') && found, 'Only Developer ID signed production archives can be deployed.');
    return found[1];
  };
  const appTeam = team(app);
  assert.equal(appTeam, team(host), 'App and host signing teams must match.');
  assert.equal(appTeam, team(helper), 'App and updater helper signing teams must match.');
  run('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=2', app]);
  run('/usr/bin/xcrun', ['stapler', 'validate', app]);
}
function firebaseJSON(args, cwd) {
  const result = JSON.parse(run('firebase', [...args, '--json', '--non-interactive'], cwd));
  assert.equal(result.status, 'success', 'Firebase read failed.');
  return result.result;
}
function hostingReadClient() {
  // Use the same installed CLI/account as the deploy commands. Credentials stay
  // inside its authentication middleware and are never printed or passed in argv.
  const executable = (process.env.PATH || '').split(path.delimiter).map(directory => path.join(directory, 'firebase')).find(file => {
    try { fs.accessSync(file, fs.constants.X_OK); return true; } catch { return false; }
  });
  assert.ok(executable, 'Firebase CLI is unavailable.');
  let directory = path.dirname(fs.realpathSync(executable)), packageRoot;
  for (let depth = 0; depth < 5; depth++) {
    const packageFile = path.join(directory, 'package.json');
    if (fs.existsSync(packageFile) && JSON.parse(fs.readFileSync(packageFile)).name === 'firebase-tools') { packageRoot = directory; break; }
    directory = path.dirname(directory);
  }
  assert.ok(packageRoot, 'Cannot locate Firebase CLI authentication/API modules; refusing to skip live inventory verification.');
  const auth = require(path.join(packageRoot, 'lib/auth.js'));
  const { Client } = require(path.join(packageRoot, 'lib/apiv2.js'));
  assert.ok(typeof auth.getGlobalDefaultAccount === 'function' && typeof auth.setActiveAccount === 'function' && typeof Client === 'function', 'Unsupported Firebase CLI API modules.');
  const account = auth.getGlobalDefaultAccount();
  assert.ok(account, 'A Firebase CLI login is required to verify the live Hosting file inventory.');
  auth.setActiveAccount({}, account);
  return new Client({ urlPrefix: 'https://firebasehosting.googleapis.com', apiVersion: 'v1beta1', auth: true });
}
async function hostingVersionFiles(project, site, versionName, client) {
  const match = typeof versionName === 'string' && versionName.match(/^(?:projects\/[^/]+\/)?sites\/([^/]+)\/versions\/([A-Za-z0-9_-]+)$/);
  assert.ok(match && match[1] === site, 'Live version does not belong to the selected Hosting site.');
  client ||= hostingReadClient();
  const files = [], tokens = new Set(); let pageToken;
  do {
    const response = await client.get(`/projects/${project}/sites/${site}/versions/${match[2]}/files`, { queryParams: { status: 'ACTIVE', pageSize: 1000, ...(pageToken ? { pageToken } : {}) } });
    assert.ok(response.body && Array.isArray(response.body.files || []), 'Invalid Hosting file inventory response.');
    files.push(...(response.body.files || []));
    assert.ok(files.length <= 10000, 'Hosting file inventory exceeds the managed release limit.');
    pageToken = response.body.nextPageToken;
    assert.ok(!pageToken || (typeof pageToken === 'string' && pageToken.length <= 4096 && !tokens.has(pageToken)), 'Invalid or repeating Hosting inventory pagination token.');
    if (pageToken) tokens.add(pageToken);
  } while (pageToken);
  return files;
}
function validateHostingInventory(files, records, reportedCount) {
  const expected = new Set(['/nimlo-updates.json', '/stable/latest.json', ...records.map(record => '/stable/' + record.filename)]);
  // Firebase adds these documented reserved SDK configuration files itself;
  // they are regenerated by Hosting, not copied from the local release store.
  const reserved = new Set(['/__/firebase/init.js', '/__/firebase/init.json']);
  assert.ok(Array.isArray(files) && Number.isSafeInteger(Number(reportedCount)) && Number(reportedCount) === files.length, 'Hosting inventory count disagrees with the live version.');
  const found = new Set();
  for (const file of files) {
    assert.ok(file && typeof file.path === 'string' && !found.has(file.path) && file.status === 'ACTIVE' && /^[0-9a-f]{64}$/.test(file.hash), 'Hosting inventory contains duplicate or inactive/malformed files.');
    assert.ok(expected.has(file.path) || reserved.has(file.path), `Remote site contains an unmanaged file: ${file.path}. Refusing a snapshot replacement.`);
    found.add(file.path);
  }
  for (const filename of expected) assert.ok(found.has(filename), `Remote site is missing managed file ${filename}. Refusing a snapshot replacement.`);
  return { managed: expected.size, firebaseReserved: [...found].filter(filename => reserved.has(filename)).length };
}
function parseArgs(args) {
  const options = { deploy: false, initialize: false, unnotarized: false };
  for (let i = 0; i < args.length; i++) {
    const value = args[i];
    if (value === '--deploy') { assert.ok(!options.deploy, 'Duplicate deploy option.'); options.deploy = true; }
    else if (value === '--unnotarized-release') { assert.ok(!options.unnotarized, 'Duplicate unnotarized option.'); options.unnotarized = true; }
    else if (value === '--initialize-empty-site') { assert.ok(!options.initialize, 'Duplicate initialization option.'); options.initialize = true; }
    else {
      assert.ok(['--project', '--site', '--release-dir', '--state-dir', '--public-key'].includes(value) && i + 1 < args.length && options[value] === undefined, `Unknown or duplicate option: ${value}`);
      options[value] = args[++i];
    }
  }
  for (const value of ['--project', '--site', '--release-dir']) assert.ok(options[value], `${value} is required.`);
  assert.ok(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(options['--project']) && /^[a-z0-9][a-z0-9-]{4,28}[a-z0-9]$/.test(options['--site']), 'Use explicit Firebase project and site IDs.');
  return options;
}
async function main(args) {
  const options = parseArgs(args), project = options['--project'], site = options['--site'];
  const releaseDirectory = fs.realpathSync(options['--release-dir']);
  const state = path.resolve(options['--state-dir'] || path.join(root, 'target/firebase-updates', project, site));
  const publicText = boundedFile(options['--public-key'] || path.join(root, 'desktop/macos/UpdatePublicKey.txt'), 1024).toString().trim();
  const candidate = releaseEnvelope(boundedFile(path.join(releaseDirectory, 'latest.json'), 65536), publicText, site);
  assert.equal(process.platform, 'darwin', 'Production release validation requires macOS.');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'nimlo-firebase-updates-')); fs.chmodSync(work, 0o700);
  const lock = path.join(state, '.deploy.lock'); let locked = false;
  try {
    fs.mkdirSync(state, { recursive: true });
    try { fs.mkdirSync(lock, { mode: 0o700 }); locked = true; }
    catch (error) { if (error.code === 'EEXIST') fail('Another deployment owns this cumulative release store. Serialize publishers; inspect an abandoned .deploy.lock before removing it.'); throw error; }
    fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    const config = JSON.parse(fs.readFileSync(path.join(root, 'hosting/updates/firebase.template.json')));
    const stage = path.join(work, 'public'), stable = path.join(stage, 'stable'); fs.mkdirSync(stable, { recursive: true });
    fs.writeFileSync(path.join(work, 'firebase.json'), JSON.stringify(config, null, 2));
    fs.writeFileSync(path.join(work, '.firebaserc'), JSON.stringify({ projects: { default: project }, targets: { [project]: { hosting: { 'nimlo-updates': [site] } } } }, null, 2));
    validateProduction(path.join(releaseDirectory, candidate.filename), candidate, publicText, site, work, options.unnotarized);
    const sites = firebaseJSON(['hosting:sites:list', '--project', project], work).sites;
    assert.ok(Array.isArray(sites) && sites.some(entry => entry.name === `projects/${project}/sites/${site}` || entry.name.endsWith(`/sites/${site}`)), 'Selected site does not belong to the selected project.');
    const channels = () => firebaseJSON(['hosting:channel:list', '--site', site, '--project', project, '--config', path.join(work, 'firebase.json')], work).channels;
    const live = channels().find(entry => entry.name.endsWith('/channels/live'));
    const indexURL = `https://${site}.web.app/nimlo-updates.json`;
    const oldBytes = await responseBytes(indexURL, indexLimit, true);
    let previous = [];
    if (!oldBytes) {
      assert.ok(!live?.release && options.initialize, 'Refusing an unrecognized site. First deployment requires --initialize-empty-site and a dedicated site with no live release.');
    } else {
      previous = validatedIndex(oldBytes, publicText, project, site);
      assert.ok(live?.release?.version, 'Managed release history has no live Firebase version.');
      const inventory = await hostingVersionFiles(project, site, live.release.version.name);
      validateHostingInventory(inventory, previous, live.release.version.fileCount);
      const latest = releaseEnvelope(await responseBytes(`https://${site}.web.app/stable/latest.json`, 65536), publicText, site);
      assert.ok(sameEnvelope(latest.envelope, previous.at(-1).envelope), 'Remote feed differs from managed release history.');
      assert.ok(candidate.release.build > latest.release.build || sameEnvelope(candidate.envelope, latest.envelope), 'Refusing a lower or conflicting release build.');
    }
    const records = previous.some(record => sameEnvelope(record.envelope, candidate.envelope)) ? previous : [...previous, candidate];
    for (const record of records) {
      const sources = [path.join(releaseDirectory, record.filename), path.join(state, 'public/stable', record.filename)];
      const source = sources.find(location => fs.existsSync(location));
      assert.ok(source, `Missing immutable historical archive ${record.filename}. Restore the cumulative release store before deploying; old downloads must remain available.`);
      validateArchive(source, record);
      fs.copyFileSync(source, path.join(stable, record.filename));
    }
    const index = { schema: 1, kind: 'nimlo-update-hosting', project, site, publicKey: publicText, latestBuild: records.at(-1).release.build, releases: records.map(record => record.envelope) };
    const nextBytes = Buffer.from(JSON.stringify(index, null, 2) + '\n'); assert.ok(nextBytes.length <= indexLimit, 'Managed history exceeds its configured bound.');
    fs.writeFileSync(path.join(stage, 'nimlo-updates.json'), nextBytes);
    fs.writeFileSync(path.join(stable, 'latest.json'), JSON.stringify(candidate.envelope, null, 2) + '\n');
    console.log(`Validated Nimlo build ${candidate.release.build}; ${records.length} immutable archives retained for ${project}/${site}.`);
    if (options.unnotarized) console.log('Unnotarized release: clients must offer verified manual installation. macOS quarantine and Gatekeeper remain active.');
    if (!options.deploy) { console.log('Preflight only. Add --deploy to publish this dedicated update site.'); return; }
    const recheck = await responseBytes(indexURL, indexLimit, true);
    assert.ok((!oldBytes && !recheck) || (oldBytes && recheck && oldBytes.equals(recheck)), 'The release history changed during preflight; retry to preserve the newer deployment.');
    const currentLive = channels().find(entry => entry.name.endsWith('/channels/live'));
    assert.equal(currentLive?.release?.name, live?.release?.name, 'The live Hosting version changed during preflight; retry.');
    run('firebase', ['deploy', '--project', project, '--config', path.join(work, 'firebase.json'), '--only', 'hosting:nimlo-updates', '--non-interactive', '--json', '--message', `Nimlo ${candidate.release.version} build ${candidate.release.build}`], work);
    const published = await responseBytes(`https://${site}.web.app/stable/latest.json`, 65536);
    assert.ok(sameEnvelope(releaseEnvelope(published, publicText, site).envelope, candidate.envelope), 'Published manifest did not match the intended release.');
    fs.mkdirSync(state, { recursive: true });
    const next = path.join(state, `.public-${Date.now()}`); fs.cpSync(stage, next, { recursive: true });
    const current = path.join(state, 'public'), backup = path.join(state, `.previous-${Date.now()}`);
    if (fs.existsSync(current)) fs.renameSync(current, backup);
    fs.renameSync(next, current); fs.rmSync(backup, { recursive: true, force: true });
    console.log(`Published ${project}/${site}: https://${site}.web.app/stable/latest.json`);
    console.log(`Keep the cumulative release store backed up: ${state}`);
  } finally { fs.rmSync(work, { recursive: true, force: true }); if (locked) fs.rmSync(lock, { recursive: true, force: true }); }
}
module.exports = { inspectZIP, releaseEnvelope, validatedIndex, parseArgs, validateProduction, hostingVersionFiles, validateHostingInventory };
if (require.main === module) main(process.argv.slice(2)).catch(error => { console.error(`Update deployment stopped: ${error.message}`); process.exitCode = 1; });
