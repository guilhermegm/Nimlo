#!/usr/bin/env node
'use strict';
// Disposable native fixtures only. Never discovers, quits or modifies a user's app.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'target', 'update-installer-review');
fs.mkdirSync(output, {recursive:true});
const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nimlo-installer-check-')));
fs.chmodSync(work, 0o700);
const checks = [];
const children = new Set();
const run = (command, args, options={}) => cp.execFileSync(command, args, {encoding:'utf8', stdio:['ignore','pipe','pipe'], ...options});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function privateJSON(file, value) { fs.writeFileSync(file, JSON.stringify(value), {mode:0o600}); }
function plist(object) {
  const file = path.join(work, 'info-' + crypto.randomUUID() + '.json');
  fs.writeFileSync(file, JSON.stringify(object));
  run('/usr/bin/plutil', ['-convert','xml1',file]);
  const bytes = fs.readFileSync(file); fs.unlinkSync(file); return bytes;
}
const fixtureSource = `import Foundation
import CryptoKit
do {
let args = CommandLine.arguments
if args.count > 1 && args[1] == "--sign" {
    let key = try Curve25519.Signing.PrivateKey(rawRepresentation: Data(contentsOf: URL(fileURLWithPath: args[4])))
    let bytes = try Data(contentsOf: URL(fileURLWithPath: args[2]))
    let object = ["payload":bytes.base64EncodedString(), "signature":try key.signature(for: bytes).base64EncodedString()]
    try JSONSerialization.data(withJSONObject: object).write(to: URL(fileURLWithPath: args[3])); exit(0)
}
if args.count > 1 && args[1] == "--key" {
    let key = Curve25519.Signing.PrivateKey()
    try key.rawRepresentation.write(to: URL(fileURLWithPath: args[2]))
    print(key.publicKey.rawRepresentation.base64EncodedString()); exit(0)
}
if args.count > 1 && args[1] == "--prepare" {
    let plan = try NimloUpdateInstaller.prepare(appURL: URL(fileURLWithPath: args[2]), archiveURL: URL(fileURLWithPath: args[3]), envelopeURL: URL(fileURLWithPath: args[4]), parentPID: 999999, hostPID: 0, relaunchArguments: [])
    print(plan.path); exit(0)
}
if args.count > 1 && args[1] == "--launch" {
    let process = try NimloUpdateInstaller.launch(planURL: URL(fileURLWithPath: args[2]))
    process.waitUntilExit(); exit(process.terminationStatus)
}
if args.count > 1 && args[1] == "--ready" {
    print(try NimloUpdateInstaller.installationReady(planURL: URL(fileURLWithPath: args[2]))); exit(0)
}
if args.count > 1 && args[1] == "--cancel" {
    try NimloUpdateInstaller.cancel(planURL: URL(fileURLWithPath: args[2])); exit(0)
}
let behavior = Bundle.main.object(forInfoDictionaryKey: "NimloInstallerTestBehavior") as? String ?? "success"
if behavior == "crash" { exit(23) }
if behavior == "wait" { Thread.sleep(forTimeInterval: 65); exit(0) }
if args.contains("--update-receipt") { _ = NimloUpdateInstaller.acknowledgeStartup() }
Thread.sleep(forTimeInterval: 1)
} catch {
    FileHandle.standardError.write(Data((error.localizedDescription + "\\n").utf8)); exit(1)
}
`;
fs.writeFileSync(path.join(work, 'main.swift'), fixtureSource);
const fixture = path.join(work, 'fixture');
const helper = path.join(output, 'nimlo-update-helper');
run('/usr/bin/swiftc', ['-O', path.join(root,'desktop/macos/UpdateInstaller.swift'), path.join(root,'desktop/macos/update-helper/main.swift'), '-o', helper]);
run('/usr/bin/swiftc', ['-O', path.join(root,'desktop/macos/UpdateInstaller.swift'), path.join(work,'main.swift'), '-o', fixture]);
const keyFile = path.join(work,'private-key');
const publicKey = run(fixture, ['--key',keyFile]).trim(); fs.chmodSync(keyFile,0o600);
function app(parent, build, options={}) {
  const location = path.join(parent,'Nimlo.app');
  fs.mkdirSync(path.join(location,'Contents/MacOS'), {recursive:true});
  fs.mkdirSync(path.join(location,'Contents/Helpers'), {recursive:true});
  fs.mkdirSync(path.join(location,'Contents/Resources'), {recursive:true});
  fs.copyFileSync(fixture,path.join(location,'Contents/MacOS/Nimlo'));
  fs.copyFileSync(helper,path.join(location,'Contents/Helpers/nimlo-update-helper'));
  fs.copyFileSync(fixture,path.join(location,'Contents/Resources/nimlo-editor'));
  fs.writeFileSync(path.join(location,'Contents/Info.plist'),plist({
    CFBundleIdentifier:options.bundle || 'dev.nimlo.editor', CFBundleName:'Nimlo',
    CFBundleExecutable:'Nimlo', CFBundlePackageType:'APPL', CFBundleShortVersionString:'0.1.'+build,
    CFBundleVersion:String(build), LSMinimumSystemVersion:'13.3', NimloUpdatePublicKey:options.key || publicKey,
    NimloInstallerTestBehavior:options.behavior || 'success',
  }));
  run('/usr/bin/codesign',['--force','--sign','-',path.join(location,'Contents/Helpers/nimlo-update-helper')]);
  run('/usr/bin/codesign',['--force','--sign','-',path.join(location,'Contents/Resources/nimlo-editor')]);
  run('/usr/bin/codesign',['--force','--sign','-',location]);
  return location;
}
function signedEnvelope(folder, zip, changes={}) {
  const bytes=fs.readFileSync(zip), payload=path.join(folder,'payload.json'), envelope=path.join(folder,'release.json');
  privateJSON(payload,{schema:1,bundleIdentifier:'dev.nimlo.editor',version:'0.1.2',build:2,publishedAt:new Date().toISOString(),minimumSystemVersion:'13.3',architecture:os.arch()==='arm64'?'arm64':'x86_64',url:'https://updates.example.invalid/Nimlo.zip',size:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex'),releaseNotes:'Disposable test release.',...changes});
  run(fixture,['--sign',payload,envelope,keyFile]); fs.chmodSync(envelope,0o600); return envelope;
}
function setup(name, options={}) {
  const folder=path.join(work,name); fs.mkdirSync(folder,{mode:0o700});
  const installed=app(path.join(folder,'installed'),1,{behavior:options.currentBehavior});
  const incoming=app(path.join(folder,'incoming'),2,options.candidate || {});
  if(options.metadata) run('/usr/bin/xattr',['-w','com.nimlo.installer-test','resource metadata',path.join(incoming,'Contents/Resources/nimlo-editor')]);
  const zip=path.join(folder,'release.zip');
  run('/usr/bin/ditto',['-c','-k','--sequesterRsrc','--keepParent',incoming,zip]);
  const envelope=signedEnvelope(folder,zip,options.manifest);
  const args=['--prepare',installed,zip,envelope].map(value=>options.aliases?value.replace(/^\/private\/var\//,'/var/'):value);
  const prepared=run(fixture,args).trim();
  return {folder,installed,incoming,zip,envelope,prepared};
}
async function execute(planURL, launchAPI=false) {
  const child=cp.spawn(launchAPI?fixture:helper,[launchAPI?'--launch':'--plan',planURL],{stdio:['ignore','pipe','pipe']}); children.add(child);
  let error=''; child.stderr.on('data',b=>error+=b.toString());
  const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve)}); children.delete(child);
  const state=JSON.parse(fs.readFileSync(path.join(path.dirname(planURL),'status.json'),'utf8'));
  return {code,state,error};
}
function buildAt(location) { return Number(run('/usr/libexec/PlistBuddy',['-c','Print :CFBundleVersion',path.join(location,'Contents/Info.plist')]).trim()); }
async function check(name, action) { const start=Date.now(); await action(); checks.push({name,passed:true,milliseconds:Date.now()-start}); process.stdout.write(name+' passed\n'); }
(async()=>{
  await check('signed unnotarized release is rejected before automatic helper preparation',async()=>{
    const folder=path.join(work,'manual-release'); fs.mkdirSync(folder,{mode:0o700});
    const installed=app(path.join(folder,'installed'),1), incoming=app(path.join(folder,'incoming'),2);
    const zip=path.join(folder,'release.zip'); run('/usr/bin/ditto',['-c','-k','--keepParent',incoming,zip]);
    const envelope=signedEnvelope(folder,zip,{distribution:'unnotarized'});
    assert.throws(()=>run(fixture,['--prepare',installed,zip,envelope]),/requires manual installation/);
    assert.equal(buildAt(installed),1);
    assert.equal(fs.readdirSync(path.dirname(installed),{withFileTypes:true}).filter(value=>value.isDirectory()&&value.name.startsWith('.nimlo-update-')).length,0);
  });
  await check('signed release installs atomically and confirms native startup',async()=>{
    const x=setup('success',{metadata:true,aliases:true}); const result=await execute(x.prepared,true);
    assert.equal(result.code,0,result.error); assert.equal(result.state.state,'complete'); assert.equal(buildAt(x.installed),2);
    assert.equal(fs.readdirSync(path.dirname(x.installed),{withFileTypes:true}).filter(v=>v.isDirectory()&&v.name.startsWith('.nimlo-update-')).length,0);
  });
  await check('startup crash restores and relaunches previous app',async()=>{
    const x=setup('crash',{candidate:{behavior:'crash'}}); const result=await execute(x.prepared);
    assert.equal(result.code,1); assert.match(result.error,/previous version was restored/); assert.equal(buildAt(x.installed),1);
  });
  await check('manifest tampering is rejected before replacement',async()=>{
    const x=setup('signature'); const e=JSON.parse(fs.readFileSync(path.join(path.dirname(x.prepared),'release.json'),'utf8'));
    e.signature=Buffer.alloc(64,7).toString('base64'); privateJSON(path.join(path.dirname(x.prepared),'release.json'),e);
    const child=cp.spawnSync(helper,['--plan',x.prepared],{encoding:'utf8'}); assert.equal(child.status,1); assert.match(child.stderr,/signature/); assert.equal(buildAt(x.installed),1);
  });
  await check('download corruption is rejected before replacement',async()=>{
    const x=setup('hash'); const saved=path.join(path.dirname(x.prepared),'release.zip');
    const b=fs.readFileSync(saved); b[b.length-1]^=1; fs.writeFileSync(saved,b);
    const child=cp.spawnSync(helper,['--plan',x.prepared],{encoding:'utf8'}); assert.equal(child.status,1); assert.match(child.stderr,/SHA-256/); assert.equal(buildAt(x.installed),1);
  });
  await check('candidate identity and pinned-key changes are rejected',async()=>{
    for (const [name,candidate] of [['bundle',{bundle:'dev.nimlo.editor.dev'}],['key',{key:crypto.randomBytes(32).toString('base64')}]]) {
      const x=setup(name,{candidate}); const result=await execute(x.prepared); assert.equal(result.code,1); assert.equal(buildAt(x.installed),1);
    }
  });
  await check('universal manifest requires both executable architectures',async()=>{
    const x=setup('universal',{manifest:{architecture:'universal'}}); const result=await execute(x.prepared);
    assert.equal(result.code,1);assert.match(result.error,/processor architecture/);assert.equal(buildAt(x.installed),1);
  });
  await check('quarantined ad-hoc release fails Gatekeeper before shutdown handshake',async()=>{
    const x=setup('quarantine');run('/usr/bin/xattr',['-w','com.apple.quarantine','0083;00000000;Nimlo installer fixture;',path.join(path.dirname(x.prepared),'release.zip')]);
    const result=await execute(x.prepared);assert.equal(result.code,1);assert.match(result.error,/spctl/);assert.equal(buildAt(x.installed),1);
    assert.throws(()=>run(fixture,['--ready',x.prepared]),/spctl/);
  });
  await check('validly signed downgrade is rejected',async()=>{
    const folder=path.join(work,'downgrade'); fs.mkdirSync(folder,{mode:0o700});
    const installed=app(path.join(folder,'installed'),3), incoming=app(path.join(folder,'incoming'),2),zip=path.join(folder,'release.zip');
    run('/usr/bin/ditto',['-c','-k','--keepParent',incoming,zip]); const envelope=signedEnvelope(folder,zip);
    assert.throws(()=>run(fixture,['--prepare',installed,zip,envelope]),/incompatible/); assert.equal(buildAt(installed),3);
  });
  await check('symlink entries rejected before extraction',async()=>{
    const x=setup('zip-symlink'); fs.symlinkSync('/tmp',path.join(x.incoming,'Contents/Resources/escape'));
    run('/usr/bin/ditto',['-c','-k','--keepParent',x.incoming,x.zip]); signedEnvelope(x.folder,x.zip);
    const plan=run(fixture,['--prepare',x.installed,x.zip,x.envelope]).trim(); const result=await execute(plan);
    assert.equal(result.code,1); assert.match(result.error,/link|file type/); assert.equal(buildAt(x.installed),1);
  });
  await check('local/central filename mismatch rejected before extraction',async()=>{
    const x=setup('zip-name'); const bytes=fs.readFileSync(x.zip); assert.equal(bytes.readUInt32LE(0),0x04034b50); bytes[30]^=1; fs.writeFileSync(x.zip,bytes); signedEnvelope(x.folder,x.zip);
    const plan=run(fixture,['--prepare',x.installed,x.zip,x.envelope]).trim(); const result=await execute(plan);
    assert.equal(result.code,1); assert.match(result.error,/filename|entries disagree/); assert.equal(buildAt(x.installed),1);
  });
  await check('traversal, duplicate entries and expansion bombs are rejected',async()=>{
    for(const kind of ['traversal','duplicate','bomb','link-extra']) {
      const x=setup('zip-'+kind); let bytes=fs.readFileSync(x.zip);
      const end=bytes.length-22, offset=bytes.readUInt32LE(end+16);
      assert.equal(bytes.readUInt32LE(end),0x06054b50);
      if(kind==='traversal') {
        const needle=Buffer.from('Nimlo.app');
        for(let at=bytes.indexOf(needle);at>=0;at=bytes.indexOf(needle,at+needle.length)) Buffer.from('../lo.app').copy(bytes,at);
      } else if(kind==='duplicate') {
        const length=46+bytes.readUInt16LE(offset+28)+bytes.readUInt16LE(offset+30)+bytes.readUInt16LE(offset+32);
        bytes=Buffer.concat([bytes.subarray(0,end),bytes.subarray(offset,offset+length),bytes.subarray(end)]);
        const next=bytes.length-22;
        bytes.writeUInt16LE(bytes.readUInt16LE(next+8)+1,next+8);bytes.writeUInt16LE(bytes.readUInt16LE(next+10)+1,next+10);
        bytes.writeUInt32LE(bytes.readUInt32LE(next+12)+length,next+12);
      } else if(kind==='bomb') {
        let entry=offset;
        while(bytes.readUInt32LE(entry+24)===0) entry+=46+bytes.readUInt16LE(entry+28)+bytes.readUInt16LE(entry+30)+bytes.readUInt16LE(entry+32);
        bytes.writeUInt32LE(513*1024*1024,entry+24);
      } else {
        const extra=offset+46+bytes.readUInt16LE(offset+28);
        assert.ok(bytes.readUInt16LE(offset+30)>=4); bytes.writeUInt16LE(0x000d,extra);
      }
      fs.writeFileSync(x.zip,bytes);signedEnvelope(x.folder,x.zip);
      const plan=run(fixture,['--prepare',x.installed,x.zip,x.envelope]).trim(); const result=await execute(plan);
      assert.equal(result.code,1);assert.match(result.error,/only Nimlo|duplicate|extraction limits|unsupported path, link/);assert.equal(buildAt(x.installed),1);
    }
  });
  await check('world-readable private plan is rejected',async()=>{
    const x=setup('plan-mode'); fs.chmodSync(x.prepared,0o644);
    const child=cp.spawnSync(helper,['--plan',x.prepared],{encoding:'utf8'}); assert.equal(child.status,1); assert.match(child.stderr,/private/); assert.equal(buildAt(x.installed),1);
  });
  await check('unrelated running PID is rejected without signalling it',async()=>{
    const x=setup('wrong-pid'); const plan=JSON.parse(fs.readFileSync(x.prepared,'utf8')); plan.parentPID=process.pid; privateJSON(x.prepared,plan);
    const child=cp.spawnSync(helper,['--plan',x.prepared],{encoding:'utf8'}); assert.equal(child.status,1); assert.match(child.stderr,/running Nimlo/); assert.equal(buildAt(x.installed),1);
  });
  await check('cancel after verification keeps current app running and removes staged download',async()=>{
    const x=setup('cancel',{currentBehavior:'wait'});
    const old=cp.spawn(path.join(x.installed,'Contents/MacOS/Nimlo'),[],{stdio:'ignore'});children.add(old);
    const plan=JSON.parse(fs.readFileSync(x.prepared,'utf8'));plan.parentPID=old.pid;privateJSON(x.prepared,plan);
    const pending=execute(x.prepared);let ready=false;const deadline=Date.now()+30000;
    while(Date.now()<deadline) {ready=run(fixture,['--ready',x.prepared]).trim()==='true';if(ready)break;await delay(100);}
    assert.ok(ready);run(fixture,['--cancel',x.prepared]);const result=await pending;
    assert.equal(result.code,1);assert.match(result.error,/cancelled/);assert.equal(buildAt(x.installed),1);assert.equal(old.exitCode,null);
    assert.ok(!fs.existsSync(path.join(path.dirname(x.prepared),'release.zip')));
    assert.equal(fs.readdirSync(path.dirname(x.installed),{withFileTypes:true}).filter(v=>v.isDirectory()&&v.name.startsWith('.nimlo-update-')).length,0);
    old.kill('SIGTERM');await new Promise(resolve=>old.once('close',resolve));children.delete(old);
  });
  await check('running app shutdown timeout cancels without killing or replacing',async()=>{
    const x=setup('wait-cancel',{currentBehavior:'wait'});
    const old=cp.spawn(path.join(x.installed,'Contents/MacOS/Nimlo'),[],{stdio:'ignore'}); children.add(old);
    const plan=JSON.parse(fs.readFileSync(x.prepared,'utf8')); plan.parentPID=old.pid; privateJSON(x.prepared,plan);
    const pending=execute(x.prepared);
    const deadline=Date.now()+30000; let ready=false;
    while(Date.now()<deadline) { ready=run(fixture,['--ready',x.prepared]).trim()==='true';if(ready)break;await delay(100); }
    assert.ok(ready,'fully verified helper did not publish shutdown handshake');assert.equal(buildAt(x.installed),1);assert.equal(old.exitCode,null);
    const duplicate=cp.spawnSync(helper,['--plan',x.prepared],{encoding:'utf8'});assert.equal(duplicate.status,1);assert.match(duplicate.stderr,/already running/);
    assert.ok(fs.existsSync(path.join(path.dirname(x.prepared),'release.zip')),'duplicate helper removed active plan archive');
    const competing=run(fixture,['--prepare',x.installed,x.zip,x.envelope]).trim();const other=cp.spawnSync(helper,['--plan',competing],{encoding:'utf8'});
    assert.equal(other.status,1);assert.match(other.stderr,/Another updater/);assert.ok(!fs.existsSync(path.join(path.dirname(competing),'release.zip')));
    const result=await pending; assert.equal(result.code,1); assert.match(result.error,/still running/); assert.equal(buildAt(x.installed),1); assert.equal(old.exitCode,null);
    // This test owns the fixture; clean it up only after proving the updater did not.
    old.kill('SIGTERM'); await new Promise(resolve=>old.once('close',resolve)); children.delete(old);
  });
  privateJSON(path.join(output,'report.json'),{passed:true,checks,fixtureRoot:work,limitations:['Disposable ad-hoc signed apps; no Developer ID certificate available to test team matching or notarization online.','No real installed Nimlo or user project/state was opened or modified.']});
  await delay(1200);
  fs.rmSync(work,{recursive:true,force:true});
})().catch(error=>{
  for(const child of children) child.kill('SIGTERM');
  privateJSON(path.join(output,'report.json'),{passed:false,checks,error:String(error.stack||error),fixtureRoot:work});
  console.error(error);process.exitCode=1;
});
