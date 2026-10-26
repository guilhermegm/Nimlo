local channel = ...
local M = { applying = false, vim = false, active = false, editable = false, views = {}, view_order = {}, all = false, buf = vim.api.nvim_get_current_buf() }
_G.nimlo = M
local function action(name, ...) vim.rpcnotify(channel, 'nimlo_action', name, ...) end
local function changed() if not M.applying and M.active then vim.rpcnotify(channel, 'nimlo_changed') end end
local selection_pattern='^[vVsS\22\19]'
local select_pattern='^[sS\19]'
local mode_options={keymodel=vim.o.keymodel,selectmode=vim.o.selectmode,selection=vim.o.selection,whichwrap=vim.o.whichwrap}
local function configure_mode()
  -- Edit is a conventional editor; Vim keeps Neovim's modal defaults.
  vim.o.keymodel=M.vim and mode_options.keymodel or 'startsel,stopsel'
  vim.o.selectmode=M.vim and mode_options.selectmode or 'mouse,key'
  vim.o.selection=M.vim and mode_options.selection or 'exclusive'
  vim.o.whichwrap=M.vim and mode_options.whichwrap or 'b,s,<,>,[,]'
end
configure_mode()
local function normal()
  -- Leave selections and Insert restarts before replacing buffers or modes.
  local mode=vim.api.nvim_get_mode().mode
  if mode:match(selection_pattern) then
    local escape=vim.api.nvim_replace_termcodes('<Esc>',true,false,true)
    vim.api.nvim_feedkeys(escape,'nx',false)
  end
  vim.cmd('stopinsert')
