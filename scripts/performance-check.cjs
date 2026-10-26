// Reproducible isolated release-host measurements. Never emits the launch token.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const {spawn, execFileSync} = require('node:child_process');
const {chromium} = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const exec = (name,args) => execFileSync(name,args,{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();
const mib = bytes => Number((bytes / 1048576).toFixed(2));
const median = values => [...values].sort((a,b) => a-b)[Math.floor(values.length/2)];
const assert = require('node:assert/strict');

function instrumentation() {
  const Native = window.WebSocket;
  window.__perf = {clientId:null,generation:0,docs:{},terminal:null};
  window.__perfPending = new Map(); let sequence = 0;
  window.WebSocket = class extends Native {
    constructor(...args) {
      super(...args);
      if (!String(args[0]).includes('/ws?')) return;
      window.__perfSocket = this;
      this.addEventListener('message',event => {
        const value = JSON.parse(event.data), state = window.__perf;
        if (value.type === 'bootstrap') {
          state.clientId = value.clientId; state.generation = value.generation;
          state.docs = {};
          for (const file of value.openFiles) state.docs[file.path] = {revision:file.revision,length:file.content.length,dirty:file.dirty};
        }
        if (value.type === 'control') state.generation = value.generation;
        if (value.type === 'file_state') state.docs[value.file.path] = {revision:value.file.revision,length:value.file.content.length,dirty:value.file.dirty};
        if (value.type === 'file_closed') delete state.docs[value.path];
        if (value.type === 'terminal_state') state.terminal = {cols:value.terminal.cols,rows:value.terminal.rows,running:value.terminal.running};
        const pending = window.__perfPending.get(value.requestId);
        if (pending) {
          window.__perfPending.delete(value.requestId); clearTimeout(pending.timer);
          if (value.type === 'error') pending.reject(new Error(value.code + ': ' + value.message));
          else pending.resolve({type:value.type,revision:value.file?.revision,lines:value.lines?.length});
        }
      });
    }
  };
  window.__perfCommand = (type,fields,mutation) => new Promise((resolve,reject) => {
    const requestId = 'perf-' + (++sequence);
    const payload = Object.assign({type,requestId},fields);
    if (mutation) payload.generation = window.__perf.generation;
    const timer = setTimeout(() => {window.__perfPending.delete(requestId);reject(new Error('Timed out: '+type));},30000);
    window.__perfPending.set(requestId,{resolve,reject,timer});
    window.__perfSocket.send(JSON.stringify(payload));
  });
}

async function main() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(),'nimlo-performance-'));
  const workspace = path.join(base,'workspace'), recovery = path.join(base,'recovery');
  fs.mkdirSync(workspace); fs.mkdirSync(recovery);
  const fileBytes = 1048576 - 1024, contents = [];
  const line = '// A plain ASCII benchmark line with a bounded eighty-column-like length.\n';
  for (let i=0;i<8;i++) {
    const header = `// File ${i}\n`;
    const content = header + line.repeat(Math.ceil(fileBytes / line.length)).slice(0,fileBytes-header.length);
    assert.equal(Buffer.byteLength(content),fileBytes); contents.push(content);
    fs.writeFileSync(path.join(workspace,`file-${i}.txt`),content);
  }
  const binary = path.resolve('target/release/nimlo-editor');
  const result = {timestamp:new Date().toISOString(),method:{rss:'macOS ps RSS, sampled every100ms, KiB converted to MiB',browserHeap:'Chrome CDP Runtime.getHeapUsage before and after HeapProfiler.collectGarbage; excludes browser native/GPU memory',phaseSettlingMilliseconds:1500},hardware:{model:exec('sysctl',['-n','hw.model']),cpu:exec('sysctl',['-n','machdep.cpu.brand_string']),physicalMemoryBytes:Number(exec('sysctl',['-n','hw.memsize'])),os:exec('sw_vers',[]),kernel:exec('uname',['-r']),rust:exec('rustc',['--version']),node:process.version},build:{profile:'release; strip=true; lto=thin; codegen-units=1',binaryBytes:fs.statSync(binary).size,binarySha256:crypto.createHash('sha256').update(fs.readFileSync(binary)).digest('hex'),assets:{}},workload:{files:8,bytesPerFile:fileBytes,totalFileBytes:fileBytes*8,edits:20,openCloseCycles:10,terminalLines:5000,terminalDelayMilliseconds:1},phases:[],cycles:[],browserErrors:[]};
  for (const name of ['index.html','app.js','style.css']) {
    const bytes = fs.readFileSync(path.join('web',name));
    result.build.assets[name] = {bytes:bytes.length,gzipBytes:zlib.gzipSync(bytes).length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')};
  }
  const host = spawn(binary,['--workspace',workspace,'--state-dir',recovery,'--listen','0.0.0.0:0'],{stdio:['ignore','pipe','pipe']});
  let output = '', failure = ''; host.stdout.on('data',data => output += data); host.stderr.on('data',data => failure += data);
  let browser, timer, currentPhase='starting', samples=[], phaseStart=0;
  const children = () => {
    const all = []; const scan = parent => {
      let ids; try { ids = exec('pgrep',['-P',String(parent)]).split(/\s+/).map(Number); } catch { return; }
      for (const id of ids) {
        try { const [pid,ppid,rss,...command] = exec('ps',['-p',String(id),'-o','pid=,ppid=,rss=,comm=']).split(/\s+/); all.push({pid:Number(pid),parent:Number(ppid),rssMiB:mib(Number(rss)*1024),executable:command.join(' ')}); scan(id); } catch {}
      }
    }; scan(host.pid); return all;
  };
  const readRSS = () => { try { return mib(Number(exec('ps',['-p',String(host.pid),'-o','rss=']))*1024); } catch { return null; } };
  const cmd = (page,type,fields={},mutation=false) => page.evaluate(({type,fields,mutation}) => window.__perfCommand(type,fields,mutation),{type,fields,mutation});
  const heaps = async pages => {
    const readings = {};
    for (const [name,page] of Object.entries(pages)) {
      const cdp = await page.context().newCDPSession(page);
      const raw = await cdp.send('Runtime.getHeapUsage'); await cdp.send('HeapProfiler.collectGarbage');
      const collected = await cdp.send('Runtime.getHeapUsage');
      readings[name] = {usedBeforeGCMiB:mib(raw.usedSize),usedAfterGCMiB:mib(collected.usedSize),totalAfterGCMiB:mib(collected.totalSize),domNodes:await page.evaluate(()=>document.querySelectorAll('*').length)};
      await cdp.detach();
    }
    return readings;
  };
  const mark = async (name,pages={}) => {
    await delay(1500); const browserHeap = await heaps(pages); await delay(300);
    const phaseSamples = samples.slice(phaseStart).filter(sample => sample.rssMiB != null), tail=phaseSamples.slice(-10).map(sample=>sample.rssMiB);
    result.phases.push({name,hostSettledMedianMiB:median(tail),hostObservedPeakMiB:Math.max(...phaseSamples.map(sample=>sample.rssMiB)),samples:phaseSamples.length,browserHeap,children:children()});
    console.log(name + ': host settled ' + median(tail) + ' MiB, observed peak ' + Math.max(...phaseSamples.map(sample=>sample.rssMiB)) + ' MiB');
    currentPhase=name; phaseStart=samples.length;
  };
  try {
    for (let n=0;!output.match(/http:\/\/127\.0\.0\.1:\d+\/#token=[a-f0-9]+/);n++) { if(n>200 || host.exitCode != null) throw new Error('Release host failed to start: '+failure); await delay(50); }
    const launch = output.match(/http:\/\/127\.0\.0\.1:\d+\/#token=[a-f0-9]+/)[0], origin = new URL(launch).origin;
    for(const [name,asset] of Object.entries(result.build.assets)) {
      const response=await fetch(origin+(name==='index.html' ? '/' : '/'+name));
      assert.equal(response.status,200);
      const embeddedHash=crypto.createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex');
      assert.equal(embeddedHash,asset.sha256,'Rebuild release binary: embedded asset differs from current '+name);
    }
    timer=setInterval(()=>samples.push({elapsedMilliseconds:Date.now(),phase:currentPhase,rssMiB:readRSS()}),100);
    await delay(8000); await mark('idle host, no browser or terminal');
    browser = await chromium.launch({executablePath:process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
    result.hardware.chrome=browser.version();
    const pcContext=await browser.newContext({viewport:{width:1280,height:800}}), phoneContext=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
    await pcContext.addInitScript(instrumentation); await phoneContext.addInitScript(instrumentation);
    const pc=await pcContext.newPage(),phone=await phoneContext.newPage(),pages={desktop:pc,phone};
    for(const [name,page] of Object.entries(pages)) page.on('pageerror',error => result.browserErrors.push(name+': '+error.message));
    await pc.goto(launch); await pc.waitForFunction(()=>document.getElementById('app').dataset.connected==='yes' && !document.getElementById('new-file').disabled);
    await mark('one desktop, no loaded files',{desktop:pc});
    await phone.goto(origin); await pc.click('#files-toggle'); await pc.click('#pair-phone'); await pc.click('#pair-local'); await pc.waitForFunction(()=>/^[0-9]{6}$/.test(document.getElementById('pair-code').textContent));
    await pc.waitForFunction(()=>/^[0-9]{6}$/.test(document.getElementById('pair-code').textContent));
    const code=await pc.locator('#pair-code').textContent(); await phone.goto(await pc.locator('#pair-urls a').first().getAttribute('href')); await phone.fill('#join-code',code); await phone.click('#join-submit');
    await phone.waitForFunction(()=>document.getElementById('app').dataset.connected==='yes' && !document.getElementById('new-file').disabled); await pc.click('[data-close="pair-dialog"]');
    await mark('desktop plus phone, no loaded files',pages);
    for(let i=0;i<8;i++) await cmd(pc,'open_file',{path:`file-${i}.txt`});
    await phone.waitForFunction(()=>Object.keys(window.__perf.docs).length===8);
    await mark('eight near-limit files, desktop plus phone',pages);
    for(let i=0;i<20;i++) {
      const revision=await pc.evaluate(()=>window.__perf.docs['file-7.txt'].revision);
      await cmd(pc,'edit_file',{path:'file-7.txt',baseRevision:revision,content:contents[7]+`\n// Edit ${i}\n`},true);
    }
    await mark('twenty full-document edits, shared unsaved buffer',pages);
    const phoneRevision=await phone.evaluate(()=>window.__perf.docs['file-7.txt'].revision), started=process.hrtime.bigint();
    const phoneEdit=await cmd(phone,'edit_file',{path:'file-7.txt',baseRevision:phoneRevision,content:contents[7]+'\n// Continued from phone\n'},true);
    await pc.waitForFunction(revision=>window.__perf.docs['file-7.txt'].revision===revision,phoneEdit.revision);
    assert.equal(await pc.locator('#code-input').evaluate(input=>input.readOnly),false);
    assert.equal(await phone.locator('#code-input').evaluate(input=>input.readOnly),false);
    result.workload.sharedDeviceEditObservedMilliseconds=Number(process.hrtime.bigint()-started)/1e6;
    result.workload.deviceSwitchEdits=1;
    await mark('phone edit, desktop remains writable, same unsaved buffer',pages);
    await phone.click('#mobile-terminal');
    await phone.waitForFunction(()=>!document.getElementById('terminal-command').disabled); await delay(500);
    await cmd(phone,'terminal_resize',{cols:80,rows:24},true);
    await mark('persistent terminal idle, 80 columns by24 rows',pages);
    const terminalCommand = 'python3 -u -c \'import time; [(print("PERF-%06d " % i + "x"*60),time.sleep(0.001)) for i in range(5000)]; print("PERF_"+"DONE")\'\r';
    let producerPeak=[]; const producerTimer=setInterval(()=>producerPeak.push(...children()),500);
    await cmd(phone,'terminal_input',{data:terminalCommand},true);
    await phone.waitForFunction(()=>document.getElementById('terminal-screen').textContent.includes('PERF_DONE'),null,{timeout:30000});
    clearInterval(producerTimer); result.terminalProducerObserved=producerPeak;
    const history=await cmd(phone,'terminal_history',{limit:500}); result.workload.retainedTerminalHistoryRows=history.lines;
    await mark('five thousand terminal lines; phone renders retained history',pages);
    await phone.click('#mobile-code');
    for(let cycle=0;cycle<10;cycle++) {
      for(let i=0;i<8;i++) {
        const filename=`file-${i}.txt`, revision=await phone.evaluate(filename=>window.__perf.docs[filename].revision,filename);
        await cmd(phone,'close_file',{path:filename,discard:true,revision},true);
      }
      for(let i=0;i<8;i++) await cmd(phone,'open_file',{path:`file-${i}.txt`});
      await delay(250);
      result.cycles.push({cycle:cycle+1,hostRSSMiB:readRSS()});
    }
    await mark('ten close/open cycles of eight near-limit files',pages);
    for(let i=0;i<8;i++) {
      const filename=`file-${i}.txt`, revision=await phone.evaluate(filename=>window.__perf.docs[filename].revision,filename);
      await cmd(phone,'close_file',{path:filename,discard:true,revision},true);
    }
    await cmd(phone,'terminal_stop',{},true); await mark('all files closed, terminal explicitly stopped',pages);
    await browser.close(); browser=null; await mark('browsers closed, host remains idle');
    result.hostObservedPeakMiB=Math.max(...samples.filter(sample=>sample.rssMiB!=null).map(sample=>sample.rssMiB));
    result.durationSeconds=(samples.at(-1).elapsedMilliseconds-samples[0].elapsedMilliseconds)/1000;
    result.recoverySnapshotBytes=fs.statSync(path.join(recovery,'drafts.json')).size;
    const producerPeaks=new Map();
    for(const process of result.terminalProducerObserved) if(!producerPeaks.has(process.executable) || producerPeaks.get(process.executable).rssMiB<process.rssMiB) producerPeaks.set(process.executable,process);
    result.terminalProducerObserved=[...producerPeaks.values()];
    assert.deepEqual(result.browserErrors,[]);
    const destination=process.env.PERFORMANCE_OUTPUT || 'tests/performance.json'; fs.writeFileSync(destination,JSON.stringify(result,null,2)+'\n');
    console.log('PASS: measurements written to '+destination);
  } finally {
    if(timer) clearInterval(timer); if(browser) await browser.close();
    host.kill('SIGINT');
    for(let n=0;host.exitCode==null&&host.signalCode==null&&n<40;n++) await delay(100);
    if(host.exitCode==null&&host.signalCode==null) host.kill('SIGKILL');
    fs.rmSync(base,{recursive:true,force:true});
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
