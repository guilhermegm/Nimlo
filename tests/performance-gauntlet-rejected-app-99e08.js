'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const app = $('app'), input = $('code-input');
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
  const state = {socket:null, connected:false, access:null, clientId:'', controllerId:null, generation:0,
    sessionId:null, projectId:null, projects:[], projectViews:new Map(), projectTrees:new Map(), workspace:'', workspacePath:'', pickerAvailable:false, switching:false, docs:new Map(), path:null, clients:[], directory:'', files:[],
    urls:[], internet:null, providers:[], terminal:null, ai:null, request:0, pending:new Map(), reconnect:0,
    aiContext:null, aiSettings:null, settingsDraft:null, settingsProvider:'codex', proposal:null, conflict:null, history:[], historyVersion:-1};
  let reconnectTimer, noticeTimer, editTimer, paintFrame, resizeTimer, aiFrame, editorHistoryBusy=false, editorPending=false, editorStale=false;
  const writable = () => state.connected && state.access === 'shared';
  const ownsTerminal = () => writable() && state.controllerId === state.clientId;
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
  function saveDraft(doc) {
    try {
      const key = 'relay-draft:' + (doc.workspacePath || state.workspacePath) + ':' + doc.path;
      if (doc.localText == null) sessionStorage.removeItem(key);
      else sessionStorage.setItem(key, JSON.stringify({path:doc.path,workspacePath:doc.workspacePath || state.workspacePath,text:doc.localText,baseRevision:doc.draftBase == null ? doc.revision : doc.draftBase,sessionId:doc.sessionId || state.sessionId}));
      return true;
    } catch { return false; /* Never evict the only copy of a pending draft. */ }
  }
  function trimClosedDrafts() {
    let count=[...state.docs.values()].filter(doc => doc.closed).length;
    for (const [path,doc] of state.docs) {
      if (count<=8) break;
      if (doc.closed && saveDraft(doc)) { state.docs.delete(path); count--; }
    }
  }
  function readDraft(path) { try { return JSON.parse(sessionStorage.getItem('relay-draft:'+state.workspacePath+':'+path)); } catch { return null; } }
  function command(type, fields={}, mutate=false) {
    if (!state.connected || !state.socket || state.socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Disconnected. Your pending edits are kept on this device.'));
    if (mutate && !writable()) return Promise.reject(new Error('Wait for this device to reconnect to the shared session.'));
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
    const owner = writable() && !state.switching, doc = current();
    $('file-context-label').textContent=doc && doc.path.includes('/') ? 'Files · '+doc.path.slice(0,doc.path.lastIndexOf('/')) : 'Files';
    const project=state.projects.find(item => item.id===state.projectId), duplicate=project && state.projects.some(other => other.id!==project.id && other.name===project.name);
    $('project-label').textContent=state.workspace || 'Project'; $('project-parent-label').textContent=duplicate ? projectParent(project) : '';
    $('project-parent-label').hidden=!duplicate;
    for (const id of ['projects-toggle','ai-project-toggle','terminal-project-toggle']) {
      $(id).title='Current project · '+state.workspacePath+' · Switch files, AI and terminal';
      $(id).setAttribute('aria-label','Current project '+projectContext()+' · Switch files, AI and terminal'); $(id).disabled=state.switching;
    }
    $('ai-project-label').textContent=projectContext(); $('terminal-project-label').textContent=projectContext();
    $('terminal-host').textContent=state.terminal?.running ? 'PC host' : 'Shell ended';
    $('terminal-host').title=state.terminal?.running ? 'Host shell · '+state.workspacePath : 'Start a shell in '+state.workspacePath;
    $('new-file').title='New file in '+projectContext(); $('new-file').setAttribute('aria-label','New file in '+projectContext());
    app.dataset.controller = owner ? 'yes' : 'no';
    app.dataset.connected = state.connected ? 'yes' : 'no';
    $('connection-state').textContent = state.connected ? '' : 'Reconnecting';
    $('view-only').hidden = true;
    input.readOnly = !owner || !doc || !!doc.closed || !!state.conflict || state.switching;
    document.querySelectorAll('[data-edit-action]').forEach(button => {
      button.disabled=button.dataset.editAction!=='done' && (input.readOnly || app.dataset.composing==='true' || editorHistoryBusy);
    });
    $('save-button').hidden = !doc || !(doc.dirty || doc.localText != null);
    $('save-button').disabled = !owner;
    $('dirty-dot').textContent = doc && (doc.dirty || doc.localText != null) ? '●' : '';
    $('new-file').disabled = !owner || state.switching; $('pair-phone').disabled = !owner;
    document.querySelectorAll('.project-expand,.quick-project-select,.project-remove').forEach(button => button.disabled=!owner || state.switching || (button.classList.contains('project-remove') && state.projects.length<2));
    $('project-path').disabled=!owner || state.switching;
    $('project-submit').disabled=!owner || state.switching;
    $('project-browse').hidden=!state.pickerAvailable;
    $('project-browse').disabled=!owner || state.switching;
    $('project-readonly').hidden=owner;
    $('take-control').hidden = true; $('request-control').hidden = true;
    $('control-note').textContent = owner ? 'All paired devices can edit files and run commands on this PC.' : 'Reconnecting to the shared PC session…';
    const running = !!(state.terminal && state.terminal.running);
    $('terminal-command').disabled = !owner || !running; $('terminal-run').disabled = !owner || !running;
    $('terminal-screen').setAttribute('aria-readonly', String(!owner));
    $('terminal-end').hidden = !owner || !running; $('terminal-restart').hidden = running;
    $('terminal-restart').disabled = !owner;
    document.querySelectorAll('[data-term-key]').forEach(button => button.disabled = !owner || !running);
    const busy = state.ai && ['starting','running','awaiting_approval','cancelling'].includes(state.ai.status);
    $('ai-send').disabled = !owner || busy; $('provider').disabled = busy;
    $('ai-cancel').hidden = !busy; $('ai-cancel').disabled = !owner;
    for (const id of ['settings-provider','settings-model','settings-effort','settings-submit','settings-auth-refresh']) $(id).disabled=!owner || !!busy || !!state.settingsLoading;
    $('settings-readonly').hidden=owner;
    document.querySelectorAll('.approval-actions button').forEach(button => button.disabled = !owner);
    if ($('pair-dialog').open) paintPairing();
    renderDevices();
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
      const wasWritable=writable();
      state.controllerId = event.controllerId; state.generation = event.generation; state.clients = event.clients; state.pairedSessions=event.pairedSessions || 0;
      state.access=event.access || state.access;
      updateControls(); if (writable() && !wasWritable) resumeDrafts(); scheduleResize();
    } else if (event.type === 'file_state') fileState(event.file,false,event.sourceClientId);
    else if (event.type === 'active_file') {
      if (event.path && state.docs.has(event.path)) selectLocal(event.path);
      else if (!event.path) selectLocal(null);
    } else if (event.type === 'file_closed') fileClosed(event.path);
    else if (event.type === 'files') {
      const directory=event.directory || '';
      if (directory!==state.directory) { $('file-filter').value=''; $('file-tree').scrollTop=0; }
      state.directory=directory; state.files=event.files; cacheProjectFiles(state.projectId,directory,event.files); treeFor(state.projectId).expanded.add(directory); renderFiles();
    }
    else if (event.type === 'terminal_state') { state.terminal = event.terminal; if (!event.terminal.running || event.terminal.alternate_screen) state.history = []; paintTerminal(); refreshHistory(); updateControls(); }
    else if (event.type === 'terminal_history') { state.history = event.lines || []; paintTerminal(); }
    else if (event.type === 'ai_state') { state.ai = event.ai; if ('aiContext' in event) state.aiContext=event.aiContext; if (event.providers) state.providers = event.providers; queueAi(); updateControls(); }
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
    if (projectChanged) {
      rememberProjectView();
      for (const doc of state.docs.values()) saveDraft(doc);
      clearTimeout(editTimer); clearTimeout(resizeTimer); clearTimeout(historyTimer);
      historyTimer=null; state.history=[]; state.docs.clear(); state.path=null; state.conflict=null; state.proposal=null;
      state.terminalView=null; state.messageScrollTop=0; state.terminalFollow=true; state.autoScrollTop=null; hideTerminalKeys();
      $('file-filter').value=''; app.dataset.editing='no';
      for (const id of ['conflict-dialog','review-dialog','new-dialog']) $(id).close();
      $('prompt').value=''; $('prompt').style.height=''; closeMenu();
      $('terminal-command').value=''; terminalComposing=false;
    }
    state.sessionId = event.sessionId; state.workspace = event.workspace; state.projectId=event.projectId || state.projectId;
    state.projects=event.projects || state.projects;
    try { if (state.projectId) sessionStorage.setItem('relay-project',state.projectId); } catch {}
    state.workspacePath=event.workspacePath || state.workspacePath; state.pickerAvailable=!!event.pickerAvailable;
    const view=state.projectViews.get(state.projectId);
    if (projectChanged) {
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
    state.controllerId = event.controllerId; state.generation = event.generation; state.access=event.access || null;
    state.clients = event.clients || []; state.pairedSessions=event.pairedSessions || 0; state.urls = event.connectUrls || event.lanUrls || [];
    state.internet=event.internet || null;
    if (state.directory) $('file-filter').value='';
    state.providers = event.providers || []; state.files = event.files || []; state.directory = '';
    const incoming = new Set((event.openFiles || []).map(file => file.path));
    for (const [path,doc] of state.docs) {
      if (!incoming.has(path)) {
        if (doc.localText == null) state.docs.delete(path);
        else { doc.closed=true; doc.needsReview=true; saveDraft(doc); }
        if (state.conflict?.doc===doc) { state.conflict=null; $('conflict-dialog').close(); }
      }
    }
    trimClosedDrafts();
    (event.openFiles || []).forEach(file => fileState(file, oldSession && oldSession !== event.sessionId));
    state.terminal = event.terminal; state.ai = event.ai;
    if ('aiContext' in event) state.aiContext=event.aiContext;
    selectLocal((projectChanged && state.docs.has(view?.path) ? view.path : null) || event.activePath || state.path || (event.openFiles[0] && event.openFiles[0].path) || null);
    $('workspace-name').textContent = event.workspace;
    $('workspace-name').title=state.workspacePath;
    $('project-current').textContent=state.projects.length+' project'+(state.projects.length===1 ? '' : 's')+' in this session';
    $('empty-project-hint').textContent='from '+state.workspace;
    if (state.projectId) { cacheProjectFiles(state.projectId,'',state.files); treeFor(state.projectId).expanded.add(''); }
    renderFiles(); renderOpenFiles(); renderProviders(); queueAi(); paintTerminal(); updateControls();
    if (!$('project-menu').hidden) renderProjectPicker();
    if (writable()) resumeDrafts();
    if (view && projectChanged && view.directory) {
      const projectId=state.projectId, generation=state.generation;
      command('list_files',{directory:view.directory}).then(() => { if (state.projectId===projectId && state.generation===generation) { $('file-filter').value=view.filter || ''; renderFiles(); } }).catch(() => {});
    }
    if (terminalOpen && state.connected) { refreshHistory(); scheduleResize(); }
  }
  function rememberProjectView() {
    if (!state.projectId) return;
    rememberCodeView();
    const views=new Map(); for (const doc of state.docs.values()) if (doc.view && views.size<32) views.set(doc.path,doc.view);
    state.projectViews.delete(state.projectId);
    const field=$('terminal-command'), value=field.value.slice(0,8192);
    const terminalDraft=value ? {value,start:Math.min(field.selectionStart,value.length),end:Math.min(field.selectionEnd,value.length),direction:field.selectionDirection} : null;
    state.projectViews.set(state.projectId,{path:state.path,prompt:$('prompt').value,mode:app.dataset.view,aiOpen:aiOpen(),terminalOpen,directory:state.directory,filter:$('file-filter').value,terminalView:state.terminalView,terminalDraft,messageScrollTop:state.messageScrollTop,views});
    while (state.projectViews.size>32) state.projectViews.delete(state.projectViews.keys().next().value);
  }
  function fileState(file, newSession=false, sourceClientId=null) {
    let doc = state.docs.get(file.path);
    if (!doc) {
      doc = Object.assign({localText:null,inflight:null,draftBase:null,workspacePath:state.workspacePath,sessionId:state.sessionId,view:state.projectViews.get(state.projectId)?.views.get(file.path)},file);
      state.docs.set(file.path,doc);
      const draft = readDraft(file.path);
      if (draft && draft.text !== file.content) {
        doc.localText = draft.text; doc.draftBase = draft.baseRevision;
        if (draft.workspacePath!==state.workspacePath || draft.sessionId !== state.sessionId || draft.baseRevision !== file.revision) doc.needsReview = true;
      }
    } else {
      // Direct replies can arrive before older queued broadcasts.
      if (!newSession && file.revision < doc.revision) return;
      const pending = doc.localText;
      const sent=doc.sentEdit;
      const ownEdit=sourceClientId===state.clientId && sent && sent.text===file.content && file.revision>sent.baseRevision;
      if (pending != null && pending !== file.content && (newSession || doc.closed || (file.revision !== doc.revision && !ownEdit))) doc.needsReview = true;
      Object.assign(doc,file);
      if (pending === file.content && (!sent || sent.text===file.content || file.revision>sent.baseRevision)) { doc.localText = null; doc.draftBase = null; doc.needsReview = false; }
      else if (pending != null) {
        doc.localText = pending;
        if (ownEdit && !doc.needsReview) doc.draftBase=file.revision;
      }
      doc.closed=false; doc.sessionId=state.sessionId; saveDraft(doc);
    }
    if (doc.path === state.path) {
      // A passive paired display can receive several source snapshots before
      // its next frame. Keep every model update, but build native textarea
      // contents only for the latest one. Interactive edits stay synchronous.
      const passive=sourceClientId && sourceClientId!==state.clientId && !newSession && doc.localText==null && !doc.closed && !doc.needsReview && !doc.conflict && !state.conflict && !state.switching && !editorHistoryBusy && app.dataset.composing!=='true' && document.activeElement!==input && !document.hidden && app.dataset.codeVisible==='yes';
      if (passive) { editorPending=true; editorStale=true; paintCode(); }
      else renderEditor();
    }
    renderOpenFiles(); updateControls();
    if (state.conflict?.doc===doc) {
      if (doc.needsReview || doc.conflict) showConflict(doc,doc.needsReview ? 'draft' : 'disk');
      else { state.conflict=null; $('conflict-dialog').close(); updateControls(); }
    } else if (writable() && !state.conflict) {
      if (doc.needsReview) showConflict(doc,'draft');
      else if (doc.conflict) showConflict(doc,'disk');
    }
  }
  function fileClosed(path) {
    const doc=state.docs.get(path); if (!doc) return;
    if (doc.localText != null) {
      doc.closed=true; doc.needsReview=true; saveDraft(doc);
      trimClosedDrafts();
      notice('Another device closed '+path+'. Your pending edits are kept here; reopen it from Files to review them.');
    } else state.docs.delete(path);
    if (state.conflict?.doc===doc) { state.conflict=null; $('conflict-dialog').close(); }
    if (state.path===path) selectLocal(null);
    renderOpenFiles(); updateControls();
  }
  function selectLocal(path) {
    const previous=current(), next=state.docs.has(path) ? path : null;
    if (previous && next!==state.path) rememberCodeView(previous);
    const changed=next!==state.path; state.path=next;
    const doc = current(); $('file-label').textContent = doc ? doc.path.split('/').pop() : 'Open a file';
    $('files-toggle').title = doc ? doc.path + ' · Files, terminal and devices' : 'Files, terminal and devices';
    renderEditor(); if (changed) restoreCodeView(doc); renderOpenFiles(); if (changed) renderFiles(); updateControls();
    if (doc && !doc.closed && writable() && !state.conflict) {
      if (doc.needsReview) showConflict(doc,'draft'); else if (doc.conflict) showConflict(doc,'disk');
    }
  }
  function rememberCodeView(doc=current()) {
    drainEditorRender();
    if (!doc || !input.clientHeight) return;
    const applied=doc.appliedView, previous=doc.view;
    const sameSelection=applied && input.selectionStart===applied.start && input.selectionEnd===applied.end && input.selectionDirection===applied.direction;
    // A wider or taller layout can clamp a restored offset. Keep the requested
    // position until the user scrolls or changes the native selection.
    doc.view={top:sameSelection && input.scrollTop===applied.top ? previous?.top ?? input.scrollTop : input.scrollTop,
      left:sameSelection && input.scrollLeft===applied.left ? previous?.left ?? input.scrollLeft : input.scrollLeft,
      start:input.selectionStart,end:input.selectionEnd,direction:input.selectionDirection};
  }
  function restoreCodeView(doc=current()) {
    // A hidden pane can cancel a queued display update. Restore the latest
    // source before its requested selection and scroll are applied.
    drainEditorRender();
    const view=doc?.view;
    input.setSelectionRange(view?.start || 0,view?.end || 0,view?.direction || 'none');
    input.scrollTop=view?.top || 0; input.scrollLeft=view?.left || 0;
    if (doc && input.clientHeight) doc.appliedView={top:input.scrollTop,left:input.scrollLeft,start:input.selectionStart,end:input.selectionEnd,direction:input.selectionDirection};
    paintCode();
  }
  function syncEditorValue() {
    editorPending=false; editorStale=false;
    const doc = current(), value = doc ? textOf(doc) : '';
    if (input.value !== value) {
      const start = input.selectionStart, end = input.selectionEnd, top=input.scrollTop, left=input.scrollLeft;
      input.value = value; input.setSelectionRange(Math.min(start,value.length),Math.min(end,value.length));
      input.scrollTop=top; input.scrollLeft=left;
    }
    $('editor-placeholder').hidden = !!doc;
  }
  function drainEditorRender() { if (editorStale) syncEditorValue(); }
  function renderEditor() {
    syncEditorValue();
    updateControls(); paintCode();
  }
  const escapeHtml = text => text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  function highlightLine(line) {
    const pattern = /(?:\/\/.*|#.*$)|(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\x60[^\x60]*\x60)|\b(?:const|let|var|function|return|if|else|for|while|class|import|from|export|default|async|await|new|try|catch|throw|def|fn|pub|use|struct|impl|match|mut|true|false|null|None|self)\b|\b\d+(?:\.\d+)?\b/g;
    let result = '', offset = 0;
    for (const match of line.matchAll(pattern)) {
      result += escapeHtml(line.slice(offset,match.index));
      const token = match[0], kind = token.startsWith('//') || token.startsWith('#') ? 'comment' : /^['"\x60]/.test(token) ? 'string' : /^\d/.test(token) ? 'number' : 'keyword';
      result += '<span class="' + kind + '">' + escapeHtml(token) + '</span>'; offset = match.index + token.length;
    }
    return result + escapeHtml(line.slice(offset));
  }
  // Only the active source needs a line index. One offset per 128 lines keeps
  // even an all-newline 1 MiB file below 33 KiB without retaining split strings.
  const codeRender={doc:null,text:null,offsets:null,lines:0,plain:false,start:-1,end:-1,html:'',numbers:''};
  function clearCodeIndex() {
    Object.assign(codeRender,{doc:null,text:null,offsets:null,lines:0,start:-1,end:-1});
  }
  function indexCode(doc,value) {
    const offsets=[0]; let position=0,lines=1,newline,plain=false;
    while ((newline=value.indexOf('\n',position))!==-1) {
      if (newline-position>8192) plain=true;
      position=newline+1;
      if (lines%128===0) offsets.push(position);
      lines++;
    }
    if (value.length-position>8192) plain=true;
    Object.assign(codeRender,{doc,text:value,offsets:Uint32Array.from(offsets),lines,plain,start:-1,end:-1});
  }
  function paintCode() {
    cancelAnimationFrame(paintFrame);
    // Background animation frames can remain suspended indefinitely. Release
    // removed documents and old source versions before waiting for a frame.
    const active=current();
    if (document.hidden || codeRender.doc!==active || (active && codeRender.text!==textOf(active))) clearCodeIndex();
    if (document.hidden) { editorPending=false; return; }
    paintFrame = requestAnimationFrame(() => {
      if (document.hidden) { editorPending=false; return; }
      if (editorPending) drainEditorRender();
      const highlight=$('highlight'), numbers=$('line-numbers');
      const doc = current(); if (!doc) {
        highlight.textContent=''; numbers.textContent='';
        Object.assign(codeRender,{doc:null,text:null,offsets:null,lines:0,start:-1,end:-1,html:'',numbers:''}); return;
      }
      const value = textOf(doc);
      if (codeRender.doc!==doc || codeRender.text!==value) indexCode(doc,value);
      document.querySelector('.codebox').dataset.plain = codeRender.plain ? 'true' : 'false';
      const lineHeight=parseFloat(getComputedStyle(input).lineHeight);
      const start = Math.max(0,Math.floor(input.scrollTop/lineHeight)-2), end = Math.min(codeRender.lines,start+Math.ceil(input.clientHeight/lineHeight)+5);
      if (start!==codeRender.start || end!==codeRender.end) {
        let html='';
        if (!codeRender.plain) {
          const block=Math.floor(start/128); let position=codeRender.offsets[block];
          for (let line=block*128;line<start;line++) position=value.indexOf('\n',position)+1;
          for (let line=start;line<end;line++) {
            const newline=value.indexOf('\n',position), limit=newline===-1 ? value.length : newline;
            html+=highlightLine(value.slice(position,limit))+'\n'; position=limit+1;
          }
        }
        if (html!==codeRender.html) { highlight.innerHTML=html; codeRender.html=html; }
        const labels=Array.from({length:end-start},(_,i) => start+i+1).join('\n');
        if (labels!==codeRender.numbers) { numbers.textContent=labels; codeRender.numbers=labels; }
        codeRender.start=start; codeRender.end=end;
      }
      highlight.style.transform = 'translate(' + -input.scrollLeft + 'px,' + (start*lineHeight-input.scrollTop) + 'px)';
      numbers.style.transform = 'translateY(' + (start*lineHeight-input.scrollTop) + 'px)';
    });
  }
  function exceedsFileLimit(value) {
    const limit=1024*1024;
    // UTF-8 uses at most three bytes per UTF-16 code unit. Ordinary small files
    // and large ASCII files need no encoded copy merely to validate their size.
    if (value.length>limit) return true;
    if (value.length<=Math.floor(limit/3) || !/[^\x00-\x7f]/.test(value)) return false;
    let bytes=value.length;
    for (let index=0;index<value.length;index++) {
      const code=value.charCodeAt(index);
      if (code<0x80) continue;
      if (code<0x800) bytes++;
      else {
        bytes+=2;
        if (code>=0xd800 && code<=0xdbff && value.charCodeAt(index+1)>=0xdc00 && value.charCodeAt(index+1)<=0xdfff) index++;
      }
      if (bytes>limit) return true;
    }
    return false;
  }
  function edited() {
    const doc = current(); if (!doc || !writable()) return;
    if (doc.localText==null && [...state.docs.values()].filter(item => item.closed).length>8) {
      input.value=textOf(doc); notice('Device draft storage is full. Reopen and save or discard a local draft from Files before editing another file.',true); return;
    }
    const value=input.value;
    if (exceedsFileLimit(value)) { input.value = textOf(doc); notice('Files are limited to 1 MiB.',true); return; }
    if (doc.localText == null) { doc.draftBase = doc.revision; doc.sessionId=state.sessionId; }
    doc.localText = value === doc.content && (!doc.sentEdit || doc.sentEdit.text===value) ? null : value;
    saveDraft(doc); updateControls(); paintCode(); clearTimeout(editTimer);
    if (!input.isComposing && app.dataset.composing !== 'true') editTimer = setTimeout(() => flush(doc).catch(report),140);
  }
  input.addEventListener('input',edited);
  input.addEventListener('pointerdown',drainEditorRender,{capture:true,passive:true});
  input.addEventListener('beforeinput',drainEditorRender,{capture:true});
  input.addEventListener('paste',drainEditorRender,{capture:true});
  input.addEventListener('drop',drainEditorRender,{capture:true});
  input.addEventListener('scroll',() => { drainEditorRender(); paintCode(); },{passive:true});
  input.addEventListener('compositionstart',() => { drainEditorRender(); app.dataset.composing = 'true'; updateControls(); });
  input.addEventListener('compositionend',() => { app.dataset.composing = 'false'; edited(); });
  input.addEventListener('focus',() => { drainEditorRender(); app.dataset.editing='yes'; if (aiOpen() && app.dataset.aiLayout==='split') { app.dataset.view='code'; syncViewControls(); } paintCode(); });
  input.addEventListener('blur',() => { rememberCodeView(); app.dataset.editing='no'; paintCode(); });
  async function flush(doc=current()) {
    if (doc===current()) drainEditorRender();
    clearTimeout(editTimer); if (!doc) return;
    const attached=() => doc.workspacePath===state.workspacePath && state.docs.get(doc.path)===doc;
    if (!attached()) throw new Error('These pending edits belong to a previous project and remain saved on this device.');
    // A prior sender can immediately flush newer typing after its reply. Join
    // that send too before using its revision, rather than issuing a duplicate.
    while (doc.inflight) await doc.inflight;
    if (!attached()) throw new Error('The project changed while these edits were being acknowledged.');
    if (doc.closed) throw new Error('Reopen '+doc.path+' from Files to review its pending edits.');
    if (doc.needsReview) { showConflict(doc,'draft'); throw new Error('Review your pending edits before continuing.'); }
    if (doc.localText == null) return;
    const text = doc.localText;
    doc.sentEdit={text,baseRevision:doc.draftBase ?? doc.revision};
    doc.inflight = command('edit_file',{path:doc.path,baseRevision:doc.sentEdit.baseRevision,content:text},true).catch(async error => {
      saveDraft(doc);
      if (error.code === 'stale_revision' && attached() && doc.localText!=null) {
        doc.needsReview = true;
        try { await command('open_file',{path:doc.path},true); } catch {}
        if (attached() && !doc.closed && doc.needsReview) showConflict(doc,'draft');
      }
      throw error;
    }).finally(() => { doc.inflight = null; doc.sentEdit=null; updateControls(); });
    await doc.inflight;
    if (doc.localText != null) await flush(doc);
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
  function insertText(text,start,end) {
    drainEditorRender();
    if (start===undefined) start=input.selectionStart;
    if (end===undefined) end=input.selectionEnd;
    input.setRangeText(text,start,end,'end'); edited();
  }
  function indentSelection(outdent=false) {
    drainEditorRender();
    if (input.readOnly || app.dataset.composing==='true') return;
    const start=input.selectionStart,end=input.selectionEnd;
    if (start===end && !outdent) { insertText('  '); return; }
    const lineStart=input.value.lastIndexOf('\n',start-1)+1, segment=input.value.slice(lineStart,end);
    const lines=segment.split('\n'); let firstDelta=0;
    const replacement=lines.map((line,index) => {
      if (index===lines.length-1 && !line && end>start && segment.endsWith('\n')) return line;
      const changed=outdent ? line.replace(/^( {1,2}|\t)/,'') : '  '+line;
      if (!index) firstDelta=changed.length-line.length;
      return changed;
    }).join('\n');
    input.setRangeText(replacement,lineStart,end,'preserve');
    input.setSelectionRange(Math.max(lineStart,start+firstDelta),Math.max(lineStart,end+replacement.length-segment.length)); edited();
  }
  async function historyEdit(redo=false) {
    drainEditorRender();
    const doc=current(); if (!doc || input.readOnly || editorHistoryBusy) return;
    editorHistoryBusy=true; updateControls();
    try {
      await flush(doc);
      if (current()!==doc || doc.closed || state.conflict || state.switching) return;
      await command(redo ? 'redo_file' : 'undo_file',{path:doc.path,revision:doc.revision},true);
    } finally { editorHistoryBusy=false; updateControls(); }
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
    drainEditorRender();
    if (input.readOnly || event.isComposing) return;
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
      event.preventDefault(); safe(() => historyEdit(event.shiftKey))();
    } else if (event.ctrlKey && event.key.toLowerCase() === 'y') {
      event.preventDefault(); safe(() => historyEdit(true))();
    } else if (event.key === 'Tab') {
      event.preventDefault(); indentSelection(event.shiftKey);
    } else if (event.key === 'Enter') {
      event.preventDefault(); const start=input.selectionStart, prefix=input.value.slice(input.value.lastIndexOf('\n',start-1)+1,start);
      const indent=(prefix.match(/^\s*/) || [''])[0]; insertText('\n'+indent+(/[\{\[:]\s*$/.test(prefix) ? '  ' : ''));
    }
  });
  input.addEventListener('keyup',event => {
    if (!mobile() || input.readOnly || event.isComposing || app.dataset.composing==='true' || document.activeElement!==input) return;
    if (event.key!=='End' && !(event.metaKey && event.key==='ArrowDown')) return;
    if (input.selectionEnd!==input.textLength || input.selectionDirection==='backward') return;
    // Native caret scrolling can leave the final CSS line box clipped in WebKit.
    // Only explicit end navigation corrects the missing pixels; selection stays native.
    const bottom=input.scrollHeight-parseFloat(getComputedStyle(input).paddingBottom)-input.clientHeight;
    if (input.scrollTop<bottom) input.scrollTop=bottom;
  });
  function openMenu(section='files') {
    closeProjectPicker();
    setMenuSection(section);
    if (mobile() && /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName)) document.activeElement.blur();
    $('files-menu').hidden=false; $('files-toggle').setAttribute('aria-expanded','true');
    $('file-tree').querySelector('button.active')?.scrollIntoView({block:'nearest',inline:'nearest'});
  }
  let projectPickerInvoker=$('projects-toggle');
  function closeMenu() { $('files-menu').hidden=true; $('files-menu').dataset.filtering='no'; $('files-toggle').setAttribute('aria-expanded','false'); }
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
      if (project.id===state.projectId) { button.setAttribute('aria-current','page'); const mark=document.createElement('span'); mark.className='project-current-mark'; mark.textContent='Current'; mark.setAttribute('aria-label','Current project'); button.append(mark); }
      button.setAttribute('aria-label',(project.id===state.projectId ? 'Current project ' : 'Switch files, AI and terminal to ')+project.name+' · '+project.path); button.disabled=!writable() || state.switching;
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
  function setMenuSection(section) {
    $('files-menu').dataset.section=section;
    $('menu-files-tab').setAttribute('aria-pressed',String(section==='files'));
    $('menu-session-tab').setAttribute('aria-pressed',String(section==='session'));
    $('files-menu').scrollTop=0;
  }
  $('menu-files-tab').onclick=() => setMenuSection('files');
  $('menu-session-tab').onclick=() => setMenuSection('session');
  $('menu-close').onclick=closeMenu;
  $('files-toggle').onclick = event => {
    if (!$('files-menu').hidden) return closeMenu();
    openMenu(); if (event.detail===0) $('file-filter').focus();
  };
  $('files-toggle').addEventListener('keydown',event => {
    if (event.key==='ArrowDown') { event.preventDefault(); openMenu(); $('file-filter').focus(); }
  });
  document.addEventListener('pointerdown',event => { if (!$('files-menu').hidden && !$('files-menu').contains(event.target) && !$('files-toggle').contains(event.target)) closeMenu(); });
  document.addEventListener('focusin',event => { if (!$('files-menu').hidden && !$('files-menu').contains(event.target) && !$('files-toggle').contains(event.target)) closeMenu(); });
  async function changeProject(type,fields) {
    if (state.switching) return;
    const projectId=state.projectId, generation=state.generation;
    state.switching=true; updateControls();
    try {
      await flushAll(); ensureProject(projectId,generation);
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
    app.dataset.aiOpen=showAi ? 'yes' : 'no'; app.dataset.view=mode; terminalOpen=showTerminal || mode==='terminal'; app.dataset.terminal=terminalOpen ? 'open' : 'closed'; $('terminal-panel').hidden=!terminalOpen;
    syncViewControls(); if (mode==='code') restoreCodeView(); if (aiVisible()) renderAi(true); paintCode(); paintTerminal(); scheduleResize(); updateControls();
  }
  async function openFile(path) {
    const projectId=state.projectId, generation=state.generation;
    closeMenu();
    if (mobile() || (aiOpen() && app.dataset.aiLayout==='tab')) setMobileView('code'); if (!mobile()) input.focus();
    if (writable() && !current()?.closed) await flush(); ensureProject(projectId,generation);
    await command('open_file',{path},true); ensureProject(projectId,generation); selectLocal(path);
    if (writable()) await command('select_file',{path},true);
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
  function fileIcon(folder) {
    const icon=document.createElementNS('http://www.w3.org/2000/svg','svg'), use=document.createElementNS('http://www.w3.org/2000/svg','use');
    icon.setAttribute('aria-hidden','true'); use.setAttribute('href',folder ? '#i-folder' : '#i-file'); icon.append(use); return icon;
  }
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
      const tree=treeFor(project.id), root=document.createElement('section'); root.className='project-root'; root.dataset.projectId=project.id;
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
      heading.append(expand,remove); root.append(heading);
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
          const retry=document.createElement('button'); retry.className='tree-note'; retry.style.setProperty('--tree-depth',Math.min(depth,5)*14+'px');
          retry.textContent=tree.loading.has(directory) ? 'Loading…' : tree.errors.has(directory) ? 'Retry loading this folder' : 'Load folder'; retry.disabled=tree.loading.has(directory); retry.title=tree.errors.get(directory) || '';
          retry.onclick=safe(() => loadProjectFolder(project.id,directory)); root.append(retry); return;
        }
        const files=cached.files.filter(file => !filter || file.name.toLocaleLowerCase().includes(filter) || (file.directory && tree.expanded.has(file.path)));
        const offset=Math.min(cached.offset || 0,Math.max(0,files.length-1)), size=Math.min(cached.limit,pageSize);
        if (offset) { const previous=document.createElement('button'); previous.className='tree-note'; previous.style.setProperty('--tree-depth',Math.min(depth,5)*14+'px'); previous.textContent='Previous files'; previous.onclick=() => { cached.offset=Math.max(0,offset-size); renderFiles(); }; root.append(previous); }
        for (const file of files.slice(offset,offset+size)) {
          const button=document.createElement('button'); button.className='tree-entry'+(project.id===state.projectId && file.path===state.path ? ' active' : ''); button.dataset.path=file.path; button.dataset.projectId=project.id;
          button.dataset.kind=file.directory ? 'directory' : 'file';
          button.style.setProperty('--tree-depth',Math.min(depth,5)*14+'px'); button.title=project.path+'/'+file.path;
          const kind=document.createElement('span'); kind.className='file-kind'; kind.append(fileIcon(file.directory));
          const label=document.createElement('span'); label.className='entry-name'; label.textContent=file.name;
          if (file.directory) { const chevron=document.createElement('span'); chevron.className='tree-arrow'; chevron.textContent=tree.expanded.has(file.path) ? '⌄' : '›'; chevron.setAttribute('aria-hidden','true'); button.append(chevron); button.setAttribute('aria-expanded',String(tree.expanded.has(file.path))); }
          button.append(kind,label); button.setAttribute('aria-label',(file.directory ? 'Open folder ' : 'Open file ')+file.name);
          button.onclick=safe(() => file.directory ? toggleProjectFolder(project.id,file.path) : openProjectFile(project.id,file.path)); root.append(button);
          if (file.directory) branch(file.path,depth+1);
        }
        if (files.length>offset+size) { const more=document.createElement('button'); more.className='tree-note'; more.style.setProperty('--tree-depth',Math.min(depth,5)*14+'px'); more.textContent='Next '+Math.min(size,files.length-offset-size)+' files · '+(files.length-offset-size)+' remaining'; more.onclick=() => { cached.offset=offset+size; renderFiles(); }; root.append(more); }
        if (!files.length) { const empty=document.createElement('p'); empty.className='control-note tree-note'; empty.style.setProperty('--tree-depth',Math.min(depth,5)*14+'px'); empty.textContent=filter ? 'No files match this filter.' : 'This folder is empty.'; root.append(empty); }
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
  function renderOpenFiles() {
    $('files-menu').dataset.hasOpenFiles=state.docs.size>=2 || [...state.docs.values()].some(doc => doc.closed) ? 'yes' : 'no';
    const fragment=document.createDocumentFragment();
    for (const doc of state.docs.values()) {
      const row=document.createElement('div'); row.className='open-file'+(doc.path===state.path ? ' active' : '');
      const button=document.createElement('button'); button.title=doc.path; button.onclick=safe(() => openFile(doc.path));
      if (doc.path===state.path) button.setAttribute('aria-current','page');
      const name=document.createElement('span'); name.className='open-file-name'; name.textContent=doc.path.split('/').pop()+(doc.closed ? ' · local draft' : doc.dirty || doc.localText!=null ? ' ●' : '');
      const path=document.createElement('small'); path.className='open-file-path'; path.textContent=doc.path.includes('/') ? doc.path.slice(0,doc.path.lastIndexOf('/')) : state.workspace || 'Project'; button.append(name,path);
      const close=document.createElement('button'); close.className='icon'; close.textContent='×'; close.setAttribute('aria-label','Close '+doc.path); close.disabled=!writable();
      close.onclick=safe(async () => {
        const projectId=state.projectId, generation=state.generation;
        if (doc.closed) {
          if (!confirm('Discard the pending edits kept on this device for '+doc.path+'?')) return;
          doc.localText=null; saveDraft(doc); fileClosed(doc.path); return;
        }
        await flush(doc); ensureProject(projectId,generation);
        const revision=doc.revision, discard=doc.dirty;
        if (discard && !confirm('Discard unsaved changes to '+doc.path+'?')) return;
        await command('close_file',{path:doc.path,revision,discard},true);
      });
      row.append(button,close); fragment.append(row);
    }
    if (!fragment.childNodes.length) { const empty=document.createElement('p'); empty.className='control-note'; empty.textContent='Choose a file from Files to open it.'; fragment.append(empty); }
    $('open-files').replaceChildren(fragment);
  }
  $('new-file').onclick=() => { closeMenu(); closeProjectPicker(); $('new-error').hidden=true; $('new-path').value=state.directory ? state.directory+'/' : ''; $('new-project-label').textContent='Path in '+projectContext(); showDialog('new-dialog'); $('new-path').focus(); };
  $('new-form').onsubmit=async event => {
    event.preventDefault(); $('new-error').hidden=true;
    const projectId=state.projectId, generation=state.generation;
    try { await flush(); ensureProject(projectId,generation); const path=$('new-path').value.trim(); await command('create_file',{path},true); ensureProject(projectId,generation); selectLocal(path); if (mobile() || (aiOpen() && app.dataset.aiLayout==='tab')) setMobileView('code'); $('new-dialog').close(); await command('list_files',{directory:state.directory}); if (!mobile()) input.focus(); }
    catch(error) { dialogError('new-error',error); }
  };
  function openProjectDialog() {
    closeMenu(); closeProjectPicker(); $('project-error').hidden=true; $('project-path').value='';
    $('project-current').textContent=state.projects.length+' project'+(state.projects.length===1 ? '' : 's')+' in this session'; updateControls(); showDialog('project-dialog');
    if (writable()) { $('project-path').focus(); $('project-path').select(); }
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
  }
  function showSettingsFields() {
    if (!state.settingsDraft) return;
    const selected=state.settingsDraft[state.settingsProvider];
    $('settings-model').value=selected.model || '';
    $('settings-effort').value=state.settingsDraft.codex.reasoningEffort || '';
    $('settings-effort-row').hidden=state.settingsProvider!=='codex'; renderSettingsAccount();
  }
  function renderSettingsAccount() {
    if (!$('settings-dialog').open) return;
    const id=state.settingsProvider, provider=state.providers.find(item => item.id===id);
    $('settings-auth').textContent=provider ? provider.detail || (provider.available ? 'CLI installed on the host PC.' : 'Install the '+provider.name+' CLI on the host PC.') : 'Checking the host’s CLI sign-in…';
    $('settings-login').textContent=provider?.loginCommand || (id==='claude' ? 'claude auth login' : 'codex login');
    $('settings-help').href=provider?.helpUrl || (id==='claude' ? 'https://code.claude.com/docs/en/authentication' : 'https://learn.chatgpt.com/docs/auth');
  }
  async function openSettings() {
    closeMenu(); state.settingsDraft=null; state.settingsLoading=true; $('settings-error').hidden=true; showDialog('settings-dialog'); updateControls();
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
    } catch(error) { dialogError('settings-error',error); }
  };
  function renderDevices() {
    const fragment=document.createDocumentFragment();
    for (const client of state.clients) {
      const row=document.createElement('div'); row.className='device';
      const label=document.createElement('span'); label.textContent=(client.name || 'Device')+(client.id===state.clientId ? ' · You' : '');
      const detail=document.createElement('small'); detail.textContent=client.connected ? 'Connected' : 'Disconnected'; label.append(detail); row.append(label);
      if (!client.isHost) {
        const revoke=document.createElement('button'); revoke.textContent=client.id===state.clientId ? 'Sign out' : 'Revoke';
        revoke.disabled=!writable(); revoke.title='Remove this device’s access to this PC';
        revoke.onclick=safe(async () => { await command('revoke_device',{targetClientId:client.id},true); pairing=null; paintPairing(); });
        row.append(revoke);
      }
      fragment.append(row);
    }
    $('device-list').replaceChildren(fragment);
    $('revoke-devices').hidden=!state.pairedSessions;
    $('revoke-devices').disabled=!writable();
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
    $('pair-description').textContent=remote ? (ready ? 'Copy this invitation link to your phone, then enter the code.' : starting ? 'Creating your secure internet link…' : 'Connect from anywhere, including mobile data.') : 'Copy this invitation link to a device on the same Wi-Fi, then enter the code.';
    const inviteUrl=invitationUrl();
    $('pair-urls').replaceChildren(...(inviteUrl ? [inviteUrl] : []).map(url => { const link=document.createElement('a'); link.className='pair-url'; link.href=url; link.textContent=pairing.origin; link.target='_blank'; link.rel='noopener noreferrer'; return link; }));
    $('pair-code').textContent=pairing && !expired && ready ? pairing.code : '';
    $('pair-code').hidden=!$('pair-code').textContent;
    $('pair-expiry').hidden=!pairing || !ready;
    $('pair-expiry').textContent=expired ? 'Invitation expired. Create a new link and code.' : 'Link and code expire in two minutes and work once.';
    $('pair-access-note').textContent=remote ? (ready ? (internet.managed===false ? 'Works away from home. Keep this PC awake and Relay running.' : 'New links may take a minute to open. Keep this PC awake and Relay running. Restarting internet access changes this address.') : 'Uses Cloudflare to connect securely to this PC. Start it only when you need internet access.') : (ready ? 'This address only works on the same network. Use an internet link when away from home.' : 'No Wi-Fi address is available. Use internet access or start Relay with LAN access.');
    $('internet-start').hidden=!remote || ready;
    $('internet-start').disabled=!writable() || starting || pairStopping;
    $('internet-start').textContent=starting ? 'Connecting…' : internet?.status==='error' ? 'Retry internet link' : 'Create internet link';
    $('pair-refresh').hidden=!ready; $('pair-refresh').disabled=!writable() || !!pairRequest;
    $('pair-copy').hidden=!inviteUrl;
    $('pair-local').textContent=remote ? 'Use same Wi-Fi' : 'Use internet';
    $('internet-stop').hidden=internet?.managed===false || !['starting','ready'].includes(internet?.status);
    $('internet-stop').disabled=!writable() || pairStopping;
    if (remote && internet?.status==='error') dialogError('pair-error',internet.error || 'Internet access could not start. Retry or use same Wi-Fi.');
  }
  function renderPairing(event) {
    pairing={code:event.code,invite:event.invite,origin:event.origin,expiresAt:event.expiresAt || Date.now()+120000};
    clearTimeout(pairTimer); pairTimer=setTimeout(paintPairing,Math.max(0,pairing.expiresAt-Date.now())); paintPairing();
  }
  function maybePair() {
    if (!$('pair-dialog').open || !writable() || !pairUrls().length || pairing || pairRequest) return;
    pairRequest=command('pair_create',{origin:pairUrls()[0]},true).catch(error => dialogError('pair-error',error)).finally(() => { pairRequest=null; paintPairing(); });
  }
  $('pair-phone').onclick=() => {
    closeMenu(); pairMode='internet'; pairing=null; $('pair-error').hidden=true;
    showDialog('pair-dialog'); paintPairing(); maybePair();
    clearTimeout(pairTimer);
  };
  $('pair-dialog').addEventListener('close',() => { clearTimeout(pairTimer); pairTimer=null; });
  $('pair-local').onclick=() => { pairMode=pairMode==='internet' ? 'local' : 'internet'; pairing=null; $('pair-error').hidden=true; paintPairing(); maybePair(); };
  $('pair-refresh').onclick=() => { pairing=null; $('pair-error').hidden=true; maybePair(); paintPairing(); };
  $('pair-copy').onclick=safe(async () => { const url=invitationUrl(); if (url) { await navigator.clipboard.writeText(url); notice('Invitation link copied. Share it only with your own device.'); } });
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
      else if (!state.conflict || state.conflict.doc===doc) { state.conflict=null; $('conflict-dialog').close(); }
      renderEditor();
    } catch(error) { dialogError('conflict-error',error); }
  }
  $('conflict-remote-button').onclick=() => resolveConflict(false); $('conflict-local-button').onclick=() => resolveConflict(true);
  let terminalOpen=false, terminalWidth=8, terminalLine=20, terminalComposing=false, terminalComposition=null, historyTimer, historyBusy=false, terminalFrame, terminalClaim;
  function claimTerminal() {
    if (!writable() || ownsTerminal()) return Promise.resolve();
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
    if ((!state.terminal || !state.terminal.running) && writable()) await command('terminal_start',{},true);
    ensureProject(projectId,generation); await command('terminal_history',{limit:200}); ensureProject(projectId,generation); paintTerminal(); scheduleResize();
    if (terminalOpen && !mobile()) $('terminal-command').focus();
  }
  $('terminal-toggle').onclick=safe(() => toggleTerminal()); $('close-terminal').onclick=safe(() => toggleTerminal(false));
  $('terminal-shortcut-toggle').onclick=safe(() => toggleTerminal());
  $('terminal-restart').onclick=safe(async () => { const projectId=state.projectId, generation=state.generation; await claimTerminal(); ensureProject(projectId,generation); await command('terminal_start',{},true); scheduleResize(); });
  $('terminal-end').onclick=safe(async () => { if (confirm('End this shell and its foreground command?')) await command('terminal_stop',{},true); });
  function paintTerminal() {
    if (!terminalVisible() || !state.terminal || document.hidden) return;
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
    if (historyTimer || historyBusy || !terminalOpen || !state.connected || !state.terminal || state.terminal.alternate_screen) return;
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
  $('terminal-screen').addEventListener('focus',() => { if (writable() && !mobile()) $('terminal-command').focus(); });
  function terminalKey(event) {
    if (!writable() || !state.terminal || !state.terminal.running || event.isComposing || terminalComposing || event.metaKey) return;
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
    if (!writable()) return; event.preventDefault(); const text=event.clipboardData.getData('text/plain');
    if (new TextEncoder().encode(text).length>15000) return notice('Terminal pastes are limited to 15 KB.',true);
    sendTerminal(state.terminal.bracketed_paste ? '\x1b[200~'+text+'\x1b[201~' : text).catch(report);
  }
  $('terminal-screen').addEventListener('paste',terminalPaste); $('terminal-command').addEventListener('paste',terminalPaste);
  $('terminal-screen-wrap').addEventListener('scroll',() => { const top=$('terminal-screen-wrap').scrollTop; if (state.autoScrollTop!=null && Math.abs(top-state.autoScrollTop)>2) state.terminalFollow=false; state.autoScrollTop=top; cancelAnimationFrame(terminalFrame); terminalFrame=requestAnimationFrame(paintTerminal); },{passive:true});
  $('terminal-screen-wrap').addEventListener('touchstart',() => { state.terminalFollow=false; },{passive:true});
  $('terminal-screen-wrap').addEventListener('pointerdown',() => { state.terminalFollow=false; },{passive:true});
  $('terminal-screen-wrap').addEventListener('wheel',event => { state.terminalFollow=event.deltaY>=0 && $('terminal-screen-wrap').scrollHeight-$('terminal-screen-wrap').scrollTop-$('terminal-screen-wrap').clientHeight<40; if (event.deltaY<0 && terminalOpen && !state.history.length && state.connected) command('terminal_history',{limit:200}).catch(() => {}); },{passive:true});
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
    if (!showCode) editorPending=false;
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
    $('ai-toggle').setAttribute('aria-expanded',String(open));
    $('ai-toggle-label').textContent=open ? 'Close AI' : 'Ask AI';
    syncTerminalControls();
  }
  function setMobileView(view) {
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
    rememberCodeView(); if (aiVisible()) state.messageScrollTop=$('messages').scrollTop;
    if (/^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName)) document.activeElement.blur();
    app.dataset.aiLayout=layout; app.dataset.aiOpen='yes';
    if (app.dataset.view==='terminal') app.dataset.view='ai';
    try { sessionStorage.setItem('relay-ai-layout:'+layoutDevice,layout); } catch {}
    syncViewControls(); restoreCodeView(); if (aiVisible()) renderAi(true);
    paintTerminal(); scheduleResize();
  }
  $('ai-layout-split').onclick=() => setAiLayout('split'); $('ai-layout-tab').onclick=() => setAiLayout('tab');
  function toggleAi(force) {
    const open=typeof force==='boolean' ? force : !aiOpen();
    if (open) setMobileView('ai');
    else {
      rememberCodeView(); if (aiVisible()) state.messageScrollTop=$('messages').scrollTop;
      app.dataset.aiOpen='no'; setMobileView('code'); syncViewControls();
    }
    paintCode(); paintTerminal(); scheduleResize(); if (!mobile()) focusWorkspace();
  }
  $('ai-toggle').onclick=() => toggleAi(); $('close-ai').onclick=() => toggleAi(false);
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
    const note=authNote;
    $('ai-note').textContent=note; $('ai-note').hidden=!note;
    const earlierFile=hasConversation && conversation && conversation!==path;
    $('ai-conversation-context').textContent=earlierFile ? 'Conversation · '+conversation : '';
    $('ai-conversation-context').title=earlierFile ? 'Earlier conversation about '+conversation+' in '+projectContext() : '';
    $('ai-conversation-context').hidden=!earlierFile;
    $('compose-context').textContent=path ? unsaved ? 'Save your file before asking' : 'Current file on disk' : 'Project context';
    $('compose-context').title=path ? projectContext()+' / '+path : state.workspacePath;
    $('prompt').placeholder=path ? 'Ask about '+path.split('/').pop()+'…' : 'Ask about this project…';
  }
  $('provider').onchange=() => { state.providerChosen=true; renderProviders(); };
  function queueAi() { cancelAnimationFrame(aiFrame); aiFrame=requestAnimationFrame(() => { renderProviders(); renderSettingsAccount(); if (aiVisible()) renderAi(); }); }
  function fenced(text) { const blocks=[...text.matchAll(/```[^\n]*\n([\s\S]*?)```/g)]; return blocks.length ? blocks[blocks.length-1][1] : null; }
  function renderAi(preserveScroll=false) {
    const ai=state.ai; if (!ai) return;
    $('ai-status').textContent=ai.status==='idle' ? '' : ai.status.replaceAll('_',' ');
    const messages=$('messages'), previousTop=state.messageScrollTop ?? messages.scrollTop;
    const bottom=!preserveScroll && messages.scrollHeight-messages.scrollTop-messages.clientHeight<60;
    const fragment=document.createDocumentFragment();
    const lastUser=(ai.messages || []).findLastIndex(message => message.role==='user');
    (ai.messages || []).forEach((message,index) => {
      const item=document.createElement('div'); item.className='message';
      const byline=document.createElement('div'); byline.className='byline'; byline.textContent=message.role==='user' ? 'You'+(index===lastUser && state.aiContext?.path ? ' · '+state.aiContext.path : '') : message.role==='assistant' ? (ai.provider==='claude' ? 'Claude' : 'Codex') : message.role;
      const body=document.createElement('pre'); body.className='ai-message-text'; body.textContent=message.text; item.append(byline,body);
      const replacement=message.role==='assistant' && fenced(message.text);
      if (replacement!=null && state.aiContext && index>lastUser && !['running','starting','awaiting_approval','cancelling'].includes(ai.status)) {
        const action=document.createElement('button'); action.className='review-action'; action.textContent='Review replacement';
        action.onclick=() => { const doc=state.docs.get(state.aiContext.path);
          if (!doc || doc.revision!==state.aiContext.revision || doc.localText!=null) return notice('The selected file changed since this AI request. Ask for a fresh replacement.',true);
          state.proposal={...state.aiContext,original:doc.content,text:replacement}; $('review-description').textContent=state.proposal.path+' · Applying changes the shared buffer. Save writes it to disk.'; $('review-original').textContent=state.proposal.original; $('review-proposed').textContent=replacement; $('review-error').hidden=true; $('apply-change').disabled=!writable(); showDialog('review-dialog'); };
        item.append(action);
      }
      fragment.append(item);
    });
    for (const approval of ai.approvals || []) {
      const card=document.createElement('div'); card.className='approval'; const title=document.createElement('p'); title.textContent=approval.title;
      const detail=document.createElement('pre'); detail.className='approval-detail'; detail.textContent=approval.detail;
      const actions=document.createElement('div'); actions.className='approval-actions';
      for (const choice of approval.choices) { const button=document.createElement('button'); button.textContent=choice.replaceAll('_',' '); button.disabled=!writable(); button.onclick=safe(() => command('ai_approve',{id:approval.id,choice},true)); actions.append(button); }
      card.append(title,detail,actions); fragment.append(card);
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
        const button=document.createElement('button'); button.type='button'; button.textContent=label;
        button.onclick=() => { $('prompt').value=prompt; $('prompt').dispatchEvent(new Event('input')); $('prompt').focus({preventScroll:true}); };
        suggestions.append(button);
      }
      entry.append(title,hint,suggestions); fragment.append(entry);
    }
    messages.replaceChildren(fragment); messages.scrollTop=bottom ? messages.scrollHeight : previousTop;
    state.messageScrollTop=messages.scrollTop;
  }
  $('messages').addEventListener('scroll',() => { if (aiVisible()) state.messageScrollTop=$('messages').scrollTop; },{passive:true});
  $('prompt-form').onsubmit=event => {
    event.preventDefault(); const prompt=$('prompt').value.trim(); if (!prompt) return;
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
  $('apply-change').onclick=async () => {
    $('review-error').hidden=true;
    const projectId=state.projectId, generation=state.generation;
    try {
      const proposal=state.proposal, doc=state.docs.get(proposal.path); await flush(doc); ensureProject(projectId,generation);
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
      else if (!$('files-menu').hidden) { event.preventDefault(); closeMenu(); $('files-toggle').focus(); }
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
    if (!$('files-menu').hidden && $('files-menu').dataset.section==='files') {
      const breadcrumbs=$('directory-breadcrumbs'); breadcrumbs.scrollLeft=breadcrumbs.scrollWidth;
    }
    if (!$('project-menu').hidden) positionPopover($('project-menu'),projectPickerInvoker,true);
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
  document.addEventListener('visibilitychange',() => { if (document.hidden) { editorPending=false; clearCodeIndex(); cancelAnimationFrame(paintFrame); } else { drainEditorRender(); paintCode(); paintTerminal(); queueAi(); } });
  window.addEventListener('beforeunload',event => { if ([...state.docs.values()].some(doc => doc.localText!=null)) { event.preventDefault(); event.returnValue=''; } });
  let pcOpenTimer, pcOpenEpoch=0, authEpoch=0;
  function stopPcRecovery() { clearTimeout(pcOpenTimer); pcOpenTimer=null; pcOpenEpoch++; $('pc-open-editor').disabled=false; }
  async function getBootstrap(token) {
    const attempt=++authEpoch;
    const query=new URLSearchParams({clientId:state.clientId});
    if (state.projectId) query.set('projectId',state.projectId);
    const response=await fetch('/api/bootstrap?'+query,{headers:token ? {Authorization:'Bearer '+token} : {},credentials:'same-origin',cache:'no-store'});
    if (attempt!==authEpoch) return false;
    if (response.status===401) {
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
      $('join-retry-actions').hidden=!!joinInvite;
      $('join-code').disabled=!joinInvite; $('join-submit').disabled=!joinInvite;
      $('connection-state').textContent='Sign in';
      if (pc) {
        $('join-dialog').close(); closeMenu(); closeProjectPicker();
        if (firstPc) $('pc-open-editor').focus({preventScroll:true});
      } else {
        stopPcRecovery();
        $('join-title').textContent=joinInvite ? 'Join your PC session' : 'Open an invitation from your PC';
        $('join-hint').textContent=joinInvite ? 'Enter the six-digit code shown on your PC. This device will share its editor and terminal.' : 'On your PC, choose Pair a device → Copy link, then open that complete invitation here. The address alone cannot pair.';
        showDialog('join-dialog');
      }
      return false;
    }
    if (!response.ok) throw new Error('Unable to connect to the host ('+response.status+').');
    const value=await response.json(); if (attempt!==authEpoch) return false;
    const pcWasVisible=!$('pc-welcome').hidden;
    app.hidden=pcWasVisible; stopPcRecovery();
    bootstrap(value);
    joinInvite=null; $('launch-link').value=''; $('join-code').value=''; $('join-error').hidden=true; $('pc-open-error').hidden=true;
    $('pc-open-status').textContent=pcWasVisible ? 'Connecting to your workspace…' : ''; $('pc-launch-details').open=false; $('join-dialog').close();
    // Replacement context is supplied by the host and shared across devices.
    return true;
  }
  function connect() {
    clearTimeout(reconnectTimer);
    const query=new URLSearchParams({clientId:state.clientId,name:mobile() ? 'Phone' : 'Desktop'});
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
      const response=await fetch('/api/pair',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:$('join-code').value.trim(),invite:joinInvite}),credentials:'same-origin'});
      const result=await response.json(); if (!response.ok) throw new Error(result.message || result.error || 'Pairing failed.');
      joinInvite=null; $('join-code').value=''; if (await getBootstrap()) connect();
    } catch(error) { dialogError('join-error',error); } finally { $('join-submit').disabled=!joinInvite; }
  };
  let joinInvite=null;
  const loopbackHost=host => ['localhost','127.0.0.1','[::1]'].includes(host);
  // This only chooses instructions. The host still verifies every credential.
  const isLocalPc=() => location.protocol==='http:' && loopbackHost(location.hostname);
  $('launch-form').onsubmit=async event => {
    event.preventDefault(); stopPcRecovery(); $('pc-open-error').hidden=true; $('launch-submit').disabled=true;
    const pasted=$('launch-link').value.trim(); $('launch-link').value='';
    try {
      let link; try { link=new URL(pasted); } catch { throw new Error('Paste the complete private launch link from the host terminal.'); }
      const fragment=new URLSearchParams(link.hash.slice(1)), token=fragment.get('token');
      if (!isLocalPc() || link.protocol!=='http:' || !loopbackHost(link.hostname) || link.port!==location.port || link.pathname!=='/' || link.username || link.password || link.search || [...fragment.keys()].length!==1 || !/^[a-f0-9]{64}$/.test(token || '')) throw new Error('Use the private PC launch link for this Relay address. Phone invitations open on the phone.');
      if (!(await getBootstrap(token))) throw new Error('That launch link is no longer valid. Use the link printed by the currently running host.');
      connect();
    } catch(error) { dialogError(isLocalPc() && !joinInvite ? 'pc-open-error' : 'join-error',error); } finally { $('launch-submit').disabled=false; }
  };
  $('pc-open-editor').onclick=async () => {
    stopPcRecovery(); const epoch=pcOpenEpoch;
    $('pc-open-editor').disabled=true; $('pc-open-error').hidden=true; $('pc-open-status').textContent='Opening your default browser…';
    try {
      const response=await fetch('/api/pc/open',{method:'POST',headers:{'X-Relay-Launch':'1'},credentials:'same-origin',cache:'no-store'});
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
    joinInvite=/^[a-f0-9]{64}$/.test(invite || '') ? invite : null;
    stopPcRecovery(); $('join-error').hidden=true; $('pc-open-error').hidden=true; $('launch-link').value=''; $('join-code').value='';
    if (location.hash) history.replaceState(null,'',location.pathname+location.search);
    if (await getBootstrap(token)) { if (!state.connected || token) connect(); }
  }
  // Pasting an invitation while the join screen is already open can be a
  // same-document navigation; handle it without losing local drafts.
  window.addEventListener('hashchange',() => openLaunchLink().catch(report));
  openLaunchLink().catch(report);
})();
