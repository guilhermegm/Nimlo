#!/usr/bin/env node
'use strict';
// Local release qualification against the task-start editor. Both sides use
// the same final compiled native wrapper; only the frozen Rust host/assets differ.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict'),cp=require('node:child_process');
const root=path.resolve(__dirname,'..'),baselineSource=path.join(root,'target/final-local-performance/baseline');
const sha=data=>crypto.createHash('sha256').update(data).digest('hex');
const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const median=values=>{const sorted=[...values].sort((a,b)=>a-b);return sorted.length%2?sorted[(sorted.length-1)/2]:(sorted[sorted.length/2-1]+sorted[sorted.length/2])/2;};
function run(command,args){const result=cp.spawnSync(command,args,{cwd:root,stdio:'inherit'});assert.equal(result.status,0,`${path.basename(command)} failed (${result.status}); reports are retained`);}
const directory=path.join(root,'target/final-local-performance','native-'+new Date().toISOString().replace(/[:.]/g,'-'));
fs.mkdirSync(directory,{recursive:true,mode:0o700});
const summary={status:'running',startedAt:new Date().toISOString(),directory,order:['baseline','candidate','candidate','baseline'],trials:[],realInferenceRequests:0,tunnelStarted:false};
const output=path.join(directory,'comparison.json'),write=()=>fs.writeFileSync(output,JSON.stringify(summary,null,2)+'\n');
function metrics(report){
  assert.equal(report.status,'pass');assert(report.ownership.allOwnedExited,'Owned fixture processes must exit');
  assert(report.backgroundBuildObservations.every(row=>row.processes.length===0),'Compiler load invalidates native measurements');
  const positive=(value,label)=>{assert(Number.isFinite(value)&&value>0,'Missing positive finite '+label);return value;};
  const phase=name=>{const row=report.nativePhases.find(row=>row.label===name);assert(row,'Missing native phase '+name);
    for(const role of ['nativeWrapper','rustHost','webContent','networking','gpu'])assert(row.tasks.some(task=>task.role===role),'Missing process role '+role+' in '+name);
    for(const task of row.tasks){positive(task.physicalFootprintMiB,'footprint');positive(task.physicalFootprintPeakMiB,'lifetime peak');}
    assert(report.backgroundBuildObservations.some(row=>row.label===name),'Missing compiler observation '+name);
    positive(row.chargedFootprintSumMiB,'phase footprint');return row;};
  for(const row of report.nativePhases)phase(row.label);
  assert.equal(report.cycles.length,10,'Ten ordinary file cycles required');
  const input=(name,count=12)=>{const row=report.nativeTrials.find(row=>row.label===name);assert.equal(row?.samples?.length,count,'Exact trusted native key count required for '+name);assert(row.samples.every(sample=>sample.trustedKeyDown&&sample.nativeKeyAssociated&&(sample.trusted||sample.trustedBeforeInput)&&sample.key==='x'&&sample.nativeKeySequence===sample.armedKeySequence),'Each result must match its armed trusted native keydown');return row.samples.map(sample=>positive(sample.nativeDispatchToFrameCallbackMilliseconds,name));};
  const scroll=name=>{const row=report.nativeTrials.find(row=>row.label===name);assert.equal(row?.scrollSamples?.length,8);assert(row.scrollSamples.some(sample=>sample.actual>0));return Math.max(...row.scrollSamples.map(sample=>{for(const key of ['target','actual','maximum'])assert(Number.isFinite(sample[key])&&sample[key]>=0);assert(Math.abs(sample.target-sample.actual)<=2);return positive(sample.milliseconds,name);}));};
  const checkpoints=prefix=>Math.max(...['open','after-input'].map(suffix=>phase(prefix+'-'+suffix).chargedFootprintSumMiB));
  const rss=report.samples.map(row=>{assert(Number.isFinite(row.nativeRssSumMiB)&&row.nativeRssSumMiB>=0,'Invalid sampled RSS');return row.nativeRssSumMiB;});assert(rss.some(value=>value>0),'Positive native RSS samples required');
  return {idleMiB:phase('idle-no-documents').chargedFootprintSumMiB,ordinaryCheckpointMaxMiB:Math.max(...['ordinary-local','ordinary-paired','eight-ordinary-open'].map(name=>phase(name).chargedFootprintSumMiB)),
    ordinaryLocalWorstMs:Math.max(...input('ordinary-local')),ordinaryPairedWorstMs:Math.max(...input('ordinary-paired')),asciiTailWorstMs:Math.max(...input('lowline-ascii-tail')),unicodeTailWorstMs:Math.max(...input('lowline-unicode-tail')),
    highLineWorstMs:Math.max(...input('high-line-paired',3)),ordinaryScrollWorstMs:scroll('ordinary-local-scroll'),highLineScrollWorstMs:scroll('high-line-scroll'),
    asciiCheckpointMaxMiB:checkpoints('lowline-ascii'),unicodeCheckpointMaxMiB:checkpoints('lowline-unicode'),highLineCheckpointMaxMiB:Math.max(...['high-line-open','high-line-after-input'].map(name=>phase(name).chargedFootprintSumMiB)),
    taskLifetimePeakChargeSumMiB:Math.max(...report.nativePhases.map(row=>row.tasks.reduce((sum,task)=>sum+task.physicalFootprintPeakMiB,0))),sampledNativeRssMaxMiB:Math.max(...rss),retainedAfterCyclesMiB:phase('ten-ordinary-cycles-closed').chargedFootprintSumMiB};
}
try{
  run(process.execPath,['scripts/native-performance-gate.cjs','--preflight','1']);
  assert(fs.existsSync(path.join(baselineSource,'freeze.json')),'Freeze task-start assets before changing the editor');
  const frozen=read(path.join(baselineSource,'freeze.json'));
  for(const [name,expected] of Object.entries(frozen.files)){const bytes=fs.readFileSync(path.join(baselineSource,name));assert.equal(bytes.length,expected.bytes,'Frozen byte count changed: '+name);assert.equal(sha(bytes),expected.sha256,'Frozen SHA changed: '+name);}
  run(process.execPath,['scripts/native-performance-freeze.cjs','--app','target/desktop/Nimlo.app','--destination',path.join(directory,'candidate'),'--working-tree','1']);
  const candidate=read(path.join(directory,'candidate/manifest.json'));
  const baselineDirectory=path.join(directory,'baseline'),app=path.join(baselineDirectory,'Nimlo.app');
  fs.mkdirSync(baselineDirectory,{mode:0o700});fs.cpSync(candidate.app,app,{recursive:true});
  const sourceHost=path.join(baselineSource,'nimlo-editor'),host=path.join(app,'Contents/Resources/nimlo-editor');
  fs.copyFileSync(sourceHost,host);fs.chmodSync(host,0o755);
  run('/usr/bin/codesign',['--force','--sign','-',host]);run('/usr/bin/codesign',['--force','--sign','-',app]);
  run('/usr/bin/codesign',['--verify','--deep','--strict',app]);
  const assets=structuredClone(candidate.assets);
  for(const name of ['editor.js','app.js','style.css','index.html']){const bytes=fs.readFileSync(path.join(baselineSource,name));assets[name]={bytes:bytes.length,sha256:sha(bytes)};}
  const native=path.join(app,'Contents/MacOS/Nimlo');
  const baseline={...candidate,app,assets,diagnosticBuild:{...candidate.diagnosticBuild,nativePreResignSha256:sha(fs.readFileSync(native))},
    provenance:'Final native wrapper and helper, re-signed around the immutable task-start Rust host. Frozen source assets are verified through actual served HTTP bytes. This compares this task, not the older a811aaf release.'};
  baseline.files={};
  const inventory=folder=>{for(const entry of fs.readdirSync(folder,{withFileTypes:true})){const filename=path.join(folder,entry.name);if(entry.isDirectory())inventory(filename);else{assert(entry.isFile(),'Unexpected frozen bundle file type');const bytes=fs.readFileSync(filename);baseline.files[path.relative(app,filename)]={bytes:bytes.length,sha256:sha(bytes)};}}};inventory(app);
  const baselineManifest=path.join(baselineDirectory,'manifest.json');fs.writeFileSync(baselineManifest,JSON.stringify(baseline,null,2)+'\n');
  summary.identities={baselineSourceHostSHA256:sha(fs.readFileSync(sourceHost)),baselineSignedHostSHA256:sha(fs.readFileSync(host)),candidateHostSHA256:sha(fs.readFileSync(path.join(candidate.app,'Contents/Resources/nimlo-editor'))),baselineEditorSHA256:assets['editor.js'].sha256,candidateEditorSHA256:candidate.assets['editor.js'].sha256,nativeWrapperSourceSHA256:candidate.diagnosticBuild.mainSourceSha256};
  summary.bar={frozenBeforeMeasurements:true,ordinaryInput:'Each local/paired worst-of12 <=100ms and baseline median ×1.25 +10ms',largeTailInput:'Each worst-of12 <=150ms; at least25% faster if reference exceeds200ms, otherwise baseline ×1.25 +10ms',highLineAndScroll:'Worst-of3 high-line input <=150ms and baseline ×1.25 +10ms; worst-of8 ordinary scroll <=100ms, high-line scroll <=150ms, both also baseline ×1.25 +10ms',memory:'Each candidate <= baseline median ×1.15 +16MiB for settled checkpoint charges, lifetime-peak charge sums, sampled RSS and post-cycle retention',referenceDrift:'Two baseline values differ by at most25% of median for memory and50% of median (minimum10ms allowance) for timings',scope:'Same local Mac; task charges and RSS include shared pages. Checkpoint maxima and summed per-task lifetime peaks are not simultaneous unique RAM peaks. Timing is native dispatch to submitted-frame callback proxy; no pixel-presentation, zero-memory or all-machine claim.'};
  fs.writeFileSync(path.join(directory,'bar.json'),JSON.stringify({identities:summary.identities,...summary.bar},null,2)+'\n',{flag:'wx'});write();
  for(let index=0;index<summary.order.length;index++){
    const side=summary.order[index],manifest=side==='baseline'?baselineManifest:path.join(directory,'candidate/manifest.json'),report=path.join(directory,`${index+1}-${side}.json`);
    run(process.execPath,['scripts/native-performance-gate.cjs','--preflight','1']);
    run(process.execPath,['scripts/native-performance-check.cjs','--app',side==='baseline'?app:candidate.app,'--asset-manifest',manifest,'--long-lines','1','--output',report]);
    const data=read(report),values=metrics(data),prior=summary.trials[0];
    assert.equal(data.build.hostSha256,side==='baseline'?summary.identities.baselineSignedHostSHA256:summary.identities.candidateHostSHA256,'Measured host differs from frozen expected identity');
    if(prior){const first=read(prior.report);for(const field of ['benchmarkSha256','instrumentationSha256','metricsSourceSha256'])assert.equal(data[field],first[field],'Measurement helper changed');assert.deepEqual(data.workload,first.workload,'Workloads differ');}
    const sameSide=summary.trials.find(row=>row.side===side);
    if(sameSide){const first=read(sameSide.report);assert.equal(data.build.sourceNativeSha256,first.build.sourceNativeSha256);assert.equal(data.build.hostSha256,first.build.hostSha256);assert.deepEqual(data.build.embeddedAssets,first.build.embeddedAssets);}
    summary.trials.push({side,report,metrics:values});write();
  }
  const references=summary.trials.filter(row=>row.side==='baseline'),candidates=summary.trials.filter(row=>row.side==='candidate'),reference={},limits={};
  for(const key of Object.keys(references[0].metrics)){
    reference[key]=median(references.map(row=>row.metrics[key]));
    if(key.endsWith('MiB'))limits[key]=reference[key]*1.15+16;
    else if(key.startsWith('ordinary'))limits[key]=Math.min(100,reference[key]*1.25+10);
    else if(key.includes('Tail'))limits[key]=Math.min(150,reference[key]>=200?reference[key]*.75:reference[key]*1.25+10);
    else limits[key]=Math.min(150,reference[key]*1.25+10);
  }
  summary.referenceMedian=reference;
  summary.referenceStability=Object.keys(reference).map(metric=>{const values=references.map(row=>row.metrics[metric]),spread=Math.max(...values)-Math.min(...values),maximum=metric.endsWith('MiB')?reference[metric]*.25:Math.max(10,reference[metric]*.5);return {metric,values,spread,maximum,passed:spread<=maximum};});
  summary.checks=Object.entries(limits).map(([metric,maximum])=>({metric,referenceMedian:reference[metric],candidateValues:candidates.map(row=>row.metrics[metric]),maximum,passed:candidates.every(row=>row.metrics[metric]<=maximum)}));
  summary.status=!summary.referenceStability.every(row=>row.passed)?'unstable-reference':summary.checks.every(row=>row.passed)?'passed':'failed-quality-bar';summary.completedAt=new Date().toISOString();write();
  console.log(JSON.stringify({status:summary.status,report:output,checks:summary.checks},null,2));
  if(summary.status!=='passed')process.exitCode=1;
}catch(error){summary.status='failed';summary.error=error.message;summary.completedAt=new Date().toISOString();write();console.error(error.stack);process.exitCode=1;}
