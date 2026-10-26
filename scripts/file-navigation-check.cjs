#!/usr/bin/env node
'use strict';
// Real embedded UI, deep folders and a project exceeding one search batch.
// All edits and source opens stay in disposable files; optional real-root
// verification searches metadata only and cancels without opening a file.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const playwright=require(process.env.PLAYWRIGHT_PATH||path.resolve(__dirname,'../../mini_gym/node_modules/playwright'));
const engine=process.env.NIMLO_BROWSER||'chromium',repo=path.resolve(__dirname,'..');
const out=path.join(repo,'target/file-navigation-review',engine),fixture=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'nimlo-file-navigation-')));
const root=path.join(fixture,'project'),bin=path.join(fixture,'bin'),folder='docs/branding/novus-unbound/logo-exploration';
const target=folder+'/logo-v03-master-prompt.txt',longName='logo-v03-master-prompt-with-a-long-descriptive-name-and-unique-ending.txt';
const checks=[],layouts=[],errors=[];let browser,host,page,url;
for(const dir of [root,bin,out,path.join(root,'bulk')])fs.mkdirSync(dir,{recursive:true});
for(let index=0;index<20_100;index++)fs.writeFileSync(path.join(root,'bulk','item-'+String(index).padStart(5,'0')+'.txt'),'');
fs.mkdirSync(path.join(root,folder),{recursive:true});
fs.writeFileSync(path.join(root,target),'Nested prompt fixture\n');
fs.writeFileSync(path.join(root,folder,longName),'Long filename fixture\n');
for(const name of ['README.md','generation-record.json','logo-v02-prompt.txt','logo-v03-correction-prompt.txt','user-logo-v01.png'])fs.writeFileSync(path.join(root,folder,name),'fixture\n');
for(const provider of ['codex','claude'])fs.writeFileSync(path.join(bin,provider),'#!/bin/sh\nprintf "Logged in using subscription\\n"\n',{mode:0o700});
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function capture(){
  const Original=WebSocket;window.__nav={sent:[],replies:[],requests:{},bootstrap:null,socket:null,holdQuery:null,held:null,id:0};
  window.WebSocket=class extends Original{
    constructor(...args){super(...args);window.__nav.socket=this;this.addEventListener('message',event=>{
      const value=JSON.parse(event.data),n=window.__nav,request=n.requests[value.requestId];
      if(value.type==='bootstrap')n.bootstrap=value;
      if(value.type==='project_file_search'&&request?.cursor&&request.query===n.holdQuery){n.held=event.data;event.stopImmediatePropagation();return;}
      n.replies.push(value);
    });}
    send(raw){const request=JSON.parse(raw);window.__nav.sent.push(request);window.__nav.requests[request.requestId]=request;super.send(raw);}
  };
}
async function check(name,work){await work();checks.push(name);console.log('PASS '+name);}
async function picker(query){await page.keyboard.press((process.platform==='darwin'?'Meta':'Control')+'+p');await page.locator('#command-dialog').waitFor({state:'visible'});await page.fill('#command-input',query);}
async function release(){await page.evaluate(()=>{const n=window.__nav,held=n.held;n.holdQuery=null;n.held=null;if(held)n.socket.dispatchEvent(new MessageEvent('message',{data:held}));});}
async function rpc(type,fields){return page.evaluate(({type,fields})=>new Promise((resolve,reject)=>{
  const n=window.__nav,id='nav-'+(++n.id),timer=setTimeout(()=>reject(Error('Command timeout')),15000);
  const listener=event=>{const value=JSON.parse(event.data);if(value.requestId!==id)return;clearTimeout(timer);n.socket.removeEventListener('message',listener);value.type==='error'?reject(Error(value.message)):resolve(value);};
  n.socket.addEventListener('message',listener);n.socket.send(JSON.stringify({type,requestId:id,projectId:n.bootstrap.projectId,generation:n.bootstrap.generation,...fields}));
}),{type,fields});}
async function files(){if(await page.locator('#files-menu').isHidden())await page.click('#files-toggle');await page.locator('#files-menu').waitFor({state:'visible'});}
async function expand(){
  await files();const rootButton=page.locator('#file-tree .project-expand');
  if(await rootButton.getAttribute('aria-expanded')!=='true')await rootButton.click();
  const parts=folder.split('/');for(let index=1;index<=parts.length;index++){
    const button=page.locator('.tree-entry[data-path="'+parts.slice(0,index).join('/')+'"]');
    await button.waitFor({state:'visible'});if(await button.getAttribute('aria-expanded')!=='true')await button.click();
  }
}
(async()=>{
  host=spawn(path.resolve(repo,process.env.NIMLO_BINARY||'target/release/nimlo-editor'),['--workspace',root,'--state-dir',path.join(fixture,'state'),'--listen','127.0.0.1:0'],{env:{...process.env,PATH:bin+path.delimiter+process.env.PATH},stdio:['ignore','pipe','pipe']});
  url=await new Promise((resolve,reject)=>{let output='';const timer=setTimeout(()=>reject(Error('Host startup timeout')),20000);host.stdout.on('data',data=>{output+=data;const match=output.match(/http:\/\/[^\s]+\/#token=[a-f0-9]{64}/);if(match){clearTimeout(timer);resolve(match[0]);}});host.on('error',reject);});
  browser=await playwright[engine].launch({headless:true,...(engine==='chromium'?{executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'}:{})});
  const context=await browser.newContext({viewport:{width:1280,height:800}});await context.addInitScript(capture);
  page=await context.newPage();page.setDefaultTimeout(20000);page.on('pageerror',error=>errors.push(error.message));await page.goto(url);await page.waitForFunction(()=>document.getElementById('app').dataset.controller==='yes');
  await check('Large-project Cmd P continues past the old cutoff and opens the nested file',async()=>{
    assert.equal(await page.evaluate(()=>window.__nav.sent.filter(r=>r.type==='search_project_files').length),0);
    await picker('logo-v03-master-prompt.txt');
    await page.waitForFunction(target=>[...document.querySelectorAll('.command-result small')].some(e=>e.textContent===target),target);
    await page.waitForFunction(()=>!document.getElementById('command-hint').textContent.startsWith('Searching'));
    const requests=await page.evaluate(()=>window.__nav.sent.filter(r=>r.type==='search_project_files'));
    assert(requests.length>=2);assert(requests.some(request=>request.cursor));
    assert(await page.locator('.command-result').count()<=80);
    await page.keyboard.press('Enter');await page.locator('#command-dialog').waitFor({state:'hidden'});
    await page.waitForFunction(()=>document.getElementById('code-input').value==='Nested prompt fixture\n');
  });
  await check('Changing query during a continuation discards stale results',async()=>{
    await page.evaluate(()=>window.__nav.holdQuery='no-such-file');await picker('no-such-file');await page.waitForFunction(()=>!!window.__nav.held);
    await page.fill('#command-input','logo-v03-correction');await release();
    await page.waitForFunction(()=>document.querySelector('.command-result > span')?.textContent==='logo-v03-correction-prompt.txt');
    assert.equal(await page.inputValue('#command-input'),'logo-v03-correction');await page.keyboard.press('Escape');
  });
  await check('Closing the picker stops requesting further batches',async()=>{
    await page.evaluate(()=>window.__nav.holdQuery='cancel-this-scan');await picker('cancel-this-scan');await page.waitForFunction(()=>!!window.__nav.held);
    await page.keyboard.press('Escape');const before=await page.evaluate(()=>window.__nav.sent.filter(r=>r.type==='search_project_files'&&r.query==='cancel-this-scan').length);
    await release();await pause(180);
    assert.equal(await page.evaluate(()=>window.__nav.sent.filter(r=>r.type==='search_project_files'&&r.query==='cancel-this-scan').length),before);
    assert(await page.locator('#command-dialog').isHidden());
  });
  await check('Deep file trees retain full names and independent scrolling at desktop and phone sizes',async()=>{
    await expand();
    for(const [width,height] of [[1280,800],[542,904],[390,844],[320,568],[320,300],[844,390]]){
      await page.setViewportSize({width,height});await files();
      const row=page.locator('.tree-entry[data-path="'+folder+'/'+longName+'"]');await row.scrollIntoViewIfNeeded();
      const layout=await row.evaluate(row=>{
        const tree=document.getElementById('file-tree'),menu=document.getElementById('files-menu'),filter=document.getElementById('file-filter');
        const t=tree.getBoundingClientRect(),m=menu.getBoundingClientRect(),f=filter.getBoundingClientRect(),label=row.querySelector('.entry-name'),l=label.getBoundingClientRect();
        tree.scrollLeft=tree.scrollWidth;
        const end=label.getBoundingClientRect();
        return {width:innerWidth,height:innerHeight,menu:{left:m.left,right:m.right,top:m.top,bottom:m.bottom,width:m.width},treeTop:t.top,filterBottom:f.bottom,treeHeight:t.height,fullNameWidth:l.width,textWidth:label.scrollWidth,textOverflow:getComputedStyle(label).textOverflow,scrollWidth:tree.scrollWidth,clientWidth:tree.clientWidth,labelEnd:end.right,treeRight:t.right,documentWidth:document.documentElement.scrollWidth,padding:parseFloat(getComputedStyle(row).paddingLeft)};
      });
      assert(layout.menu.left>=0&&layout.menu.right<=width+1&&layout.menu.top>=0&&layout.menu.bottom<=height+1,JSON.stringify(layout));
      assert(layout.treeTop>=layout.filterBottom&&layout.treeHeight>=40,JSON.stringify(layout));
      assert.equal(layout.textOverflow,'clip');assert(layout.fullNameWidth>=layout.textWidth-1);assert(layout.labelEnd<=layout.treeRight+1);
      assert(layout.scrollWidth>layout.clientWidth);assert(layout.documentWidth<=width);assert(layout.padding<=50);
      if(width===1280)assert(layout.menu.width>=400);
      layouts.push(layout);await page.locator('#file-tree').evaluate(tree=>{tree.scrollLeft=0;});
      await page.screenshot({path:path.join(out,'tree-'+width+'x'+height+'.png')});
    }
  });
  if(process.env.NIMLO_NAVIGATION_REAL_ROOT)await check('Screenshot filename is discoverable in the original project using metadata only',async()=>{
    await page.click('#menu-close');await page.setViewportSize({width:1280,height:800});
    await rpc('add_project',{path:process.env.NIMLO_NAVIGATION_REAL_ROOT});
    await picker('logo-v03-master-prompt.txt');
    await page.waitForFunction(()=>[...document.querySelectorAll('.command-result small')].some(e=>e.textContent.endsWith('docs/branding/novus-unbound/logo-exploration/logo-v03-master-prompt.txt')),null,{timeout:120000});
    await page.screenshot({path:path.join(out,'original-project-search.png')});await page.keyboard.press('Escape');
  });
  assert.deepEqual(errors,[]);
  fs.writeFileSync(path.join(out,'report.json'),JSON.stringify({status:'pass',engine,checks,layouts,errors},null,2));
})().catch(error=>{fs.writeFileSync(path.join(out,'report.json'),JSON.stringify({status:'fail',engine,error:error.stack,checks,layouts,errors},null,2));console.error(error.stack);process.exitCode=1;}).finally(async()=>{
  await browser?.close();if(host&&host.exitCode===null){host.kill('SIGTERM');await new Promise(resolve=>{host.once('exit',resolve);setTimeout(resolve,4000);});}fs.rmSync(fixture,{recursive:true,force:true});
});
