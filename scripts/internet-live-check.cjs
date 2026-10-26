'use strict';
// Explicit live-network check. Uses a disposable project, never the user's workspace.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {spawn,execFileSync}=require('node:child_process');
const WebSocket=require(process.env.NIMLO_WS_MODULE || 'ws');
const binary=path.resolve(process.env.NIMLO_BINARY || 'target/release/nimlo-editor');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'nimlo-internet-live-'));
const checks=[], sockets=[];
const started=Date.now();
let host, browser, publicOrigin, memory;
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn,label,ms=15000){const end=Date.now()+ms;while(Date.now()<end){if(await fn())return;await delay(100);}throw new Error(label);}
function sanitize(text){return String(text).replace(/(?:token=|invite=|Bearer )[a-f0-9]{64}/g,'[private token]').replace(/nimlo_session=[a-f0-9]{64}/g,'nimlo_session=[private]');}
async function connect(origin,cookie,id){
  const ws=new WebSocket(origin.replace(/^http/,'ws')+'/ws?clientId='+id+'&name=InternetTest',{headers:{Cookie:cookie,Origin:origin}});
  const events=[],pending=new Map();let seq=0;
  sockets.push(ws);
  ws.on('message',raw=>{const event=JSON.parse(raw);events.push(event);if(events.length>1000)events.shift();const request=pending.get(event.requestId);if(request){pending.delete(event.requestId);clearTimeout(request.timer);event.type==='error'?request.reject(new Error(event.code+': '+event.message)):request.resolve(event);}});
  await new Promise((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject);});
  await until(()=>events.some(event=>event.type==='bootstrap'),'WebSocket bootstrap missing');
  const bootstrap=events.find(event=>event.type==='bootstrap');
  return {ws,events,bootstrap,command(type,fields={}){const requestId='live-'+(++seq);return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(requestId);reject(new Error('Command timed out: '+type));},15000);pending.set(requestId,{resolve,reject,timer});ws.send(JSON.stringify({type,...fields,generation:bootstrap.generation,requestId}));});}};
}
async function check(name,fn){await fn();checks.push({name,status:'pass'});console.log('PASS '+name);}
async function run(){
  fs.writeFileSync(path.join(root,'hello.txt'),'Internet fixture original\n');
  const fakeBin=path.join(root,'bin');fs.mkdirSync(fakeBin);
  for(const name of ['codex','claude'])fs.writeFileSync(path.join(fakeBin,name),'#!/bin/sh\nexit 1\n',{mode:0o700});
  host=spawn(binary,['--workspace',root,'--state-dir',path.join(root,'.state'),'--listen','127.0.0.1:0'],{env:{...process.env,PATH:fakeBin+path.delimiter+process.env.PATH},stdio:['ignore','pipe','pipe']});
  let output='';host.stdout.on('data',chunk=>{output=(output+chunk).slice(-12000);});host.stderr.on('data',()=>{});
  await until(()=>/http:\/\/127\.0\.0\.1:\d+\/#token=[a-f0-9]{64}/.test(output),'Host launch failed');
  const launch=output.match(/http:\/\/127\.0\.0\.1:\d+\/#token=[a-f0-9]{64}/)[0];output='';
  const localOrigin=new URL(launch).origin,token=new URLSearchParams(new URL(launch).hash.slice(1)).get('token');
  const local=await connect(localOrigin,'nimlo_session='+token,'internet-live-desktop');
  await check('internet connector starts only when requested',async()=>{
    assert.equal(local.bootstrap.internet.status,'off');
    await local.command('internet_start');
    await until(()=>{const internet=local.events.filter(event=>event.internet).at(-1)?.internet;if(internet?.status==='error')throw new Error(internet.error);if(internet?.status==='ready'){publicOrigin=internet.url;return true;}return false;},'Public tunnel did not become ready',55000);
    assert.match(publicOrigin,/^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/);
  });
  await check('actual public HTTPS route requires authentication',async()=>{
    let last='No response';
    // Allow new DNS records to propagate before the OS can cache a negative answer.
    await delay(15000);
    try { await until(async()=>{try{const response=await fetch(publicOrigin+'/api/bootstrap',{signal:AbortSignal.timeout(5000)});last='HTTP '+response.status+' '+(await response.text()).slice(0,300);return response.status===401;}catch(error){last=error.message+' '+(error.cause?.message || '');return false;}},'Public HTTPS endpoint unavailable',180000); }
    catch { throw new Error('Public HTTPS endpoint unavailable: '+sanitize(last)); }
    const page=await fetch(publicOrigin,{signal:AbortSignal.timeout(10000)});assert.equal(page.status,200);assert((await page.text()).includes('join-dialog'));
  });
  let phoneCookie, phone;
  await check('one-time pairing over public HTTPS sets a secure session cookie',async()=>{
    const pairing=await local.command('pair_create',{origin:publicOrigin});
    const response=await fetch(publicOrigin+'/api/pair',{method:'POST',headers:{Origin:publicOrigin,'Content-Type':'application/json'},body:JSON.stringify({code:pairing.code,invite:pairing.invite}),signal:AbortSignal.timeout(15000)});
    assert.equal(response.status,200);
    const cookie=response.headers.get('set-cookie');assert.match(cookie,/; Secure/);assert.match(cookie,/HttpOnly/);phoneCookie=cookie.split(';')[0];
  });
  await check('actual WSS session shares full access without local picker privileges',async()=>{
    phone=await connect(publicOrigin,phoneCookie,'internet-live-phone');
    assert.equal(phone.bootstrap.access,'shared');assert.equal(phone.bootstrap.pickerAvailable,false);
    assert.equal(phone.bootstrap.sessionId,local.bootstrap.sessionId);
  });
  await check('public browser joins with the same session cookie',async()=>{
    const {chromium}=require(process.env.PLAYWRIGHT_PATH || 'playwright');
    browser=await chromium.launch({executablePath:process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
    const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
    await context.addCookies([{name:phoneCookie.split('=')[0],value:phoneCookie.split('=')[1],url:publicOrigin,httpOnly:true,secure:true,sameSite:'Strict'}]);
    const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto(publicOrigin);await page.waitForFunction(()=>document.getElementById('app').dataset.connected==='yes'&&!document.getElementById('new-file').disabled);
    assert(await page.locator('#view-only').isHidden());
    await page.click('#files-toggle');await page.click('#pair-phone');
    await page.waitForFunction(()=>/^[0-9]{6}$/.test(document.getElementById('pair-code').textContent));
    const invitationUrl=new URL(await page.locator('#pair-urls a').first().getAttribute('href'));assert.equal(invitationUrl.origin,publicOrigin);assert.match(invitationUrl.hash,/^#invite=[a-f0-9]{64}$/);
    await page.screenshot({path:'tests/internet-phone-pairing.png'});assert.deepEqual(errors,[]);await context.close();
  });
  await check('public device edits and saves the host file',async()=>{
    const opened=await phone.command('open_file',{path:'hello.txt'});
    const edited=await phone.command('edit_file',{path:'hello.txt',baseRevision:opened.file.revision,content:'Saved through internet WSS\n'});
    await phone.command('save_file',{path:'hello.txt',revision:edited.file.revision});
    assert.equal(fs.readFileSync(path.join(root,'hello.txt'),'utf8'),'Saved through internet WSS\n');
    await until(()=>local.events.some(event=>event.file?.content==='Saved through internet WSS\n'),'Desktop did not receive public edit');
  });
  await check('public device runs the real persistent host shell',async()=>{
    await phone.command('terminal_start');
    await phone.command('terminal_input',{data:"printf 'NIMLO_INTERNET_OK\\n' > internet-proof.txt\r"});
    await until(()=>fs.existsSync(path.join(root,'internet-proof.txt')),'Public shell command did not execute');
    assert.equal(fs.readFileSync(path.join(root,'internet-proof.txt'),'utf8'),'NIMLO_INTERNET_OK\n');
  });
  await check('public device reconnects to the same shell and saved file',async()=>{
    phone.ws.close();await delay(300);phone=await connect(publicOrigin,phoneCookie,'internet-live-phone');
    assert.equal(phone.bootstrap.sessionId,local.bootstrap.sessionId);assert.equal(phone.bootstrap.terminal.running,true);
    assert.equal(phone.bootstrap.openFiles.find(file=>file.path==='hello.txt').content,'Saved through internet WSS\n');
  });
  try {
    const rows=execFileSync('ps',['-axo','pid=,ppid=,rss=,comm='],{encoding:'utf8'}).trim().split('\n').map(line=>line.trim().split(/\s+/));
    memory={hostRssKiB:Number(rows.find(row=>Number(row[0])===host.pid)?.[2]),connectorRssKiB:rows.filter(row=>Number(row[1])===host.pid&&row.slice(3).join(' ').includes('cloudflared')).reduce((sum,row)=>sum+Number(row[2]),0),note:'One RSS observation after editing and terminal use; excludes browser and shell. Not a benchmark or peak.'};
  }catch{}
  await check('turning internet access off preserves local access and the shell',async()=>{
    await local.command('internet_stop');
    await until(()=>phone.ws.readyState===WebSocket.CLOSED,'Public socket did not close after stop');
    const response=await fetch(localOrigin+'/api/bootstrap',{headers:{Authorization:'Bearer '+token},signal:AbortSignal.timeout(5000)});
    const snapshot=await response.json();assert.equal(snapshot.internet.status,'off');assert.equal(snapshot.terminal.running,true);
  });
}
(async()=>{
  let failure;
  try{await run();}catch(error){failure=sanitize(error.stack||error);console.error(failure);}
  finally{
    for(const socket of sockets)socket.terminate();
    if(browser)await browser.close();
    if(host&&host.exitCode===null){host.kill('SIGINT');await Promise.race([new Promise(resolve=>host.once('exit',resolve)),delay(5000)]);if(host.exitCode===null)host.kill('SIGKILL');}
    fs.mkdirSync('tests',{recursive:true});
    fs.writeFileSync('tests/internet-live.json',JSON.stringify({status:failure?'fail':'pass',date:new Date().toISOString(),binarySha256:crypto.createHash('sha256').update(fs.readFileSync(binary)).digest('hex'),liveNetwork:true,temporaryFixture:true,mobileDataTested:false,elapsedMilliseconds:Date.now()-started,checks,memory,...(failure?{failure}:{})},null,2)+'\n');
    fs.rmSync(root,{recursive:true,force:true});
  }
  process.exitCode=failure?1:0;
})();
