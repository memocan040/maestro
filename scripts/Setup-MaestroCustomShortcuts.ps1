$ErrorActionPreference = 'Stop'
$repository = Split-Path -Parent $PSScriptRoot
$launcher = Join-Path $PSScriptRoot 'Start-MaestroCustom.ps1'
$shortcutShell = New-Object -ComObject WScript.Shell
$shortcutLocations = @([Environment]::GetFolderPath('Desktop'), (Join-Path ([Environment]::GetFolderPath('StartMenu')) 'Programs'))
foreach ($location in $shortcutLocations) {
    foreach ($mode in @('Dev', 'Update')) {
        $name = if ($mode -eq 'Dev') { 'Maestro Custom - Dev' } else { 'Maestro Custom - Update' }
        $shortcut = $shortcutShell.CreateShortcut((Join-Path $location ($name + '.lnk')))
        $shortcut.TargetPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
        $shortcut.Arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $launcher + '" -Mode ' + $mode
        $shortcut.WorkingDirectory = $repository
        $shortcut.IconLocation = (Join-Path $repository 'src-tauri\icons\icon.ico')
        $shortcut.Description = if ($mode -eq 'Dev') { 'Maestro Custom mit Vite HMR, Rust-Watcher und geschütztem Daemon-Neustart' } else { 'Release bauen und erst nach Bestätigung installieren' }
        $shortcut.Save()
        Write-Output (Join-Path $location ($name + '.lnk'))
    }
}
