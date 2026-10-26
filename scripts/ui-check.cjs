#!/usr/bin/env node
'use strict';
const patchFixture=require('./patch-fixture.cjs');
const actions=require('./ui-actions.cjs');

// Embedded-release UI regression. All files, shells and provider jobs use a
// disposable fixture; the provider is a local fake CLI and makes no inference.
// Optional: NIMLO_BINARY, PLAYWRIGHT_PATH, CHROME_PATH, NIMLO_BROWSER=webkit.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const playwright = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const browserEngine=process.env.NIMLO_BROWSER || 'chromium';
if(!['chromium','webkit'].includes(browserEngine)) throw new Error('NIMLO_BROWSER must be chromium or webkit');
const repo = path.resolve(__dirname, '..');
const binary = path.resolve(repo, process.env.NIMLO_BINARY || 'target/release/nimlo-editor');
const artifacts = path.join(repo, 'tests');
const reportName=browserEngine==='webkit' ? 'ui-webkit.json' : 'ui.json';
const binarySha256 = crypto.createHash('sha256').update(fs.readFileSync(binary)).digest('hex');
const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nimlo-ui-')));
const workspace = path.join(fixture, 'workspace');
const bin = path.join(fixture, 'bin');
const filename = 'workspace-session-controller.js';
const checks = [], screenshots = [], layouts = [], errors = [], exploratoryFindings = [];
const expectedDisconnects = new WeakMap(), expectedNetworkEvents = [];
let host, browser, pc, phone, stage = 'startup';
fs.mkdirSync(workspace); fs.mkdirSync(bin); fs.mkdirSync(artifacts, { recursive: true });
const code = [
  '// One project, shared across desktop and phone.',
  'const MAX_RECENT_FILES = 12;',
  'const devices = new Map();',
  '',
  'export class WorkspaceSession {',
  '  constructor(root, storage) {',
  '    this.root = root;',
  '    this.storage = storage;',
  '    this.documents = new Map();',
  '    this.activePath = null;',
  '    this.terminalViewportOwner = null;',
  '    this.generation = 1;',
  '  }',
  '',
  '  async open(path) {',
  '    const content = await this.storage.read(path);',
  '    const document = { path, content, revision: 1 };',
  '    this.documents.set(path, document);',
  '    this.activePath = path;',
  '    return document;',
  '  }',
  '',
  '  update(path, content, baseRevision) {',
  '    const document = this.documents.get(path);',
  '    if (document.revision !== baseRevision) {',
  '      throw new Error("Review the latest edits first");',
  '    }',
  '    document.content = content;',
  '    document.revision += 1;',
  '    document.dirty = true;',
  '    return document;',
  '  }',
  '',
  '  async save(path) {',
  '    const document = this.documents.get(path);',
  '    await this.storage.write(path, document.content);',
  '    document.dirty = false;',
  '  }',
  '',
  '  focusTerminal(device) {',
  '    this.terminalViewportOwner = device;',
  '    return { device, generation: this.generation };',
  '  }',
  '}',
  '',
  'export function recentFiles(session) {',
  '  return [...session.documents.values()]',
  '    .slice(-MAX_RECENT_FILES)',
  '    .map(document => document.path);',
  '}',
  '',
  'export function connectedDevices() {',
  '  return [...devices.values()]',
  '    .filter(device => device.connected)',
  '    .map(device => device.name);',
  '}',
  '',
  '// Keep the last line reachable with both panels open.',
  'export const ready = true;',
  '',
].join('\n');
fs.writeFileSync(path.join(workspace, filename), code);
fs.writeFileSync(path.join(workspace, 'README.md'), '# Workspace session\n\nA small editor across devices.\n');
fs.mkdirSync(path.join(workspace, 'src'));
fs.mkdirSync(path.join(workspace, 'src', 'client'));
fs.mkdirSync(path.join(workspace, 'src', 'server'));
fs.mkdirSync(path.join(workspace, 'many-files'));
fs.writeFileSync(path.join(workspace, 'src', 'client', 'config.js'), 'export const side = "client";\n');
fs.writeFileSync(path.join(workspace, 'src', 'server', 'config.js'), 'export const side = "server";\n');
const touchCode = '// Touch editing fixture\nfunction greet() {\n  return "hello";\n}\n';
fs.writeFileSync(path.join(workspace, 'src', 'editor.js'), touchCode);
for (let i = 0; i < 120; i++) fs.writeFileSync(path.join(workspace, 'many-files', 'module-' + String(i).padStart(3, '0') + '.js'), 'export const value = ' + i + ';\n');
fs.writeFileSync(path.join(bin, 'codex'), String.raw`#!/usr/bin/env node
const readline = require('node:readline');
if (process.argv[2] === 'login') { console.log('Logged in using ChatGPT'); process.exit(0); }
const send = value => console.log(JSON.stringify(value));
readline.createInterface({input:process.stdin}).on('line', line => {
 const frame = JSON.parse(line);
 if (frame.method === 'initialize') send({id:frame.id,result:{userAgent:'ui-fixture'}});
 else if (frame.method === 'thread/start' || frame.method === 'thread/resume') send({id:frame.id,result:{thread:{id:'ui-fixture-thread'}}});
 else if (frame.method === 'turn/start') {
  send({id:frame.id,result:{turn:{id:'ui-fixture-turn'}}});
  send({method:'item/completed',params:{item:{id:'reply',type:'agentMessage',text:'Keep the workspace as one shared session. The generation check protects edits after a project switch.\n\nA small improvement: move the recent-file limit into the session constructor so each workspace can choose its own history size.'}}});
  send({method:'turn/completed',params:{turn:{id:'ui-fixture-turn',status:'completed',error:null}}});
 }
});
`);
fs.chmodSync(path.join(bin, 'codex'), 0o700);

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function startHost() {
  host = spawn(binary, ['--workspace', workspace, '--state-dir', path.join(fixture, 'state'), '--listen', '0.0.0.0:0'], {
    env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    let output = '', stderr = '';
    const timer = setTimeout(() => reject(new Error('Host startup timeout: ' + stderr)), 20000);
    host.stdout.on('data', chunk => { output += chunk; const match = output.match(/http:\/\/[^\s]+\/#token=[a-f0-9]{64}/); if (match) { clearTimeout(timer); resolve(match[0]); } });
    host.stderr.on('data', chunk => { stderr += chunk; });
    host.on('error', reject);
    host.on('exit', code => { clearTimeout(timer); reject(new Error('Host exit ' + code + ': ' + stderr)); });
  });
}
async function installCapture(context) {
  await patchFixture.install(context);
  await context.addInitScript(() => {
    const Original = window.WebSocket;
    window.__sockets = []; window.__sent = []; window.__events = []; window.__generation = 0;
    window.WebSocket = class extends Original {
      constructor(...args) {
        super(...args); window.__sockets.push(this);
        this.addEventListener('message', event => {
          const value = window.__patchFixture.observe(JSON.parse(event.data)); window.__events.push(value);
          if (value.generation !== undefined) window.__generation = value.generation;
          if (value.type === 'bootstrap') window.__bootstrap = value;
          if (value.terminal) window.__terminal = value.terminal;
          if (value.ai) window.__ai = value.ai;
        });
      }
      send(value) { window.__sent.push(JSON.parse(value)); super.send(value); }
    };
    let count = 0;
    window.__command = (type, fields = {}, mutate = false) => new Promise((resolve, reject) => {
      const socket = window.__sockets.at(-1), requestId = 'ui-' + (++count);
      const timer = setTimeout(() => { socket.removeEventListener('message', listener); reject(new Error('Command timeout: ' + type)); }, 10000);
      const listener = event => {
        const value = JSON.parse(event.data);
        if (value.requestId === requestId) { clearTimeout(timer); socket.removeEventListener('message', listener); resolve(value); }
      };
      socket.addEventListener('message', listener);
      socket.send(JSON.stringify({ type, ...fields, requestId, ...(mutate ? { generation: window.__generation } : {}) }));
    });
  });
}
const command = (page, type, fields = {}, mutate = false) => page.evaluate(([t, f, m]) => window.__command(t, f, m), [type, fields, mutate]);
function observe(page) {
  page.setDefaultTimeout(12000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (message.type() !== 'error' || message.text().includes('401')) return;
    const deliberatelyClosedSocket = expectedDisconnects.get(page);
    if (deliberatelyClosedSocket && message.text().includes(deliberatelyClosedSocket) && /WebSocket connection .+ failed: The network connection was lost/.test(message.text())) {
      expectedNetworkEvents.push('Browser reported the deliberately closed reconnect-test socket'); return;
    }
    errors.push(message.text());
  });
}
async function check(name, work) { stage = name; await work(); checks.push(name); console.log('PASS ' + name); }
async function screenshot(page, name) {
  await page.bringToFront(); await page.waitForTimeout(150);
  const file = 'floating-' + (browserEngine==='webkit' ? 'webkit-' : '') + name + '.png'; await page.screenshot({ path: path.join(artifacts, file) }); screenshots.push(file);
}
async function menu(page,section='files'){return actions.menu(page,section);}
async function folder(page,directory){const node=page.locator('#file-tree .tree-entry[data-kind=directory][data-path="'+directory+'"]');if(await node.getAttribute('aria-expanded')==='true')await node.click();await node.click();await page.waitForFunction(value=>document.getElementById('directory-label').textContent===value,directory);}
async function ai(page){return actions.ai(page);}
async function closeMenu(page){return actions.closeMenu(page);}
// Host administration is exercised at a compact viewport with its actual host
// credential. The paired phone keeps its restricted role throughout this suite.
async function compactHost(work) {
  const viewport=pc.viewportSize();
  await closeMenu(pc); await pc.setViewportSize({width:390,height:844});
  try { await work(pc); } finally { await pc.keyboard.press('Escape'); await closeMenu(pc); await pc.setViewportSize(viewport); }
}
async function keyboardViewport(page, enabled) {
  await page.evaluate(enabled=>{
    if(enabled) {
      window.__viewportOwn={height:Object.getOwnPropertyDescriptor(visualViewport,'height'),offsetTop:Object.getOwnPropertyDescriptor(visualViewport,'offsetTop')};
      Object.defineProperty(visualViewport,'height',{configurable:true,get:()=>360});
      Object.defineProperty(visualViewport,'offsetTop',{configurable:true,get:()=>36});
    } else {
      for(const key of ['height','offsetTop']){const descriptor=window.__viewportOwn[key];if(descriptor)Object.defineProperty(visualViewport,key,descriptor);else delete visualViewport[key];}
      delete window.__viewportOwn;
    }
    visualViewport.dispatchEvent(new Event('resize')); visualViewport.dispatchEvent(new Event('scroll'));
  },enabled);
}
async function expectFocus(page, id) { await page.waitForFunction(target => document.activeElement.id === target, id); }
async function measure(page, name) {
  const result = await page.evaluate(() => {
    const bounds = element => { const r = element.getBoundingClientRect(); return { left:r.left, right:r.right, top:r.top, bottom:r.bottom, width:r.width, height:r.height }; };
    const visible = element => !!(element.offsetWidth || element.offsetHeight || element.getClientRects().length) && getComputedStyle(element).visibility !== 'hidden';
    const ids = ['projects-toggle','files-toggle','save-button','terminal-shortcut-toggle','ai-toggle','view-only','connection-state','code-input','codebox','ai-panel','terminal-panel'];
    const rectangles = Object.fromEntries(ids.map(id => { const el = id === 'codebox' ? document.querySelector('.codebox') : document.getElementById(id); return [id, visible(el) ? bounds(el) : null]; }));
    return { viewport:{width:innerWidth,height:innerHeight}, documentWidth:document.documentElement.scrollWidth, rectangles,
      codeGeometry:['code-input','highlight','line-numbers'].map(id=>{const el=document.getElementById(id),style=getComputedStyle(el);return {id,...bounds(el),clientWidth:el.clientWidth,clientHeight:el.clientHeight,scrollTop:el.scrollTop,scrollHeight:el.scrollHeight,lines:el.value?el.value.split('\n').length:el.textContent.split('\n').length,renderedTail:el.textContent.slice(-180),fontSize:style.fontSize,lineHeight:style.lineHeight,overflow:style.overflow,transform:style.transform,hidden:document.hidden,parentChain:[el.parentElement,el.parentElement.parentElement].map(parent=>({className:parent.className,...bounds(parent),overflow:getComputedStyle(parent).overflow}))};}),
      controls:[...document.querySelectorAll('button,select,input,textarea')].filter(visible).filter(el => el.id !== 'code-input' && el.id !== 'terminal-command').map(el => ({id:el.id || el.getAttribute('aria-label') || el.textContent.trim(), ...bounds(el)})),
      terminal:window.__terminal ? {cols:window.__terminal.cols,rows:window.__terminal.rows,running:window.__terminal.running} : null };
  });
  result.name = name; layouts.push(result);
  assert(result.documentWidth <= result.viewport.width, name + ' document overflows viewport');
  for (const id of ['projects-toggle','files-toggle','save-button','terminal-shortcut-toggle','ai-toggle','view-only','connection-state']) {
    const r = result.rectangles[id]; if (!r || !r.width) continue;
    assert(r.left >= -0.5 && r.right <= result.viewport.width + 0.5, name + ' HUD control outside viewport: ' + id);
  }
  return result;
}
async function assertMobileTargets(page, name) {
  const layout = await measure(page, name);
  const misses = layout.controls.filter(r => r.height < 43.9 || ((r.id !== 'prompt') && r.width < 43.9));
  if(misses.length&&process.env.NIMLO_UI_EXPLORE==='1'){exploratoryFindings.push({name,misses});console.log('FINDING '+name+' '+JSON.stringify(misses));return;}
  assert.deepEqual(misses, [], name + ' has touch targets smaller than 44px');
}
async function waitResize(page) {
  await page.waitForFunction(() => {
    const wrap = document.getElementById('terminal-screen-wrap'), style = getComputedStyle(wrap), screen = getComputedStyle(document.getElementById('terminal-screen'));
    const canvas = document.createElement('canvas'), context = canvas.getContext('2d'); context.font = screen.fontSize + ' ' + screen.fontFamily;
    const cols = Math.max(20,Math.min(200,Math.floor((wrap.clientWidth-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight))/context.measureText('M').width)));
    const rows = Math.max(5,Math.min(80,Math.floor((wrap.clientHeight-parseFloat(style.paddingTop)-parseFloat(style.paddingBottom))/parseFloat(screen.lineHeight))));
    return window.__terminal?.cols === cols && window.__terminal?.rows === rows;
  });
}
async function terminalProof(page, name) {
  const pidFile='ui-pid-'+name, proofFile='ui-proof-'+name;
  const result = await command(page, 'terminal_input', { data: `printf '%s\\n' "$$" > ${pidFile}; printf '${name}\\n' > ${proofFile}; cat ${proofFile}\r` }, true);
  assert.notEqual(result.type, 'error');
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (fs.existsSync(path.join(workspace,proofFile)) && fs.readFileSync(path.join(workspace,proofFile),'utf8') === name + '\n' && fs.existsSync(path.join(workspace,pidFile)) && /^\d+\n$/.test(fs.readFileSync(path.join(workspace,pidFile),'utf8'))) break;
    await sleep(30);
  }
  assert.equal(fs.readFileSync(path.join(workspace,proofFile),'utf8'), name + '\n');
  await page.waitForFunction(text => document.getElementById('terminal-screen').textContent.includes(text), name);
  const pid=fs.readFileSync(path.join(workspace,pidFile),'utf8').trim(); assert(/^\d+$/.test(pid),'Real shell PID proof is missing'); return pid;
}
async function scrollEndClear(page) {
  await page.locator('#code-input').focus(); await page.keyboard.press('Control+End');
  if (await page.evaluate(() => document.getElementById('code-input').selectionStart !== document.getElementById('code-input').value.length)) await page.keyboard.press('Meta+ArrowDown');
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  const metrics = await page.evaluate(() => {
    const el = document.getElementById('code-input'), style = getComputedStyle(el), rect = el.getBoundingClientRect(), box = document.querySelector('.codebox').getBoundingClientRect();
    const line = el.value.slice(0,el.selectionStart).split('\n').length - 1;
    const caretTop = rect.top + parseFloat(style.paddingTop) + line * parseFloat(style.lineHeight) - el.scrollTop;
    return { caretAtEnd:el.selectionStart===el.value.length, caretTop, caretBottom:caretTop+parseFloat(style.lineHeight), boxBottom:box.bottom, inputBottom:rect.bottom, scrollTop:el.scrollTop, scrollHeight:el.scrollHeight, clientHeight:el.clientHeight };
  });
  assert(metrics.caretAtEnd, 'Document-end shortcut did not reach end');
  assert(metrics.caretBottom <= metrics.inputBottom + 1, 'End-of-document caret is clipped');
  assert(metrics.scrollTop > 0, 'Representative fixture did not exercise scrolling');
  return metrics;
}

