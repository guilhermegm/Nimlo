#!/usr/bin/env node
'use strict';

// Exercise the current embedded editor with trusted browser keyboard actions.
// Every project, provider probe and host process belongs to this fixture.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const {spawn} = require('node:child_process');
const playwright = require(process.env.PLAYWRIGHT_PATH || path.resolve(__dirname, '../../mini_gym/node_modules/playwright'));

const engine = process.env.NIMLO_BROWSER || 'chromium';
assert(['chromium', 'webkit'].includes(engine), 'Use Chromium or WebKit');
const repo = path.resolve(__dirname, '..');
const binary = path.resolve(repo, process.env.NIMLO_BINARY || 'target/release/nimlo-editor');
const out = path.resolve(process.env.EDITOR_INPUT_OUTPUT || path.join(repo, 'target/editor-input-review', engine));
const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nimlo-editor-input-')));
const workspace = path.join(fixture, 'project');
const providerBin = path.join(fixture, 'bin');
const providerLog = path.join(fixture, 'provider-probes.txt');
const shortcut = process.platform === 'darwin' ? 'Meta' : 'Control';
const padding = '// retained line\n'.repeat(11000);
const checks = [], errors = [], screenshots = [], measurements = [];
let host, browser, context, page, launchUrl, currentPath, stage = 'startup';

