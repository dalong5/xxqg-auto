param([switch]$Stop)
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path $PSScriptRoot -Parent
$taskNode = (Get-Command node).Source
$taskStartup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 }

foreach ($taskEntry in @('src/server.js', 'src/worker.js')) {
  $taskPath = (Resolve-Path (Join-Path $taskRoot $taskEntry)).Path
  $taskQuotedPath = '"' + $taskPath + '"'
  $taskExisting = @(Get-CimInstance Win32_Process -Filter "name='node.exe'" | Where-Object {
    $_.ExecutablePath -eq $taskNode -and $_.CommandLine -and $_.CommandLine.Contains($taskQuotedPath)
  })
  if ($Stop) {
    foreach ($taskProcess in $taskExisting) {
      Stop-Process -Id $taskProcess.ProcessId
      [pscustomobject]@{ Entry = $taskEntry; Id = $taskProcess.ProcessId; Status = 'stopped' }
    }
  } elseif ($taskExisting.Count) {
    foreach ($taskProcess in $taskExisting) {
      [pscustomobject]@{ Entry = $taskEntry; Id = $taskProcess.ProcessId; Status = 'already-running' }
    }
  } else {
    $taskResult = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
      CommandLine = '"' + $taskNode + '" ' + $taskQuotedPath
      CurrentDirectory = $taskRoot
      ProcessStartupInformation = $taskStartup
    }
    if ($taskResult.ReturnValue -ne 0) { throw "Could not start $taskEntry (code $($taskResult.ReturnValue))" }
    [pscustomobject]@{ Entry = $taskEntry; Id = $taskResult.ProcessId; Status = 'started' }
  }
}
