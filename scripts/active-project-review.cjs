#!/usr/bin/env node
'use strict';
const patchFixture=require('./patch-fixture.cjs');
const actions=require('./ui-actions.cjs');

// Independent gauntlet review: real embedded release and disposable projects.
// No provider inference, public tunnel, live workspace, or production service.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const assert=require('node:assert/strict'),crypto=require('node:crypto');
const {spawn}=require('node:child_process');
const playwright=require(process.env.PLAYWRIGHT_PATH||path.resolve(__dirname,'../../mini_gym/node_modules/playwright'));
const engine=process.env.NIMLO_BROWSER||'chromium';
assert(['chromium','webkit'].includes(engine),'Choose chromium or webkit');
const repo=path.resolve(__dirname,'..'),binary=path.resolve(repo,process.env.NIMLO_BINARY||'target/release/nimlo-editor');
const binarySha256=crypto.createHash('sha256').update(fs.readFileSync(binary)).digest('hex');
const artifacts=path.join(repo,'tests','active-project-review-'+engine);
const fixture=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'nimlo-active-project-critic-')));
const bin=path.join(fixture,'bin'),stateDir=path.join(fixture,'state');
const roots=[path.join(fixture,'client','app'),path.join(fixture,'server','app'),path.join(fixture,'long-project-name-with-clear-mobile-context'),path.join(fixture,'utility')];
const initialTexts=roots.map((root,index)=>'// Project '+String.fromCharCode(65+index)+' on the hosting PC\nexport const project = '+JSON.stringify(String.fromCharCode(65+index))+';\n');
const checks=[],screenshots=[],layouts=[],errors=[],expectedNetwork=[],findings=[];
let host,browser,pc,phone,pcContext,phoneContext,privateUrl,browserVersion,stage='startup';
fs.mkdirSync(bin,{recursive:true});fs.mkdirSync(artifacts,{recursive:true});
roots.forEach((root,index)=>{
  fs.mkdirSync(path.join(root,'src'),{recursive:true});
  fs.writeFileSync(path.join(root,'shared.js'),initialTexts[index]);
  fs.writeFileSync(path.join(root,'src','context.js'),'export const root = '+JSON.stringify(String.fromCharCode(65+index))+';\n');
});
fs.symlinkSync(path.join(roots[1],'shared.js'),path.join(roots[0],'outside.js'));
fs.symlinkSync(roots[1],path.join(fixture,'server-alias'));
fs.mkdirSync(path.join(roots[0],'src','client'));
const filteredText='// A nested result must stay touchable above the phone keyboard.\n';
fs.writeFileSync(path.join(roots[0],'src','client','target-focus.js'),filteredText);
for(let index=0;index<36;index++)fs.writeFileSync(path.join(roots[0],'src','client','module-'+String(index).padStart(2,'0')+'.js'),'export const value = '+index+';\n');
const callsLog=path.join(fixture,'provider-calls.jsonl');
const fake=String.raw`#!/usr/bin/env node
const fs=require('node:fs'),readline=require('node:readline');
fs.appendFileSync(process.env.NIMLO_REVIEW_LOG,JSON.stringify({event:'spawn',cwd:process.cwd(),args:process.argv.slice(2)})+'\n');
if(process.argv[2]==='login'){if(fs.existsSync(process.env.NIMLO_REVIEW_AUTH_GATE)){console.log('Not logged in');process.exit(1);}console.log('Logged in using ChatGPT');process.exit(0);}
if(process.argv[2]==='auth'){console.log(JSON.stringify({loggedIn:!fs.existsSync(process.env.NIMLO_REVIEW_AUTH_GATE),subscriptionType:'fixture'}));process.exit(0);}
const send=value=>console.log(JSON.stringify(value));
readline.createInterface({input:process.stdin}).on('line',line=>{
 const frame=JSON.parse(line);
 fs.appendFileSync(process.env.NIMLO_REVIEW_LOG,JSON.stringify({event:'frame',cwd:process.cwd(),frame})+'\n');
 if(frame.method==='initialize')send({id:frame.id,result:{userAgent:'independent-review-fixture'}});
 else if(frame.method==='thread/start'||frame.method==='thread/resume')send({id:frame.id,result:{thread:{id:'review-'+Buffer.from(process.cwd()).toString('hex').slice(-12)}}});
 else if(frame.method==='turn/start'){
  send({id:frame.id,result:{turn:{id:'review-turn'}}});
  const finish=()=>{send({method:'item/completed',params:{item:{id:'reply',type:'agentMessage',text:'Fixture AI reply from '+process.cwd()}}});send({method:'turn/completed',params:{turn:{id:'review-turn',status:'completed',error:null}}});};
  if(JSON.stringify(frame.params).includes('HOLD')){
   const timer=setInterval(()=>{if(fs.existsSync(process.env.NIMLO_REVIEW_GATE)){clearInterval(timer);finish();}},25);
  }else finish();
 }
 else if(frame.method==='turn/interrupt')send({method:'turn/completed',params:{turn:{id:'review-turn',status:'interrupted',error:null}}});
});
`;
fs.writeFileSync(path.join(bin,'codex'),fake,{mode:0o700});
fs.writeFileSync(path.join(bin,'claude'),fake,{mode:0o700});
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function startHost(resume=false){
 host=spawn(binary,[...(resume?['--resume-project']:['--workspace',roots[0]]),'--state-dir',stateDir,'--listen','0.0.0.0:0'],{
  env:{...process.env,PATH:bin+path.delimiter+process.env.PATH,NIMLO_REVIEW_LOG:callsLog,NIMLO_REVIEW_GATE:path.join(fixture,'ai-gate'),NIMLO_REVIEW_AUTH_GATE:path.join(fixture,'auth-gate')},stdio:['ignore','pipe','pipe'],
 });
 privateUrl=await new Promise((resolve,reject)=>{
  let output='',stderr='';const timer=setTimeout(()=>reject(Error('Fixture host startup timeout: '+stderr)),20000);
  host.stdout.on('data',chunk=>{output+=chunk;const match=output.match(/http:\/\/[^\s]+\/#token=[a-f0-9]{64}/);if(match){clearTimeout(timer);resolve(match[0]);}});
  host.stderr.on('data',chunk=>{stderr+=chunk;});
  host.on('error',reject);host.on('exit',code=>{clearTimeout(timer);reject(Error('Fixture host exit '+code+': '+stderr));});
 });
 return privateUrl;
}
async function stopHost(){
 if(!host||host.exitCode!==null)return;
 const process=host;host=null;
 await new Promise(resolve=>{const timer=setTimeout(()=>{process.kill('SIGKILL');},10000);process.once('exit',()=>{clearTimeout(timer);resolve();});process.kill('SIGTERM');});
}
async function capture(context){
 await patchFixture.install(context);
 await context.addInitScript(()=>{
  const Original=window.WebSocket;
  window.__review={events:[],sent:[],sockets:[],projectId:null,generation:0,bootstrap:null,projects:[]};
  window.WebSocket=class extends Original{
   constructor(...args){super(...args);window.__review.sockets.push(this);this.addEventListener('message',message=>{
    const value=window.__patchFixture.observe(JSON.parse(message.data)),review=window.__review;
    if(value.type==='bootstrap'&&review.delayNextBootstrap){const delay=review.delayNextBootstrap;review.delayNextBootstrap=0;review.delayedBootstraps=(review.delayedBootstraps||0)+1;message.stopImmediatePropagation();setTimeout(()=>this.dispatchEvent(new MessageEvent('message',{data:message.data})),delay);return;}
    review.events.push(value);
    if(value.type==='bootstrap'){review.bootstrap=value;review.projectId=value.projectId;review.generation=value.generation;}
    if(value.projects)review.projects=value.projects;
    if(value.type==='control'&&value.generation!==undefined)review.generation=value.generation;
   });}
   send(raw){window.__review.sent.push(JSON.parse(raw));super.send(raw);}
  };
  let next=0;
  window.__reviewCommand=(type,fields={},mutate=false)=>new Promise((resolve,reject)=>{
   const review=window.__review,socket=review.sockets.at(-1),requestId='critic-'+(++next);
   const timer=setTimeout(()=>{socket.removeEventListener('message',listener);reject(Error('Fixture command timeout: '+type));},12000);
   const listener=message=>{const value=JSON.parse(message.data);if(value.requestId===requestId){clearTimeout(timer);socket.removeEventListener('message',listener);resolve(value);}};
   socket.addEventListener('message',listener);
   socket.send(JSON.stringify({type,requestId,projectId:review.projectId,...(mutate?{generation:review.generation}:{}),...fields}));
  });
 });
}
function observe(page){
 page.setDefaultTimeout(15000);page.on('pageerror',error=>errors.push(error.message));
 page.on('console',message=>{
  if(message.type()!=='error'||message.text().includes('401'))return;
  if(page.__expectedDisconnect&&/WebSocket.+(closed|lost|failed|error)/i.test(message.text())){expectedNetwork.push('Browser reported deliberately disconnected fixture host/socket');return;}
  errors.push(message.text());
 });
}
const command=(page,type,fields={},mutate=false)=>page.evaluate(([t,f,m])=>window.__reviewCommand(t,f,m),[type,fields,mutate]);
const snapshot=page=>page.evaluate(()=>{const review=window.__review,current=review.projectId,result={...review.bootstrap};for(const event of review.events){if(event.type==='bootstrap'&&event.projectId===current){Object.assign(result,event);}else if(event.projectId===current){if(event.type==='terminal_state')result.terminal=event.terminal;if(event.type==='ai_state')result.ai=event.ai;}}result.projects=review.projects;return result;});
const projectIdFor=(page,root)=>page.evaluate(root=>window.__review.projects.find(project=>project.path===root||project.workspacePath===root)?.id,root);
async function check(name,work){stage=name;await work();checks.push(name);console.log('PASS '+name);}
async function screenshot(page,name){await page.bringToFront();await page.waitForTimeout(120);const file=name+'.png';await page.screenshot({path:path.join(artifacts,file)});screenshots.push(file);}
const rootNode=(page,id)=>page.locator('.project-root[data-project-id="'+id+'"]');
async function projects(page){await menu(page);await page.locator('#file-tree .project-root').first().waitFor({state:'visible'});}
async function expandRoot(page,id){
 const button=rootNode(page,id).locator('.project-expand');
 if(await button.getAttribute('aria-expanded')!=='true')await button.click();
 await rootNode(page,id).locator('.tree-entry[data-path="shared.js"]').waitFor({state:'visible'});
}
async function select(page,id){
 if(await page.evaluate(()=>window.__review.projectId)===id)return;
 await quickSelect(page,id);
 await projects(page);await expandRoot(page,id);
 await rootNode(page,id).locator('.tree-entry[data-path="shared.js"]').click();
 await page.waitForFunction(id=>window.__review.projectId===id,id);
 await page.waitForFunction(()=>!document.getElementById('code-input').readOnly);
}
async function quickMenu(page){
 await closeMenu(page);
 if(await page.locator('#project-menu').isHidden())await page.click('#projects-toggle');
 await page.locator('#project-menu').waitFor({state:'visible'});
 const active=page.locator('#project-menu .quick-project-select[aria-current="page"]');
 assert.equal(await active.count(),1,'Quick picker must expose exactly one active project');
 assert.equal(await active.getAttribute('data-project-id'),await page.evaluate(()=>window.__review.projectId),'Quick picker active state is stale');
}
async function quickSelect(page,id,surface){
 const before=await page.evaluate(()=>({projectId:window.__review.projectId,sent:window.__review.sent.length,view:document.getElementById('app').dataset.view}));
 await quickMenu(page);
 await page.locator('#project-menu .quick-project-select[data-project-id="'+id+'"]').click();
 await page.waitForFunction(id=>window.__review.projectId===id,id);
 await page.locator('#project-menu').waitFor({state:'hidden'});
 await page.waitForFunction(()=>document.getElementById('app').dataset.connected==='yes'&&document.getElementById('app').dataset.controller==='yes');
 const after=await page.evaluate(start=>({view:document.getElementById('app').dataset.view,sent:window.__review.sent.slice(start)}),before.sent);
 assert.equal(after.view,surface||before.view,'Quick switch navigates away from the working surface');
 assert(!after.sent.some(value=>value.type==='open_file'),'Quick switch opens a file as a side effect');
 assert(!after.sent.some(value=>value.type==='list_project_files'),'Quick switch expands or scans project roots as a side effect');
 const selections=after.sent.filter(value=>value.type==='select_project');
 assert.equal(selections.length,before.projectId===id?0:1,'Quick switch sends redundant project-selection commands');
 if(selections.length)assert.equal(selections[0].targetProjectId,id);
}
async function add(page,root){
 await quickMenu(page);
 await page.click('#quick-add-project');await page.fill('#project-path',root);await page.click('#project-submit');
 await page.locator('#project-dialog').waitFor({state:'hidden'});
 await page.waitForFunction(root=>window.__review.bootstrap?.workspacePath===root,root);
 return (await snapshot(page)).projectId;
}
async function menu(page,section='files'){return actions.menu(page,section);}
async function closeMenu(page){return actions.closeMenu(page);}
async function dismissNotice(page){if(await page.locator('#notice').isVisible())await page.locator('#notice').click();}
async function openShared(page){await menu(page);const id=await page.evaluate(()=>window.__review.projectId);await expandRoot(page,id);await rootNode(page,id).locator('.tree-entry[data-path="shared.js"]').click();await page.waitForFunction(()=>document.getElementById('code-input').value.includes('hosting PC'));}
async function layout(page,name,touch=true){
 const result=await page.evaluate(()=>{
  const bounds=element=>{const r=element.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height};};
  const visible=element=>!!(element.offsetWidth||element.offsetHeight||element.getClientRects().length)&&getComputedStyle(element).visibility!=='hidden';
  return {viewport:{width:innerWidth,height:innerHeight},documentWidth:document.documentElement.scrollWidth,dom:document.querySelectorAll('*').length,controls:[...document.querySelectorAll('button,select,input,textarea')].filter(visible).filter(el=>el.id!=='code-input'&&el.id!=='terminal-command').map(el=>({id:el.id||el.getAttribute('aria-label')||el.textContent.trim(),...bounds(el)})),menu:visible(document.getElementById('files-menu'))?bounds(document.getElementById('files-menu')):null};
 });
 result.name=name;layouts.push(result);assert(result.documentWidth<=result.viewport.width,name+' has page overflow');
 for(const id of ['projects-toggle','files-toggle','save-button']){const item=result.controls.find(item=>item.id===id);if(item)assert(item.left>=-1&&item.right<=result.viewport.width+1,name+' HUD outside viewport: '+id);}
 if(touch)assert.deepEqual(result.controls.filter(item=>item.width<43.9||item.height<43.9),[],name+' touch target under 44px');
 return result;
}
async function hierarchy(page,id,name,nested=false){
 const columns=await page.evaluate(([id,nested])=>{
  const root=document.querySelector('.project-root[data-project-id="'+id+'"]');
  const column=selector=>{const element=root.querySelector(selector);if(!element)throw Error('Missing hierarchy row: '+selector);const r=element.getBoundingClientRect();return {left:r.left,right:r.right,width:r.width};};
  const result={project:column('.project-name'),directory:column('.tree-entry[data-path="src"] .entry-name'),file:column('.tree-entry[data-path="shared.js"] .entry-name')};
  if(nested){result.childDirectory=column('.tree-entry[data-path="src/client"] .entry-name');result.childFile=column('.tree-entry[data-path="src/context.js"] .entry-name');result.grandchildFile=column('.tree-entry[data-path="src/client/target-focus.js"] .entry-name');}
  return result;
 },[id,nested]);
 layouts.push({name,...columns});
 assert(columns.directory.left>columns.project.left&&columns.file.left>columns.project.left,'Project children appear outdented: '+JSON.stringify(columns));
 assert(Math.abs(columns.directory.left-columns.file.left)<=1,'Sibling folders and files use different tree columns: '+JSON.stringify(columns));
 if(nested){
  assert(columns.childDirectory.left>columns.directory.left,'Nested folder does not advance the hierarchy: '+JSON.stringify(columns));
  assert(Math.abs(columns.childDirectory.left-columns.childFile.left)<=1,'Nested sibling file/folder columns differ: '+JSON.stringify(columns));
  assert(columns.grandchildFile.left>columns.childDirectory.left,'Grandchild file appears outdented: '+JSON.stringify(columns));
 }
}
async function pairPhone(){
 await menu(pc,'session');await pc.click('#pair-phone');await pc.click('#pair-local');
 const bundle=await pc.waitForFunction(()=>{const link=document.querySelector('#pair-urls a')?.href,pin=document.getElementById('pair-code').textContent.trim();return link&&/^\d{6}$/.test(pin)?{link,pin}:false;});
 const {link,pin}=await bundle.jsonValue();await phone.goto(link);
 await phone.waitForFunction(()=>document.getElementById('join-dialog').open&&!document.getElementById('join-form').hidden&&!document.getElementById('join-code').disabled&&!location.hash);
 await phone.locator('#join-code').fill(pin);await phone.click('#join-submit');
 await phone.waitForFunction(()=>document.getElementById('app').dataset.controller==='yes'&&!!window.__review.bootstrap?.projectId);
 await pc.click('[data-close="pair-dialog"]');
}

function frames(){if(!fs.existsSync(callsLog))return[];return fs.readFileSync(callsLog,'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));}
async function until(predicate){const limit=Date.now()+12000;while(!predicate()){if(Date.now()>limit)throw Error('Fixture did not reach expected state');await sleep(30);}}

function contextName(index){return index===0?'client':index===1?'server':path.basename(roots[index]);}
async function activeScope(page,id,index){
 assert.equal((await snapshot(page)).projectId,id,'Selected backend project is stale');
 assert(await page.locator('#projects-toggle').isVisible(),'Persistent selected-project control is hidden');
 const header=await page.locator('#projects-toggle').textContent();
 assert(/current project.*files.*ai.*terminal/i.test(await page.locator('#projects-toggle').getAttribute('aria-label')),'Persistent control does not identify its shared current-project scope');
 assert(header.includes(index<2?'app':path.basename(roots[index])),'Persistent control omits selected project');
 if(index<2&&await page.evaluate(()=>window.__review.projects.filter(p=>p.name==='app').length)>1)assert(header.includes(contextName(index)),'Same-name selected project is ambiguous');
 const label=await page.locator('#compose-context').getAttribute('title');
 if(label)assert(label.includes(index<2?'app':path.basename(roots[index])),'AI composer belongs to a different project');
 if(label&&index<2&&await page.evaluate(()=>window.__review.projects.filter(p=>p.name==='app').length)>1)assert(label.includes(contextName(index)),'AI composer does not disambiguate same-name roots');
 const terminal=await page.locator('#terminal-project-toggle').textContent();
 assert(terminal.includes(index<2?'app':path.basename(roots[index])),'Terminal project trigger belongs to a different project');
 if(index<2&&await page.evaluate(()=>window.__review.projects.filter(p=>p.name==='app').length)>1)assert(terminal.includes(contextName(index)),'Terminal project trigger does not disambiguate same-name roots');
 if(await page.locator('#app').getAttribute('data-view')==='terminal')assert((await page.locator('#terminal-host').getAttribute('title')).includes(roots[index]),'Host shell context is from a different project');
}
async function explicitTree(page,id){
 await projects(page);
 assert.equal(await page.locator('#file-tree .project-root').count(),1,'Files must contain only the selected project root');
 assert.deepEqual(await page.locator('#file-tree [data-project-id]').evaluateAll(elements=>[...new Set(elements.map(element=>element.dataset.projectId))]),[id],'Files contains an inactive project or entry');
 const disclosure=rootNode(page,id).locator('.project-root-heading > .project-expand');
 assert.equal(await disclosure.count(),1,'Root must have one coherent disclosure button');
 assert.equal(await disclosure.locator('.tree-arrow,svg,.project-name').count(),3,'Root name, chevron and folder icon must share the disclosure');
 assert.equal(await rootNode(page,id).locator('.project-select,.project-current-mark,[aria-current="page"]').count(),0,'Files retains a redundant root selection pill or Current badge');
 assert.equal(await rootNode(page,id).locator('.project-root-heading > button').count(),2,'Root has extra controls beyond disclosure and remove');
 assert(await page.locator('#projects-toggle').isVisible(),'Current scope is missing from the persistent project control');
 assert(/current project/i.test(await page.locator('#projects-toggle').getAttribute('aria-label')),'Persistent selector does not identify the current project');
}
async function heldTerminalDraft(page,value,selection=[2,7]){
 await page.locator('#terminal-command').evaluate((element,{value,selection})=>{const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;setter.call(element,value);element.setSelectionRange(selection[0],selection[1],'backward');},{value,selection});
}
async function assertHeldDraft(page,value,selection){
 assert.equal(await page.locator('#terminal-command').inputValue(),value,'Browser-held terminal text leaked or was lost');
 if(selection)assert.deepEqual(await page.locator('#terminal-command').evaluate(e=>[e.selectionStart,e.selectionEnd,e.selectionDirection]),[...selection,'backward'],'Terminal draft selection was lost');
}
async function startShell(page,root,label){
 if(!(await snapshot(page)).terminal.running){await page.locator('#terminal-restart').waitFor({state:'visible'});await page.click('#terminal-restart');}
 await page.waitForFunction(()=>!document.getElementById('terminal-command').disabled);
 await command(page,'terminal_input',{data:"pwd > "+label+"-cwd.txt; printf '%s\\n' \"$$\" > "+label+"-pid.txt\r"},true);
 await until(()=>{try{return /^\d+$/.test(fs.readFileSync(path.join(root,label+'-pid.txt'),'utf8').trim())&&fs.readFileSync(path.join(root,label+'-cwd.txt'),'utf8').trim()===root;}catch(error){if(error.code==='ENOENT')return false;throw error;}});
 assert.equal(fs.readFileSync(path.join(root,label+'-cwd.txt'),'utf8').trim(),root);
 return fs.readFileSync(path.join(root,label+'-pid.txt'),'utf8').trim();
}
async function noAutomaticTerminalText(page,start,markers){
 const inputs=await page.evaluate(start=>window.__review.sent.slice(start).filter(v=>v.type==='terminal_input').map(v=>v.data),start);
 assert(!inputs.some(text=>markers.some(marker=>text.includes(marker))),'Held terminal draft was sent automatically to a shell');
}

(async()=>{
 fs.mkdirSync(path.join(roots[2],'components','nested-app'),{recursive:true});
 const nestedRoot=path.join(roots[2],'components','nested-app');
 fs.writeFileSync(path.join(nestedRoot,'shared.js'),'// Nested project on the hosting PC\n');
 fs.writeFileSync(path.join(nestedRoot,'inactive-only-c.js'),'// Cached inactive project match must never leak into selected Files.\n');
 await startHost();
 browser=await playwright[engine].launch({...(engine==='chromium'?{executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'}:{}),headless:true});browserVersion=browser.version();
 pcContext=await browser.newContext({viewport:{width:1280,height:800}});phoneContext=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
 await capture(pcContext);await capture(phoneContext);pc=await pcContext.newPage();phone=await phoneContext.newPage();observe(pc);observe(phone);
 await pc.goto(privateUrl);await pc.waitForFunction(()=>document.getElementById('app').dataset.controller==='yes'&&!!window.__review.bootstrap?.projectId);
 const rootA=(await snapshot(pc)).projectId;let rootB,rootC;
 await check('Embedded release matches frozen source and starts with no terminal or AI job',async()=>{
  for(const [route,file]of [['/','index.html'],['/editor.js','editor.js'],['/app.js','app.js'],['/style.css','style.css']])assert.equal(await(await pc.request.get(new URL(route,privateUrl).href)).text(),fs.readFileSync(path.join(repo,'web',file),'utf8'));
  assert.equal((await snapshot(pc)).terminal.running,false);assert(!['starting','running'].includes((await snapshot(pc)).ai.status));
 });
 await check('Code has an explicit persistent current-project control before opening any file',async()=>{await activeScope(pc,rootA,0);await screenshot(pc,'desktop-current-no-file');});
 await check('A paired phone receives full access while selecting projects independently',async()=>{await pairPhone();await activeScope(phone,rootA,0);await openShared(phone);assert.equal(await phone.locator('#code-input').inputValue(),initialTexts[0]);assert.equal(await phone.locator('#code-input').getAttribute('readonly'),null);});
 await sleep(400);const initialSpawns=frames().filter(v=>v.event==='spawn').length;
 await check('Attaching same-name and container projects does not move the other device or start runtimes',async()=>{
  rootB=await add(pc,roots[1]);rootC=await add(pc,roots[2]);await phone.waitForFunction(()=>window.__review.projects.length===3);
  assert.equal((await snapshot(phone)).projectId,rootA);assert.equal(await phone.locator('#code-input').inputValue(),initialTexts[0]);
  assert.equal(frames().filter(v=>v.event==='spawn').length,initialSpawns);assert.equal((await snapshot(pc)).terminal.running,false);
 });
 await check('Files menu is reduced to Files and Session while keyboard file creation and open-buffer closing stay scoped',async()=>{
  await projects(phone);assert.equal(await phone.locator('#open-project,#refresh-files,#menu-open-tab,#files-menu .project-actions,#files-menu #new-file').count(),0,'Removed action row or Open tab remains in the Files menu');assert.deepEqual(await phone.locator('#files-menu .menu-tabs > button:not(.icon)').allTextContents(),['Files','Session']);await closeMenu(phone);
  const start=await phone.evaluate(()=>window.__review.sent.length);await phone.locator('#projects-toggle').focus();await phone.keyboard.press('Enter');await phone.locator('#project-menu').waitFor({state:'visible'});assert(await phone.locator('#project-menu #quick-add-project').isVisible());await phone.locator('#project-menu #new-file').focus();await phone.keyboard.press('Space');await phone.locator('#new-dialog').waitFor({state:'visible'});assert((await phone.locator('#new-project-label').textContent()).includes('client/app'),'New file dialog omits its current-project scope');await phone.fill('#new-path','menu-created.txt');await phone.locator('#new-path').press('Enter');await phone.locator('#new-dialog').waitFor({state:'hidden'});await until(()=>fs.existsSync(path.join(roots[0],'menu-created.txt')));assert.equal(fs.readFileSync(path.join(roots[0],'menu-created.txt'),'utf8'),'');assert(!fs.existsSync(path.join(roots[1],'menu-created.txt'))&&!fs.existsSync(path.join(roots[2],'menu-created.txt')),'New file was created in an inactive project');await activeScope(phone,rootA,0);assert.equal((await snapshot(pc)).projectId,rootC);
  await openShared(phone);await projects(phone);assert(await phone.locator('#open-files-section').isVisible(),'Open buffers are no longer available within Files');await phone.locator('#open-files button[title="menu-created.txt"]').click();await phone.waitForFunction(()=>document.getElementById('code-input').value==='');assert.equal(await phone.locator('#code-input').inputValue(),'');await projects(phone);await phone.locator('#open-files button[aria-label="Close menu-created.txt"]').click();await phone.waitForFunction(()=>!document.querySelector('#open-files button[title="menu-created.txt"]'));assert(fs.existsSync(path.join(roots[0],'menu-created.txt')),'Closing an open buffer deleted the disk file');await openShared(phone);const sent=await phone.evaluate(start=>window.__review.sent.slice(start),start);assert.equal(sent.filter(v=>v.type==='create_file'&&v.projectId===rootA&&v.path==='menu-created.txt').length,1);assert(!sent.some(v=>['select_project','terminal_start','ai_prompt'].includes(v.type)),'Menu actions changed project or started work');
 });
 await check('One neutral root control toggles by name, chevron and keyboard without changing scope; remove can be canceled',async()=>{
  await explicitTree(phone,rootA);await expandRoot(phone,rootA);const start=await phone.evaluate(()=>window.__review.sent.length);
  for(const [method,expanded] of [['name',false],['chevron',true],['Enter',false],['Space',true]]){
   const button=rootNode(phone,rootA).locator('.project-expand');
   if(method==='name')await button.locator('.project-name').click();else if(method==='chevron')await button.locator('.tree-arrow').click();else{await button.focus();await phone.keyboard.press(method);}
   await phone.waitForFunction(({id,expanded})=>document.querySelector('.project-root[data-project-id="'+id+'"] .project-expand').getAttribute('aria-expanded')===String(expanded),{id:rootA,expanded});
   if(expanded)await rootNode(phone,rootA).locator('.tree-entry[data-path="shared.js"]').waitFor({state:'visible'});else assert.equal(await rootNode(phone,rootA).locator('.tree-entry').count(),0,'Collapsed root still exposes files');
   await activeScope(phone,rootA,0);assert.equal((await snapshot(pc)).projectId,rootC);assert.equal(await phone.locator('#app').getAttribute('data-view'),'code');
  }
  const dialogPromise=phone.waitForEvent('dialog');const click= rootNode(phone,rootA).locator('.project-remove').click();const dialog=await dialogPromise;assert.equal(dialog.type(),'confirm');assert(dialog.message().includes('All paired devices lose access'));await dialog.dismiss();await click;
  assert.equal((await snapshot(phone)).projects.length,3);await explicitTree(phone,rootA);const sent=await phone.evaluate(start=>window.__review.sent.slice(start),start);assert(!sent.some(v=>['select_project','add_project','remove_project','open_file','terminal_start','ai_prompt'].includes(v.type)),'Root disclosure or canceled remove changes the working project');await layout(phone,'neutral-root-disclosure-390');await screenshot(phone,'phone-neutral-root-row');
 });
 await check('Files and filtering expose only the selected project despite cached inactive folders',async()=>{
  await explicitTree(phone,rootA);await expandRoot(phone,rootA);await quickSelect(phone,rootC,'code');await explicitTree(phone,rootC);await expandRoot(phone,rootC);
  const start=await phone.evaluate(()=>window.__review.sent.length);await rootNode(phone,rootC).locator('.tree-entry[data-path="components"][data-kind="directory"]').click();
  await rootNode(phone,rootC).locator('.tree-entry[data-path="components/nested-app"]').waitFor({state:'visible'});
  await rootNode(phone,rootC).locator('.tree-entry[data-path="components/nested-app"]').click();await rootNode(phone,rootC).locator('.tree-entry[data-path="components/nested-app/inactive-only-c.js"]').waitFor({state:'visible'});assert.equal(await phone.locator('.folder-options,#folder-menu,#use-folder-project').count(),0,'Folder promotion remains despite roots-only selection preference');assert.equal((await snapshot(phone)).projects.length,3,'Browsing a folder attaches it as a project');await activeScope(phone,rootC,2);await explicitTree(phone,rootC);const sent=await phone.evaluate(start=>window.__review.sent.slice(start),start);
  assert(!sent.some(v=>['select_project','add_project','open_file','terminal_start','ai_prompt'].includes(v.type)),'Folder expansion changed workspace or executed work');
  await quickSelect(phone,rootA,'code');await explicitTree(phone,rootA);await expandRoot(phone,rootA);await rootNode(phone,rootA).locator('.tree-entry[data-path="src"]').click();await rootNode(phone,rootA).locator('.tree-entry[data-path="src/client"]').waitFor({state:'visible'});await rootNode(phone,rootA).locator('.tree-entry[data-path="src/client"]').click();await rootNode(phone,rootA).locator('.tree-entry[data-path="src/client/target-focus.js"]').waitFor({state:'visible'});await hierarchy(phone,rootA,'phone-current-root-hierarchy',true);
  await phone.fill('#file-filter','inactive-only-c');assert.equal(await phone.locator('#file-tree .tree-entry').count(),0,'Current-project filter leaks a cached inactive root match');assert.equal(await phone.locator('#file-tree .project-root').count(),0,'Inactive matching root remains in filtered Files');
  await phone.fill('#file-filter','target-focus');await rootNode(phone,rootA).locator('.filtered-entry[data-path="src/client/target-focus.js"]').waitFor({state:'visible'});assert.equal(await phone.locator('#file-tree .project-root').count(),1);assert.deepEqual(await phone.locator('#file-tree .tree-entry').evaluateAll(elements=>[...new Set(elements.map(element=>element.dataset.projectId))]),[rootA]);await phone.fill('#file-filter','');await explicitTree(phone,rootA);
  assert.equal((await snapshot(pc)).projectId,rootC);await layout(phone,'phone-current-project-files');await screenshot(phone,'phone-current-project-files');await closeMenu(phone);
 });
 await check('Same-name project picker identifies exactly one textual current project',async()=>{
  await quickMenu(phone);const current=phone.locator('.quick-project-select[aria-current="page"]');assert(/current|active|selected/i.test(await current.textContent()));
  assert((await phone.locator('#project-menu').textContent()).includes('client')&&(await phone.locator('#project-menu').textContent()).includes('server'));
  await screenshot(phone,'phone-same-name-current-picker');await quickSelect(phone,rootB,'code');await activeScope(phone,rootB,1);await quickSelect(phone,rootA,'code');
 });
 const dirtyA='// A dirty source belongs only to the client project.\n';
 await check('Changing project swaps code buffers together and retains unsaved source without a disk write',async()=>{
  await phone.fill('#code-input',dirtyA);await phone.waitForFunction(text=>window.__review.events.some(v=>v.type==='file_state'&&v.file?.content===text),dirtyA);
  await quickSelect(phone,rootB,'code');await openShared(phone);assert.equal(await phone.locator('#code-input').inputValue(),initialTexts[1]);
  await quickSelect(phone,rootA,'code');assert.equal(await phone.locator('#code-input').inputValue(),dirtyA);assert(await phone.locator('#save-button').isVisible());assert.equal(fs.readFileSync(path.join(roots[0],'shared.js'),'utf8'),initialTexts[0]);await screenshot(phone,'phone-dirty-current-project');
 });
 await check('Project switching from AI keeps the surface and swaps independent prompt drafts',async()=>{
  await phone.click('#mobile-ai');await phone.fill('#prompt','Unsent client question');await quickSelect(phone,rootB,'ai');await activeScope(phone,rootB,1);assert.equal(await phone.locator('#prompt').inputValue(),'');
  await phone.fill('#prompt','Unsent server question');await quickSelect(phone,rootA,'ai');assert.equal(await phone.locator('#prompt').inputValue(),'Unsent client question');
  await quickSelect(phone,rootB,'ai');assert.equal(await phone.locator('#prompt').inputValue(),'Unsent server question');await screenshot(phone,'phone-ai-current-project');
 });
 await check('Running AI and historical conversation remain bound to their project and real provider cwd',async()=>{
  await quickSelect(pc,rootB,'code');await openShared(pc);await actions.ai(pc);await pc.fill('#prompt','HOLD server conversation');await pc.click('#ai-send');
  await pc.waitForFunction(()=>window.__review.events.some(v=>v.ai?.status==='running'));
  await quickSelect(pc,rootC,'ai');await pc.fill('#prompt','Container conversation');await pc.click('#ai-send');await pc.waitForFunction(root=>document.getElementById('messages').textContent.includes('Fixture AI reply from '+root),roots[2]);
  await pc.fill('#prompt','Container follow-up draft');await quickSelect(pc,rootB,'ai');assert((await pc.locator('#messages').innerText()).includes('HOLD server conversation'));assert(!(await pc.locator('#messages').innerText()).includes(roots[2]));
  fs.writeFileSync(path.join(fixture,'ai-gate'),'finish');await pc.waitForFunction(root=>document.getElementById('messages').textContent.includes('Fixture AI reply from '+root),roots[1]);
  await quickSelect(pc,rootC,'ai');assert.equal(await pc.locator('#prompt').inputValue(),'Container follow-up draft');assert(!(await pc.locator('#messages').innerText()).includes(roots[1]));
  const turns=frames().filter(v=>v.event==='frame'&&v.frame.method==='turn/start');assert(turns.some(v=>v.cwd===roots[1]));assert(turns.some(v=>v.cwd===roots[2]));await screenshot(pc,'desktop-ai-project-scope');
 });
 let shellA,shellB;
 await check('Two explicit host terminals keep their original cwd and partial PTY input during switching',async()=>{
  await quickSelect(phone,rootA,'ai');await phone.click('#mobile-terminal');await phone.waitForFunction(()=>!document.getElementById('terminal-command').disabled);shellA=await startShell(phone,roots[0],'a');
  await phone.fill('#terminal-command',"printf 'A_ONLY\\n' > partial-a-proof.txt");
  await quickSelect(phone,rootB,'terminal');assert.equal((await snapshot(phone)).terminal.running,false,'Switching starts a shell automatically');shellB=await startShell(phone,roots[1],'b');
  await phone.fill('#terminal-command',"printf 'B_ONLY\\n' > partial-b-proof.txt");
  assert(!fs.existsSync(path.join(roots[0],'partial-a-proof.txt'))&&!fs.existsSync(path.join(roots[1],'partial-b-proof.txt')),'Partial commands executed before Enter');
  await quickSelect(phone,rootA,'terminal');await phone.click('#terminal-run');await until(()=>fs.existsSync(path.join(roots[0],'partial-a-proof.txt')));assert.equal(fs.readFileSync(path.join(roots[0],'partial-a-proof.txt'),'utf8'),'A_ONLY\n');assert(!fs.existsSync(path.join(roots[1],'partial-a-proof.txt')));
  await quickSelect(phone,rootB,'terminal');await phone.click('#terminal-run');await until(()=>fs.existsSync(path.join(roots[1],'partial-b-proof.txt')));assert.equal(fs.readFileSync(path.join(roots[1],'partial-b-proof.txt'),'utf8'),'B_ONLY\n');assert(!fs.existsSync(path.join(roots[0],'partial-b-proof.txt')));
  assert.equal(await startShell(phone,roots[1],'b-after'),shellB);await quickSelect(phone,rootA,'terminal');assert.equal(await startShell(phone,roots[0],'a-after'),shellA);await activeScope(phone,rootA,0);await screenshot(phone,'phone-terminal-current-project');
 });
 await check('Browser-held unsent terminal form text and selection restore separately from PTY input',async()=>{
  const start=await phone.evaluate(()=>window.__review.sent.length);await heldTerminalDraft(phone,'A_BROWSER_HELD_DRAFT',[2,7]);await quickSelect(phone,rootB,'terminal');await assertHeldDraft(phone,'');
  await heldTerminalDraft(phone,'B_BROWSER_HELD_DRAFT',[3,8]);await quickSelect(phone,rootA,'terminal');await assertHeldDraft(phone,'A_BROWSER_HELD_DRAFT',[2,7]);
  await quickSelect(phone,rootB,'terminal');await assertHeldDraft(phone,'B_BROWSER_HELD_DRAFT',[3,8]);await noAutomaticTerminalText(phone,start,['A_BROWSER_HELD_DRAFT','B_BROWSER_HELD_DRAFT']);await screenshot(phone,'phone-held-terminal-draft');
 });
 let compositionSendStart;
 await check('A canceled old-project IME cannot block ordinary typing in the new project',async()=>{
  await heldTerminalDraft(phone,'',[0,0]);await quickSelect(phone,rootA,'terminal');await heldTerminalDraft(phone,'A_IME_PENDING',[0,5]);
  await phone.locator('#terminal-command').evaluate(e=>{e.dispatchEvent(new CompositionEvent('compositionstart',{data:'A_IME_PENDING',bubbles:true}));e.dispatchEvent(new InputEvent('input',{data:'A_IME_PENDING',isComposing:true,inputType:'insertCompositionText',bubbles:true}));});
  compositionSendStart=await phone.evaluate(()=>window.__review.sent.length);await quickSelect(phone,rootB,'terminal');await phone.locator('#terminal-command').focus();await phone.keyboard.insertText('B_TYPING_AFTER_SWITCH');
  await phone.waitForFunction(({start,id})=>window.__review.sent.slice(start).some(v=>v.type==='terminal_input'&&v.projectId===id&&v.data.includes('B_TYPING_AFTER_SWITCH')),{start:compositionSendStart,id:rootB});
  await command(phone,'terminal_input',{data:'\x03'},true);
 });
 await check('A delayed old-project composition event cannot execute or clear the new project draft',async()=>{
  await heldTerminalDraft(phone,'B_DRAFT_AFTER_SWITCH',[0,6]);
  await phone.locator('#terminal-command').evaluate(e=>e.dispatchEvent(new CompositionEvent('compositionend',{data:'A_IME_PENDING',bubbles:true})));await sleep(80);
  await assertHeldDraft(phone,'B_DRAFT_AFTER_SWITCH',[0,6]);await noAutomaticTerminalText(phone,compositionSendStart,['A_IME_PENDING','B_DRAFT_AFTER_SWITCH']);await heldTerminalDraft(phone,'',[0,0]);
 });
 await check('Picker selection changes shared scope before Files opens only that project',async()=>{
  await quickSelect(phone,rootA,'terminal');await explicitTree(phone,rootA);
  await projects(phone);await expandRoot(phone,rootA);await rootNode(phone,rootA).locator('.tree-entry[data-path="shared.js"]').click();await phone.waitForFunction(id=>window.__review.projectId===id,rootA);
  assert.equal(await phone.locator('#app').getAttribute('data-view'),'code');assert.equal(await phone.locator('#code-input').inputValue(),dirtyA);await activeScope(phone,rootA,0);assert.equal((await snapshot(phone)).terminal.running,true);assert((await phone.locator('#terminal-project-toggle').textContent()).includes('client'));assert((await phone.locator('#compose-context').getAttribute('title')).includes('client'));assert.equal((await snapshot(pc)).projectId,rootC);
 });
 await check('The active project and switcher remain usable at 390 px, 320 px and short keyboard viewports',async()=>{
  for(const size of [{width:390,height:844},{width:320,height:600},{width:320,height:300}]){
   await phone.setViewportSize(size);await phone.click('#mobile-ai');await quickMenu(phone);await layout(phone,'active-picker-'+size.width+'x'+size.height);
   const target=phone.locator('.quick-project-select[data-project-id="'+rootB+'"]');await target.scrollIntoViewIfNeeded();const hit=await target.evaluate(e=>{const r=e.getBoundingClientRect();return {top:r.top,bottom:r.bottom,height:r.height,width:r.width,hit:e.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2))};});layouts.push({name:'current-picker-target-'+size.width+'x'+size.height,...hit});assert(hit.height>=44&&hit.width>=44&&hit.top>=0&&hit.bottom<=size.height&&hit.hit);await screenshot(phone,'phone-picker-'+size.width+'x'+size.height);
   await target.tap();await phone.waitForFunction(id=>window.__review.projectId===id,rootB);await activeScope(phone,rootB,1);assert.equal(await phone.locator('#app').getAttribute('data-view'),'ai');await quickSelect(phone,rootA,'ai');
  }
  await projects(phone);await phone.fill('#file-filter','target-focus');await phone.locator('#file-filter').focus();const currentResult=rootNode(phone,rootA).locator('.filtered-entry[data-path="src/client/target-focus.js"]');await currentResult.waitFor({state:'visible'});const filteredHit=await currentResult.evaluate(e=>{const r=e.getBoundingClientRect(),menu=document.getElementById('files-menu').getBoundingClientRect();return {top:r.top,bottom:r.bottom,height:r.height,width:r.width,menuBottom:menu.bottom,hit:e.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2))};});layouts.push({name:'current-only-filter-320x300',...filteredHit});assert(filteredHit.height>=44&&filteredHit.top>=0&&filteredHit.bottom<=filteredHit.menuBottom&&filteredHit.hit,'Current nested filter result is not touchable in keyboard viewport');await screenshot(phone,'phone-current-filter-320x300');await currentResult.tap();await phone.waitForFunction(text=>document.getElementById('code-input').value===text,filteredText);await activeScope(phone,rootA,0);assert.equal((await snapshot(pc)).projectId,rootC);await projects(phone);await phone.fill('#file-filter','');await closeMenu(phone);
  await phone.setViewportSize({width:390,height:844});await phone.click('#mobile-ai');
 });
 await check('Keyboard switching names the current project and Escape returns focus without navigation',async()=>{
  await pc.locator('#projects-toggle').focus();await pc.keyboard.press('ArrowDown');await pc.locator('#project-menu').waitFor({state:'visible'});assert(await pc.locator('#project-menu .quick-project-select').first().evaluate(e=>document.activeElement===e));await pc.keyboard.press('Escape');assert(await pc.locator('#projects-toggle').evaluate(e=>document.activeElement===e));assert.equal((await snapshot(pc)).projectId,rootC);
  await pc.locator('#projects-toggle').focus();await pc.keyboard.press('Enter');await pc.locator('.quick-project-select[data-project-id="'+rootB+'"]').focus();await pc.keyboard.press('Enter');await pc.waitForFunction(id=>window.__review.projectId===id,rootB);await activeScope(pc,rootB,1);assert.equal(await pc.locator('#app').getAttribute('data-view'),'ai');await quickSelect(pc,rootC,'ai');
 });
 await check('Reconnect preserves selected project and local terminal draft without moving the other device',async()=>{
  await quickSelect(phone,rootB,'ai');await phone.click('#mobile-terminal');await heldTerminalDraft(phone,'B_RECONNECT_HELD',[2,6]);phone.__expectedDisconnect=true;
  await phone.evaluate(()=>window.__review.sockets.at(-1).close());await phone.waitForFunction(()=>document.getElementById('app').dataset.connected==='no');await phone.waitForFunction(()=>document.getElementById('app').dataset.connected==='yes');
  await assertHeldDraft(phone,'B_RECONNECT_HELD',[2,6]);assert.equal((await snapshot(phone)).projectId,rootB);assert.equal((await snapshot(pc)).projectId,rootC);await activeScope(phone,rootB,1);phone.__expectedDisconnect=false;await heldTerminalDraft(phone,'',[0,0]);
 });
 await check('AI and terminal surfaces expose the shared project switcher and Escape restores their invoker',async()=>{
  await phone.click('#mobile-ai');const aiProjectInvoker=await phone.locator('#ai-project-toggle').isVisible()?'#ai-project-toggle':'#projects-toggle';await phone.locator(aiProjectInvoker).focus();await phone.keyboard.press('Enter');await phone.locator('#project-menu').waitFor({state:'visible'});const scope=phone.locator('#project-picker-scope');assert.equal(await phone.locator('#project-menu').getAttribute('aria-describedby'),'project-picker-scope','Project menu omits its accessible shared scope');assert.equal(await phone.locator('#projects-toggle').getAttribute('aria-describedby'),'project-picker-scope','Project trigger omits its accessible shared scope');assert(/\b(files|code)\b.*\bai\b.*\bterminal\b/i.test(await scope.textContent()),'Switcher omits its shared files, AI and terminal scope');await phone.keyboard.press('Escape');assert(await phone.locator(aiProjectInvoker).evaluate(e=>document.activeElement===e),'Escape does not return to the visible project trigger');
  await phone.click('#mobile-terminal');const terminalProjectInvoker=await phone.locator('#terminal-project-toggle').isVisible()?'#terminal-project-toggle':'#projects-toggle';await phone.locator(terminalProjectInvoker).focus();await phone.keyboard.press('Enter');await phone.locator('#project-menu').waitFor({state:'visible'});await phone.keyboard.press('Escape');assert(await phone.locator(terminalProjectInvoker).evaluate(e=>document.activeElement===e),'Escape does not return to the visible Terminal project trigger');assert.equal((await snapshot(phone)).projectId,rootB);
 });
 await check('Internet-like selection latency fences old terminal work and restores current history and PTY dimensions',async()=>{
  // Settle earlier history work, then place one real history refresh deadline
  // inside the delayed project-selection response, rather than relying on luck.
  await sleep(750);await command(phone,'terminal_input',{data:"printf 'HISTORY_TIMER_START\\n'\r"},true);await phone.waitForFunction(()=>document.getElementById('terminal-screen').textContent.includes('HISTORY_TIMER_START'));await sleep(250);
  await quickMenu(phone);const start=await phone.evaluate(()=>{window.__review.delayNextBootstrap=300;return {sent:window.__review.sent.length,events:window.__review.events.length,delayed:window.__review.delayedBootstraps||0};});
  await phone.setViewportSize({width:350,height:844});await phone.locator('.quick-project-select[data-project-id="'+rootA+'"]').tap();await phone.waitForFunction(id=>window.__review.projectId===id,rootA);await phone.locator('#project-menu').waitFor({state:'hidden'});
  await phone.waitForFunction(({start,id})=>window.__review.sent.slice(start).some(v=>v.type==='terminal_resize'&&v.projectId===id),{start:start.sent,id:rootA});
  await phone.waitForFunction(({start,id})=>{const request=window.__review.sent.slice(start).find(v=>v.type==='terminal_history'&&v.projectId===id&&!v.requestId.startsWith('critic-'));return request&&window.__review.events.some(v=>v.requestId===request.requestId&&v.type==='terminal_history');},{start:start.sent,id:rootA});
  const wire=await phone.evaluate(start=>({delayed:window.__review.delayedBootstraps||0,sent:window.__review.sent.slice(start.sent),errors:window.__review.events.slice(start.events).filter(v=>v.type==='error').map(v=>({...v,originatingCommand:window.__review.sent.find(sent=>sent.requestId===v.requestId)}))}),start);
  assert.equal(wire.delayed,start.delayed+1,'Fixture did not delay an actual bootstrap');const selectionIndex=wire.sent.findIndex(v=>v.type==='select_project');assert(selectionIndex>=0);assert(!wire.sent.slice(selectionIndex+1).some(v=>v.type==='terminal_resize'&&v.projectId===rootB),'A stale resize was sent after changing project');const diagnostics={name:'delayed-selection-wire',sent:wire.sent.map(v=>({type:v.type,requestId:v.requestId,project:v.projectId===rootA?'A':v.projectId===rootB?'B':'other',generation:v.generation})),errors:wire.errors.map(v=>({code:v.code,requestId:v.requestId,commandType:v.originatingCommand?.type||'unknown',actor:v.requestId?.startsWith('critic-')?'harness':'app',project:v.originatingCommand?.projectId===rootA?'A':v.originatingCommand?.projectId===rootB?'B':'other',generation:v.originatingCommand?.generation}))};layouts.push(diagnostics);assert(!wire.errors.some(v=>v.code==='stale_project'),'Host rejected a stale project request: '+JSON.stringify(diagnostics.errors));
  await command(phone,'terminal_input',{data:'stty size > resized-a-dimensions.txt\r'},true);await until(()=>fs.existsSync(path.join(roots[0],'resized-a-dimensions.txt'))&&/^\d+\s+\d+$/.test(fs.readFileSync(path.join(roots[0],'resized-a-dimensions.txt'),'utf8').trim()));const dimensions=fs.readFileSync(path.join(roots[0],'resized-a-dimensions.txt'),'utf8').trim().split(/\s+/).map(Number),terminal=(await snapshot(phone)).terminal;assert.deepEqual(dimensions,[terminal.rows,terminal.cols],'Host PTY dimensions differ from current project snapshot');layouts.push({name:'actual-delayed-selection-resize',delayMilliseconds:300,freshOutputBeforeSelectionMilliseconds:250,rows:terminal.rows,cols:terminal.cols,oldProjectResizeAfterSelection:false,currentProjectHistoryReceived:true});
  await screenshot(phone,'phone-delayed-switch-terminal');await phone.setViewportSize({width:390,height:844});await quickSelect(phone,rootB,'terminal');
 });
 await check('No unexpected browser errors or eagerly created provider runtimes occur',async()=>{assert.deepEqual(errors,[]);assert(frames().filter(v=>v.event==='spawn').length<=initialSpawns+4,'Selection creates unbounded provider processes');});
 console.log('ACTIVE PROJECT FUNCTIONAL ACCEPT '+engine+' '+checks.length+' checks');
})().catch(async error=>{
 findings.push({stage,message:error.message});console.error('ACTIVE PROJECT REJECT '+stage+': '+error.message);try{if(phone&&!phone.isClosed())await screenshot(phone,'failure-phone');if(pc&&!pc.isClosed())await screenshot(pc,'failure-desktop');}catch{}process.exitCode=1;
}).finally(async()=>{
 const report={status:findings.length?'reject':'functional-accept-pending-visual-review',date:new Date().toISOString(),binarySha256,browserEngine:engine,browserVersion,realHost:true,sourceOverrides:false,disposableWorkspaces:true,fakeProviders:true,checks,screenshots,layouts,findings,unexpectedBrowserErrors:errors,expectedNetworkEvents:expectedNetwork,references:'tests/active-project-review-references/provenance.json',limits:['No real inference, credentials, user projects, tunnels or live Nimlo hosts were accessed.','Physical devices and real mobile IME keyboards remain untested; delayed composition events are injected to exercise project fencing.','Recognizable independent screenshot comparison; no true blind study claimed.']};
 fs.writeFileSync(path.join(artifacts,'review.json'),JSON.stringify(report,null,2)+'\n');if(browser)await browser.close().catch(()=>{});await stopHost();fs.rmSync(fixture,{recursive:true,force:true});
});
