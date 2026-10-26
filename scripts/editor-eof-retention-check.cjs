#!/usr/bin/env node
'use strict';
// Compare the same fixed Unicode EOF input, changing only whether a complete
// retained line needs recentering when its viewport extends into trailing space.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const playwright=require(process.env.PLAYWRIGHT_PATH||'playwright');
const repo=path.resolve(__dirname,'..'),baselinePath=path.resolve(process.env.EDITOR_EOF_BASELINE||path.join(repo,'target/final-local-performance/eof-retention-before.js'));
const predicate='this.scrollLeft+this.clientWidth<=retainedRight';
const fixed='(retainedEnd===lineEnd || this.scrollLeft+this.clientWidth<=retainedRight)';
const current=fs.readFileSync(path.join(repo,'web/editor.js'),'utf8');
const baselineOrigin=fs.existsSync(baselinePath) ? 'frozen actual pre-fix editor source' : 'counterfactual current source with only the EOF predicate reverted';
const baseline=fs.existsSync(baselinePath) ? fs.readFileSync(baselinePath,'utf8') : current.replace(fixed,predicate);
assert.equal(baseline.split(predicate).length,2,'The explicit baseline predicate changed');
assert(!baseline.includes(fixed),'The baseline must retain the old EOF predicate');
const proposed=baseline.replace(predicate,fixed);
const output=path.resolve(process.env.EDITOR_EOF_OUTPUT||path.join(repo,'target/final-local-performance/eof-retention-proof.json'));
let browser;const rows=[];
(async()=>{
 browser=await playwright.webkit.launch({headless:true});
 for(const reveal of [false,true])for(const [name,source] of [['before',baseline],['proposed',proposed]]){
  const page=await browser.newPage({viewport:{width:1280,height:800}});
  await page.setContent('<div class="codebox" style="inset:0"><div class="code-surface"><textarea id="code-input" class="code-input" wrap="off" spellcheck="false"></textarea></div></div>');
  await page.addStyleTag({content:fs.readFileSync(path.join(repo,'web/style.css'),'utf8')});await page.addScriptTag({content:source});
  const initial=await page.evaluate(reveal=>{
   const unit='界🙂e\u0301\tconst value = 123; ',line=unit.repeat(2048),text=Array.from({length:Math.floor(1040000/new TextEncoder().encode(line+'\n').length)},()=>line).join('\n');
   const editor=window.e=new NimloEditor(document.getElementById('code-input'));editor.value=text;editor.setSelectionRange(0,0);editor.scrollTop=0;editor.setSelectionRange(text.length,text.length);if(reveal)editor.reveal();editor.input.focus({preventScroll:true});
   window.originalText=text;window.eofWrites=0;const descriptor=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value');Object.defineProperty(editor.input,'value',{configurable:true,get(){return descriptor.get.call(this)},set(value){window.eofWrites++;descriptor.set.call(this,value)}});
   return{length:text.length,start:editor.start,nativeLength:editor.input.value.length,scrollTop:editor.scrollTop,scrollLeft:editor.scrollLeft};
  },reveal);
  const samples=[];
  for(let i=0;i<12;i++){
   await page.keyboard.press('x');await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
   const state=await page.evaluate(()=>({writes:window.eofWrites,start:e.start,nativeLength:e.input.value.length,length:e.length,selection:e.getSelection(),scrollTop:e.scrollTop,scrollLeft:e.scrollLeft}));
   assert.equal(state.selection.start,initial.length+i+1);assert.equal(state.selection.end,initial.length+i+1);samples.push(state);
  }
  assert.equal(await page.evaluate(()=>e.value===window.originalText+'x'.repeat(12)),true);
  let coverage=null;
  if(name==='proposed'){
   coverage=await page.evaluate(()=>{
    const text=e.value,lineStart=e.offsetAtLine(e.firstLine),tailStart=e.start,writes=window.eofWrites;
    e.scrollLeft=e.widthBetween(lineStart,e.length)+1500;
    const blankStable=e.start===tailStart&&window.eofWrites===writes;
    e.scrollLeft=Math.max(0,e.widthBetween(lineStart,tailStart)-e.clientWidth);
    const leftRecrops=e.start<tailStart;
    e.setSelectionRange(lineStart+24000,lineStart+24000);e.reveal();const middleStart=e.start,middleEnd=e.end;
    e.scrollLeft=e.widthBetween(lineStart,middleEnd)+1500;
    return{blankStable,leftRecrops,middleRecrops:e.start>middleStart,middleHadMoreText:middleEnd<text.length,unchanged:e.value===text};
   });
   assert(coverage.blankStable&&coverage.leftRecrops&&coverage.middleRecrops&&coverage.middleHadMoreText&&coverage.unchanged,JSON.stringify(coverage));
  }
  rows.push({name,reveal,sourceSha256:crypto.createHash('sha256').update(source).digest('hex'),initial,samples,coverage});
  await page.close();
 }
 const comparisons=[false,true].map(reveal=>{const before=rows.find(x=>x.name==='before'&&x.reveal===reveal),after=rows.find(x=>x.name==='proposed'&&x.reveal===reveal);assert(before.samples.at(-1).writes>after.samples.at(-1).writes,'The native reset must be reproduced and avoided');assert.equal(after.samples.at(-1).writes,0);assert.equal(after.samples.at(-1).start,after.initial.start);assert(after.samples.every(s=>s.nativeLength<=8192));return{reveal,beforeWrites:before.samples.at(-1).writes,afterWrites:after.samples.at(-1).writes};});
 fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,JSON.stringify({status:'pass',engine:'webkit',baselineOrigin,comparisons,rows,scope:'Isolated editor source; only proposed trailing-line predicate changed; trusted browser keys and exact full global text/caret; no native app memory/latency claim'},null,2)+'\n');
 console.log(JSON.stringify(comparisons));
})().catch(error=>{console.error(error);process.exitCode=1}).finally(async()=>{if(browser)await browser.close()});
