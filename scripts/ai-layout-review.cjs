#!/usr/bin/env node
'use strict';
const patchFixture=require('./patch-fixture.cjs');
const actions=require('./ui-actions.cjs');

// Independent task review of the real embedded release. Every workspace,
// provider and shell below is disposable; no production host or inference.
// NIMLO_BASELINE=1 captures the frozen prior release in matching task states.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const assert=require('node:assert/strict'),crypto=require('node:crypto');
const {spawn}=require('node:child_process');
const playwright=require(process.env.PLAYWRIGHT_PATH||'playwright');
const engine=process.env.NIMLO_BROWSER||'chromium',baseline=process.env.NIMLO_BASELINE==='1';
assert(['chromium','webkit'].includes(engine),'Choose chromium or webkit');
const repo=path.resolve(__dirname,'..'),binary=path.resolve(repo,process.env.NIMLO_BINARY||'target/release/nimlo-editor');
const binarySha256=crypto.createHash('sha256').update(fs.readFileSync(binary)).digest('hex');
if(process.env.NIMLO_EXPECT_SHA)assert.equal(binarySha256,process.env.NIMLO_EXPECT_SHA,'Frozen build differs');
const artifacts=path.join(repo,'tests','ai-layout-review-'+(baseline?'baseline-':'')+engine);
const fixture=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'nimlo-ai-layout-critic-')));
const bin=path.join(fixture,'bin'),stateDir=path.join(fixture,'state');
const roots=[path.join(fixture,'client','app'),path.join(fixture,'server','app')];
const filename='session-controller.js';
const code=Array.from({length:160},(_,i)=>i===0?'// Disposable shared-session editing fixture.':i===1?'export const project = "client";':i%17===0?'// Long editable line '+i+' '+'.'.repeat(145):'export const session_'+String(i).padStart(3,'0')+' = { generation: '+i+', owner: "fixture", retained: true };').join('\n')+'\n';
const reply='Keep the active file and the conversation together.\n\nA compact layout lets the same source stay editable while reading a reply.\n\n'+Array.from({length:18},(_,i)=>'Review item '+(i+1)+': preserve selection, source scroll and the unsent question when changing views.').join('\n\n');
const question='Review the session state and explain what to preserve when changing views.';
const draft='Could we keep the file open while reading your reply?';
const checks=[],screenshots=[],layouts=[],errors=[],findings=[];
let host,browser,pc,phone,privateUrl,browserVersion,stage='startup';
fs.mkdirSync(bin,{recursive:true});fs.mkdirSync(artifacts,{recursive:true});
for(let i=0;i<roots.length;i++){fs.mkdirSync(roots[i],{recursive:true});fs.writeFileSync(path.join(roots[i],filename),i?code.replace('"client"','"server"'):code);}
const callsLog=path.join(fixture,'provider-calls.jsonl');
fs.writeFileSync(path.join(bin,'codex'),String.raw`#!/usr/bin/env node
const fs=require('node:fs'),readline=require('node:readline');
fs.appendFileSync(process.env.NIMLO_REVIEW_LOG,JSON.stringify({event:'spawn',args:process.argv.slice(2)})+'\n');
if(process.argv[2]==='login'){console.log('Logged in using ChatGPT');process.exit(0);}
const send=value=>console.log(JSON.stringify(value));
readline.createInterface({input:process.stdin}).on('line',line=>{
 const frame=JSON.parse(line);fs.appendFileSync(process.env.NIMLO_REVIEW_LOG,JSON.stringify({event:'frame',method:frame.method})+'\n');
 if(frame.method==='initialize')send({id:frame.id,result:{userAgent:'independent-layout-review-fixture'}});
 else if(frame.method==='thread/start'||frame.method==='thread/resume')send({id:frame.id,result:{thread:{id:'layout-review-thread'}}});
 else if(frame.method==='turn/start'){
  send({id:frame.id,result:{turn:{id:'layout-review-turn'}}});
  const finish=()=>{send({method:'item/completed',params:{item:{id:'reply',type:'agentMessage',text:JSON.parse(process.env.NIMLO_REVIEW_REPLY)}}});send({method:'turn/completed',params:{turn:{id:'layout-review-turn',status:'completed',error:null}}});};
  if(JSON.stringify(frame.params).includes('HOLD')){const timer=setInterval(()=>{if(fs.existsSync(process.env.NIMLO_REVIEW_GATE)){clearInterval(timer);finish();}},25);}else finish();
 }
});
`,{mode:0o700});
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function frames(){return fs.existsSync(callsLog)?fs.readFileSync(callsLog,'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)):[];}
function turns(){return frames().filter(v=>v.event==='frame'&&v.method==='turn/start').length;}
async function startHost(){
 host=spawn(binary,['--workspace',roots[0],'--state-dir',stateDir,'--listen','0.0.0.0:0'],{env:{...process.env,PATH:bin+path.delimiter+process.env.PATH,NIMLO_REVIEW_LOG:callsLog,NIMLO_REVIEW_REPLY:JSON.stringify(reply),NIMLO_REVIEW_GATE:path.join(fixture,'ai-gate')},stdio:['ignore','pipe','pipe']});
 privateUrl=await new Promise((resolve,reject)=>{
  let output='',stderr='';const timer=setTimeout(()=>reject(Error('Fixture host startup timeout: '+stderr)),20000);
  host.stdout.on('data',chunk=>{output+=chunk;const match=output.match(/http:\/\/[^\s]+\/#token=[a-f0-9]{64}/);if(match){clearTimeout(timer);resolve(match[0]);}});
  host.stderr.on('data',chunk=>{stderr+=chunk;});host.on('error',reject);host.on('exit',code=>{clearTimeout(timer);reject(Error('Fixture host exited '+code+': '+stderr));});
 });
}
async function stopHost(){if(!host||host.exitCode!==null)return;const child=host;host=null;await new Promise(resolve=>{const timer=setTimeout(()=>child.kill('SIGKILL'),8000);child.once('exit',()=>{clearTimeout(timer);resolve();});child.kill('SIGTERM');});}
async function installCapture(context){
 await patchFixture.install(context);
 await context.addInitScript(()=>{
  const Original=window.WebSocket;
  window.__layoutReview={sent:[],events:[],sockets:[],projectId:null,generation:0,projects:[]};
  window.WebSocket=class extends Original{
   constructor(...args){super(...args);window.__layoutReview.sockets.push(this);this.addEventListener('message',message=>{const value=window.__patchFixture.observe(JSON.parse(message.data)),review=window.__layoutReview;review.events.push(value);if(value.type==='bootstrap'){review.projectId=value.projectId;review.generation=value.generation;review.bootstrap=value;}if(value.projects)review.projects=value.projects;if(value.generation!==undefined)review.generation=value.generation;});}
   send(raw){window.__layoutReview.sent.push(JSON.parse(raw));super.send(raw);}
  };
  let next=0;
  window.__layoutCommand=(type,fields={},mutate=false)=>new Promise((resolve,reject)=>{
   const review=window.__layoutReview,socket=review.sockets.at(-1),requestId='layout-critic-'+(++next);
   const timer=setTimeout(()=>{socket.removeEventListener('message',listener);reject(Error('Fixture command timeout: '+type));},10000);
   const listener=message=>{const value=JSON.parse(message.data);if(value.requestId===requestId){clearTimeout(timer);socket.removeEventListener('message',listener);resolve(value);}};
   socket.addEventListener('message',listener);socket.send(JSON.stringify({type,requestId,projectId:review.projectId,...(mutate?{generation:review.generation}:{}),...fields}));
  });
 });
}
function observe(page){page.setDefaultTimeout(12000);page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error'&&!m.text().includes('401'))errors.push(m.text());});}
async function check(name,work){stage=name;await work();checks.push(name);console.log('PASS '+name);}
async function screenshot(page,name){await page.bringToFront();await page.waitForTimeout(120);const file=name+'.png';await page.screenshot({path:path.join(artifacts,file)});screenshots.push(file);}
const command=(page,type,fields={},mutate=false)=>page.evaluate(([t,f,m])=>window.__layoutCommand(t,f,m),[type,fields,mutate]);
const snapshot=page=>page.evaluate(()=>{const review=window.__layoutReview,current=review.projectId,result={...review.bootstrap};for(const v of review.events){if(v.type==='bootstrap'&&v.projectId===current)Object.assign(result,v);else if(v.projectId===current){if(v.terminal)result.terminal=v.terminal;if(v.ai)result.ai=v.ai;}}result.projects=review.projects;return result;});
async function menu(page,section='files'){return actions.menu(page,section);}
async function closeMenu(page){return actions.closeMenu(page);}
async function openFile(page){await menu(page);const root=page.locator('#file-tree .project-root');const expand=root.locator('.project-expand');if(await expand.getAttribute('aria-expanded')!=='true')await expand.click();await root.locator('.tree-entry[data-path="'+filename+'"]').click();await page.waitForFunction(()=>!document.getElementById('code-input').readOnly&&document.getElementById('code-input').value.includes('session_159'));}
async function ai(page){return actions.ai(page);}
async function activate(page,selector){if(page===phone)await page.locator(selector).tap();else await page.locator(selector).click();}
async function mode(page,value){return actions.mode(page,value);}
async function view(page,value){if(await page.locator('#mobile-'+value).isVisible())await activate(page,'#mobile-'+value);else if(value==='ai')await actions.ai(page);else if(value==='code')await page.locator('#code-input').focus();await page.waitForFunction(value=>document.getElementById('app').dataset.view===value,value);}
async function pairPhone(){
 await menu(pc,'session');await pc.click('#pair-phone');await pc.click('#pair-local');
 const bundle=await pc.waitForFunction(()=>{const link=document.querySelector('#pair-urls a')?.href,pin=document.getElementById('pair-code').textContent.trim();return link&&/^\d{6}$/.test(pin)?{link,pin}:false;});
 const {link,pin}=await bundle.jsonValue();await phone.goto(link);await phone.waitForFunction(()=>document.getElementById('join-dialog').open&&!document.getElementById('join-code').disabled&&!location.hash);await phone.fill('#join-code',pin);await phone.click('#join-submit');await phone.waitForFunction(()=>document.getElementById('app').dataset.controller==='yes'&&!!window.__layoutReview.projectId);await pc.click('[data-close="pair-dialog"]');
}
async function projectMenu(page){await closeMenu(page);if(await page.locator('#project-menu').isHidden())await page.click('#projects-toggle');await page.locator('#project-menu').waitFor({state:'visible'});}
async function addProject(page,root){await projectMenu(page);await page.click('#quick-add-project');await page.fill('#project-path',root);await page.click('#project-submit');await page.locator('#project-dialog').waitFor({state:'hidden'});await page.waitForFunction(root=>window.__layoutReview.bootstrap.workspacePath===root,root);return (await snapshot(page)).projectId;}
async function selectProject(page,id){if((await snapshot(page)).projectId===id)return;await projectMenu(page);await page.locator('.quick-project-select[data-project-id="'+id+'"]').click();await page.waitForFunction(id=>window.__layoutReview.projectId===id&&!document.getElementById('projects-toggle').disabled,id);await page.locator('#project-menu').waitFor({state:'hidden'});}
async function saveIdentity(page){await page.evaluate(()=>{window.__originalLayoutNodes=['code-input','messages','prompt','ai-panel'].map(id=>document.getElementById(id));});}
async function sameNodes(page){const result=await page.evaluate(()=>window.__originalLayoutNodes.every(node=>node===document.getElementById(node.id)&&node.isConnected)&&['code-input','messages','prompt','ai-panel'].every(id=>document.querySelectorAll('#'+id).length===1));assert(result,'A second editor/chat was created or the original DOM was replaced');}
async function measure(page,name,expected){
 const data=await page.evaluate(()=>{
  const rect=e=>{const r=e.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height};};
  const visible=e=>!!(e.offsetWidth||e.offsetHeight||e.getClientRects().length)&&getComputedStyle(e).visibility!=='hidden';
  const region=id=>{const e=document.getElementById(id);return {visible:visible(e),...rect(e)};};
  const controls=['mobile-code','mobile-ai','ai-layout-split','ai-layout-tab','provider','ai-settings','ai-cancel','prompt','ai-send'].map(id=>{const e=document.getElementById(id);const r=rect(e);return {id,visible:visible(e),...r,hit:visible(e)&&e.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2))};});
  return {viewport:{width:innerWidth,height:innerHeight},documentWidth:document.documentElement.scrollWidth,code:region('code-input'),ai:region('ai-panel'),messages:region('messages'),controls,dom:document.querySelectorAll('*').length};
 });
 data.name=name;layouts.push(data);assert(data.documentWidth<=data.viewport.width,name+' creates horizontal page overflow');
 if(expected==='split'){
  assert(data.code.visible&&data.ai.visible,name+' does not display both code and AI');
  assert(data.code.right<=data.ai.left+1,name+' Split panels overlap or are not side-by-side');
  assert(data.code.width>=44&&data.ai.width>=44&&data.code.height>=44&&data.messages.height>=44,name+' has no usable reading/editing area');
  assert.equal(await page.locator('#code-input').getAttribute('readonly'),null,'Split code is not editable');
 }else if(expected==='ai')assert(data.ai.visible&&!data.code.visible,name+' AI Tab is not a separate working surface');
 else if(expected==='code')assert(data.code.visible&&!data.ai.visible,name+' File Tab is not a separate working surface');
 for(const item of data.controls.filter(v=>v.visible)){
  assert(item.left>=-1&&item.right<=data.viewport.width+1&&item.top>=-1&&item.bottom<=data.viewport.height+1,name+' has an offscreen control: '+item.id);
  assert(item.hit,name+' has an obscured control: '+item.id);
  if(data.viewport.width<=900)assert(item.width>=43.9&&item.height>=43.9,name+' has a phone control below44px: '+item.id);
 }
 await sameNodes(page);return data;
}
async function codeState(page){return page.locator('#code-input').evaluate(e=>({value:e.value,start:e.selectionStart,end:e.selectionEnd,direction:e.selectionDirection,top:e.scrollTop,left:e.scrollLeft}));}
async function assertCodeState(page,expected,scroll=true){const actual=await codeState(page);layouts.push({name:'editor-retention',expected:{start:expected.start,end:expected.end,direction:expected.direction,top:expected.top,left:expected.left},actual:{start:actual.start,end:actual.end,direction:actual.direction,top:actual.top,left:actual.left},sameText:actual.value===expected.value});assert.equal(actual.value,expected.value,'Layout change loses unsaved source');assert.deepEqual([actual.start,actual.end,actual.direction],[expected.start,expected.end,expected.direction],'Layout change loses source selection');if(scroll){assert(Math.abs(actual.top-expected.top)<=1,'Layout change loses source vertical scroll: '+actual.top+' vs '+expected.top);assert(Math.abs(actual.left-expected.left)<=1,'Layout change loses source horizontal scroll: '+actual.left+' vs '+expected.left);}}
async function noWork(page,start,turnCount){const sent=await page.evaluate(start=>window.__layoutReview.sent.slice(start).map(v=>v.type),start);assert(!sent.some(type=>['terminal_start','terminal_stop','terminal_input','ai_start','ai_cancel','edit_file','patch_file','save_file'].includes(type)),'Layout toggle executes work: '+sent.join(','));assert.equal(turns(),turnCount,'Layout toggle creates an AI turn');layouts.push({name:'layout-command-audit',sentTypes:sent,providerTurns:turnCount});}

(async()=>{
 await startHost();browser=await playwright[engine].launch({...(engine==='chromium'?{executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'}:{}),headless:true});browserVersion=browser.version();
 const pcContext=await browser.newContext({viewport:{width:1280,height:800}}),phoneContext=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
 await installCapture(pcContext);await installCapture(phoneContext);pc=await pcContext.newPage();phone=await phoneContext.newPage();observe(pc);observe(phone);
 await pc.goto(privateUrl);await pc.waitForFunction(()=>document.getElementById('app').dataset.controller==='yes'&&!!window.__layoutReview.projectId);
 await check('Frozen embedded build starts without a shell or inference',async()=>{
  if(!baseline)for(const [route,file]of [['/','index.html'],['/editor.js','editor.js'],['/app.js','app.js'],['/style.css','style.css']])assert.equal(await(await pc.request.get(new URL(route,privateUrl).href)).text(),fs.readFileSync(path.join(repo,'web',file),'utf8'));
  assert.equal((await snapshot(pc)).terminal.running,false);assert.equal(turns(),0);
 });
 const rootA=(await snapshot(pc)).projectId;
 await check('Real paired phone and desktop share one editable fixture',async()=>{await openFile(pc);await pairPhone();await openFile(phone);assert.equal(await phone.locator('#code-input').inputValue(),code);assert.equal(await pc.locator('#code-input').inputValue(),code);await saveIdentity(pc);await saveIdentity(phone);});
 await check('Matched task state has a real fake-provider reply and unsent draft',async()=>{
  await ai(pc);await pc.fill('#prompt',question);await pc.click('#ai-send');await pc.waitForFunction(()=>document.getElementById('messages').textContent.includes('Review item 18'));
  await ai(phone);await phone.waitForFunction(()=>document.getElementById('messages').textContent.includes('Review item 18'));await pc.fill('#prompt',draft);await phone.fill('#prompt',draft);
  if(!baseline){assert.equal(await pc.locator('#app').getAttribute('data-ai-layout'),'split','Desktop default should be Split');assert.equal(await phone.locator('#app').getAttribute('data-ai-layout'),'tab','Phone default should be Tab');}
  await screenshot(pc,'desktop-ai-matched');await screenshot(phone,'phone-ai-matched');
 });
 if(baseline){console.log('BASELINE CAPTURE '+engine);return;}
 await check('Desktop Split keeps editable source beside the same AI conversation',async()=>{await mode(pc,'split');await measure(pc,'desktop-split','split');await screenshot(pc,'desktop-split');});
 await check('Desktop file and AI tabs are distinct and work through native keyboard activation',async()=>{
  await actions.aiOptions(pc);await pc.locator('#ai-layout-tab').focus();await pc.keyboard.press('Space');await pc.waitForFunction(()=>document.getElementById('app').dataset.aiLayout==='tab');await measure(pc,'desktop-ai-tab','ai');await screenshot(pc,'desktop-ai-tab');
  assert((await pc.locator('#mobile-code').textContent()).includes(filename),'File tab does not name the open file');
  assert.equal(await pc.locator('#mobile-code').getAttribute('role'),'tab');assert.equal(await pc.locator('#mobile-ai').getAttribute('role'),'tab');assert.equal(await pc.locator('#mobile-ai').getAttribute('aria-selected'),'true');assert.equal(await pc.locator('#mobile-code').getAttribute('aria-selected'),'false');
  await pc.locator('#mobile-code').focus();await pc.keyboard.press('Enter');await measure(pc,'desktop-file-tab','code');await screenshot(pc,'desktop-file-tab');await pc.locator('#mobile-ai').focus();await pc.keyboard.press('Space');await measure(pc,'desktop-ai-tab-keyboard','ai');await pc.locator('#mobile-ai').focus();await pc.keyboard.press('Home');assert.equal(await pc.locator('#app').getAttribute('data-view'),'code');assert.equal(await pc.locator('#mobile-code').getAttribute('aria-selected'),'true');await pc.keyboard.press('ArrowRight');assert.equal(await pc.locator('#app').getAttribute('data-view'),'ai');assert(await pc.locator('#mobile-ai').evaluate(e=>document.activeElement===e));
 });
 await check('Split and Tab retain unsaved text, selection, both source scroll axes, prompt and conversation scroll',async()=>{
  await mode(pc,'split');const edited=code+'// Unsent edits survive AI layout changes.\n';await pc.fill('#code-input',edited);await pc.waitForFunction(text=>window.__layoutReview.events.some(v=>v.type==='file_state'&&v.file?.content===text),edited);
  await pc.locator('#code-input').evaluate(e=>{e.setSelectionRange(360,382,'backward');e.scrollTop=410;e.scrollLeft=110;e.dispatchEvent(new Event('scroll'));});
  await pc.locator('#messages').evaluate(e=>{e.scrollTop=90;e.dispatchEvent(new Event('scroll'));});await sleep(80);const expected=await codeState(pc),chatTop=await pc.locator('#messages').evaluate(e=>e.scrollTop);assert(chatTop>0,'Conversation fixture must be long enough to scroll');
  const start=await pc.evaluate(()=>window.__layoutReview.sent.length),turnCount=turns();
  for(let i=0;i<6;i++){await mode(pc,'tab');await view(pc,'code');await view(pc,'ai');await mode(pc,'split');}
  await assertCodeState(pc,expected);assert.equal(await pc.locator('#prompt').inputValue(),draft);assert((await pc.locator('#messages').innerText()).includes(question));assert((await pc.locator('#messages').innerText()).includes('Review item 18'));assert(Math.abs(await pc.locator('#messages').evaluate(e=>e.scrollTop)-chatTop)<=1,'Conversation scroll changes on layout toggle');assert.equal(fs.readFileSync(path.join(roots[0],filename),'utf8'),code,'Layout toggles save the dirty source');await sameNodes(pc);await noWork(pc,start,turnCount);await screenshot(pc,'desktop-retained-edit');
 });
 await check('A real horizontal wheel gesture in the wider File tab overrides the earlier Split scroll position',async()=>{
  await mode(pc,'tab');await view(pc,'code');await pc.bringToFront();await pc.locator('#code-input').click({position:{x:70,y:40}});const before=await codeState(pc);assert(before.left>30,'Fixture must retain horizontal scroll in the wider File tab');await pc.locator('#code-input').evaluate(e=>{
   window.__layoutWheels=[];window.__layoutInputTrace=[];
   const trace=(type,event)=>{if(window.__layoutInputTrace.length<80)window.__layoutInputTrace.push({type,target:event.target.id,trusted:event.isTrusted,defaultPrevented:event.defaultPrevented,left:e.scrollLeft,top:e.scrollTop,at:Math.round(performance.now()),active:document.activeElement.id,view:document.getElementById('app').dataset.view});};
   e.addEventListener('wheel',event=>{window.__layoutWheels.push({target:event.target.id,deltaX:event.deltaX,deltaY:event.deltaY,trusted:event.isTrusted});trace('wheel',event);queueMicrotask(()=>trace('wheel-after-bubble',event));},{passive:true});e.addEventListener('scroll',event=>trace('scroll',event),{passive:true});document.addEventListener('focusin',event=>trace('focusin',event));
  });const geometry=await pc.locator('#code-input').evaluate(e=>({scrollWidth:e.scrollWidth,clientWidth:e.clientWidth,scrollHeight:e.scrollHeight,clientHeight:e.clientHeight,editorInert:document.getElementById('editor-panel').inert,hidden:document.hidden,rect:e.getBoundingClientRect().toJSON()}));await pc.locator('#code-input').hover();await pc.mouse.wheel(-86,0);await pc.waitForFunction(left=>document.getElementById('code-input').scrollLeft<left-20,before.left,{timeout:1000}).catch(()=>{});if((await codeState(pc)).left>=before.left-20){await pc.mouse.wheel(-86,1);await pc.waitForFunction(left=>document.getElementById('code-input').scrollLeft<left-20,before.left,{timeout:3000}).catch(()=>{});}const moved=await codeState(pc),wheel=await pc.evaluate(()=>({events:window.__layoutWheels,trace:window.__layoutInputTrace}));layouts.push({name:'native-wheel-input',before:before.left,after:moved.left,geometry,...wheel});assert(moved.left<before.left-20,'Native horizontal wheel gesture did not change source scroll: '+JSON.stringify({before:before.left,after:moved.left,wheel}));await view(pc,'ai');await mode(pc,'split');await assertCodeState(pc,moved);layouts.push({name:'native-user-horizontal-scroll',before:before.left,afterWheel:moved.left,restored:await pc.locator('#code-input').evaluate(e=>e.scrollLeft)});
 });
 await check('Returning to the file cannot overwrite a new native select-all on a delayed frame',async()=>{
  await mode(pc,'tab');await view(pc,'ai');await view(pc,'code');await pc.locator('#code-input').focus();await pc.keyboard.press('Meta+A');const selected=await codeState(pc);assert.equal(selected.start,0);assert.equal(selected.end,selected.value.length);await sleep(80);await assertCodeState(pc,selected,false);
 });
 await check('Both layouts remain reachable and usable in portrait, short keyboard viewport and landscape',async()=>{
  for(const size of [{width:390,height:844},{width:320,height:300},{width:844,height:390}]){
   await phone.setViewportSize(size);await ai(phone);await mode(phone,'split');await measure(phone,'phone-split-'+size.width+'x'+size.height,'split');await screenshot(phone,'phone-split-'+size.width+'x'+size.height);
   const original=await phone.locator('#code-input').inputValue(),insert='/* touch edit */';await phone.locator('#code-input').tap();await phone.locator('#code-input').evaluate(e=>e.setSelectionRange(190,214,'backward'));await phone.keyboard.insertText(insert);const changed=original.slice(0,190)+insert+original.slice(214);assert.equal(await phone.locator('#code-input').inputValue(),changed,'Native typing into phone Split failed');await phone.waitForFunction(text=>window.__layoutReview.events.some(v=>v.type==='file_state'&&v.file?.content===text),changed);
   await phone.locator('#code-input').evaluate(e=>{e.setSelectionRange(240,266,'backward');e.scrollTop=370;e.scrollLeft=65;e.dispatchEvent(new Event('scroll'));});const position=await codeState(phone);assert(position.top>0&&position.left>0,'Phone Split source fixture must exercise both scroll axes');
   await mode(phone,'tab');await view(phone,'ai');await measure(phone,'phone-ai-tab-'+size.width+'x'+size.height,'ai');await screenshot(phone,'phone-ai-tab-'+size.width+'x'+size.height);await view(phone,'code');await measure(phone,'phone-file-tab-'+size.width+'x'+size.height,'code');await screenshot(phone,'phone-file-tab-'+size.width+'x'+size.height);
   await mode(phone,'split');await assertCodeState(phone,position);
  }
  await phone.setViewportSize({width:390,height:844});
 });
 await check('Phone layout cycles preserve editing position and unsent AI text',async()=>{
  await mode(phone,'split');await phone.locator('#code-input').evaluate(e=>{e.setSelectionRange(190,214,'backward');e.scrollTop=510;e.scrollLeft=80;e.dispatchEvent(new Event('scroll'));});const expected=await codeState(phone);await phone.fill('#prompt','Phone unsent question');const start=await phone.evaluate(()=>window.__layoutReview.sent.length),turnCount=turns();
  for(let i=0;i<4;i++){await mode(phone,'tab');await view(phone,'code');await view(phone,'ai');await mode(phone,'split');}
  await assertCodeState(phone,expected);assert.equal(await phone.locator('#prompt').inputValue(),'Phone unsent question');await noWork(phone,start,turnCount);await sameNodes(phone);
 });
 await check('Running AI keeps Stop reachable and at least44px of conversation at320x300 Split',async()=>{
  if(await phone.locator('#save-button').isVisible())await phone.click('#save-button');await phone.waitForFunction(()=>document.getElementById('save-button').hidden);await phone.setViewportSize({width:320,height:300});await mode(phone,'split');await phone.fill('#prompt','HOLD a running fixture reply while checking the short Split layout');await phone.click('#ai-send');await phone.locator('#ai-cancel').waitFor({state:'visible'});await measure(phone,'phone-running-split-320x300','split');await screenshot(phone,'phone-running-split-320x300');fs.writeFileSync(path.join(fixture,'ai-gate'),'finish');await phone.locator('#ai-cancel').waitFor({state:'hidden'});await phone.fill('#prompt','Phone unsent question');await phone.setViewportSize({width:390,height:844});
 });
 await check('Project switching restores each file, prompt and conversation while retaining the working surface and device layout',async()=>{
  await mode(pc,'split');await pc.fill('#prompt','Client project draft');const a=await codeState(pc),rootB=await addProject(pc,roots[1]);await openFile(pc);await ai(pc);await mode(pc,'tab');await pc.fill('#prompt','Server project draft');assert(!(await pc.locator('#messages').innerText()).includes(question),'Server inherited another project conversation');
  const start=await pc.evaluate(()=>window.__layoutReview.sent.length),turnCount=turns();
  await selectProject(pc,rootA);assert.equal(await pc.locator('#app').getAttribute('data-ai-layout'),'tab','Device layout preference changed during project switch');assert.equal(await pc.locator('#app').getAttribute('data-view'),'ai','Tab AI working surface was lost');await assertCodeState(pc,a,false);assert.equal(await pc.locator('#prompt').inputValue(),'Client project draft');assert((await pc.locator('#messages').innerText()).includes(question));
  await selectProject(pc,rootB);assert.equal(await pc.locator('#app').getAttribute('data-ai-layout'),'tab');assert.equal(await pc.locator('#prompt').inputValue(),'Server project draft');assert(!(await pc.locator('#messages').innerText()).includes(question));await mode(pc,'split');await view(pc,'code');await selectProject(pc,rootA);assert.equal(await pc.locator('#app').getAttribute('data-ai-layout'),'split');assert.equal(await pc.locator('#app').getAttribute('data-view'),'code','Split Code working surface was lost');assert.equal(await pc.locator('#app').getAttribute('data-ai-open'),'yes','Project switch closes the working Split');assert.equal(await pc.locator('#prompt').inputValue(),'Client project draft');assert.equal((await snapshot(phone)).projectId,rootA,'Desktop switch moved the phone');await sameNodes(pc);const sent=await pc.evaluate(start=>window.__layoutReview.sent.slice(start).map(v=>v.type),start);assert(!sent.some(type=>['terminal_start','terminal_stop','terminal_input','ai_start','ai_cancel'].includes(type)),'Project/layout switch starts work');assert.equal(turns(),turnCount);await screenshot(pc,'desktop-project-restoration');
 });
 await check('AI layout changes coordinate an existing terminal without shell commands or extra AI turns',async()=>{
  await pc.click('#terminal-shortcut-toggle');await pc.waitForFunction(()=>!document.getElementById('terminal-command').disabled&&window.__layoutReview.events.some(v=>v.terminal?.running));
  await command(pc,'terminal_input',{data:'pwd > layout-shell-cwd.txt; printf "%s\\n" "$$" > layout-shell-pid.txt\r'},true);
  const limit=Date.now()+10000;while(!fs.existsSync(path.join(roots[0],'layout-shell-pid.txt'))){if(Date.now()>limit)throw Error('Actual fixture shell did not respond');await sleep(30);}
  const pid=fs.readFileSync(path.join(roots[0],'layout-shell-pid.txt'),'utf8').trim();assert.equal(fs.readFileSync(path.join(roots[0],'layout-shell-cwd.txt'),'utf8').trim(),roots[0]);
  await pc.locator('#terminal-command').evaluate(e=>{e.value='HELD_DO_NOT_SEND';e.setSelectionRange(2,6,'backward');});const start=await pc.evaluate(()=>window.__layoutReview.sent.length),turnCount=turns();
  await ai(pc);await mode(pc,'split');assert(await pc.locator('#terminal-panel').isVisible(),'Split loses the already open terminal');await mode(pc,'tab');await view(pc,'ai');assert(await pc.locator('#terminal-panel').isHidden(),'AI Tab is obscured by the code terminal');await view(pc,'code');assert(await pc.locator('#terminal-panel').isVisible(),'File Tab fails to restore its terminal');await view(pc,'ai');await mode(pc,'split');
  await noWork(pc,start,turnCount);assert.equal(await pc.locator('#terminal-command').inputValue(),'HELD_DO_NOT_SEND');assert.deepEqual(await pc.locator('#terminal-command').evaluate(e=>[e.selectionStart,e.selectionEnd,e.selectionDirection]),[2,6,'backward']);assert.equal(fs.readFileSync(path.join(roots[0],'layout-shell-pid.txt'),'utf8').trim(),pid);assert.equal((await snapshot(pc)).terminal.running,true);await screenshot(pc,'desktop-terminal-ai-coordination');
 });
 await check('Native settings dialog and composing Enter fence workspace shortcuts and AI submission',async()=>{
  await mode(pc,'tab');await view(pc,'ai');const before={mode:await pc.locator('#app').getAttribute('data-ai-layout'),view:await pc.locator('#app').getAttribute('data-view'),turns:turns(),sent:await pc.evaluate(()=>window.__layoutReview.sent.length)};
  await pc.click('#ai-settings');await pc.locator('#settings-dialog').waitFor({state:'visible'});await pc.keyboard.press('Control+Backquote');assert.equal(await pc.locator('#app').getAttribute('data-view'),before.view);assert.equal(await pc.locator('#app').getAttribute('data-ai-layout'),before.mode);await pc.keyboard.press('Escape');await pc.locator('#settings-dialog').waitFor({state:'hidden'});assert.equal(await pc.locator('#app').getAttribute('data-view'),before.view,'Escape closing dialog also closes AI');
  await pc.locator('#prompt').evaluate(e=>{e.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true,data:'あ'}));e.dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,key:'Enter',code:'Enter',isComposing:true}));e.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'あ'}));});await sleep(100);assert.equal(turns(),before.turns,'Composing Enter submits the prompt');assert.equal(await pc.locator('#prompt').inputValue(),'Client project draft');const sent=await pc.evaluate(start=>window.__layoutReview.sent.slice(start).map(v=>v.type),before.sent);assert(!sent.includes('terminal_start')&&!sent.includes('terminal_input')&&!sent.includes('ai_start'),'Native dialog/IME keys execute workspace work');
 });
 await check('Repeated layout switches reuse bounded DOM and produce no browser errors',async()=>{
  await mode(pc,'split');const before=await pc.evaluate(()=>document.querySelectorAll('*').length);for(let i=0;i<15;i++){await mode(pc,'tab');await view(pc,'code');await view(pc,'ai');await mode(pc,'split');}const after=await pc.evaluate(()=>document.querySelectorAll('*').length);assert(after<=before+2,'Repeated layout switches accumulate DOM nodes');await sameNodes(pc);await sameNodes(phone);assert.deepEqual(errors,[]);layouts.push({name:'repeated-switch-dom',before,after,cycles:15});
 });
 await check('Layout preference survives reload and stays separate between desktop and phone viewport classes',async()=>{
  // Keep this separate responsive-page probe after native interaction checks:
  // closing a resized Chromium target can disturb sibling target hit testing.
  const preferenceContext=await browser.newContext({viewport:{width:1280,height:800}});await installCapture(preferenceContext);const preferencePage=await preferenceContext.newPage();observe(preferencePage);try{
   await preferencePage.goto(privateUrl);await preferencePage.waitForFunction(()=>document.getElementById('app').dataset.controller==='yes');await ai(preferencePage);await mode(preferencePage,'tab');await preferencePage.reload();await preferencePage.waitForFunction(()=>document.getElementById('app').dataset.connected==='yes');assert.equal(await preferencePage.locator('#app').getAttribute('data-ai-layout'),'tab','Desktop Tab preference is lost on reload');
   await preferencePage.setViewportSize({width:390,height:844});await preferencePage.waitForTimeout(100);await ai(preferencePage);await mode(preferencePage,'split');await preferencePage.setViewportSize({width:1280,height:800});await preferencePage.waitForTimeout(100);assert.equal(await preferencePage.locator('#app').getAttribute('data-ai-layout'),'tab','Phone preference overwrites the desktop layout');await preferencePage.setViewportSize({width:390,height:844});await preferencePage.waitForTimeout(100);assert.equal(await preferencePage.locator('#app').getAttribute('data-ai-layout'),'split','Returning to phone loses its Split preference');
  }finally{await preferenceContext.close();}
 });
 console.log('AI LAYOUT FUNCTIONAL ACCEPT '+engine+' '+checks.length+' checks');
})().catch(async error=>{findings.push({stage,message:error.message});console.error('AI LAYOUT REJECT '+stage+': '+error.message);try{if(phone&&!phone.isClosed())await screenshot(phone,'failure-phone');if(pc&&!pc.isClosed())await screenshot(pc,'failure-desktop');}catch{}process.exitCode=1;}).finally(async()=>{
 const screenshotProof=screenshots.map(file=>{const bytes=fs.readFileSync(path.join(artifacts,file));return {file,bytes:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')};});
 const report={status:findings.length?'reject':baseline?'baseline-captured':'functional-accept-pending-visual-review',date:new Date().toISOString(),binarySha256,browserEngine:engine,browserVersion,realHost:true,sourceOverrides:false,disposableWorkspaces:true,fakeProviders:true,checks,screenshots:screenshotProof,layouts,findings,unexpectedBrowserErrors:errors,references:'tests/ai-layout-review-references/provenance.json',matchedTaskState:{file:filename,source:'160 generated lines, same content and visible text on both releases',prompt:question,reply:'same deterministic fake-provider reply',unsentDraft:draft,viewports:[{width:1280,height:800},{width:390,height:844}]},limits:['No real inference, credentials, user projects, tunnels or live Nimlo hosts were accessed.','Physical devices and native mobile keyboards remain untested.320x300 is a simulated reduced visual viewport; IME events are injected.','Independent recognizable matched-state screenshot comparison; no true blind study or broad product parity claim.']};
 fs.writeFileSync(path.join(artifacts,'review.json'),JSON.stringify(report,null,2)+'\n');if(browser)await browser.close().catch(()=>{});await stopHost();fs.rmSync(fixture,{recursive:true,force:true});
});
