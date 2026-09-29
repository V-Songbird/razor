# Fallback of each commandWindows in hooks/codex-hooks.json, run when cmd finds
# no Node on PATH. Rebuild with node scripts/build-windows-launchers.js --write.
# EncodedCommand keeps this script intact whether cmd.exe or PowerShell runs
# the hook command; an inline -Command string loses its $ variables and quotes
# under a PowerShell parent. It changes no execution policy or hook trust.
# PATH is probed with where.exe rather than Get-Command: a lookup that misses
# makes Windows PowerShell consult its module analysis cache, which can take
# tens of seconds while that cache is cold. Progress records are silenced
# because Windows PowerShell writes them to a redirected stderr as CLIXML.
$ProgressPreference = 'SilentlyContinue'
where.exe /q '$PATH:node'
if ($LASTEXITCODE -ne 0) {
  where.exe /q '$PATH:fnm'
  if ($LASTEXITCODE -ne 0) { throw 'razor requires Node.js on PATH or a configured fnm default.' }
  fnm env --shell powershell | Out-String | Invoke-Expression
}
& node ($env:PLUGIN_ROOT + '/hooks/codex-hook.js') __RAZOR_EVENT__
exit $LASTEXITCODE
