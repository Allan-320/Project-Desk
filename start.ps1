# Written as UTF-8 with BOM in the distribution for Windows PowerShell 5.1.
param([switch]$NoOpen,[switch]$ChooseFolder,[switch]$Empty,[string]$Folder)
$ErrorActionPreference='Stop'
$deskBase=$PSScriptRoot
$deskSettingsPath=Join-Path $deskBase 'settings.json'
$deskData=Join-Path $deskBase 'data'
$deskLock=$null
$deskLockHeld=$false
function Get-DeskService($Settings){
 if(-not $Settings){return $null}
 $markerPath=Join-Path $deskData 'service.json'
 if(-not(Test-Path -LiteralPath $markerPath)){return $null}
 try{
  $marker=Get-Content -LiteralPath $markerPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if($marker.url -notmatch '^http://127\.0\.0\.1:[0-9]+/$'){return $null}
  $null=Invoke-WebRequest -Uri $marker.url -UseBasicParsing -TimeoutSec 2 -SessionVariable deskWebSession
  $identity=Invoke-RestMethod -Uri ($marker.url+'api/identity') -WebSession $deskWebSession -TimeoutSec 2
  if($identity.instanceId -eq $Settings.installationId -and $identity.workspaceId -eq $Settings.activeWorkspace){return $marker}
 }catch{}
 return $null
}
function Select-DeskFolder {
 $deskSelectionPath=Join-Path $deskData ('folder-selection-'+[guid]::NewGuid().ToString()+'.tmp')
 $picker=New-Object System.Diagnostics.Process
 $picker.StartInfo.FileName=Join-Path $deskBase 'app\folder-picker.exe'
 $picker.StartInfo.Arguments='"'+$deskSelectionPath+'"'
 $picker.StartInfo.UseShellExecute=$false
 $picker.StartInfo.CreateNoWindow=$true
 try{
  [void]$picker.Start();$picker.WaitForExit()
  if($picker.ExitCode -ne 0 -or -not(Test-Path -LiteralPath $deskSelectionPath)){
   $deskPickerError=$deskSelectionPath+'.error.txt'
   if(Test-Path -LiteralPath $deskPickerError){Copy-Item -LiteralPath $deskPickerError -Destination (Join-Path $deskData 'folder-picker-error.log') -Force}
   throw '目录选择窗口未能打开，请查看 data\folder-picker-error.log。也可双击“直接建立空白工作区.cmd”继续。'
  }
  return [IO.File]::ReadAllText($deskSelectionPath,[Text.Encoding]::UTF8).Trim()
 }finally{
  $picker.Dispose()
  if(Test-Path -LiteralPath $deskSelectionPath){Remove-Item -LiteralPath $deskSelectionPath -Force}
  if(Test-Path -LiteralPath ($deskSelectionPath+'.error.txt')){Remove-Item -LiteralPath ($deskSelectionPath+'.error.txt') -Force}
 }
}

