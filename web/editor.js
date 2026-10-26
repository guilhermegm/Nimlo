'use strict';
// Ordinary documents keep the browser's native text control. Documents with
// many line breaks or a large character count use a bounded editing window.
// The document String is shared with the app; no full hidden control or line
// String array is kept alongside it.
(() => {
  const ENABLED=true; // Adaptive large-file editing; ordinary files keep the native control.
  const LINE_LIMIT=10000, CHARACTER_LIMIT=65536, WINDOW_LINES=160, WINDOW_CHARS=65536, INPUT_CHARS=8192, STRIDE=64;
  class NimloEditor {
    constructor(input,options={}) {
      this.input=input; this.text=''; this.large=false; this.index=null;
      this.enabled=options.enabled===true || ENABLED || new URLSearchParams(location.search).get('bounded')==='1';
      this.lineCount=1; this.maxColumns=0; this.start=0; this.end=0;
      this.firstLine=0; this.firstColumn=0; this.buffer='';
      this.selection={start:0,end:0,direction:'none'};
      this.syncing=false; this.composing=false; this.pointer=null;
      this.scroller=document.createElement('div'); this.scroller.className='editor-scroll'; this.scroller.hidden=true;
      this.spacer=document.createElement('div'); this.spacer.className='editor-spacer'; this.spacer.setAttribute('aria-hidden','true');
      input.parentNode.insertBefore(this.scroller,input); this.scroller.append(this.spacer);
      this.help=document.createElement('span'); this.help.id='editor-window-help'; this.help.className='visually-hidden';
      this.help.textContent='Large file editor. The editing area shows a moving range of lines. Arrow keys move through the whole file. Control or Command with Home and End moves to its beginning and end. Control or Command A selects the whole file. Native touch selection selects the displayed range. Read file provides all lines, line navigation and a whole-file Select all action. Copy, cut and paste use your selected document range.';
      input.parentNode.append(this.help);
      this.readButton=document.createElement('button'); this.readButton.type='button'; this.readButton.className='editor-read'; this.readButton.textContent='Read file'; this.readButton.hidden=true;
      input.closest('.codebox').append(this.readButton);
      this.reader=document.createElement('dialog'); this.reader.className='editor-reader'; this.reader.setAttribute('aria-label','Read document');
      this.reader.innerHTML='<div class="reader-heading"><h2>Read file</h2><button type="button" data-reader="close" aria-label="Close reading view">×</button></div><p data-reader="range" role="status"></p><pre tabindex="0" data-reader="text" role="document" aria-label="Document text"></pre><div class="reader-controls"><button type="button" data-reader="previous">Previous lines</button><button type="button" data-reader="next">Next lines</button><label>Line <input type="number" min="1" step="1" data-reader="line"></label><button type="button" data-reader="go">Go</button><button type="button" data-reader="edit">Edit here</button><button type="button" data-reader="all">Select all</button></div>';
      document.body.append(this.reader);
      const control=name => this.reader.querySelector('[data-reader="'+name+'"]');
      this.readButton.onclick=() => { this.readerOffset=this.offsetAtLine(this.lineAtOffset(this.selectionStart)); this.readPage(); this.reader.showModal(); control('text').focus(); };
      control('close').onclick=() => this.reader.close();
      control('next').onclick=() => { this.readerOffset=this.readerEnd; this.readPage(); control('text').focus(); };
      control('previous').onclick=() => { const line=this.lineAtOffset(this.readerOffset),start=this.offsetAtLine(line); this.readerOffset=this.readerOffset>start ? Math.max(start,this.readerOffset-WINDOW_CHARS) : this.offsetAtLine(Math.max(0,line-120)); this.readPage(); control('text').focus(); };
      control('go').onclick=() => { this.readerOffset=this.offsetAtLine(Math.max(0,Number(control('line').value)-1)); this.readPage(); control('text').focus(); };
      control('edit').onclick=() => { this.setSelectionRange(this.readerOffset,this.readerOffset); this.reveal(); this.changedViewport(); this.reader.close(); };
      control('all').onclick=() => { this.setSelectionRange(0,this.text.length,'forward'); this.reader.close(); };
      this.reader.addEventListener('close',() => { control('text').textContent=''; this.input.focus({preventScroll:true}); });
      input.nimloEditor=this;
      this.scroller.addEventListener('scroll',() => { this.window(false); this.changedViewport(); },{passive:true});
      input.addEventListener('input',() => this.readInput(),true);
      input.addEventListener('select',() => this.readSelection());
      document.addEventListener('selectionchange',() => { if (document.activeElement===input) this.readSelection(); });
      input.addEventListener('compositionstart',() => {
        this.readSelection(); this.compositionOriginal=null; this.compositionChanged=false;
        this.stopPointer();
        if (this.large && (this.selection.start<this.start || this.selection.end>this.end)) {
          // compositionstart runs after the OS has established its marked-text
          // session. Leave that native buffer alone and translate its changes
          // onto the complete document range until the session ends.
          this.compositionOriginal={text:this.text,selection:{...this.selection},buffer:this.buffer,local:{start:input.selectionStart,end:input.selectionEnd},start:this.start};
        }
        this.composing=true;
      });
      input.addEventListener('compositionend',() => {
        this.readInput(); this.composing=false;
        this.compositionOriginal=null; this.settle();
      });
      input.addEventListener('beforeinput',event => this.beforeInput(event));
      input.addEventListener('keydown',event => this.key(event));
      input.addEventListener('keyup',() => { if (this.nativeKeyboardSelection) { this.readSelection(); this.nativeKeyboardSelection=false; } });
      input.addEventListener('copy',event => this.clipboard(event,false));
      input.addEventListener('cut',event => this.clipboard(event,true));
      input.addEventListener('paste',event => {
        if (input.readOnly || this.composing || !event.clipboardData) return;
        const value=event.clipboardData.getData('text/plain');
        if (!this.large) { if (this.nativeReplacement(value,input.selectionStart,input.selectionEnd,'end',true)) event.preventDefault(); return; }
        event.preventDefault(); this.replace(value,this.selection.start,this.selection.end,'end',true);
      });
      input.addEventListener('drop',event => {
        if (!this.large || input.readOnly || this.composing || !event.dataTransfer) return;
        event.preventDefault(); const at=this.position(event.clientX,event.clientY);
        this.replace(event.dataTransfer.getData('text/plain'),at,at,'end',true);
      });
      input.addEventListener('pointerdown',event => this.pointerDown(event));
      input.addEventListener('blur',() => this.stopPointer());
      input.addEventListener('lostpointercapture',event => { if (this.pointer?.id===event.pointerId) this.stopPointer(); });
      window.addEventListener('blur',() => this.stopPointer());
      document.addEventListener('visibilitychange',() => { if (document.hidden) this.stopPointer(); });
      document.addEventListener('pointermove',event => this.pointerMove(event));
      document.addEventListener('pointerup',() => { if (this.pointer) this.readSelection(); this.stopPointer(); });
      document.addEventListener('pointercancel',() => this.stopPointer());
      this.scroller.addEventListener('pointerdown',event => {
        if (event.target===this.scroller || event.target===this.spacer) this.pointerDown(event);
      });
    }
    get value() { return this.large ? this.text : this.input.value; }
    set value(value) {
      value=String(value).replace(/\r\n?/g,'\n'); if (value===this.value) return;
      if (this.composing && this.large) return; // Never replace the OS composition buffer.
      const selected=this.getSelection(), top=this.scrollTop, left=this.scrollLeft;
      this.stopPointer();
      this.text=value; this.buildIndex();
      this.widthLines=null;
      const large=this.enabled && (this.lineCount>LINE_LIMIT || value.length>CHARACTER_LIMIT);
      this.setMode(large);
      if (!large) {
        this.input.value=value; this.input.setSelectionRange(Math.min(selected.start,value.length),Math.min(selected.end,value.length),selected.direction);
        this.index=null; this.buffer=''; this.text='';
      } else {
        this.selection={start:Math.min(selected.start,value.length),end:Math.min(selected.end,value.length),direction:selected.direction};
        this.layout(); this.window(true);
        if (this.reader.open) this.readPage();
      }
      this.scrollTop=top; this.scrollLeft=left;
    }
    getText() { return this.value; }
    setMode(large) {
      if (large===this.large) return;
      const focused=document.activeElement===this.input;
      this.large=large;
      if (!large) this.stopPointer();
      this.input.closest('.codebox').dataset.bounded=large ? 'true' : 'false';
      this.scroller.hidden=!large; this.readButton.hidden=!large;
      if (large) { this.scroller.append(this.input); this.input.setAttribute('aria-describedby',this.help.id); }
      else { this.scroller.parentNode.append(this.input); this.input.removeAttribute('aria-describedby'); this.input.setAttribute('aria-label','Code editor'); this.input.removeAttribute('data-window'); this.input.removeAttribute('style'); if (this.reader.open) this.reader.close(); }
      if (focused) this.input.focus({preventScroll:true});
    }
    settle() {
      if (this.composing) return;
      if (!this.large) { this.promote(); return; }
      this.ensureIndex();
      if (this.lineCount>LINE_LIMIT || this.text.length>CHARACTER_LIMIT) { this.window(true,true); return; }
      const text=this.text,s=this.selection,top=this.scrollTop,left=this.scrollLeft;
      this.setMode(false); this.input.value=text; this.input.setSelectionRange(s.start,s.end,s.direction);
      this.text=''; this.buffer=''; this.index=null; this.widthLines=null; this.scrollTop=top; this.scrollLeft=left;
    }
    get length() { return this.large ? this.text.length : this.input.textLength; }
    get textLength() { return this.length; }
    getSelection() {
      if (!this.large) return {start:this.input.selectionStart,end:this.input.selectionEnd,direction:this.input.selectionDirection};
      this.readSelection();
      return {...this.selection};
    }
    get selectionStart() { return this.getSelection().start; }
    get selectionEnd() { return this.getSelection().end; }
    get selectionDirection() { return this.getSelection().direction; }
    setSelectionRange(start,end,direction='none',preserveColumn=false) {
      if (this.composing) return;
      this.touchSelecting=false; this.touchPanning=false;
      if (this.pointer?.touch) this.pointer=null;
      if (!this.large) { this.input.setSelectionRange(start,end,direction); return; }
      if (!preserveColumn) this.column=null;
      this.nativeExtending=false;
      start=Math.max(0,Math.min(this.text.length,start)); end=Math.max(start,Math.min(this.text.length,end));
      this.selection={start,end,direction}; this.window(true,true); this.nativeSelection();
    }
    get scrollTop() { return this.large ? this.scroller.scrollTop : this.input.scrollTop; }
    set scrollTop(value) { if (this.large) { this.scroller.scrollTop=value; this.window(false); } else this.input.scrollTop=value; }
    get scrollLeft() { return this.large ? this.scroller.scrollLeft : this.input.scrollLeft; }
    set scrollLeft(value) { if (this.large) { this.scroller.scrollLeft=value; this.window(false); } else this.input.scrollLeft=value; }
    get scrollHeight() { return this.large ? this.scroller.scrollHeight : this.input.scrollHeight; }
    get clientHeight() { return this.large ? this.scroller.clientHeight : this.input.clientHeight; }
    get clientWidth() { return this.large ? this.scroller.clientWidth : this.input.clientWidth; }
    setRangeText(value,start=this.selectionStart,end=this.selectionEnd,mode='preserve') {
      if (!this.large) { if (!this.nativeReplacement(value,start,end,mode,false)) this.input.setRangeText(value,start,end,mode); return; }
      this.replace(value,start,end,mode,false);
    }
    lineBreaks(value,start=0,end=value.length,limit=Infinity) {
      let count=0;
      for (let at=value.indexOf('\n',start);at>=0 && at<end && count<limit;at=value.indexOf('\n',at+1)) count++;
      return count;
    }
    promote() {
      if (this.large || !this.enabled || this.composing) return;
      const value=this.input.value;
      if (value.length<=CHARACTER_LIMIT && this.lineBreaks(value,0,value.length,LINE_LIMIT)<LINE_LIMIT) return;
      const selection=this.getSelection(),top=this.input.scrollTop,left=this.input.scrollLeft;
      this.widthLines=null; this.text=value; this.selection=selection; this.buildIndex(); this.setMode(true); this.layout();
      this.scroller.scrollTop=top; this.scroller.scrollLeft=left; this.window(true,true); this.reveal(); this.changedViewport();
    }
    nativeReplacement(value,start,end,mode,emit) {
      if (!this.enabled || this.composing) return false;
      value=String(value).replace(/\r\n?/g,'\n'); const text=this.input.value;
      if (text.length+value.length-(end-start)<=CHARACTER_LIMIT && !value.includes('\n')) return false;
      const remaining=LINE_LIMIT-this.lineBreaks(text)+this.lineBreaks(text,start,end);
      if (text.length+value.length-(end-start)<=CHARACTER_LIMIT && this.lineBreaks(value,0,value.length,Math.max(1,remaining))<remaining) return false;
      const top=this.input.scrollTop,left=this.input.scrollLeft;
      this.selection=this.getSelection(); this.text=text; this.index=null; this.widthLines=null; this.setMode(true);
      this.replace(value,start,end,mode,false); this.scrollTop=top; this.scrollLeft=left; this.reveal(); this.changedViewport();
      if (emit) this.input.dispatchEvent(new Event('input',{bubbles:true}));
      return true;
    }
    buildIndex() {
      const offsets=[0]; let line=0, last=0, longest=0;
      for (let at=this.text.indexOf('\n');at>=0;at=this.text.indexOf('\n',at+1)) {
        longest=Math.max(longest,at-last); last=at+1; line++;
        if (line%STRIDE===0) offsets.push(last);
      }
      this.lineCount=line+1; this.maxColumns=Math.max(longest,this.text.length-last);
      // A conservative horizontal extent avoids clipping tab/wide-glyph lines;
      // exact native hit testing and viewport slicing use measured glyph widths.
      this.horizontalColumns=this.maxColumns*(this.text.includes('\t') ? 4 : /[^\x00-\x7f]/.test(this.text) ? 2 : 1);
      this.index=Uint32Array.from(offsets);
    }
    ensureIndex() { if (!this.index) this.buildIndex(); }
    releaseIndex() { if (this.large && !this.composing) this.index=null; }
    offsetAtLine(line) {
      this.ensureIndex(); line=Math.max(0,Math.min(this.lineCount-1,line));
      const block=Math.floor(line/STRIDE); let at=this.index[block];
      for (let i=block*STRIDE;i<line;i++) at=this.text.indexOf('\n',at)+1;
      return at;
    }
    lineAtOffset(at) {
      this.ensureIndex(); at=Math.max(0,Math.min(this.text.length,at));
      let lo=0, hi=this.index.length;
      while (lo+1<hi) { const mid=(lo+hi)>>1; if (this.index[mid]<=at) lo=mid; else hi=mid; }
      let line=lo*STRIDE, cursor=this.index[lo], next;
      while ((next=this.text.indexOf('\n',cursor))>=0 && next<at) { line++; cursor=next+1; }
      return line;
    }
    metrics() {
      const style=getComputedStyle(this.input);
      const height=parseFloat(style.lineHeight)||23, padding=parseFloat(style.paddingTop)||0;
      const canvas=NimloEditor.canvas || (NimloEditor.canvas=document.createElement('canvas'));
      const context=canvas.getContext('2d'); context.font=style.fontSize+' '+style.fontFamily;
      return {height,padding,char:context.measureText('M').width||parseFloat(style.fontSize)*.6,font:context.font};
    }
    layout() {
      if (!this.large) return;
      this.ensureIndex(); const m=this.metrics();
      this.spacer.style.height=(this.lineCount*m.height+m.padding+32)+'px';
      this.spacer.style.width=Math.max(this.scroller.clientWidth,this.horizontalColumns*m.char+32)+'px';
    }
    window(force=false,forSelection=false) {
      if (!this.large || this.composing) return;
      this.ensureIndex(); this.layout(); const m=this.metrics();
      const visible=Math.max(0,Math.floor(Math.max(0,this.scrollTop-m.padding)/m.height));
      const caret=this.selection.direction==='backward' ? this.selection.start : this.selection.end;
      const caretLine=this.lineAtOffset(caret);
      const caretVisible=caretLine>=visible && caretLine<visible+Math.ceil(this.clientHeight/m.height);
      const localSelection=this.selection.start===this.selection.end || this.selection.end-this.selection.start<=INPUT_CHARS && this.lineAtOffset(this.selection.start)===this.lineAtOffset(this.selection.end);
      const focus=localSelection && (forSelection || caretVisible) ? caretLine : visible;
      const retainedFocus=forSelection || caretVisible ? caretLine : visible;
      let first=Math.max(0,focus-40);
      if (this.buffer && this.firstColumn===0 && this.firstLine<this.lineCount) {
        const retainedFirst=this.firstLine,retainedLast=Math.min(this.lineCount,retainedFirst+WINDOW_LINES);
        const retainedStart=this.offsetAtLine(retainedFirst),retainedEnd=retainedLast===this.lineCount ? this.text.length : this.offsetAtLine(retainedLast);
        const lower=retainedFirst===0 ? 0 : retainedFirst+16,upper=retainedLast===this.lineCount ? this.lineCount : retainedLast-16;
        const viewEnd=Math.min(this.lineCount,visible+Math.ceil(this.clientHeight/m.height));
        // Refresh edits in place until focus approaches the retained boundary.
        // Character-clipped windows keep their existing horizontal behavior.
        if (retainedEnd-retainedStart<=INPUT_CHARS && visible>=retainedFirst && viewEnd<=retainedLast && retainedFocus>=lower && retainedFocus<upper) first=retainedFirst;
      }
      let last=Math.min(this.lineCount,first+WINDOW_LINES);
      let start=this.offsetAtLine(first), end=last===this.lineCount ? this.text.length : this.offsetAtLine(last), column=0,horizontal=0;
      if (end-start>INPUT_CHARS) {
        // Very long logical lines are clipped horizontally as well as vertically.
        // A partial first line never shares its horizontal offset with later lines.
        first=Math.min(this.lineCount-1,focus); start=this.offsetAtLine(first);
        const stop=this.text.indexOf('\n',start), lineEnd=stop<0 ? this.text.length : stop;
        if (lineEnd-start>INPUT_CHARS) {
          const lineStart=start,target=forSelection ? this.widthBetween(start,caret,m) : this.scrollLeft;
          const retainedStart=this.start,retainedEnd=this.end;
          const inside=this.buffer && this.firstLine===first && retainedStart>=lineStart && retainedEnd<=lineEnd && retainedEnd-retainedStart<=INPUT_CHARS;
          const safeCaret=caret>=retainedStart+(retainedStart===lineStart ? 0 : 512) && caret<=retainedEnd-(retainedEnd===lineEnd ? 0 : 512);
          const selectedRange=localSelection && this.selection.end>this.selection.start && this.selection.end-this.selection.start<=INPUT_CHARS-1024 && this.selection.start>=lineStart && this.selection.end<=lineEnd;
          const safeSelection=!selectedRange || this.selection.start>=retainedStart && this.selection.end<=retainedEnd;
          const retainedLeft=inside ? this.widthBetween(lineStart,retainedStart,m) : 0,retainedRight=inside ? this.widthBetween(lineStart,retainedEnd,m) : 0;
          // A retained suffix already contains every character to its right.
          // Native caret scrolling may extend past the measured line end;
          // recropping there would reset the entire native input on a keypress.
          if (inside && safeSelection && (forSelection ? safeCaret : this.scrollLeft>=retainedLeft && (retainedEnd===lineEnd || this.scrollLeft+this.clientWidth<=retainedRight))) {
            start=retainedStart; end=retainedEnd;
          } else {
            start=this.offsetAtWidth(lineStart,lineEnd,Math.max(0,target-2048*m.char),m);
            start=Math.min(start,Math.max(lineStart,lineEnd-(INPUT_CHARS-1024)));
            end=Math.min(lineEnd,start+INPUT_CHARS-1024);
            if (selectedRange) {
              start=Math.max(lineStart,Math.max(Math.min(start,this.selection.start),this.selection.end-(INPUT_CHARS-1024)));
              end=Math.min(lineEnd,start+INPUT_CHARS-1024);
            }
          }
          if (/[\uDC00-\uDFFF]/.test(this.text[start])) start--;
          column=start-lineStart; horizontal=this.widthBetween(lineStart,start,m);
          if (/[\uDC00-\uDFFF]/.test(this.text[end])) end--;
          last=first+1;
        } else {
          last=first+1; end=stop<0 ? this.text.length : stop+1;
          while (last<this.lineCount && last<first+WINDOW_LINES) {
            const next=this.offsetAtLine(last+1), nextEnd=last+1===this.lineCount ? this.text.length : next;
            if (nextEnd-start>INPUT_CHARS) break; end=nextEnd; last++;
          }
        }
      }
      const value=this.text.slice(start,end);
      if (force || start!==this.start || end!==this.end || value!==this.buffer) {
        this.syncing=true; this.start=start; this.end=end; this.firstLine=first; this.firstColumn=column; this.buffer=value;
        if (this.input.value!==value) this.input.value=value;
        this.input.dataset.window=String(first+1)+'–'+String(last)+' of '+this.lineCount+' lines';
        this.input.setAttribute('aria-label','Code editor, lines '+(first+1)+' through '+last+' of '+this.lineCount);
        const indent=horizontal%(m.char*4);
        this.input.style.textIndent=indent+'px';
        this.input.style.top=(first*m.height)+'px'; this.input.style.left=(horizontal-indent)+'px';
        const width=last===first+1 ? this.widthBetween(this.offsetAtLine(first),end,m)-horizontal : Math.min(this.horizontalColumns,INPUT_CHARS*4)*m.char;
        this.input.style.width=Math.max(this.scroller.clientWidth-horizontal,width+32)+'px';
        this.input.style.height=((last-first)*m.height+m.padding+32)+'px';
        this.nativeSelection(); this.syncing=false;
      }
    }
    nativeSelection() {
      if (!this.large || this.composing) return;
      this.syncing=true;
      const s=this.selection;
      this.input.setSelectionRange(Math.max(0,Math.min(this.buffer.length,s.start-this.start)),Math.max(0,Math.min(this.buffer.length,s.end-this.start)),s.direction);
      this.input.scrollTop=0; this.input.scrollLeft=0;
      this.syncing=false;
    }
    readSelection() {
      if (!this.large || this.syncing || this.composing) return;
      const local={start:this.input.selectionStart,end:this.input.selectionEnd,direction:this.input.selectionDirection};
      if (this.pointer?.touch && (local.start!==this.pointer.local.start || local.end!==this.pointer.local.end)) this.pointer.selectionChanged=true;
      const expected={start:Math.max(0,Math.min(this.buffer.length,this.selection.start-this.start)),end:Math.max(0,Math.min(this.buffer.length,this.selection.end-this.start))};
      if (local.start===expected.start && local.end===expected.end && !(this.touchSelecting && !this.touchPanning && !this.nativeExtending) && !this.pointer?.shift) return;
      if (this.pointer?.native && this.pointer.shift && (this.pointer.anchor<this.start || this.pointer.anchor>this.end)) {
        const anchor=this.pointer.anchor,nativeAnchor=Math.max(0,Math.min(this.buffer.length,anchor-this.start));
        const at=this.start+(local.start===nativeAnchor ? local.end : local.end===nativeAnchor ? local.start : local.direction==='backward' ? local.start : local.end);
        this.selection={start:Math.min(anchor,at),end:Math.max(anchor,at),direction:at<anchor ? 'backward' : 'forward'}; this.nativeExtending=true; return;
      }
      // Native Edit > Select All and accessibility selection commands operate
      // on the document. Pointer drags retain their explicit document anchor.
      if (!this.pointer && !this.touchSelecting && !this.nativeKeyboardSelection && local.start===0 && local.end===this.buffer.length && this.buffer.length) { this.selection={start:0,end:this.text.length,direction:local.direction}; this.nativeExtending=false; }
      else {
        const collapsed=local.start===local.end, extending=this.nativeExtending && this.selection.start!==this.selection.end;
        this.selection={start:extending && !collapsed && local.start===expected.start && this.selection.start<this.start ? this.selection.start : this.start+local.start,
          end:extending && !collapsed && local.end===expected.end && this.selection.end>this.end ? this.selection.end : this.start+local.end,direction:local.direction};
        this.nativeExtending=true;
      }
    }
    readInput() {
      if (!this.large) { this.promote(); return; }
      const value=this.input.value; if (value===this.buffer) return;
      let first=0, oldEnd=this.buffer.length, newEnd=value.length;
      while (first<oldEnd && first<newEnd && this.buffer[first]===value[first]) first++;
      while (oldEnd>first && newEnd>first && this.buffer[oldEnd-1]===value[newEnd-1]) { oldEnd--; newEnd--; }
      this.invalidateWidths(this.start+first);
      this.text=this.text.slice(0,this.start+first)+value.slice(first,newEnd)+this.text.slice(this.start+oldEnd);
      if (this.composing && this.compositionOriginal) {
        const original=this.compositionOriginal, local=original.local;
        if (value===original.buffer) {
          this.text=original.text; this.start=original.start; this.buffer=value; this.end=this.start+value.length;
          this.selection={...original.selection}; this.index=null; return;
        }
        first=0; oldEnd=original.buffer.length; newEnd=value.length;
        while (first<oldEnd && first<newEnd && original.buffer[first]===value[first]) first++;
        while (oldEnd>first && newEnd>first && original.buffer[oldEnd-1]===value[newEnd-1]) { oldEnd--; newEnd--; }
        first=Math.min(first,local.start); oldEnd=Math.max(oldEnd,local.end); newEnd=value.length-(original.buffer.length-oldEnd);
        const globalStart=original.selection.start+first-local.start,globalEnd=original.selection.end+oldEnd-local.end;
        this.text=original.text.slice(0,globalStart)+value.slice(first,newEnd)+original.text.slice(globalEnd);
        this.start=original.selection.start-local.start;
      }
      this.end=this.start+value.length; this.buffer=value; this.compositionChanged=true;
      this.selection={start:this.start+this.input.selectionStart,end:this.start+this.input.selectionEnd,direction:this.input.selectionDirection};
      this.index=null; this.column=null;
      if (!this.composing) this.settle();
    }
    replace(value,start,end,mode,emit) {
      value=String(value).replace(/\r\n?/g,'\n');
      const before=this.selection, delta=value.length-(end-start);
      this.invalidateWidths(start);
      this.text=this.text.slice(0,start)+value+this.text.slice(end);
      if (start>=this.start && end<=this.end) this.end+=delta;
      if (mode==='start') this.selection={start,end:start,direction:'none'};
      else if (mode==='end') this.selection={start:start+value.length,end:start+value.length,direction:'none'};
      else if (mode==='select') this.selection={start,end:start+value.length,direction:'none'};
      else this.selection={start:before.start>end ? before.start+delta : Math.min(before.start,start),end:before.end>end ? before.end+delta : Math.max(start+value.length,before.end),direction:before.direction};
      this.index=null; this.settle(); this.reveal();
      if (emit) this.input.dispatchEvent(new Event('input',{bubbles:true}));
    }
    beforeInput(event) {
      if (event.defaultPrevented || this.input.readOnly) return;
      if (event.inputType==='historyUndo' || event.inputType==='historyRedo') { if (!this.composing && !event.isComposing && this.onHistory) { event.preventDefault(); this.onHistory(event.inputType==='historyRedo'); } return; }
      if (!this.large && !this.composing && !event.isComposing) {
        const value=event.inputType==='insertLineBreak' || event.inputType==='insertParagraph' ? '\n' : event.inputType.startsWith('insert') ? event.data : null;
        if (value!=null && this.nativeReplacement(value,this.input.selectionStart,this.input.selectionEnd,'end',true)) event.preventDefault();
        return;
      }
      if (!this.large || this.composing || event.isComposing || this.input.dataset.vim==='normal') return;
      this.readSelection(); const s=this.selection;
      const outside=s.start<this.start || s.end>this.end;
      const backward=event.inputType==='deleteContentBackward' && s.start===s.end && s.start===this.start && s.start>0;
      const forward=event.inputType==='deleteContentForward' && s.start===s.end && s.end===this.end && s.end<this.text.length;
      const wordBackward=event.inputType==='deleteWordBackward' && s.start===s.end;
      const wordForward=event.inputType==='deleteWordForward' && s.start===s.end;
      if (outside || backward || forward || wordBackward || wordForward) {
        let value=event.data;
        if (event.inputType.startsWith('delete')) value='';
        else if (event.inputType==='insertLineBreak' || event.inputType==='insertParagraph') value='\n';
        if (value==null) return;
        event.preventDefault(); let start=s.start,end=s.end;
        if (backward) start=this.previous(start); if (forward) end=this.next(end);
        if (wordBackward) start=this.wordPrevious(start); if (wordForward) end=this.wordNext(end);
        this.replace(value,start,end,'end',true);
      }
    }
    previousScalar(at) { return at>1 && /[\uDC00-\uDFFF]/.test(this.text[at-1]) ? at-2 : Math.max(0,at-1); }
    nextScalar(at) { return Math.min(this.text.length,at+(this.text.codePointAt(at)>0xffff ? 2 : 1)); }
    segments(start,end) {
      const text=this.text.slice(start,end);
      if (/^[\x00-\x7f]*$/.test(text) || typeof Intl.Segmenter!=='function') return null;
      const segmenter=NimloEditor.segmenter || (NimloEditor.segmenter=new Intl.Segmenter(undefined,{granularity:'grapheme'}));
      return segmenter.segment(text);
    }
    previous(at) {
      if (!at || this.text[at-1]==='\n') return Math.max(0,at-1);
      const start=this.text.lastIndexOf('\n',at-1)+1,stop=this.text.indexOf('\n',at),end=stop<0 ? this.text.length : stop;
      const segment=this.segments(start,end)?.containing(at-start-1);
      return segment ? start+segment.index : this.previousScalar(at);
    }
    next(at) {
      if (at===this.text.length || this.text[at]==='\n') return Math.min(this.text.length,at+1);
      const start=at ? this.text.lastIndexOf('\n',at-1)+1 : 0,stop=this.text.indexOf('\n',at),end=stop<0 ? this.text.length : stop;
      const segment=this.segments(start,end)?.containing(at-start);
      return segment ? start+segment.index+segment.segment.length : this.nextScalar(at);
    }
    wordPrevious(at) {
      at=this.previousScalar(at); while (at>0 && /\s/u.test(this.text[at])) at=this.previousScalar(at);
      const word=position => /[\p{L}\p{N}\p{M}_]/u.test(String.fromCodePoint(this.text.codePointAt(position)||32)),kind=word(at);
      while (at>0 && !/\s/u.test(this.text[this.previousScalar(at)]) && word(this.previousScalar(at))===kind) at=this.previousScalar(at);
      return at;
    }
    wordNext(at) {
      const word=position => /[\p{L}\p{N}\p{M}_]/u.test(String.fromCodePoint(this.text.codePointAt(position)||32)),kind=word(at);
      while (at<this.text.length && !/\s/u.test(this.text[at]) && word(at)===kind) at=this.nextScalar(at);
      while (at<this.text.length && /\s/u.test(this.text[at])) at=this.nextScalar(at);
      return at;
    }
    key(event) {
      if (!this.large || event.defaultPrevented || event.isComposing || this.composing) return;
      this.readSelection();
      this.touchSelecting=false;
      const text=this.text,s=this.selection, meta=event.metaKey||event.ctrlKey;
      if (meta && event.key.toLowerCase()==='a') { event.preventDefault(); this.setSelectionRange(0,text.length,'forward'); return; }
      if (this.input.dataset.vim==='normal') return;
      if ((event.altKey && !['ArrowLeft','ArrowRight'].includes(event.key)) || (meta && !['Home','End','ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key))) return;
      if (!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End','PageUp','PageDown'].includes(event.key)) return;
      let at=s.direction==='backward' ? s.start : s.end;
      if (!meta && !event.altKey && ['ArrowLeft','ArrowRight'].includes(event.key) && s.start>=this.start && s.end<=this.end && (at>this.start || this.start===0) && (at<this.end || this.end===text.length)) {
        // Native visual movement preserves bidi, grapheme and platform selection
        // rules inside the buffer. Only crossing its edges needs global motion.
        this.column=null; this.nativeKeyboardSelection=event.shiftKey;
        setTimeout(() => { if (this.large && !this.composing) { this.readSelection(); this.reveal(); this.window(false); this.changedViewport(); } },0);
        return;
      }
      const start=at ? text.lastIndexOf('\n',at-1)+1 : 0, stop=text.indexOf('\n',at), end=stop<0 ? text.length : stop;
      if (meta && (event.key==='Home' || event.key==='ArrowUp')) at=0;
      else if (meta && (event.key==='End' || event.key==='ArrowDown')) at=text.length;
      else if (event.key==='Home' || (event.metaKey && event.key==='ArrowLeft')) at=start;
      else if (event.key==='End' || (event.metaKey && event.key==='ArrowRight')) at=end;
      else if (event.key==='ArrowLeft') at=!event.shiftKey && s.start!==s.end ? s.start : (event.altKey||event.ctrlKey ? this.wordPrevious(at) : this.previous(at));
      else if (event.key==='ArrowRight') at=!event.shiftKey && s.start!==s.end ? s.end : (event.altKey||event.ctrlKey ? this.wordNext(at) : this.next(at));
      else {
        const down=['ArrowDown','PageDown'].includes(event.key), count=event.key.startsWith('Page') ? Math.max(1,Math.floor(this.clientHeight/this.metrics().height)-2) : 1;
        const line=Math.max(0,Math.min(this.lineCount-1,this.lineAtOffset(at)+(down ? count : -count))), first=this.offsetAtLine(line), last=text.indexOf('\n',first);
        const m=this.metrics(),column=this.column ?? Math.floor(this.widthBetween(start,at,m)); this.column=column;
        at=this.offsetAtWidth(first,last<0 ? text.length : last,column,m,true);
      }
      if (!['ArrowUp','ArrowDown','PageUp','PageDown'].includes(event.key)) this.column=null;
      event.preventDefault();
      const vertical=['ArrowUp','ArrowDown','PageUp','PageDown'].includes(event.key);
      if (event.shiftKey) { const anchor=s.direction==='backward' ? s.end : s.start; this.setSelectionRange(Math.min(anchor,at),Math.max(anchor,at),at<anchor ? 'backward' : 'forward',vertical); }
      else this.setSelectionRange(at,at,'none',vertical);
      this.reveal(); this.changedViewport();
    }
    reveal() {
      if (this.composing) return;
      if (!this.large) {
        const input=this.input;
        if (!input.clientHeight || !input.clientWidth) return;
        const text=input.value,at=input.selectionDirection==='backward' ? input.selectionStart : input.selectionEnd;
        let line=0,start=0,next;
        while ((next=text.indexOf('\n',start))>=0 && next<at) { line++; start=next+1; }
        const m=this.metrics(),style=getComputedStyle(input),top=line*m.height+m.padding;
        if (top<input.scrollTop) input.scrollTop=top-m.padding;
        else if (top+m.height+4>input.scrollTop+input.clientHeight) input.scrollTop=top+m.height+4-input.clientHeight;
        // Keep native bidi affinity authoritative. Logical prefix widths suffice
        // for ordinary code, but cannot identify both visual edges of RTL runs.
        const stop=text.indexOf('\n',start),end=stop<0 ? text.length : stop;
        if (style.direction==='rtl' || /[\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufeff]/.test(text.slice(start,end))) return;
        const context=NimloEditor.canvas.getContext('2d'),tabSize=style.tabSize || '4';
        const tabWidth=tabSize.endsWith('px') ? parseFloat(tabSize) : (parseFloat(tabSize)||4)*m.char;
        let width=0,offset=start,tab;
        while ((tab=text.indexOf('\t',offset))>=0 && tab<at) {
          width+=context.measureText(text.slice(offset,tab)).width;
          width=(Math.floor(width/tabWidth+0.000001)+1)*tabWidth; offset=tab+1;
        }
        width+=context.measureText(text.slice(offset,at)).width;
        const left=(parseFloat(style.paddingLeft)||0)+width,right=left+Math.max(4,parseFloat(style.paddingRight)||0);
        if (left<input.scrollLeft) input.scrollLeft=left;
        else if (right>input.scrollLeft+input.clientWidth) input.scrollLeft=right-input.clientWidth;
        return;
      }
      const at=this.selection.direction==='backward' ? this.selection.start : this.selection.end,m=this.metrics(),line=this.lineAtOffset(at),top=line*m.height+m.padding;
      if (top<this.scrollTop) this.scrollTop=top-m.padding;
      else if (top+m.height>this.scrollTop+this.clientHeight) this.scrollTop=top+m.height-this.clientHeight;
      const left=this.widthBetween(this.offsetAtLine(line),at,m);
      if (left<this.scrollLeft) this.scrollLeft=left;
      else if (left+16>this.scrollLeft+this.clientWidth) this.scrollLeft=left+16-this.clientWidth;
    }
    clipboard(event,cut) {
      if (!this.large || !event.clipboardData || this.composing || (cut && this.input.readOnly)) return;
      this.readSelection(); if (this.selection.start===this.selection.end) return;
      event.preventDefault(); event.clipboardData.setData('text/plain',this.text.slice(this.selection.start,this.selection.end));
      if (cut) this.replace('',this.selection.start,this.selection.end,'end',true);
    }
    position(x,y) {
      const rect=this.scroller.getBoundingClientRect(),m=this.metrics(),line=Math.max(0,Math.min(this.lineCount-1,Math.floor((y-rect.top+this.scrollTop-m.padding)/m.height))),start=this.offsetAtLine(line),stop=this.text.indexOf('\n',start);
      const end=stop<0 ? this.text.length : stop,target=Math.max(0,x-rect.left+this.scrollLeft);
      return this.offsetAtWidth(start,end,target,m,true);
    }
    *glyphs(start,end) {
      // Segment bounded chunks. Holding the last cluster for the next chunk
      // keeps combining marks, flags and ZWJ emoji intact across chunk edges.
      let at=start;
      while (at<end) {
        const chunkStart=at;
        let stop=Math.min(end,at+2048),progress=false;
        while (!progress) {
          const segments=this.segments(at,stop);
          if (!segments) {
            const safe=stop<end && typeof Intl.Segmenter==='function' ? stop-1 : stop;
            for (const char of this.text.slice(at,safe)) yield char; at=safe; break;
          }
          let pending=null;
          for (const segment of segments) {
            if (pending) { yield pending.segment; at=pending.index+pending.segment.length; progress=true; }
            pending={index:chunkStart+segment.index,segment:segment.segment};
          }
          if (stop===end) { if (pending) yield pending.segment; at=end; break; }
          if (!progress) { stop=Math.min(end,stop+2048); continue; }
          // `at` now ends immediately before the final, potentially unfinished
          // cluster. The next bounded segmenter sees that cluster in full.
          break;
        }
      }
    }
    advance(glyph,width,m) {
      if (glyph==='\t') { const remainder=width/m.char%4; return (remainder<.000001 || 4-remainder<.000001 ? 4 : 4-remainder)*m.char; }
      if (/^[\x20-\x7e]$/.test(glyph)) return m.char;
      if (glyph.length>32) return NimloEditor.canvas.getContext('2d').measureText(glyph).width;
      const cache=this.glyphWidths || (this.glyphWidths=new Map()),key=m.font+'|'+[...glyph].join('');
      if (!cache.has(key)) { if (cache.size===128) cache.delete(cache.keys().next().value); cache.set(key,NimloEditor.canvas.getContext('2d').measureText(glyph).width); }
      return cache.get(key);
    }
    widthBetween(start,end,m=this.metrics()) {
      if (/^[\x20-\x7e]*$/.test(this.text.slice(start,end))) return (end-start)*m.char;
      const lineStart=start===0 || this.text[start-1]==='\n';
      if (lineStart) {
        const record=this.widthRecord(start,m);
        let checkpoint=record.offsets.length-1;
        while (checkpoint>0 && record.offsets[checkpoint]>end) checkpoint--;
        let at=record.offsets[checkpoint],width=record.widths[checkpoint],last=at;
        for (const glyph of this.glyphs(at,end)) {
          width+=this.advance(glyph,width,m); at+=glyph.length;
          if (at<end && checkpoint===record.offsets.length-1 && at-last>=256) { record.offsets.push(at); record.widths.push(width); checkpoint++; last=at; }
        }
        return width;
      }
      let width=0; for (const glyph of this.glyphs(start,end)) width+=this.advance(glyph,width,m);
      return width;
    }
    widthRecord(start,m) {
      const records=this.widthLines || (this.widthLines=new Map());
      let record=records.get(start);
      if (!record || record.font!==m.font || record.char!==m.char) {
        if (records.size>=16) records.delete(records.keys().next().value);
        record={font:m.font,char:m.char,offsets:[start],widths:[0]}; records.set(start,record);
      }
      return record;
    }
    invalidateWidths(at) {
      if (!this.widthLines) return;
      for (const [start,record] of this.widthLines) {
        if (start>at) { this.widthLines.delete(start); continue; }
        let keep=record.offsets.length;
        while (keep>1 && record.offsets[keep-1]>=at) keep--;
        record.offsets.length=keep; record.widths.length=keep;
      }
    }
    offsetAtWidth(start,end,target,m=this.metrics(),nearest=false) {
      if (/^[\x20-\x7e]*$/.test(this.text.slice(start,end))) return Math.max(start,Math.min(end,start+(nearest ? Math.round(target/m.char) : Math.ceil(target/m.char))));
      const record=start===0 || this.text[start-1]==='\n' ? this.widthRecord(start,m) : null;
      let checkpoint=0;
      if (record) {
        let lo=0,hi=record.widths.length;
        while (lo+1<hi) { const middle=(lo+hi)>>1; if (record.widths[middle]<=target && record.offsets[middle]<=end) lo=middle; else hi=middle; }
        checkpoint=lo;
      }
      let width=record?.widths[checkpoint] || 0,at=record?.offsets[checkpoint] ?? start,last=at;
      for (const glyph of this.glyphs(at,end)) {
        const advance=this.advance(glyph,width,m);
        if (nearest ? target<width+advance/2 : width>=target) break;
        width+=advance; at+=glyph.length;
        if (record && checkpoint===record.offsets.length-1 && at-last>=256) { record.offsets.push(at); record.widths.push(width); checkpoint++; last=at; }
      }
      return at;
    }
    pointerDown(event) {
      if (!this.large || this.composing || event.button!==0) return;
      this.readSelection();
      const extending=this.nativeExtending;
      this.nativeExtending=false; this.column=null;
      this.touchSelecting=event.pointerType==='touch'; this.touchPanning=false;
      if (this.touchSelecting) { this.pointer={id:event.pointerId,native:true,touch:true,x:event.clientX,y:event.clientY,selection:{...this.selection},local:{start:this.input.selectionStart,end:this.input.selectionEnd},text:this.text,extending}; return; }
      const at=this.position(event.clientX,event.clientY),s=this.selection;
      const anchor=event.shiftKey ? (s.direction==='backward' ? s.end : s.start) : at;
      this.pointer={id:event.pointerId,anchor,native:event.target===this.input,shift:event.shiftKey,x:event.clientX,y:event.clientY};
      if (event.target===this.input) {
        // Browser hit testing, double-click words and native touch affordances
        // stay authoritative inside the current text window.
        const pointer=this.pointer;
        setTimeout(() => { if (this.pointer===pointer && !pointer.custom) { this.readSelection(); if (!pointer.shift) pointer.anchor=this.selection.start; } },0);
        return;
      }
      event.preventDefault(); this.input.focus({preventScroll:true});
      this.setSelectionRange(Math.min(anchor,at),Math.max(anchor,at),at<anchor ? 'backward' : 'forward');
    }
    pointerMove(event) {
      if (!this.large || !this.pointer || this.pointer.id!==event.pointerId || this.composing) return;
      if (this.pointer.touch) {
        const pointer=this.pointer;
        if (this.input.selectionStart!==pointer.local.start || this.input.selectionEnd!==pointer.local.end) pointer.selectionChanged=true;
        if (!pointer.selectionChanged && this.text===pointer.text && Math.hypot(event.clientX-pointer.x,event.clientY-pointer.y)>6) {
          this.selection={...pointer.selection}; this.nativeExtending=pointer.extending; this.touchPanning=true;
        }
        return;
      }
      const pointer=this.pointer,rect=this.scroller.getBoundingClientRect();
      pointer.x=event.clientX; pointer.y=event.clientY;
      if (pointer.native && !pointer.custom && event.clientY>=rect.top+16 && event.clientY<=rect.bottom-16 && event.clientX>=rect.left && event.clientX<=rect.right) return;
      event.preventDefault();
      if (!pointer.custom) {
        pointer.custom=true;
        try { this.input.setPointerCapture(pointer.id); pointer.captured=this.input.hasPointerCapture(pointer.id); } catch {}
      }
      this.extendPointer(pointer,3); this.queuePointerScroll();
    }
    extendPointer(pointer,lines=1) {
      const rect=this.scroller.getBoundingClientRect(),m=this.metrics();
      if (pointer.y<rect.top+16) this.scrollTop-=m.height*lines;
      else if (pointer.y>rect.bottom-16) this.scrollTop+=m.height*lines;
      const at=this.position(pointer.x,pointer.y),anchor=pointer.anchor;
      this.setSelectionRange(Math.min(anchor,at),Math.max(anchor,at),at<anchor ? 'backward' : 'forward'); this.changedViewport();
    }
    queuePointerScroll() {
      if (this.pointerFrame) { cancelAnimationFrame(this.pointerFrame); this.pointerFrame=0; }
      const pointer=this.pointer;
      if (!this.large || this.composing || !pointer?.custom || pointer.touch) return;
      const rect=this.scroller.getBoundingClientRect();
      if (!(pointer.y<rect.top+16 && this.scrollTop>0 || pointer.y>rect.bottom-16 && this.scrollTop<this.scrollHeight-this.clientHeight)) return;
      this.pointerFrame=requestAnimationFrame(() => {
        this.pointerFrame=0;
        if (this.pointer!==pointer || !this.large || this.composing) return;
        this.extendPointer(pointer); this.queuePointerScroll();
      });
    }
    stopPointer() {
      if (this.pointerFrame) cancelAnimationFrame(this.pointerFrame);
      const pointer=this.pointer;
      this.pointerFrame=0; this.pointer=null;
      if (pointer?.captured) { try { this.input.releasePointerCapture(pointer.id); } catch {} }
    }
    viewport() {
      if (!this.large) return null;
      this.ensureIndex(); const m=this.metrics(),first=Math.max(0,Math.floor(this.scrollTop/m.height)-2),last=Math.min(this.lineCount,first+Math.ceil(this.clientHeight/m.height)+5),lines=[],offsets=[],starts=[];
      let at=this.offsetAtLine(first);
      for (let line=first;line<last;line++) {
        const end=this.text.indexOf('\n',at),stop=end<0 ? this.text.length : end;
        let from=at,width=0;
        if (stop-at>8192) {
          const target=Math.max(0,this.scrollLeft-64*m.char);
          from=this.offsetAtWidth(at,stop,target,m); width=this.widthBetween(at,from,m);
        }
        lines.push(this.text.slice(from,Math.min(stop,from+8192))); offsets.push(width); starts.push(from); at=stop+1;
      }
      return {first,last,lines,offsets,starts,height:m.height,top:this.scrollTop,left:this.scrollLeft,plain:this.maxColumns>8192};
    }
    changedViewport() { this.input.dispatchEvent(new Event('nimloviewportchange')); }
    readPage() {
      this.ensureIndex(); let start=Math.max(0,Math.min(this.text.length,this.readerOffset));
      if (/[\uDC00-\uDFFF]/.test(this.text[start])) start--;
      this.readerOffset=start; const first=this.lineAtOffset(start);
      const endLine=Math.min(this.lineCount,first+120),lineEnd=endLine===this.lineCount ? this.text.length : this.offsetAtLine(endLine);
      let end=Math.min(this.text.length,start+WINDOW_CHARS,lineEnd);
      if (/[\uDC00-\uDFFF]/.test(this.text[end])) end--;
      this.readerEnd=end;
      const control=name => this.reader.querySelector('[data-reader="'+name+'"]');
      control('text').textContent=this.text.slice(start,end);
      control('range').textContent='Lines '+(first+1)+'–'+(this.lineAtOffset(Math.max(start,end-1))+1)+' of '+this.lineCount+(start>this.offsetAtLine(first) ? ', continued' : '');
      control('line').value=String(first+1); control('line').max=String(this.lineCount);
      control('previous').disabled=start===0; control('next').disabled=end===this.text.length;
      control('text').scrollTop=0; control('text').scrollLeft=0;
    }
  }
  window.NimloEditor=NimloEditor;
})();
