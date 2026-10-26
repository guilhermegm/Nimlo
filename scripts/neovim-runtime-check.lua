-- Real-engine regression: host snapshots must not warn about read-only writes,
-- and applying a snapshot must restore the host's editing permissions.
local ok, err = pcall(function()
  assert(loadfile('runtime/nimlo.lua'))(0)
  local function messages()
    return vim.api.nvim_exec2('messages', {output=true}).output
  end
  _G.nimlo.bind('example.js', 'const value = 1;\n', false, false, true)
  assert(vim.bo.readonly and not vim.bo.modifiable, 'read-only host permissions')
  vim.cmd('messages clear')
  _G.nimlo.bind('example.js', 'const value = 2;\n', false, true, false)
  assert(_G.nimlo.text() == 'const value = 2;\n', 'host snapshot text')
  assert(not vim.bo.readonly and vim.bo.modifiable, 'editable host permissions')
  assert(not messages():find('W10:', 1, true), 'snapshot raised a read-only warning')
  _G.nimlo.bind('example.js', 'const value = 3;\n', false, false, false)
  assert(vim.bo.readonly and not vim.bo.modifiable, 'permissions restored after snapshot')
  assert(not messages():find('W10:', 1, true), 'read-only snapshot raised a warning')
end)
if not ok then
  io.stderr:write(tostring(err) .. '\n')
  vim.cmd('cquit 1')
else
  print('Neovim snapshot text and read-only permissions passed')
  vim.cmd('qa!')
end
