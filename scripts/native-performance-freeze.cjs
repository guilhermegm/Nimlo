#!/usr/bin/env node
'use strict';
const {appBundle}=require('./app-bundle.cjs');
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict'),{execFileSync}=require('node:child_process');
const repo=path.resolve(__dirname,'..'),args=process.argv.slice(2),opts={};
for(let i=0;i<args.length;i+=2){assert(args[i].startsWith('--')&&args[i+1],'Arguments are --name value pairs');opts[args[i].slice(2)]=args[i+1];}
assert(opts.destination,'Use --app target/desktop/Nimlo.app --destination target/performance-candidate --source-ref COMMIT (or --working-tree 1)');
const source=path.resolve(opts.app||path.join(repo,'target/desktop/Nimlo.app')),destination=path.resolve(opts.destination),app=path.join(destination,'Nimlo.app');
assert(!fs.existsSync(destination),'Frozen destinations must not be overwritten');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const git=args=>execFileSync('git',args,{cwd:repo,encoding:null,maxBuffer:64*1024*1024});
const sourceRef=opts['source-ref']||git(['rev-parse','HEAD']).toString().trim(),dirty=git(['status','--porcelain']).toString();
assert(opts['source-ref']||opts['working-tree']==='1'||!dirty,'Dirty source requires --working-tree 1 or an explicit --source-ref');
const names=['web/index.html','web/app.js','web/style.css'];
for(const name of ['favicon.png','apple-touch-icon.png','logo.png'])if(opts['working-tree']==='1'?fs.existsSync(path.join(repo,'web',name)):(()=>{try{git(['cat-file','-e',sourceRef+':web/'+name]);return true;}catch{return false;}})())names.push('web/'+name);
if(opts['working-tree']==='1'?fs.existsSync(path.join(repo,'web/editor.js')):(()=>{try{git(['cat-file','-e',sourceRef+':web/editor.js']);return true;}catch{return false;}})())names.push('web/editor.js');
const assets={};for(const name of names){const bytes=opts['working-tree']==='1'?fs.readFileSync(path.join(repo,name)):git(['show',sourceRef+':'+name]);assets[path.basename(name)]={bytes:bytes.length,sha256:sha(bytes)};}
fs.mkdirSync(destination,{recursive:true,mode:0o700});fs.cpSync(source,app,{recursive:true});execFileSync('/usr/bin/codesign',['--verify','--strict',app],{stdio:'ignore'});
const files={};function scan(dir){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const full=path.join(dir,entry.name);if(entry.isDirectory())scan(full);else if(entry.isFile()){const bytes=fs.readFileSync(full);files[path.relative(app,full)]={bytes:bytes.length,sha256:sha(bytes)};}else throw Error('Unexpected nonregular artifact path');}}scan(app);
const bundleIdentity=appBundle(app);
const diagnosticBuild=opts['working-tree']==='1'?{nativePreResignSha256:files[bundleIdentity.native].sha256,metricsSourceSha256:sha(fs.readFileSync(path.join(repo,'desktop/macos/Metrics.swift'))),mainSourceSha256:sha(fs.readFileSync(path.join(repo,'desktop/macos/main.swift'))),policySourceSha256:sha(fs.readFileSync(path.join(repo,'desktop/macos/Policy.swift'))),association:'Current native source association recorded while freezing the just-built release artifact; this is not a reproducible-build proof.'}:null;
if(diagnosticBuild&&fs.existsSync(path.join(repo,'desktop/macos/Downloads.swift')))diagnosticBuild.downloadsSourceSha256=sha(fs.readFileSync(path.join(repo,'desktop/macos/Downloads.swift')));
const manifest={schemaVersion:1,frozenAt:new Date().toISOString(),app,sourceRef,workingTree:opts['working-tree']==='1',sourceDiffSha256:opts['working-tree']==='1'?sha(git(['diff','HEAD'])):null,assets,files,diagnosticBuild,provenance:'Frozen copied signed artifact plus expected source asset hashes. Harness verifies embedded HTTP SHA against this manifest; copied binary source association is not a reproducible-build proof.'};
fs.writeFileSync(path.join(destination,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{mode:0o600});console.log(JSON.stringify({app,manifest:path.join(destination,'manifest.json'),hostSha256:files[bundleIdentity.host].sha256,nativeSha256:files[bundleIdentity.native].sha256},null,2));
