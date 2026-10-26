'use strict';
// Keep Relay's persisted storage keys so existing tabs retain drafts and preferences.
// A running older development host can reload app.js before it can serve a new
// asset route. Preserve its existing native editor until a safe host restart.
class NimloNativeEditor {
  constructor(input) { this.input=input; this.large=false; input.nimloEditor=this; }
  get value() { return this.input.value; } set value(value) { this.input.value=value; }
  getText() { return this.value; }
  get length() { return this.value.length; } get textLength() { return this.length; }
  getSelection() { return {start:this.selectionStart,end:this.selectionEnd,direction:this.selectionDirection}; }
  get selectionStart() { return this.input.selectionStart; } get selectionEnd() { return this.input.selectionEnd; }
  get selectionDirection() { return this.input.selectionDirection; }
  setSelectionRange(...args) { this.input.setSelectionRange(...args); }
  setRangeText(...args) { this.input.setRangeText(...args); }
  get scrollTop() { return this.input.scrollTop; } set scrollTop(value) { this.input.scrollTop=value; }
  get scrollLeft() { return this.input.scrollLeft; } set scrollLeft(value) { this.input.scrollLeft=value; }
  get scrollHeight() { return this.input.scrollHeight; }
  get clientHeight() { return this.input.clientHeight; } get clientWidth() { return this.input.clientWidth; }
  viewport() { return null; } releaseIndex() {}
}
// The budget covers all project drafts in this browser tab, including failed writes.
// Stored text stays in sessionStorage; only drafts whose storage write failed stay in RAM.
class NimloDraftStore {
  constructor(storage, maxBytes=8*1024*1024, maxCount=32) {
    this.storage=storage; this.maxBytes=maxBytes; this.maxCount=maxCount;
    this.bytes=0; this.count=0; this.costs=new Map(); this.volatile=new Map();
    this.accounted=false; this.rescan();
  }
  rescan() {
    try {
      const source=this.storage(), costs=new Map(); let bytes=0, count=0;
      for (let i=0;i<source.length;i++) {
        const key=source.key(i); if (!key?.startsWith('relay-draft:')) continue;
        const value=source.getItem(key); if (value==null) continue;
        const cost=2*(key.length+value.length); bytes+=cost; count++;
        if (costs.size<this.maxCount) costs.set(key,cost);
      }
      this.bytes=bytes; this.count=count; this.costs=costs; this.accounted=true; return true;
    } catch { this.accounted=false; return false; }
  }
  ensureAccounting() { return this.accounted || this.rescan(); }
  storedCost(key) {
    if (this.costs.has(key)) return this.costs.get(key);
    try { const value=this.storage().getItem(key); return value==null ? 0 : 2*(key.length+value.length); } catch { return 0; }
  }
  usage() {
    let bytes=this.bytes, count=this.count;
    for (const [key,item] of this.volatile) { bytes+=item.cost; if (!this.storedCost(key)) count++; }
    return {bytes,count};
  }
  allows(key,data) {
    if (data==null) return true;
    if (!this.ensureAccounting()) return false;
    const cost=2*(key.length+JSON.stringify(data).length), old=this.volatile.get(key), usage=this.usage();
    // Reserve both the old durable value and a new RAM value in case the write fails.
    const bytes=usage.bytes-(old?.cost || 0)+cost;
    const count=usage.count+(!old && !this.storedCost(key) ? 1 : 0);
    return bytes<=this.maxBytes && count<=this.maxCount;
  }
  write(key,data) {
    const accounted=this.ensureAccounting(), oldCost=accounted ? this.storedCost(key) : 0;
    if (data==null) {
      try { this.storage().removeItem(key); this.volatile.delete(key); this.bytes-=oldCost; if (oldCost) this.count--; this.costs.delete(key); return true; } catch { return false; }
    }
    const encoded=JSON.stringify(data), cost=2*(key.length+encoded.length);
    try {
      if (!accounted) throw new Error('Draft storage accounting is unavailable');
      this.storage().setItem(key,encoded); this.bytes+=cost-oldCost; if (!oldCost) this.count++;
      this.costs.delete(key); if (this.costs.size<this.maxCount) this.costs.set(key,cost);
      this.volatile.delete(key); return true;
    } catch {
      this.volatile.set(key,{data,cost}); return false;
    }
  }
  read(key) {
    const pending=this.volatile.get(key); if (pending) return pending.data;
    try { return JSON.parse(this.storage().getItem(key)); } catch { return null; }
  }
  list(offset=0,limit=32) {
    const rows=[]; let position=0, more=false;
    const add=key => {
      if (position++<offset) return;
      if (rows.length>=limit) { more=true; return; }
      const data=this.read(key);
      rows.push({key,path:typeof data?.path==='string' ? data.path : 'Unrecognized draft',workspacePath:typeof data?.workspacePath==='string' ? data.workspacePath : '',valid:typeof data?.text==='string'});
    };
    for (const key of this.volatile.keys()) add(key);
    try { const storage=this.storage(); for(let i=0;i<storage.length;i++) { const key=storage.key(i); if (key?.startsWith('relay-draft:') && !this.volatile.has(key)) add(key); } } catch {}
    return {rows,more};
  }
}
(() => {
  const $ = id => document.getElementById(id);
  const app = $('app'), input = $('code-input');
  const editor=globalThis.NimloEditor ? new NimloEditor(input) : new NimloNativeEditor(input); window.nimloEditor=editor;
  const typing={doc:null,pairs:[],pending:null,syntax:null};
  // Only an open find bar retains results; dense files keep at most 10,000
  // UTF-16 offsets. Navigation beyond that prefix searches on demand.
  const fileFind={open:false,doc:null,text:null,query:'',matchCase:false,positions:[],capped:false,active:null,anchor:0,marks:0};
  const findLimit=10000;
  const mobileQuery='(max-width:760px), (pointer:coarse) and (max-height:600px) and (max-width:1100px)';
  const mobile = () => matchMedia(mobileQuery).matches;
  let layoutDevice=mobile() ? 'phone' : 'desktop';
  function preferredAiLayout(device=layoutDevice) {
    try { const saved=sessionStorage.getItem('relay-ai-layout:'+device); if (saved==='split' || saved==='tab') return saved; } catch {}
    return device==='phone' ? 'tab' : 'split';
  }
  app.dataset.aiLayout=preferredAiLayout();
  const aiOpen=() => app.dataset.aiOpen==='yes';
  const aiVisible=() => aiOpen() && (!mobile() || app.dataset.view!=='terminal') && (app.dataset.aiLayout==='split' || app.dataset.view==='ai');
  const state = {socket:null, connected:false, access:null, isHost:false, permissions:{editFiles:false,terminal:false,ai:false}, accessSettings:null, clientId:'', controllerId:null, generation:0,
    sessionId:null, textPatchVersion:0, projectId:null, projects:[], projectViews:new Map(), projectTrees:new Map(), workspace:'', workspacePath:'', pickerAvailable:false, switching:false, docs:new Map(), recentFiles:[], fileShortcutsEnabled:false, fileViews:new Map(), path:null, clients:[], directory:'', files:[],
    urls:[], internet:null, providers:[], terminal:null, ai:null, request:0, pending:new Map(), reconnect:0,
    aiContext:null, aiSettings:null, settingsDraft:null, settingsProvider:'codex', proposal:null, conflict:null, history:[], historyVersion:-1};
  let reconnectTimer, noticeTimer, editTimer, paintFrame, resizeTimer, aiFrame, editorHistoryBusy=false, composition=null;
  const connected = () => state.connected && state.access === 'shared';
  const isHost = () => connected() && state.isHost;
  const canEdit = () => connected() && !!state.permissions.editFiles;
  const canTerminal = () => connected() && !!state.permissions.terminal;
  const canAi = () => connected() && !!state.permissions.ai;
  const canRunAi = () => canAi() && canEdit() && canTerminal();
  const writable = canEdit;
  const ownsTerminal = () => canTerminal() && state.controllerId === state.clientId;
  const affirmativeApproval = choice => choice.startsWith('accept') || choice.startsWith('allow_network_');
  const hostCommands=new Set(['session_access_set','device_permissions_set','pair_create','revoke_all_devices','internet_start','internet_stop','add_project','open_project','remove_project','browse_project','ai_settings_set','ai_auth_refresh']);
  const editorCommands=new Set(['edit_file','patch_file','save_file','create_file','resolve_conflict','undo_file','redo_file']);
  function permissionError(type,fields) {
    if (hostCommands.has(type) || type==='revoke_device' && fields.targetClientId!==state.clientId) return isHost() ? null : 'Only the PC host can change this session setting.';
    if (editorCommands.has(type) || type==='close_file' && fields.discard) return canEdit() ? null : 'File editing is disabled for this device. Your pending edits are kept here.';
    if (type.startsWith('terminal_') || type==='claim_control') return canTerminal() ? null : 'Terminal access is disabled for this device.';
    if (type==='ai_start' || type==='ai_approve' && affirmativeApproval(fields.choice || '')) return canRunAi() ? null : 'AI actions require AI, file editing and terminal access.';
    if (type.startsWith('ai_') && type!=='ai_open_file') return canAi() || isHost() ? null : 'AI access is disabled for this device.';
    return null;
  }
  function accessSummary(permissions=state.permissions) {
    const enabled=[permissions.editFiles ? 'Editor' : 'Read-only editor',permissions.terminal ? 'Terminal' : null,permissions.ai ? 'AI' : null].filter(Boolean);
    return enabled.join(' · ');
  }
  function applyAccess(event) {
    if (event.permissions && ['editFiles','terminal','ai'].some(key => !!event.permissions[key]!==!!state.permissions[key])) state.accessVersion=(state.accessVersion || 0)+1;
    if ('isHost' in event) state.isHost=!!event.isHost;
    if (event.permissions) state.permissions=event.permissions;
    if (event.accessSettings) state.accessSettings=event.accessSettings;
    if (!state.permissions.editFiles) {
      clearTimeout(editTimer);
      input.readOnly=true;
      $('conflict-local-button').disabled=true; $('apply-change').disabled=true;
    }
    if (!state.permissions.terminal) {
      clearTimeout(historyTimer); historyTimer=null; state.history=[]; state.terminal=null;
      terminalOpen=false; app.dataset.terminal='closed'; $('terminal-panel').hidden=true;
      $('terminal-screen').replaceChildren(); $('terminal-command').value=''; hideTerminalKeys();
      if (app.dataset.view==='terminal') app.dataset.view='code';
    }
    if (!state.permissions.ai) {
      cancelAnimationFrame(aiFrame); state.ai=null; state.aiContext=null; state.proposal=null;
      $('messages').replaceChildren(); $('compose-context').textContent=''; $('ai-conversation-context').textContent='';
      $('review-original').textContent=''; $('review-proposed').textContent=''; $('review-description').textContent='';
      $('review-dialog').close(); $('settings-dialog').close(); app.dataset.aiOpen='no';
      if (app.dataset.view==='ai') app.dataset.view='code';
    }
  }
  async function refreshGrantedAccess(previous) {
    const terminalGranted=!previous.terminal && state.permissions.terminal, aiGranted=!previous.ai && state.permissions.ai;
    if (!terminalGranted && !aiGranted) return;
    const projectId=state.projectId, version=state.accessVersion;
    const query=new URLSearchParams({clientId:state.clientId,projectId});
    try {
      const response=await fetch('/api/bootstrap?'+query,{credentials:'same-origin',cache:'no-store'});
      if (!response.ok) return;
      const snapshot=await response.json();
      if (!state.connected || state.projectId!==projectId || state.accessVersion!==version) return;
      if (terminalGranted && state.permissions.terminal && snapshot.permissions?.terminal && !state.terminal) { state.terminal=snapshot.terminal; paintTerminal(); }
      if (aiGranted && state.permissions.ai && snapshot.permissions?.ai && !state.ai) {
        state.ai=snapshot.ai; state.aiContext=snapshot.aiContext || null;
        if (snapshot.providers) state.providers=snapshot.providers;
        queueAi();
      }
      updateControls();
    } catch(error) { report(error); }
  }
  const current = () => state.docs.get(state.path);
  const ensureProject = (projectId,generation) => { if (projectId!==state.projectId || generation!==state.generation) throw new Error('The selected project changed. Retry this action in the intended project.'); };
  function projectParent(project) {
    const segments=project.path.slice(0,project.path.lastIndexOf('/')).split('/').filter(Boolean);
    let suffix=segments.slice(-1).join('/');
    for (let length=2; length<=segments.length && state.projects.some(other => other.id!==project.id && other.name===project.name && other.path.slice(0,other.path.lastIndexOf('/')).endsWith('/'+suffix)); length++) suffix=segments.slice(-length).join('/');
    return suffix || '/';
  }
  function projectContext() {
    const project=state.projects.find(item => item.id===state.projectId);
    return project && state.projects.some(other => other.id!==project.id && other.name===project.name) ? projectParent(project)+'/'+project.name : state.workspace || 'Project';
  }
  const textOf = doc => doc.localText == null ? doc.content : doc.localText;
  const report = error => notice(error.message || String(error), true);
  const safe = fn => (...args) => Promise.resolve().then(() => fn(...args)).catch(report);
  function notice(message, error=false) {
    $('notice').textContent = message; $('notice').classList.toggle('error', error);
    $('notice').hidden = false; clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => { $('notice').hidden = true; }, error ? 12000 : 4000);
  }
  $('notice').onclick = () => { $('notice').hidden = true; };
  if (!globalThis.NimloEditor) notice('The large-file update needs a host restart. Finish your current work, then relaunch Nimlo.',true);
  function dialogError(id, error) { $(id).textContent = error.message || String(error); $(id).hidden = false; }
  function showDialog(id) { if (!$(id).open) $(id).showModal(); }
  document.querySelectorAll('[data-close]').forEach(button => button.onclick = () => $(button.dataset.close).close());
  $('join-dialog').addEventListener('cancel', event => event.preventDefault());
  $('conflict-dialog').addEventListener('cancel', event => event.preventDefault());
  function randomId() {
    if (globalThis.crypto && crypto.randomUUID) return crypto.randomUUID();
    if (globalThis.crypto && crypto.getRandomValues) return Array.from(crypto.getRandomValues(new Uint8Array(16)), n => n.toString(16).padStart(2,'0')).join('');
    return Date.now().toString(36) + Math.random().toString(36).slice(2);
  }
  try { state.clientId = sessionStorage.getItem('relay-client') || randomId(); sessionStorage.setItem('relay-client',state.clientId); state.projectId=sessionStorage.getItem('relay-project') || null; }
  catch { state.clientId = randomId(); }
  const draftStore=new NimloDraftStore(() => sessionStorage);
  const draftKey=doc => 'relay-draft:'+(doc.workspacePath || state.workspacePath)+':'+doc.path;
  const draftData=(doc,text=doc.localText) => text==null ? null : {path:doc.path,workspacePath:doc.workspacePath || state.workspacePath,text,baseRevision:doc.draftBase == null ? doc.revision : doc.draftBase,sessionId:doc.sessionId || state.sessionId};
  function allowDraftEdit(doc,text) {
    const pending=text===doc.content && (!doc.sentEdit || doc.sentEdit.text===text) ? null : text;
    return draftStore.allows(draftKey(doc),draftData(doc,pending));
  }
  function saveDraft(doc) {
    const stored=draftStore.write(draftKey(doc),draftData(doc));
    if (!stored && doc.localText!=null && !doc.storageWarned) {
      doc.storageWarned=true;
      notice('Device recovery storage is unavailable. Your pending edits remain in this tab; save them before closing it.',true);
    }
    if (stored) doc.storageWarned=false;
    return stored;
  }
  function rememberFilePath(path) {
    if (typeof path!=='string' || !path) return;
    setFileShortcuts([path,...state.recentFiles]);
  }
  function setFileShortcuts(paths) {
    const seen=new Set(), next=[]; let bytes=0;
    for (const path of paths || []) {
      if (typeof path!=='string' || !path || seen.has(path)) continue;
      const cost=new TextEncoder().encode(path).length;
      if (cost>16384) continue;
      if (next.length===32 || bytes+cost>16384) break;
      next.push(path); seen.add(path); bytes+=cost;
    }
    state.recentFiles=next;
    for (const path of state.fileViews.keys()) if (!seen.has(path) && !state.docs.has(path)) state.fileViews.delete(path);
  }
  function releaseDocumentReferences(doc) {
    if (typing.doc===doc) { typing.doc=null; typing.pairs=[]; typing.pending=null; typing.syntax=null; }
    if (codeRender.doc===doc) clearCodeCache();
    if (fileFind.doc===doc) {
      fileFind.doc=null; fileFind.text=null; fileFind.positions=[]; fileFind.active=null; fileFind.capped=false; fileFind.marks=0;
      paintFindCount();
    }
    if (state.proposal?.path===doc.path) dismissReview();
  }
  function dropDocument(doc) {
    if (state.docs.get(doc.path)!==doc) return;
    state.docs.delete(doc.path); releaseDocumentReferences(doc);
  }
  function pendingDeviceText(doc) {
    return doc.localText!=null || !!doc.inflight || !!doc.sentEdit || composition?.doc===doc;
  }
  function releaseSettledDocument(doc) {
    if (doc.closed && !pendingDeviceText(doc) && !doc.dirty && !doc.conflict && !doc.needsReview) {
      dropDocument(doc);
      if (state.path===doc.path) selectLocal(null);
      renderOpenFiles();
    }
  }
  function fileUnloaded(path) {
    const doc=state.docs.get(path); if (!doc) return;
    if (state.path===path) rememberCodeView(doc);
    // An acknowledgement may be queued while another device changes files.
    // Keep that draft until its outcome is known; an unload is never consent
    // to throw away unacknowledged text or an OS marked-text composition.
    if (pendingDeviceText(doc) || doc.dirty || doc.conflict || doc.needsReview) {
      if (composition?.doc===doc) composition.remoteChanged=true;
      if (doc.localText==null && (doc.dirty || doc.conflict)) doc.localText=doc.content;
      doc.closed=true; doc.unloaded=true;
      if (doc.localText!=null || composition?.doc===doc) doc.needsReview=true;
      saveDraft(doc);
    } else dropDocument(doc);
    if (state.conflict?.doc===doc) dismissConflict();
    if (state.path===path) selectLocal(null);
    renderOpenFiles(); updateControls();
  }
  function fileShortcuts(event) {
    state.fileShortcutsEnabled=true;
    setFileShortcuts(event.paths);
    if (Array.isArray(event.loadedPaths)) {
      const loaded=new Set(event.loadedPaths);
      for (const [path,doc] of state.docs) if (!loaded.has(path) && !doc.closed) fileUnloaded(path);
    }
    renderOpenFiles();
  }
  function trimClosedDrafts() {
    let count=[...state.docs.values()].filter(doc => doc.closed).length;
    for (const [path,doc] of state.docs) {
      if (count<=8) break;
      if (doc.closed && !doc.inflight && !doc.sentEdit && composition?.doc!==doc && saveDraft(doc)) { dropDocument(doc); count--; }
    }
  }
  function readDraft(path) { return draftStore.read('relay-draft:'+state.workspacePath+':'+path); }
  function command(type, fields={}, mutate=false) {
    if (!state.connected || !state.socket || state.socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Disconnected. Your pending edits are kept on this device.'));
    if (mutate && !connected()) return Promise.reject(new Error('Wait for this device to reconnect to the shared session.'));
    const denied=permissionError(type,fields); if (denied) return Promise.reject(new Error(denied));
    if (state.pending.size >= 48 || state.socket.bufferedAmount > 2*1024*1024) return Promise.reject(new Error('The connection is busy. Please retry.'));
    const requestId = String(++state.request), payload = Object.assign({type,requestId,projectId:state.projectId}, fields);
    if (mutate) payload.generation = state.generation;
    return new Promise((resolve,reject) => {
      const timer = setTimeout(() => { state.pending.delete(requestId); reject(new Error('The host did not respond. Pending edits remain on this device.')); },type==='browse_project' ? 130000 : 30000);
      state.pending.set(requestId,{resolve,reject,timer});
      state.socket.send(JSON.stringify(payload));
    });
  }
  function updateControls() {
    const owner = connected() && !state.switching, edit=canEdit() && !state.switching, terminal=canTerminal() && !state.switching, host=isHost() && !state.switching, ai=canAi() && !state.switching, doc = current();
    $('file-context-label').textContent=doc && doc.path.includes('/') ? 'Files · '+doc.path.slice(0,doc.path.lastIndexOf('/')) : 'Files';
    const project=state.projects.find(item => item.id===state.projectId), duplicate=project && state.projects.some(other => other.id!==project.id && other.name===project.name);
    $('project-label').textContent=state.workspace || 'Projects'; $('project-parent-label').textContent=duplicate ? projectParent(project) : '';
    $('project-parent-label').hidden=!duplicate;
    for (const id of ['projects-toggle','ai-project-toggle','terminal-project-toggle']) {
      $(id).title='Current project · '+state.workspacePath+' · Switch files, AI and terminal';
      $(id).setAttribute('aria-label','Current project '+projectContext()+' · Switch files, AI and terminal'); $(id).disabled=state.switching;
    }
    $('ai-project-label').textContent=projectContext(); $('terminal-project-label').textContent=projectContext();
    $('terminal-host').textContent=state.terminal?.running ? 'PC host' : 'Shell ended';
    $('terminal-host').title=state.terminal?.running ? 'Host shell · '+state.workspacePath : 'Start a shell in '+state.workspacePath;
    for (const id of ['new-file','files-new-file']) {
      $(id).title='New file in '+projectContext(); $(id).setAttribute('aria-label','New file in '+projectContext()); $(id).disabled=!edit;
    }
    $('find-file').disabled=!owner;
    app.dataset.controller = owner ? 'yes' : 'no';
    app.dataset.connected = state.connected ? 'yes' : 'no';
    const online=state.clients.filter(client => client.connected).length;
    $('session-count').textContent = state.connected ? String(online) : '';
    $('session-count').hidden=!state.connected || !online;
    $('connection-state').dataset.status=state.connected ? 'connected' : 'reconnecting';
    $('connection-state').disabled=!state.connected;
    const sessionLabel=state.connected ? 'Session · '+online+' connected browser'+(online===1 ? '' : 's') : 'Session · Reconnecting';
    $('connection-state').setAttribute('aria-label',sessionLabel); $('connection-state').title=sessionLabel;
    $('view-only').hidden = !state.connected || canEdit();
    $('view-only').textContent='Read only';
    if (!composition || !canEdit()) input.readOnly = !edit || !doc || !!doc.closed || !!state.conflict || state.switching;
    document.querySelectorAll('[data-edit-action]').forEach(button => {
      button.disabled=button.dataset.editAction!=='done' && (input.readOnly || app.dataset.composing==='true' || editorHistoryBusy);
    });
    $('save-button').hidden = !doc || !(doc.dirty || doc.localText != null);
    $('save-button').disabled = !edit; app.dataset.unsaved=$('save-button').hidden ? 'no' : 'yes';
    $('dirty-dot').textContent = doc && (doc.dirty || doc.localText != null) ? '●' : '';
    $('pair-phone').hidden=!state.isHost; $('pair-phone').disabled = !host || !state.accessSettings?.allowDevices;
    $('session-permissions').hidden=!state.isHost; $('session-permissions').disabled=!host;
    $('quick-add-project').hidden=!state.isHost; $('quick-add-project').disabled=!host;
    $('new-path').disabled=!edit; $('new-form').querySelector('[type=submit]').disabled=!edit;
    $('conflict-local-button').disabled=!edit; $('apply-change').disabled=!edit;
    document.querySelectorAll('.project-expand,.quick-project-select,.project-remove').forEach(button => button.disabled=!owner || state.switching || (button.classList.contains('project-remove') && (!host || state.projects.length<2)));
    $('project-path').disabled=!host || state.switching;
    $('project-submit').disabled=!host || state.switching;
    $('project-browse').hidden=!state.pickerAvailable;
    $('project-browse').disabled=!host || state.switching;
    $('project-readonly').hidden=host;
    $('project-readonly').textContent=state.connected ? 'Only the PC host can add projects.' : 'Reconnect to the host to add a project.';
    $('take-control').hidden = true; $('request-control').hidden = true;
    $('control-note').textContent = !state.connected ? 'Reconnecting to the shared PC session…' : state.isHost ? (state.accessSettings?.allowDevices ? 'Paired devices · '+accessSummary(state.accessSettings.permissions) : 'Device connections are turned off.') : 'Your access · '+accessSummary();
    const running = !!(state.terminal && state.terminal.running);
    $('terminal-command').disabled = !terminal || !running; $('terminal-run').disabled = !terminal || !running;
    $('terminal-screen').setAttribute('aria-readonly', String(!terminal));
    $('terminal-end').hidden = !terminal || !running; $('terminal-restart').hidden = running;
    $('terminal-restart').disabled = !terminal;
    document.querySelectorAll('[data-term-key]').forEach(button => button.disabled = !terminal || !running);
    const busy = state.ai && ['starting','running','awaiting_approval','cancelling'].includes(state.ai.status);
    $('ai-send').disabled = !canRunAi() || state.switching || busy; $('provider').disabled = !ai || busy; $('prompt').disabled=!canRunAi() || state.switching;
    for (const id of ['terminal-toggle','terminal-shortcut-toggle','mobile-terminal','terminal-keys-toggle']) $(id).disabled=!terminal;
    for (const id of ['ai-toggle','mobile-ai','ai-show','ai-layout-split','ai-layout-tab']) $(id).disabled=!ai;
    for (const id of ['ai-settings','ai-permission-mode','settings-open']) $(id).disabled=!host;
    for (const id of ['session-access-submit','access-allow-devices','access-edit-files','access-terminal','access-ai','access-remove-password','device-access-submit','device-edit-files','device-terminal','device-ai']) $(id).disabled=!host || !!state.accessSaving;
    $('access-password').disabled=!host || !!state.accessSaving || $('access-remove-password').checked;
    $('ai-cancel').hidden = !busy; $('ai-cancel').disabled = !ai;
    for (const id of ['settings-provider','settings-permissions','settings-model','settings-effort','settings-submit','settings-auth-refresh']) $(id).disabled=!host || !!busy || !!state.settingsLoading;
    $('settings-readonly').hidden=host && !busy;
    $('settings-readonly').textContent=host ? 'Stop the current AI turn to change these settings.' : state.connected ? 'Only the PC host can change AI settings.' : 'Reconnect to the host to change settings.';
    document.querySelectorAll('.prompt-suggestions button').forEach(button => button.disabled=!canRunAi());
    document.querySelectorAll('.review-action').forEach(button => button.disabled=!edit);
    document.querySelectorAll('.approval-actions button').forEach(button => button.disabled = !(affirmativeApproval(button.dataset.choice || '') ? canRunAi() : ai) || button.dataset.submitting==='yes');
    if ($('pair-dialog').open) paintPairing();
    renderDevices();
    const retained=Math.max(0,draftStore.usage().count-[...state.docs.values()].filter(doc => !doc.closed && doc.localText!=null).length);
    $('device-drafts').hidden=!retained; $('device-drafts-label').textContent='Device drafts · '+retained;
    renderAiContext();
    syncViewControls();
  }
  function receive(event) {
    // The host sends ordered shared events before the correlated command reply.
    // Replies settle requests only; replaying their snapshots can undo newer state.
    const replyOnly=event.requestId && ['file_state','file_closed','active_file','control'].includes(event.type);
    if (!replyOnly) applyEvent(event);
    const pending = event.requestId && state.pending.get(event.requestId);
    if (pending) {
      clearTimeout(pending.timer); state.pending.delete(event.requestId);
      if (event.type === 'error') { const error = new Error(event.message); error.code = event.code; pending.reject(error); }
      else pending.resolve(event);
    } else if (event.type === 'error') report(new Error(event.message));
  }
  function applyEvent(event) {
    // Another device can work in another project. Never paint its files or
    // processes into this device's selected project; replies still settle above.
    if (event.type==='project_files') { cacheProjectFiles(event.targetProjectId,event.directory || '',event.files || []); renderFiles(); return; }
    if (event.type!=='bootstrap' && event.projectId && event.projectId!==state.projectId) return;
    if (event.type === 'bootstrap') bootstrap(event);
    else if (event.type === 'projects_changed') {
      state.projects=event.projects || [];
      for (const cache of [state.projectViews,state.projectTrees]) for (const projectId of cache.keys()) if (!state.projects.some(project => project.id===projectId)) cache.delete(projectId);
      renderFiles();
      if (!$('project-menu').hidden) renderProjectPicker();
    }
    else if (event.type === 'control') {
      const wasWritable=writable(), previousPermissions=state.permissions;
      state.controllerId = event.controllerId; state.generation = event.generation; state.clients = event.clients; state.pairedSessions=event.pairedSessions || 0;
      state.access=event.access || state.access; applyAccess(event);
      updateControls(); renderOpenFiles(); if (writable() && !wasWritable) resumeDrafts(); refreshGrantedAccess(previousPermissions); scheduleResize();
    } else if (event.type === 'session_access') {
      applyAccess(event); updateControls();
    } else if (event.type === 'file_state') fileState(event.file,false,event.sourceClientId);
    else if (event.type === 'file_patch') filePatch(event);
    else if (event.type === 'active_file') {
      if (event.path && state.docs.has(event.path)) selectLocal(event.path);
      else if (!event.path) selectLocal(null);
    } else if (event.type === 'file_closed') fileClosed(event.path);
    else if (event.type === 'file_unloaded') fileUnloaded(event.path);
    else if (event.type === 'file_shortcuts') fileShortcuts(event);
    else if (event.type === 'files') {
      const directory=event.directory || '';
      if (directory!==state.directory) { $('file-filter').value=''; $('file-tree').scrollTop=0; }
      state.directory=directory; state.files=event.files; cacheProjectFiles(state.projectId,directory,event.files); treeFor(state.projectId).expanded.add(directory); renderFiles();
    }
    else if (event.type === 'terminal_state' && state.permissions.terminal) { state.terminal = event.terminal; if (!event.terminal.running || event.terminal.alternate_screen) state.history = []; paintTerminal(); refreshHistory(); updateControls(); }
    else if (event.type === 'terminal_history' && state.permissions.terminal) { state.history = event.lines || []; paintTerminal(); }
    else if (event.type === 'ai_state' && state.permissions.ai) { state.ai = event.ai; if ('aiContext' in event) state.aiContext=event.aiContext; if (event.providers) state.providers = event.providers; queueAi(); updateControls(); }
    else if (event.type === 'provider_state') { state.providers = event.providers; renderProviders(); renderSettingsAccount(); }
    else if (event.type === 'ai_settings') {
      const previousDefault=state.aiSettings?.defaultProvider; state.aiSettings=event.settings;
      if (event.providers) state.providers=event.providers;
      if (!state.providerChosen || event.settings.defaultProvider!==previousDefault) $('provider').value=event.settings.defaultProvider;
      renderProviders(); renderSettingsAccount();
    }
    else if (event.type === 'project_picked' && event.path) $('project-path').value=event.path;
    else if (event.type === 'pairing') renderPairing(event);
    else if (event.type === 'pairing_cancelled') { pairing=null; paintPairing(); }
    else if (event.type === 'internet_state') {
      const oldUrl=state.internet?.url;
      state.internet=event.internet;
      if (pairMode==='internet' && oldUrl!==state.internet?.url) pairing=null;
      paintPairing(); maybePair();
    }
  }
  function bootstrap(event) {
    const oldSession = state.sessionId;
    const projectChanged=!!state.workspacePath && !!event.workspacePath && (state.workspacePath!==event.workspacePath || (state.projectId && event.projectId && state.projectId!==event.projectId));
    const restoreView=projectChanged || (!state.workspacePath && state.projectViews.has(event.projectId || state.projectId));
    if (projectChanged) {
      if ($('command-dialog').open && !palette.busy) closePalette();
      vimPending=''; vimColumn=null;
      rememberProjectView();
      for (const doc of state.docs.values()) saveDraft(doc);
      clearTimeout(editTimer); clearTimeout(resizeTimer); clearTimeout(historyTimer);
      historyTimer=null; state.history=[];
      for (const doc of state.docs.values()) releaseDocumentReferences(doc);
      state.docs.clear(); state.recentFiles=[]; state.fileViews.clear(); state.path=null; state.conflict=null; state.proposal=null;
      state.terminalView=null; state.messageScrollTop=0; state.terminalFollow=true; state.autoScrollTop=null; hideTerminalKeys();
      $('file-filter').value=''; app.dataset.editing='no';
      for (const id of ['conflict-dialog','review-dialog','new-dialog']) $(id).close();
      dismissConflict(); dismissReview();
      $('prompt').value=''; $('prompt').style.height=''; closeMenu();
      $('terminal-command').value=''; terminalComposing=false;
    }
    state.sessionId = event.sessionId; state.workspace = event.workspace; state.projectId=event.projectId || state.projectId;
    state.projects=event.projects || state.projects;
    try { if (state.projectId) sessionStorage.setItem('relay-project',state.projectId); } catch {}
    state.workspacePath=event.workspacePath || state.workspacePath; state.pickerAvailable=!!event.pickerAvailable;
    const view=state.projectViews.get(state.projectId);
    if (restoreView) {
      state.fileViews=new Map(view?.views || []);
      $('prompt').value=view?.prompt || ''; $('prompt').style.height='';
      const terminalDraft=view?.terminalDraft; $('terminal-command').value=terminalDraft?.value || '';
      if (terminalDraft) $('terminal-command').setSelectionRange(terminalDraft.start,terminalDraft.end,terminalDraft.direction);
      state.terminalView=view?.terminalView || null; state.messageScrollTop=view?.messageScrollTop || 0; state.terminalFollow=view?.terminalView?.follow ?? true;
      terminalOpen=!!view?.terminalOpen; app.dataset.terminal=terminalOpen ? 'open' : 'closed'; $('terminal-panel').hidden=!terminalOpen;
      $('terminal-toggle').setAttribute('aria-expanded',String(terminalOpen)); $('terminal-shortcut-toggle').setAttribute('aria-expanded',String(terminalOpen));
      app.dataset.view=view?.mode || 'code';
      app.dataset.aiOpen=(view?.aiOpen ?? app.dataset.view==='ai') ? 'yes' : 'no';
    }
    if (event.aiSettings) { state.aiSettings=event.aiSettings; if (!state.providerChosen) $('provider').value=event.aiSettings.defaultProvider; }
    if (event.clientId) state.clientId = event.clientId;
    state.textPatchVersion=event.textPatchVersion===1 ? 1 : 0;
    state.controllerId = event.controllerId; state.generation = event.generation; state.access=event.access || null;
    applyAccess(event);
    state.clients = event.clients || []; state.pairedSessions=event.pairedSessions || 0; state.urls = event.connectUrls || event.lanUrls || [];
    state.internet=event.internet || null;
    if (state.directory) $('file-filter').value='';
    state.providers = event.providers || []; state.files = event.files || []; state.directory = '';
    state.fileShortcutsEnabled=Array.isArray(event.recentFiles);
    setFileShortcuts(event.recentFiles || (event.openFiles || []).map(file => file.path));
    const incoming = new Set((event.openFiles || []).map(file => file.path));
    for (const [path,doc] of state.docs) {
      if (!incoming.has(path)) {
        fileUnloaded(path);
      }
    }
    trimClosedDrafts();
    (event.openFiles || []).forEach(file => fileState(file, oldSession && oldSession !== event.sessionId));
    state.terminal = state.permissions.terminal ? event.terminal : null; state.ai = state.permissions.ai ? event.ai : null;
    if ('aiContext' in event) state.aiContext=state.permissions.ai ? event.aiContext : null;
    selectLocal((restoreView && state.docs.has(view?.path) ? view.path : null) || event.activePath || state.path || (event.openFiles[0] && event.openFiles[0].path) || null);
    $('workspace-name').textContent = event.workspace;
    $('workspace-name').title=state.workspacePath;
    $('project-current').textContent=state.projects.length+' project'+(state.projects.length===1 ? '' : 's')+' in this session';
    $('empty-project-hint').textContent='from '+state.workspace;
    if (state.projectId) { cacheProjectFiles(state.projectId,'',state.files); treeFor(state.projectId).expanded.add(''); }
    renderFiles(); renderOpenFiles(); renderProviders(); queueAi(); paintTerminal(); updateControls();
    if (!$('project-menu').hidden) renderProjectPicker();
    if (writable()) resumeDrafts();
    if (view && restoreView && view.directory) {
      const projectId=state.projectId, generation=state.generation;
      command('list_files',{directory:view.directory}).then(() => { if (state.projectId===projectId && state.generation===generation) { $('file-filter').value=view.filter || ''; renderFiles(); } }).catch(() => {});
    }
    if (terminalOpen && canTerminal()) { refreshHistory(); scheduleResize(); }
  }
  function rememberProjectView() {
    if (!state.projectId || !state.workspacePath) return;
    rememberCodeView();
    const views=new Map(state.fileViews); for (const doc of state.docs.values()) if (doc.view && views.size<32) views.set(doc.path,doc.view);
    while (views.size>32) views.delete(views.keys().next().value);
    state.projectViews.delete(state.projectId);
    const field=$('terminal-command'), value=field.value.slice(0,8192);
    const terminalDraft=value ? {value,start:Math.min(field.selectionStart,value.length),end:Math.min(field.selectionEnd,value.length),direction:field.selectionDirection} : null;
    state.projectViews.set(state.projectId,{path:state.path,prompt:$('prompt').value,mode:app.dataset.view,aiOpen:aiOpen(),terminalOpen,directory:state.directory,filter:$('file-filter').value,terminalView:state.terminalView,terminalDraft,messageScrollTop:state.messageScrollTop,views});
    while (state.projectViews.size>32) state.projectViews.delete(state.projectViews.keys().next().value);
  }
  function fileState(file, newSession=false, sourceClientId=null) {
    if (!file || typeof file.path!=='string') return;
    if (!state.fileShortcutsEnabled && !state.recentFiles.includes(file.path)) rememberFilePath(file.path);
    let doc = state.docs.get(file.path);
    if (!doc) {
      doc = Object.assign({localText:null,inflight:null,draftBase:null,workspacePath:state.workspacePath,sessionId:state.sessionId,view:state.fileViews.get(file.path) || state.projectViews.get(state.projectId)?.views.get(file.path)},file);
      state.docs.set(file.path,doc);
      const draft = readDraft(file.path);
      if (draft && typeof draft.text==='string' && draft.text !== file.content) {
        doc.localText = draft.text; doc.draftBase = draft.baseRevision;
        if (draft.workspacePath!==state.workspacePath || draft.sessionId !== state.sessionId || draft.baseRevision !== file.revision) doc.needsReview = true;
      } else if (draft && draft.text===file.content && draft.path===file.path && draft.workspacePath===state.workspacePath) saveDraft(doc);
    } else {
      // Direct replies can arrive before older queued broadcasts.
      if (!newSession && file.revision < doc.revision) return;
      const pending = doc.localText;
      const sent=doc.sentEdit;
      const ownEdit=sourceClientId===state.clientId && sent && sent.text===file.content && file.revision>sent.baseRevision;
      if (composition?.doc===doc && (newSession || file.revision>doc.revision)) {
        if (ownEdit && !composition.remoteChanged && !newSession) {
          composition.base=file.revision;
          if (composition.pendingText===file.content) composition.pendingText=null;
        } else composition.remoteChanged=true;
      }
      if (pending != null && pending !== file.content && (newSession || doc.closed || (file.revision !== doc.revision && !ownEdit))) doc.needsReview = true;
      Object.assign(doc,file);
      if (pending === file.content && (!sent || sent.text===file.content || file.revision>sent.baseRevision)) { doc.localText = null; doc.draftBase = null; doc.needsReview = false; }
      else if (pending != null) {
        doc.localText = pending;
        if (ownEdit && !doc.needsReview) doc.draftBase=file.revision;
      }
      doc.closed=false; doc.unloaded=false; doc.sessionId=state.sessionId; saveDraft(doc);
    }
    if (doc.path === state.path) renderEditor();
    renderOpenFiles(); updateControls();
    if (composition) return; // Do not interrupt the OS marked-text session with a modal.
    if (state.conflict?.doc===doc) {
      if (doc.needsReview || doc.conflict) showConflict(doc,doc.needsReview ? 'draft' : 'disk');
      else { dismissConflict(); updateControls(); }
    } else if (writable() && !state.conflict) {
      if (doc.needsReview) showConflict(doc,'draft');
      else if (doc.conflict) showConflict(doc,'disk');
    }
  }
  function scalarBoundary(text,offset) {
    return offset>=0 && offset<=text.length && !(offset>0 && offset<text.length && text.charCodeAt(offset-1)>=0xd800 && text.charCodeAt(offset-1)<=0xdbff && text.charCodeAt(offset)>=0xdc00 && text.charCodeAt(offset)<=0xdfff);
  }
  function textPatch(before,after) {
    let start=0, endBefore=before.length, endAfter=after.length;
    while (start<endBefore && start<endAfter && before.charCodeAt(start)===after.charCodeAt(start)) start++;
    if (!scalarBoundary(before,start) || !scalarBoundary(after,start)) start--;
    while (endBefore>start && endAfter>start && before.charCodeAt(endBefore-1)===after.charCodeAt(endAfter-1)) { endBefore--; endAfter--; }
    if (!scalarBoundary(before,endBefore) || !scalarBoundary(after,endAfter)) { endBefore++; endAfter++; }
    return {start,deleteCount:endBefore-start,insert:after.slice(start,endAfter)};
  }
  const syncingFiles=new Set();
  function filePatch(event) {
    const file=event.file, doc=file && state.docs.get(file.path), patch=event.patch;
    // A recent-file shortcut has no text to patch and must stay unloaded.
    if (!file || !doc || doc.closed || file.revision<=doc.revision) return;
    if (!doc || doc.revision!==event.baseRevision || !patch || !Number.isSafeInteger(patch.start) || !Number.isSafeInteger(patch.deleteCount) || patch.deleteCount<0 || typeof patch.insert!=='string' || !scalarBoundary(doc.content,patch.start) || !scalarBoundary(doc.content,patch.start+patch.deleteCount)) {
      const key=state.projectId+':'+file.path;
      if (!syncingFiles.has(key)) {
        const projectId=state.projectId, generation=state.generation, original=doc;
        syncingFiles.add(key);
        command('file_sync',{path:file.path},true).then(reply => {
          if (state.projectId!==projectId || state.generation!==generation || state.docs.get(file.path)!==original || original?.closed) return;
          fileState(reply.file,false,reply.sourceClientId);
        }).catch(error => {
          if (state.projectId!==projectId || state.generation!==generation || state.docs.get(file.path)!==original) return;
          if (error.code==='file_closed') fileClosed(file.path); else report(error);
        }).finally(() => syncingFiles.delete(key));
      }
      return;
    }
    fileState({...file,content:doc.content.slice(0,patch.start)+patch.insert+doc.content.slice(patch.start+patch.deleteCount)},false,event.sourceClientId);
  }
  function fileClosed(path) {
    state.recentFiles=state.recentFiles.filter(file => file!==path); state.fileViews.delete(path);
    const doc=state.docs.get(path); if (!doc) { renderOpenFiles(); return; }
    if (pendingDeviceText(doc)) {
      if (composition?.doc===doc) composition.remoteChanged=true;
      doc.closed=true; doc.unloaded=false; doc.needsReview=doc.localText!=null || composition?.doc===doc; saveDraft(doc);
      trimClosedDrafts();
      notice('Another device closed '+path+'. Your pending edits are kept here; reopen it from Files to review them.');
    } else dropDocument(doc);
    if (state.conflict?.doc===doc) dismissConflict();
    if (state.path===path) selectLocal(null);
    renderOpenFiles(); updateControls();
  }
  function selectLocal(path) {
    if (composition) { composition.nextSelection={path,projectId:state.projectId,generation:state.generation}; return; }
    const previous=current(), next=state.docs.has(path) ? path : null;
    if (previous && next!==state.path) rememberCodeView(previous);
    const changed=next!==state.path; state.path=next;
    const doc = current(), filename=doc ? doc.path.split('/').pop() : 'Files', dot=filename.lastIndexOf('.');
    $('file-stem').textContent=doc && dot>0 ? filename.slice(0,dot) : filename;
    $('file-extension').textContent=doc && dot>0 ? filename.slice(dot) : '';
    $('files-current-label').textContent=doc ? doc.path : ''; $('files-current-label').hidden=!doc;
    $('files-toggle').title = doc ? doc.path + ' · Browse files' : 'Browse files';
    $('files-toggle').setAttribute('aria-label',doc ? 'Files · '+doc.path : 'Browse files');
    renderEditor(); if (changed) restoreCodeView(doc); renderOpenFiles(); if (changed) renderFiles(); updateControls();
    if (doc && !doc.closed && writable() && !state.conflict) {
      if (doc.needsReview) showConflict(doc,'draft'); else if (doc.conflict) showConflict(doc,'disk');
    }
  }
  function rememberCodeView(doc=current()) {
    if (!doc || !editor.clientHeight) return;
    const applied=doc.appliedView, previous=doc.view;
    const sameSelection=applied && editor.selectionStart===applied.start && editor.selectionEnd===applied.end && editor.selectionDirection===applied.direction;
    // A wider or taller layout can clamp a restored offset. Keep the requested
    // position until the user scrolls or changes the native selection.
    doc.view={top:sameSelection && editor.scrollTop===applied.top ? previous?.top ?? editor.scrollTop : editor.scrollTop,
      left:sameSelection && editor.scrollLeft===applied.left ? previous?.left ?? editor.scrollLeft : editor.scrollLeft,
      start:editor.selectionStart,end:editor.selectionEnd,direction:editor.selectionDirection};
    state.fileViews.delete(doc.path); state.fileViews.set(doc.path,doc.view);
    while (state.fileViews.size>32) state.fileViews.delete(state.fileViews.keys().next().value);
  }
  function restoreCodeView(doc=current()) {
    const view=doc?.view;
    editor.setSelectionRange(view?.start || 0,view?.end || 0,view?.direction || 'none');
    editor.scrollTop=view?.top || 0; editor.scrollLeft=view?.left || 0;
    if (doc && editor.clientHeight) doc.appliedView={top:editor.scrollTop,left:editor.scrollLeft,start:editor.selectionStart,end:editor.selectionEnd,direction:editor.selectionDirection};
    paintCode();
  }
  function renderEditor() {
    if (composition) return; // Keep both marked text and native selection untouched.
    const doc = current(), value = doc ? textOf(doc) : '';
    if (typing.doc!==doc) { typing.doc=doc; typing.pairs=[]; typing.pending=null; typing.syntax=null; }
    if (editor.value !== value) {
      typing.pairs=[]; typing.pending=null; typing.syntax=null;
      const start = editor.selectionStart, end = editor.selectionEnd, direction=editor.selectionDirection, top=editor.scrollTop, left=editor.scrollLeft;
      editor.value = value; editor.setSelectionRange(Math.min(start,value.length),Math.min(end,value.length),direction);
      editor.scrollTop=top; editor.scrollLeft=left;
    }
    $('editor-placeholder').hidden = !!doc;
    updateControls(); paintCode();
  }
  const escapeHtml = text => text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  function findPattern() {
    return fileFind.query ? new RegExp(fileFind.query.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),fileFind.matchCase ? 'gu' : 'giu') : null;
  }
  function paintFindCount() {
    const n=fileFind.positions.length, index=fileFind.active==null ? -1 : fileFind.positions.indexOf(fileFind.active);
    $('file-find-count').textContent=!fileFind.query ? '' : !n ? 'No results' : fileFind.capped ? '10,000+ matches' : index<0 ? n+' match'+(n===1 ? '' : 'es') : (index+1)+' of '+n;
    $('file-find').dataset.empty=String(!!fileFind.query && !n);
    $('file-find-previous').disabled=$('file-find-next').disabled=!n;
    $('file-find-case').setAttribute('aria-pressed',String(fileFind.matchCase));
  }
  function refreshFileFind(value=current() ? textOf(current()) : '',doc=current()) {
    if (!fileFind.open) return;
    if (!doc) { closeFileFind(false); return; }
    if (fileFind.doc===doc && fileFind.text===value) return;
    fileFind.doc=doc; fileFind.text=value; fileFind.positions=[]; fileFind.capped=false; fileFind.active=null;
    const pattern=findPattern(); let match;
    if (pattern) while ((match=pattern.exec(value))) {
      if (fileFind.positions.length===findLimit) { fileFind.capped=true; break; }
      fileFind.positions.push(match.index);
    }
    const selection=editor.getSelection();
    if (pattern && selection.start!==selection.end) {
      pattern.lastIndex=selection.start; const selected=pattern.exec(value);
      if (selected?.index===selection.start && selected.index+selected[0].length===selection.end) fileFind.active=selected.index;
    }
    paintFindCount();
  }
  function selectFileMatch(start,length) {
    fileFind.active=start;
    editor.setSelectionRange(start,start+length);
    editor.reveal?.(); rememberCodeView(); paintFindCount(); paintCode();
  }
  function findFileMatch(backward=false,initial=false) {
    if (!connected() || state.switching || composition || terminalComposing || app.dataset.composing==='true' || document.querySelector('dialog[open]')) return false;
    if (!fileFind.open && !openFileFind(false)) return false;
    refreshFileFind();
    const pattern=findPattern(),text=fileFind.text; if (!pattern || !fileFind.positions.length || text==null) return false;
    const selection=editor.getSelection(), at=initial ? fileFind.anchor : backward ? selection.start : selection.end;
    let match;
    if (backward) {
      // The document is capped at 1 MiB. Scan without accumulating offsets
      // when navigating beyond the bounded result prefix.
      let previous=null,last=null;
      while ((match=pattern.exec(text))) { last=match; if (match.index<at) previous=match; }
      match=previous || last;
    } else {
      pattern.lastIndex=at; match=pattern.exec(text);
      if (!match) { pattern.lastIndex=0; match=pattern.exec(text); }
    }
    if (match) selectFileMatch(match.index,match[0].length);
    return !!match;
  }
  function openFileFind(navigate=true) {
    const doc=current();
    if (!doc || !connected() || state.switching || composition || terminalComposing || document.querySelector('dialog[open]')) return false;
    const selection=editor.getSelection(),selected=selection.end-selection.start<=1024 ? editor.value.slice(selection.start,selection.end) : '';
    const prefill=selected && !/[\r\n]/.test(selected) && (!fileFind.open || document.activeElement===input);
    closeMenu(); closeProjectPicker(); setMobileView('code');
    fileFind.anchor=selection.start; fileFind.open=true; fileFind.doc=null;
    $('file-find').hidden=false; input.closest('.codebox').dataset.find='true';
    if (prefill) $('file-find-input').value=selected;
    fileFind.query=$('file-find-input').value;
    refreshFileFind(); if (navigate && fileFind.query) findFileMatch(false,true);
    $('file-find-input').focus({preventScroll:true}); $('file-find-input').select(); paintCode();
    return true;
  }
  function closeFileFind(focus=true) {
    if (!fileFind.open) return;
    fileFind.open=false; fileFind.doc=null; fileFind.text=null; fileFind.positions=[]; fileFind.active=null; fileFind.capped=false;
    $('file-find').hidden=true; delete input.closest('.codebox').dataset.find;
    if (focus && current()) { input.focus({preventScroll:true}); editor.reveal?.(); }
    paintCode();
  }
  function navigateFileFind(backward=false) {
    if (!connected() || state.switching || composition || terminalComposing || document.querySelector('dialog[open]')) return false;
    setMobileView('code'); return findFileMatch(backward);
  }
  function changeFileFind() {
    fileFind.query=$('file-find-input').value;
    fileFind.anchor=editor.selectionStart; fileFind.text=null;
    refreshFileFind(); if (fileFind.query) findFileMatch(false,true); paintCode();
  }
  $('file-find-input').addEventListener('input',event => { if (!event.isComposing) changeFileFind(); });
  $('file-find-input').addEventListener('compositionend',changeFileFind);
  $('file-find-input').addEventListener('keydown',event => {
    if (event.isComposing) return;
    if (event.key==='Enter') { event.preventDefault(); event.stopPropagation(); findFileMatch(event.shiftKey); }
  });
  $('file-find-case').onclick=() => { fileFind.matchCase=!fileFind.matchCase; changeFileFind(); $('file-find-input').focus({preventScroll:true}); };
  $('file-find-next').onclick=() => findFileMatch();
  $('file-find-previous').onclick=() => findFileMatch(true);
  $('file-find-close').onclick=() => closeFileFind();
  $('find-in-file').onclick=openFileFind;
  $('find-in-file-shortcut').textContent=/Mac|iPhone|iPad/.test(navigator.platform) ? '⌘F' : 'Ctrl+F';
  function findLineRanges(line,offset) {
    const ranges=[],pattern=fileFind.open && fileFind.query && findPattern(); let match;
    if (pattern && fileFind.marks<300) while (ranges.length<300 && (match=pattern.exec(line))) {
      ranges.push({start:match.index,end:match.index+match[0].length,current:offset+match.index===fileFind.active});
    }
    return ranges;
  }
  function escapeFound(text,offset,ranges) {
    let html='',at=0;
    for (const range of ranges) {
      if (fileFind.marks===300) break;
      const start=Math.max(0,range.start-offset),end=Math.min(text.length,range.end-offset);
      if (end<=start) continue;
      html+=escapeHtml(text.slice(at,start))+'<mark class="find-match'+(range.current ? ' find-match-current' : '')+'">'+escapeHtml(text.slice(start,end))+'</mark>'; at=end; fileFind.marks++;
    }
    return html+escapeHtml(text.slice(at));
  }
  function highlightLine(line,absoluteOffset=0,plain=false) {
    const ranges=findLineRanges(line,absoluteOffset),escape=(text,offset) => ranges.length ? escapeFound(text,offset,ranges) : escapeHtml(text);
    if (plain) return escape(line,0);
    const pattern = /(?:\/\/.*|#.*$)|(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\x60[^\x60]*\x60)|\b(?:const|let|var|function|return|if|else|for|while|class|import|from|export|default|async|await|new|try|catch|throw|def|fn|pub|use|struct|impl|match|mut|true|false|null|None|self)\b|\b\d+(?:\.\d+)?\b/g;
    let result = '', offset = 0;
    for (const match of line.matchAll(pattern)) {
      result += escape(line.slice(offset,match.index),offset);
      const token = match[0], kind = token.startsWith('//') || token.startsWith('#') ? 'comment' : /^['"\x60]/.test(token) ? 'string' : /^\d/.test(token) ? 'number' : 'keyword';
      result += '<span class="' + kind + '">' + escape(token,match.index) + '</span>'; offset = match.index + token.length;
    }
    return result + escape(line.slice(offset),offset);
  }
  // Retain the baseline split/render work for active edits, but release line
  // arrays as soon as their document leaves the editor or the page is hidden.
  const codeRender={doc:null,text:null,lines:null,plain:false};
  function clearCodeCache() {
    Object.assign(codeRender,{doc:null,text:null,lines:null,plain:false});
    editor.releaseIndex();
  }
  function paintCode() {
    cancelAnimationFrame(paintFrame);
    if (document.hidden || codeRender.doc!==current()) clearCodeCache();
    if (document.hidden) return;
    paintFrame = requestAnimationFrame(() => {
      if (document.hidden) { clearCodeCache(); return; }
      const doc = current(); if (!doc) { if (fileFind.open) closeFileFind(false); clearCodeCache(); $('highlight').textContent=''; $('line-numbers').textContent=''; return; }
      const value = textOf(doc);
      refreshFileFind(value,doc); fileFind.marks=0;
      if (editor.large) {
        Object.assign(codeRender,{doc,text:null,lines:null,plain:false});
        const view=editor.viewport();
        document.querySelector('.codebox').dataset.plain=view.plain ? 'true' : 'false';
        $('highlight').innerHTML=view.lines.map((line,index) => {
          const html=highlightLine(line,view.starts[index],view.plain);
          return '<span style="padding-left:'+view.offsets[index]+'px">'+html+'</span>';
        }).join('\n')+'\n';
        $('highlight').style.transform='translate('+ -view.left+'px,'+(view.first*view.height-view.top)+'px)';
        $('line-numbers').textContent=Array.from({length:view.last-view.first},(_,i) => view.first+i+1).join('\n');
        $('line-numbers').style.transform='translateY('+(view.first*view.height-view.top)+'px)';
        return;
      }
      if (codeRender.doc!==doc || codeRender.text!==value) { codeRender.doc=doc; codeRender.lines=value.split('\n'); codeRender.text=value; codeRender.plain=codeRender.lines.some(line => line.length > 8192); }
      document.querySelector('.codebox').dataset.plain = codeRender.plain ? 'true' : 'false';
      const lineHeight=parseFloat(getComputedStyle(input).lineHeight);
      const start = Math.max(0,Math.floor(input.scrollTop/lineHeight)-2), end = Math.min(codeRender.lines.length,start+Math.ceil(input.clientHeight/lineHeight)+5);
      let offset=0; for (let line=0;line<start;line++) offset+=codeRender.lines[line].length+1;
      $('highlight').innerHTML = codeRender.plain ? '' : codeRender.lines.slice(start,end).map(line => { const html=highlightLine(line,offset); offset+=line.length+1; return html; }).join('\n') + '\n';
      $('highlight').style.transform = 'translate(' + -input.scrollLeft + 'px,' + (start*lineHeight-input.scrollTop) + 'px)';
      $('line-numbers').textContent = Array.from({length:end-start},(_,i) => start+i+1).join('\n');
      $('line-numbers').style.transform = 'translateY(' + (start*lineHeight-input.scrollTop) + 'px)';
    });
  }
  function beginComposition() {
    const doc=current(); if (!doc || input.readOnly) return;
    typing.pairs=[]; typing.pending=null; typing.syntax=null;
    clearTimeout(editTimer);
    composition={doc,projectId:state.projectId,generation:state.generation,sessionId:state.sessionId,
      text:editor.value,base:doc.draftBase ?? doc.revision,pendingText:doc.localText,review:!!doc.needsReview,remoteChanged:false,nextSelection:null};
    app.dataset.composing='true'; updateControls();
  }
  function endComposition() {
    const source=composition;
    if (!source) { app.dataset.composing='false'; updateControls(); return; }
    const doc=source.doc;
    if (editor.value===source.text) {
      // A cancelled/no-change composition cannot turn a newer host snapshot into an old-source draft.
      doc.localText=source.pendingText===doc.content ? null : source.pendingText;
      doc.draftBase=doc.localText==null ? null : source.base;
      doc.needsReview=doc.localText!=null && (source.review || source.remoteChanged || doc.closed);
      saveDraft(doc);
    } else edited();
    composition=null; app.dataset.composing='false';
    releaseSettledDocument(doc);
    const next=source.nextSelection;
    if (next && next.projectId===state.projectId && next.generation===state.generation) selectLocal(next.path);
    else { renderEditor(); updateControls(); }
    if (state.docs.get(doc.path)===doc && doc.workspacePath===state.workspacePath && writable() && !doc.closed) {
      if (doc.needsReview && !state.conflict) showConflict(doc,'draft');
      else if (doc.conflict && !state.conflict) showConflict(doc,'disk');
      else if (doc.localText!=null) editTimer=setTimeout(() => flush(doc).catch(report),140);
    }
    paintCode();
  }
  function edited() {
    const inputEdit=typing.pending; typing.pending=null;
    const doc = composition?.doc || current(); if (!doc || (!composition && !writable())) return;
    if (doc.localText==null && [...state.docs.values()].filter(item => item.closed).length>8) {
      editor.value=textOf(doc); notice('Device draft storage is full. Save or discard a Device draft in Session before editing another file.',true); return;
    }
    const nextText=editor.value;
    if (new TextEncoder().encode(nextText).length > 1024*1024) { editor.value = textOf(doc); notice('Files are limited to 1 MiB.',true); return; }
    if (!allowDraftEdit(doc,nextText)) { editor.value=textOf(doc); notice(draftStore.accounted ? 'Device draft storage is full. Save or discard a pending draft before adding more text.' : 'Device draft storage is unavailable. Retry when browser storage is available.',true); return; }
    trackTypedPairs(doc,textOf(doc),nextText,inputEdit);
    if (doc.localText == null) { doc.draftBase = composition?.base ?? doc.revision; doc.sessionId=composition?.sessionId || state.sessionId; }
    doc.localText = nextText === doc.content && (!doc.sentEdit || doc.sentEdit.text===nextText) ? null : nextText;
    if (composition && doc.localText!=null && (composition.remoteChanged || composition.review || doc.closed || composition.projectId!==state.projectId || composition.generation!==state.generation)) doc.needsReview=true;
    saveDraft(doc); updateControls(); paintCode(); clearTimeout(editTimer);
    if (!input.isComposing && app.dataset.composing !== 'true') editTimer = setTimeout(() => flush(doc).catch(report),140);
  }
  input.addEventListener('input',edited);
  input.addEventListener('scroll',paintCode,{passive:true});
  input.addEventListener('nimloviewportchange',paintCode);
  input.addEventListener('compositionstart',beginComposition);
  input.addEventListener('compositionend',endComposition);
  input.addEventListener('focus',() => { app.dataset.editing='yes'; if (aiOpen() && app.dataset.aiLayout==='split') { app.dataset.view='code'; syncViewControls(); } paintCode(); });
  input.addEventListener('blur',() => { rememberCodeView(); app.dataset.editing='no'; paintCode(); });
  async function flush(doc=current()) {
    clearTimeout(editTimer); if (!doc) return;
    if (composition?.doc===doc || input.isComposing && doc===current()) throw new Error('Finish the current input composition before saving or changing files.');
    const attached=() => doc.workspacePath===state.workspacePath && state.docs.get(doc.path)===doc;
    if (!attached()) throw new Error('These pending edits belong to a previous project and remain saved on this device.');
    // A prior sender can immediately flush newer typing after its reply. Join
    // that send too before using its revision, rather than issuing a duplicate.
    while (doc.inflight) await doc.inflight;
    if (composition?.doc===doc || input.isComposing && doc===current()) throw new Error('Finish the current input composition before saving or changing files.');
    if (!attached()) throw new Error('The project changed while these edits were being acknowledged.');
    if (doc.closed) throw new Error('Reopen '+doc.path+' from Files to review its pending edits.');
    if (doc.needsReview) { showConflict(doc,'draft'); throw new Error('Review your pending edits before continuing.'); }
    if (doc.localText == null) return;
    const text = doc.localText;
    doc.sentEdit={text,baseRevision:doc.draftBase ?? doc.revision};
    const fields=state.textPatchVersion===1 ? {path:doc.path,baseRevision:doc.sentEdit.baseRevision,...textPatch(doc.content,text)} : {path:doc.path,baseRevision:doc.sentEdit.baseRevision,content:text};
    doc.inflight = command(state.textPatchVersion===1 ? 'patch_file' : 'edit_file',fields,true).catch(async error => {
      saveDraft(doc);
      if (error.code === 'not_open' && attached() && doc.localText!=null) {
        doc.closed=true; doc.unloaded=true; doc.needsReview=true;
        notice('Your pending edits to '+doc.path+' are kept on this device. Reopen it from Recent files to review them.',true);
        renderOpenFiles();
      } else if (error.code === 'stale_revision' && attached() && doc.localText!=null) {
        doc.needsReview = true;
        if (!doc.closed) try { await command('open_file',{path:doc.path},true); } catch {}
        if (attached() && !doc.closed && doc.needsReview) showConflict(doc,'draft');
      }
      throw error;
    }).finally(() => { doc.inflight = null; doc.sentEdit=null; releaseSettledDocument(doc); renderOpenFiles(); updateControls(); });
    await doc.inflight;
    if (doc.localText != null && composition?.doc!==doc) await flush(doc);
  }
  function resumeDrafts() {
    for (const doc of state.docs.values()) {
      if (doc.closed) continue;
      if (doc.needsReview) { if (!state.conflict) showConflict(doc,'draft'); break; }
      if (doc.localText != null) flush(doc).catch(report);
    }
  }
  async function flushAll() { for (const doc of state.docs.values()) await flush(doc); }
  async function saveFile() {
    const projectId=state.projectId, generation=state.generation, doc = current(); if (!doc) return; await flush(doc); ensureProject(projectId,generation);
    try { await command('save_file',{path:doc.path,revision:doc.revision},true); }
    catch(error) { if (doc.conflict) showConflict(doc,'disk'); throw error; }
  }
  $('save-button').onclick = safe(saveFile);
  $('save-button').addEventListener('mousedown',event => { if (mobile() && document.activeElement===input) event.preventDefault(); });
  function lineStartAt(text,at) { return at ? text.lastIndexOf('\n',at-1)+1 : 0; }
  function indentUnit(doc=current()) {
    if (doc?.indentUnit) return doc.indentUnit;
    let tabs=0,spaces=0,twos=0,fours=0;
    // Infer once from a small prefix; no project scan or full-document cache.
    for (const line of (doc ? textOf(doc) : '').slice(0,16384).split('\n',160)) {
      if (!line.trim()) continue;
      const indent=line.match(/^[\t ]+/)?.[0];
      if (!indent) continue;
      if (indent[0]==='\t') tabs++;
      else if (indent.length>=2) {
        spaces++;
        if (indent.length%4===0) fours++;
        else if (indent.length%2===0) twos++;
      }
    }
    const unit=tabs>spaces ? '\t' : !twos && fours ? '    ' : '  ';
    if (doc && tabs+spaces) doc.indentUnit=unit;
    return unit;
  }
  function columnOf(text) {
    let column=0;
    for (const character of text) column+=character==='\t' ? 4-column%4 : 1;
    return column;
  }
  function trackTypedPairs(doc,before,after,change) {
    if (typing.doc!==doc) { typing.doc=doc; typing.pairs=[]; typing.syntax=null; return; }
    if (before===after) return;
    if (!change || change.doc!==doc || !['replace','insertText','insertFromPaste','insertLineBreak','insertParagraph','deleteContentBackward','deleteContentForward','deleteByCut'].includes(change.kind)) {
      typing.pairs=[]; typing.syntax=null; return;
    }
    let {start,end}=change;
    const delta=after.length-before.length;
    if (start===end && change.kind==='deleteContentBackward') start=editor.selectionStart;
    else if (start===end && change.kind==='deleteContentForward') end=start-delta;
    if (start>end || start<0 || end>before.length) { typing.pairs=[]; typing.syntax=null; return; }
    if (typing.syntax && start<typing.syntax.at) typing.syntax=null;
    typing.pairs=typing.pairs.filter(pair => {
      if (end<=pair.open) { pair.open+=delta; pair.close+=delta; }
      else if (start>pair.open && end<=pair.close) pair.close+=delta;
      else if (start<=pair.close) return false;
      return after[pair.open]===pair.left && after[pair.close]===pair.right;
    });
  }
  function insertText(text,start=editor.selectionStart,end=editor.selectionEnd,selection=null) {
    const doc=current(),length=editor.length;
    typing.pending={doc,start,end,kind:'replace'};
    editor.setRangeText(text,start,end,'end');
    if (selection) editor.setSelectionRange(selection.start,selection.end,selection.direction || 'none');
    edited(); editor.reveal?.();
    return current()===doc && editor.length===length+text.length-(end-start) && editor.value.slice(start,start+text.length)===text;
  }
  function indentSelection(outdent=false) {
    if (input.readOnly || app.dataset.composing==='true') return;
    const start=editor.selectionStart,end=editor.selectionEnd,direction=editor.selectionDirection,unit=indentUnit(),text=editor.value;
    const lineStart=lineStartAt(text,start);
    if (start===end && !outdent) {
      const width=unit.length;
      insertText(unit==='\t' ? unit : ' '.repeat(width-columnOf(text.slice(lineStart,start))%width));
      return;
    }
    const segment=text.slice(lineStart,end);
    const lines=segment.split('\n'); let firstDelta=0;
    const replacement=lines.map((line,index) => {
      if (index===lines.length-1 && !line && end>start && segment.endsWith('\n')) return line;
      const remove=line[0]==='\t' ? 1 : Math.min(unit==='\t' ? 4 : unit.length,line.match(/^ */)[0].length);
      const changed=outdent ? line.slice(remove) : unit+line;
      if (!index) firstDelta=changed.length-line.length;
      return changed;
    }).join('\n');
    insertText(replacement,lineStart,end,{start:Math.max(lineStart,start+firstDelta),end:Math.max(lineStart,end+replacement.length-segment.length),direction});
  }
  function codeContext(text,at) {
    const start=lineStartAt(text,at);
    if (at-start>4096) return false;
    const path=current()?.path || '',python=/\.(?:py|pyi)$/i.test(path),rust=/\.rs$/i.test(path),cpp=/\.(?:c|cc|cpp|cxx|h|hpp)$/i.test(path);
    const hashComment=/\.(?:py|pyi|sh|bash|zsh|rb|pl|ya?ml|toml)$/i.test(path);
    const scan=(from,to,state) => {
      for (let i=from;i<to;i++) {
        const character=text[i],next=i+1<to ? text[i+1] : '';
        if (state.line) { if (character==='\n') state.line=false; continue; }
        if (state.block) { if (character==='*' && next==='/') { state.block=false; i++; } continue; }
        if (state.quote) {
          if (character==='\\' && i+1<to) i++;
          else if (state.triple && character===state.quote && text.slice(i,i+3)===state.quote.repeat(3) && i+2<to) { state.quote=''; state.triple=false; i+=2; }
          else if (!state.triple && character===state.quote) state.quote='';
          else if (character==='\n' && !state.triple && state.quote.charCodeAt(0)!==96) state.quote='';
          continue;
        }
        if (!hashComment && character==='/' && next==='/' || hashComment && character==='#') { state.line=true; continue; }
        if (!hashComment && character==='/' && next==='*') { state.block=true; i++; continue; }
        if (character==="'" && rust && /[A-Za-z_]/.test(next) && text[i+2]!=="'") continue;
        if (character==="'" && cpp && /[0-9A-Fa-f]/.test(next) && /\b(?:0[xX][0-9A-Fa-f]+|[0-9][0-9A-Fa-f]*)$/.test(text.slice(Math.max(0,i-32),i))) continue;
        if (character==='"' || character==="'" || character.charCodeAt(0)===96) {
          state.quote=character;
          state.triple=python && i+2<to && text.slice(i,i+3)===character.repeat(3);
          if (state.triple) i+=2;
        }
      }
      return state;
    };
    // Retain only lexical flags at a completed line boundary. Edits before that
    // boundary invalidate it; the mutable current line is always scanned fresh.
    if (!typing.syntax || typing.syntax.at>start) typing.syntax={at:0,state:{quote:'',triple:false,block:false,line:false}};
    const cache=typing.syntax;
    cache.state=scan(cache.at,start,{...cache.state}); cache.at=start;
    const context=scan(start,at,{...cache.state});
    return !context.quote && !context.block && !context.line;
  }
  function newline() {
    const start=editor.selectionStart,end=editor.selectionEnd,text=editor.value;
    const prefix=text.slice(lineStartAt(text,start),start),indent=prefix.match(/^[\t ]*/)[0],unit=indentUnit();
    const opener=prefix.trimEnd().slice(-1),closer=({'(':')','[':']','{':'}'})[opener],code=codeContext(text,start);
    const extra=code && (closer || opener===':' && /\.(?:py|pyi)$/i.test(current()?.path || '')) ? unit : '';
    const suffix=text.slice(end,text.indexOf('\n',end)<0 ? text.length : text.indexOf('\n',end));
    const space=suffix.match(/^[\t ]*/)[0];
    if (code && closer && suffix[space.length]===closer) {
      const insertion='\n'+indent+unit+'\n'+indent,caret=start+1+indent.length+unit.length;
      insertText(insertion,start,end+space.length,{start:caret,end:caret});
    } else insertText('\n'+indent+extra,start,end);
  }
  function bracketKey(event) {
    const start=editor.selectionStart,end=editor.selectionEnd,text=editor.value,doc=current();
    if (typing.doc!==doc) { typing.doc=doc; typing.pairs=[]; typing.syntax=null; }
    const pair=typing.pairs.find(pair => pair.close===start && pair.right===event.key);
    if (start===end && pair) {
      event.preventDefault(); typing.pairs=typing.pairs.filter(item => item!==pair);
      editor.setSelectionRange(start+1,start+1); editor.reveal?.(); return true;
    }
    if (event.key==='Backspace' && start===end) {
      const empty=typing.pairs.find(pair => pair.open===start-1 && pair.close===start);
      if (empty) { event.preventDefault(); insertText('',start-1,start+1); return true; }
      const prefix=text.slice(lineStartAt(text,start),start);
      if (prefix && /^[\t ]+$/.test(prefix)) {
        const unit=indentUnit(),width=unit==='\t' ? 4 : unit.length;
        let count=1;
        if (prefix.endsWith(' ')) {
          count=columnOf(prefix)%width || width;
          count=Math.min(count,prefix.match(/ *$/)[0].length);
        }
        event.preventDefault(); insertText('',start-count,start); return true;
      }
    }
    const closer=({'(':')','[':']','{':'}'})[event.key];
    if (!closer || !codeContext(text,start)) return false;
    if (start===end && text[end] && !/[\s)\]};,]/.test(text[end])) return false;
    const selected=text.slice(start,end);
    event.preventDefault();
    if (insertText(event.key+selected+closer,start,end,{start:start+1,end:end+1,direction:editor.selectionDirection})) {
      if (typing.pairs.length===64) typing.pairs.shift();
      typing.pairs.push({open:start,close:end+1,left:event.key,right:closer});
    }
    return true;
  }
  async function historyEdit(redo=false) {
    const doc=current(); if (!doc || input.readOnly || editorHistoryBusy || composition || app.dataset.composing==='true') return;
    editorHistoryBusy=true; updateControls();
    try {
      await flush(doc);
      if (current()!==doc || doc.closed || state.conflict || state.switching) return;
      await command(redo ? 'redo_file' : 'undo_file',{path:doc.path,revision:doc.revision},true);
    } finally { editorHistoryBusy=false; updateControls(); }
  }
  editor.onHistory=redo => safe(() => historyEdit(redo))();
  function desktopHistory(redo=false) {
    if (document.activeElement!==input) return false;
    if (!document.querySelector('dialog[open]')) safe(() => historyEdit(redo))();
    return true;
  }
  document.querySelectorAll('[data-edit-action]').forEach(button => {
    button.addEventListener('mousedown',event => {
      if (document.activeElement===input && button.dataset.editAction!=='done') event.preventDefault();
    });
    button.onclick=safe(() => {
      const action=button.dataset.editAction;
      if (action==='done') { input.blur(); return; }
      if (input.readOnly || app.dataset.composing==='true') return;
      if (action==='undo' || action==='redo') return historyEdit(action==='redo');
      indentSelection(action==='outdent');
    });
  });
  input.addEventListener('keydown',event => {
    if (event.defaultPrevented) return;
    if (vimKey(event)) return;
    if (input.readOnly) {
      if (['Backspace','Delete','Enter'].includes(event.key) || (event.metaKey || event.ctrlKey) && ['z','y'].includes(event.key.toLowerCase())) event.preventDefault();
      return;
    }
    if (composition || app.dataset.composing==='true' || event.isComposing || event.keyCode===229) return;
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
      event.preventDefault(); safe(() => historyEdit(event.shiftKey))();
    } else if (event.ctrlKey && event.key.toLowerCase() === 'y') {
      event.preventDefault(); safe(() => historyEdit(true))();
    } else if (event.metaKey || event.ctrlKey || event.altKey) {
      return;
    } else if (event.key === 'Tab') {
      event.preventDefault(); indentSelection(event.shiftKey);
    } else if (event.key === 'Enter') {
      event.preventDefault(); newline();
    } else bracketKey(event);
  });
  input.addEventListener('beforeinput',event => {
    if (event.defaultPrevented || input.readOnly || composition || event.isComposing) return;
    typing.pending={doc:current(),start:editor.selectionStart,end:editor.selectionEnd,kind:event.inputType};
  });
  // Keyboard navigation shares existing host boundaries and directory metadata.
  // Only one metadata batch and at most 80 result nodes exist at a time.
  const palette={rows:[],selected:0,rendered:null,folder:null,files:null,truncated:false,stopSearch:false,project:null,generation:0,epoch:0,loading:false,load:null,busy:false,invoker:null,focus:null};
  let paletteTimer, vimEnabled=false, vimMode='normal', vimPending='', vimColumn=null;
  try { vimEnabled=sessionStorage.getItem('relay-vim')==='on'; } catch {}
  function setVim(enabled,mode='normal') {
    vimEnabled=enabled; vimMode=mode; vimPending=''; vimColumn=null;
    try { sessionStorage.setItem('relay-vim',enabled ? 'on' : 'off'); } catch {}
    $('editor-mode').hidden=!enabled; $('editor-mode').textContent=mode.toUpperCase();
    $('editor-mode').title=mode==='normal' ? 'Vim navigation · i to edit · : for commands' : 'Vim insert · Escape for navigation';
    input.dataset.vim=enabled ? mode : 'off';
  }
  setVim(vimEnabled);
  $('editor-mode').onclick=() => { setVim(true,vimMode==='normal' ? 'insert' : 'normal'); input.focus({preventScroll:true}); };
  input.addEventListener('beforeinput',event => { if (vimEnabled && vimMode==='normal') event.preventDefault(); });
  function vimKey(event) {
    if (!vimEnabled || event.isComposing || app.dataset.composing==='true') return false;
    if (event.key==='Escape') { event.preventDefault(); event.stopPropagation(); setVim(true); return true; }
    if (vimMode==='insert') return false;
    if (event.ctrlKey && !event.metaKey && event.key==='r') { event.preventDefault(); safe(() => historyEdit(true))(); return true; }
    if (event.ctrlKey || event.metaKey || event.altKey) return false;
    if (event.key==='Tab') return true; // Native focus navigation, never indentation.
    if (event.key===':') { event.preventDefault(); openPalette(':'); return true; }
    if (!current() || input.readOnly) return false;
    const key=event.key, text=editor.value; let at=editor.selectionStart;
    const previous=position => position>1 && /[\uDC00-\uDFFF]/.test(text[position-1]) ? position-2 : Math.max(0,position-1);
    const next=position => Math.min(text.length,position+(text.codePointAt(position)>0xffff ? 2 : 1));
    const start=at ? text.lastIndexOf('\n',at-1)+1 : 0, stop=text.indexOf('\n',at), end=stop<0 ? text.length : stop;
    if (key==='i' || key==='a') { event.preventDefault(); if (key==='a' && at<end) editor.setSelectionRange(next(at),next(at)); setVim(true,'insert'); return true; }
    if (key==='u') { event.preventDefault(); safe(() => historyEdit())(); return true; }
    if (key==='g' && vimPending!=='g') { event.preventDefault(); vimPending='g'; return true; }
    if (key==='g' && vimPending==='g') at=0;
    else if (key==='G') at=text.lastIndexOf('\n',Math.max(0,text.length-2))+1;
    else if (key==='h' || key==='ArrowLeft' || key==='Backspace') at=Math.max(start,previous(at));
    else if (key==='l' || key==='ArrowRight') at=Math.min(end,next(at));
    else if (key==='0' || key==='Home') at=start;
    else if (key==='$' || key==='End') at=end;
    else if (['j','k','ArrowDown','ArrowUp','Enter'].includes(key)) {
      const column=vimColumn ?? at-start; vimColumn=column;
      if (key==='k' || key==='ArrowUp') { const last=Math.max(0,start-1), first=text.lastIndexOf('\n',last-1)+1; at=Math.min(last,first+column); }
      else if (stop>=0) { const first=stop+1,last=text.indexOf('\n',first); at=Math.min(last<0 ? text.length : last,first+column); }
      if (at>0 && /[\uDC00-\uDFFF]/.test(text[at])) at--;
    } else if (key==='w') {
      const word=position => /[\p{L}\p{N}_]/u.test(String.fromCodePoint(text.codePointAt(position) || 32));
      const kind=word(at); while (at<text.length && !/\s/u.test(text[at]) && word(at)===kind) at=next(at);
      while (at<text.length && /\s/u.test(text[at])) at=next(at);
    } else if (key==='b') {
      at=previous(at); while (at>0 && /\s/u.test(text[at])) at=previous(at);
      const word=position => /[\p{L}\p{N}_]/u.test(String.fromCodePoint(text.codePointAt(position) || 32));
      const kind=word(at); while (at>0 && !/\s/u.test(text[previous(at)]) && word(previous(at))===kind) at=previous(at);
    } else { vimPending=''; if (key.length===1 || key==='Delete') { event.preventDefault(); return true; } return false; }
    event.preventDefault(); vimPending='';
    if (!['j','k','ArrowDown','ArrowUp','Enter'].includes(key)) vimColumn=null;
    editor.setSelectionRange(at,at);
    // Reveal the caret without allocating another line array or document index.
    let line=0, offset=-1; while ((offset=text.indexOf('\n',offset+1))>=0 && offset<at) line++;
    const style=getComputedStyle(input), height=parseFloat(style.lineHeight), top=line*height+parseFloat(style.paddingTop);
    if (top<editor.scrollTop) editor.scrollTop=top;
    else if (top+height>editor.scrollTop+editor.clientHeight) editor.scrollTop=top+height-editor.clientHeight;
    const left=(at-(at ? text.lastIndexOf('\n',at-1)+1 : 0))*parseFloat(style.fontSize)*.6;
    if (left<editor.scrollLeft) editor.scrollLeft=left;
    else if (left+16>editor.scrollLeft+editor.clientWidth) editor.scrollLeft=left+16-editor.clientWidth;
    rememberCodeView(); paintCode(); return true;
  }
  function openPalette(value='') {
    if (!connected() || state.switching || palette.busy || composition || terminalComposing || document.querySelector('dialog[open]')) return;
    closeMenu(true); closeProjectPicker(); palette.invoker=document.activeElement; palette.focus=null;
    palette.project=state.projectId; palette.generation=state.generation; palette.epoch++;
    clearTimeout(paletteTimer); palette.folder=null; palette.files=null; palette.rows=[]; palette.rendered=null;
    $('command-input').value=value; $('command-error').hidden=true;
    $('command-label').textContent=(value.startsWith(':') ? 'Commands · ' : 'Find file · ')+projectContext(); showDialog('command-dialog'); $('command-input').focus();
    refreshPalette();
  }
  function finishPaletteClose() {
    clearTimeout(paletteTimer); palette.epoch++; palette.folder=null; palette.files=null; palette.rows=[]; palette.rendered=null;
    $('command-results').replaceChildren(); $('command-input').value=''; $('command-input').removeAttribute('aria-activedescendant');
    const focus=palette.focus || palette.invoker; palette.focus=null; palette.invoker=null;
    if (!document.querySelector('dialog[open]')) {
      if (focus?.isConnected && focus.getClientRects().length && !focus.closest('[inert]')) { if (focus===$('prompt')) setMobileView('ai'); focus.focus({preventScroll:true}); if (focus===input) restoreCodeView(); }
      else focusWorkspace();
    }
  }
  function closePalette() {
    if (!$('command-dialog').open) return;
    $('command-dialog').close();
    // Restore before the workspace becomes interactive. A later native close
    // event must not replace a selection made after the dialog already closed.
    finishPaletteClose();
  }
  $('command-dialog').addEventListener('close',() => {
    if ($('command-dialog').open || (!palette.invoker && !palette.focus)) return;
    finishPaletteClose();
  });
  $('command-dialog').addEventListener('cancel',event => { event.preventDefault(); event.stopPropagation(); closePalette(); });
  document.querySelector('[data-close="command-dialog"]').onclick=closePalette;
  const paletteCommands=() => [
    {label:'Open file…',detail:':e path',value:':e '}, {label:'Switch project…',detail:':project name',value:':project '},
    {label:'Save file',detail:':w',action:'w'}, {label:'Close saved file',detail:':q',action:'q'},
    {label:'Go to code',detail:':code',action:'code'}, {label:'Go to AI',detail:':ai',action:'ai'},
    {label:'Go to terminal',detail:':terminal',action:'terminal'},
    {label:vimEnabled ? 'Turn Vim navigation off' : 'Turn Vim navigation on',detail:':vim '+(vimEnabled ? 'off' : 'on'),action:vimEnabled ? 'vim off' : 'vim on'}
  ].filter(command => command.action!=='w' || canEdit()).filter(command => command.action!=='ai' || canAi()).filter(command => command.action!=='terminal' || canTerminal());
  function paletteFileQuery(value) {
    const match=value.match(/^:(?:e|edit|open|files)\s+(.*)$/); if (match) return {prefix:value.slice(0,value.length-match[1].length),path:match[1]};
    return value.startsWith(':') ? null : {prefix:'',path:value};
  }
  function paintPalette(rows,total=rows.length) {
    const selected=palette.rendered===$('command-input').value ? palette.rows[palette.selected]?.entry?.path : null;
    palette.rows=rows.slice(0,80); palette.selected=0; palette.rendered=$('command-input').value; const fragment=document.createDocumentFragment();
    palette.rows.forEach((row,index) => {
      const option=document.createElement('div'); option.className='command-result'; option.id='command-result-'+index; option.setAttribute('role','option');
      const label=document.createElement('span'); label.textContent=row.label; const detail=document.createElement('small'); detail.textContent=row.detail || ''; option.append(label,detail);
      option.onmousedown=event => event.preventDefault(); option.onclick=() => { palette.selected=index; safe(activatePalette)(); }; fragment.append(option);
    });
    $('command-results').replaceChildren(fragment); selectPalette(Math.max(0,palette.rows.findIndex(row => selected && row.entry?.path===selected)));
    $('command-hint').textContent=total>80 ? 'Showing 80 matches · Type more to narrow' : rows.length ? '↑↓ choose · Enter open · Tab complete · Alt ← parent' : 'No matches · Enter a complete file path or :command';
  }
  function selectPalette(index) {
    palette.selected=palette.rows.length ? (index+palette.rows.length)%palette.rows.length : 0;
    [...$('command-results').children].forEach((row,i) => row.setAttribute('aria-selected',String(i===palette.selected)));
    const selected=$('command-results').children[palette.selected];
    if (selected) { $('command-input').setAttribute('aria-activedescendant',selected.id); selected.scrollIntoView({block:'nearest'}); }
    else $('command-input').removeAttribute('aria-activedescendant');
  }
  async function refreshPalette() {
    if (!$('command-dialog').open || palette.busy || palette.loading) return;
    clearTimeout(paletteTimer);
    const value=$('command-input').value, query=paletteFileQuery(value);
    if (/^:project\s/.test(value)) {
      const filter=value.replace(/^:project\s+/,'').toLocaleLowerCase();
      paintPalette(state.projects.filter(p => (p.name+' '+p.path).toLocaleLowerCase().includes(filter)).map(p => ({label:p.name,detail:p.path,project:p.id}))); return;
    }
    if (!query) { const filter=value.slice(1).trim().toLocaleLowerCase(), commands=paletteCommands(), exact=commands.filter(c => c.detail===value.trim()); paintPalette(exact.length ? exact : commands.filter(c => (c.label+' '+c.detail).toLocaleLowerCase().includes(filter))); return; }
    const slash=query.path.lastIndexOf('/'), folder=slash<0 ? '' : query.path.slice(0,slash), filter=query.path.slice(slash+1).toLocaleLowerCase();
    if (folder.split('/').some(p => p==='..' || p==='.') || folder.startsWith('/') || folder.includes('\\')) { paintPalette([]); return; }
    const search=slash<0 && !!filter.trim(), key=(search ? 'search:' : 'folder:')+(search ? filter : folder);
    if (search && [...query.path].length>128) { paintPalette([]); $('command-hint').textContent='Use a file name up to 128 characters, or enter its folder/path.'; return; }
    const compare=(a,b) => Number(b.name.toLocaleLowerCase().startsWith(filter))-Number(a.name.toLocaleLowerCase().startsWith(filter)) || Number(b.directory)-Number(a.directory) || a.name.localeCompare(b.name) || a.path.localeCompare(b.path);
    const paintFiles=() => {
      const files=palette.files || [], matches=search ? [...files] : files.filter(f => f.name.toLocaleLowerCase().includes(filter));
      matches.sort(compare);
      paintPalette(matches.slice(0,80).map(f => ({label:f.name+(f.directory ? '/' : ''),detail:f.directory && f.path===f.name ? 'Folder' : f.path,entry:f,prefix:query.prefix})),matches.length>=80 ? 81 : matches.length);
    };
    if (palette.folder!==key || !palette.files) {
      const epoch=palette.epoch, projectId=palette.project, generation=palette.generation; palette.loading=true; paintPalette([]); $('command-hint').textContent=search ? 'Searching project…' : 'Loading folder…';
      palette.stopSearch=false; palette.files=[]; palette.truncated=false;
      try {
        ensureProject(projectId,generation);
        let cursor=null;
        do {
          palette.load=search ? command('search_project_files',{targetProjectId:projectId,query:query.path,cursor},true) : command('list_project_files',{targetProjectId:projectId,directory:folder},true);
          const result=await palette.load;
          if (epoch!==palette.epoch || !$('command-dialog').open || $('command-input').value!==value) return; ensureProject(projectId,generation);
          palette.folder=key; palette.truncated ||= !!result.truncated;
          // Retain only the best 80 across batches, including later exact names.
          palette.files=search ? [...new Map([...palette.files,...result.files].map(file => [file.path,file])).values()].sort(compare).slice(0,80) : result.files;
          cursor=search ? result.cursor : null;
          paintFiles();
          if (cursor) $('command-hint').textContent='Searching project…'+(palette.files.length ? ' · Enter to open a result' : '');
        } while (cursor && !(palette.stopSearch && palette.files.length));
      } catch(error) { if (epoch===palette.epoch && $('command-dialog').open) dialogError('command-error',error); return; }
      finally { palette.loading=false; palette.load=null; if (epoch!==palette.epoch || $('command-input').value!==value) refreshPalette().catch(report); }
    }
    if ($('command-input').value!==value || !$('command-dialog').open) return;
    paintFiles();
    if (search && palette.truncated && palette.files.length<80) $('command-hint').textContent='Some folders could not be searched · Enter a folder/path to browse directly';
  }
  function fillPalette(value) { $('command-error').hidden=true; $('command-input').value=value; $('command-input').focus(); refreshPalette().catch(report); }
  async function activatePalette(complete=false) {
    if (palette.busy || !$('command-dialog').open) return;
    clearTimeout(paletteTimer);
    palette.stopSearch=true;
    while (palette.loading && palette.load) await palette.load.catch(() => {});
    if (palette.rendered!==$('command-input').value) await refreshPalette();
    if (palette.busy || !$('command-dialog').open) return;
    const value=$('command-input').value.trim(), row=palette.rows[palette.selected], query=paletteFileQuery(value);
    const actionText=value.slice(1).trim(), exactCommand=/^(w|write|q|quit|wq|code|ai|terminal|vim(?:\s+(?:on|off))?)$/.test(actionText);
    if (row?.value && !exactCommand) return fillPalette(row.value);
    if (row?.entry?.directory || (complete && row?.entry)) return fillPalette((row.prefix || '')+row.entry.path+(row.entry.directory ? '/' : ''));
    if (complete) return;
    const projectId=palette.project,generation=palette.generation; palette.busy=true; $('command-input').disabled=true; $('command-error').hidden=true;
    try {
      ensureProject(projectId,generation);
      if (row?.project) { await selectProject(row.project); setMobileView('code'); palette.focus=current() ? input : $('files-toggle'); }
      else if (query) { await openAiFile(row?.entry?.path || query.path); palette.focus=input; }
      else {
        const action=exactCommand ? actionText : row?.action || actionText;
        if (action==='w' || action==='write') { if (!current()) throw new Error('No file is open.'); await saveFile(); }
        else if (action==='q' || action==='quit' || action==='wq') {
          const doc=current(); if (!doc) throw new Error('No file is open.');
          if (action==='wq') await saveFile(); else await flush(doc); ensureProject(projectId,generation);
          if (doc.dirty || doc.localText!=null || doc.conflict) throw new Error('Save with :w before closing this file.');
          await command('close_file',{path:doc.path,revision:doc.revision,discard:false},true);
        } else if (action==='code' || action==='ai') { setMobileView(action); palette.focus=action==='code' ? input : $('prompt'); }
        else if (action==='terminal') { await toggleTerminal(true); palette.focus=mobile() ? $('terminal-command') : $('terminal-screen'); }
        else if (/^vim(?:\s+(on|off))?$/.test(action)) { setVim(action!=='vim off'); setMobileView('code'); palette.focus=input; }
        else throw new Error('Unknown command. Use :e path, :w, :q, :project, :ai, :terminal or :vim on/off.');
      }
      if ($('command-dialog').open) closePalette();
    } catch(error) { dialogError('command-error',error); }
    finally { palette.busy=false; $('command-input').disabled=false; if ($('command-dialog').open) $('command-input').focus(); }
  }
  $('command-form').onsubmit=event => { event.preventDefault(); safe(activatePalette)(); };
  $('command-input').oninput=() => { $('command-error').hidden=true; clearTimeout(paletteTimer); paintPalette([]); palette.rendered=null; paletteTimer=setTimeout(() => refreshPalette().catch(report),120); };
  $('command-input').addEventListener('keydown',event => {
    if (event.isComposing || palette.busy) return;
    if (event.key==='ArrowDown' || event.key==='ArrowUp') { event.preventDefault(); selectPalette(palette.selected+(event.key==='ArrowDown' ? 1 : -1)); }
    else if (event.key==='Tab' && !event.shiftKey && palette.rows[palette.selected]?.entry) { event.preventDefault(); safe(() => activatePalette(true))(); }
    else if (event.altKey && event.key==='ArrowLeft') { event.preventDefault(); const q=paletteFileQuery($('command-input').value); if (q) { const parts=q.path.split('/'); parts.pop(); parts.pop(); fillPalette(q.prefix+(parts.length ? parts.join('/')+'/' : '')); } }
  });
  function showDeviceDrafts(offset=0) {
    const list=$('draft-list'), page=draftStore.list(offset); list.replaceChildren();
    for (const row of page.rows) {
      const item=document.createElement('div'); item.className='draft-row';
      const name=document.createElement('div'), file=document.createElement('strong'), project=document.createElement('span');
      file.textContent=row.path; project.textContent=row.workspacePath; name.append(file,project); item.append(name);
      const actions=document.createElement('div'); actions.className='draft-actions';
      const download=document.createElement('button'); download.textContent='Download'; download.disabled=!row.valid;
      download.onclick=() => {
        const draft=draftStore.read(row.key); if (typeof draft?.text!=='string') return notice('This draft could not be read.',true);
        const url=URL.createObjectURL(new Blob([draft.text],{type:'text/plain;charset=utf-8'})), link=document.createElement('a');
        link.href=url; link.download=(draft.path || 'device-draft.txt').split('/').pop(); link.click(); setTimeout(() => URL.revokeObjectURL(url),1000);
      };
      const discard=document.createElement('button'); discard.textContent='Discard';
      const local=[...state.docs.values()].find(doc => draftKey(doc)===row.key); discard.disabled=!!local?.inflight;
      discard.onclick=() => {
        if (!confirm('Discard this device’s pending text for '+row.path+'?')) return;
        if (!draftStore.write(row.key,null)) return notice('Draft storage is unavailable. The saved copy was kept.',true);
        const doc=[...state.docs.values()].find(doc => draftKey(doc)===row.key);
        if (doc) {
          doc.localText=null; doc.draftBase=null; doc.needsReview=false;
          if (state.conflict?.doc===doc) dismissConflict();
          if (doc.closed) { dropDocument(doc); if (state.path===doc.path) selectLocal(null); }
        }
        renderEditor(); renderOpenFiles(); updateControls(); showDeviceDrafts(offset);
      };
      actions.append(download,discard); item.append(actions); list.append(item);
    }
    if (!page.rows.length) { const empty=document.createElement('p'); empty.textContent='No pending device drafts.'; list.append(empty); }
    $('draft-previous').hidden=!offset; $('draft-previous').onclick=() => showDeviceDrafts(Math.max(0,offset-32));
    $('draft-next').hidden=!page.more; $('draft-next').onclick=() => showDeviceDrafts(offset+32);
    showDialog('draft-dialog');
  }
  $('device-drafts').onclick=() => { closeMenu(); showDeviceDrafts(); };
  $('keyboard-commands').onclick=() => openPalette(':');
  $('find-file').onclick=() => openPalette();
  const fileShortcut=/Mac|iPhone|iPad/.test(navigator.platform) ? '⌘P' : 'Ctrl+P';
  $('find-file-shortcut').textContent=fileShortcut;
  $('find-file').title='Find file ('+fileShortcut+')';
  document.addEventListener('keydown',event => {
    if (event.defaultPrevented || event.isComposing || app.dataset.composing==='true' || !$('pc-welcome').hidden || document.querySelector('dialog[open]')) return;
    const terminalKey=$('terminal-panel').contains(event.target) && event.ctrlKey && !event.metaKey;
    const inFind=$('file-find').contains(event.target), inEditor=event.target===input;
    if (!terminalKey && (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase()==='f') {
      if (event.target!==$('prompt') && (!/^(INPUT|TEXTAREA)$/.test(event.target.tagName) || inEditor || inFind) && openFileFind()) { event.preventDefault(); event.stopPropagation(); }
      return;
    }
    if (!terminalKey && (event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase()==='g' && (inEditor || inFind || fileFind.open && !/^(INPUT|TEXTAREA)$/.test(event.target.tagName))) {
      event.preventDefault(); event.stopPropagation(); navigateFileFind(event.shiftKey); return;
    }
    if (event.key==='Escape' && fileFind.open && (inEditor || inFind)) { event.preventDefault(); event.stopPropagation(); closeFileFind(); return; }
    if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase()==='p') {
      event.preventDefault(); event.stopPropagation(); openPalette(event.shiftKey ? ':' : '');
    } else if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase()==='n' && canEdit()) {
      event.preventDefault(); event.stopPropagation(); openNewFile();
    }
  },true);
  input.addEventListener('keyup',event => {
    if (!mobile() || input.readOnly || event.isComposing || app.dataset.composing==='true' || document.activeElement!==input) return;
    if (event.key!=='End' && !(event.metaKey && event.key==='ArrowDown')) return;
    if (editor.selectionEnd!==editor.textLength || editor.selectionDirection==='backward') return;
    // Native caret scrolling can leave the final CSS line box clipped in WebKit.
    // Only explicit end navigation corrects the missing pixels; selection stays native.
    const bottom=editor.scrollHeight-parseFloat(getComputedStyle(input).paddingBottom)-editor.clientHeight;
    if (editor.scrollTop<bottom) editor.scrollTop=bottom;
  });
  // The three command popovers share dismissal logic, not document/chat state.
  const commandMenus={files:['files-menu','files-toggle'],session:['session-menu','connection-state'],ai:['ai-menu','ai-toggle']};
  let activeMenu=null;
  function openMenu(section='files',focus=false) {
    rememberCodeView(); closeProjectPicker(); closeMenu();
    if (mobile() && /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName)) document.activeElement.blur();
    const [menuId,triggerId]=commandMenus[section], menu=$(menuId);
    activeMenu=section; menu.hidden=false; $(triggerId).setAttribute('aria-expanded','true');
    if (section==='session') renderDevices();
    positionPopover(menu,$(triggerId),true);
    if (section==='files') $('file-tree').querySelector('button.active')?.scrollIntoView({block:'nearest',inline:'nearest'});
    if (focus) (section==='files' ? $('file-filter') : menu.querySelector('button:not(:disabled):not(.icon)'))?.focus({preventScroll:true});
  }
  let projectPickerInvoker=$('projects-toggle');
  function closeMenu(restoreFocus=false) {
    const invoker=activeMenu ? $(commandMenus[activeMenu][1]) : null;
    activeMenu=null;
    for (const [menuId,triggerId] of Object.values(commandMenus)) { $(menuId).hidden=true; $(triggerId).setAttribute('aria-expanded','false'); }
    $('files-menu').dataset.filtering='no';
    if (restoreFocus && invoker && !invoker.disabled) invoker.focus({preventScroll:true});
  }
  function closeProjectPicker(restoreFocus=false) {
    $('project-menu').hidden=true;
    for (const id of ['projects-toggle','ai-project-toggle','terminal-project-toggle']) $(id).setAttribute('aria-expanded','false');
    if (restoreFocus && projectPickerInvoker.isConnected && !projectPickerInvoker.disabled) projectPickerInvoker.focus({preventScroll:true});
  }
  function positionPopover(menu,invoker,topOnPhone=false) {
    menu.style.left=''; menu.style.top='';
    if (mobile() && topOnPhone) return;
    const rect=invoker.getBoundingClientRect(), viewport=window.visualViewport;
    const width=viewport?.width || innerWidth, top=viewport?.offsetTop || 0, bottom=top+(viewport?.height || innerHeight);
    menu.style.left=Math.max(10,Math.min(width-menu.offsetWidth-10,rect.left))+'px';
    menu.style.top=Math.max(top+10,Math.min(bottom-menu.offsetHeight-10,rect.bottom+8+menu.offsetHeight<=bottom-10 ? rect.bottom+8 : rect.top-menu.offsetHeight-8))+'px';
  }
  function renderProjectPicker() {
    const fragment=document.createDocumentFragment();
    for (const project of state.projects) {
      const button=document.createElement('button'); button.className='quick-project-select'; button.dataset.projectId=project.id; button.title=project.path;
      const copy=document.createElement('span'); copy.className='project-copy'; const name=document.createElement('span'); name.className='project-name'; name.textContent=project.name; copy.append(name);
      if (state.projects.some(other => other.id!==project.id && other.name===project.name)) { const parent=document.createElement('small'); parent.className='project-parent'; parent.textContent=projectParent(project); copy.append(parent); }
      button.append(fileIcon(true),copy);
      if (project.id===state.projectId) { button.setAttribute('aria-current','page'); const mark=document.createElement('span'); mark.className='project-current-mark'; mark.setAttribute('aria-label','Current project'); mark.append(symbolIcon('i-check')); button.append(mark); }
      button.setAttribute('aria-label',(project.id===state.projectId ? 'Current project ' : 'Switch files, AI and terminal to ')+project.name+' · '+project.path); button.disabled=!connected() || state.switching;
      button.onclick=safe(() => quickSelectProject(project.id)); fragment.append(button);
    }
    $('quick-project-list').replaceChildren(fragment);
  }
  function openProjectPicker(invoker=$('projects-toggle')) {
    closeMenu(); if (mobile() && /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName)) document.activeElement.blur();
    projectPickerInvoker=invoker; renderProjectPicker(); $('project-menu').hidden=false;
    for (const id of ['projects-toggle','ai-project-toggle','terminal-project-toggle']) $(id).setAttribute('aria-expanded','true');
    positionPopover($('project-menu'),invoker,true);
    $('quick-project-list').querySelector('[aria-current=page]')?.scrollIntoView({block:'nearest',inline:'nearest'});
  }
  for (const id of ['projects-toggle','ai-project-toggle','terminal-project-toggle']) {
    $(id).onclick=event => { if (!$('project-menu').hidden && projectPickerInvoker===$(id)) return closeProjectPicker(); openProjectPicker($(id)); if (event.detail===0) $('quick-project-list').querySelector('[aria-current=page]')?.focus(); };
    $(id).addEventListener('keydown',event => { if (event.key==='ArrowDown') { event.preventDefault(); openProjectPicker($(id)); $('quick-project-list').querySelector('button')?.focus(); } });
  }
  $('project-menu-close').onclick=() => closeProjectPicker(true);
  const projectPickerContains=target => $('project-menu').contains(target) || ['projects-toggle','ai-project-toggle','terminal-project-toggle'].some(id => $(id).contains(target));
  document.addEventListener('pointerdown',event => { if (!$('project-menu').hidden && !projectPickerContains(event.target)) closeProjectPicker(); });
  document.addEventListener('focusin',event => { if (!$('project-menu').hidden && !projectPickerContains(event.target)) closeProjectPicker(); });
  for (const [section,[menuId,triggerId]] of Object.entries(commandMenus)) {
    $(triggerId).onclick=event => { if (activeMenu===section) closeMenu(); else openMenu(section,event.detail===0); };
    $(triggerId).addEventListener('keydown',event => {
      if (event.key==='ArrowDown') { event.preventDefault(); openMenu(section,true); }
    });
  }
  for (const menuId of ['project-menu','files-menu','session-menu','ai-menu']) $(menuId).addEventListener('keydown',event => {
    if (!['ArrowDown','ArrowUp','Home','End'].includes(event.key) || /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName)) return;
    const buttons=[...$(menuId).querySelectorAll('button:not(:disabled)')].filter(button => button.offsetWidth && button.offsetHeight);
    if (!buttons.length) return;
    event.preventDefault(); const index=buttons.indexOf(document.activeElement);
    const next=event.key==='Home' ? 0 : event.key==='End' ? buttons.length-1 : (index+(event.key==='ArrowDown' ? 1 : buttons.length-1)+buttons.length)%buttons.length;
    buttons[next].focus({preventScroll:true}); buttons[next].scrollIntoView({block:'nearest',inline:'nearest'});
  });
  for (const id of ['menu-close','session-menu-close','ai-menu-close']) $(id).onclick=() => closeMenu(true);
  const commandMenuContains=target => activeMenu && commandMenus[activeMenu].some(id => $(id).contains(target));
  document.addEventListener('pointerdown',event => { if (activeMenu && !commandMenuContains(event.target)) closeMenu(); });
  document.addEventListener('focusin',event => { if (activeMenu && !commandMenuContains(event.target)) closeMenu(); });
  async function changeProject(type,fields) {
    if (state.switching) return;
    const projectId=state.projectId, generation=state.generation;
    state.switching=true; updateControls();
    try {
      if (canEdit()) await flushAll(); ensureProject(projectId,generation);
      const result=await command(type,fields,true);
      if (result.preferenceError) notice('Project added, but it could not be remembered: '+result.preferenceError,true);
      return result;
    } finally { state.switching=false; updateControls(); }
  }
  async function selectProject(projectId) {
    if (projectId===state.projectId) { closeMenu(); return; }
    await changeProject('select_project',{targetProjectId:projectId}); closeMenu();
  }
  async function quickSelectProject(projectId) {
    const mode=app.dataset.view, showTerminal=terminalOpen, showAi=aiOpen();
    if (projectId!==state.projectId) await selectProject(projectId);
    if (projectId!==state.projectId || !state.projects.some(project => project.id===projectId)) throw new Error('This project is no longer in the session. Choose another project.');
    closeMenu(); restoreWorkingSurface(mode,showTerminal,showAi); closeProjectPicker(true);
  }
  function restoreWorkingSurface(mode,showTerminal,showAi) {
    showAi=showAi && canAi(); showTerminal=showTerminal && canTerminal();
    if (mode==='ai' && !canAi() || mode==='terminal' && !canTerminal()) mode='code';
    app.dataset.aiOpen=showAi ? 'yes' : 'no'; app.dataset.view=mode; terminalOpen=showTerminal || mode==='terminal'; app.dataset.terminal=terminalOpen ? 'open' : 'closed'; $('terminal-panel').hidden=!terminalOpen;
    syncViewControls(); if (mode==='code') restoreCodeView(); if (aiVisible()) renderAi(true); paintCode(); paintTerminal(); scheduleResize(); updateControls();
  }
  async function openFile(path) {
    const projectId=state.projectId, generation=state.generation;
    closeMenu();
    if (mobile() || (aiOpen() && app.dataset.aiLayout==='tab')) setMobileView('code'); if (!mobile()) input.focus();
    if (writable() && !current()?.closed) await flush(); ensureProject(projectId,generation);
    // Opening selects atomically on the host. Its ordered active_file event
    // sets the shared selection; a late reply must not select over a newer peer.
    await command('open_file',{path},true); ensureProject(projectId,generation);
  }
  function treeFor(projectId) {
    if (!state.projectTrees.has(projectId)) state.projectTrees.set(projectId,{expanded:new Set(),folders:new Map(),loading:new Set(),errors:new Map()});
    return state.projectTrees.get(projectId);
  }
  let treeClock=0;
  function cacheProjectFiles(projectId,directory,files) {
    if (!projectId) return;
    const tree=treeFor(projectId), previous=tree.folders.get(directory);
    tree.folders.set(directory,{files,limit:previous?.limit || 128,used:++treeClock}); tree.errors.delete(directory);
    // Keep directory metadata bounded; inactive file contents are never fetched.
    const entries=[]; let total=0;
    for (const [id,root] of state.projectTrees) for (const [folder,cached] of root.folders) { entries.push({id,root,folder,cached}); total+=cached.files.length; }
    entries.sort((a,b) => Number(a.root.expanded.has(a.folder))-Number(b.root.expanded.has(b.folder)) || a.cached.used-b.cached.used);
    let count=entries.length;
    for (const entry of entries) {
      if (count<=12 && total<=8000) break;
      if (entry.id===projectId && entry.folder===directory) continue;
      entry.root.folders.delete(entry.folder); count--; total-=entry.cached.files.length;
    }
  }
  async function loadProjectFolder(projectId,directory='') {
    const tree=treeFor(projectId); if (tree.loading.has(directory)) return;
    tree.loading.add(directory); tree.errors.delete(directory); renderFiles();
    try { await command('list_project_files',{targetProjectId:projectId,directory},true); }
    catch(error) { tree.errors.set(directory,error.message); }
    finally { tree.loading.delete(directory); renderFiles(); }
  }
  function toggleProjectFolder(projectId,directory) {
    const tree=treeFor(projectId);
    if (tree.expanded.has(directory)) { tree.expanded.delete(directory); renderFiles(); return; }
    if ([...state.projectTrees.values()].reduce((sum,root) => sum+root.expanded.size,0)>=64) return notice('Collapse a folder before expanding another. This keeps the file menu small.');
    tree.expanded.add(directory);
    if (projectId===state.projectId) { state.directory=directory; $('file-filter').value=''; }
    if (!tree.folders.has(directory)) return loadProjectFolder(projectId,directory);
    renderFiles();
  }
  function symbolIcon(name) {
    const icon=document.createElementNS('http://www.w3.org/2000/svg','svg'), use=document.createElementNS('http://www.w3.org/2000/svg','use');
    icon.setAttribute('aria-hidden','true'); use.setAttribute('href','#'+name); icon.append(use); return icon;
  }
  function fileIcon(folder) { return symbolIcon(folder ? 'i-folder' : 'i-file'); }
  async function openProjectFile(projectId,path) {
    if (state.switching) return;
    if (projectId!==state.projectId) await selectProject(projectId);
    if (projectId!==state.projectId || !state.projects.some(project => project.id===projectId)) throw new Error('This project is no longer selected. Reopen the file from its project folder.');
    await openFile(path);
  }
  function renderFiles() {
    $('files-menu').dataset.nested=state.directory ? 'yes' : 'no';
    $('directory-label').textContent=state.directory || 'Files'; $('directory-up').hidden=!state.directory;
    const crumbs=document.createDocumentFragment(), parts=state.directory ? state.directory.split('/') : [];
    for (let index=0; index<=parts.length; index++) {
      if (index) { const separator=document.createElement('span'); separator.textContent='/'; separator.setAttribute('aria-hidden','true'); crumbs.append(separator); }
      const button=document.createElement('button'), directory=parts.slice(0,index).join('/');
      button.textContent=index ? parts[index-1] : state.workspace || 'Project'; button.title=directory || state.workspacePath;
      button.dataset.directory=directory; if (index===parts.length) button.setAttribute('aria-current','location');
      button.onclick=safe(() => { treeFor(state.projectId).expanded.add(directory); return command('list_files',{directory}); }); crumbs.append(button);
    }
    const breadcrumbs=$('directory-breadcrumbs'); breadcrumbs.replaceChildren(crumbs); breadcrumbs.scrollLeft=breadcrumbs.scrollWidth;
    const filter=$('file-filter').value.trim().toLocaleLowerCase(); $('file-filter-clear').hidden=!$('file-filter').value;
    const fragment=document.createDocumentFragment();
    let cachedBranches=0;
    const currentTree=state.projectTrees.get(state.projectId);
    if (currentTree) for (const directory of currentTree.expanded) if (currentTree.folders.has(directory)) cachedBranches++;
    const pageSize=Math.min(128,Math.max(16,Math.floor(512/Math.max(1,cachedBranches))));
    const projects=state.projects.length ? state.projects.filter(project => project.id===state.projectId) : [{id:state.projectId,name:state.workspace,path:state.workspacePath}];
    for (const project of projects) {
      const tree=treeFor(project.id), root=document.createElement('section'); root.className='project-root'+(filter ? ' filtered-root' : ''); root.dataset.projectId=project.id;
      const matches=[];
      if (filter) {
        if (!tree.expanded.has('')) continue;
        for (const [directory,cached] of tree.folders) {
          const parts=directory ? directory.split('/') : [];
          if (!tree.expanded.has(directory) || parts.some((_,index) => !tree.expanded.has(parts.slice(0,index).join('/')))) continue;
          for (const file of cached.files) if (file.name.toLocaleLowerCase().includes(filter)) matches.push(file);
        }
        if (!matches.length) continue;
      }
      const heading=document.createElement('div'); heading.className='project-root-heading';
      const expand=document.createElement('button'); expand.className='project-expand'; expand.dataset.projectId=project.id; expand.title=(tree.expanded.has('') ? 'Collapse ' : 'Expand ')+project.name;
      expand.setAttribute('aria-label',(tree.expanded.has('') ? 'Collapse ' : 'Expand ')+project.name+' folder'); expand.setAttribute('aria-expanded',String(tree.expanded.has('')));
      const arrow=document.createElement('span'); arrow.className='tree-arrow'; arrow.textContent=tree.expanded.has('') ? '⌄' : '›'; arrow.setAttribute('aria-hidden','true');
      const copy=document.createElement('span'); copy.className='project-copy'; const name=document.createElement('span'); name.className='project-name'; name.textContent=project.name; copy.append(name);
      if (state.projects.some(other => other.id!==project.id && other.name===project.name)) {
        const parent=document.createElement('small'); parent.className='project-parent';
        parent.textContent=projectParent(project); parent.title=project.path; copy.append(parent);
      }
      expand.append(arrow,fileIcon(true),copy); expand.onclick=safe(() => toggleProjectFolder(project.id,''));
      const remove=document.createElement('button'); remove.className='icon project-remove'; remove.textContent='×'; remove.title='Remove from session'; remove.setAttribute('aria-label','Remove '+project.name+' from session');
      remove.onclick=safe(async () => { if (confirm('Remove '+project.name+' from this session? Files on disk are kept. All paired devices lose access to this project.')) await changeProject('remove_project',{targetProjectId:project.id}); });
      remove.hidden=!state.isHost; heading.append(expand,remove); root.append(heading);
      if (filter) {
        const offset=Math.min(tree.filterOffset || 0,Math.max(0,matches.length-1));
        if (offset) { const previous=document.createElement('button'); previous.className='tree-note'; previous.textContent='Previous matches'; previous.onclick=() => { tree.filterOffset=Math.max(0,offset-pageSize); renderFiles(); }; root.append(previous); }
        for (const file of matches.slice(offset,offset+pageSize)) {
          const button=document.createElement('button'); button.className='tree-entry filtered-entry'+(project.id===state.projectId && file.path===state.path ? ' active' : ''); button.dataset.path=file.path; button.dataset.projectId=project.id; button.dataset.kind=file.directory ? 'directory' : 'file'; button.title=project.path+'/'+file.path;
          const kind=document.createElement('span'); kind.className='file-kind'; kind.append(fileIcon(file.directory));
          const label=document.createElement('span'); label.className='entry-name'; const name=document.createElement('span'); name.textContent=file.name; label.append(name);
          if (file.path.includes('/')) { const path=document.createElement('small'); path.className='file-result-path'; path.textContent=file.path.slice(0,file.path.lastIndexOf('/')); label.append(path); }
          button.append(kind,label); button.setAttribute('aria-label',(file.directory ? 'Open folder ' : 'Open file ')+file.name);
          button.onclick=safe(() => file.directory ? toggleProjectFolder(project.id,file.path) : openProjectFile(project.id,file.path)); root.append(button);
        }
        if (matches.length>offset+pageSize) { const more=document.createElement('button'); more.className='tree-note'; more.textContent='Next matches · '+(matches.length-offset-pageSize)+' remaining'; more.onclick=() => { tree.filterOffset=offset+pageSize; renderFiles(); }; root.append(more); }
        fragment.append(root); continue;
      }
      function branch(directory,depth) {
        if (!tree.expanded.has(directory)) return;
        const cached=tree.folders.get(directory);
        if (!cached) {
          const retry=document.createElement('button'); retry.className='tree-note'; retry.style.setProperty('--tree-depth',Math.min(depth,4)*10+'px');
          retry.textContent=tree.loading.has(directory) ? 'Loading…' : tree.errors.has(directory) ? 'Retry loading this folder' : 'Load folder'; retry.disabled=tree.loading.has(directory); retry.title=tree.errors.get(directory) || '';
          retry.onclick=safe(() => loadProjectFolder(project.id,directory)); root.append(retry); return;
        }
        const files=cached.files.filter(file => !filter || file.name.toLocaleLowerCase().includes(filter) || (file.directory && tree.expanded.has(file.path)));
        const offset=Math.min(cached.offset || 0,Math.max(0,files.length-1)), size=Math.min(cached.limit,pageSize);
        if (offset) { const previous=document.createElement('button'); previous.className='tree-note'; previous.style.setProperty('--tree-depth',Math.min(depth,4)*10+'px'); previous.textContent='Previous files'; previous.onclick=() => { cached.offset=Math.max(0,offset-size); renderFiles(); }; root.append(previous); }
        for (const file of files.slice(offset,offset+size)) {
          const button=document.createElement('button'); button.className='tree-entry'+(project.id===state.projectId && file.path===state.path ? ' active' : ''); button.dataset.path=file.path; button.dataset.projectId=project.id;
          button.dataset.kind=file.directory ? 'directory' : 'file';
          button.style.setProperty('--tree-depth',Math.min(depth,4)*10+'px'); button.title=project.path+'/'+file.path;
          const kind=document.createElement('span'); kind.className='file-kind'; kind.append(fileIcon(file.directory));
          const label=document.createElement('span'); label.className='entry-name'; label.textContent=file.name;
          if (file.directory) { const chevron=document.createElement('span'); chevron.className='tree-arrow'; chevron.textContent=tree.expanded.has(file.path) ? '⌄' : '›'; chevron.setAttribute('aria-hidden','true'); button.append(chevron); button.setAttribute('aria-expanded',String(tree.expanded.has(file.path))); }
          button.append(kind,label); button.setAttribute('aria-label',(file.directory ? 'Open folder ' : 'Open file ')+file.name);
          button.onclick=safe(() => file.directory ? toggleProjectFolder(project.id,file.path) : openProjectFile(project.id,file.path)); root.append(button);
          if (file.directory) branch(file.path,depth+1);
        }
        if (files.length>offset+size) { const more=document.createElement('button'); more.className='tree-note'; more.style.setProperty('--tree-depth',Math.min(depth,4)*10+'px'); more.textContent='Next '+Math.min(size,files.length-offset-size)+' files · '+(files.length-offset-size)+' remaining'; more.onclick=() => { cached.offset=offset+size; renderFiles(); }; root.append(more); }
        if (!files.length) { const empty=document.createElement('p'); empty.className='control-note tree-note'; empty.style.setProperty('--tree-depth',Math.min(depth,4)*10+'px'); empty.textContent=filter ? 'No files match this filter.' : 'This folder is empty.'; root.append(empty); }
      }
      branch('',0); fragment.append(root);
    }
    if (filter && !fragment.childNodes.length) { const empty=document.createElement('p'); empty.className='control-note'; empty.textContent='No files match in the expanded folders.'; fragment.append(empty); }
    $('file-tree').replaceChildren(fragment); updateControls();
  }
  $('file-filter').addEventListener('input',() => { treeFor(state.projectId).filterOffset=0; $('files-menu').scrollTop=0; $('file-tree').scrollTop=0; renderFiles(); });
  $('file-filter').addEventListener('focus',() => {
    $('files-menu').dataset.filtering='yes'; $('files-menu').scrollTop=0;
    const breadcrumbs=$('directory-breadcrumbs'); breadcrumbs.scrollLeft=breadcrumbs.scrollWidth;
  });
  $('file-filter-clear').addEventListener('mousedown',event => { if (document.activeElement===$('file-filter')) event.preventDefault(); });
  $('file-filter-clear').onclick=() => { $('file-filter').value=''; renderFiles(); };
  $('directory-up').onclick=safe(() => command('list_files',{directory:state.directory.split('/').slice(0,-1).join('/')}));
  let closingFile=false;
  function askCloseFile(doc) {
    const dialog=$('close-file-dialog'), form=dialog.querySelector('form');
    $('close-file-description').textContent='Save changes to '+doc.path+' before closing?';
    $('close-file-save').disabled=!canEdit();
    dialog.returnValue='cancel';
    const decision=new Promise(resolve => {
      const finish=value => {
        form.removeEventListener('submit',submit); dialog.removeEventListener('cancel',cancel); dialog.removeEventListener('close',closed);
        if (dialog.open) dialog.close(value);
        resolve(value);
      };
      const submit=event => { event.preventDefault(); finish(event.submitter?.value || 'cancel'); };
      const cancel=event => { event.preventDefault(); finish('cancel'); };
      // A queued close event from the previous prompt must not dismiss a new one.
      const closed=() => { if (!dialog.open) finish(dialog.returnValue); };
      form.addEventListener('submit',submit); dialog.addEventListener('cancel',cancel); dialog.addEventListener('close',closed);
    });
    showDialog('close-file-dialog');
    $('close-file-save').focus();
    return decision;
  }
  async function closeFile(filePath=state.path) {
    if (!filePath || closingFile || !connected() || state.switching || composition || terminalComposing || app.dataset.composing==='true' || document.querySelector('dialog[open]')) return false;
    const restoreFocus=!mobile() || document.activeElement===input;
    closingFile=true;
    try {
      const projectId=state.projectId, generation=state.generation;
      const latest=state.docs.get(filePath);
      if (!latest) { await command('close_file',{path:filePath,revision:0,discard:false},true); return true; }
      if (latest.closed) {
        if (pendingDeviceText(latest) && !confirm('Discard the pending edits kept on this device for '+filePath+'?')) return false;
        if (latest.inflight || composition?.doc===latest) throw new Error('Wait for the pending edit before closing this draft.');
        const recent=state.recentFiles.includes(filePath);
        latest.localText=null; latest.needsReview=false; latest.draftBase=null;
        if (!saveDraft(latest)) throw new Error('Draft storage is unavailable. The saved copy was kept.');
        fileClosed(filePath);
        if (recent) try { await command('close_file',{path:filePath,revision:0,discard:false},true); } catch(error) { if (error.code!=='not_open') throw error; }
        return true;
      }
      await flush(latest); ensureProject(projectId,generation);
      let revision=latest.revision, discard=false;
      if (latest.dirty || latest.conflict) {
        closeMenu(); closeProjectPicker();
        const decision=await askCloseFile(latest);
        if (decision!=='save' && decision!=='discard') return false;
        ensureProject(projectId,generation);
        if (state.docs.get(filePath)!==latest || latest.closed || latest.revision!==revision || pendingDeviceText(latest)) throw new Error('This file changed while you were deciding. Review it before closing again.');
        if (decision==='save') {
          try {
            const saved=await command('save_file',{path:filePath,revision},true);
            ensureProject(projectId,generation); revision=saved.file.revision;
          } catch(error) { if (latest.conflict) showConflict(latest,'disk'); throw error; }
        } else discard=true;
      }
      await command('close_file',{path:filePath,revision,discard},true);
      return true;
    } finally {
      closingFile=false;
      if (restoreFocus && current() && !document.querySelector('dialog[open]')) input.focus({preventScroll:true});
    }
  }
  function renderOpenFiles() {
    // Recent entries retain their path and view position, never file contents.
    // Unsaved host buffers and pending device drafts stay visible alongside them.
    const paths=[...new Set([...state.recentFiles,...state.docs.keys()])];
    $('files-menu').dataset.hasOpenFiles=paths.length ? 'yes' : 'no';
    const fragment=document.createDocumentFragment();
    for (const filePath of paths) {
      const doc=state.docs.get(filePath), dirty=doc && (doc.dirty || doc.localText!=null || doc.conflict || doc.needsReview);
      const status=doc?.closed ? 'draft' : dirty ? 'unsaved' : filePath===state.path ? 'active' : 'recent';
      const row=document.createElement('div'); row.className='open-file'+(filePath===state.path ? ' active' : ''); row.dataset.path=filePath; row.dataset.state=status;
      const button=document.createElement('button'); button.title=filePath+(doc?.closed ? ' · Review device draft' : !doc ? ' · Reopen from disk' : ''); button.onclick=safe(() => openFile(filePath));
      if (filePath===state.path) button.setAttribute('aria-current','page');
      const copy=document.createElement('span'); copy.className='open-file-copy';
      const name=document.createElement('span'); name.className='open-file-name'; name.textContent=filePath.split('/').pop(); copy.append(name);
      if (status!=='recent') { const badge=document.createElement('small'); badge.className='open-file-status'; badge.textContent=status==='draft' ? 'Device draft' : status==='unsaved' ? 'Unsaved' : 'Active'; copy.append(badge); }
      const path=document.createElement('small'); path.className='open-file-path'; path.textContent=filePath.includes('/') ? filePath.slice(0,filePath.lastIndexOf('/')) : state.workspace || 'Project'; button.append(copy,path);
      const close=document.createElement('button'); close.className='icon'; close.textContent='×'; close.setAttribute('aria-label',(!doc ? 'Remove from recent files ' : 'Close ')+filePath); close.disabled=!connected() || !!doc?.inflight || !!doc && composition?.doc===doc || !canEdit() && !!dirty;
      close.onclick=safe(() => closeFile(filePath));
      row.append(button,close); fragment.append(row);
    }
    if (!fragment.childNodes.length) { const empty=document.createElement('p'); empty.className='control-note'; empty.textContent='Choose a file from Files to open it.'; fragment.append(empty); }
    $('open-files').replaceChildren(fragment);
  }
  function openNewFile() {
    if (!canEdit() || state.switching || composition || terminalComposing || document.querySelector('dialog[open]')) return;
    closeMenu(); closeProjectPicker(); $('new-error').hidden=true; $('new-path').value=state.directory ? state.directory+'/' : ''; $('new-project-label').textContent='Path in '+projectContext(); showDialog('new-dialog'); $('new-path').focus();
  }
  $('new-file').onclick=openNewFile;
  $('files-new-file').onclick=openNewFile;
  $('new-form').onsubmit=async event => {
    event.preventDefault(); $('new-error').hidden=true;
    const projectId=state.projectId, generation=state.generation;
    try { await flush(); ensureProject(projectId,generation); const path=$('new-path').value.trim(); await command('create_file',{path},true); ensureProject(projectId,generation); setMobileView('code'); $('new-dialog').close(); await command('list_files',{directory:state.directory}); if (!mobile()) input.focus(); }
    catch(error) { dialogError('new-error',error); }
  };
  function openProjectDialog() {
    closeMenu(); closeProjectPicker(); $('project-error').hidden=true; $('project-path').value='';
    $('project-current').textContent=state.projects.length+' project'+(state.projects.length===1 ? '' : 's')+' in this session'; updateControls(); showDialog('project-dialog');
    if (isHost()) { $('project-path').focus(); $('project-path').select(); }
  }
  $('quick-add-project').onclick=openProjectDialog;
  $('empty-open-project').onclick=() => openMenu();
  $('project-browse').onclick=async () => {
    $('project-error').hidden=true; $('project-browse').disabled=true;
    try { const result=await command('browse_project',{},true); if (result.path) $('project-path').value=result.path; }
    catch(error) { dialogError('project-error',error); }
    finally { updateControls(); }
  };
  $('project-form').onsubmit=async event => {
    event.preventDefault(); $('project-error').hidden=true;
    try {
      const path=$('project-path').value.trim();
      await changeProject('add_project',{path}); $('project-dialog').close();
    } catch(error) { dialogError('project-error',error); }
    finally { state.switching=false; updateControls(); }
  };
  function storeSettingsFields() {
    if (!state.settingsDraft) return;
    const selected=state.settingsDraft[state.settingsProvider];
    selected.model=$('settings-model').value.trim() || null;
    if (state.settingsProvider==='codex') selected.reasoningEffort=$('settings-effort').value.trim() || null;
    state.settingsDraft.permissionMode=$('settings-permissions').value;
  }
  function showSettingsFields() {
    if (!state.settingsDraft) return;
    const selected=state.settingsDraft[state.settingsProvider];
    $('settings-model').value=selected.model || '';
    $('settings-effort').value=state.settingsDraft.codex.reasoningEffort || '';
    $('settings-permissions').value=state.settingsDraft.permissionMode || 'ask';
    $('settings-effort-row').hidden=state.settingsProvider!=='codex'; $('settings-effort-row').parentElement.dataset.effort=state.settingsProvider==='codex' ? 'yes' : 'no'; renderPermissionHelp(); renderSettingsAccount();
  }
  function renderPermissionHelp() {
    $('settings-permission-help').textContent=$('settings-permissions').value==='fullAccess'
      ? 'Run commands and change files with your PC’s permissions, including outside projects, without asking.'
      : 'Ask before changes and actions outside the allowed scope.';
  }
  $('settings-permissions').onchange=renderPermissionHelp;
  function renderSettingsAccount() {
    if (!$('settings-dialog').open) return;
    const id=state.settingsProvider, provider=state.providers.find(item => item.id===id);
    const auth=provider?.auth || 'unknown', name=provider?.name || (id==='claude' ? 'Claude Code' : 'Codex');
    const connected=auth==='signed_in';
    const status=!provider ? 'Checking sign-in…' : !provider.available ? name+' is not installed on the host' : connected ? provider.detail.includes('ChatGPT') ? 'Connected with ChatGPT' : provider.detail.includes('Claude account') ? 'Connected with Claude account' : 'Connected on the host' : auth==='signed_out' ? 'Sign in on the host PC' : 'Sign-in status unknown';
    if ($('settings-auth').textContent!==status) $('settings-auth').textContent=status;
    $('settings-auth').title=provider?.detail || ''; $('settings-connection').dataset.status=provider && !provider.available ? 'unavailable' : auth;
    const details=$('settings-account-details');
    if (details.dataset.provider!==id || details.dataset.auth!==auth) { details.open=!!provider && !connected; details.dataset.provider=id; details.dataset.auth=auth; }
    $('settings-login').textContent=provider?.loginCommand || (id==='claude' ? 'claude auth login' : 'codex login');
    $('settings-help').href=provider?.helpUrl || (id==='claude' ? 'https://code.claude.com/docs/en/authentication' : 'https://learn.chatgpt.com/docs/auth');
  }
  async function openSettings() {
    if (!isHost()) throw new Error('Only the PC host can change AI settings.');
    closeMenu(true); state.settingsDraft=null; state.settingsLoading=true; $('settings-error').hidden=true; $('settings-account-details').dataset.provider=''; showDialog('settings-dialog'); updateControls();
    try {
      const result=await command('ai_settings_get');
      state.settingsDraft=JSON.parse(JSON.stringify(result.settings));
      state.settingsProvider=result.settings.defaultProvider; $('settings-provider').value=state.settingsProvider;
      showSettingsFields();
      if (result.settingsError) dialogError('settings-error',new Error(result.settingsError));
    } catch(error) { dialogError('settings-error',error); }
    finally { state.settingsLoading=false; updateControls(); }
  }
  $('settings-open').onclick=safe(openSettings);
  $('ai-settings').onclick=safe(openSettings);
  $('ai-permission-mode').onclick=safe(openSettings);
  $('settings-provider').onchange=() => {
    storeSettingsFields(); state.settingsProvider=$('settings-provider').value;
    if (state.settingsDraft) state.settingsDraft.defaultProvider=state.settingsProvider;
    showSettingsFields();
  };
  $('settings-copy-login').onclick=safe(async () => {
    const text=$('settings-login').textContent;
    if (!navigator.clipboard) return notice('Run '+text+' in a terminal on the host PC.');
    try { await navigator.clipboard.writeText(text); notice('Sign-in command copied. Run it on the host PC.'); }
    catch { notice('Run '+text+' in a terminal on the host PC.'); }
  });
  $('settings-auth-refresh').onclick=async () => {
    $('settings-error').hidden=true;
    try { await command('ai_auth_refresh',{},true); notice('Checking installed CLIs and sign-in status on the host PC.'); }
    catch(error) { dialogError('settings-error',error); }
  };
  $('settings-form').onsubmit=async event => {
    event.preventDefault(); $('settings-error').hidden=true;
    try {
      if (!state.settingsDraft) throw new Error('Wait for settings to load from the host.');
      storeSettingsFields(); await command('ai_settings_set',{settings:state.settingsDraft},true);
      state.providerChosen=false; $('provider').value=state.aiSettings.defaultProvider; $('settings-dialog').close(); notice('AI settings saved.');
    } catch(error) { dialogError('settings-error',error); $('settings-error').scrollIntoView({block:'nearest'}); }
  };
  let deviceAccessTarget=null, accessInvoker=null;
  function permissionFields(prefix) {
    return {editFiles:$(prefix+'-edit-files').checked,terminal:$(prefix+'-terminal').checked,ai:$(prefix+'-ai').checked};
  }
  function setPermissionFields(prefix,permissions) {
    $(prefix+'-edit-files').checked=!!permissions.editFiles;
    $(prefix+'-terminal').checked=!!permissions.terminal;
    $(prefix+'-ai').checked=!!permissions.ai;
  }
  function openSessionAccess() {
    if (!isHost() || !state.accessSettings) return;
    accessInvoker=$('session-permissions'); closeMenu();
    const settings=state.accessSettings;
    $('access-allow-devices').checked=settings.allowDevices;
    setPermissionFields('access',settings.permissions);
    $('access-password').value=''; $('access-remove-password').checked=false;
    $('access-password-status').textContent=settings.passwordSet ? 'Set' : 'Not set';
    $('access-password').placeholder=settings.passwordSet ? 'New password (optional)' : 'Set a password (optional)';
    $('access-remove-password-row').hidden=!settings.passwordSet;
    $('session-access-error').hidden=true;
    showDialog('session-access-dialog'); updateControls();
    if (settings.error) dialogError('session-access-error',settings.error);
  }
  $('session-permissions').onclick=openSessionAccess;
  $('access-remove-password').onchange=() => {
    if ($('access-remove-password').checked) $('access-password').value='';
    updateControls();
  };
  $('session-access-form').onsubmit=async event => {
    event.preventDefault(); $('session-access-error').hidden=true;
    state.accessSaving=true; updateControls();
    try {
      const password=$('access-remove-password').checked ? '' : $('access-password').value || null;
      const result=await command('session_access_set',{settings:{allowDevices:$('access-allow-devices').checked,permissions:permissionFields('access')},password},true);
      if (result.accessSettings) state.accessSettings=result.accessSettings;
      $('access-password').value=''; $('session-access-dialog').close(); notice('Session permissions saved.');
    } catch(error) { dialogError('session-access-error',error); }
    finally { state.accessSaving=false; updateControls(); }
  };
  function openDeviceAccess(client,invoker) {
    if (!isHost() || client.isHost) return;
    deviceAccessTarget=client.id; accessInvoker=invoker;
    $('device-access-description').textContent=(client.name || 'Device')+' · Choose what this paired device can do.';
    setPermissionFields('device',client.permissions || {editFiles:false,terminal:false,ai:false});
    $('device-access-error').hidden=true; showDialog('device-access-dialog'); updateControls();
  }
  $('device-access-form').onsubmit=async event => {
    event.preventDefault(); $('device-access-error').hidden=true;
    state.accessSaving=true; updateControls();
    try {
      if (!state.clients.some(client => client.id===deviceAccessTarget && !client.isHost)) throw new Error('This device is no longer paired.');
      await command('device_permissions_set',{targetClientId:deviceAccessTarget,permissions:permissionFields('device')},true);
      $('device-access-dialog').close(); notice('Device permissions saved.');
    } catch(error) { dialogError('device-access-error',error); }
    finally { state.accessSaving=false; updateControls(); }
  };
  for (const id of ['session-access-dialog','device-access-dialog']) $(id).addEventListener('close',() => {
    $('access-password').value=''; $('access-remove-password').checked=false;
    if (id==='device-access-dialog') deviceAccessTarget=null;
    if (!document.querySelector('dialog[open]')) {
      const original=accessInvoker, replacement=original?.dataset.clientId && [...$('device-list').querySelectorAll('button')].find(button => button.dataset.clientId===original.dataset.clientId && button.dataset.deviceAction===original.dataset.deviceAction);
      const target=replacement || original;
      (target?.isConnected && target.getClientRects().length && !target.disabled ? target : $('connection-state')).focus({preventScroll:true});
      accessInvoker=null;
    }
  });
  function renderDevices() {
    const online=state.clients.filter(client => client.connected).length;
    $('device-summary').textContent=online+' connected browser'+(online===1 ? '' : 's');
    $('revoke-devices').hidden=!state.isHost || !state.pairedSessions;
    $('revoke-devices').disabled=!isHost();
    if ($('session-menu').hidden) return;
    const active=$('device-list').contains(document.activeElement) ? document.activeElement : null;
    const focused=active ? {clientId:active.dataset.clientId,action:active.dataset.deviceAction} : null;
    const fragment=document.createDocumentFragment();
    for (const client of state.clients) {
      const row=document.createElement('div'); row.className='device';
      const label=document.createElement('span'); label.className='device-copy'; label.textContent=(client.name || 'Device')+(client.id===state.clientId ? ' · You' : '');
      const detail=document.createElement('small'); detail.textContent=(client.connected ? 'Connected' : 'Disconnected')+(client.isHost ? ' · PC host' : ''); label.append(detail);
      if (!client.isHost) {
        const access=document.createElement('small'); access.className='device-access'; access.textContent=accessSummary(client.permissions || {}); label.append(access);
      }
      const icon=symbolIcon(client.name==='Phone' ? 'i-phone' : 'i-pc'); icon.classList.add('device-icon'); row.append(icon,label);
      if (!client.isHost && (state.isHost || client.id===state.clientId)) {
        const actions=document.createElement('div'); actions.className='device-actions';
        if (state.isHost) {
          const permissions=document.createElement('button'); permissions.dataset.clientId=client.id; permissions.dataset.deviceAction='permissions'; permissions.textContent='Permissions'; permissions.disabled=!isHost(); permissions.setAttribute('aria-label','Permissions for '+(client.name || 'device'));
          permissions.onclick=() => openDeviceAccess(client,permissions); actions.append(permissions);
        }
        const revoke=document.createElement('button'); revoke.dataset.clientId=client.id; revoke.dataset.deviceAction='revoke'; revoke.textContent=client.id===state.clientId ? 'Sign out' : 'Revoke';
        revoke.disabled=!(isHost() || connected() && client.id===state.clientId); revoke.title='Remove this device’s access to this PC';
        revoke.onclick=safe(async () => { await command('revoke_device',{targetClientId:client.id},true); pairing=null; paintPairing(); });
        actions.append(revoke); row.append(actions);
      }
      fragment.append(row);
    }
    $('device-list').replaceChildren(fragment);
    if (focused) {
      const button=[...$('device-list').querySelectorAll('button')].find(button => button.dataset.clientId===focused.clientId && button.dataset.deviceAction===focused.action && !button.disabled);
      (button || $('session-menu-close')).focus({preventScroll:true});
    }
  }
  $('revoke-devices').onclick=safe(async () => { await command('revoke_all_devices',{},true); pairing=null; paintPairing(); notice('Paired devices signed out. The shell keeps running.'); });
  let pairMode='internet', pairing=null, pairRequest=null, pairTimer, pairStarting=false, pairStopping=false;
  function pairUrls() {
    if (pairMode==='internet') return state.internet?.status==='ready' && state.internet.url ? [state.internet.url] : [];
    const reachable=url => { try { const parsed=new URL(url), host=parsed.hostname; return parsed.protocol==='http:' && host!=='localhost' && !host.endsWith('.localhost') && !/^127\./.test(host) && !['[::1]','[::]','0.0.0.0'].includes(host); } catch { return false; } };
    const urls=state.urls.filter(reachable);
    if (!urls.length && reachable(location.origin)) urls.push(location.origin);
    return urls.slice(0,1);
  }
  const invitationUrl = () => pairing && Date.now()<pairing.expiresAt && pairing.origin===pairUrls()[0] ? pairing.origin+'/#invite='+encodeURIComponent(pairing.invite) : null;
  function paintPairing() {
    if (!$('pair-dialog').open) return;
    const remote=pairMode==='internet', internet=state.internet, urls=pairUrls();
    const starting=remote && (pairStarting || internet?.status==='starting');
    const ready=urls.length>0, expired=pairing && Date.now()>=pairing.expiresAt;
    $('pair-description').textContent=ready ? (!pairing && !pairRequest ? 'Create a fresh invitation for each device you want to join.' : 'Send the complete invitation below to your device, then enter the code.') : remote ? (starting ? 'Creating your secure internet link…' : 'Connect from anywhere, including mobile data.') : 'Connect a device on the same Wi-Fi.';
    if (state.accessSettings?.passwordSet) $('pair-description').textContent+=' The device will also need your pairing password.';
    const inviteUrl=invitationUrl();
    $('pair-urls').replaceChildren(...(inviteUrl ? [inviteUrl] : []).map(url => { const link=document.createElement('a'); link.className='pair-url'; link.href=url; link.textContent=url; link.target='_blank'; link.rel='noopener noreferrer'; return link; }));
    $('pair-link').value=inviteUrl || '';
    if (!inviteUrl) $('pair-manual').hidden=true;
    $('pair-code').textContent=pairing && !expired && ready ? pairing.code : '';
    $('pair-code').hidden=!$('pair-code').textContent;
    $('pair-expiry').hidden=!pairing || !ready;
    $('pair-expiry').textContent=expired ? 'Invitation expired. Create a new link and code.' : 'Link and code expire in two minutes and work once.';
    $('pair-access-note').textContent=remote ? (ready ? (internet.managed===false ? 'Works away from home. Keep this PC awake and Nimlo running.' : 'New links may take a minute to open. Keep this PC awake and Nimlo running. Restarting internet access changes this address.') : 'Uses Cloudflare to connect securely to this PC. Start it only when you need internet access.') : (ready ? 'This address only works on the same network. Use an internet link when away from home.' : 'No Wi-Fi address is available. Use internet access or start Nimlo with LAN access.');
    $('internet-start').hidden=!remote || ready;
    $('internet-start').disabled=!isHost() || !state.accessSettings?.allowDevices || starting || pairStopping;
    $('internet-start').textContent=starting ? 'Connecting…' : internet?.status==='error' ? 'Retry internet link' : 'Create internet link';
    $('pair-refresh').hidden=!ready; $('pair-refresh').disabled=!isHost() || !state.accessSettings?.allowDevices || !!pairRequest;
    $('pair-copy').hidden=!inviteUrl;
    $('pair-copy').textContent='Copy invitation link';
    $('pair-local').textContent=remote ? 'Use same Wi-Fi' : 'Use internet';
    $('internet-stop').hidden=internet?.managed===false || !['starting','ready'].includes(internet?.status);
    $('internet-stop').disabled=!isHost() || pairStopping;
    if (remote && internet?.status==='error') dialogError('pair-error',internet.error || 'Internet access could not start. Retry or use same Wi-Fi.');
  }
  function renderPairing(event) {
    pairing={code:event.code,invite:event.invite,origin:event.origin,expiresAt:event.expiresAt || Date.now()+120000};
    clearTimeout(pairTimer); pairTimer=setTimeout(paintPairing,Math.max(0,pairing.expiresAt-Date.now())); paintPairing();
  }
  function maybePair() {
    if (!$('pair-dialog').open || !isHost() || !state.accessSettings?.allowDevices || !pairUrls().length || pairing || pairRequest) return;
    pairRequest=command('pair_create',{origin:pairUrls()[0]},true).catch(error => dialogError('pair-error',error)).finally(() => { pairRequest=null; paintPairing(); });
  }
  $('pair-phone').onclick=() => {
    if (!isHost() || !state.accessSettings?.allowDevices) return;
    closeMenu(true); pairMode='internet'; pairing=null; $('pair-error').hidden=true;
    showDialog('pair-dialog'); paintPairing(); maybePair();
    clearTimeout(pairTimer);
  };
  $('pair-dialog').addEventListener('close',() => { clearTimeout(pairTimer); pairTimer=null; });
  $('pair-local').onclick=() => { pairMode=pairMode==='internet' ? 'local' : 'internet'; pairing=null; $('pair-error').hidden=true; paintPairing(); maybePair(); };
  $('pair-refresh').onclick=() => { pairing=null; $('pair-error').hidden=true; maybePair(); paintPairing(); };
  $('pair-copy').onclick=async () => {
    const url=invitationUrl(); if (!url) return;
    $('pair-error').hidden=true;
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(url);
      if (url!==invitationUrl()) return;
      $('pair-copy').textContent='Copied'; notice('Complete invitation copied. Send it only to a device you trust.');
    } catch {
      if (url!==invitationUrl()) return;
      $('pair-manual').hidden=false; $('pair-link').focus(); $('pair-link').select();
      dialogError('pair-error',new Error('Automatic copy is unavailable. Copy the selected complete link and send it to your device.'));
    }
  };
  $('internet-start').onclick=async () => {
    pairStarting=true; pairing=null; $('pair-error').hidden=true; paintPairing();
    try { await command('internet_start',{},true); maybePair(); }
    catch(error) { dialogError('pair-error',error); }
    finally { pairStarting=false; paintPairing(); }
  };
  $('internet-stop').onclick=async () => {
    pairStopping=true; $('pair-error').hidden=true; paintPairing();
    try { await command('internet_stop',{},true); pairing=null; }
    catch(error) { dialogError('pair-error',error); }
    finally { pairStopping=false; paintPairing(); }
  };
  function dismissConflict() {
    state.conflict=null; $('conflict-dialog').close();
    $('conflict-local').textContent=''; $('conflict-remote').textContent='';
  }
  function showConflict(doc,kind) {
    state.conflict={doc,kind}; $('conflict-error').hidden=true;
    $('conflict-description').textContent=kind==='disk' ? doc.path+' changed on disk while this session had unsaved edits. Choose the version to keep.' : doc.path+' has pending edits from this device and a different host revision. Choose the version to keep.';
    $('conflict-local').textContent=textOf(doc); $('conflict-remote').textContent=kind==='disk' ? (doc.conflict.diskContent == null ? '[File deleted, unavailable or no longer a supported text file]' : doc.conflict.diskContent) : doc.content;
    $('conflict-remote-button').textContent=kind==='disk' ? 'Use disk version' : 'Use host version';
    $('conflict-local-button').disabled=!writable(); showDialog('conflict-dialog'); updateControls();
  }
  $('conflict-export').onclick=() => {
    const doc=state.conflict.doc, link=document.createElement('a'), url=URL.createObjectURL(new Blob([textOf(doc)],{type:'text/plain;charset=utf-8'}));
    link.href=url; link.download=doc.path.split('/').pop()+'.backup'; link.click(); setTimeout(() => URL.revokeObjectURL(url),1000);
  };
  async function resolveConflict(keep) {
    if (!state.conflict) return;
    const projectId=state.projectId, generation=state.generation;
    const {doc,kind}=state.conflict; $('conflict-error').hidden=true;
    try {
      if (kind==='disk') {
        if (keep) await flush(doc);
        ensureProject(projectId,generation);
        if (doc.conflict) await command('resolve_conflict',{path:doc.path,revision:doc.revision,diskRevision:doc.conflict.diskRevision,resolution:keep ? 'buffer' : 'disk'},true);
        if (!keep) { doc.localText=null; doc.needsReview=false; saveDraft(doc); }
      } else if (keep) {
        // A rejected in-flight edit may still be refreshing the host version.
        if (doc.inflight) await doc.inflight.catch(() => {});
        ensureProject(projectId,generation);
        if (doc.closed) throw new Error('Reopen this file from Files before applying its draft.');
        doc.needsReview=false; doc.draftBase=doc.revision; await flush(doc);
      } else { doc.localText=null; doc.needsReview=false; doc.draftBase=null; saveDraft(doc); }
      ensureProject(projectId,generation);
      if (doc.needsReview || doc.conflict) showConflict(doc,doc.needsReview ? 'draft' : 'disk');
      else if (!state.conflict || state.conflict.doc===doc) dismissConflict();
      releaseSettledDocument(doc);
      renderEditor();
    } catch(error) { dialogError('conflict-error',error); }
  }
  $('conflict-remote-button').onclick=() => resolveConflict(false); $('conflict-local-button').onclick=() => resolveConflict(true);
  let terminalOpen=false, terminalWidth=8, terminalLine=20, terminalComposing=false, terminalComposition=null, historyTimer, historyBusy=false, terminalFrame, terminalClaim;
  function claimTerminal() {
    if (!canTerminal() || ownsTerminal()) return Promise.resolve();
    if (!terminalClaim) terminalClaim=command('claim_control').finally(() => { terminalClaim=null; scheduleResize(); });
    return terminalClaim;
  }
  function terminalMetrics() {
    const style=getComputedStyle($('terminal-screen')), canvas=document.createElement('canvas');
    const context=canvas.getContext('2d'); context.font=style.fontSize+' '+style.fontFamily;
    terminalWidth=context.measureText('M').width; terminalLine=parseFloat(style.lineHeight);
  }
  const terminalVisible=() => terminalOpen && (mobile() ? app.dataset.view==='terminal' : !(aiOpen() && app.dataset.aiLayout==='tab' && app.dataset.view==='ai'));
  async function toggleTerminal(force) {
    if (force!==false && !canTerminal()) throw new Error('Terminal access is disabled for this device.');
    const projectId=state.projectId, generation=state.generation;
    if (!mobile() && aiOpen() && app.dataset.aiLayout==='tab' && app.dataset.view==='ai') setMobileView('code');
    if (mobile()) {
      const open=typeof force==='boolean' ? force : app.dataset.view!=='terminal';
      if (open && terminalOpen && app.dataset.view==='terminal') return;
      setMobileView(open ? 'terminal' : 'code');
      if (!open) return;
      if (terminalOpen) { await claimTerminal(); ensureProject(projectId,generation); paintTerminal(); scheduleResize(); return; }
    }
    terminalOpen=typeof force==='boolean' ? force : (mobile() && app.dataset.view==='ai') || !terminalOpen;
    if (state.terminalFollow==null) state.terminalFollow=true;
    app.dataset.terminal=terminalOpen ? 'open' : 'closed'; $('terminal-panel').hidden=!terminalOpen;
    $('terminal-toggle').setAttribute('aria-expanded',String(terminalOpen));
    $('terminal-shortcut-toggle').setAttribute('aria-expanded',String(terminalOpen)); closeMenu(); paintCode();
    if (!terminalOpen) { $('terminal-screen').replaceChildren(); state.history=[]; focusWorkspace(); return; }
    syncViewControls();
    terminalMetrics();
    await claimTerminal(); ensureProject(projectId,generation);
    if ((!state.terminal || !state.terminal.running) && canTerminal()) await command('terminal_start',{},true);
    ensureProject(projectId,generation); await command('terminal_history',{limit:200}); ensureProject(projectId,generation); paintTerminal(); scheduleResize();
    if (terminalOpen && !mobile()) $('terminal-command').focus();
  }
  $('terminal-toggle').onclick=safe(() => toggleTerminal()); $('close-terminal').onclick=safe(() => toggleTerminal(false));
  $('terminal-shortcut-toggle').onclick=safe(() => toggleTerminal());
  $('terminal-restart').onclick=safe(async () => { const projectId=state.projectId, generation=state.generation; await claimTerminal(); ensureProject(projectId,generation); await command('terminal_start',{},true); scheduleResize(); });
  $('terminal-end').onclick=safe(async () => { if (confirm('End this shell and its foreground command?')) await command('terminal_stop',{},true); });
  function paintTerminal() {
    if (!canTerminal() || !terminalVisible() || !state.terminal || document.hidden) return;
    const terminal=state.terminal, screen=$('terminal-screen'), wrap=$('terminal-screen-wrap');
    const atBottom=wrap.scrollHeight-wrap.scrollTop-wrap.clientHeight<32;
    const history=terminal.alternate_screen ? [] : state.history;
    const lines=history.concat(terminal.lines), fragment=document.createDocumentFragment();
    let columns=terminal.cols;
    for (const line of lines) for (const run of line.runs) columns=Math.max(columns,run.col+run.cols);
    screen.style.width=columns*terminalWidth+'px'; screen.style.height=lines.length*terminalLine+'px';
    const start=Math.max(0,Math.floor(wrap.scrollTop/terminalLine)-2), end=Math.min(lines.length,start+Math.ceil(wrap.clientHeight/terminalLine)+5);
    lines.slice(start,end).forEach((line,offset) => {
      const index=start+offset;
      const row=document.createElement('div'); row.className='term-row'; row.style.top=index*terminalLine+'px'; row.style.width=columns*terminalWidth+'px';
      for (const run of line.runs) {
        const span=document.createElement('span'); span.className='term-run'; span.textContent=run.text;
        span.style.left=run.col*terminalWidth+'px'; span.style.width=run.cols*terminalWidth+'px';
        if (run.fg) span.style.color=run.fg; if (run.bg) span.style.backgroundColor=run.bg;
        if (run.bold) span.style.fontWeight='bold'; if (run.dim) span.style.opacity='.65'; if (run.italic) span.style.fontStyle='italic'; if (run.underline) span.style.textDecoration='underline';
        if (run.inverse) { span.style.color=run.bg || 'var(--bg)'; span.style.backgroundColor=run.fg || 'var(--text)'; }
        row.append(span);
      }
      fragment.append(row);
    });
    if (terminal.cursor.visible && terminal.running) {
      const cursor=document.createElement('span'); cursor.className='term-cursor'; cursor.style.left=terminal.cursor.col*terminalWidth+'px'; cursor.style.top=(history.length+terminal.cursor.row)*terminalLine+'px'; fragment.append(cursor);
    }
    screen.replaceChildren(fragment);
    if (state.terminalFollow!==false) { const before=wrap.scrollTop; wrap.scrollTop=Math.max(0,(history.length+terminal.cursor.row+1)*terminalLine-wrap.clientHeight+16); state.autoScrollTop=wrap.scrollTop; if (before!==wrap.scrollTop) requestAnimationFrame(paintTerminal); }
    $('terminal-command').placeholder=terminal.running ? 'Type into shell…' : 'Start a shell to type…';
  }
  function scheduleResize() {
    clearTimeout(resizeTimer); resizeTimer=setTimeout(() => {
      if (state.switching || document.hidden || !terminalVisible() || !ownsTerminal() || !state.terminal || !state.terminal.running) return;
      terminalMetrics(); const wrap=$('terminal-screen-wrap'), style=getComputedStyle(wrap);
      const cols=Math.max(20,Math.min(200,Math.floor((wrap.clientWidth-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight))/terminalWidth)));
      const rows=Math.max(5,Math.min(80,Math.floor((wrap.clientHeight-parseFloat(style.paddingTop)-parseFloat(style.paddingBottom))/terminalLine)));
      if (cols!==state.terminal.cols || rows!==state.terminal.rows) command('terminal_resize',{cols,rows},true).catch(report);
    },120);
  }
  function sendTerminal(data) { if (state.switching) return Promise.reject(new Error('Wait for the project switch before typing into its terminal.')); state.terminalFollow=true; return command('terminal_input',{data},true); }
  function arrow(key) { return '\x1b'+(state.terminal && state.terminal.application_cursor ? 'O' : '[')+({up:'A',down:'B',right:'C',left:'D'}[key]); }
  function hideTerminalKeys() { app.dataset.terminalKeys='closed'; $('terminal-keys-toggle').setAttribute('aria-expanded','false'); }
  $('terminal-keys-toggle').onclick=() => {
    const open=app.dataset.terminalKeys!=='open'; app.dataset.terminalKeys=open ? 'open' : 'closed';
    $('terminal-keys-toggle').setAttribute('aria-expanded',String(open));
  };
  document.querySelectorAll('[data-term-key]').forEach(button => button.onclick=safe(() => {
    hideTerminalKeys(); return sendTerminal(({interrupt:'\x03',escape:'\x1b',tab:'\t'})[button.dataset.termKey] || arrow(button.dataset.termKey));
  }));
  for (const button of [...document.querySelectorAll('[data-term-key]'),$('terminal-keys-toggle'),$('terminal-run')]) {
    button.addEventListener('mousedown',event => { if (document.activeElement===$('terminal-command')) event.preventDefault(); });
  }
  function refreshHistory() {
    if (historyTimer || historyBusy || !terminalOpen || !canTerminal() || !state.terminal || state.terminal.alternate_screen) return;
    historyTimer=setTimeout(async () => {
      historyTimer=null;
      if (state.switching) return;
      historyBusy=true;
      try { await command('terminal_history',{limit:200}); } catch {} finally { historyBusy=false; }
    },500);
  }
  $('terminal-form').onsubmit=event => { event.preventDefault(); safe(() => sendTerminal('\r'))(); };
  $('terminal-command').addEventListener('compositionstart',() => { terminalComposing=true; terminalComposition={projectId:state.projectId,generation:state.generation}; });
  $('terminal-command').addEventListener('focus',() => { claimTerminal().catch(report); });
  $('terminal-command').addEventListener('compositionend',() => {
    const origin=terminalComposition; terminalComposition=null; terminalComposing=false;
    if (!origin || origin.projectId!==state.projectId || origin.generation!==state.generation) return;
    const value=$('terminal-command').value; $('terminal-command').value=''; if (value) sendTerminal(value).catch(report);
  });
  $('terminal-command').addEventListener('input',event => {
    if (terminalComposing || event.isComposing) return;
    if (terminalComposition && (terminalComposition.projectId!==state.projectId || terminalComposition.generation!==state.generation) && /Composition/.test(event.inputType || '')) return;
    const value=$('terminal-command').value; $('terminal-command').value=''; if (value) sendTerminal(value).catch(report);
  });
  $('terminal-command').addEventListener('beforeinput',event => {
    if (!terminalComposing && !event.isComposing && event.inputType==='deleteContentBackward') { event.preventDefault(); sendTerminal('\x7f').catch(report); }
  });
  $('terminal-screen').addEventListener('focus',() => { if (canTerminal() && !mobile()) $('terminal-command').focus(); });
  function terminalKey(event) {
    if (!canTerminal() || !state.terminal || !state.terminal.running || event.isComposing || terminalComposing || event.metaKey) return;
    if (event.ctrlKey && event.key.toLowerCase()==='c' && String(getSelection())) return;
    if (event.ctrlKey && event.key.toLowerCase()==='v') return;
    let data;
    if (event.ctrlKey && /^[a-z@\[\]\\^_]$/i.test(event.key)) data=String.fromCharCode(event.key.toUpperCase().charCodeAt(0)&31);
    else data=({Enter:'\r',Backspace:'\x7f',Tab:'\t',Escape:'\x1b',ArrowUp:arrow('up'),ArrowDown:arrow('down'),ArrowLeft:arrow('left'),ArrowRight:arrow('right'),Home:'\x1b[H',End:'\x1b[F',Delete:'\x1b[3~',PageUp:'\x1b[5~',PageDown:'\x1b[6~'})[event.key];
    if (!data && event.key.length===1 && !event.ctrlKey) data=(event.altKey ? '\x1b' : '')+event.key;
    if (data) { event.preventDefault(); event.stopPropagation(); sendTerminal(data).catch(report); }
  }
  $('terminal-screen').addEventListener('keydown',terminalKey);
  $('terminal-command').addEventListener('keydown',terminalKey);
  function terminalPaste(event) {
    if (!canTerminal()) return; event.preventDefault(); const text=event.clipboardData.getData('text/plain');
    if (new TextEncoder().encode(text).length>15000) return notice('Terminal pastes are limited to 15 KB.',true);
    sendTerminal(state.terminal.bracketed_paste ? '\x1b[200~'+text+'\x1b[201~' : text).catch(report);
  }
  $('terminal-screen').addEventListener('paste',terminalPaste); $('terminal-command').addEventListener('paste',terminalPaste);
  $('terminal-screen-wrap').addEventListener('scroll',() => { const top=$('terminal-screen-wrap').scrollTop; if (state.autoScrollTop!=null && Math.abs(top-state.autoScrollTop)>2) state.terminalFollow=false; state.autoScrollTop=top; cancelAnimationFrame(terminalFrame); terminalFrame=requestAnimationFrame(paintTerminal); },{passive:true});
  $('terminal-screen-wrap').addEventListener('touchstart',() => { state.terminalFollow=false; },{passive:true});
  $('terminal-screen-wrap').addEventListener('pointerdown',() => { state.terminalFollow=false; },{passive:true});
  $('terminal-screen-wrap').addEventListener('wheel',event => { state.terminalFollow=event.deltaY>=0 && $('terminal-screen-wrap').scrollHeight-$('terminal-screen-wrap').scrollTop-$('terminal-screen-wrap').clientHeight<40; if (event.deltaY<0 && terminalOpen && !state.history.length && canTerminal()) command('terminal_history',{limit:200}).catch(() => {}); },{passive:true});
  function focusWorkspace() {
    if (mobile()) return;
    if (app.dataset.view==='ai') $('prompt').focus();
    else if (state.path) input.focus();
    else $('files-toggle').focus();
  }
  function syncTerminalControls() {
    const visible=terminalVisible();
    for (const id of ['terminal-toggle','terminal-shortcut-toggle']) $(id).setAttribute('aria-expanded',String(visible));
  }
  function syncViewControls() {
    const view=app.dataset.view, open=aiOpen(), split=app.dataset.aiLayout==='split';
    const showAi=aiVisible(), showCode=(!mobile() || view!=='terminal') && !(open && !split && view==='ai');
    const showEditor=showCode || (mobile() && view==='terminal');
    app.dataset.aiVisible=showAi ? 'yes' : 'no'; app.dataset.codeVisible=showCode ? 'yes' : 'no';
    app.dataset.editorVisible=showEditor ? 'yes' : 'no';
    $('ai-panel').inert=!showAi; $('editor-panel').inert=!showEditor;
    $('ai-panel').setAttribute('aria-hidden',String(!showAi)); $('editor-panel').setAttribute('aria-hidden',String(!showEditor));
    $('terminal-screen').tabIndex=mobile() ? -1 : 0;
    $('workspace-file-label').textContent=mobile() ? 'Code' : current()?.path.split('/').pop() || 'Open a file';
    $('mobile-code').title=current()?.path || 'Code editor';
    $('mobile-code').setAttribute('aria-label',current() ? 'File: '+current().path : 'Code editor');
    $('workspace-dirty-dot').textContent=mobile() ? '' : $('dirty-dot').textContent;
    $('workspace-tabs').setAttribute('role',split ? 'group' : 'tablist');
    for (const name of ['code','ai','terminal']) {
      const button=$('mobile-'+name);
      if (view===name) button.setAttribute('aria-current','page'); else button.removeAttribute('aria-current');
      if (name!=='terminal') {
        button.setAttribute('role',split ? 'button' : 'tab');
        if (split) button.removeAttribute('aria-selected'); else button.setAttribute('aria-selected',String(view===name));
        button.tabIndex=split || view===name || view==='terminal' ? 0 : -1;
      }
    }
    for (const [id,selected] of [['ai-layout-split',split],['ai-layout-tab',!split]]) $(id).setAttribute('aria-pressed',String(selected));
    for (const [id,label] of [['editor-panel','mobile-code'],['ai-panel','mobile-ai']]) {
      $(id).setAttribute('role',split ? 'region' : 'tabpanel'); $(id).setAttribute('aria-labelledby',label);
    }
    $('ai-toggle').dataset.active=String(open);
    $('ai-show-label').textContent=open ? 'Show AI' : 'Open AI'; $('close-ai').hidden=!open;
    syncTerminalControls();
  }
  function setMobileView(view) {
    if (view==='ai' && !canAi() || view==='terminal' && !canTerminal()) return;
    if (view==='ai') app.dataset.aiOpen='yes';
    if (app.dataset.view===view) { syncViewControls(); if (aiVisible()) renderAi(true); return; }
    rememberCodeView();
    if (aiVisible()) state.messageScrollTop=$('messages').scrollTop;
    if (app.dataset.view==='terminal') state.terminalView={top:$('terminal-screen-wrap').scrollTop,left:$('terminal-screen-wrap').scrollLeft,follow:state.terminalFollow};
    if (/^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName)) document.activeElement.blur();
    app.dataset.view=view; closeMenu(); syncViewControls(); hideTerminalKeys();
    if (aiVisible()) renderAi(true);
    // Restore synchronously before a later native selection event can occur.
    if (view==='code') restoreCodeView();
    if (view==='terminal' && state.terminalView) {
      $('terminal-screen-wrap').scrollTop=state.terminalView.top; $('terminal-screen-wrap').scrollLeft=state.terminalView.left;
      state.terminalFollow=state.terminalView.follow;
    }
    paintCode(); paintTerminal(); scheduleResize();
  }
  $('mobile-code').onclick=() => { setMobileView('code'); if (!mobile()) input.focus({preventScroll:true}); };
  $('mobile-ai').onclick=() => { setMobileView('ai'); if (!mobile()) $('prompt').focus({preventScroll:true}); };
  $('mobile-terminal').onclick=safe(() => toggleTerminal(true));
  $('workspace-tabs').addEventListener('keydown',event => {
    if (!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
    event.preventDefault(); const view=event.key==='Home' ? 'code' : event.key==='End' ? 'ai' : app.dataset.view==='ai' ? 'code' : 'ai';
    setMobileView(view); $('mobile-'+view).focus({preventScroll:true});
  });
  function setAiLayout(layout) {
    if (!canAi()) return;
    rememberCodeView(); if (aiVisible()) state.messageScrollTop=$('messages').scrollTop;
    if (/^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName)) document.activeElement.blur();
    app.dataset.aiLayout=layout; app.dataset.aiOpen='yes';
    if (app.dataset.view==='terminal') app.dataset.view='ai';
    try { sessionStorage.setItem('relay-ai-layout:'+layoutDevice,layout); } catch {}
    syncViewControls(); restoreCodeView(); if (aiVisible()) renderAi(true);
    paintTerminal(); scheduleResize();
  }
  for (const layout of ['split','tab']) $('ai-layout-'+layout).onclick=() => { closeMenu(); setAiLayout(layout); setMobileView('ai'); $('ai-toggle').focus({preventScroll:true}); };
  function toggleAi(force) {
    const open=typeof force==='boolean' ? force : !aiOpen();
    if (open && !canAi()) return;
    if (open) setMobileView('ai');
    else {
      rememberCodeView(); if (aiVisible()) state.messageScrollTop=$('messages').scrollTop;
      app.dataset.aiOpen='no'; setMobileView('code'); syncViewControls();
    }
    paintCode(); paintTerminal(); scheduleResize(); if (!mobile()) focusWorkspace();
  }
  $('ai-show').onclick=() => { closeMenu(); toggleAi(true); if (!mobile()) $('prompt').focus({preventScroll:true}); };
  $('close-ai').onclick=() => { closeMenu(); toggleAi(false); if (mobile()) $('ai-toggle').focus({preventScroll:true}); };
  function renderProviders() {
    const provider=state.providers.find(item => item.id===$('provider').value);
    renderAiContext();
    for (const option of $('provider').options) { const info=state.providers.find(item => item.id===option.value); option.disabled=!!info && !info.available; }
  }
  function renderAiContext() {
    const provider=state.providers.find(item => item.id===$('provider').value), doc=current();
    const path=doc?.path, unsaved=doc && (doc.dirty || doc.localText!=null), conversation=state.aiContext?.path;
    const hasConversation=!!state.ai?.messages?.length || state.ai && ['starting','running','awaiting_approval','cancelling'].includes(state.ai.status);
    const authNote=provider ? provider.auth==='signed_in' ? '' : provider.detail || (provider.available ? 'Check your account in AI settings.' : 'Install '+provider.name+' CLI on the host PC.') : 'Check your account in AI settings.';
    const note=!state.permissions.ai ? 'AI access is disabled for this device.' : !state.permissions.editFiles || !state.permissions.terminal ? 'AI actions require file editing and terminal access. Ask the PC host to enable them.' : authNote;
    $('ai-note').textContent=note; $('ai-note').hidden=!note;
    const earlierFile=hasConversation && conversation && conversation!==path;
    $('ai-conversation-context').textContent=earlierFile ? 'Conversation · '+conversation : '';
    $('ai-conversation-context').title=earlierFile ? 'Earlier conversation about '+conversation+' in '+projectContext() : '';
    $('ai-conversation-context').hidden=!earlierFile;
    $('compose-context').textContent=path ? unsaved ? 'Save your file before asking' : 'Current file on disk' : 'Project context';
    $('compose-context').title=path ? projectContext()+' / '+path : state.workspacePath;
    $('prompt').placeholder=path ? 'Ask about '+path.split('/').pop()+'…' : 'Ask about this project…';
    const fullAccess=state.aiSettings?.permissionMode==='fullAccess';
    $('ai-permission-mode').textContent=fullAccess ? 'Full access' : 'Ask first';
    $('ai-permission-mode').classList.toggle('full-access',fullAccess);
    $('ai-permission-mode').title=fullAccess ? 'AI can change files and run host commands without asking · Change permissions' : 'AI asks when permission is needed · Change permissions';
    $('ai-permission-mode').setAttribute('aria-label',fullAccess ? 'AI permissions: full access · Open settings' : 'AI permissions: ask first · Open settings');
  }
  $('provider').onchange=() => { state.providerChosen=true; renderProviders(); };
  function queueAi() { cancelAnimationFrame(aiFrame); aiFrame=requestAnimationFrame(() => { renderProviders(); renderSettingsAccount(); if (aiVisible()) renderAi(); }); }
  function fenced(text) { const blocks=[...text.matchAll(/```[^\n]*\n([\s\S]*?)```/g)]; return blocks.length ? blocks[blocks.length-1][1] : null; }
  async function openAiFile(target) {
    const projectId=state.projectId, generation=state.generation;
    if (canEdit()) await flushAll(); ensureProject(projectId,generation);
    const result=await command('ai_open_file',{target}); ensureProject(projectId,generation);
    await openProjectFile(result.projectId,result.path);
    if (state.projectId!==result.projectId || current()?.path!==result.path) return;
    const text=editor.value; let start=0, line=1;
    while (line<result.line) { const next=text.indexOf('\n',start); if (next<0) { start=text.length; break; } start=next+1; line++; }
    const height=parseFloat(getComputedStyle(input).lineHeight) || 24;
    current().view={top:Math.max(0,(line-3)*height),left:0,start,end:start,direction:'none'};
    restoreCodeView(); if (!mobile()) input.focus({preventScroll:true});
  }
  function markdownElement(tag,budget) {
    if (budget.left<1) return null;
    budget.left--; return document.createElement(tag);
  }
  function markdownLink(target,label,budget) {
    target=target.trim().replace(/^<([\s\S]*)>$/,'$1');
    if (!target || target.length>4096 || /[\u0000-\u001f\u007f]/.test(target)) return null;
    let external;
    if (/^https?:\/\//i.test(target)) {
      try { external=new URL(target); if (!['http:','https:'].includes(external.protocol) || external.username || external.password) return null; } catch { return null; }
    } else if (target.startsWith('//') || target.startsWith('#') || target.startsWith('?') || /^(?:javascript|data|vbscript|file|mailto|about|blob|ftp):/i.test(target) || (/^[a-z][a-z\d+.-]*:/i.test(target) && !/^[a-z]:[\\/]/i.test(target) && !/^[^:]+:\d{1,9}(?::\d{1,9})?$/.test(target))) return null;
    const link=markdownElement('a',budget); if (!link) return null;
    if (external) { link.href=external.href; link.target='_blank'; link.rel='noopener noreferrer'; }
    else {
      link.href='#'; link.className='ai-file-link'; link.dataset.fileTarget=target; link.title='Open '+label+' in the editor';
      link.onclick=event => { event.preventDefault(); safe(() => openAiFile(target))(); };
    }
    return link;
  }
  function markdownInline(parent,text,budget,depth=0) {
    if (!text) return;
    if (depth>=3 || budget.left<2) { parent.append(document.createTextNode(text)); return; }
    // Every token has a bounded span. Raw HTML stays text, and links never
    // become executable HTML, file URLs, or unvalidated filesystem requests.
    const tokens=/\\([\\`*_{}\[\]()#+.!>-])|(`{1,3})([^`\n]{1,12000})\2|\[([^\]\n]{1,300})\]\s*\((<?[^)\n]{1,4096}>?)\)|(\*\*|__)(?=\S)([^\n]{1,8192}?)\6|(\*|_)(?=\S)([^*_\n]{1,4096})\8|~~(?=\S)([^~\n]{1,8192})~~/g;
    let cursor=0, match;
    while (budget.left>=2 && (match=tokens.exec(text))) {
      if (match.index>cursor) { parent.append(document.createTextNode(text.slice(cursor,match.index))); budget.left--; }
      let node, content;
      if (match[1]) { parent.append(document.createTextNode(match[1])); budget.left--; }
      else if (match[2]) { node=markdownElement('code',budget); if (node) node.textContent=match[3]; }
      else if (match[4]) { node=markdownLink(match[5],match[4],budget); content=match[4]; }
      else if (match[6]) { node=markdownElement('strong',budget); content=match[7]; }
      else if (match[8]) { node=markdownElement('em',budget); content=match[9]; }
      else { node=markdownElement('s',budget); content=match[10]; }
      if (node) { if (content) markdownInline(node,content,budget,depth+1); parent.append(node); }
      else if (!match[1]) { parent.append(document.createTextNode(match[0])); budget.left--; }
      cursor=tokens.lastIndex;
    }
    if (cursor<text.length) parent.append(document.createTextNode(text.slice(cursor)));
  }
  function renderMarkdown(body,text,budget) {
    const lines=text.replace(/\r\n?/g,'\n').split('\n');
    const list=line => /^( {0,12})([-+*]|\d{1,6}\.)[ \t]+(.+)$/.exec(line);
    const fence=line => /^ {0,3}(`{3,}|~{3,})([^`~]*)$/.exec(line);
    const block=line => /^ {0,3}(?:#{1,6}\s|>|(?:\*\s*){3,}$|(?:-\s*){3,}$|(?:_\s*){3,}$)/.test(line) || list(line) || fence(line);
    const cells=line => line.trim().replace(/^\||\|$/g,'').split('|').map(cell => cell.trim());
    let i=0;
    while (i<lines.length) {
      if (!lines[i].trim()) { i++; continue; }
      if (budget.left<4) { const tail=document.createElement('p'); tail.className='ai-plain-tail'; tail.textContent=lines.slice(i).join('\n'); body.append(tail); break; }
      const opening=fence(lines[i]);
      if (opening) {
        const start=++i, close=new RegExp('^ {0,3}'+(opening[1][0]==='`' ? '`' : '~')+'{'+opening[1].length+',}\\s*$');
        while (i<lines.length && !close.test(lines[i])) i++;
        const pre=markdownElement('pre',budget), code=markdownElement('code',budget);
        code.textContent=lines.slice(start,i).join('\n'); pre.append(code); body.append(pre); if (i<lines.length) i++; continue;
      }
      const heading=/^ {0,3}(#{1,6})\s+(.+?)(?:\s+#+\s*)?$/.exec(lines[i]);
      if (heading) { const node=markdownElement('h'+heading[1].length,budget); markdownInline(node,heading[2],budget); body.append(node); i++; continue; }
      if (/^ {0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/.test(lines[i])) { body.append(markdownElement('hr',budget)); i++; continue; }
      if (/^ {0,3}>/.test(lines[i])) {
        const quote=markdownElement('blockquote',budget), chunk=[];
        while (i<lines.length && /^ {0,3}>/.test(lines[i])) chunk.push(lines[i++].replace(/^ {0,3}> ?/,''));
        markdownInline(quote,chunk.join('\n'),budget); body.append(quote); continue;
      }
      const first=list(lines[i]);
      if (first) {
        const root=markdownElement(/\d/.test(first[2]) ? 'ol' : 'ul',budget);
        if (root.tagName==='OL' && parseInt(first[2],10)!==1) root.start=parseInt(first[2],10);
        const stack=[{indent:first[1].length,node:root,item:null}]; body.append(root);
        while (i<lines.length && budget.left>=4) {
          const entry=list(lines[i]);
          if (!entry) {
            if (/^ {2,}\S/.test(lines[i]) && stack.at(-1).item) { const item=stack.at(-1).item; item.append(document.createTextNode(' ')); markdownInline(item,lines[i++].trim(),budget); continue; }
            break;
          }
          const indent=entry[1].length, ordered=/\d/.test(entry[2]);
          while (stack.length>1 && indent<stack.at(-1).indent) stack.pop();
          if (indent>stack.at(-1).indent && stack.at(-1).item && stack.length<3) {
            const nested=markdownElement(ordered ? 'ol' : 'ul',budget); stack.at(-1).item.append(nested); stack.push({indent,node:nested,item:null});
          } else if (indent===stack.at(-1).indent && (stack.at(-1).node.tagName==='OL')!==ordered) break;
          let content=entry[3];
          // Codex can wrap a file citation between its label and destination,
          // including at the end of a list item. Keep that one link together.
          if (/\]\s*$/.test(content) && i+1<lines.length && /^\s*\([^\n]+\)/.test(lines[i+1])) content+='\n'+lines[++i].trim();
          const item=markdownElement('li',budget); markdownInline(item,content,budget); stack.at(-1).node.append(item); stack.at(-1).item=item; i++;
        }
        continue;
      }
      const header=cells(lines[i]), separators=i+1<lines.length ? cells(lines[i+1]) : [];
      if (header.length>=2 && header.length<=16 && separators.length===header.length && separators.every(cell => /^:?-{3,}:?$/.test(cell)) && budget.left>=header.length*2+5) {
        const wrap=markdownElement('div',budget); wrap.className='ai-table'; const table=markdownElement('table',budget), row=markdownElement('tr',budget);
        const headingCells=header.map(() => markdownElement('th',budget));
        headingCells.forEach((cell,index) => { markdownInline(cell,header[index],budget); row.append(cell); });
        table.append(row); i+=2;
        while (i<lines.length && lines[i].includes('|') && lines[i].trim() && budget.left>=header.length*2+2) {
          const values=cells(lines[i]); if (values.length!==header.length) break;
          const row=markdownElement('tr',budget), rowCells=values.map(() => markdownElement('td',budget));
          rowCells.forEach((cell,index) => { markdownInline(cell,values[index],budget); row.append(cell); }); table.append(row); i++;
        }
        wrap.append(table); body.append(wrap); continue;
      }
      const start=i++;
      while (i<lines.length && lines[i].trim() && !block(lines[i])) {
        if (i+1<lines.length && lines[i].includes('|') && cells(lines[i+1]).every(cell => /^:?-{3,}:?$/.test(cell))) break;
        i++;
      }
      const paragraph=markdownElement('p',budget); markdownInline(paragraph,lines.slice(start,i).join('\n'),budget); body.append(paragraph);
    }
  }
  function renderAi(preserveScroll=false) {
    const ai=state.ai; if (!canAi() || !ai) return;
    $('ai-status').textContent=ai.status==='idle' ? '' : ai.status.replaceAll('_',' ');
    const messages=$('messages'), previousTop=state.messageScrollTop ?? messages.scrollTop;
    const expandedApprovals=new Set([...messages.querySelectorAll('.approval-more[open]')].slice(0,8).map(detail => detail.closest('.approval').dataset.approvalId));
    const active=document.activeElement, focusedCard=messages.contains(active) && active.closest('.approval');
    const focusedApproval=focusedCard && (active.dataset.choice || active.matches('.approval-more > summary'))
      ? {id:focusedCard.dataset.approvalId,choice:active.dataset.choice || null} : null;
    const bottom=!preserveScroll && messages.scrollHeight-messages.scrollTop-messages.clientHeight<60;
    const fragment=document.createDocumentFragment(), markdownBudget={left:1800};
    const lastUser=(ai.messages || []).findLastIndex(message => message.role==='user');
    (ai.messages || []).forEach((message,index) => {
      const item=document.createElement('div'); item.className='message'; item.dataset.role=message.role;
      const byline=document.createElement('div'); byline.className='byline'; byline.textContent=message.role==='user' ? 'You'+(index===lastUser && state.aiContext?.path ? ' · '+state.aiContext.path : '') : message.role==='assistant' ? (ai.provider==='claude' ? 'Claude' : 'Codex') : message.role;
      const body=document.createElement(message.role==='assistant' ? 'div' : 'p'); body.className=message.role==='assistant' ? 'ai-markdown' : 'ai-message-text';
      if (message.role==='assistant') renderMarkdown(body,message.text,markdownBudget); else body.textContent=message.text;
      item.append(byline,body);
      const replacement=message.role==='assistant' && fenced(message.text);
      if (replacement!=null && state.aiContext && index>lastUser && !['running','starting','awaiting_approval','cancelling'].includes(ai.status)) {
        const action=document.createElement('button'); action.className='review-action'; action.textContent='Review replacement'; action.disabled=!canEdit();
        action.onclick=() => { const doc=state.docs.get(state.aiContext.path);
          if (!doc || doc.revision!==state.aiContext.revision || doc.localText!=null) return notice('The selected file changed since this AI request. Ask for a fresh replacement.',true);
          state.proposal={...state.aiContext,original:doc.content,text:replacement}; $('review-description').textContent=state.proposal.path+' · Applying changes the shared buffer. Save writes it to disk.'; $('review-original').textContent=state.proposal.original; $('review-proposed').textContent=replacement; $('review-error').hidden=true; $('apply-change').disabled=!writable(); showDialog('review-dialog'); };
        item.append(action);
      }
      fragment.append(item);
    });
    for (const approval of ai.approvals || []) {
      const card=document.createElement('div'); card.className='approval'; card.dataset.approvalId=approval.id;
      const label=document.createElement('div'); label.className='approval-label'; label.textContent='Permission required';
      const title=document.createElement('p'); title.className='approval-title'; title.textContent=approval.title;
      const detail=document.createElement('pre'); detail.className='approval-detail'; detail.textContent=approval.detail;
      const actions=document.createElement('div'); actions.className='approval-actions'; let more;
      const affirmative=choice => choice.startsWith('accept') || choice.startsWith('allow_network_');
      const primaryChoice=approval.choices.includes('accept') ? 'accept' : approval.choices.find(affirmative);
      for (const choice of approval.choices) {
        const button=document.createElement('button'); button.type='button'; button.dataset.choice=choice;
        button.textContent=approval.choiceLabels?.[choice] || ({accept:'Approve once',decline:'Decline',cancel:'Stop turn',accept_for_session:'Approve for this conversation',accept_with_execpolicy_amendment:'Approve and remember command',accept_with_network_policy_amendment:'Approve and remember network access'})[choice] || choice.replaceAll('_',' ');
        if (choice===primaryChoice) button.className='primary';
        button.disabled=!(affirmative(choice) ? canRunAi() : canAi()); button.onclick=safe(async () => { button.dataset.submitting='yes'; button.disabled=true; try { await command('ai_approve',{id:approval.id,choice},true); } catch(error) { delete button.dataset.submitting; button.disabled=!(affirmative(choice) ? canRunAi() : canAi()); throw error; } });
        if (['decline','cancel'].includes(choice) || choice===primaryChoice) actions.append(button);
        else {
          if (!more) { more=document.createElement('details'); more.className='approval-more'; more.open=expandedApprovals.has(approval.id); const summary=document.createElement('summary'); summary.textContent='More approval options'; const options=document.createElement('div'); options.className='approval-actions'; more.append(summary,options); }
          more.lastChild.append(button);
        }
      }
      card.append(label,title,detail);
      if (!canRunAi()) { const reason=document.createElement('p'); reason.className='approval-reason'; reason.textContent='Approving AI actions requires file editing and terminal access.'; card.append(reason); }
      if (approval.disabledReason || !approval.choices.some(affirmative)) { const reason=document.createElement('p'); reason.className='approval-reason'; reason.textContent=approval.disabledReason || 'This request cannot be approved. Decline it or stop the turn.'; card.append(reason); }
      card.append(actions); if (more) card.append(more); fragment.append(card);
    }
    if (ai.error) { const error=document.createElement('p'); error.className='ai-error'; error.textContent=ai.error; fragment.append(error); }
    if (ai.truncated) { const note=document.createElement('p'); note.className='control-note'; note.textContent='Older messages were trimmed to keep memory bounded.'; fragment.append(note); }
    const empty=!fragment.childNodes.length;
    $('ai-panel').dataset.empty=empty ? 'yes' : 'no';
    if (empty) {
      const entry=document.createElement('div'); entry.className='empty-ai';
      const title=document.createElement('h1'); title.textContent='What are we working on?';
      const hint=document.createElement('p'); hint.textContent=current() ? 'Ask a question or make a change to your current file.' : 'Explore your project, find an issue, or plan a change.';
      const suggestions=document.createElement('div'); suggestions.className='prompt-suggestions';
      for (const [label,prompt] of [['Explain the code','Explain '+(current() ? 'this file' : 'this project')+' and how it works.'],['Find an issue','Review '+(current() ? 'this file' : 'this project')+' for bugs and suggest a focused fix.'],['Plan a change','Help me plan a change to '+(current() ? 'this file' : 'this project')+'.']]) {
        const button=document.createElement('button'); button.type='button'; button.textContent=label; button.disabled=!canRunAi();
        button.onclick=() => { $('prompt').value=prompt; $('prompt').dispatchEvent(new Event('input')); $('prompt').focus({preventScroll:true}); };
        suggestions.append(button);
      }
      entry.append(title,hint,suggestions); fragment.append(entry);
    }
    messages.replaceChildren(fragment); messages.scrollTop=bottom ? messages.scrollHeight : previousTop;
    if (focusedApproval) {
      const card=[...messages.querySelectorAll('.approval')].find(card => card.dataset.approvalId===focusedApproval.id);
      const target=focusedApproval.choice ? [...(card?.querySelectorAll('.approval-actions button') || [])].find(button => button.dataset.choice===focusedApproval.choice) : card?.querySelector('.approval-more > summary');
      target?.focus({preventScroll:true});
    }
    state.messageScrollTop=messages.scrollTop;
  }
  $('messages').addEventListener('scroll',() => { if (aiVisible()) state.messageScrollTop=$('messages').scrollTop; },{passive:true});
  $('prompt-form').onsubmit=event => {
    event.preventDefault(); if (!canRunAi()) return notice('AI actions require AI, file editing and terminal access.',true); const prompt=$('prompt').value.trim(); if (!prompt) return;
    const projectId=state.projectId, generation=state.generation;
    safe(async () => {
      await flushAll(); ensureProject(projectId,generation); if ([...state.docs.values()].some(doc => doc.dirty)) throw new Error('Save your open files before asking AI, so it sees the current code on disk.');
      const doc=current();
      await command('ai_start',{provider:$('provider').value,prompt,path:doc ? doc.path : null},true);
      if (state.projectId===projectId) { $('prompt').value=''; $('prompt').style.height=''; }
      else if (state.projectViews.has(projectId)) state.projectViews.get(projectId).prompt='';
    })();
  };
  $('prompt').addEventListener('focus',() => { if (aiOpen() && app.dataset.aiLayout==='split') { app.dataset.view='ai'; syncViewControls(); } });
  $('prompt').addEventListener('input',() => { $('prompt').style.height='auto'; $('prompt').style.height=Math.min(110,$('prompt').scrollHeight)+'px'; });
  $('prompt').addEventListener('keydown',event => { if (event.key==='Enter' && !event.shiftKey && !event.isComposing && !mobile()) { event.preventDefault(); $('prompt-form').requestSubmit(); } });
  $('ai-cancel').onclick=safe(() => command('ai_cancel',{},true));
  function dismissReview() {
    state.proposal=null; $('review-dialog').close();
    $('review-original').textContent=''; $('review-proposed').textContent=''; $('review-description').textContent='';
  }
  $('review-dialog').addEventListener('close',() => { if (!$('review-dialog').open) dismissReview(); });
  $('apply-change').onclick=async () => {
    $('review-error').hidden=true;
    const projectId=state.projectId, generation=state.generation;
    try {
      const proposal=state.proposal; if (!proposal) return;
      const doc=state.docs.get(proposal.path); await flush(doc); ensureProject(projectId,generation);
      if (!doc || doc.revision!==proposal.revision || doc.content!==proposal.original) throw new Error('This file changed since the AI request. Keep your edits and ask for a fresh replacement.');
      await command('edit_file',{path:doc.path,baseRevision:doc.revision,content:proposal.text},true); ensureProject(projectId,generation); selectLocal(doc.path); $('review-dialog').close(); notice('Applied to buffer. Save when ready.');
    } catch(error) { dialogError('review-error',error); }
  };
  document.addEventListener('keydown',event => {
    if (!$('pc-welcome').hidden) return;
    if (event.isComposing || document.querySelector('dialog[open]')) return;
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase()==='s') { event.preventDefault(); safe(saveFile)(); }
    if (event.ctrlKey && event.key==='`') { event.preventDefault(); safe(() => toggleTerminal())(); }
    if (event.key==='Escape') {
      if (!$('project-menu').hidden) { event.preventDefault(); closeProjectPicker(true); }
      else if (activeMenu) { event.preventDefault(); closeMenu(true); }
      else if (aiOpen() && (app.dataset.view==='ai' || $('ai-panel').contains(event.target))) { event.preventDefault(); toggleAi(false); }
      else if (terminalOpen && $('terminal-panel').contains(event.target)) { event.preventDefault(); safe(() => toggleTerminal(false))(); }
    }
  });
  function syncViewport() {
    const viewport=window.visualViewport;
    document.documentElement.style.setProperty('--viewport-height',(viewport ? viewport.height : innerHeight)+'px');
    document.documentElement.style.setProperty('--viewport-top',(viewport ? viewport.offsetTop : 0)+'px');
    app.dataset.shortViewport=(viewport ? viewport.height : innerHeight)<=400 ? 'yes' : 'no';
    $('files-menu').dataset.shortViewport=app.dataset.shortViewport;
    if (activeMenu==='files') {
      const breadcrumbs=$('directory-breadcrumbs'); breadcrumbs.scrollLeft=breadcrumbs.scrollWidth;
    }
    if (!$('project-menu').hidden) positionPopover($('project-menu'),projectPickerInvoker,true);
    if (activeMenu) { const [menuId,triggerId]=commandMenus[activeMenu]; positionPopover($(menuId),$(triggerId),true); }
    const device=mobile() ? 'phone' : 'desktop';
    if (device!==layoutDevice) {
      rememberCodeView(); if (aiVisible()) state.messageScrollTop=$('messages').scrollTop;
      layoutDevice=device; app.dataset.aiLayout=preferredAiLayout();
      if (!mobile() && app.dataset.view==='terminal') app.dataset.view='code';
      syncViewControls(); restoreCodeView(); if (aiVisible()) renderAi(true);
    }
    syncViewControls(); paintCode(); if (terminalOpen) { terminalMetrics(); paintTerminal(); } scheduleResize();
  }
  window.addEventListener('resize',syncViewport);
  if (window.visualViewport) { visualViewport.addEventListener('resize',syncViewport); visualViewport.addEventListener('scroll',syncViewport,{passive:true}); }
  syncViewport();
  document.addEventListener('visibilitychange',() => { if (document.hidden) { clearCodeCache(); cancelAnimationFrame(paintFrame); } else { paintCode(); paintTerminal(); queueAi(); } });
  window.addEventListener('beforeunload',event => { if (draftStore.usage().count || [...state.docs.values()].some(doc => doc.localText!=null)) { event.preventDefault(); event.returnValue=''; } });
  // A narrow lifecycle hook for the native window, with no filesystem or shell
  // bridge. The same authenticated HTTP/WS session still owns all commands.
  const desktopViewKey='relay-desktop-reload-view';
  try {
    const saved=sessionStorage.getItem(desktopViewKey);
    if (saved && saved.length<=262144) {
      const records=JSON.parse(saved);
      if (Array.isArray(records) && records.length<=32) for (const [id,view] of records) {
        if (typeof id==='string' && id.length<=256 && view && ['code','ai','terminal'].includes(view.mode) && Array.isArray(view.views) && view.views.length<=32) state.projectViews.set(id,{...view,views:new Map(view.views)});
      }
    }
    sessionStorage.removeItem(desktopViewKey);
  } catch { /* A malformed or unavailable view record does not block startup. */ }
  window.nimloDesktop=Object.freeze({
    closeFile() { safe(() => closeFile())(); return true; },
    save() {
      if (!current() || !writable() || state.switching || composition || terminalComposing || app.dataset.composing==='true' || document.querySelector('dialog[open]')) return false;
      safe(saveFile)(); return true;
    },
    undo() { return desktopHistory(); },
    redo() { return desktopHistory(true); },
    findInFile:openFileFind,
    findNext:() => navigateFileFind(),
    findPrevious:() => navigateFileFind(true),
    canUpdate() {
      return state.connected && !state.switching && !composition && !terminalComposing && !document.querySelector('dialog[open]');
    },
    async prepareReload(restart=false) {
      if (!state.connected || state.switching || app.dataset.composing==='true' || terminalComposing || document.querySelector('dialog[open]') || state.pending.size) return false;
      try {
        for (const doc of state.docs.values()) if (doc.localText!=null && !doc.closed) await flush(doc);
        if (draftStore.volatile.size || [...state.docs.values()].some(doc => doc.localText!=null || doc.inflight || doc.needsReview)) return false;
        if (restart) {
          if (draftStore.usage().count) return false;
          for (const project of state.projects) {
            const response=await fetch('/api/bootstrap?projectId='+encodeURIComponent(project.id),{credentials:'same-origin',cache:'no-store'});
            if (!response.ok) return false;
            const b=await response.json();
            if (b.terminal?.running || ['starting','running','awaiting_approval','cancelling'].includes(b.ai?.status) || b.internet?.status==='ready' || b.clients?.filter(client => client.connected).length>1) return false;
          }
        }
        rememberProjectView();
        const saved=JSON.stringify([...state.projectViews].map(([id,view]) => [id,{...view,views:[...view.views]}]));
        if (saved.length>262144) return false;
        sessionStorage.setItem(desktopViewKey,saved);
        return !draftStore.volatile.size && !state.pending.size && !state.switching && ![...state.docs.values()].some(doc => doc.localText!=null);
      } catch { return false; }
    },
    async quitState() {
      const pending=!!draftStore.usage().count || [...state.docs.values()].some(doc => doc.localText!=null || doc.inflight) || state.pending.size>0;
      let work=false,dirty=false;
      try {
        for (const project of state.projects) {
          const response=await fetch('/api/bootstrap?projectId='+encodeURIComponent(project.id),{credentials:'same-origin',cache:'no-store'});
          if (!response.ok) return {pending:true,work:true,dirty:true};
          const b=await response.json();
          work ||= !!b.terminal?.running || ['starting','running','awaiting_approval','cancelling'].includes(b.ai?.status) || b.internet?.status==='ready' || b.clients?.filter(client => client.connected).length>1;
          dirty ||= b.openFiles?.some(file => file.dirty || file.conflict);
        }
        return {pending,work,dirty};
      } catch { return {pending:true,work:true,dirty:true}; }
    }
  });
  let pcOpenTimer, pcOpenEpoch=0, authEpoch=0;
  function stopPcRecovery() { clearTimeout(pcOpenTimer); pcOpenTimer=null; pcOpenEpoch++; $('pc-open-editor').disabled=false; }
  async function getBootstrap(token) {
    const attempt=++authEpoch;
    const query=new URLSearchParams({clientId:state.clientId});
    if (state.projectId) query.set('projectId',state.projectId);
    const response=await fetch('/api/bootstrap?'+query,{headers:token ? {Authorization:'Bearer '+token} : {},credentials:'same-origin',cache:'no-store'});
    if (attempt!==authEpoch) return false;
    if (response.status===401) {
      if (joinInvite && joinExpiresAt<=Date.now()) rememberJoinInvitation(null);
      const local=isLocalPc(), failure=await response.json().catch(() => ({}));
      if (attempt!==authEpoch) return false;
      // Normalize fresh PC entry only. Invites and local drafts keep their origin.
      let storedDrafts=true;
      try { storedDrafts=Object.keys(sessionStorage).some(key => key.startsWith('relay-draft:')); } catch {}
      if (local && !joinInvite && !token && !state.sessionId && !state.docs.size && !storedDrafts && failure.pcOrigin) {
        const canonical=new URL(failure.pcOrigin);
        if (canonical.protocol==='http:' && loopbackHost(canonical.hostname) && canonical.port===location.port && canonical.pathname==='/' && !canonical.search && !canonical.hash && !canonical.username && !canonical.password && canonical.origin!==location.origin) {
          location.replace(canonical.origin+'/'); return false;
        }
      }
      const pc=local && !joinInvite, firstPc=pc && $('pc-welcome').hidden;
      $('pc-welcome').hidden=!pc; app.hidden=pc;
      $('launch-form').hidden=!pc;
      $('join-form').hidden=!joinInvite;
      $('join-link-form').hidden=pc || !!joinInvite;
      $('join-retry-actions').hidden=!!joinInvite;
      $('join-code').disabled=!joinInvite; $('join-submit').disabled=!joinInvite;
      $('join-password').disabled=!joinInvite; $('join-password').required=!!failure.passwordRequired;
      $('join-password-status').textContent=failure.passwordRequired ? 'Required' : 'Optional';
      $('session-count').hidden=true; $('connection-state').dataset.status='signed-out';
      $('connection-state').setAttribute('aria-label','Session · Sign in'); $('connection-state').title='Session · Sign in';
      if (pc) {
        $('join-dialog').close(); closeMenu(); closeProjectPicker();
        if (firstPc) $('pc-open-editor').focus({preventScroll:true});
      } else {
        stopPcRecovery();
        $('join-title').textContent=joinInvite ? 'Join your PC session' : 'Open an invitation from your PC';
        $('join-hint').textContent=joinInvite ? 'Enter the six-digit code shown on your PC. The PC host chooses this device’s file, terminal and AI permissions.' : 'On your PC, choose Pair a device → Copy invitation link. Paste that complete link below to continue.';
        showDialog('join-dialog');
      }
      return false;
    }
    if (!response.ok) throw new Error('Unable to connect to the host ('+response.status+').');
    const value=await response.json(); if (attempt!==authEpoch) return false;
    const pcWasVisible=!$('pc-welcome').hidden;
    app.hidden=pcWasVisible; stopPcRecovery();
    bootstrap(value);
    rememberJoinInvitation(null); $('join-link').value=''; $('launch-link').value=''; $('join-code').value=''; $('join-password').value=''; $('join-error').hidden=true; $('pc-open-error').hidden=true;
    $('pc-open-status').textContent=pcWasVisible ? 'Connecting to your workspace…' : ''; $('pc-launch-details').open=false; $('join-dialog').close();
    // Replacement context is supplied by the host and shared across devices.
    return true;
  }
  function connect() {
    clearTimeout(reconnectTimer);
    const query=new URLSearchParams({clientId:state.clientId,name:mobile() ? 'Phone' : 'Desktop',patches:'1'});
    if (state.projectId) query.set('projectId',state.projectId);
    const socket=new WebSocket((location.protocol==='https:' ? 'wss://' : 'ws://')+location.host+'/ws?'+query);
    state.socket=socket;
    socket.onopen=() => {
      state.connected=true; state.reconnect=0;
      const pcWasVisible=!$('pc-welcome').hidden;
      app.hidden=false; $('pc-welcome').hidden=true; $('pc-open-status').textContent=''; updateControls();
      if (pcWasVisible) { syncViewport(); $('files-toggle').focus({preventScroll:true}); }
    };
    socket.onmessage=event => { try { receive(JSON.parse(event.data)); } catch(error) { report(error); } };
    socket.onclose=event => {
      if (state.socket!==socket) return; state.connected=false;
      for (const pending of state.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('Disconnected. Pending edits are kept on this device.')); }
      state.pending.clear(); updateControls();
      if (event.code===1008) { notice('Access ended or this connection was replaced. Your pending edits are kept on this device.',true); getBootstrap().catch(report); return; }
      reconnectTimer=setTimeout(async () => { try { if (await getBootstrap()) connect(); } catch(error) { report(error); connect(); } },Math.min(5000,350*Math.pow(1.6,state.reconnect++)));
    };
    socket.onerror=() => {};
  }
  $('join-form').onsubmit=async event => {
    event.preventDefault(); $('join-error').hidden=true; $('join-submit').disabled=true;
    try {
      if (!joinInvite) throw new Error('Open a fresh invitation link from your PC to pair.');
      const response=await fetch('/api/pair',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:$('join-code').value.trim(),invite:joinInvite,password:$('join-password').value || null}),credentials:'same-origin'});
      const result=await response.json(); if (!response.ok) {
        if (result.code==='password_required' || result.error==='password_required' || result.passwordRequired) { $('join-password').required=true; $('join-password-status').textContent='Required'; $('join-password').focus(); }
        throw new Error(result.message || result.error || 'Pairing failed.');
      }
      rememberJoinInvitation(null); $('join-code').value=''; $('join-password').value=''; if (await getBootstrap()) connect();
    } catch(error) { dialogError('join-error',error); } finally { $('join-submit').disabled=!joinInvite; }
  };
  let joinInvite=null, joinExpiresAt=0;
  const pendingInvitationKey='relay-pending-invitation';
  function rememberJoinInvitation(invite,expiresAt=Date.now()+120000) {
    joinInvite=invite; joinExpiresAt=invite ? expiresAt : 0;
    try {
      if (invite) sessionStorage.setItem(pendingInvitationKey,JSON.stringify({invite,expiresAt}));
      else sessionStorage.removeItem(pendingInvitationKey);
    } catch { /* Pairing remains usable when browser storage is unavailable. */ }
  }
  function restoreJoinInvitation() {
    try {
      const saved=sessionStorage.getItem(pendingInvitationKey);
      if (saved && saved.length<=256) {
        const value=JSON.parse(saved), now=Date.now();
        if (/^[a-f0-9]{64}$/.test(value.invite || '') && Number.isFinite(value.expiresAt) && value.expiresAt>now && value.expiresAt<=now+120000) return rememberJoinInvitation(value.invite,value.expiresAt);
      }
    } catch {}
    rememberJoinInvitation(null);
  }
  $('join-link-form').onsubmit=async event => {
    event.preventDefault(); $('join-error').hidden=true; $('join-link-submit').disabled=true;
    const pasted=$('join-link').value.trim(); $('join-link').value='';
    try {
      let link; try { link=new URL(pasted); } catch { throw new Error('Paste the complete invitation link copied on your PC.'); }
      const fragment=new URLSearchParams(link.hash.slice(1)), invite=fragment.get('invite');
      if (!['http:','https:'].includes(link.protocol) || link.pathname!=='/' || link.search || link.username || link.password || [...fragment.keys()].length!==1 || !/^[a-f0-9]{64}$/.test(invite || '')) throw new Error('This is not a complete invitation. Use Copy invitation link on your PC; the server address alone cannot pair.');
      if (link.origin!==location.origin) { location.assign(link.href); return; }
      rememberJoinInvitation(invite);
      if (await getBootstrap()) connect();
      else if (joinInvite) $('join-code').focus({preventScroll:true});
    } catch(error) { dialogError('join-error',error); }
    finally { $('join-link-submit').disabled=false; }
  };
  $('join-change').onclick=async () => {
    rememberJoinInvitation(null); $('join-code').value=''; $('join-password').value=''; $('join-password').required=false; $('join-error').hidden=true;
    try { if (await getBootstrap()) connect(); else $('join-link').focus({preventScroll:true}); }
    catch(error) { dialogError('join-error',error); }
  };
  const loopbackHost=host => ['localhost','127.0.0.1','[::1]'].includes(host);
  // This only chooses instructions. The host still verifies every credential.
  const isLocalPc=() => location.protocol==='http:' && loopbackHost(location.hostname);
  $('launch-form').onsubmit=async event => {
    event.preventDefault(); stopPcRecovery(); $('pc-open-error').hidden=true; $('launch-submit').disabled=true;
    const pasted=$('launch-link').value.trim(); $('launch-link').value='';
    try {
      let link; try { link=new URL(pasted); } catch { throw new Error('Paste the complete private launch link from the host terminal.'); }
      const fragment=new URLSearchParams(link.hash.slice(1)), token=fragment.get('token');
      if (!isLocalPc() || link.protocol!=='http:' || !loopbackHost(link.hostname) || link.port!==location.port || link.pathname!=='/' || link.username || link.password || link.search || [...fragment.keys()].length!==1 || !/^[a-f0-9]{64}$/.test(token || '')) throw new Error('Use the private PC launch link for this Nimlo address. Phone invitations open on the phone.');
      if (!(await getBootstrap(token))) throw new Error('That launch link is no longer valid. Use the link printed by the currently running host.');
      connect();
    } catch(error) { dialogError(isLocalPc() && !joinInvite ? 'pc-open-error' : 'join-error',error); } finally { $('launch-submit').disabled=false; }
  };
  $('pc-open-editor').onclick=async () => {
    stopPcRecovery(); const epoch=pcOpenEpoch;
    $('pc-open-editor').disabled=true; $('pc-open-error').hidden=true; $('pc-open-status').textContent='Opening your default browser…';
    try {
      const response=await fetch('/api/pc/open',{method:'POST',headers:{'X-Nimlo-Launch':'1'},credentials:'same-origin',cache:'no-store'});
      const result=await response.json(); if (epoch!==pcOpenEpoch) return;
      if (!response.ok || !result.opened) throw new Error(result.message || 'Unable to open your browser.');
      $('pc-open-status').textContent='Opened in your default browser. Connecting this tab…';
      const deadline=Date.now()+8000;
      const probe=async () => {
        if (epoch!==pcOpenEpoch) return;
        try {
          if (await getBootstrap()) { if (!state.connected) connect(); return; }
          if (epoch!==pcOpenEpoch) return;
          if (Date.now()>=deadline) {
            stopPcRecovery(); $('pc-open-status').textContent='If the editor opened in another browser, continue there. To use this browser, open the option below.'; $('pc-launch-details').open=true;
          } else pcOpenTimer=setTimeout(probe,650);
        } catch(error) { if (epoch===pcOpenEpoch) { stopPcRecovery(); dialogError('pc-open-error',error); $('pc-launch-details').open=true; } }
      };
      await probe();
    } catch(error) {
      if (epoch===pcOpenEpoch) { stopPcRecovery(); dialogError('pc-open-error',error); $('pc-launch-details').open=true; $('pc-open-status').textContent='You can retry, or continue here with your private launch link.'; }
    }
  };
  $('pc-retry').onclick=async () => {
    stopPcRecovery(); $('pc-open-error').hidden=true; $('pc-retry').disabled=true;
    try { if (await getBootstrap()) { if (!state.connected) connect(); } else $('pc-open-status').textContent='Choose Open editor to sign in securely, or use a private link in the option below.'; }
    catch(error) { dialogError('pc-open-error',error); } finally { $('pc-retry').disabled=false; }
  };
  $('join-retry').onclick=async () => {
    $('join-error').hidden=true; $('join-retry').disabled=true;
    try { if (await getBootstrap()) connect(); else dialogError('join-error',new Error('This browser is still signed out. Follow the instructions above.')); }
    catch(error) { dialogError('join-error',error); } finally { $('join-retry').disabled=false; }
  };
  async function openLaunchLink() {
    const fragments=new URLSearchParams(location.hash.slice(1)), rawToken=fragments.get('token'), invite=fragments.get('invite');
    const token=isLocalPc() && /^[a-f0-9]{64}$/.test(rawToken || '') ? rawToken : null;
    if (location.hash) rememberJoinInvitation(/^[a-f0-9]{64}$/.test(invite || '') ? invite : null);
    else restoreJoinInvitation();
    stopPcRecovery(); $('join-error').hidden=true; $('pc-open-error').hidden=true; $('launch-link').value=''; $('join-code').value='';
    if (location.hash) history.replaceState(null,'',location.pathname+location.search);
    if (await getBootstrap(token)) { if (!state.connected || token) connect(); }
  }
  // Pasting an invitation while the join screen is already open can be a
  // same-document navigation; handle it without losing local drafts.
  window.addEventListener('hashchange',() => openLaunchLink().catch(report));
  openLaunchLink().catch(report);
})();
