#!/usr/bin/env node
'use strict';
// Pure file-inventory fixtures: no CLI account, network, app, ZIP or compiler.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { hostingVersionFiles, validateHostingInventory } = require('./deploy-updates.cjs');
const checks = [];
function check(name, action) { action(); checks.push(name); }
function rejects(name, action) { check(name, () => assert.throws(action)); }
const records = [{ filename: 'Nimlo-0.2.0-2-macos-arm64.zip' }];
const active = name => ({ path: name, hash: 'a'.repeat(64), status: 'ACTIVE' });
const managed = ['/nimlo-updates.json', '/stable/latest.json', '/stable/' + records[0].filename].map(active);
const actual = [...managed, active('/__/firebase/init.js'), active('/__/firebase/init.json')];
check('actual Firebase five-file shape preserves three managed release files', () => assert.deepEqual(validateHostingInventory(actual, records, '5'), { managed: 3, firebaseReserved: 2 }));
check('versions without generated Firebase init files remain supported', () => assert.deepEqual(validateHostingInventory(managed, records, '3'), { managed: 3, firebaseReserved: 0 }));
rejects('unknown file cannot hide behind unchanged five-file count', () => validateHostingInventory([...managed, active('/index.html'), active('/__/firebase/init.json')], records, '5'));
rejects('unknown reserved-namespace file is not broadly allowed', () => validateHostingInventory([...managed, active('/__/firebase/other.js')], records, '4'));
rejects('missing historical archive remains blocked', () => validateHostingInventory(actual.filter(file => !file.path.endsWith('.zip')), records, '4'));
rejects('duplicate inventory paths remain blocked', () => validateHostingInventory([...actual, actual[0]], records, '6'));
rejects('inactive inventory entry remains blocked', () => validateHostingInventory(actual.map((file, i) => i ? file : { ...file, status: 'EXPECTED' }), records, '5'));
rejects('malformed inventory hash remains blocked', () => validateHostingInventory(actual.map((file, i) => i ? file : { ...file, hash: 'wrong' }), records, '5'));
rejects('reported file count must match complete enumerated inventory', () => validateHostingInventory(actual, records, '6'));
rejects('absent file count cannot disable complete inventory validation', () => validateHostingInventory(actual, records, undefined));
(async () => {
  const requests = [];
  const client = { async get(url, options) {
    requests.push({ url, query: options.queryParams });
    return options.queryParams.pageToken ? { body: { files: actual.slice(2) } } : { body: { files: actual.slice(0, 2), nextPageToken: 'page-2' } };
  } };
  const files = await hostingVersionFiles('nimlo-editor', 'nimlo-editor-updates', 'projects/nimlo-editor/sites/nimlo-editor-updates/versions/example', client);
  check('authenticated inventory reads all result pages', () => assert.deepEqual(files, actual));
  check('inventory API requests ACTIVE files from the selected project/site/version', () => assert.ok(requests.every(request => request.url === '/projects/nimlo-editor/sites/nimlo-editor-updates/versions/example/files' && request.query.status === 'ACTIVE')));
  await assert.rejects(() => hostingVersionFiles('nimlo-editor', 'nimlo-editor-updates', 'sites/unrelated-site/versions/example', client)); checks.push('foreign-site inventory request is rejected');
  await assert.rejects(() => hostingVersionFiles('nimlo-editor', 'nimlo-editor-updates', 'sites/nimlo-editor-updates/versions/example', { async get() { return { body: { files: [], nextPageToken: 'loop' } }; } })); checks.push('repeating inventory pagination token is rejected');
  const report = { passed: true, count: checks.length, checks, networkUsed: false, credentialsRead: false };
  const output = path.join(__dirname, '../target/update-release-review/hosting-inventory.json');
  fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
})().catch(error => { console.error(error.message); process.exitCode = 1; });