try{
 if(-not [Environment]::Is64BitOperatingSystem){throw '此分享版需要 64 位 Windows。'}
 New-Item -ItemType Directory -Path $deskData -Force | Out-Null
 $deskDigest=[System.Security.Cryptography.SHA256]::Create()
 try{$deskKey=[BitConverter]::ToString($deskDigest.ComputeHash([Text.Encoding]::UTF8.GetBytes($deskBase.ToLowerInvariant()))).Replace('-','')}finally{$deskDigest.Dispose()}
 $deskLock=New-Object System.Threading.Mutex($false,('Local\ProjectDeskPortable-'+$deskKey))
 try{$deskLockHeld=$deskLock.WaitOne(60000)}catch [System.Threading.AbandonedMutexException]{$deskLockHeld=$true}
 if(-not $deskLockHeld){throw '另一个启动窗口仍在运行，请稍后再试。'}
 $deskSettings=$null
 if(Test-Path -LiteralPath $deskSettingsPath){$deskSettings=Get-Content -LiteralPath $deskSettingsPath -Raw -Encoding UTF8 | ConvertFrom-Json}
 $deskLive=Get-DeskService $deskSettings
 if($deskLive -and ($ChooseFolder -or $Empty -or $Folder)){throw '请先在资料台右上角点击“停止运行”，再切换资料目录。'}
 if($deskLive){if(-not $NoOpen){Start-Process -FilePath $deskLive.url};Write-Host ('已打开：'+$deskLive.url);exit 0}
 $deskWorkspace=$null
 if($deskSettings){$deskWorkspace=@($deskSettings.workspaces | Where-Object {$_.id -eq $deskSettings.activeWorkspace}) | Select-Object -First 1}
 $deskRoot=$null
 if($deskWorkspace){$deskRoot=if($deskWorkspace.relative){Join-Path $deskBase $deskWorkspace.root}else{$deskWorkspace.root}}
 if($ChooseFolder -or $Empty -or $Folder -or -not $deskWorkspace -or -not(Test-Path -LiteralPath $deskRoot -PathType Container)){
  $deskSelected=if($Empty){'__EMPTY__'}elseif($Folder){$Folder}else{Select-DeskFolder}
  if(-not $deskSelected){Write-Host '已取消启动。';exit 0}
  $deskRelative=$deskSelected -eq '__EMPTY__'
  if($deskRelative){$deskRoot=Join-Path $deskBase '资料';New-Item -ItemType Directory -Path $deskRoot -Force | Out-Null}else{$deskRoot=$deskSelected}
  $deskRoot=(Resolve-Path -LiteralPath $deskRoot).ProviderPath.TrimEnd('\')
  if(-not(Test-Path -LiteralPath $deskRoot -PathType Container)){throw '请选择有效文件夹。'}
  if($deskBase -eq $deskRoot -or $deskBase.StartsWith($deskRoot+'\',[StringComparison]::OrdinalIgnoreCase)){throw '请选具体的资料文件夹，不能选择包含本程序的上级目录或整盘。'}
  if(-not $deskRelative -and $deskRoot.StartsWith($deskBase+'\',[StringComparison]::OrdinalIgnoreCase)){throw '请在程序文件夹外选择资料；或使用“先建空白计划”里的独立资料目录。'}
  if(-not $deskSettings){$deskSettings=[pscustomobject]@{version=1;installationId=[guid]::NewGuid().ToString();activeWorkspace='';workspaces=@()}}
  $deskStoredRoot=if($deskRelative){'资料'}else{$deskRoot}
  $deskWorkspace=@($deskSettings.workspaces | Where-Object {$_.root -eq $deskStoredRoot -and $_.relative -eq $deskRelative}) | Select-Object -First 1
  if(-not $deskWorkspace){$deskWorkspace=[pscustomobject]@{id=[guid]::NewGuid().ToString();root=$deskStoredRoot;relative=$deskRelative};$deskSettings.workspaces=@($deskSettings.workspaces)+@($deskWorkspace)}
  $deskSettings.activeWorkspace=$deskWorkspace.id
  $deskTemporary=$deskSettingsPath+'.'+[guid]::NewGuid().ToString()+'.tmp'
  [IO.File]::WriteAllText($deskTemporary,($deskSettings | ConvertTo-Json -Depth 6),(New-Object Text.UTF8Encoding($false)))
  Move-Item -LiteralPath $deskTemporary -Destination $deskSettingsPath -Force
 }
 $deskNode=Join-Path $deskBase 'runtime\node\node.exe';$deskPython=Join-Path $deskBase 'runtime\python\python.exe'
 if(-not(Test-Path -LiteralPath $deskNode) -or -not(Test-Path -LiteralPath $deskPython)){throw '运行环境不完整，请先把整个压缩包解压到可写文件夹，再双击启动。'}
 $deskEntry=Join-Path $deskBase 'app\portable-runner.cjs'
 $deskChild=Start-Process -FilePath $deskNode -ArgumentList @(('"'+$deskEntry+'"')) -WorkingDirectory $deskBase -WindowStyle Hidden -RedirectStandardOutput (Join-Path $deskData 'server.log') -RedirectStandardError (Join-Path $deskData 'server-error.log') -PassThru
 $deskDeadline=[DateTime]::UtcNow.AddSeconds(60)
 do{
  Start-Sleep -Milliseconds 400
  $deskLive=Get-DeskService $deskSettings
  if($deskLive){break}
  $deskChild.Refresh()
  if($deskChild.HasExited){$deskDetail=Get-Content -LiteralPath (Join-Path $deskData 'server-error.log') -Tail 5 -ErrorAction SilentlyContinue;throw ('启动失败：'+($deskDetail -join [Environment]::NewLine))}
 }while([DateTime]::UtcNow -lt $deskDeadline)
 if(-not $deskLive){throw '资料目录仍在扫描或启动超时。请查看 data\server-error.log；稍后可再次双击启动。'}
 if(-not $NoOpen){Start-Process -FilePath $deskLive.url}
 Write-Host ('已启动：'+$deskLive.url)
}catch{Write-Host $_.Exception.Message -ForegroundColor Red;exit 1}
finally{if($deskLockHeld -and $deskLock){$deskLock.ReleaseMutex()};if($deskLock){$deskLock.Dispose()}}
