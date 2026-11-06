param([string]$Action, [string]$A1, [string]$A2, [string]$A3, [string]$A4, [string]$A5)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
if (-not ('N' -as [type])) {
  Add-Type @"
using System;
using System.Runtime.InteropServices;
public class N {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, int dx, int dy, uint d, IntPtr e);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h, int x, int y, int w, int ht, bool r);
  [DllImport("user32.dll")] public static extern void keybd_event(byte k, byte s, uint f, IntPtr e);
}
"@
}
[N]::SetProcessDPIAware() | Out-Null
# Always resolve the HWND fresh: Chrome windows come and go, stale handles blow up later.
# Prefer the Playwright-launched Chrome (its command line carries --remote-debugging-pipe),
# otherwise a user-opened Chrome window would receive the synthetic mouse and the drag lands nowhere.
function Resolve-Hwnd {
  for ($i = 0; $i -lt 25; $i++) {
    $autoPids = @()
    try {
      $autoPids = @(Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -like '*--remote-debugging-pipe*' } |
        ForEach-Object { $_.ProcessId })
    } catch {}
    $list = @(Get-Process chrome -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 })
    if ($autoPids.Count -gt 0) {
      $auto = @($list | Where-Object { $autoPids -contains $_.Id })
      if ($auto.Count -gt 0) { $list = $auto }
    }
    if ($list.Count -gt 0) {
      $hit = $list | Where-Object { $_.MainWindowTitle -match 'xuexi|Chrome' } | Select-Object -First 1
      if (-not $hit) { $hit = $list[0] }
      $h = $hit.MainWindowHandle
      if ($h -and $h -ne [IntPtr]::Zero -and [N]::IsWindow($h)) { return $h }
    }
    Start-Sleep -Milliseconds 700
  }
  throw 'no chrome window'
}
function Focus-Win($h) {
  if (-not $h -or $h -eq [IntPtr]::Zero -or -not [N]::IsWindow($h)) { throw 'bad window handle' }
  [N]::ShowWindow($h, 9) | Out-Null
  [N]::SetForegroundWindow($h) | Out-Null
  Start-Sleep -Milliseconds 250
}
function Send-Key([byte]$vk, [bool]$up) {
  if ($up) { [N]::keybd_event($vk, 0, 0x0002, [IntPtr]::Zero) } else { [N]::keybd_event($vk, 0, 0, [IntPtr]::Zero) }
  Start-Sleep -Milliseconds 45
}
function Tap([byte]$vk) { Send-Key $vk $false; Send-Key $vk $true }
function Ctrl([byte]$vk) { Send-Key 0x11 $false; Tap $vk; Send-Key 0x11 $true }
function Set-Clip([string]$text) {
  # Set-Clipboard  ExternalException
  for ($i = 0; $i -lt 8; $i++) {
    try { Set-Clipboard -Value $text; return } catch { Start-Sleep -Milliseconds 120 }
  }
  for ($i = 0; $i -lt 8; $i++) {
    try { [System.Windows.Forms.Clipboard]::SetText($text); return } catch { Start-Sleep -Milliseconds 120 }
  }
  throw 'clipboard busy'
}
function Paste-Text([string]$text) {
  Set-Clip $text
  Ctrl 0x56
  Start-Sleep -Milliseconds 260
}

$needWin = $Action -notin @('key', 'killplain', 'list', 'type', 'esc')
$hwnd = $null
if ($needWin) { $hwnd = Resolve-Hwnd }

switch ($Action) {
  'list' { Get-Process chrome -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | ForEach-Object { "$($_.Id) $($_.MainWindowTitle)" } }
  'title' { (Get-Process -Id (Get-Process chrome | Where-Object { $_.MainWindowHandle -eq $hwnd }).Id -ErrorAction SilentlyContinue).MainWindowTitle }
  'focus' { Focus-Win $hwnd; 'ok' }
  'move' {
    Focus-Win $hwnd
    [N]::MoveWindow($hwnd, [int]$A1, [int]$A2, [int]$A3, [int]$A4, $true) | Out-Null
    Start-Sleep -Milliseconds 400
    'ok'
  }
  'click' {
    Focus-Win $hwnd
    [N]::SetCursorPos([int]$A1, [int]$A2) | Out-Null
    Start-Sleep -Milliseconds 90
    [N]::mouse_event(0x0002, 0, 0, 0, [IntPtr]::Zero)
    Start-Sleep -Milliseconds 60
    [N]::mouse_event(0x0004, 0, 0, 0, [IntPtr]::Zero)
    'ok'
  }
  'drag' {
    Focus-Win $hwnd
    $x1 = [int]$A1; $y1 = [int]$A2; $x2 = [int]$A3; $y2 = [int]$A4; $steps = [int]$A5
    [N]::SetCursorPos($x1, $y1) | Out-Null
    Start-Sleep -Milliseconds 130
    [N]::mouse_event(0x0002, 0, 0, 0, [IntPtr]::Zero)
    Start-Sleep -Milliseconds 70
    for ($i = 1; $i -le $steps; $i++) {
      $t = $i / $steps
      [N]::SetCursorPos([int]($x1 + ($x2 - $x1) * $t), [int]($y1 + ($y2 - $y1) * $t)) | Out-Null
      Start-Sleep -Milliseconds 26
    }
    Start-Sleep -Milliseconds 90
    [N]::mouse_event(0x0004, 0, 0, 0, [IntPtr]::Zero)
    'ok'
  }
  # Build a javascript: URL in the omnibox. Paste in three pieces to dodge Chrome
  # stripping the scheme and the IME turning ':' into a full-width colon.
  'paste' {
    Focus-Win $hwnd
    Ctrl 0x4C
    Ctrl 0x41
    Paste-Text $A1
    Tap 0x24
    Paste-Text ':'
    Tap 0x24
    Paste-Text 'javascript'
    Tap 0x24
    Start-Sleep -Milliseconds 200
    Tap 0x0D
    'ok'
  }
  'nav' {
    Focus-Win $hwnd
    Ctrl 0x4C
    Ctrl 0x41
    Paste-Text $A1
    Start-Sleep -Milliseconds 200
    Tap 0x0D
    'ok'
  }
  'type' {
    Focus-Win $hwnd
    Ctrl 0x41
    Paste-Text $A1
    Start-Sleep -Milliseconds 150
    'ok'
  }
  'esc' { Focus-Win $hwnd; Tap 0x1B; 'ok' }
  'enter' { Focus-Win $hwnd; Tap 0x0D; 'ok' }
  'key' {
    Add-Type -AssemblyName System.Security
    $ls = Get-Content (Join-Path $A1 'Local State') -Raw | ConvertFrom-Json
    $enc = [Convert]::FromBase64String($ls.os_crypt.encrypted_key)
    $raw = $enc[5..($enc.Length - 1)]
    $k = [Security.Cryptography.ProtectedData]::Unprotect($raw, $null, 'CurrentUser')
    [Convert]::ToBase64String($k)
  }
  'killplain' {
    $n = 0
    Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -like '*\data\plain\*' } | ForEach-Object {
      Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
      $n++
    }
    Start-Sleep -Milliseconds 900
    "killed $n"
  }
  'close' {
    Get-Process chrome -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | ForEach-Object { $_.CloseMainWindow() | Out-Null }
    'ok'
  }
  default { throw "unknown action $Action" }
}