fs.mkdirSync(workspace, {recursive:true});
fs.mkdirSync(providerBin, {recursive:true});
fs.mkdirSync(out, {recursive:true});
for (const provider of ['codex', 'claude']) {
  fs.writeFileSync(path.join(providerBin, provider), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$NIMLO_INPUT_PROVIDER_LOG"\nprintf "Logged in using subscription\\n"\n', {mode:0o700});
}
const lowlineFiles=[['long-ascii.js','x'.repeat(1_040_000)],
  ['few-unicode.js',('日本語 😀 cafe\u0301\tconst value = 42; '.repeat(140)+'\n').repeat(180)]];
for(const [file,source] of lowlineFiles) fs.writeFileSync(path.join(workspace,file),source);
for (const bounded of [false, true]) for (const [style, unit] of [['two', '  '], ['four', '    '], ['tabs', '\t']]) {
  fs.writeFileSync(path.join(workspace, style + (bounded ? '-large' : '') + '.js'), 'function task() {\n' + unit + 'existing();\n}\n' + (bounded ? padding : ''));
}
for (const [file,source] of [
  ['lifetimes.rs', "fn task<'a>() {\n    let borrowed: &'a str = ;\n}\n"],
  ['multiline.py', 'def task():\n    text = """first\n    continued {\n    last"""\n'],
  ['separators.cpp', "int main() {\n    auto value = 1'000 + ;\n}\n"]
]) fs.writeFileSync(path.join(workspace,file),source);

function sanitized(value) {return String(value).replace(/[a-f0-9]{64}/gi, '[private]');}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function check(name, run) {stage=name; await run(); checks.push(name); console.log('PASS ' + name);}
async function textIs(text) {
  await page.waitForFunction(text => document.getElementById('code-input').nimloEditor.value === text, text);
}
async function selectionIs(start, end=start, direction) {
  await page.waitForFunction(({start,end,direction}) => {
    const editor=document.getElementById('code-input').nimloEditor;
    return editor.selectionStart===start && editor.selectionEnd===end && (direction===undefined || editor.selectionDirection===direction);
  }, {start,end,direction});
}
async function select(start, end=start, direction='none') {
  await page.evaluate(({start,end,direction}) => {
    const input=document.getElementById('code-input'), editor=input.nimloEditor;
    editor.setSelectionRange(start,end,direction); editor.reveal(); input.focus({preventScroll:true});
  }, {start,end,direction});
}
async function acknowledged(text) {
  await page.waitForFunction(({path,text}) => window.__inputReview.documents[path]?.content===text, {path:currentPath,text});
}
async function palette(command) {
  await page.keyboard.press(shortcut + '+Shift+p');
  await page.locator('#command-dialog').waitFor({state:'visible'});
  await page.fill('#command-input', command);
  await page.keyboard.press('Enter');
  await page.locator('#command-dialog').waitFor({state:'hidden'});
}
async function open(style, bounded) {
  await openPath(style + (bounded ? '-large' : '') + '.js');
}
async function openPath(file) {
  currentPath=file;
  await palette(':e ' + currentPath);
  await page.waitForFunction(path => window.__inputReview.activePath===path && !document.getElementById('code-input').readOnly, currentPath);
  await page.locator('#code-input').focus();
}
async function reset(source, bounded) {
  const text=source + (bounded ? padding : '');
  await page.locator('#code-input').focus();
  await page.keyboard.press(shortcut + '+a');
  await page.keyboard.insertText(text);
  await textIs(text); await acknowledged(text);
  assert.equal(await page.evaluate(() => document.getElementById('code-input').nimloEditor.large), bounded);
  return text;
}
async function shot(name) {
  const file=name+'.png'; await page.screenshot({path:path.join(out,file)}); screenshots.push(file);
}
async function startHost() {
  host=spawn(binary, ['--workspace',workspace,'--state-dir',path.join(fixture,'state'),'--listen','127.0.0.1:0'], {
    env:{...process.env,PATH:providerBin+path.delimiter+process.env.PATH,NIMLO_INPUT_PROVIDER_LOG:providerLog},
    stdio:['ignore','pipe','pipe']
  });
  let output='', stderr='';
  host.stderr.on('data', bytes => {stderr=(stderr+bytes).slice(-2000);});
  launchUrl=await new Promise((resolve,reject) => {
    const timer=setTimeout(() => reject(Error('Fixture host timed out: '+sanitized(stderr))), 15000);
    host.stdout.on('data', bytes => {
      output=(output+bytes).slice(-12000); const match=output.match(/http:\/\/127\.0\.0\.1:\d+\/#token=[a-f0-9]{64}/);
      if (match) {clearTimeout(timer); resolve(match[0]); output='';}
    });
    host.once('error', error => {clearTimeout(timer); reject(error);});
    host.once('exit', code => {clearTimeout(timer); reject(Error('Fixture host exited '+code+': '+sanitized(stderr)));});
  });
}
async function stopHost() {
  if (!host || host.exitCode!==null || host.signalCode!==null) return;
  const exited=new Promise(resolve => host.once('exit',resolve));
  host.kill('SIGINT'); await Promise.race([exited,delay(3000)]);
  if (host.exitCode===null && host.signalCode===null) {host.kill('SIGKILL'); await Promise.race([exited,delay(2000)]);}
}

(async () => {
  await startHost();
  browser=await playwright[engine].launch({headless:true,...(engine==='chromium' ? {executablePath:process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'} : {})});
  context=await browser.newContext({viewport:{width:1120,height:720}});
  await context.addInitScript(() => {
    const Original=WebSocket;
    window.__inputReview={documents:{},activePath:null,sent:[],messages:0};
    window.WebSocket=class extends Original {
      constructor(...args) {
        super(...args);
        this.addEventListener('message', event => {
          const message=JSON.parse(event.data), capture=window.__inputReview;
          capture.messages++;
          if (message.type==='bootstrap') {
            capture.activePath=message.activePath;
            for (const file of message.openFiles || []) capture.documents[file.path]={...file};
          }
          if (message.type==='file_state') capture.documents[message.file.path]={...message.file};
          if (message.type==='file_patch') {
            const previous=capture.documents[message.file.path];
            if (previous?.revision===message.baseRevision) {
              const patch=message.patch;
              capture.documents[message.file.path]={...previous,...message.file,content:previous.content.slice(0,patch.start)+patch.insert+previous.content.slice(patch.start+patch.deleteCount)};
            }
          }
          if (message.type==='file_closed') delete capture.documents[message.path];
          if (message.type==='active_file') capture.activePath=message.path;
          if (message.activePath!==undefined) capture.activePath=message.activePath;
        });
      }
      send(raw) {
        const message=JSON.parse(raw);
        window.__inputReview.sent.push({type:message.type,path:message.path,requestId:message.requestId});
        super.send(raw);
      }
    };
  });
  page=await context.newPage(); page.on('pageerror', error => errors.push(sanitized(error.message)));
  await page.goto(launchUrl);
  await page.waitForFunction(() => document.getElementById('app').dataset.controller==='yes');
  await check('Fresh release serves the exact current editor assets without a shell or inference', async () => {
    for (const [route,file] of [['/','index.html'],['/editor.js','editor.js'],['/app.js','app.js'],['/style.css','style.css']]) {
      assert.equal(await (await page.request.get(new URL(route,launchUrl).href)).text(),fs.readFileSync(path.join(repo,'web',file),'utf8'),'Stale embedded '+file);
    }
    assert.equal(await page.locator('#terminal-panel').isVisible(),false);
    assert.equal(await page.evaluate(() => window.__inputReview.sent.some(message => ['ai_start','terminal_start'].includes(message.type))),false);
  });

  for (const bounded of [false,true]) {
    const label=bounded ? 'bounded' : 'ordinary';
    for (const [style,unit] of [['two','  '],['four','    '],['tabs','\t']]) {
      await open(style,bounded);
      await check(label+' '+style+': Tab reaches the next indentation stop and Backspace removes one stop', async () => {
        const source='function task() {\n'+unit+'existing();\n'+unit+'another();\n x\n}\n';
        const before=await reset(source,bounded), at=before.indexOf('\n x')+2;
        await select(at); await page.keyboard.press('Tab');
        const replacement=style==='tabs' ? ' \tx' : unit+'x';
        const after=before.replace('\n x\n','\n'+replacement+'\n');
        await textIs(after);
        const caret=at+(style==='tabs' ? 1 : unit.length-1);
        await selectionIs(caret);
        await page.keyboard.press('Backspace');
        await textIs(style==='tabs' ? before : before.replace('\n x\n','\nx\n'));
      });
      await check(label+' '+style+': Enter expands an empty brace pair using the file indentation', async () => {
        const source='function task() {\n'+unit+'const item = {};\n}\n';
        const before=await reset(source,bounded), at=before.indexOf('{}')+1;
        await select(at); await page.keyboard.press('Enter');
        const inserted='\n'+unit+unit+'\n'+unit;
        await textIs(before.slice(0,at)+inserted+before.slice(at));
        await selectionIs(at+1+unit.length*2);
      });
    }

    await open('two',bounded);
    await check(label+': multiline indent and outdent preserve a backward range and exclude the next line at column zero', async () => {
      const before=await reset('one\n  two\nthree\n',bounded), start=1, end=before.indexOf('three');
      await select(start,end,'backward'); await page.keyboard.press('Tab');
      const indented=before.replace('one\n  two\n','  one\n    two\n');
      await textIs(indented); await selectionIs(start+2,end+4,'backward');
      await page.keyboard.press('Shift+Tab');
      await textIs(before); await selectionIs(start,end,'backward');
    });
    await check(label+': an acknowledged edit from another window preserves the backward selection and its active end', async () => {
      const before=await reset('one\n  two\nthree\n',bounded);
      await select(1,7,'backward');
      const other=await context.newPage();
      try {
        await other.goto(launchUrl);
        await other.waitForFunction(text => {
          const input=document.getElementById('code-input');
          return input && !input.readOnly && input.nimloEditor.value===text;
        },before);
        await other.evaluate(() => {
          const input=document.getElementById('code-input'), editor=input.nimloEditor;
          editor.setSelectionRange(editor.length,editor.length); editor.reveal(); input.focus({preventScroll:true});
        });
        await other.keyboard.type('x');
        await textIs(before+'x'); await acknowledged(before+'x');
        await selectionIs(1,7,'backward');
      } finally {await other.close();}
      await page.bringToFront(); await page.locator('#code-input').focus();
      await page.keyboard.press('Shift+ArrowRight');
      await selectionIs(2,7,'backward');
    });
    await check(label+': Enter continues whitespace without treating comment or string braces as a block', async () => {
      for (const line of ['  // opening {','  const mark = "{']) {
        const before=await reset('function task() {\n'+line+'\n}\n',bounded), at=before.indexOf(line)+line.length;
        await select(at); await page.keyboard.press('Enter');
        await textIs(before.slice(0,at)+'\n  '+before.slice(at)); await selectionIs(at+3);
      }
    });
    await check(label+': newly typed brackets pair, skip their own closer, and remove together with Backspace', async () => {
      for (const [opening,closing] of [['(',')'],['[',']'],['{','}']]) {
        const before=await reset('const result = ;\n  // indentation sample\n',bounded), at=before.indexOf(';');
        await select(at); await page.keyboard.type(opening);
        await textIs(before.slice(0,at)+opening+closing+before.slice(at)); await selectionIs(at+1);
        await page.keyboard.press('Backspace'); await textIs(before); await selectionIs(at);
        await page.keyboard.type(opening+'x'+closing);
        await textIs(before.slice(0,at)+opening+'x'+closing+before.slice(at)); await selectionIs(at+3);
      }
    });
    await check(label+': existing untracked closers type normally, Unicode selections wrap, and quotes remain single', async () => {
      let before=await reset('const result = ();\n  // indentation sample\n',bounded), at=before.indexOf(')');
      await select(at); await page.keyboard.type(')');
      await textIs(before.slice(0,at)+')'+before.slice(at)); await selectionIs(at+1);
      before=await reset('const label = 日本😀;\n  // indentation sample\n',bounded); at=before.indexOf('日本😀');
      await select(at,at+'日本😀'.length,'backward'); await page.keyboard.type('[');
      await textIs(before.slice(0,at)+'[日本😀]'+before.slice(at+'日本😀'.length));
      before=await reset('const label = ;\n  // indentation sample\n',bounded); at=before.indexOf(';');
      await select(at); await page.keyboard.type('"');
      await textIs(before.slice(0,at)+'"'+before.slice(at)); await selectionIs(at+1);
    });
    await check(label+': comments and strings receive literal brackets', async () => {
      for (const line of ['// comment ','const text = "literal ']) {
        const before=await reset(line+'\n  // indentation sample\n',bounded), at=line.length;
        await select(at); await page.keyboard.type('(');
        await textIs(before.slice(0,at)+'('+before.slice(at)); await selectionIs(at+1);
      }
    });
    await check(label+': multiline JavaScript templates and block comments remain literal until their closing delimiter', async () => {
      const continued='  retained content\n'.repeat(180), marker='  continued {';
      for (const [opening,closing] of [['const template = `first\n','last`;\n'],['/* opening block\n','*/\n']]) {
        const source=opening+continued+marker+'\n'+closing+'const result = ;\n';
        let before=await reset(source,bounded), at=before.indexOf(marker)+marker.length;
        await select(at); await page.keyboard.type('(');
        await textIs(before.slice(0,at)+'('+before.slice(at)); await selectionIs(at+1);
        before=await reset(source,bounded); at=before.indexOf(marker)+marker.length;
        await select(at); await page.keyboard.press('Enter');
        await textIs(before.slice(0,at)+'\n  '+before.slice(at)); await selectionIs(at+3);
        before=await reset(source,bounded); at=before.indexOf('const result = ;')+'const result = '.length;
        await select(at); await page.keyboard.type('(');
        await textIs(before.slice(0,at)+'()'+before.slice(at)); await selectionIs(at+1);
      }
    });
    await check(label+': editing a preceding template delimiter invalidates the remembered literal context', async () => {
      const before=await reset('const template = `first\n  target ;\nlast`;\n',bounded), opening=before.indexOf('`'), at=before.indexOf('target ;')+'target '.length;
      await select(at); await page.keyboard.type('(');
      const literal=before.slice(0,at)+'('+before.slice(at);
      await textIs(literal);
      await select(opening,opening+1); await page.keyboard.press('Backspace');
      const code=literal.slice(0,opening)+literal.slice(opening+1), caret=at;
      await textIs(code); await select(caret); await page.keyboard.type('[');
      await textIs(code.slice(0,caret)+'[]'+code.slice(caret)); await selectionIs(caret+1);
    });
    await check(label+': pair insertion is acknowledged and shared-host undo and redo restore the exact document', async () => {
      const before=await reset('const result = ;\n  // indentation sample\n',bounded), at=before.indexOf(';');
      await select(at); await page.keyboard.type('(');
      const after=before.slice(0,at)+'()'+before.slice(at);
      await textIs(after); await acknowledged(after);
      await page.keyboard.press(shortcut+'+z'); await textIs(before); await acknowledged(before);
      await page.keyboard.press(shortcut+'+Shift+z'); await textIs(after); await acknowledged(after);
    });
    await check(label+': Enter at the viewport bottom keeps the resulting caret and editor focus visible', async () => {
      const before=await reset('const value = 0;\n'.repeat(160)+'function tail() {}\n',bounded), at=before.lastIndexOf('{}')+1;
      await select(at);
      await page.evaluate(() => {
        const input=document.getElementById('code-input'), editor=input.nimloEditor, style=getComputedStyle(input);
        const line=editor.value.slice(0,editor.selectionStart).split('\n').length-1, height=parseFloat(style.lineHeight);
        editor.scrollTop=line*height+parseFloat(style.paddingTop)+height-editor.clientHeight;
      });
      await page.keyboard.press('Enter');
      await textIs(before.slice(0,at)+'\n  \n'+before.slice(at));
      const geometry=await page.evaluate(() => {
        const input=document.getElementById('code-input'), editor=input.nimloEditor, style=getComputedStyle(input);
        const surface=editor.large ? editor.scroller : input, rect=surface.getBoundingClientRect(), line=editor.value.slice(0,editor.selectionEnd).split('\n').length-1;
        const height=parseFloat(style.lineHeight), top=rect.top+parseFloat(style.paddingTop)+line*height-editor.scrollTop;
        return {bounded:editor.large,caretTop:top,caretBottom:top+height,viewportTop:rect.top,viewportBottom:rect.bottom,focused:document.activeElement===input,scrollTop:editor.scrollTop};
      });
      measurements.push({case:label+'-caret-reveal',...geometry});
      assert(geometry.focused); assert(geometry.caretTop>=geometry.viewportTop-1,JSON.stringify(geometry));
      assert(geometry.caretBottom<=geometry.viewportBottom+1,JSON.stringify(geometry));
      await shot(label+'-caret-reveal');
    });
    await check(label+': modeled composition pins native input and leaves custom command keys alone', async () => {
      const before=await reset('const result = ;\n  // indentation sample\n',bounded), at=before.indexOf(';');
      await select(at);
      const prevented=await page.evaluate(() => {
        const input=document.getElementById('code-input');
        input.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));
        return ['Enter','Tab','Backspace','('].map(key => {
          const event=new KeyboardEvent('keydown',{key,isComposing:true,bubbles:true,cancelable:true});
          input.dispatchEvent(event); return event.defaultPrevented;
        });
      });
      assert.deepEqual(prevented,[false,false,false,false]); await textIs(before);
      await page.evaluate(() => {
        const input=document.getElementById('code-input');
        input.setRangeText('文',input.selectionStart,input.selectionEnd,'end');
        input.dispatchEvent(new InputEvent('input',{inputType:'insertCompositionText',data:'文',isComposing:true,bubbles:true}));
        input.dispatchEvent(new CompositionEvent('compositionend',{data:'文',bubbles:true}));
      });
      await textIs(before.slice(0,at)+'文'+before.slice(at));
      await acknowledged(before.slice(0,at)+'文'+before.slice(at));
    });
    await check(label+': modified command keys remain available to the browser and operating system', async () => {
      const before=await reset('const result = ;\n  // indentation sample\n',bounded), at=before.indexOf(';');
      await select(at);
      const prevented=await page.evaluate(() => {
        const input=document.getElementById('code-input'), results=[];
        for (const modifier of ['metaKey','ctrlKey','altKey']) for (const key of ['Enter','Tab','Backspace','(']) {
          const event=new KeyboardEvent('keydown',{key,[modifier]:true,bubbles:true,cancelable:true});
          input.dispatchEvent(event); results.push({modifier,key,prevented:event.defaultPrevented});
        }
        return results;
      });
      assert(prevented.every(result => !result.prevented),JSON.stringify(prevented));
      await textIs(before); await selectionIs(at);
    });
    await check(label+': readonly input and Vim normal mode never run editing conveniences', async () => {
      const before=await reset('const result = ;\n  // indentation sample\n',bounded), at=before.indexOf(';');
      await select(at);
      await page.evaluate(() => {document.getElementById('code-input').readOnly=true;});
      await page.keyboard.type('('); await page.keyboard.press('Enter'); await page.keyboard.press('Backspace');
      await page.keyboard.press('Tab'); await page.locator('#code-input').focus();
      await textIs(before);
      await page.evaluate(() => {document.getElementById('code-input').readOnly=false;});
      await palette(':vim on'); await select(at); await page.keyboard.type('('); await page.keyboard.press('Enter');
      await textIs(before); assert.equal(await page.locator('#editor-mode').textContent(),'NORMAL');
      await palette(':vim off'); await select(at);
      await page.keyboard.type('('); await textIs(before.slice(0,at)+'()'+before.slice(at));
    });
  }
  await check('Saved ordinary style fixtures close before extra language files open', async () => {
    for (const style of ['two','four','tabs']) {
      await open(style,false); await palette(':w');
      assert.equal(fs.readFileSync(path.join(workspace,currentPath),'utf8'),await page.evaluate(() => document.getElementById('code-input').nimloEditor.value));
      const closed=currentPath; await palette(':q');
      await page.waitForFunction(path => !window.__inputReview.documents[path],closed);
    }
    assert.equal(await page.evaluate(() => Object.keys(window.__inputReview.documents).length),3);
  });
  await openPath('lifetimes.rs');
  await check('Rust lifetimes leave code conveniences active while character literals remain literal', async () => {
    let before=await reset("fn task<'a>() {\n    let borrowed: &'a str = ;\n}\n",false), at=before.indexOf(';');
    await select(at); await page.keyboard.type('(');
    await textIs(before.slice(0,at)+'()'+before.slice(at)); await selectionIs(at+1);
    before=await reset("fn task<'a>() {\n    existing();\n}\n",false); at=before.indexOf('{')+1;
    await select(at); await page.keyboard.press('Enter');
    await textIs(before.slice(0,at)+'\n    '+before.slice(at)); await selectionIs(at+5);
    before=await reset("fn task() {\n    let symbol = 'x';\n}\n",false); at=before.indexOf("x'")+1;
    await select(at); await page.keyboard.type('(');
    await textIs(before.slice(0,at)+'('+before.slice(at)); await selectionIs(at+1);
  });
  await openPath('multiline.py');
  await check('Python triple strings remain literal and closing them restores code indentation and pairing', async () => {
    for (const delimiter of ['"""',"'''"]) {
      const source='def task():\n    text = '+delimiter+'first\n    continued {\n    last'+delimiter+'\n    next = ;\n';
      let before=await reset(source,false), at=before.indexOf('continued {')+'continued {'.length;
      await select(at); await page.keyboard.type('(');
      await textIs(before.slice(0,at)+'('+before.slice(at)); await selectionIs(at+1);
      before=await reset(source,false); at=before.indexOf('continued {')+'continued {'.length;
      await select(at); await page.keyboard.press('Enter');
      await textIs(before.slice(0,at)+'\n    '+before.slice(at)); await selectionIs(at+5);
      before=await reset(source,false); at=before.indexOf('next = ;')+'next = '.length;
      await select(at); await page.keyboard.type('(');
      await textIs(before.slice(0,at)+'()'+before.slice(at)); await selectionIs(at+1);
    }
    const before=await reset('def task():\n    existing()\n',false), at=before.indexOf(':')+1;
    await select(at); await page.keyboard.press('Enter');
    await textIs(before.slice(0,at)+'\n    '+before.slice(at)); await selectionIs(at+5);
  });
  await check('Python floor division remains code when continuing a colon block', async () => {
    const before=await reset('def task():\n    if count // 2:\n        work()\n',false);
    const at=before.indexOf('if count // 2:')+'if count // 2:'.length;
    await select(at); await page.keyboard.press('Enter');
    await textIs(before.slice(0,at)+'\n        '+before.slice(at)); await selectionIs(at+9);
  });
  await openPath('separators.cpp');
  await check('C++ digit separators leave code pairing active while character literals remain literal', async () => {
    let before=await reset("int main() {\n    auto value = 1'000 + ;\n}\n",false), at=before.indexOf(';');
    await select(at); await page.keyboard.type('(');
    await textIs(before.slice(0,at)+'()'+before.slice(at)); await selectionIs(at+1);
    before=await reset("int main() {\n    char symbol = 'x';\n}\n",false); at=before.indexOf("x'")+1;
    await select(at); await page.keyboard.type('(');
    await textIs(before.slice(0,at)+'('+before.slice(at)); await selectionIs(at+1);
  });
  for(const [file,before] of lowlineFiles) await check(file+': few-line large-file typing, shared undo/redo and disk save remain exact',async()=>{
    await openPath(file);await textIs(before);
    let at=Math.floor(before.length*.8);if(/[\uDC00-\uDFFF]/.test(before[at]))at--;
    await select(at);
    assert.equal(await page.evaluate(()=>document.getElementById('code-input').nimloEditor.large),true);
    assert((await page.inputValue('#code-input')).length<=8192);
    await page.keyboard.type('Z');const after=before.slice(0,at)+'Z'+before.slice(at);
    await textIs(after);await acknowledged(after);await selectionIs(at+1);
    await page.keyboard.press(shortcut+'+z');await textIs(before);await acknowledged(before);
    await page.keyboard.press(shortcut+'+Shift+z');await textIs(after);await acknowledged(after);
    await page.keyboard.press(shortcut+'+s');
    const until=Date.now()+5000;while(Date.now()<until && fs.readFileSync(path.join(workspace,file),'utf8')!==after)await delay(25);
    assert.equal(fs.readFileSync(path.join(workspace,file),'utf8'),after);
    assert((await page.inputValue('#code-input')).length<=8192);
  });
  await check('No rendering errors, real inference, or terminal process were introduced', async () => {
    assert.deepEqual(errors,[]);
    assert.equal(await page.evaluate(() => window.__inputReview.sent.some(message => ['ai_start','terminal_start','terminal_input'].includes(message.type))),false);
    const probes=fs.existsSync(providerLog) ? fs.readFileSync(providerLog,'utf8').trim().split('\n').filter(Boolean) : [];
    assert(probes.every(argumentsText => /(?:auth|login|status|--version)/.test(argumentsText)), 'Unexpected provider command: '+probes.join(', '));
  });
  console.log('EDITOR INPUT PASS '+engine+' '+checks.length);
})().catch(async error => {
  errors.push(sanitized(error.stack || error)); console.error('EDITOR INPUT FAIL '+sanitized(error.stack || error));
  if (page) await shot('failure').catch(() => {}); process.exitCode=1;
}).finally(async () => {
  const report={status:errors.length ? 'fail' : 'pass',date:new Date().toISOString(),browserEngine:engine,stage,checks,errors,screenshots,measurements,
    binarySha256:fs.existsSync(binary) ? crypto.createHash('sha256').update(fs.readFileSync(binary)).digest('hex') : null,
    sourceSha256:Object.fromEntries(['web/app.js','web/editor.js','web/style.css','web/index.html'].map(file => [file,crypto.createHash('sha256').update(fs.readFileSync(path.join(repo,file))).digest('hex')])),
    sourceOverrides:false,isolatedTemporaryWorkspace:true,realInferenceRequests:0,
    limits:['Composition events and modifier-fence dispatches model browser lifecycle; physical OS IMEs, operating-system shortcut defaults and mobile keyboards are not qualified.','Readonly is an explicit native-control fence check; authorization is covered by the separate session-access suite.','No memory benchmark or native dispatch-to-pixel latency claim is made.']};
  fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2)+'\n');
  if (browser) await browser.close(); await stopHost(); fs.rmSync(fixture,{recursive:true,force:true});
});
