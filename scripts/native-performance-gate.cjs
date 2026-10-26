#!/usr/bin/env node
'use strict';
const {appBundle}=require('./app-bundle.cjs');
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict'),{spawnSync,execFileSync}=require('node:child_process');
const repo=path.resolve(__dirname,'..'),args=process.argv.slice(2),opts={};
for(let i=0;i<args.length;i+=2){assert(args[i].startsWith('--')&&args[i+1],'Arguments are --name value pairs');opts[args[i].slice(2)]=args[i+1];}
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const read=filename=>JSON.parse(fs.readFileSync(path.resolve(filename),'utf8'));
if(opts['baseline-preparation']){
  const prepared=read(opts['baseline-preparation']);
  for(const[suffix,field]of[['app','app'],['manifest','assetManifest'],['ref','sourceRef'],['wrapper','diagnosticWrapper'],['diagnostic-manifest','diagnosticManifest']]){assert(prepared[field],'Incomplete baseline preparation descriptor');assert(!opts['baseline-'+suffix],'Use a preparation descriptor or explicit baseline artifact arguments');opts['baseline-'+suffix]=prepared[field];}
}
const median=xs=>{const a=[...xs].sort((a,b)=>a-b);return a.length%2?a[(a.length-1)/2]:(a[a.length/2-1]+a[a.length/2])/2;};
const percentile=xs=>[...xs].sort((a,b)=>a-b)[Math.max(0,Math.ceil(xs.length*.95)-1)];
const input=paths=>paths.split(',').map(filename=>({filename:path.resolve(filename),sha256:sha(fs.readFileSync(path.resolve(filename))),report:read(filename)}));
function metrics(report){
  assert.equal(report.status,'pass','Every trial must fully pass');assert(report.ownership.allOwnedExited,'Every owned PID identity must exit');assert(report.nativeTrials.some(t=>t.label==='high-line-paired'),'Full native workload required');
  assert(report.backgroundBuildObservations.every(p=>p.processes.length===0),'Background compiler load invalidates a release gate trial');
  assert(report.backgroundBuildObservations.some(p=>p.label==='prelaunch'),'Prelaunch compiler observation is required');
  for(const phase of report.nativePhases)assert(report.backgroundBuildObservations.some(p=>p.label===phase.label),'Missing compiler observation for '+phase.label);
  const finite=(value,label)=>{assert(Number.isFinite(value)&&value>0,'Missing finite positive '+label);return value;};
  const phase=name=>{const found=report.nativePhases.find(p=>p.label===name);assert(found,'Missing phase '+name);for(const role of['nativeWrapper','rustHost','webContent','networking','gpu'])assert(found.tasks.some(t=>t.role===role),'Missing owned '+role+' in '+name);for(const task of found.tasks){finite(task.physicalFootprintMiB,name+' '+task.role+' footprint');finite(task.physicalFootprintPeakMiB,name+' '+task.role+' peak');}finite(found.chargedFootprintSumMiB,name+' sum');return found;};
  const trial=name=>{const found=report.nativeTrials.find(t=>t.label===name);assert.equal(found?.samples?.length,name==='high-line-paired'?3:12,'Exact equivalent native sample count required for '+name);return found;};
  const values=(name,metric)=>trial(name).samples.map(s=>finite(s[metric],name+' '+metric));
  const scrollValues=name=>{const rows=report.nativeTrials.find(t=>t.label===name)?.scrollSamples;assert.equal(rows?.length,8,'Exactly eight viewport movements required for '+name);assert(rows.some(s=>s.actual>0),'Global scrolling must move '+name);return rows.map(sample=>{for(const field of['target','actual','maximum'])assert(Number.isFinite(sample[field])&&sample[field]>=0,'Finite global scroll geometry required');assert(Math.abs(sample.target-sample.actual)<=2,'Global scroll target must be achieved');return finite(sample.milliseconds,name+' submitted-frame latency');});};
  const ordinary=['ordinary-local','ordinary-paired'].flatMap(name=>values(name,'nativeDispatchToFrameCallbackMilliseconds'));assert(ordinary.length>=24,'At least24ordinary trusted native samples');
  assert(report.nativeTrials.filter(t=>t.samples).every(t=>t.samples.every(s=>s.trustedKeyDown===undefined?s.trusted:s.trustedKeyDown&&s.nativeKeyAssociated&&(s.trusted||s.trustedBeforeInput)&&s.key==='x'&&s.nativeKeySequence===s.armedKeySequence)),'Trusted AppKit keydown and associated editor input required');
  assert.equal(report.cycles.length,report.workload.ordinaryOpenCloseCycles,'All declared open/close cycles must complete');
  const idle=phase('idle-no-documents').chargedFootprintSumMiB,retained=phase('high-line-closed-natural-8s').chargedFootprintSumMiB;
  return{ordinaryScrollSubmittedFrameEmpiricalP95Milliseconds:percentile(scrollValues('ordinary-local-scroll')),highLineScrollSubmittedFrameObservedMaxMilliseconds:Math.max(...scrollValues('high-line-scroll')),idleFootprintMiB:idle,ordinaryInputP95Milliseconds:percentile(ordinary),ordinaryPairedAckAndRenderP95Milliseconds:percentile(values('ordinary-paired','driverAckAndRenderMilliseconds')),normalFootprintMiB:Math.max(...['idle-no-documents','ordinary-local','ordinary-paired','eight-ordinary-open'].map(n=>phase(n).chargedFootprintSumMiB)),highLineChargedFootprintMiB:Math.max(...['high-line-open','high-line-after-input'].map(n=>phase(n).chargedFootprintSumMiB)),highLineChargedPeakSumMiB:Math.max(...['high-line-open','high-line-after-input'].map(n=>phase(n).tasks.reduce((sum,task)=>sum+task.physicalFootprintPeakMiB,0))),highLineWebContentPeakMiB:Math.max(...['high-line-open','high-line-after-input'].flatMap(n=>phase(n).tasks.filter(t=>t.role==='webContent').map(t=>t.physicalFootprintPeakMiB))),highLineRawRetainedFootprintMiB:retained,highLineRetainedExcessMiB:Math.max(0,retained-idle),cycleRetainedFootprintMiB:phase('ten-ordinary-cycles-closed').chargedFootprintSumMiB,highLineInputObservedMaxMilliseconds:Math.max(...values('high-line-paired','nativeDispatchToFrameCallbackMilliseconds')),highLinePairedAckAndRenderObservedMaxMilliseconds:Math.max(...values('high-line-paired','driverAckAndRenderMilliseconds'))};
}
function consistent(rows){
  for(const key of['instrumentationSha256','benchmarkSha256','metricsSourceSha256']){const values=new Set(rows.map(x=>x.report[key]));assert(values.size===1&&!values.has(undefined),'Same '+key+' required');}
  const fields=['mode','ordinaryBytes','ordinaryLines','highLineBytes','highLineLines','highLineOpenCount','highLineNativeKeystrokes','ordinaryOpenCloseCycles'];
  const workloads=new Set(rows.map(x=>JSON.stringify(fields.map(key=>{assert(x.report.workload[key]!==undefined,'Missing workload '+key);return x.report.workload[key];}))));assert.equal(workloads.size,1,'Same workload shape/counts required');
}
function frozenSide(rows){
  const identities=rows.map(({report})=>{const native=report.build.diagnosticWrapper?report.build.preResignDiagnosticWrapperSHA256:report.build.sourceNativeSha256;assert(/^[a-f0-9]{64}$/.test(native||''),'Pre-resign wrapper SHA from frozen source artifact is required');assert.equal(report.build.diagnosticBuildAssociation?.nativePreResignSha256,native,'Verified frozen helper build association required');assert.equal(report.build.diagnosticBuildAssociation?.metricsSourceSha256,report.metricsSourceSha256,'Native helper/source association must match');assert(/^[a-f0-9]{64}$/.test(report.build.hostSha256||''),'Frozen release host SHA required');return JSON.stringify([native,report.build.hostSha256,report.build.embeddedAssets]);});
  assert.equal(new Set(identities).size,1,'Same-side frozen wrapper, host and embedded assets must match');
}
function nativePreflight(){
  assert.equal(process.platform,'darwin','Actual macOS native app required');
  const session=execFileSync('/usr/sbin/ioreg',['-n','Root','-d','1'],{encoding:'utf8'}),locked=session.match(/"CGSSessionScreenIsLocked"\s*=\s*(Yes|No)/);
  assert(locked?.[1]!=='Yes','macOS session is locked: native visible-frame trials require an unlocked session');
  const commands=execFileSync('/bin/ps',['-axo','comm='],{encoding:'utf8'}).split('\n');assert(!commands.some(name=>/(?:^|\/)(?:cargo|rustc|swiftc|swift-frontend)$/.test(name.trim())),'Background compiler is active: wait for a quiet release performance trial');
  return{status:'pass',checkedAt:new Date().toISOString(),sessionLockFlag:locked?.[1]||'absent',explicitSessionLockDetected:false,activeCompilerCount:0,nativeVisibility:'The actual native trial additionally requires its visible-window double-frame barrier; an absent lock flag alone does not prove frame visibility.'};
}
function calibratedBudgets(){const budgets=read(budgetPath);assert.equal(budgets.calibrated,true,'Calibrate two valid quiet baselines before any candidate capture');return budgets;}
function validateBaselineDrift(rows,budgets){
  const measured=rows.map(x=>metrics(x.report));
  for(const[metric,budget]of Object.entries(budgets.bar)){
    if(budget.maximumAllowedSpreadRatio===null)continue;
    const all=[...budget.baselineValues,...measured.map(x=>x[metric])];
    assert((Math.max(...all)-Math.min(...all))/budget.baselineMedian<=budget.maximumAllowedSpreadRatio,'Baseline drift invalidates frozen '+metric+'; retain artifacts and repeat a quiet run without widening the bar');
  }
  return measured;
}
function capture(label,destination){
  assert(opts[label+'-app'],'Frozen '+label+' app required');assert(!fs.existsSync(destination),'Trial reports must not be overwritten');
  const wrapper=opts[label+'-wrapper']?path.resolve(opts[label+'-wrapper']):null,preResignSha=wrapper?sha(fs.readFileSync(wrapper)):null,argv=[path.join(__dirname,'native-performance-check.cjs'),'--app',path.resolve(opts[label+'-app']),'--output',destination];
  for(const[suffix,argument]of[['manifest','asset-manifest'],['ref','source-ref'],['wrapper','diagnostic-wrapper'],['diagnostic-manifest','diagnostic-manifest']])if(opts[label+'-'+suffix])argv.push('--'+argument,opts[label+'-'+suffix]);
  nativePreflight();const child=spawnSync(process.execPath,argv,{cwd:repo,stdio:'inherit'});assert.equal(child.status,0,'Trial failed; remaining stress trials are not run');
  if(wrapper){assert.equal(sha(fs.readFileSync(wrapper)),preResignSha,'Frozen diagnostic wrapper changed during trial');const report=read(destination);report.build.preResignDiagnosticWrapperSHA256=preResignSha;report.build.preResignWrapperEvidence='Immutable wrapper artifact SHA captured before and verified after child trial, before per-run bundle resigning';fs.writeFileSync(destination,JSON.stringify(report,null,2)+'\n');}
  const row=input(destination)[0];metrics(row.report);return row;
}
function verifyCaptureArtifacts(label,budgets,reference){
  const assetManifest=opts[label+'-manifest']?read(opts[label+'-manifest']):null,diagnostic=opts[label+'-diagnostic-manifest']?read(opts[label+'-diagnostic-manifest']):assetManifest?.diagnosticBuild;
  assert.equal(diagnostic?.metricsSourceSha256,budgets.metricsSourceSha256,'Frozen '+label+' helper must match calibrated Metrics source');
  const app=path.resolve(opts[label+'-app']),bundleIdentity=appBundle(app),native=opts[label+'-wrapper']?path.resolve(opts[label+'-wrapper']):path.join(app,bundleIdentity.native);
  assert.equal(sha(fs.readFileSync(native)),diagnostic.nativePreResignSha256,'Frozen '+label+' helper binary must match its manifest');
  if(reference){assert.equal(diagnostic.nativePreResignSha256,reference.build.preResignDiagnosticWrapperSHA256||reference.build.sourceNativeSha256,'Calibration used a different baseline native helper');assert.equal(sha(fs.readFileSync(path.join(app,bundleIdentity.host))),reference.build.hostSha256,'Calibration used a different baseline host');assert.deepEqual(assetManifest?.assets,reference.build.embeddedAssets,'Calibration used different baseline assets');}
}
const budgetPath=path.resolve(opts.budgets||path.join(repo,'scripts/native-performance-budgets.json'));
if(opts.preflight==='1'){
  console.log(JSON.stringify(nativePreflight(),null,2));
 }else if(opts['capture-baselines']==='1'){
  assert(!fs.existsSync(budgetPath),'Frozen budgets must not be overwritten');
  const prefix=path.resolve(opts['output-prefix']||path.join(repo,'tests/native-performance')),files=[];
  for(let index=1;index<=2;index++){const destination=prefix+'-calibration-baseline-'+index+'.json';console.log('Calibration baseline '+index+'/2');capture('baseline',destination);files.push(destination);}
  const calibrated=spawnSync(process.execPath,[__filename,'--calibrate',files.join(','),'--budgets',budgetPath],{cwd:repo,stdio:'inherit'});assert.equal(calibrated.status,0,'Baseline calibration failed; no candidate data captured and no bar widened');
}else if(opts.run==='1'){
  assert(opts['baseline-app']&&opts['candidate-app'],'--baseline-app and --candidate-app required');
  const budgets=calibratedBudgets(),budgetSHA=sha(fs.readFileSync(budgetPath)),references=input(budgets.baselineReports.map(r=>r.filename).join(','));
  for(const frozen of budgets.baselineReports)assert(references.some(r=>r.sha256===frozen.sha256),'Frozen calibration report changed');
  consistent(references);frozenSide(references);validateBaselineDrift(references,budgets);
  assert.equal(sha(fs.readFileSync(path.join(__dirname,'native-performance-check.cjs'))),budgets.benchmarkSha256,'Benchmark changed since calibration');
  assert.equal(sha(fs.readFileSync(path.join(repo,'desktop/macos/Metrics.swift'))),budgets.metricsSourceSha256,'Metrics helper changed since calibration');
  verifyCaptureArtifacts('baseline',budgets,references[0].report);verifyCaptureArtifacts('candidate',budgets);
  const prefix=path.resolve(opts['output-prefix']||path.join(repo,'tests/native-performance')),orders=['baseline','candidate','candidate','baseline'],drift=[...references],candidates=[];
  for(let index=0;index<orders.length;index++){
    assert.equal(sha(fs.readFileSync(budgetPath)),budgetSHA,'Frozen budgets changed during candidate capture');
    const label=orders[index],destination=prefix+'-'+label+'-'+(index+1)+'.json';console.log('Serial comparison '+(index+1)+'/'+orders.length+' '+label);const row=capture(label,destination);
    if(label==='baseline'){drift.push(row);consistent(drift);frozenSide(drift);validateBaselineDrift(drift,budgets);}else{candidates.push(row);consistent([...references,...candidates]);frozenSide(candidates);}
  }
  console.log('Comparison complete with unchanged pre-candidate numeric budgets; validate all calibration and drift references in the final verdict.');
}else if(opts.calibrate){
  assert(!fs.existsSync(budgetPath),'Do not overwrite frozen budgets; choose a new --budgets path');const rows=input(opts.calibrate);assert(rows.length>=2,'Calibration requires repeated baseline trials');consistent(rows);frozenSide(rows);const measured=rows.map(x=>metrics(x.report)),bar={};
  for(const name of Object.keys(measured[0])){
    const values=measured.map(x=>x[name]),baselineMedian=median(values),spread=Math.max(...values)-Math.min(...values),timing=name.includes('Milliseconds'),stabilityLimit=timing?.15:.10,natural=['highLineRawRetainedFootprintMiB','highLineRetainedExcessMiB','cycleRetainedFootprintMiB'].includes(name),reference=natural?Math.min(...values):baselineMedian;
    assert(values.every(value=>Number.isFinite(value)&&value>=0),'Finite nonnegative metric required '+name);
    if(!natural)assert(spread/baselineMedian<=stabilityLimit,'Unstable baseline '+name+': repeat quiet trials instead of widening budgets');
    const reduction=name==='highLineRetainedExcessMiB'||name==='highLineWebContentPeakMiB'?.70:['highLineInputObservedMaxMilliseconds','highLinePairedAckAndRenderObservedMaxMilliseconds'].includes(name)?.75:1,noiseAllowance=reduction<1||['highLineChargedFootprintMiB','highLineChargedPeakSumMiB'].includes(name)?0:Math.min(Math.max(8,natural?0:spread),reference*stabilityLimit);
    bar[name]={baselineMedian,baselineReference:reference,referenceSelection:natural?'Minimum valid natural checkpoint; variable GC disclosed, conservative acceptance':'Repeated baseline median',baselineValues:values,baselineSpread:spread,maximumAllowedSpreadRatio:natural?null:stabilityLimit,noiseAllowance,requiredRatio:reduction,maximum:reference*reduction+noiseAllowance,...(name==='highLineRetainedExcessMiB'?{retentionReductionEstablishable:reference>0}: {})};
  }
  const budgets={schemaVersion:1,calibrated:true,createdAt:new Date().toISOString(),description:'Machine/workload-specific budgets from at least2quiet frozen baselines. Reject unstable normal/peak/latency calibration above15percent timing/10percent memory spread. Idle and normal footprint each have bounded10percent parity allowance. Variable natural retained checkpoints use the minimum valid reference, not an enlarged noise allowance: raw-total/cycle parity plus30percent excess-over-own-idle reduction; zero reference requireszero excess and establishesno reduction. High-line whole-owned current charges and summed lifetime task peaks each require zero-additive parity (the latter is not simultaneous physical RAM); renderer peak requires30percent and observed worst-of3 input/both-render latency25percent reduction, withzero additive stress allowance. Ordinary scrolling empirical p95 and high-line observed worst-of8 submitted-frame latency require bounded15percent parity and stability. Every candidate trial must pass.',baselineReports:rows.map(({filename,sha256})=>({filename,sha256})),instrumentationSha256:rows[0].report.instrumentationSha256,benchmarkSha256:rows[0].report.benchmarkSha256,metricsSourceSha256:rows[0].report.metricsSourceSha256,bar};fs.writeFileSync(budgetPath,JSON.stringify(budgets,null,2)+'\n');console.log(budgetPath);
 }else{
  assert(opts.baseline&&opts.candidate,'Use --baseline calibration-and-drift-reports --candidate report1,report2 --budgets frozen.json');
  const baselines=input(opts.baseline),candidates=input(opts.candidate),budgets=calibratedBudgets();assert(baselines.length>=2&&candidates.length>=2,'Two serial trials per side required');
  consistent([...baselines,...candidates]);frozenSide(baselines);frozenSide(candidates);for(const reference of budgets.baselineReports)assert(baselines.some(x=>x.sha256===reference.sha256),'Frozen calibration report is absent or changed');
  for(const key of['instrumentationSha256','benchmarkSha256','metricsSourceSha256'])assert.equal(candidates[0].report[key],budgets[key]);
  const baselineMeasured=validateBaselineDrift(baselines,budgets),measured=candidates.map(x=>metrics(x.report));
  const naturalMetrics=['highLineRawRetainedFootprintMiB','highLineRetainedExcessMiB','cycleRetainedFootprintMiB'];
  const checks=Object.entries(budgets.bar).map(([metric,budget])=>{
    const values=measured.map(x=>x[metric]),candidateMedian=median(values),reference=naturalMetrics.includes(metric)?Math.min(budget.baselineReference,...baselineMeasured.map(x=>x[metric])):budget.baselineReference;
    const maximum=Math.min(budget.maximum,reference*budget.requiredRatio+budget.noiseAllowance);
    return{metric,baselineMedian:budget.baselineMedian,baselineReference:reference,candidateValues:values,candidateMedian,frozenMaximum:budget.maximum,maximum,pass:values.every(value=>value<=maximum)};
  });
  const verdict={schemaVersion:1,status:checks.every(x=>x.pass)?'pass':'fail',comparedAt:new Date().toISOString(),budgetsSha256:sha(fs.readFileSync(budgetPath)),baselineReports:baselines.map(({filename,sha256})=>({filename,sha256})),candidateReports:candidates.map(({filename,sha256})=>({filename,sha256})),baselineDrift:'All supplied references validated; non-natural metrics remain within frozen calibration spread. Lower natural checkpoints can only tighten acceptance, never widen budgets.',checks};
  const output=path.resolve(opts.output||path.join(repo,'tests/native-performance-verdict.json'));assert(!fs.existsSync(output),'Verdicts must not be overwritten');fs.writeFileSync(output,JSON.stringify(verdict,null,2)+'\n');console.log(JSON.stringify(verdict,null,2));if(verdict.status!=='pass')process.exitCode=1;
}
