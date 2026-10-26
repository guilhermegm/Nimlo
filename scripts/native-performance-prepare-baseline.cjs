#!/usr/bin/env node
'use strict';

// Builds only an owned reference archive. Never edits the working checkout or
// launches an app. Frozen original apps/helpers are validated, never replaced.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict'),{execFileSync}=require('node:child_process');
const repo=path.resolve(__dirname,'..'),opts={},args=process.argv.slice(2);
for(let i=0;i<args.length;i+=2){assert(args[i].startsWith('--')&&args[i+1],'Arguments are --name value pairs');opts[args[i].slice(2)]=args[i+1];}
assert.equal(process.platform,'darwin','The reference native release targets macOS');
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const git=argv=>execFileSync('git',argv,{cwd:repo,maxBuffer:64*1024*1024});
const sourceRef=git(['rev-parse','--verify',(opts['source-ref']||'a811aaf')+'^{commit}']).toString().trim();
const destination=path.resolve(opts.destination||path.join(repo,'target/performance-baseline-'+sourceRef.slice(0,7)));
assert(destination.startsWith(path.join(repo,'target')+path.sep),'Baseline destination must be an owned path under this repository target directory');
const originalInfo=git(['show',sourceRef+':desktop/macos/Info.plist']).toString();
const referenceName=originalInfo.match(/<key>CFBundleName<\/key>\s*<string>([^<]+)<\/string>/)?.[1],referenceExecutable=originalInfo.match(/<key>CFBundleExecutable<\/key>\s*<string>([^<]+)<\/string>/)?.[1];
assert(referenceName&&referenceExecutable,'Reference bundle identity is required');
const referenceNative='Contents/MacOS/'+referenceExecutable;
const app=path.join(destination,referenceName+'.app'),manifestFile=path.join(destination,'manifest.json');
const metricsFile=path.join(repo,'desktop/macos/Metrics.swift'),metricsBytes=fs.readFileSync(metricsFile),metricsSourceSha256=sha(metricsBytes);
const originalMain=git(['show',sourceRef+':desktop/macos/main.swift']),policy=git(['show',sourceRef+':desktop/macos/Policy.swift']);
const trigger='setupWindow(); startHost()',replacement='setupWindow(); startPerformanceDiagnostics(); startHost()';
const mainText=originalMain.toString('utf8');assert.equal(mainText.split(trigger).length,2,'Reference main must contain exactly one recognized diagnostic hook location');
assert(!mainText.includes('startPerformanceDiagnostics'),'Reference wrapper must remain uninstrumented');
const referenceClass=mainText.match(/final class (\w+App):/)?.[1];assert(referenceClass,'Reference app class is required');
const brandingAlias=referenceClass==='NimloApp'?'':'\n// Name-only adapter for the current diagnostics on an unchanged legacy wrapper.\ntypealias NimloApp = '+referenceClass+'\n';
const instrumentedMain=Buffer.from(mainText.replace(trigger,replacement)+brandingAlias),mainSourceSha256=sha(instrumentedMain),policySourceSha256=sha(policy);
const assets={};for(const name of['index.html','app.js','style.css']){const bytes=git(['show',sourceRef+':web/'+name]);assets[name]={bytes:bytes.length,sha256:sha(bytes)};}
function scan(dir){const rows={};function visit(folder){for(const e of fs.readdirSync(folder,{withFileTypes:true})){const full=path.join(folder,e.name);if(e.isDirectory())visit(full);else{assert(e.isFile(),'Frozen artifact contains a nonregular path');const bytes=fs.readFileSync(full);rows[path.relative(dir,full)]={bytes:bytes.length,sha256:sha(bytes)};}}}visit(dir);return rows;}
function validateOriginal(){
  assert(fs.existsSync(app)&&fs.existsSync(manifestFile),'Existing baseline destination is incomplete; it will not be overwritten');
  const manifest=JSON.parse(fs.readFileSync(manifestFile)),ref=manifest.commit||manifest.sourceRef;
  assert.equal(git(['rev-parse','--verify',ref+'^{commit}']).toString().trim(),sourceRef,'Frozen baseline reference differs');
  assert.deepEqual(scan(app),manifest.files,'Frozen original app changed');
  for(const[name,record]of Object.entries(assets)){const recorded=manifest.assets?.[name]?.sha256||manifest.sourceSha256?.['web/'+name];assert.equal(recorded,record.sha256,'Frozen asset/source association differs');}
  for(const[name,bytes]of[['desktop/macos/main.swift',originalMain],['desktop/macos/Policy.swift',policy]])if(manifest.sourceSha256?.[name])assert.equal(manifest.sourceSha256[name],sha(bytes),'Frozen original native source differs');
  execFileSync('/usr/bin/codesign',['--verify','--strict',app],{stdio:'ignore'});return manifest;
}
function existingHelper(){
  if(!fs.existsSync(destination))return null;
  for(const file of fs.readdirSync(destination).filter(n=>/^diagnostic.*\.json$/.test(n))){
    const manifest=JSON.parse(fs.readFileSync(path.join(destination,file)));
    if(manifest.metricsSourceSha256!==metricsSourceSha256||manifest.mainSourceSha256!==mainSourceSha256||manifest.policySourceSha256!==policySourceSha256)continue;
    const binary=path.resolve(manifest.nativeFrozenArtifact||'');assert(path.dirname(binary)===destination,'Diagnostic helper must be frozen inside the baseline directory');
    assert.equal(sha(fs.readFileSync(binary)),manifest.nativePreResignSha256,'Frozen diagnostic helper changed');return{binary,manifest:path.join(destination,file)};
  }return null;
}
if(opts.plan==='1'){
  if(fs.existsSync(destination))validateOriginal();
  console.log(JSON.stringify({sourceRef,destination,originalAppAlreadyFrozen:fs.existsSync(app),existingMatchingHelper:existingHelper(),metricsSourceSha256,originalMainSourceSha256:sha(originalMain),mainSourceSha256,policySourceSha256,willLaunchApp:false,willBuild:!fs.existsSync(app)||!existingHelper()},null,2));process.exit(0);
}
const lock=path.join(repo,'target/native-performance.lock');fs.mkdirSync(path.dirname(lock),{recursive:true});fs.mkdirSync(lock,{mode:0o700});
let temporary,ownedNewDestination=false;
const run=(command,argv,options={})=>execFileSync(command,argv,{stdio:'inherit',...options});
try{
  if(!fs.existsSync(destination)){
    temporary=fs.mkdtempSync(path.join(os.tmpdir(),'nimlo-performance-reference-'));fs.chmodSync(temporary,0o700);
    const checkout=path.join(temporary,'source');fs.mkdirSync(checkout,{mode:0o700});const archive=git(['archive','--format=tar',sourceRef]);
    execFileSync('/usr/bin/tar',['-x','-C',checkout],{input:archive});
    // Cached Cargo dependencies only; no provider, shell startup file, app or
    // network tunnel is launched by this reference build.
    run('/bin/sh',[path.join(checkout,'scripts/build-desktop.sh'),'release'],{cwd:checkout,env:{...process.env,CARGO_NET_OFFLINE:'true',CARGO_TARGET_DIR:path.join(checkout,'target')}});
    const built=path.join(checkout,'target/desktop',referenceName+'.app');execFileSync('/usr/bin/codesign',['--verify','--strict',built],{stdio:'ignore'});
    fs.mkdirSync(destination,{mode:0o700});ownedNewDestination=true;fs.cpSync(built,app,{recursive:true});
    const sourceSha256={'desktop/macos/main.swift':sha(originalMain),'desktop/macos/Policy.swift':policySourceSha256};for(const[name,record]of Object.entries(assets))sourceSha256['web/'+name]=record.sha256;
    const manifest={schemaVersion:2,frozenAt:new Date().toISOString(),sourceRef,sourceTree:git(['rev-parse',sourceRef+'^{tree}']).toString().trim(),sourceArchiveSha256:sha(archive),app,assets,files:scan(app),sourceSha256,build:{command:['/bin/sh','scripts/build-desktop.sh','release'],cargoOffline:true,cargoVersion:execFileSync('cargo',['--version'],{encoding:'utf8'}).trim(),swiftVersion:execFileSync('swiftc',['--version'],{encoding:'utf8'}).trim()},provenance:'Built the exact local git reference archive in an owned temporary directory using its original release build script; hashes associate source/build/artifacts but do not claim bit-for-bit reproducibility.'};
    fs.writeFileSync(manifestFile,JSON.stringify(manifest,null,2)+'\n',{mode:0o600,flag:'wx'});ownedNewDestination=false;
  }
  const originalManifest=validateOriginal();let helper=existingHelper();
  if(!helper){
    if(!temporary){temporary=fs.mkdtempSync(path.join(os.tmpdir(),'nimlo-performance-reference-'));fs.chmodSync(temporary,0o700);}
    const suffix=metricsSourceSha256.slice(0,16),sourceDir=path.join(destination,'diagnostic-source-'+suffix),binary=path.join(destination,'NimloDiagnostic-'+suffix),helperManifest=path.join(destination,'diagnostic-build-'+suffix+'.json');
    assert(!fs.existsSync(sourceDir)&&!fs.existsSync(binary)&&!fs.existsSync(helperManifest),'Incomplete or conflicting frozen helper artifacts will not be replaced');
    const buildDir=path.join(temporary,'diagnostic');fs.mkdirSync(buildDir,{mode:0o700});fs.writeFileSync(path.join(buildDir,'main.original.swift'),originalMain);fs.writeFileSync(path.join(buildDir,'main.swift'),instrumentedMain);fs.writeFileSync(path.join(buildDir,'Policy.swift'),policy);fs.writeFileSync(path.join(buildDir,'Metrics.swift'),metricsBytes);
    const swiftc=execFileSync('/usr/bin/xcrun',['--find','swiftc'],{encoding:'utf8'}).trim(),sdk=execFileSync('/usr/bin/xcrun',['--sdk','macosx','--show-sdk-path'],{encoding:'utf8'}).trim(),architecture=execFileSync('/usr/bin/uname',['-m'],{encoding:'utf8'}).trim();assert(['arm64','x86_64'].includes(architecture),'Supported native architecture required');const target=architecture+'-apple-macosx13.3',compilerArguments=['-O','-sdk',sdk,'-target',target,'Policy.swift','main.swift','Metrics.swift','-o','NimloDiagnostic','-framework','AppKit','-framework','WebKit'];
    run(swiftc,compilerArguments,{cwd:buildDir});
    fs.cpSync(buildDir,sourceDir,{recursive:true});fs.copyFileSync(path.join(buildDir,'NimloDiagnostic'),binary,fs.constants.COPYFILE_EXCL);fs.chmodSync(binary,0o700);
    const manifest={schemaVersion:2,recordedAt:new Date().toISOString(),sourceCommit:sourceRef,nativeFrozenArtifact:binary,nativePreResignSha256:sha(fs.readFileSync(binary)),originalAppNativeSha256:originalManifest.files[referenceNative].sha256,originalMainSourceSha256:sha(originalMain),mainSourceSha256,policySourceSha256,metricsSourceSha256,diagnosticSourceDirectory:sourceDir,hook:{before:trigger,after:replacement,occurrences:1,brandingAlias},compiler:swiftc,compilerVersion:execFileSync(swiftc,['--version'],{encoding:'utf8'}).trim(),compilerArguments,association:'The diagnostic initialization call and a name-only app-class alias were added to reference main.swift; original Policy and identical current Metrics were compiled with -O. Frozen original app/host/assets were not modified.'};
    fs.writeFileSync(helperManifest,JSON.stringify(manifest,null,2)+'\n',{mode:0o600,flag:'wx'});helper={binary,manifest:helperManifest};
  }
  const assetManifest=path.join(destination,'reference-assets-manifest.json'),normalized={sourceRef,assets,originalManifestSha256:sha(fs.readFileSync(manifestFile))};
  if(fs.existsSync(assetManifest))assert.deepEqual(JSON.parse(fs.readFileSync(assetManifest)),normalized,'Frozen reference asset manifest changed');else fs.writeFileSync(assetManifest,JSON.stringify(normalized,null,2)+'\n',{mode:0o600,flag:'wx'});
  const descriptor={schemaVersion:1,preparedAt:new Date().toISOString(),sourceRef,app,assetManifest,originalManifest:manifestFile,diagnosticWrapper:helper.binary,diagnosticManifest:helper.manifest,metricsSourceSha256};
  const output=path.resolve(opts.output||path.join(repo,'target/native-performance-prepared-baseline.json'));fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,JSON.stringify(descriptor,null,2)+'\n',{mode:0o600});console.log(JSON.stringify(descriptor,null,2));
}finally{
  if(temporary)fs.rmSync(temporary,{recursive:true,force:true});
  if(ownedNewDestination)fs.rmSync(destination,{recursive:true,force:true});
  fs.rmSync(lock,{recursive:true,force:true});
}
