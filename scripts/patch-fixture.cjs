'use strict';
// Functional-test observers only. The app receives the original wire event;
// historical fixture assertions receive an independently reconstructed snapshot.
// Do not install this full-text observer in memory or latency benchmarks.
function browserObserver() {
  const documents=new Map(); let project=null;
  const boundary=(text,at) => Number.isSafeInteger(at) && at>=0 && at<=text.length && !(at>0 && at<text.length && /[\uD800-\uDBFF]/.test(text[at-1]) && /[\uDC00-\uDFFF]/.test(text[at]));
  const scalarText=text => {
    for (let at=0;at<text.length;at++) {
      const code=text.charCodeAt(at);
      if (code>=0xd800 && code<=0xdbff) { if (++at>=text.length || text.charCodeAt(at)<0xdc00 || text.charCodeAt(at)>0xdfff) return false; }
      else if (code>=0xdc00 && code<=0xdfff) return false;
    }
    return true;
  };
  const observer={patches:0,observe(message) {
    if (message.type==='bootstrap') {
      project=message.projectId; documents.clear();
      for (const file of message.openFiles||[]) documents.set(file.path,{...file});
      return message;
    }
    if (message.projectId && project && message.projectId!==project) return message;
    if (message.type==='file_closed') { documents.delete(message.path); return message; }
    if (message.type==='file_state' && message.file) {
      const old=documents.get(message.file.path);
      if (!old || message.file.revision>=old.revision) documents.set(message.file.path,{...message.file});
      return message;
    }
    if (message.type!=='file_patch') return message;
    observer.patches++;
    const file=message.file, old=file && documents.get(file.path), patch=message.patch;
    if (!old) throw Error('Fixture patch has no base snapshot: '+file?.path);
    if (file.revision>old.revision) {
      if (old.revision!==message.baseRevision || !patch || !Number.isSafeInteger(patch.deleteCount) || patch.deleteCount<0 || typeof patch.insert!=='string' || !boundary(old.content,patch.start) || !boundary(old.content,patch.start+patch.deleteCount) || !scalarText(patch.insert)) throw Error('Fixture patch failed independent revision/UTF-16 validation: '+file.path);
      documents.set(file.path,{...file,content:old.content.slice(0,patch.start)+patch.insert+old.content.slice(patch.start+patch.deleteCount)});
    }
    return {...message,type:'file_state',fixtureWireType:'file_patch',file:{...documents.get(file.path)}};
  }};
  window.__patchFixture=observer;
}
exports.install=context => context.addInitScript(browserObserver);
