#!/usr/bin/env node
'use strict';

// Development-only release gate orchestration. Makefile builds/tests the
// candidate first; this runner never edits or rebuilds that candidate.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict'),{spawnSync}=require('node:child_process');
const repo=path.resolve(__dirname,'..'),args=process.argv.slice(2),opts={};
for(let i=0;i<args.length;i+=2){assert(args[i].startsWith('--')&&args[i+1],'Arguments are --name value pairs');opts[args[i].slice(2)]=args[i+1];}
const baselineRef=opts['baseline-ref']||'a811aaf',candidateApp=path.resolve(opts.app||path.join(repo,'target/desktop/Nimlo.app'));
const stages=['Check unlocked-session/compiler preflight','Prepare immutable original reference and exact current diagnostic helper','Freeze already-built candidate app and source association in a unique run directory','Capture two valid quiet baseline trials and freeze numeric budgets before candidate data','Capture serial baseline/candidate/candidate/baseline trials against unchanged budgets','Validate all reference drift and require every candidate trial to pass'];
if(opts.plan==='1'){
  console.log(JSON.stringify({schemaVersion:1,mode:'plan',baselineRef,candidateApp,artifactRoot:path.join(repo,'target/performance-runs'),stages,willSpawnProcesses:false,willLaunchApps:false,willBuild:false,willCapture:false,willModifyFiles:false},null,2));process.exit(0);
}
assert.equal(process.platform,'darwin','Actual macOS native release required');assert(fs.existsSync(candidateApp),'Build the candidate release app before running the gate');
const runId=new Date().toISOString().replace(/[:.]/g,'-')+'-'+crypto.randomUUID().slice(0,8),directory=path.join(repo,'target/performance-runs',runId),lock=path.join(repo,'target/native-performance-run.lock');
fs.mkdirSync(path.dirname(directory),{recursive:true});fs.mkdirSync(lock,{mode:0o700});fs.mkdirSync(directory,{mode:0o700});
const summary={schemaVersion:1,status:'running',runId,startedAt:new Date().toISOString(),directory,baselineRef,candidateApp,stages:[],candidateMeasured:false,budgetsFrozenBeforeCandidate:false,realInferenceRequests:0,tunnelStarted:false};
const summaryFile=path.join(directory,'run.json'),prepared=path.join(directory,'prepared-baseline.json'),candidate=path.join(directory,'candidate'),budgets=path.join(directory,'budgets.json'),prefix=path.join(directory,'comparison'),calibrationPrefix=path.join(directory,'calibration');
const write=()=>fs.writeFileSync(summaryFile,JSON.stringify(summary,null,2)+'\n',{mode:0o600});
function invoke(label,file,argv){summary.currentStage=label;write();console.log('Release performance: '+label);const child=spawnSync(process.execPath,[path.join(__dirname,file),...argv],{cwd:repo,stdio:'inherit'});summary.stages.push({label,exitCode:child.status,signal:child.signal||null});write();assert.equal(child.status,0,label+' failed; artifacts retained at '+directory);}
function blind(){
  const files={baseline:[prefix+'-baseline-1.json',prefix+'-baseline-4.json'],candidate:[prefix+'-candidate-2.json',prefix+'-candidate-3.json']};
  if(!Object.values(files).flat().every(filename=>fs.existsSync(filename)))return;
  const order=crypto.randomInt(2)?['baseline','candidate']:['candidate','baseline'],rows=side=>files[side].map(filename=>{const report=JSON.parse(fs.readFileSync(filename));return{workload:report.workload,nativePhases:report.nativePhases.map(p=>({scenario:p.label,chargedFootprintSumMiB:p.chargedFootprintSumMiB,roles:p.tasks.map(t=>({role:t.role,physicalFootprintMiB:t.physicalFootprintMiB,physicalFootprintPeakMiB:t.physicalFootprintPeakMiB}))})),nativeTrials:report.nativeTrials.map(t=>({scenario:t.label,samples:t.samples?.map(s=>({trusted:s.trusted,nativeDispatchToFrameCallbackMilliseconds:s.nativeDispatchToFrameCallbackMilliseconds,driverAckAndRenderMilliseconds:s.driverAckAndRenderMilliseconds,inputHandlerMilliseconds:s.inputHandlerMilliseconds}))})),browserPhases:report.browserPhases.map(p=>({scenario:p.label,chargedFootprintSumMiB:p.chargedFootprintSumMiB,naturalHeap:p.naturalHeap,afterForcedGCHeap:p.afterForcedGCHeap,dom:p.dom}))};});
  const file=path.join(directory,'blind-comparison.json');fs.writeFileSync(file,JSON.stringify({schemaVersion:1,description:'Anonymous matching paired comparison rows; calibration-only trials excluded from this equal-count review bundle',groups:{A:rows(order[0]),B:rows(order[1])}},null,2)+'\n',{mode:0o600});summary.blindComparison=file;summary.blindIdentityForParent={A:order[0],B:order[1]};
}
try{
  invoke('preflight','native-performance-gate.cjs',['--preflight','1']);
  invoke('prepare reference','native-performance-prepare-baseline.cjs',['--source-ref',baselineRef,'--output',prepared]);summary.preparedBaseline=prepared;
  invoke('freeze candidate','native-performance-freeze.cjs',['--app',candidateApp,'--destination',candidate,'--working-tree','1']);summary.frozenCandidate=path.join(candidate,'Nimlo.app');
  invoke('baseline calibration','native-performance-gate.cjs',['--capture-baselines','1','--baseline-preparation',prepared,'--output-prefix',calibrationPrefix,'--budgets',budgets]);
  assert(JSON.parse(fs.readFileSync(budgets)).calibrated);summary.budgetsFrozenBeforeCandidate=true;summary.budgets=budgets;summary.budgetsSha256=crypto.createHash('sha256').update(fs.readFileSync(budgets)).digest('hex');write();
  invoke('paired comparison','native-performance-gate.cjs',['--run','1','--baseline-preparation',prepared,'--candidate-app',path.join(candidate,'Nimlo.app'),'--candidate-manifest',path.join(candidate,'manifest.json'),'--output-prefix',prefix,'--budgets',budgets]);summary.candidateMeasured=true;
  const baselines=[calibrationPrefix+'-calibration-baseline-1.json',calibrationPrefix+'-calibration-baseline-2.json',prefix+'-baseline-1.json',prefix+'-baseline-4.json'],candidates=[prefix+'-candidate-2.json',prefix+'-candidate-3.json'];
  summary.baselineReports=baselines;summary.candidateReports=candidates;blind();
  const verdict=path.join(directory,'verdict.json');invoke('frozen verdict','native-performance-gate.cjs',['--baseline',baselines.join(','),'--candidate',candidates.join(','),'--budgets',budgets,'--output',verdict]);summary.verdict=verdict;summary.status='pass';summary.completedAt=new Date().toISOString();write();console.log(JSON.stringify(summary,null,2));
}catch(error){
  summary.status=summary.currentStage==='baseline calibration'?'baseline-calibration-failed':'fail';summary.error=String(error.message);summary.completedAt=new Date().toISOString();
  summary.candidateMeasured=fs.existsSync(prefix+'-candidate-2.json')||fs.existsSync(prefix+'-candidate-3.json');blind();write();console.error(summary.error);console.error('Retained release-gate report: '+summaryFile);process.exitCode=1;
}finally{fs.rmSync(lock,{recursive:true,force:true});}
