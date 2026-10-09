param([ValidateSet('Dev', 'Update')][string]$Mode = 'Dev')
$ErrorActionPreference = 'Stop'
try {
    $repository = Split-Path -Parent $PSScriptRoot
    $nodeExecutable = (Get-Command node.exe -ErrorAction Stop).Source
    $launcher = Join-Path $PSScriptRoot 'custom-desktop.mjs'
    Start-Process -FilePath $nodeExecutable -ArgumentList @(('"' + $launcher + '"'), $Mode.ToLowerInvariant()) -WorkingDirectory $repository -WindowStyle Hidden
} catch {
    Add-Type -AssemblyName PresentationFramework
    [System.Windows.MessageBox]::Show($_.Exception.Message, 'Maestro Custom', 'OK', 'Error') | Out-Null
    exit 1
}