end
local function insert_at(cursor)
  local count=vim.api.nvim_buf_line_count(M.buf)
  cursor[1]=math.max(1,math.min(count,cursor[1]))
  local line=vim.api.nvim_buf_get_lines(M.buf,cursor[1]-1,cursor[1],true)[1] or ''
  local append=cursor[2]>=#line and #line>0
  cursor[2]=math.min(cursor[2],#line)
  vim.api.nvim_win_set_cursor(0,cursor)
  vim.cmd(append and 'startinsert!' or 'startinsert')
end

vim.o.termguicolors = true
vim.o.mouse = 'a'
vim.o.number = true
vim.o.relativenumber = false
vim.o.signcolumn = 'no'
vim.o.laststatus = 0
vim.o.showmode = false
vim.o.showcmd = false
vim.o.ruler = false
vim.o.cmdheight = 1
vim.o.wrap = false
vim.o.scrolloff = 4
vim.o.sidescrolloff = 6
vim.o.ignorecase = true
vim.o.smartcase = true
vim.o.hlsearch = true
vim.o.incsearch = true
vim.o.hidden = true
vim.o.smarttab = true
vim.o.modeline = false
vim.o.exrc = false
vim.o.undofile = false
vim.o.backup = false
vim.o.writebackup = false
vim.o.updatetime = 250
vim.o.shortmess = 'filnxtToOFc'
vim.o.fillchars = 'eob: '
vim.cmd('syntax enable')
for group, options in pairs({
  Normal={fg='#e8edf3',bg='#15191f'}, NormalNC={fg='#e8edf3',bg='#15191f'},
  LineNr={fg='#667383',bg='#15191f'}, CursorLineNr={fg='#c6e3ad',bold=true},
  CursorLine={bg='#1b222b'}, Visual={bg='#344452'}, Search={fg='#15191f',bg='#c6e3ad'},
  IncSearch={fg='#15191f',bg='#ebcc91'}, Comment={fg='#8491a2',italic=true},
  String={fg='#bddca4'}, Statement={fg='#c2b1e3'}, Type={fg='#a9c8df'},
  Identifier={fg='#d9e2ed'}, Constant={fg='#e4c08e'}, Special={fg='#e4c08e'},
  StatusLine={fg='#a9b4c3',bg='#20262f'}, EndOfBuffer={fg='#15191f',bg='#15191f'},
}) do vim.api.nvim_set_hl(0,group,options) end
vim.g.clipboard = {name='Nimlo native clipboard',copy={
  ['+']=function(lines) vim.rpcnotify(channel,'nimlo_clipboard',lines) end,
  ['*']=function(lines) vim.rpcnotify(channel,'nimlo_clipboard',lines) end,
},paste={
  ['+']=function() return vim.rpcrequest(channel,'nimlo_clipboard_get') end,
  ['*']=function() return vim.rpcrequest(channel,'nimlo_clipboard_get') end,
},cache_enabled=0}
local function setup_buffer()
  vim.bo[M.buf].buftype='acwrite'
  vim.bo[M.buf].swapfile=false
  vim.bo[M.buf].undofile=false
  -- One history authority is essential across phone and desktop. Neovim edits
  -- use the same revision-checked, bounded, durable host history as browser edits.
  vim.bo[M.buf].undolevels=-1
  vim.bo[M.buf].expandtab=true
  vim.bo[M.buf].shiftwidth=2
  vim.bo[M.buf].tabstop=2
  vim.bo[M.buf].softtabstop=2
  vim.bo[M.buf].autoindent=true
  vim.bo[M.buf].smartindent=true
end
setup_buffer()
vim.api.nvim_buf_attach(M.buf,false,{on_lines=changed})
vim.api.nvim_create_autocmd('BufWriteCmd',{buffer=M.buf,callback=function() action('save') end})
vim.api.nvim_create_autocmd('BufEnter',{callback=function(event)
  if not M.applying and event.buf~=M.buf then
    local name=vim.api.nvim_buf_get_name(event.buf)
    vim.schedule(function()
      if vim.api.nvim_buf_is_valid(M.buf) then vim.api.nvim_set_current_buf(M.buf) end
      if name~='' then action('open',name) end
      if vim.api.nvim_buf_is_valid(event.buf) then pcall(vim.api.nvim_buf_delete,event.buf,{force=true}) end
    end)
  end
end})
vim.keymap.set('n','u',function() action('undo') end)
vim.keymap.set('n','<C-r>',function() action('redo') end)
vim.keymap.set({'i','n','v'},'<D-s>',function() action('save') end)
vim.keymap.set({'i','n','v'},'<D-z>',function() action('undo') end)
vim.keymap.set({'i','n','v'},'<D-w>',function() action('close') end)
vim.keymap.set('i','<S-Tab>','<C-d>',{noremap=true})
vim.keymap.set('v','<Tab>','>gv',{noremap=true})
vim.keymap.set('v','<S-Tab>','<gv',{noremap=true})
for open,close in pairs({['(']=')',['[']=']',['{']='}'}) do
  vim.keymap.set('i',open,open..close..'<Left>',{noremap=true})
  vim.keymap.set('i',close,function()
    local at=vim.api.nvim_win_get_cursor(0)[2]
    return vim.api.nvim_get_current_line():sub(at+1,at+1)==close and '<Right>' or close
  end,{expr=true,noremap=true})
end
vim.keymap.set('i','<BS>',function()
  local at=vim.api.nvim_win_get_cursor(0)[2]; local line=vim.api.nvim_get_current_line()
  local pairs={['(']=')',['[']=']',['{']='}'}
  return pairs[line:sub(at,at)]==line:sub(at+1,at+1) and '<BS><Del>' or '<BS>'
end,{expr=true,noremap=true})
for name,method in pairs({NimloWrite='save',NimloClose='close',NimloUndo='undo',NimloRedo='redo',NimloWriteClose='saveClose'}) do
  vim.api.nvim_create_user_command(name,function() action(method) end,{})
end
vim.api.nvim_create_user_command('NimloEdit',function(opts) action('open',opts.args) end,{nargs=1,complete='file'})
for from,to in pairs({w='NimloWrite',write='NimloWrite',q='NimloClose',quit='NimloClose',wq='NimloWriteClose',undo='NimloUndo',redo='NimloRedo',e='NimloEdit',edit='NimloEdit'}) do
  vim.cmd(string.format([[cnoreabbrev <expr> %s getcmdtype() == ':' && getcmdline() == '%s' ? '%s' : '%s']],from,from,to,from))
end
function M.text()
  local lines=vim.api.nvim_buf_get_lines(M.buf,0,-1,true)
  return table.concat(lines,'\n') .. (vim.bo[M.buf].endofline and '\n' or '')
end
function M.bind(name,text,dirty,editable,reset)
  M.applying=true
  if name~=M.name and M.name and M.name~='' then
    if not M.views[M.name] then table.insert(M.view_order,M.name) end
    M.views[M.name]=vim.fn.winsaveview()
    while #M.view_order>32 do M.views[table.remove(M.view_order,1)]=nil end
  end
  M.name=name
  if vim.api.nvim_get_current_buf()~=M.buf then vim.api.nvim_set_current_buf(M.buf) end
  local cursor=vim.api.nvim_win_get_cursor(0)
  M.active=name~=''; M.editable=editable
  -- Host snapshots can update a read-only view; restore its permissions below.
  vim.bo[M.buf].readonly=false
  vim.bo[M.buf].modifiable=true
  local replacing=M.text()~=text
  if reset or replacing then M.all=false;normal() end
  if replacing then
    local lines=vim.split(text,'\n',{plain=true}); local eol=text:sub(-1)=='\n'
    if eol then table.remove(lines) end
    if #lines==0 then lines={''} end
    vim.api.nvim_buf_set_lines(M.buf,0,-1,true,lines)
    vim.bo[M.buf].endofline=eol
  end
  if name~='' then pcall(vim.api.nvim_buf_set_name,M.buf,name) end
  if reset then
    local ft=vim.filetype.match({filename=name,buf=M.buf}); if ft then vim.bo[M.buf].filetype=ft end
    local tabs,spaces=0,{}
    for line in text:gmatch('[^\n]+') do
      if line:match('^\t') then tabs=tabs+1 end
      local leading=line:match('^( +)%S'); if leading and #leading<=8 then spaces[#leading]=(spaces[#leading] or 0)+1 end
    end
    vim.bo[M.buf].expandtab=tabs==0
    vim.bo[M.buf].shiftwidth=spaces[4] and not spaces[2] and 4 or 2
    vim.bo[M.buf].tabstop=vim.bo[M.buf].shiftwidth
    vim.bo[M.buf].softtabstop=vim.bo[M.buf].shiftwidth
    cursor={1,0}
  end
  -- Acknowledging unchanged text must not reset an insert-mode cursor or
  -- re-enter Insert. In particular, a column beyond the last character can be
  -- clamped by win_set_cursor while a long-line key sequence is in progress.
  if reset or replacing then
    local count=vim.api.nvim_buf_line_count(M.buf);cursor[1]=math.max(1,math.min(count,cursor[1]))
    cursor[2]=math.min(cursor[2],#(vim.api.nvim_buf_get_lines(M.buf,cursor[1]-1,cursor[1],true)[1] or ''))
    pcall(vim.api.nvim_win_set_cursor,0,cursor)
    if reset and M.views[name] then pcall(vim.fn.winrestview,M.views[name]) end
  end
  vim.bo[M.buf].modified=dirty
  vim.bo[M.buf].readonly=not editable
  vim.bo[M.buf].modifiable=editable
  M.applying=false
  if not M.vim and editable and (reset or replacing) then
    if reset and M.views[name] then local v=M.views[name];insert_at({v.lnum,v.col}) else insert_at(cursor) end
  end
  return true
end
function M.mode(enabled)
  local cursor=vim.api.nvim_win_get_cursor(0)
  M.vim=enabled;M.all=false
  normal()
  configure_mode()
  if not enabled and M.editable then insert_at(cursor) end
end
local function empty_selection()
  if not M.vim and vim.fn.mode()=='s' then
    local anchor=vim.fn.getpos('v');local cursor=vim.api.nvim_win_get_cursor(0)
    return anchor[2]==cursor[1] and anchor[3]-1==cursor[2]
  end
  return false
end
vim.api.nvim_create_autocmd('CursorMoved',{callback=function()
  if empty_selection() then
    vim.schedule(function() if M.editable and empty_selection() then M.mode(false) end end)
  end
end})
function M.type(text)
  if not M.editable then return false end
  if not M.vim and M.all then M.replace_all(text); return true end
  M.all=false
  local mode=vim.api.nvim_get_mode().mode
  local keys=text:gsub('<','<lt>')
  if not M.vim then
    if mode:match('^[vV\22]') then keys='c'..keys
    elseif mode:sub(1,1)=='n' then keys='i'..keys end
  end
  return vim.api.nvim_input(keys)
end
function M.find(query,backward)
  M.all=false;normal()
  if query~='' then vim.fn.setreg('/','\\V'..query:gsub('\\','\\\\')) end
  vim.o.hlsearch=true
  local found=vim.fn.search(vim.fn.getreg('/'),backward and 'bw' or 'w')
  return {line=found,count=vim.fn.searchcount({recompute=1,maxcount=10000,timeout=50})}
end
function M.goto_line(line)
  M.all=false;normal()
  line=math.max(1,math.min(vim.api.nvim_buf_line_count(M.buf),line))
  vim.api.nvim_win_set_cursor(0,{line,0});vim.cmd('normal! zz')
  if not M.vim and M.editable then insert_at({line,0}) end
end
function M.replace_all(text)
  M.all=false
  normal()
  local lines=vim.split(text,'\n',{plain=true});local eol=text:sub(-1)=='\n'
  if eol then table.remove(lines) end
  if #lines==0 then lines={''} end
  vim.api.nvim_buf_set_lines(M.buf,0,-1,true,lines);vim.bo[M.buf].endofline=eol
  local last=vim.api.nvim_buf_line_count(M.buf)
  vim.api.nvim_win_set_cursor(0,{last,#lines[last]})
  if not M.vim then insert_at({last,#lines[last]}) end
  changed()
end
function M.key(keys)
  if not M.vim and M.all and (keys=='<BS>' or keys=='<Del>') then M.replace_all('');return true end
  if not M.vim and keys=='<Esc>' then M.mode(false);return true end
  if not M.vim then
    if M.all and (keys=='<Left>' or keys=='<Right>') then
      local last=vim.api.nvim_buf_line_count(M.buf)
      local finish={last,#(vim.api.nvim_buf_get_lines(M.buf,last-1,last,true)[1] or '')}
      M.all=false;normal();insert_at(keys=='<Left>' and {1,0} or finish);return true
    end
    -- In Select mode Neovim's Control-Home can retain the desired column.
    -- macOS document selection includes the complete first/last line.
    if keys=='<S-C-Home>' or keys=='<C-S-Home>' then keys='<C-S-Home><S-Home>' end
    if keys=='<S-C-End>' or keys=='<C-S-End>' then keys='<C-S-End><S-End>' end
    local mode=vim.fn.mode()
    if mode:match(selection_pattern) and (keys=='<Left>' or keys=='<Right>') then
      -- An unshifted horizontal arrow collapses to the selection's edge.
      local anchor=vim.fn.getpos('v');local cursor=vim.api.nvim_win_get_cursor(0)
      local start={anchor[2],anchor[3]-1};local finish={cursor[1],cursor[2]}
      if start[1]>finish[1] or (start[1]==finish[1] and start[2]>finish[2]) then start,finish=finish,start end
      M.all=false;normal();insert_at(keys=='<Left>' and start or finish);return true
    end
    if mode:sub(1,1)=='n' and M.editable then keys='i'..keys end
  end
  M.all=false
  return vim.api.nvim_input(keys)
end
function M.paste(text)
  if not M.vim and M.all then M.replace_all(text);return true end
  M.all=false
  if not M.vim and vim.fn.mode():sub(1,1)=='n' then
    -- A Select-mode action may return to Normal internally. Edit's caret
    -- still denotes an insertion point, including past the last character.
    local cursor=vim.api.nvim_win_get_cursor(0)
    local lines=vim.split(text:gsub('\r\n','\n'):gsub('\r','\n'),'\n',{plain=true})
    vim.api.nvim_buf_set_text(M.buf,cursor[1]-1,cursor[2],cursor[1]-1,cursor[2],lines)
    insert_at({cursor[1]+#lines-1,(#lines==1 and cursor[2] or 0)+#lines[#lines]})
    return true
  end
  local selected=vim.fn.mode():match(selection_pattern)
  local result=vim.api.nvim_paste(text,true,-1)
  if not M.vim and selected then
    local cursor=vim.api.nvim_win_get_cursor(0)
    if text~='' and not text:match('[\r\n]$') then
      cursor[2]=math.max(cursor[2],vim.fn.matchend(vim.api.nvim_get_current_line(),'.',cursor[2]))
    end
    insert_at(cursor)
  end
  return result
end
function M.select_all()
  normal();vim.cmd('normal! ggVG');M.all=true
end
function M.copy(cut)
  if M.all then
    vim.rpcnotify(channel,'nimlo_clipboard',vim.split(M.text(),'\n',{plain=true}))
    if cut then M.replace_all('') end
  elseif vim.fn.mode():match(selection_pattern) then
    local select=vim.fn.mode():match(select_pattern)
    local toggle=vim.api.nvim_replace_termcodes('<C-g>',true,false,true)
    local anchor=vim.fn.getpos('v');local cursor=vim.api.nvim_win_get_cursor(0)
    local start={anchor[2],anchor[3]-1}
    if cursor[1]<start[1] or (cursor[1]==start[1] and cursor[2]<start[2]) then start=cursor end
    if select then vim.cmd('normal! '..toggle) end
    vim.cmd(cut and 'normal! "+d' or 'normal! "+y')
    if not M.vim then
      if cut then insert_at(start) else vim.cmd('normal! gv'..(select and toggle or '')) end
    end
  end
end
return true