(async () => {
  const url = await startHost();
  browser = await playwright[browserEngine].launch({ ...(browserEngine==='chromium' ? {executablePath:process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'} : {}), headless:true });
  const pcContext = await browser.newContext({ viewport:{width:1280,height:800} });
  const phoneContext = await browser.newContext({ viewport:{width:390,height:844}, isMobile:true, hasTouch:true });
  if (process.env.NIMLO_USE_SOURCE_CSS === '1') {
    for (const context of [pcContext,phoneContext]) await context.route('**/*',async route => {
      const pathname=new URL(route.request().url()).pathname;
      const file=pathname==='/style.css'?'web/style.css':(process.env.NIMLO_USE_SOURCE_JS==='1'&&['/app.js','/editor.js'].includes(pathname)?'web'+pathname:null);
      if(!file)return route.continue();
      const response=await route.fetch(); await route.fulfill({response,body:fs.readFileSync(path.join(repo,file))});
    });
  }
  await installCapture(pcContext); await installCapture(phoneContext);
  pc = await pcContext.newPage(); phone = await phoneContext.newPage(); observe(pc); observe(phone);
  await pc.goto(url); await pc.waitForFunction(() => document.getElementById('app').dataset.controller === 'yes');
  for(const [route,file] of [['/editor.js','editor.js'],['/app.js','app.js'],['/style.css','style.css'],['/','index.html']]) {
    const response=await pc.request.get(new URL(route,url).toString());
    assert.equal(await response.text(),fs.readFileSync(path.join(repo,'web',file),'utf8'),'Embedded browser asset differs from final source: '+file);
  }
  await menu(pc); await pc.locator('#file-tree button').filter({hasText:filename}).click();
  await pc.waitForFunction(text => document.getElementById('code-input').value === text, code);
  await pc.bringToFront();
  await check('Desktop code uses matching 14px/23px overlay geometry', async () => {
    await pc.waitForFunction(() => document.getElementById('highlight').textContent.includes('WorkspaceSession'));
    const geometry = await pc.evaluate(() => ['code-input','highlight'].map(id => { const el=document.getElementById(id),s=getComputedStyle(el),r=el.getBoundingClientRect(); return {id,font:s.fontSize,line:s.lineHeight,padding:s.padding,left:r.left,top:r.top,width:r.width}; }));
    assert.equal(geometry[0].font,'14px'); assert.equal(geometry[0].line,'23px');
    for (const key of ['font','line','padding','left','top','width']) assert.equal(geometry[0][key],geometry[1][key], 'Overlay mismatch: '+key);
    await measure(pc,'desktop-code'); await screenshot(pc,'desktop-code');
  });
  await check('Keyboard opens the native menu and Escape restores the trigger', async () => {
    await pc.locator('#files-toggle').focus(); await pc.keyboard.press('ArrowDown'); await expectFocus(pc,'file-filter');
    assert(!/\b(Controlling|Viewing|Hand off)\b/.test(await pc.locator('#files-menu').innerText()));
    await screenshot(pc,'desktop-menu'); await pc.keyboard.press('Escape'); await expectFocus(pc,'files-toggle'); assert(await pc.locator('#files-menu').isHidden());
  });
  await check('Real fake-provider response renders in the floating AI surface', async () => {
    await actions.ai(pc); await expectFocus(pc,'prompt'); await pc.fill('#prompt','Review the shared session and suggest one small improvement.'); await pc.click('#ai-send');
    await pc.waitForFunction(() => window.__ai?.status === 'complete'); await pc.waitForFunction(() => document.getElementById('messages').textContent.includes('generation check'));
    if (process.env.NIMLO_USE_SOURCE_CSS !== '1') {
      const user=await pc.locator('.message').filter({has:pc.locator('.byline').filter({hasText:'You'})}).locator('.ai-message-text').textContent();
      assert.equal(user,'Review the shared session and suggest one small improvement.','AI transcript leaked internal file-context instructions');
    }
    await measure(pc,'desktop-ai'); await screenshot(pc,'desktop-ai');
  });
  await check('AI close and Escape restore editor focus', async () => {
    await actions.closeAi(pc); await expectFocus(pc,'code-input'); await actions.ai(pc); await pc.keyboard.press('Escape'); await expectFocus(pc,'code-input');
    assert.equal(await pc.locator('#app').getAttribute('data-view'),'code');
  });
  let shellPid;
  await check('HUD terminal toggles retain the same real PTY', async () => {
    await pc.click('#terminal-shortcut-toggle'); await pc.waitForFunction(() => window.__terminal?.running); await waitResize(pc);
    shellPid = await terminalProof(pc,'DESKTOP_PTY'); await measure(pc,'desktop-terminal'); await screenshot(pc,'desktop-terminal');
    await pc.click('#terminal-shortcut-toggle'); assert(await pc.locator('#terminal-panel').isHidden());
    await pc.click('#terminal-shortcut-toggle'); await waitResize(pc); assert.equal(await terminalProof(pc,'SAME_DESKTOP_PTY'),shellPid);
  });
  await check('Both desktop panels stay separate and resize the terminal to its visible width', async () => {
    const before = await pc.evaluate(() => window.__terminal.cols); await actions.ai(pc); await waitResize(pc);
    const layout = await measure(pc,'desktop-both'), ai=layout.rectangles['ai-panel'],terminal=layout.rectangles['terminal-panel'],editor=layout.rectangles.codebox;
    assert(terminal.right <= ai.left-1, 'AI overlaps terminal'); assert(editor.right <= ai.left, 'AI overlaps code'); assert(editor.bottom <= terminal.top-1, 'Terminal overlaps editor');
    const surfaces=await pc.evaluate(()=>['ai-panel','terminal-panel'].map(id=>{const s=getComputedStyle(document.getElementById(id));return {radius:parseFloat(s.borderRadius),shadow:s.boxShadow,background:s.backgroundColor,border:s.borderColor,borderWidth:parseFloat(s.borderTopWidth)};}));
    assert(surfaces[0].radius>=8&&surfaces[0].shadow!=='none'&&surfaces[0].borderWidth>=1,'AI has no rounded floating surface');
    assert.deepEqual(surfaces[0],surfaces[1],'AI and terminal surfaces are inconsistent');
    assert(ai.left-editor.right>=10&&ai.left-terminal.right>=10,'Floating surfaces have no breathing room');
    assert(await pc.evaluate(old => window.__terminal.cols < old, before));
    await pc.locator('#terminal-screen').focus(); await pc.keyboard.press('Escape');
    assert.equal(await pc.locator('#app').getAttribute('data-view'),'ai');
    assert.equal(await pc.locator('#app').getAttribute('data-terminal'),'open');
    assert(await pc.evaluate(()=>window.__sent.some(x=>x.type==='terminal_input'&&x.data==='\x1b')),'Raw PTY Escape was not delivered');
    // A real zsh line editor treats standalone Escape as a pending Meta prefix.
    // Clear that input state before the later phone command proof.
    await command(pc,'terminal_input',{data:'\x03'},true); await pc.waitForTimeout(100);
    await scrollEndClear(pc); await screenshot(pc,'desktop-both');
    await pc.click('#close-terminal'); await actions.closeAi(pc);
  });
  await check('Native dialogs isolate workspace keyboard shortcuts', async () => {
    await menu(pc,'session'); await actions.aiOptions(pc);await pc.click('#settings-open'); await pc.waitForFunction(() => !document.getElementById('settings-model').disabled);
    const sent = await pc.evaluate(() => window.__sent.filter(x=>['terminal_start','terminal_resize','save_file'].includes(x.type)).length);
    await pc.keyboard.press('Control+Backquote'); await pc.keyboard.press('Control+s');
    assert.equal(await pc.locator('#app').getAttribute('data-terminal'),'closed');
    assert.equal(await pc.evaluate(() => window.__sent.filter(x=>['terminal_start','terminal_resize','save_file'].includes(x.type)).length),sent);
    await screenshot(pc,'desktop-settings'); await pc.keyboard.press('Escape'); assert(!await pc.locator('#settings-dialog').evaluate(el=>el.open));
  });
  await check('Pairing defaults to internet without exposing a LAN or loopback address', async () => {
    await menu(pc,'session'); await pc.click('#pair-phone'); await pc.locator('#pair-dialog').waitFor({state:'visible'});
    assert.equal(await pc.locator('#internet-start').textContent(),'Create internet link');
    assert(await pc.locator('#internet-start').isEnabled()); assert(await pc.locator('#internet-start').isVisible());
    assert.equal(await pc.locator('#pair-local').textContent(),'Use same Wi-Fi');
    assert.equal(await pc.locator('#pair-urls a').count(),0); assert(await pc.locator('#pair-code').isHidden());
    assert(!await pc.evaluate(()=>window.__sent.some(x=>x.type==='internet_start')));
    await screenshot(pc,'desktop-pair-internet');
  });
  await pc.click('#pair-local'); await pc.waitForFunction(()=>/^[0-9]{6}$/.test(document.getElementById('pair-code').textContent));
  const localPairUrl=await pc.locator('#pair-urls a').first().getAttribute('href');
  assert(!['localhost','0.0.0.0','[::1]','[::]'].includes(new URL(localPairUrl).hostname)&&!/^127\./.test(new URL(localPairUrl).hostname),'Local pairing advertised a loopback address');
  await phone.goto(localPairUrl); await phone.locator('#join-dialog').waitFor({state:'visible'});
  await phone.fill('#join-code',await pc.locator('#pair-code').textContent()); await phone.click('#join-submit');
  await phone.waitForFunction(() => !!window.__bootstrap?.activePath); await pc.click('[data-close="pair-dialog"]');
  await phone.waitForFunction(() => document.getElementById('app').dataset.controller==='yes'&&!document.getElementById('code-input').readOnly);
  await check('Pairing immediately exposes editing on both devices without a handoff', async () => {
    for(const page of [pc,phone]) {
      assert.equal(await page.locator('#code-input').getAttribute('readonly'),null);
      assert(await page.locator('#view-only').isHidden());
      assert(await page.locator('#take-control').isHidden());
      assert(await page.locator('#request-control').isHidden());
      assert.equal(await page.locator('.device button').filter({hasText:'Hand off'}).count(),0);
    }
  });
  await phone.bringToFront();
  await check('Phone source keeps indentation, aligned syntax colors and bounded visible lines', async () => {
    await phone.waitForFunction(()=>document.querySelector('#highlight .keyword'));
    const geometry=await phone.evaluate(()=>{
      const input=document.getElementById('code-input'),highlight=document.getElementById('highlight');
      const properties=element=>{const s=getComputedStyle(element),r=element.getBoundingClientRect();return {font:s.fontSize,line:s.lineHeight,padding:s.padding,left:r.left,top:r.top,width:r.width,whiteSpace:s.whiteSpace};};
      return {input:properties(input),highlight:properties(highlight),rendered:highlight.textContent.split('\n').length,total:input.value.split('\n').length,rows:input.clientHeight/parseFloat(getComputedStyle(input).lineHeight),gutter:getComputedStyle(document.getElementById('line-numbers')).display,scrolls:input.scrollWidth>input.clientWidth};
    });
    assert.equal(geometry.input.font,'16px'); assert.equal(geometry.input.whiteSpace,'pre');
    for(const property of ['font','line','padding','left','top','width'])assert.equal(geometry.input[property],geometry.highlight[property],'Phone overlay mismatch: '+property);
    assert(geometry.rendered<=Math.ceil(geometry.rows)+7,'Phone renders offscreen source without a bound');
    assert(geometry.rendered<geometry.total,'Phone fixture did not exercise virtual rendering');
    assert.notEqual(geometry.gutter,'none'); assert(geometry.scrolls,'Long source cannot scroll horizontally');
  });
  await check('Phone destinations preserve selection, scroll and AI drafts without opening a keyboard', async () => {
    const before=await phone.evaluate(()=>{
      const input=document.getElementById('code-input');input.setSelectionRange(150,166);input.scrollTop=300;input.scrollLeft=54;input.dispatchEvent(new Event('scroll'));
      return {start:input.selectionStart,end:input.selectionEnd,top:input.scrollTop,left:input.scrollLeft};
    });
    await phone.click('#mobile-ai'); await phone.fill('#prompt','A draft to finish after checking the code.');
    await phone.click('#mobile-code');
    await phone.waitForFunction(view=>{const el=document.getElementById('code-input');return el.selectionStart===view.start&&el.selectionEnd===view.end&&Math.abs(el.scrollTop-view.top)<1&&Math.abs(el.scrollLeft-view.left)<1;},before);
    await phone.click('#mobile-ai'); assert.equal(await phone.locator('#prompt').inputValue(),'A draft to finish after checking the code.');
    await phone.click('#mobile-ai'); assert.equal(await phone.locator('#app').getAttribute('data-view'),'ai','Active destination toggled away');
    assert(!await phone.locator('#prompt').evaluate(el=>el===document.activeElement));
    assert.equal(await phone.locator('.mobile-dock [aria-current="page"]').count(),1);
    await phone.fill('#prompt',''); await phone.click('#mobile-code');
  });
  await check('Phone Files filters a large directory and exposes root navigation without extra scrolling', async () => {
    await menu(phone);
    await folder(phone,'many-files');
    await phone.waitForFunction(()=>document.getElementById('directory-label').textContent==='many-files');
    await phone.waitForFunction(()=>document.querySelectorAll('#file-tree .tree-entry[data-kind=file][data-path^="many-files/"]').length===120);
    assert.equal(await phone.locator('#file-tree .tree-entry[data-kind=file][data-path^="many-files/"]').count(),120);
    await phone.fill('#file-filter','module-119');
    await phone.waitForFunction(()=>document.querySelectorAll('#file-tree .tree-entry[data-kind=file]').length===1);
    assert.equal(await phone.locator('#file-tree .tree-entry[data-kind=file]').getAttribute('title'),path.join(workspace,'many-files/module-119.js'));
    await assertMobileTargets(phone,'phone-filtered-files'); await screenshot(phone,'phone-filtered-files');
    await phone.locator('#file-filter-clear').tap(); assert.equal(await phone.locator('#file-filter').inputValue(),'');
    await expectFocus(phone,'file-filter');
    await phone.fill('#file-filter','no such file');
    assert.equal(await phone.locator('#file-tree .tree-entry[data-kind=file]').count(),0);
    assert(await phone.locator('#file-tree').textContent(),'Empty results lack explanation');
    await phone.locator('#directory-breadcrumbs [data-directory=""]').click();
    await phone.waitForFunction(()=>document.getElementById('directory-label').textContent==='Files');
    assert.equal(await phone.locator('#file-filter').inputValue(),'','A folder switch retained the previous filter');
    await phone.click('#menu-close');
  });
  await check('Phone filtering leaves an actionable result when the keyboard reduces available space', async () => {
    await menu(phone); await folder(phone,'many-files');
    await phone.waitForFunction(()=>document.getElementById('directory-label').textContent==='many-files');
    await phone.fill('#file-filter','module-119');
    try {
      for(const [width,height] of [[320,300],[390,360]]) {
        await phone.setViewportSize({width,height}); await phone.waitForTimeout(120);
        await screenshot(phone,'phone-filter-keyboard-'+width+'x'+height);
        const layout=await phone.evaluate(()=>{
          const menu=document.getElementById('files-menu').getBoundingClientRect(), row=document.querySelector('#file-tree .tree-entry[data-kind=file]'), filter=document.getElementById('file-filter');
          const r=row.getBoundingClientRect(), f=filter.getBoundingClientRect();
          const receiver=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);
          return {menu:{top:menu.top,bottom:menu.bottom},row:{top:r.top,bottom:r.bottom,height:r.height},filter:{top:f.top,bottom:f.bottom},receivesTouch:receiver===row||row.contains(receiver)};
        });
        assert(layout.filter.top>=layout.menu.top&&layout.filter.bottom<=layout.menu.bottom,'Filtering field is clipped: '+JSON.stringify(layout));
        assert(layout.row.top>=layout.menu.top&&layout.row.bottom<=layout.menu.bottom&&layout.row.height>=44&&layout.receivesTouch,'Matched file cannot be tapped above the keyboard: '+JSON.stringify(layout));
      }
      await phone.locator('#file-tree .tree-entry[data-kind=file]').tap();
      await phone.waitForFunction(()=>document.getElementById('code-input').value==='export const value = 119;\n');
    } finally { await phone.setViewportSize({width:390,height:844}); }
    await menu(phone);
    await phone.locator('.open-file').filter({hasText:filename}).locator('button').first().click();
    await phone.waitForFunction(text=>document.getElementById('code-input').value===text,code);
    await menu(phone); await phone.locator('#directory-breadcrumbs [data-directory=""]').click();
    await phone.waitForFunction(()=>document.getElementById('directory-label').textContent==='Files'); await phone.click('#menu-close');
  });
  await check('Phone reconnect clears a nested-folder filter when browsing returns to the root', async () => {
    await menu(phone); await folder(phone,'many-files');
    await phone.waitForFunction(()=>document.getElementById('directory-label').textContent==='many-files');
    await phone.fill('#file-filter','module-119');
    assert.equal(await phone.locator('#file-tree .tree-entry[data-kind=file]').count(),1);
    const previousBootstraps=await phone.evaluate(()=>window.__events.filter(event=>event.type==='bootstrap').length);
    expectedDisconnects.set(phone,await phone.evaluate(()=>window.__sockets.at(-1).url));
    await phone.evaluate(()=>window.__sockets.at(-1).close());
    await phone.waitForFunction(count=>window.__events.filter(event=>event.type==='bootstrap').length>count&&document.getElementById('app').dataset.connected==='yes'&&document.getElementById('directory-label').textContent==='Files',previousBootstraps);
    expectedDisconnects.delete(phone);
    assert.equal(await phone.locator('#file-filter').inputValue(),'','Reconnect left a subfolder query filtering the project root');
    assert(await phone.locator('#file-tree button').filter({hasText:'many-files'}).isVisible(),'Root files disappeared after reconnect');
    assert(!await phone.locator('#code-input').evaluate(el=>el.readOnly),'Reconnect lost shared editing access');
    await screenshot(phone,'phone-reconnected-files'); await phone.click('#menu-close');
  });
  await check('Phone Files switches retained same-named documents with visible folder context', async () => {
    await menu(phone); await phone.locator('#file-tree button').filter({hasText:'src'}).click();
    await phone.waitForFunction(()=>document.getElementById('directory-label').textContent==='src');
    await phone.locator('#file-tree button').filter({hasText:'client'}).click();
    await phone.waitForFunction(()=>document.getElementById('directory-label').textContent==='src/client');
    await phone.locator('#file-tree .tree-entry[data-kind=file][data-path="src/client/config.js"]').click();
    await phone.waitForFunction(()=>document.getElementById('code-input').value==='export const side = "client";\n');
    await menu(phone); await phone.locator('#directory-breadcrumbs [data-directory="src"]').click();
    await phone.waitForFunction(()=>document.getElementById('directory-label').textContent==='src');
    await phone.locator('#file-tree button').filter({hasText:'server'}).click();
    await phone.waitForFunction(()=>document.getElementById('directory-label').textContent==='src/server');
    await phone.locator('#file-tree .tree-entry[data-kind=file][data-path="src/server/config.js"]').click();
    await phone.waitForFunction(()=>document.getElementById('code-input').value==='export const side = "server";\n');
    await menu(phone);
    assert(await phone.locator('#file-tree').isVisible());
    assert(await phone.locator('#open-files').isVisible());
    const client=phone.locator('.open-file').filter({hasText:'src/client'}), server=phone.locator('.open-file').filter({hasText:'src/server'});
    assert.equal(await client.count(),1); assert.equal(await server.count(),1);
    assert.equal(await phone.locator('.open-file.active').count(),1);
    await assertMobileTargets(phone,'phone-open-files'); await screenshot(phone,'phone-open-files');
    await client.locator('button').first().click();
    await phone.waitForFunction(()=>document.getElementById('code-input').value==='export const side = "client";\n');
    assert(!await phone.locator('#code-input').evaluate(el=>el===document.activeElement),'Retained file selection raised keyboard while navigating');
    await menu(phone);
    await phone.locator('.open-file').filter({hasText:filename}).locator('button').first().click();
    await phone.waitForFunction(text=>document.getElementById('code-input').value===text,code);
  });
  await check('Phone AI identifies its requested file after switching code and keeps the prompt draft', async () => {
    await menu(phone);
    await phone.locator('.open-file').filter({hasText:'src/server'}).locator('button').first().click();
    await phone.click('#mobile-ai');
    assert((await phone.locator('#prompt').getAttribute('placeholder')).includes('config.js'));
    const lastUser=phone.locator('.message').filter({has:phone.locator('.byline').filter({hasText:'You'})}).last();
    assert((await lastUser.locator('.byline').textContent()).includes(filename),'Previous AI conversation was relabeled as the currently selected file');
    await phone.fill('#prompt','A phone draft while I check the host shell.');
    await phone.click('#mobile-terminal');
    await phone.waitForFunction(()=>document.getElementById('terminal-project-label').textContent.includes('workspace'));
    assert(await phone.locator('#projects-toggle').isVisible(),'Persistent project selector is missing from Terminal');
    assert((await phone.locator('#projects-toggle').textContent()).includes('workspace'),'Visible Terminal project scope is wrong');
    assert(/files.*ai.*terminal/i.test(await phone.locator('#projects-toggle').getAttribute('aria-label')),'Persistent selector omits its shared scope');
    assert(/shell/i.test(await phone.locator('#terminal-command').getAttribute('placeholder')));
    await phone.click('#mobile-ai');
    assert.equal(await phone.locator('#prompt').inputValue(),'A phone draft while I check the host shell.');
    await screenshot(phone,'phone-ai-context');
    await phone.fill('#prompt','A two-line draft\nwhile I check the prior response.');
    await phone.setViewportSize({width:320,height:300});
    try {
      await phone.waitForTimeout(120);
      const reading=await phone.locator('#messages').evaluate(el=>{const r=el.getBoundingClientRect(),s=getComputedStyle(el);return {height:r.height,usable:el.clientHeight-parseFloat(s.paddingTop)-parseFloat(s.paddingBottom)};});
      await screenshot(phone,'phone-short-ai-draft');
      assert(reading.usable>=44,'An unsent phone draft hides the conversation: '+JSON.stringify(reading));
      await assertMobileTargets(phone,'phone-short-ai-draft');
    } finally { await phone.setViewportSize({width:390,height:844}); }
    await phone.fill('#prompt','');
    await menu(phone);
    await phone.locator('.open-file').filter({hasText:filename}).locator('button').first().click();
    await phone.waitForFunction(text=>document.getElementById('code-input').value===text,code);
  });
  await check('Phone touch indent, undo, redo and outdent reach the shared host and retain keyboard focus', async () => {
    await menu(phone); await phone.locator('#directory-breadcrumbs [data-directory="src"]').click();
    await phone.waitForFunction(()=>document.getElementById('directory-label').textContent==='src');
    await phone.locator('#file-tree button').filter({hasText:'editor.js'}).click();
    await phone.waitForFunction(text=>document.getElementById('code-input').value===text,touchCode);
    await phone.locator('#code-input').focus(); await phone.locator('#code-input').evaluate(el=>el.setSelectionRange(0,0));
    await phone.locator('[data-edit-action="tab"]').tap();
    await phone.waitForFunction(text=>document.getElementById('code-input').value==='  '+text,touchCode);
    await expectFocus(phone,'code-input');
    await phone.locator('[data-edit-action="undo"]').tap();
    await phone.waitForFunction(text=>document.getElementById('code-input').value===text,touchCode);
    await expectFocus(phone,'code-input');
    await phone.locator('[data-edit-action="redo"]').tap();
    await phone.waitForFunction(text=>document.getElementById('code-input').value==='  '+text,touchCode);
    await phone.locator('#save-button').tap(); await phone.waitForFunction(()=>document.getElementById('save-button').hidden);
    await expectFocus(phone,'code-input');
    assert.equal(fs.readFileSync(path.join(workspace,'src','editor.js'),'utf8'),'  '+touchCode);
    await pc.waitForFunction(text=>document.getElementById('code-input').value==='  '+text,touchCode);
    await phone.locator('#code-input').focus(); await phone.locator('#code-input').evaluate(el=>el.setSelectionRange(0,2));
    await phone.locator('[data-edit-action="outdent"]').tap();
    await phone.waitForFunction(text=>document.getElementById('code-input').value===text,touchCode);
    if(await phone.locator('#save-button').isVisible())await phone.locator('#save-button').tap();
    await phone.waitForFunction(()=>document.getElementById('save-button').hidden);
    assert.equal(fs.readFileSync(path.join(workspace,'src','editor.js'),'utf8'),touchCode);
    await phone.locator('#code-input').focus(); await assertMobileTargets(phone,'phone-editing-tools'); await screenshot(phone,'phone-editing-tools');
    await phone.locator('[data-edit-action="done"]').tap();
    assert(!await phone.locator('#code-input').evaluate(el=>el===document.activeElement));
    assert(await phone.locator('#editor-keys').isHidden());
    await menu(phone);
    await phone.locator('.open-file').filter({hasText:filename}).locator('button').first().click();
    await phone.waitForFunction(text=>document.getElementById('code-input').value===text,code);
    await menu(phone); await phone.locator('#directory-breadcrumbs [data-directory=""]').click();
    await phone.waitForFunction(()=>document.getElementById('directory-label').textContent==='Files'); await phone.click('#menu-close');
  });
  await check('Phone editing actions stay above a short keyboard viewport without covering the final line', async () => {
    await phone.setViewportSize({width:320,height:300}); await phone.click('#mobile-code');
    try {
      await scrollEndClear(phone);
      await assertMobileTargets(phone,'phone-short-editing');
      const controls=await phone.locator('#editor-keys button').evaluateAll(elements=>elements.map(el=>{const r=el.getBoundingClientRect();return {name:el.textContent,left:r.left,right:r.right,top:r.top,bottom:r.bottom};}));
      for(const r of controls)assert(r.left>=0&&r.right<=320&&r.top>=0&&r.bottom<=300,JSON.stringify(r));
      const editor=await phone.locator('#code-input').boundingBox(), tools=await phone.locator('#editor-keys').boundingBox();
      assert(editor.y+editor.height<=tools.y+1,'Editing actions cover source lines');
      await screenshot(phone,'phone-short-editing'); await phone.locator('[data-edit-action="done"]').tap();
    } finally { await phone.setViewportSize({width:390,height:844}); }
  });
  await check('Phone code and menu stay within the viewport with 44px controls', async () => {
    await phone.locator('#code-input').focus();
    // Native caret scrolling must use the focused layout after the editing toolbar opens.
    await phone.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    await phone.keyboard.press('Control+End');
    if(await phone.evaluate(()=>document.getElementById('code-input').selectionStart!==document.getElementById('code-input').value.length))await phone.keyboard.press('Meta+ArrowDown');
    // Check the painted response to native navigation, including the full final line.
    await phone.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    const bottom=await phone.evaluate(()=>{const el=document.getElementById('code-input'),style=getComputedStyle(el),rect=el.getBoundingClientRect(),line=el.value.slice(0,el.selectionStart).split('\n').length-1;return {end:el.selectionStart===el.value.length,selection:el.selectionStart,length:el.value.length,scrollTop:el.scrollTop,scrollHeight:el.scrollHeight,clientHeight:el.clientHeight,remaining:el.scrollHeight-el.scrollTop-el.clientHeight,caretBottom:rect.top+parseFloat(style.paddingTop)+(line+1)*parseFloat(style.lineHeight)-el.scrollTop,inputBottom:rect.bottom};});
    assert(bottom.end&&bottom.remaining<=32,'Phone document end cannot scroll clear: '+JSON.stringify(bottom));
    assert(bottom.caretBottom<=bottom.inputBottom+1,'Phone final caret line is clipped: '+JSON.stringify(bottom));
    await phone.keyboard.press('Control+Home');
    if(await phone.evaluate(()=>document.getElementById('code-input').selectionStart!==0))await phone.keyboard.press('Meta+ArrowUp');
    await phone.locator('#code-input').evaluate(el=>el.blur());
    await assertMobileTargets(phone,'phone-code'); await screenshot(phone,'phone-code');
    await menu(phone); assert(!/\b(Controlling|Viewing|Hand off)\b/.test(await phone.locator('#files-menu').innerText())); await assertMobileTargets(phone,'phone-menu'); await screenshot(phone,'phone-menu');
    const active=await phone.evaluate(()=>{const tree=document.getElementById('file-tree').getBoundingClientRect(),row=document.querySelector('#file-tree button.active')?.getBoundingClientRect();return {tree:{top:tree.top,bottom:tree.bottom},row:row?{top:row.top,bottom:row.bottom}:null};});
    if(process.env.NIMLO_UI_EXPLORE==='1'&&(!active.row||active.row.top<active.tree.top||active.row.bottom>active.tree.bottom))exploratoryFindings.push({name:'Opening menu keeps the active file fully visible',active});
    else assert(active.row&&active.row.top>=active.tree.top-1&&active.row.bottom<=active.tree.bottom+1,'Active file is clipped when opening the menu: '+JSON.stringify(active));
    await phone.keyboard.press('Escape'); await expectFocus(phone,'files-toggle');
    await menu(phone,'session'); assert(await phone.locator('#pair-phone').isHidden()); assert(await phone.locator('#pair-phone').isDisabled());
    assert.equal((await command(phone,'pair_create',{},true)).code,'permission_denied'); await closeMenu(phone);
    await compactHost(async page=>{
      await menu(page,'session'); await page.click('#pair-phone'); await page.locator('#pair-dialog').waitFor({state:'visible'});
      assert(await page.locator('#internet-start').isVisible()); assert.equal(await page.locator('#pair-urls a').count(),0);
      assert(await page.locator('#pair-code').isHidden()); assert.equal(await page.locator('#pair-local').textContent(),'Use same Wi-Fi');
      await assertMobileTargets(page,'compact-host-pair-internet'); await screenshot(page,'compact-host-pair-internet');
      await page.click('[data-close="pair-dialog"]');
    });
  });
  await check('Phone AI has full-size close, send, settings and provider controls', async () => {
    await ai(phone); await assertMobileTargets(phone,'phone-ai'); await screenshot(phone,'phone-ai'); await phone.click('#mobile-code');
    assert(!await phone.locator('#code-input').evaluate(el=>el===document.activeElement),'Returning to code unexpectedly raises the keyboard');
  });
  await check('Phone terminal uses the existing real PTY and full-size controls', async () => {
    await phone.click('#mobile-terminal'); await waitResize(phone); assert.equal(await terminalProof(phone,'PHONE_SAME_PTY'),shellPid);
    await screenshot(phone,'phone-terminal'); await assertMobileTargets(phone,'phone-terminal');
  });
  await check('Hidden phone terminal retains dimensions and repaints when returning from AI', async () => {
    const dimensions = await phone.evaluate(() => ({cols:window.__terminal.cols,rows:window.__terminal.rows}));
    await command(phone,'terminal_input',{data:"sleep 0.4; printf 'OUTPUT_WHILE_AI_IS_OPEN\\n'\r"},true); await ai(phone);
    await phone.waitForFunction(() => JSON.stringify(window.__terminal).includes('OUTPUT_WHILE_AI_IS_OPEN')); await phone.waitForTimeout(700);
    assert.deepEqual(await phone.evaluate(()=>({cols:window.__terminal.cols,rows:window.__terminal.rows})),dimensions);
    await phone.click('#mobile-terminal');
    await phone.waitForFunction(() => document.getElementById('terminal-screen').textContent.includes('OUTPUT_WHILE_AI_IS_OPEN'));
    const rendered = await phone.evaluate(() => ({rows:document.querySelectorAll('.term-row').length,available:window.__terminal.rows}));
    assert(rendered.rows >= Math.min(rendered.available,10), 'Restored phone terminal was not fully repainted'); await phone.click('#mobile-code');
  });
  await check('Phone switching keeps a partially typed command in the same real shell', async () => {
    await phone.click('#mobile-terminal'); await phone.waitForFunction(()=>!document.getElementById('terminal-command').disabled);
    await phone.fill('#terminal-command',"printf 'MOBILE_ROUTE_CONTINUITY\\n' > ui-mobile-route-proof.txt");
    await phone.waitForFunction(()=>window.__sent.some(event=>event.type==='terminal_input'&&event.data.includes('MOBILE_ROUTE_CONTINUITY')));
    await phone.click('#mobile-code'); await phone.click('#mobile-ai'); await phone.click('#mobile-terminal');
    await phone.click('#mobile-terminal'); assert.equal(await phone.locator('#app').getAttribute('data-view'),'terminal');
    const entersBefore=await phone.evaluate(()=>window.__sent.filter(event=>event.type==='terminal_input'&&event.data==='\r').length);
    await phone.locator('#terminal-command').focus(); await phone.locator('#terminal-run').tap();
    await expectFocus(phone,'terminal-command');
    const deadline=Date.now()+10000;
    while(Date.now()<deadline&&!fs.existsSync(path.join(workspace,'ui-mobile-route-proof.txt')))await sleep(30);
    assert.equal(fs.readFileSync(path.join(workspace,'ui-mobile-route-proof.txt'),'utf8'),'MOBILE_ROUTE_CONTINUITY\n');
    assert.equal(await phone.evaluate(()=>window.__sent.filter(event=>event.type==='terminal_input'&&event.data==='\r').length),entersBefore+1,'Touch Enter sent duplicate or missing shell input');
    assert.equal(await terminalProof(phone,'ROUTE_SAME_PTY'),shellPid);
    await phone.click('#mobile-code');
  });
  await check('Phone terminal Keys and Ctrl C respond once to touch without losing input focus', async () => {
    await phone.click('#mobile-terminal'); await phone.setViewportSize({width:320,height:300});
    try {
      await phone.locator('#terminal-command').focus();
      const interruptsBefore=await phone.evaluate(()=>window.__sent.filter(event=>event.type==='terminal_input'&&event.data==='\x03').length);
      await phone.locator('#terminal-keys-toggle').tap();
      await phone.waitForFunction(()=>document.getElementById('app').dataset.terminalKeys==='open');
      await expectFocus(phone,'terminal-command');
      await assertMobileTargets(phone,'phone-terminal-touch-keys'); await screenshot(phone,'phone-terminal-touch-keys');
      await phone.locator('[data-term-key="interrupt"]').tap();
      await phone.waitForFunction(count=>window.__sent.filter(event=>event.type==='terminal_input'&&event.data==='\x03').length===count+1,interruptsBefore);
      assert.equal(await phone.locator('#app').getAttribute('data-terminal-keys'),'closed');
      await expectFocus(phone,'terminal-command');
      await sleep(100);
      assert.equal(await phone.evaluate(()=>window.__sent.filter(event=>event.type==='terminal_input'&&event.data==='\x03').length),interruptsBefore+1,'Touch Ctrl C sent duplicate shell input');
    } finally { await phone.setViewportSize({width:390,height:844}); }
    assert.equal(await terminalProof(phone,'TOUCH_KEYS_SAME_PTY'),shellPid); await phone.click('#mobile-code');
  });
  await check('Phone Files and Session expose focused actions without mixed device clutter', async () => {
    await menu(phone); assert(await phone.locator('#file-tree').isVisible()); assert(await phone.locator('#device-list').isHidden());
    await menu(phone,'session'); assert(await phone.locator('#file-tree').isHidden());
    assert(await phone.locator('#settings-open').isHidden(),'Session contains AI settings'); assert(await phone.locator('#pair-phone').isHidden()); assert(await phone.locator('#pair-phone').isDisabled()); assert(await phone.locator('#device-list').isVisible());
    await screenshot(phone,'session'); await phone.click('#session-menu-close'); assert(await phone.locator('#session-menu').isHidden());
  });
  await check('Phone rotation and constrained keyboard space keep navigation and inputs within bounds', async () => {
    for(const [width,height] of [[430,932],[844,390],[390,360],[320,300]]){
      await phone.setViewportSize({width,height}); await phone.waitForTimeout(100);
      for(const view of ['code','ai','terminal']){
        await phone.click('#mobile-'+view); await assertMobileTargets(phone,'phone-'+width+'x'+height+'-'+view);
        if(view==='terminal'){
          const output=await phone.locator('#terminal-screen-wrap').evaluate(el=>{const s=getComputedStyle(el);return {height:el.clientHeight,usable:el.clientHeight-parseFloat(s.paddingTop)-parseFloat(s.paddingBottom)};});
          assert(output.usable>=44,'Keyboard-constrained terminal clips its readable output: '+JSON.stringify(output));
        }
        const positions=await phone.evaluate(()=>{
          const visible=el=>!!el.getClientRects().length;
          const controls=['projects-toggle','files-toggle','mobile-code','mobile-ai','mobile-terminal','prompt','ai-send','terminal-command','terminal-run'].map(id=>document.getElementById(id)).filter(visible);
          return controls.map(el=>{const r=el.getBoundingClientRect();return {id:el.id,left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height};});
        });
        for(const rect of positions){assert(rect.left>=-0.5&&rect.right<=width+0.5,JSON.stringify(rect));assert(rect.top>=-0.5&&rect.bottom<=height+0.5,JSON.stringify(rect));}
      }
      await screenshot(phone,'compact-'+width+'x'+height);
    }
    await phone.setViewportSize({width:390,height:844}); await phone.click('#mobile-code');
  });
  await check('Native visual viewport changes keep the workspace and dialogs above a keyboard', async () => {
    // Headless browsers do not show an OS keyboard. Drive the native event
    // boundary while keeping the layout viewport full size, as mobile Safari does.
    await keyboardViewport(phone,true);
    try{
      for(const view of ['code','ai','terminal']){
        await phone.click('#mobile-'+view);
        const bounds=await phone.evaluate(()=>{
          const ids=['app','mobile-code','mobile-ai','mobile-terminal',...(document.getElementById('app').dataset.view==='ai'?['prompt','ai-send']:document.getElementById('app').dataset.view==='terminal'?['terminal-command','terminal-run']:['code-input'])];
          return ids.map(id=>{const r=document.getElementById(id).getBoundingClientRect();return {id,top:r.top,bottom:r.bottom,height:r.height};});
        });
        for(const rect of bounds){assert(rect.top>=35.5&&rect.bottom<=396.5,'Keyboard viewport violation: '+JSON.stringify(rect));assert(rect.height>0);}
      }
      assert(await phone.locator('#ai-settings').isDisabled());
      await compactHost(async page=>{
        await keyboardViewport(page,true);
        try {
          await actions.aiOptions(page); await page.click('#settings-open'); await page.waitForFunction(()=>!document.getElementById('settings-model').disabled);
          const rect=await page.locator('#settings-dialog').boundingBox(); assert(rect.y>=36&&rect.y+rect.height<=396);
          assert(await page.locator('#settings-submit').evaluate(e=>{const r=e.getBoundingClientRect();return r.top>=36&&r.bottom<=396&&e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));}),'Settings Save is obscured in a keyboard viewport');
          await page.locator('#settings-model').focus(); await screenshot(page,'compact-host-settings-keyboard');
          await page.click('[data-close="settings-dialog"]');
        } finally { await keyboardViewport(page,false); }
      });
    }finally{
      await keyboardViewport(phone,false);
      await phone.click('#mobile-code');
    }
  });
  await check('Host project and settings dialogs preserve large compact-screen touch targets', async () => {
    await phone.click('#projects-toggle'); assert(await phone.locator('#quick-add-project').isHidden()); assert(await phone.locator('#quick-add-project').isDisabled()); await phone.keyboard.press('Escape');
    assert(await phone.locator('#ai-settings').isDisabled());
    await compactHost(async page=>{
      await page.click('#projects-toggle'); await page.click('#quick-add-project'); await assertMobileTargets(page,'compact-host-project'); await screenshot(page,'compact-host-project'); await page.keyboard.press('Escape');
      await actions.aiOptions(page); await page.click('#settings-open'); await page.waitForFunction(() => !document.getElementById('settings-model').disabled); await assertMobileTargets(page,'compact-host-settings'); await screenshot(page,'compact-host-settings'); await page.keyboard.press('Escape');
    });
  });
  await check('320px HUD keeps a dirty long filename, save and panel controls within bounds', async () => {
    await phone.setViewportSize({width:320,height:700}); await phone.fill('#code-input',code+'// Edited from the phone.\n');
    await phone.waitForFunction(() => !document.getElementById('save-button').hidden); await assertMobileTargets(phone,'phone-320-dirty');
    const labels=await phone.evaluate(()=>({file:document.getElementById('file-label').getBoundingClientRect().width,project:document.getElementById('project-label').getBoundingClientRect().width}));
    assert(labels.file>=50&&labels.project>=20,'Dirty phone toolbar makes names unreadable');
    assert(await phone.locator('#file-extension').evaluate(e=>e.textContent==='.js'&&e.scrollWidth<=e.clientWidth+1),'Phone filename loses its extension');
    await menu(phone);assert.equal(await phone.locator('#files-current-label').textContent(),filename);await closeMenu(phone);
    const save=await phone.locator('#save-button').boundingBox(),dock=await phone.locator('#workspace-bar').boundingBox();
    assert(save.x>=dock.x+dock.width+4&&Math.abs(save.y+save.height/2-dock.y-dock.height/2)<=1,'Save crowds the dock');
    for(const id of ['mobile-code','mobile-ai','mobile-terminal'])assert(await phone.locator('#'+id).evaluate(e=>e.scrollWidth<=e.clientWidth),'Dock label clips: '+id);
    await screenshot(phone,'phone-320-dirty');
    await phone.setViewportSize({width:320,height:300});await screenshot(phone,'phone-320-dirty-short');
    await phone.click('#mobile-ai');await actions.mode(phone,'split');await screenshot(phone,'phone-320-dirty-ai-split');
    await actions.mode(phone,'tab');await phone.click('#mobile-code');await phone.setViewportSize({width:320,height:700});
    await pc.waitForFunction(text=>document.getElementById('code-input').value===text,code+'// Edited from the phone.\n');
    await pc.bringToFront(); assert.equal(await pc.locator('#code-input').getAttribute('readonly'),null);
    await pc.fill('#code-input',code+'// Edited from both devices.\n');
    await phone.waitForFunction(text=>document.getElementById('code-input').value===text,code+'// Edited from both devices.\n');
    assert.equal(await phone.locator('#code-input').getAttribute('readonly'),null);
    assert(await phone.locator('#view-only').isHidden());
    await phone.click('#save-button'); await phone.waitForFunction(()=>document.getElementById('save-button').hidden);
    assert.equal(fs.readFileSync(path.join(workspace,filename),'utf8'),code+'// Edited from both devices.\n');
    await phone.bringToFront(); await measure(phone,'phone-320-shared-edit'); await screenshot(phone,'phone-320-shared-edit');
  });
  await check('An ended shell can be restarted from a narrow phone without hidden controls', async () => {
    await phone.click('#mobile-terminal');phone.once('dialog',dialog=>dialog.accept());await phone.click('#terminal-end');
    await phone.waitForFunction(()=>window.__terminal?.running===false);
    const restart=await phone.locator('#terminal-restart').boundingBox();assert(restart&&restart.x>=0&&restart.x+restart.width<=320);
    await phone.click('#terminal-restart');await phone.waitForFunction(()=>window.__terminal?.running===true);
    await terminalProof(phone,'RESTARTED_FROM_PHONE');await phone.click('#mobile-code');
  });
  await check('Revoke signs the phone out while the PC and existing shell stay usable', async () => {
    await menu(pc,'session');
    const device = pc.locator('#device-list .device').filter({hasText:'Phone'});
    await device.getByRole('button',{name:'Revoke',exact:true}).click();
    await phone.locator('#join-dialog').waitFor({state:'visible'});
    assert(await phone.locator('#join-code').isDisabled(),'Revoked page retained an invitation');
    assert(await phone.locator('#code-input').evaluate(el=>el.readOnly));
    assert(await pc.locator('#view-only').isHidden());
    assert.equal(await pc.locator('#code-input').getAttribute('readonly'),null);
    assert(await pc.evaluate(()=>window.__terminal.running),'Revocation stopped the shared shell');
  });
  await check('A fresh invitation pasted into the signed-out page restores full phone access', async () => {
    await menu(pc,'session'); await pc.click('#pair-phone'); await pc.click('#pair-local');
    const invitationHandle=await pc.waitForFunction(()=>{
      const pin=document.getElementById('pair-code').textContent, link=document.querySelector('#pair-urls a')?.href;
      return document.getElementById('pair-dialog').open && /^[0-9]{6}$/.test(pin) && link && new URLSearchParams(new URL(link).hash.slice(1)).has('invite') ? {link,pin} : false;
    });
    const {link,pin}=await invitationHandle.jsonValue(); await invitationHandle.dispose();
    // A fragment navigation can return before its hash handler initializes the
    // invitation. Wait for that bootstrap before entering the PIN it clears.
    const invitationReady=phone.waitForResponse(response=>new URL(response.url()).pathname==='/api/bootstrap' && response.status()===401);
    await phone.goto(link); await invitationReady;
    await phone.waitForFunction(()=>document.getElementById('join-dialog').open && !document.getElementById('join-form').hidden && !document.getElementById('join-code').disabled && !location.hash);
    await phone.fill('#join-code',pin); await phone.click('#join-submit');
    await phone.waitForFunction(()=>document.getElementById('app').dataset.connected==='yes'&&!document.getElementById('code-input').readOnly);
    assert.equal(await phone.locator('#code-input').inputValue(),code+'// Edited from both devices.\n');
    assert.equal(new URL(phone.url()).hash,'','Invitation remains in the address bar');
    await pc.click('[data-close="pair-dialog"]');
  });
  assert.deepEqual(errors,[]); checks.push('Zero browser exceptions or unexpected console errors');
  if(!exploratoryFindings.length)for(const name of ['failure-desktop','failure-phone','phone-320-view-only-dirty'])fs.rmSync(path.join(artifacts,'floating-'+(browserEngine==='webkit' ? 'webkit-' : '')+name+'.png'),{force:true});
  fs.writeFileSync(path.join(artifacts,reportName),JSON.stringify({status:exploratoryFindings.length?'exploratory-findings':'pass',date:new Date().toISOString(),binary,binarySha256,browserEngine,sourceCssOverride:process.env.NIMLO_USE_SOURCE_CSS==='1',sourceJsOverride:process.env.NIMLO_USE_SOURCE_JS==='1',keyboardValidation:'Reduced viewport geometry and simulated native visualViewport resize/pan; physical keyboards are untested',fixtureLines:code.split('\n').length,checks,screenshots,layouts,exploratoryFindings,expectedNetworkEvents},null,2)+'\n');
  console.log((exploratoryFindings.length?'EXPLORATORY UI: '+exploratoryFindings.length+' findings; ':'PASS UI: ')+checks.length+' checks; '+screenshots.length+' actual embedded-app screenshots; tests/'+reportName);
})().catch(async error => {
  console.error('FAIL '+stage+': '+(error.stack||String(error)));
  if(pc&&!pc.isClosed())await screenshot(pc,'failure-desktop').catch(()=>{});
  if(phone&&!phone.isClosed())await screenshot(phone,'failure-phone').catch(()=>{});
  fs.writeFileSync(path.join(artifacts,reportName),JSON.stringify({status:'fail',date:new Date().toISOString(),binary,binarySha256,browserEngine,stage,error:String(error),checks,screenshots,layouts,errors},null,2)+'\n');
  process.exitCode=1;
}).finally(async () => {
  if(browser)await browser.close();
  if(host){const child=host;child.kill('SIGINT');await new Promise(resolve=>{if(child.exitCode!==null)return resolve();child.once('exit',resolve);setTimeout(()=>{child.kill('SIGKILL');resolve();},5000).unref();});}
  fs.rmSync(fixture,{recursive:true,force:true});
});
