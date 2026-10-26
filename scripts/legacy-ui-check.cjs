#!/usr/bin/env node
'use strict';
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto'),{spawn}=require('node:child_process');
const {chromium}=require(process.env.PLAYWRIGHT_PATH||path.resolve(__dirname,'../../mini_gym/node_modules/playwright'));
const repo=path.resolve(__dirname,'..'),baseline=path.join(repo,'target/performance-baseline-a811aaf'),binary=path.join(baseline,'Nimlo.app/Contents/Resources/nimlo-editor');
let browser,host,fixture;const secrets=[];const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
(async()=>{
 const manifest=JSON.parse(fs.readFileSync(path.join(baseline,'manifest.json')));
 assert.equal(crypto.createHash('sha256').update(fs.readFileSync(binary)).digest('hex'),manifest.files['Contents/Resources/nimlo-editor'].sha256,'Frozen reference host changed');
 fixture=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'nimlo-legacy-ui-')));const project=path.join(fixture,'project'),bin=path.join(fixture,'bin');fs.mkdirSync(project);fs.mkdirSync(bin);
 fs.writeFileSync(path.join(project,'main.js'),'const original = "fixture";\n');
 for(const name of ['codex','claude'])fs.writeFileSync(path.join(bin,name),'#!/bin/sh\necho "Logged in using subscription"\n',{mode:0o700});
 host=spawn(binary,['--workspace',project,'--state-dir',path.join(fixture,'state'),'--listen','127.0.0.1:0','--dev-assets',path.join(repo,'web')],{cwd:repo,env:{...process.env,PATH:bin+':/usr/bin:/bin:/usr/sbin:/sbin',SHELL:'/bin/sh',ENV:'',BASH_ENV:''},stdio:['ignore','pipe','pipe']});
 const url=await new Promise((resolve,reject)=>{let buffer='';const timer=setTimeout(()=>reject(Error('Legacy fixture launch timeout')),15000);host.stdout.on('data',chunk=>{buffer+=chunk;const match=buffer.match(/http:\/\/[^\s]+\/#token=([a-f0-9]{64})/);if(match){clearTimeout(timer);secrets.push(match[1]);resolve(match[0]);buffer='';}});host.on('error',reject);host.once('exit',()=>reject(Error('Legacy fixture exited')));host.stderr.on('data',()=>{});});
 const origin=new URL(url).origin;assert(![8742,8765,8767].includes(+new URL(origin).port));assert.equal((await fetch(origin+'/editor.js')).status,404,'Reference must genuinely lack the new asset route');
 browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});const page=await browser.newPage({viewport:{width:1280,height:800}}),errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.addInitScript(()=>{const Native=WebSocket;window.__legacySent=[];window.WebSocket=class extends Native{send(raw){window.__legacySent.push(JSON.parse(raw).type);super.send(raw);}};});
 await page.goto(url);await page.waitForFunction(()=>document.getElementById('app').dataset.connected==='yes');
 assert.equal(await page.evaluate(()=>nimloEditor.constructor.name),'NimloNativeEditor');
 await page.keyboard.press('Meta+p');await page.fill('#command-input','main.js');await page.keyboard.press('Enter');await page.waitForFunction(()=>document.getElementById('code-input').value.includes('fixture'));await page.locator('#command-dialog').waitFor({state:'hidden'});assert.equal(await page.locator('#code-input').evaluate(input=>input.readOnly),false);
 await page.locator('#code-input').focus();await page.keyboard.press('Meta+End');await page.keyboard.insertText('日本🚀');const text=await page.inputValue('#code-input');assert(text.includes('日本🚀'),'Native fallback input did not receive typed text');await page.click('#save-button');
 for(let i=0;i<100&&fs.readFileSync(path.join(project,'main.js'),'utf8')!==text;i++)await pause(50);
 assert.equal(fs.readFileSync(path.join(project,'main.js'),'utf8'),text);
 const sent=await page.evaluate(()=>window.__legacySent);assert(sent.includes('edit_file'));assert(!sent.includes('patch_file'),'Older host must use negotiated legacy writes');assert.deepEqual(errors,[]);
 await browser.close();browser=null;host.kill('SIGTERM');await new Promise(resolve=>host.once('exit',resolve));
 const report={status:'pass',checks:['Frozen old dev host genuinely returns404 for new editor asset','Reloaded current UI initializes a native adapter rather than failing','Keyboard file navigation and Unicode saving preserve exact text','Capability fallback sends only legacy full-file writes','No page exceptions and owned host/browser exited'],referenceHostSha256:manifest.files['Contents/Resources/nimlo-editor'].sha256,frontendSha256:crypto.createHash('sha256').update(fs.readFileSync(path.join(repo,'web/app.js'))).digest('hex'),fixtureOnly:true,realInferenceRequests:0};fs.mkdirSync(path.join(repo,'tests'),{recursive:true});fs.writeFileSync(path.join(repo,'tests/legacy-ui-check.json'),JSON.stringify(report,null,2)+'\n');console.log('PASS legacy live-asset compatibility: '+report.checks.length+' checks');
})().catch(error=>{let message=String(error.stack||error);for(const secret of secrets)message=message.split(secret).join('[private]');console.error(message);process.exitCode=1;}).finally(async()=>{if(browser)await browser.close();if(host&&host.exitCode===null){host.kill('SIGTERM');for(let i=0;i<50&&host.exitCode===null;i++)await pause(20);if(host.exitCode===null)host.kill('SIGKILL');}if(fixture)fs.rmSync(fixture,{recursive:true,force:true});});
