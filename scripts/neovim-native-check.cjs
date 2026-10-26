#!/usr/bin/env node
'use strict';
// The actual signed app, a real embedded Neovim, a paired browser and fake AI.
// Every project, shell, credential and recovery record belongs to this fixture.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {spawn,execFileSync}=require('node:child_process');
const playwright=require(process.env.PLAYWRIGHT_PATH||'playwright');
const repo=path.resolve(__dirname,'..'),out=path.join(repo,'target/neovim-review');fs.mkdirSync(out,{recursive:true});
const work=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'nimlo-neovim-native-'))),root=path.join(work,'Project A'),other=path.join(work,'Project B'),bin=path.join(work,'bin'),state=path.join(work,'state'),control=path.join(work,'control');
for(const dir of [root,other,bin,state,control])fs.mkdirSync(dir,{mode:0o700});
const unicode='日本 café 👩‍💻 é without a final newline',large=('// 日本😀 const value = 1;\n').repeat(15000);
const source='const message = "Hello from Neovim";\n// Shared with the phone\n',nested='docs/branding/sample-project/logo-exploration/logo-v03-master-prompt.txt';
const selectionSource='alpha beta\nsecond line\n日本 café 👩‍💻 é\nlast';
fs.writeFileSync(path.join(root,'selection.txt'),selectionSource);
fs.mkdirSync(path.join(root,'src'));fs.writeFileSync(path.join(root,'unicode.txt'),unicode);fs.writeFileSync(path.join(root,'large.js'),large);fs.writeFileSync(path.join(root,'hello.js'),source);fs.writeFileSync(path.join(root,'other.txt'),'Other file\n');fs.writeFileSync(path.join(other,'hello.js'),'Project B source\n');
fs.mkdirSync(path.dirname(path.join(root,nested)),{recursive:true});fs.writeFileSync(path.join(root,nested),'Nested prompt\n');
const fake=String.raw`#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path'),readline=require('node:readline');const provider=path.basename(process.argv[1]);
if(['login','auth'].includes(process.argv[2])){console.log(provider==='codex'?'Logged in using ChatGPT':JSON.stringify({loggedIn:true,authMethod:'claude.ai'}));process.exit(0);}
const send=x=>console.log(JSON.stringify(x));
readline.createInterface({input:process.stdin}).on('line',line=>{const f=JSON.parse(line);
if(provider==='codex'){
if(f.method==='initialize')send({id:f.id,result:{userAgent:'nimlo-neovim-fixture'}});
else if(f.method==='thread/start'||f.method==='thread/resume')send({id:f.id,result:{thread:{id:'neovim-test-thread'}}});
else if(f.method==='turn/start'){send({id:f.id,result:{turn:{id:'turn-1'}}});send({method:'item/completed',params:{item:{id:'reply',type:'agentMessage',text:'Neovim companion fixture reply\n\n[Open other file](other.txt:1)'}}});send({method:'turn/completed',params:{turn:{id:'turn-1',status:'completed',error:null}}});}
}else if(f.type==='control_request')send({type:'control_response',response:{subtype:'success',request_id:f.request_id,response:{}}});
else if(f.type==='user'){send({type:'system',subtype:'init',session_id:'neovim-claude'});send({type:'assistant',message:{id:'reply',content:[{type:'text',text:'Neovim Claude fixture reply'}]}});send({type:'result',subtype:'success',is_error:false,session_id:'neovim-claude',result:'Neovim Claude fixture reply'});}
});
`;
for(const name of ['codex','claude'])fs.writeFileSync(path.join(bin,name),fake,{mode:0o700});
const appBundle=path.resolve(process.env.NIMLO_NEOVIM_APP||path.join(repo,'target/desktop/Nimlo.app'));
const executable=path.join(appBundle,'Contents/MacOS/Nimlo');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms)),read=file=>{try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch{return null;}};
let child,browser,phone,sequence=0,stderr='',hostPid,nvimPid,stage='startup';const checks=[];
function status(){return read(path.join(control,'status.json'));}
async function until(test,label,timeout=30000){const end=Date.now()+timeout;while(Date.now()<end){const result=await test();if(result)return result;await pause(50);}throw Error('Timeout '+label+'; status='+JSON.stringify((s=>s?{...s,text:undefined,textLength:s.text?.length,textTail:s.text?.slice(-150)}:s)(status()))+'; stderr='+stderr);}
async function command(value,allowFailure=false){const name=String(++sequence).padStart(6,'0')+'.json',file=path.join(control,name);fs.writeFileSync(file+'.tmp',JSON.stringify(value),{mode:0o600});fs.renameSync(file+'.tmp',file);const reply=await until(()=>read(path.join(control,'responses',name)),value.kind);if(!allowFailure)assert.equal(reply.ok,true,reply.error||JSON.stringify(reply));return reply;}
const engine=lua=>command({kind:'engine',lua}).then(r=>r.value);
const rpc=(type,fields={})=>command({kind:'rpc',type,fields}).then(r=>r.value);
// AppKit retargets responder-chain actions after a closing sheet's animation.
const menu=action=>until(async()=>{const reply=await command({kind:'menu',action},true);if(reply.ok)return reply;if(reply.error!=='Menu is disabled')throw Error(reply.error);return false;},'enabled menu '+action);
const toolbar=title=>until(async()=>{const reply=await command({kind:'toolbar',title},true);if(reply.ok)return reply;if(reply.error!=='Disabled toolbar action')throw Error(reply.error);return false;},'enabled toolbar '+title);
async function settled(text){await until(()=>{const s=status();return s?.text===text&&!s.pending;},'settled '+text.slice(0,30));}
async function check(name,run){if(process.env.NIMLO_UI_ONLY==='1'&&!name.startsWith('Toolbar tools'))return;if(process.env.NIMLO_CHECK_FILTER&&!name.includes(process.env.NIMLO_CHECK_FILTER))return;stage=name;await run();checks.push(name);console.log('PASS '+name);}
async function open(file){await command({kind:'file',path:file});await until(()=>status()?.active===file&&!status()?.pending&&!status()?.busy,'open '+file);}
async function js(javascript){return(await command({kind:'companionJS',javascript})).value;}
function alive(pid){try{process.kill(pid,0);return true;}catch{return false;}}
async function start(openFile='hello.js'){
 child=spawn(executable,['--workspace',root,'--open-file',openFile,'--state-dir',state,'--test-control',control],{env:{...process.env,PATH:bin+path.delimiter+process.env.PATH},stdio:['ignore','pipe','pipe']});
 child.stderr.on('data',data=>stderr+=data);await until(()=>status()?.ready&&status().active===openFile,'native app ready',60000);hostPid=status().hostPid;nvimPid=status().neovimPid;
}
(async()=>{
 await start();await settled(source);
 await check('Native app starts a real Neovim 0.12.6 and native editor without a WebView',async()=>{
  const s=status();assert.equal(s.engineVersion,'0.12.6');assert.equal(s.companion,false);assert(alive(s.neovimPid));assert(alive(s.hostPid));assert.equal(s.text,source);
  assert.equal(execFileSync('/usr/libexec/PlistBuddy',['-c','Print :CFBundleIdentifier',path.join(appBundle,'Contents/Info.plist')],{encoding:'utf8'}).trim(),'dev.nimlo.editor');
  assert.equal(await engine('return vim.version().minor'),12);
 });
 await check('Native AppKit text input reaches the host and Command-S saves exact bytes',async()=>{
  await command({kind:'key',characters:'X',keyCode:7});await settled('X'+source);
  await command({kind:'key',characters:'s',keyCode:1,modifiers:1<<20});await until(()=>!status()?.dirty,'native save');assert.equal(fs.readFileSync(path.join(root,'hello.js'),'utf8'),'X'+source);
 });
 await check('Shared undo and redo survive saved-file switching',async()=>{
  await open('other.txt');await open('hello.js');await menu('undo:');await settled(source);await menu('redo:');await settled('X'+source);await menu('saveFile:');await until(()=>!status()?.dirty,'save before Vim');
 });
 await check('Real Vim commands and recorded macros edit the Neovim buffer',async()=>{
  await toolbar('Vim');await command({kind:'input',keys:'gg0qaA!<Esc>q'});await settled(('X'+source).replace('\n','!\n'));
  assert((await engine('return vim.fn.getreg("a")')).includes('A!'));
  await command({kind:'input',keys:'@a'});await settled(('X'+source).replace('\n','!!\n'));await menu('saveFile:');await until(()=>!status()?.dirty,'save macro edit');
 });
 await check('Native Find uses the Neovim search engine',async()=>{
  await command({kind:'find',query:'message'});assert.equal(await engine('return vim.fn.getreg("/")'),'\\Vmessage');assert((await engine('return vim.fn.searchcount({recompute=1}).total'))>=1);await command({kind:'closeFind'});
 });
 await check('Native Command-P discovers and opens the deep folder filename',async()=>{
  await command({kind:'key',characters:'p',keyCode:35,modifiers:1<<20});await until(()=>status()?.sheet,'Command-P sheet');await command({kind:'palette',query:'logo-v03-master-prompt'});await until(()=>status()?.palette.some(row=>row.path===nested),'native deep search');await command({kind:'paletteOpen'});await settled('Nested prompt\n');assert.equal(status().active,nested);
  await command({kind:'capture',name:'native-deep-file'});fs.copyFileSync(path.join(control,'native-deep-file.png'),path.join(out,'native-deep-file.png'));
 });
 await check('Native Unicode clipboard and Select All preserve exact text without adding a newline',async()=>{
  await open('unicode.txt');await settled(unicode);await toolbar('Edit');await command({kind:'focusEditor'});
  await menu('selectAll:');await menu('copy:');assert.equal((await command({kind:'clipboard'})).value,unicode);
  await command({kind:'setClipboard',text:'replacement 日本😀'});await menu('paste:');await settled('replacement 日本😀');
  await menu('undo:');await settled(unicode);await menu('saveFile:');await until(()=>!status()?.dirty,'save Unicode');
  await menu('selectAll:');await menu('copy:');await open('other.txt');await command({kind:'paste',text:'Prefix '});await settled('Prefix Other file\n');await menu('undo:');await settled('Other file\n');await menu('selectAll:');await menu('copy:');
 });
 await check('Edit mode Shift-Arrows select, copy, replace and delete through native keyboard events',async()=>{
  await open('selection.txt');await toolbar('Edit');await command({kind:'focusEditor'});await settled(selectionSource);
  const shift=1<<17,cmd=1<<20,option=1<<19;
  const key=(keyCode,modifiers=0)=>command({kind:'key',keyCode,modifiers,characters:({123:'\uf702',124:'\uf703',125:'\uf701',126:'\uf700',51:'\u007f',117:'\uf728',53:'\u001b'})[keyCode]||''});
  async function copied(expected){await command({kind:'setClipboard',text:'__selection_pending__'});try{await until(async()=>{await menu('copy:');return(await command({kind:'clipboard'})).value===expected;},'selection clipboard '+expected,5000);}catch(error){throw Error(error.message+'; selection='+JSON.stringify(await engine('return {mode=vim.fn.mode(1),cursor=vim.api.nvim_win_get_cursor(0),anchor=vim.fn.getpos("v")}')));}}
  async function reset(){await menu('selectAll:');await command({kind:'type',text:selectionSource});await settled(selectionSource);await key(126,cmd);await until(async()=>JSON.stringify(await engine('return vim.api.nvim_win_get_cursor(0)'))==='[1,0]','selection reset cursor');}
  await key(126,cmd);await key(124,shift);await key(124,shift);await key(124,shift);await copied('alp');assert.equal(status().dirty,false);
  await command({kind:'key',characters:'X',keyCode:7});await settled('Xha beta\nsecond line\n日本 café 👩‍💻 é\nlast');
  await menu('undo:');await settled(selectionSource);
  await key(126,cmd);await key(124,cmd);for(let i=0;i<4;i++)await key(123,shift);await copied('beta');
  await command({kind:'setClipboard',text:'new'});await menu('paste:');await settled('alpha new\nsecond line\n日本 café 👩‍💻 é\nlast');
  await key(51);await settled('alpha ne\nsecond line\n日本 café 👩‍💻 é\nlast');await command({kind:'type',text:'w'});await settled('alpha new\nsecond line\n日本 café 👩‍💻 é\nlast');
  await command({kind:'key',characters:'!',keyCode:18});await settled('alpha new!\nsecond line\n日本 café 👩‍💻 é\nlast');
  await reset();await key(124,shift);await key(124,shift);await key(123,shift);await copied('a');await key(123,shift);
  await command({kind:'key',characters:'Z',keyCode:6});await settled('Z'+selectionSource);
  await reset();await key(125,shift);await copied('alpha beta\n');await key(51);await settled(selectionSource.slice('alpha beta\n'.length));
  await command({kind:'key',characters:'Q',keyCode:12});await settled('Q'+selectionSource.slice('alpha beta\n'.length));
  await reset();await key(125);await key(126,shift);await copied('alpha beta\n');
  await reset();await key(125);await key(125);await key(123,cmd);await key(124,shift);await key(124,shift);await copied('日本');
  await command({kind:'type',text:'語'});await settled(selectionSource.replace('日本','語'));
  await reset();await key(124,cmd|shift);await copied('alpha beta');await key(117);await settled(selectionSource.slice('alpha beta'.length));
  await reset();await key(124,cmd);await key(123,option|shift);await copied('beta');await menu('cut:');await settled(selectionSource.replace('beta',''));
  await command({kind:'key',characters:'B',keyCode:11});await settled(selectionSource.replace('beta','B'));
  await reset();await key(125,cmd|shift);await copied(selectionSource);await key(123);await command({kind:'key',characters:'L',keyCode:37});await settled('L'+selectionSource);
  await reset();await key(125,cmd);await key(126,cmd|shift);await copied(selectionSource);await key(124);await command({kind:'key',characters:'R',keyCode:15});await settled(selectionSource+'R');
  await reset();await menu('selectAll:');await key(124);await command({kind:'type',text:'R'});await settled(selectionSource+'R');
  await reset();await menu('selectAll:');await key(123);await command({kind:'type',text:'L'});await settled('L'+selectionSource);
  await reset();await key(124,shift);await copied('a');await open('other.txt');await key(126,cmd);await command({kind:'type',text:'Safe '});await settled('Safe Other file\n');await menu('undo:');await settled('Other file\n');
  await open('selection.txt');await settled(selectionSource);await toolbar('Vim');await until(()=>status()?.mode==='normal','Vim navigation mode');
  assert.equal(await engine('return vim.o.keymodel'),'');assert.equal(await engine('return vim.o.selectmode'),'');assert.equal(await engine('return vim.o.selection'),'inclusive');
  await toolbar('Edit');await key(126,cmd);await key(124,shift);await copied('a');await key(53);assert.equal(status().vim,false);
  await command({kind:'type',text:'Q'});await settled('aQ'+selectionSource.slice(1));await menu('undo:');await settled(selectionSource);
  await key(126,cmd);await key(124,shift);await key(53);await command({kind:'paste',text:'P\n'});await settled('aP\n'+selectionSource.slice(1));await menu('undo:');await settled(selectionSource);
  await menu('saveFile:');await until(()=>!status()?.dirty,'selection fixture saved');assert.equal(fs.readFileSync(path.join(root,'selection.txt'),'utf8'),selectionSource);
 });
 await check('Large Unicode files use a bounded native grid and save exact edited bytes',async()=>{
  await open('large.js');await settled(large);
  await command({kind:'vim',enabled:true});await until(()=>status()?.mode==='normal','Vim normal mode');await command({kind:'input',keys:'G$AEND<Esc>'});
  const edited=large.slice(0,-1)+'END\n';await settled(edited);assert.equal(await engine('return vim.api.nvim_buf_line_count(0)'),15000);assert(status().gridRows<100);
  await menu('saveFile:');await until(()=>!status()?.dirty,'large save');assert.equal(fs.readFileSync(path.join(root,'large.js'),'utf8'),edited);
 });
 await check('A paired phone and native Neovim edit the same acknowledged source',async()=>{
  await open('hello.js');await command({kind:'vim',enabled:false});await menu('saveFile:');
  const launch=(await command({kind:'privateLaunch'})).url,origin=new URL(launch).origin,pair=await rpc('pair_create',{origin});
  browser=await playwright.chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
  const context=await browser.newContext({viewport:{width:390,height:844}});phone=await context.newPage();await phone.goto(origin+'/#invite='+pair.invite);await phone.fill('#join-code',pair.code);await phone.click('#join-submit');await phone.waitForFunction(()=>document.getElementById('app').dataset.connected==='yes'&&!document.getElementById('code-input').readOnly);
  await phone.fill('#code-input','Phone shared edit\n');await settled('Phone shared edit\n');
  await command({kind:'paste',text:'Native '});await until(()=>status()?.text.includes('Native '),'native paste');await until(async()=>await phone.inputValue('#code-input')===status()?.text,'phone receives native edit');
  await phone.keyboard.press('Meta+z');await settled('Phone shared edit\n');await menu('saveFile:');await until(()=>!status()?.dirty,'save phone edit');
 });
 await check('Cancel, save and discard close decisions preserve the native window and file bytes',async()=>{
  await command({kind:'paste',text:'dirty '});await until(()=>status()?.dirty&&!status()?.pending,'dirty close');await command({kind:'key',characters:'w',keyCode:13,modifiers:1<<20});await until(()=>status()?.sheet,'close sheet');await command({kind:'sheet',title:'Cancel'});await until(()=>!status()?.sheet,'cancel close');assert.equal(status().active,'hello.js');
  await menu('closeFile:');await until(()=>status()?.sheet,'discard sheet');await command({kind:'sheet',title:'Don’t Save'});await until(()=>status()?.active!=='hello.js','discard closes file');assert.equal(fs.readFileSync(path.join(root,'hello.js'),'utf8'),'Phone shared edit\n');
  await open('hello.js');await command({kind:'paste',text:'Saved '});await until(()=>status()?.dirty&&!status()?.pending,'save close dirty');await menu('closeFile:');await until(()=>status()?.sheet,'save close sheet');await command({kind:'sheet',title:'Save'});await until(()=>status()?.active!=='hello.js','save closes file');assert(fs.readFileSync(path.join(root,'hello.js'),'utf8').includes('Saved '));await open('hello.js');
 });
 await check('Project selection stays independent from the paired phone',async()=>{
  const first=status().projectId;await rpc('add_project',{path:other});await until(()=>status()?.workspace===other,'second project');await open('hello.js');await settled('Project B source\n');assert.equal(await phone.inputValue('#code-input'),fs.readFileSync(path.join(root,'hello.js'),'utf8'));
  await rpc('select_project',{targetProjectId:first});await until(()=>status()?.workspace===root,'return project');await open('hello.js');await settled(fs.readFileSync(path.join(root,'hello.js'),'utf8'));assert.equal(status().dirty,false);assert.equal(fs.readFileSync(path.join(other,'hello.js'),'utf8'),'Project B source\n');
 });
 await check('Toolbar tools share the main window, preserve native editing and fit a narrow window',async()=>{
  const fullWidth=status().editorWidth,fullHeight=status().editorHeight,originalHello=fs.readFileSync(path.join(root,'hello.js'),'utf8');
  await toolbar('AI');await until(()=>status()?.aiOpen,'AI open');await until(()=>status()?.aiOpen&&status()?.editorWidth<fullWidth-200,'AI sidebar');
  assert.equal(status().toolsWindowNumber,status().windowNumber);assert.equal(status().mainWindowCount,1);assert.equal((await command({kind:'hitEditor'})).value,true);
  await open('other.txt');await until(async()=> (await js('return document.getElementById("prompt").placeholder;')).includes('other.txt'),'AI follows selected file');await command({kind:'key',characters:'Y',keyCode:16});await until(()=>status()?.dirty&&!status()?.pending,'edit with AI open');const edited=status().text;
  await js('const p=document.getElementById("prompt");p.value="Guard unsaved edits";document.getElementById("prompt-form").requestSubmit();return true;');await until(async()=>await js('return !document.getElementById("notice").hidden&&document.getElementById("notice").textContent.includes("Save your open files");'),'AI unsaved guard');await until(()=>status()?.toolOverlays>0,'visible in-app notice');await js('document.getElementById("notice").click();document.getElementById("prompt").value="";return true;');
  await command({kind:'focusTools'});await js('document.getElementById("prompt").focus();return true;');await until(()=>/WK|Web/.test(status()?.responder||''),'tools text focus');await menu('saveFile:');await until(()=>!status()?.dirty,'native save with tools focused');assert.equal(fs.readFileSync(path.join(root,'other.txt'),'utf8'),edited);assert.equal(fs.readFileSync(path.join(root,'hello.js'),'utf8'),originalHello);
  await command({kind:'focusEditor'});await menu('undo:');await settled('Other file\n');await menu('saveFile:');await until(()=>!status()?.dirty,'restore other file');await open('hello.js');
  await toolbar('Terminal');await until(()=>status()?.terminalOpen&&status()?.editorHeight<fullHeight-100,'bottom terminal');assert.equal(status().aiOpen,true);assert.equal(status().mainWindowCount,1);assert.equal((await command({kind:'hitEditor'})).value,true);
  await command({kind:'resize',width:900,height:620});await until(()=>status()?.toolbarCompact&&status()?.editorWidth>=240&&status()?.editorWidth<350,'compact toolbar');assert(status().editorHeight>=120);assert(await js('return document.documentElement.scrollWidth<=innerWidth;'));
  await command({kind:'resize',width:1280,height:820});await until(()=>!status()?.toolbarCompact&&status()?.editorWidth>400,'restore width');await command({kind:'capture',name:'native-in-app-tools'});fs.copyFileSync(path.join(control,'native-in-app-tools.png'),path.join(out,'native-in-app-tools.png'));
  await js('document.getElementById("native-close-ai").click();return true;');await until(()=>!status()?.aiOpen&&status()?.terminalOpen&&status()?.editorWidth===fullWidth,'close AI only');
  await js('const previous=window.nimloDesktop;window.nimloDesktop={...previous,prepareReload:async(...args)=>{await new Promise(r=>setTimeout(r,250));return previous.prepareReload(...args);}};return true;');
  await toolbar('Terminal');await until(()=>!status()?.terminalOpen,'terminal hidden');await toolbar('AI');await until(()=>status()?.aiOpen,'rapidly reopen AI');await pause(400);assert.equal(status().aiOpen,true);assert.equal(status().companion,true);
  await toolbar('AI');await until(()=>!status()?.companion&&status()?.editorWidth===fullWidth&&status()?.editorHeight===fullHeight,'close all panes');await rpc('terminal_stop');
 });
 await check('In-app AI uses the provider integration, opens links in Neovim and preserves prompts',async()=>{
  await command({kind:'companion',view:'ai'});await until(async()=>{try{return await js('return document.getElementById("app")?.dataset.connected === "yes" && typeof window.nimloNeovimCompanion === "object";');}catch{return false;}},'AI companion ready');
  await js('document.getElementById("prompt").value="Disposable fixture question";document.getElementById("prompt").dispatchEvent(new Event("input",{bubbles:true}));document.getElementById("prompt-form").requestSubmit();return true;');
  await until(async()=> (await rpc('ai_status')).ai?.status==='complete','fake AI response');
  await until(async()=>await js('return !!document.querySelector(".ai-file-link");'),'AI file link');await js('document.querySelector(".ai-file-link").click();return true;');await until(()=>status()?.active==='other.txt'&&!status()?.busy,'AI link opens native file');assert.equal(await engine('return vim.api.nvim_win_get_cursor(0)[1]'),1);assert.equal(status().aiOpen,true);await open('hello.js');

  await settled(fs.readFileSync(path.join(root,'hello.js'),'utf8'));const nativeBeforePromptUndo=status().text;
  await command({kind:'focusTools'});await js('const p=document.getElementById("prompt");p.value="";p.focus();document.execCommand("insertText",false,"Prompt undo text");return true;');await until(()=>/WK|Web/.test(status()?.responder||''),'prompt focus');await menu('undo:');await until(async()=>await js('return document.getElementById("prompt").value;')==='','prompt undo');assert.equal(status().text,nativeBeforePromptUndo);await menu('redo:');await until(async()=>await js('return document.getElementById("prompt").value;')==='Prompt undo text','prompt redo');assert.equal(status().text,nativeBeforePromptUndo);
  await js('document.getElementById("prompt").value="Unsent companion prompt";document.getElementById("prompt").dispatchEvent(new Event("input",{bubbles:true}));return true;');
  await command({kind:'closeCompanion'});await until(()=>status()?.companion===false,'release companion');
  await command({kind:'companion',view:'ai'});await until(async()=>{try{return await js('return document.getElementById("prompt")?.value;')==='Unsent companion prompt';}catch{return false;}},'restore prompt');
 });
 await check('Terminal survives companion closure with the same shell session',async()=>{
  await command({kind:'companion',view:'terminal'});await until(()=>status()?.terminalOpen&&status()?.aiOpen,'AI and terminal remain open together');assert.equal(status().toolsWindowNumber,status().windowNumber);await until(async()=> (await rpc('terminal_history',{limit:100})).type!=='error'&&(await rpc('terminal_history',{limit:100})), 'terminal available');
  await until(async()=> (await rpc('ping')).type==='pong','host alive');
  await pause(300);await rpc('terminal_input',{data:"NIMLO_NEO_PROOF='SHARED_TERMINAL'; printf 'ENGINE_%s\\n' \"$NIMLO_NEO_PROOF\"\n"});
  await until(async()=>JSON.stringify(await rpc('terminal_history',{limit:100})).includes('ENGINE_SHARED_TERMINAL')||JSON.stringify(await rpc('terminal_resize',{cols:90,rows:30})).includes('ENGINE_SHARED_TERMINAL'),'shell output');
  await command({kind:'closeCompanion'});await until(()=>!status()?.companion,'terminal companion released');await rpc('terminal_input',{data:"printf 'RETAINED_%s\\n' \"$NIMLO_NEO_PROOF\"\n"});await until(async()=>JSON.stringify(await rpc('terminal_resize',{cols:90,rows:30})).includes('RETAINED_SHARED_TERMINAL'),'same shell');
  await rpc('terminal_stop');
 });
 await check('Sharing, permissions and settings open over the main workspace and close cleanly',async()=>{
  for(const [view,id]of [['settings','settings-dialog'],['sharing','pair-dialog'],['permissions','session-access-dialog']]){
   await command({kind:'companion',view});await until(async()=>{try{return await js(`return document.getElementById(${JSON.stringify(id)})?.open===true;`);}catch{return false;}},view+' dialog');await until(()=>status()?.toolsModal,'modal reaches native workspace');assert.equal(status().toolsWindowNumber,status().windowNumber);await command({kind:'capture',name:'native-'+view});fs.copyFileSync(path.join(control,'native-'+view+'.png'),path.join(out,'native-'+view+'.png'));if(view==='sharing')await command({kind:'key',target:'tools',characters:'\u001b',keyCode:53});else await js(`document.getElementById(${JSON.stringify(id)}).close();return true;`);await until(()=>!status()?.companion,'dialog view released');
  }
  await command({kind:'closeCompanion'});await until(()=>!status()?.companion,'all tools close');
 });
 await check('Native New File creates and selects a nested project file',async()=>{
  await command({kind:'focusEditor'});await menu('newFile:');await until(()=>status()?.sheet,'native new-file dialog');await command({kind:'sheetText',text:'src/new-native-file.txt'});await command({kind:'sheet',title:'Create'});await until(()=>status()?.active==='src/new-native-file.txt'&&!status()?.busy,'new file selected');assert.equal(fs.readFileSync(path.join(root,'src/new-native-file.txt'),'utf8'),'');await open('hello.js');
 });
 await check('App quit cleans up its owned host and Neovim processes',async()=>{
  await browser.close();browser=null;await command({kind:'capture',name:'native-editor'});fs.copyFileSync(path.join(control,'native-editor.png'),path.join(out,'native-editor.png'));
  await command({kind:'quit'});await until(()=>child.exitCode!==null&&!alive(hostPid)&&!alive(nvimPid),'owned shutdown');
 });
 await check('Native pending-copy recovery survives relaunch and preserves the disk version until Save',async()=>{
  for(const file of fs.readdirSync(control))if(/^\d+\.json$/.test(file)||file==='status.json')fs.rmSync(path.join(control,file));
  const pending='Recovered native pending 日本😀\n',disk=fs.readFileSync(path.join(root,'hello.js'),'utf8');
  fs.writeFileSync(path.join(state,'native-pending.json'),JSON.stringify({version:1,workspace:root,path:'hello.js',content:pending,baseRevision:1}),{mode:0o600});
  await start();await until(()=>status()?.sheet,'pending recovery dialog');await command({kind:'sheet',title:'Recover'});await settled(pending);assert.equal(fs.readFileSync(path.join(root,'hello.js'),'utf8'),disk);assert.equal(status().nativePendingFile,false);
  await menu('saveFile:');await until(()=>!status()?.dirty,'save recovered pending');assert.equal(fs.readFileSync(path.join(root,'hello.js'),'utf8'),pending);
 });
 await check('Close Project stops the session and returns to welcome without removing recovery',async()=>{
  const ownedHost=status().hostPid,ownedEngine=status().neovimPid;await menu('closeProject:');await until(()=>status()?.welcome&&!alive(ownedHost)&&!alive(ownedEngine),'close project welcome');assert(!fs.existsSync(path.join(state,'last-project.json')));assert(fs.existsSync(path.join(state,'project-root.json')));await command({kind:'capture',name:'native-welcome'});fs.copyFileSync(path.join(control,'native-welcome.png'),path.join(out,'native-welcome.png'));await command({kind:'quit'});await until(()=>child.exitCode!==null,'welcome quit');
 });
 fs.writeFileSync(path.join(out,'report.json'),JSON.stringify({status:'pass',diagnosticOnly:process.env.NIMLO_UI_ONLY==='1'||!!process.env.NIMLO_CHECK_FILTER,appBundle,checks,realNeovim:true,realNativeWindow:true,pairedBrowser:!!phone,realInferenceRequests:0,disposableWorkspace:true},null,2));
})().catch(error=>{console.error(error.stack);fs.writeFileSync(path.join(out,'report.json'),JSON.stringify({status:'fail',stage,error:error.stack,checks,state:status(),stderr},null,2));process.exitCode=1;}).finally(async()=>{
 await browser?.close();if(child?.exitCode===null)child.kill('SIGTERM');await pause(300);if(child?.exitCode===null)child.kill('SIGKILL');
 for(const pid of [hostPid,nvimPid])if(pid&&alive(pid)){const line=execFileSync('/bin/ps',['-p',String(pid),'-o','command='],{encoding:'utf8'});if(line.includes(appBundle))process.kill(pid,'SIGTERM');}
 await pause(300);fs.rmSync(work,{recursive:true,force:true});
});
