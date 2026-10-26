#!/usr/bin/env node
'use strict';
// Isolated native-control diagnostic. The final shipping measurement uses the
// separate native macOS fixture and includes the app, host and WebKit processes.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {performance}=require('node:perf_hooks');
const playwright=require(process.env.PLAYWRIGHT_PATH||'playwright');
const root=path.resolve(__dirname,'..'),engine=process.env.NIMLO_BROWSER||'webkit';
const before=path.resolve(process.env.EDITOR_BASELINE||path.join(root,'target/final-local-performance/baseline/editor.js'));
const after=path.resolve(process.env.EDITOR_CANDIDATE||path.join(root,'web/editor.js'));
const output=path.resolve(process.env.EDITOR_PERFORMANCE_OUTPUT||path.join(root,'target/final-local-performance/lowline-'+engine+'.json'));
const samples=Number(process.env.EDITOR_PERFORMANCE_SAMPLES||5),results=[];
const position=process.env.EDITOR_PERFORMANCE_POSITION==='end' ? 'end' : '80-percent';
const mixedLine='日本語 😀 cafe\u0301\tconst value = 42; '.repeat(140);
const fixtures=[{name:'ordinary',text:('const value = 42;\n').repeat(120)},
 {name:'near-1MiB-single-line-ASCII',text:'x'.repeat(1_040_000)},
 {name:'near-1MiB-few-line-Unicode',text:(mixedLine+'\n').repeat(Math.floor(1_040_000/Buffer.byteLength(mixedLine+'\n'))).trimEnd()}];
let browser;
const percentile=(xs,p)=>[...xs].sort((a,b)=>a-b)[Math.min(xs.length-1,Math.floor(xs.length*p))];
(async()=>{
 browser=await playwright[engine].launch({headless:true,...(engine==='chromium'?{executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'}:{})});
 for(const [label,source]of[['baseline',before],['candidate',after]])for(const fixture of fixtures){
  const page=await browser.newPage({viewport:{width:1280,height:800}}),errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.setContent('<!doctype html><html><head></head><body><div class="codebox" style="inset:0"><div class="code-surface"><textarea class="code-input" id="code-input" wrap="off" spellcheck="false"></textarea></div></div></body></html>');
  await page.addStyleTag({content:fs.readFileSync(path.join(root,'web/style.css'),'utf8')});await page.addScriptTag({content:fs.readFileSync(source,'utf8')});
  const initialization=await page.evaluate(({text,position})=>{const start=performance.now();window.editor=new NimloEditor(document.getElementById('code-input'));editor.value=text;let at=position==='end' ? text.length : Math.floor(text.length*.8);if(/[\uDC00-\uDFFF]/.test(text[at]))at--;editor.setSelectionRange(at,at);editor.reveal();editor.input.focus({preventScroll:true});window.startPosition=at;return{milliseconds:performance.now()-start,large:editor.large,nativeCharacters:editor.input.value.length,totalCharacters:text.length,lines:text.split('\n').length};},{text:fixture.text,position});
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  const durations=[];
  for(let i=0;i<samples;i++){
   await page.evaluate(()=>{window.finishedKey=false;const input=editor.input;input.addEventListener('keydown',()=>{window.keyStart=performance.now();requestAnimationFrame(()=>requestAnimationFrame(()=>{window.inputToFrames=performance.now()-window.keyStart;window.finishedKey=true;}));},{capture:true,once:true});});
   const start=performance.now();await page.keyboard.press('x');await page.waitForFunction(()=>window.finishedKey);
   durations.push({driverToTwoFramesMs:performance.now()-start,keydownToTwoFramesMs:await page.evaluate(()=>window.inputToFrames)});
  }
  const state=await page.evaluate(()=>({nativeCharacters:editor.input.value.length,selection:editor.selectionStart,length:editor.length,text:editor.value}));
  const expected=fixture.text.slice(0,await page.evaluate(()=>window.startPosition))+'x'.repeat(samples)+fixture.text.slice(await page.evaluate(()=>window.startPosition));
  assert.equal(state.text,expected);assert.deepEqual(errors,[]);
  let memory=null;
  if(engine==='chromium'){
   const cdp=await page.context().newCDPSession(page);await cdp.send('Performance.enable');await cdp.send('HeapProfiler.collectGarbage');const metrics=await cdp.send('Performance.getMetrics');
   memory={scope:'Isolated renderer JS heap after forced GC; excludes native text layout and app/host memory',usedJSHeapBytes:metrics.metrics.find(metric=>metric.name==='JSHeapUsedSize')?.value??null,dom:await cdp.send('Memory.getDOMCounters')};
  }
  const row={label,fixture:fixture.name,sourceSha256:crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex'),utf8Bytes:Buffer.byteLength(fixture.text),initialization,durations,
   keydownToTwoFramesMs:{median:percentile(durations.map(x=>x.keydownToTwoFramesMs),.5),p95:percentile(durations.map(x=>x.keydownToTwoFramesMs),.95)},
   nativeCharactersAfter:state.nativeCharacters,memory};results.push(row);console.log(label+' '+fixture.name+' '+row.keydownToTwoFramesMs.median.toFixed(1)+'ms; native chars '+state.nativeCharacters);
  await page.close();
 }
 const report={status:'passed',date:new Date().toISOString(),engine,samples,position,scope:'Isolated actual native textarea/editor.js; trusted browser keyboard, keydown through two animation frames',results,
  limitations:['This diagnostic is not the embedded Nimlo app or an OS dispatch-to-pixel measurement.','Renderer JS heap excludes browser native allocations; full app memory is measured separately.','Synthetic browser keyboard does not qualify physical IMEs or touch selection.']};
 fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n');
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{if(browser)await browser.close();});
