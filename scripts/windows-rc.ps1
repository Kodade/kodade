param(
    [Parameter(Mandatory = $true)]
    [string] $InstallerPath,

    [Parameter(Mandatory = $true)]
    [string] $Version
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$userUninstallKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\kodade"
$machineUninstallKey = "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\kodade"
$appDataDirectory = Join-Path $env:APPDATA "com.kodade.desktop"
$runToken = if ($env:GITHUB_RUN_ID) { $env:GITHUB_RUN_ID } else { [guid]::NewGuid().ToString("N") }
$projectDirectory = Join-Path $env:TEMP "Kodade RC Project Ω $runToken"
$storagePath = Join-Path $appDataDirectory "kodade.json"
$sentinelPath = Join-Path $appDataDirectory "windows-rc-sentinel.txt"
$app = $null
$fallbackInstallDirectory = Join-Path $env:LOCALAPPDATA "kodade"
$fallbackUninstaller = Join-Path $fallbackInstallDirectory "uninstall.exe"
$uninstaller = $fallbackUninstaller
$tauriConfigPath = Join-Path (Split-Path $PSScriptRoot -Parent) "src-tauri\tauri.conf.json"
$expectedWindowTitle = (Get-Content -LiteralPath $tauriConfigPath -Raw | ConvertFrom-Json).app.windows[0].title
if (-not $expectedWindowTitle) {
    throw "The Tauri config does not define the primary window title"
}

Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class KodadeWindowProbe {
    public sealed class WindowInfo {
        public long Handle { get; set; }
        public long Owner { get; set; }
        public uint ThreadId { get; set; }
        public bool Visible { get; set; }
        public string Title { get; set; }
        public string ClassName { get; set; }
    }

    private delegate bool EnumWindowsProc(IntPtr window, IntPtr state);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr state);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr window, StringBuilder text, int capacity);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassName(IntPtr window, StringBuilder text, int capacity);

    [DllImport("user32.dll")]
    private static extern IntPtr GetWindow(IntPtr window, uint command);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr window);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SendMessageTimeout(
        IntPtr window,
        uint message,
        IntPtr wParam,
        IntPtr lParam,
        uint flags,
        uint timeout,
        out IntPtr result
    );

    public static bool IsResponsive(long handle, uint timeout) {
        IntPtr result;
        return SendMessageTimeout(
            new IntPtr(handle), 0x0000, IntPtr.Zero, IntPtr.Zero, 0x0002, timeout, out result
        ) != IntPtr.Zero;
    }

    public static bool Close(long handle, uint timeout) {
        IntPtr result;
        return SendMessageTimeout(
            new IntPtr(handle), 0x0010, IntPtr.Zero, IntPtr.Zero, 0x0002, timeout, out result
        ) != IntPtr.Zero;
    }

    public static WindowInfo[] ForProcess(uint processId) {
        var windows = new List<WindowInfo>();
        EnumWindows((window, _) => {
            uint ownerProcessId;
            uint threadId = GetWindowThreadProcessId(window, out ownerProcessId);
            if (ownerProcessId == processId) {
                var title = new StringBuilder(1024);
                var className = new StringBuilder(256);
                GetWindowText(window, title, title.Capacity);
                GetClassName(window, className, className.Capacity);
                windows.Add(new WindowInfo {
                    Handle = window.ToInt64(),
                    Owner = GetWindow(window, 4).ToInt64(),
                    ThreadId = threadId,
                    Visible = IsWindowVisible(window),
                    Title = title.ToString(),
                    ClassName = className.ToString()
                });
            }
            return true;
        }, IntPtr.Zero);
        return windows.ToArray();
    }
}
"@

function Invoke-SilentProcess {
    param(
        [Parameter(Mandatory = $true)] [string] $FilePath,
        [string[]] $ArgumentList = @()
    )
    $process = Start-Process -FilePath $FilePath -ArgumentList $ArgumentList -Wait -PassThru
    if ($process.ExitCode -ne 0) {
        throw "$FilePath failed with exit code $($process.ExitCode)"
    }
}

function Read-SharedText {
    param([Parameter(Mandatory = $true)] [string] $Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return ""
    }
    $stream = [System.IO.File]::Open(
        $Path,
        [System.IO.FileMode]::Open,
        [System.IO.FileAccess]::Read,
        [System.IO.FileShare]::ReadWrite
    )
    try {
        $reader = [System.IO.StreamReader]::new($stream)
        try {
            return $reader.ReadToEnd()
        }
        finally {
            $reader.Dispose()
        }
    }
    finally {
        $stream.Dispose()
    }
}

function Get-ProcessSnapshot {
    return @(Get-CimInstance Win32_Process | Where-Object { $_.CreationDate } | ForEach-Object {
        [pscustomobject]@{
            Id = [long] $_.ProcessId
            ParentId = [long] $_.ParentProcessId
            CreatedTicks = [long] $_.CreationDate.ToUniversalTime().Ticks
            Name = [string] $_.Name
            ExecutablePath = [string] $_.ExecutablePath
            CommandLine = [string] $_.CommandLine
        }
    })
}

function Get-ProcessIdentityKey {
    param([Parameter(Mandatory = $true)] $ProcessRecord)
    return "$($ProcessRecord.Id):$($ProcessRecord.CreatedTicks)"
}

function Get-ManagedLoginShell {
    param(
        [Parameter(Mandatory = $true)] [string] $StdoutPath,
        [Parameter(Mandatory = $true)] [object[]] $Snapshot,
        [Parameter(Mandatory = $true)] [long] $AppCreationFileTime
    )

    $records = [regex]::Matches(
        (Read-SharedText -Path $StdoutPath),
        '(?m)^kodade: managed login shell name=(?<shell>pwsh|powershell|cmd) pid=(?<pid>\d+) creation_filetime=(?<creation>\d+)\r?$'
    )
    foreach ($match in $records) {
        $shellName = $match.Groups['shell'].Value
        $shellPid = [long] $match.Groups['pid'].Value
        $creationFileTime = [long] $match.Groups['creation'].Value
        $expectedProcessName = "$shellName.exe"
        $processRecord = @($Snapshot | Where-Object {
            $_.Id -eq $shellPid -and
            $_.Name -ieq $expectedProcessName
        } | Select-Object -First 1)
        if ($processRecord.Count -ne 1 -or
            -not $processRecord[0].ExecutablePath -or
            -not $processRecord[0].CommandLine) {
            continue
        }

        # CIM timestamps are DMTF values with microsecond precision, while the
        # marker carries the raw 100-nanosecond FILETIME retained by Kodade.
        # Resolve the live process so PID reuse cannot satisfy this check.
        $identityMatches = $false
        $liveShellProcess = $null
        try {
            $liveShellProcess = [System.Diagnostics.Process]::GetProcessById([int] $shellPid)
            $liveShellProcess.Refresh()
            if (-not $liveShellProcess.HasExited) {
                $liveCreationFileTime = [long] $liveShellProcess.StartTime.ToUniversalTime().ToFileTimeUtc()
                $identityMatches = (
                    $liveCreationFileTime -eq $creationFileTime -and
                    $liveCreationFileTime -ge $AppCreationFileTime
                )
            }
        }
        catch {
            $identityMatches = $false
        }
        finally {
            if ($null -ne $liveShellProcess) {
                $liveShellProcess.Dispose()
            }
        }
        if (-not $identityMatches) {
            continue
        }

        $executablePath = $processRecord[0].ExecutablePath
        if ([System.IO.Path]::GetFileName($executablePath) -ine $expectedProcessName) {
            continue
        }
        $commandLine = $processRecord[0].CommandLine.Trim()
        $quotedExecutable = '"' + $executablePath + '"'
        $expectedCommandLines = if ($shellName -ieq 'cmd') {
            @($executablePath, $quotedExecutable)
        }
        else {
            @("$executablePath -NoLogo", "$quotedExecutable -NoLogo")
        }
        if ($expectedCommandLines -icontains $commandLine) {
            return $processRecord[0]
        }
    }
    return $null
}

function Add-TrackedDescendants {
    param(
        [Parameter(Mandatory = $true)]
        [System.Collections.Generic.Dictionary[string, object]] $Tracked,
        [Parameter(Mandatory = $true)]
        [object[]] $Snapshot
    )

    $currentById = [System.Collections.Generic.Dictionary[long, object]]::new()
    foreach ($record in $Snapshot) {
        $currentById[$record.Id] = $record
    }

    do {
        $added = $false
        foreach ($record in $Snapshot) {
            if (-not $currentById.ContainsKey($record.ParentId)) {
                continue
            }
            $parentKey = Get-ProcessIdentityKey -ProcessRecord $currentById[$record.ParentId]
            if (-not $Tracked.ContainsKey($parentKey)) {
                continue
            }
            $key = Get-ProcessIdentityKey -ProcessRecord $record
            if (-not $Tracked.ContainsKey($key)) {
                $Tracked.Add($key, $record)
                $added = $true
            }
        }
    } while ($added)
}

function New-TrackedProcessTree {
    param([Parameter(Mandatory = $true)] [long] $RootId)

    $snapshot = @(Get-ProcessSnapshot)
    $root = @($snapshot | Where-Object { $_.Id -eq $RootId } | Select-Object -First 1)
    if ($root.Count -ne 1) {
        throw "Could not record the installed Kodade process identity"
    }
    $tracked = [System.Collections.Generic.Dictionary[string, object]]::new()
    $tracked.Add((Get-ProcessIdentityKey -ProcessRecord $root[0]), $root[0])
    Add-TrackedDescendants -Tracked $tracked -Snapshot $snapshot
    return ,$tracked
}

function Assert-TrackedProcessTreeExited {
    param(
        [Parameter(Mandatory = $true)]
        [System.Collections.Generic.Dictionary[string, object]] $Tracked
    )

    $stableEmptyPasses = 0
    for ($attempt = 0; $attempt -lt 60; $attempt++) {
        $snapshot = @(Get-ProcessSnapshot)
        Add-TrackedDescendants -Tracked $Tracked -Snapshot $snapshot
        $currentKeys = [System.Collections.Generic.HashSet[string]]::new()
        foreach ($record in $snapshot) {
            [void] $currentKeys.Add((Get-ProcessIdentityKey -ProcessRecord $record))
        }
        $remaining = @($Tracked.Keys | Where-Object { $currentKeys.Contains($_) })
        if ($remaining.Count -eq 0) {
            $stableEmptyPasses++
            if ($stableEmptyPasses -ge 2) {
                return
            }
        }
        else {
            $stableEmptyPasses = 0
        }
        Start-Sleep -Milliseconds 250
    }
    $remaining = @($Tracked.Values | ForEach-Object {
        $record = $_
        $current = @(Get-ProcessSnapshot | Where-Object {
            $_.Id -eq $record.Id -and $_.CreatedTicks -eq $record.CreatedTicks
        })
        if ($current.Count -gt 0) { "$($record.Name) $($record.Id)@$($record.CreatedTicks)" }
    })
    throw "Kodade launch left identity-matched processes running: $($remaining -join ', ')"
}

function Invoke-LaunchAndGracefulQuit {
    param([Parameter(Mandatory = $true)] [string] $AppPath)

    $stdoutPath = Join-Path $env:TEMP "kodade-rc-$([guid]::NewGuid().ToString('N')).stdout.log"
    $stderrPath = Join-Path $env:TEMP "kodade-rc-$([guid]::NewGuid().ToString('N')).stderr.log"
    $process = Start-Process `
        -FilePath $AppPath `
        -RedirectStandardOutput $stdoutPath `
        -RedirectStandardError $stderrPath `
        -PassThru
    try {
        for ($attempt = 0; $attempt -lt 40; $attempt++) {
            Start-Sleep -Milliseconds 250
            $process.Refresh()
            if ($process.HasExited) {
                throw "Installed kodade.exe exited during WebView2 startup (code $($process.ExitCode))"
            }
            if ($process.MainWindowHandle -ne 0) {
                break
            }
        }
        if ($process.MainWindowHandle -eq 0) {
            throw "Installed kodade.exe did not create a main window"
        }

        $tracked = New-TrackedProcessTree -RootId $process.Id
        try {
            $process.Refresh()
            if ($process.HasExited) {
                throw "Installed kodade.exe exited before its process identity was recorded"
            }
            $appCreationFileTime = [long] $process.StartTime.ToUniversalTime().ToFileTimeUtc()
        }
        catch {
            throw "Could not record the exact installed Kodade process identity: $($_.Exception.Message)"
        }
        $mainWindow = $null
        # Renderer hydration and listener registration are asynchronous on a
        # cold WebView2 launch. Keep the proof bounded, but require an explicit
        # managed-PTY record and its live interactive shell rather than using a
        # transient provider-detection process as readiness evidence.
        $readinessDeadline = [DateTime]::UtcNow.AddSeconds(60)
        while ([DateTime]::UtcNow -lt $readinessDeadline) {
            $process.Refresh()
            if ($process.HasExited) {
                throw "Installed kodade.exe exited before its Windows UI was ready (code $($process.ExitCode))"
            }
            $windows = @([KodadeWindowProbe]::ForProcess([uint32] $process.Id))
            $matchingWindows = @($windows | Where-Object {
                $_.Visible -and $_.Owner -eq 0 -and $_.Title -ceq $expectedWindowTitle
            })
            if ($matchingWindows.Count -eq 1 -and
                [KodadeWindowProbe]::IsResponsive($matchingWindows[0].Handle, 1000)) {
                $snapshot = @(Get-ProcessSnapshot)
                Add-TrackedDescendants -Tracked $tracked -Snapshot $snapshot
                $loginShell = Get-ManagedLoginShell `
                    -StdoutPath $stdoutPath `
                    -Snapshot $snapshot `
                    -AppCreationFileTime $appCreationFileTime
                if ($null -ne $loginShell) {
                    $shellKey = Get-ProcessIdentityKey -ProcessRecord $loginShell
                    if (-not $tracked.ContainsKey($shellKey)) {
                        $tracked.Add($shellKey, $loginShell)
                    }
                    Add-TrackedDescendants -Tracked $tracked -Snapshot $snapshot
                }
                $liveTracked = @($snapshot | Where-Object {
                    $tracked.ContainsKey((Get-ProcessIdentityKey -ProcessRecord $_))
                })
                $hasWebView = @($liveTracked | Where-Object {
                    $_.Name -ieq "msedgewebview2.exe"
                }).Count -gt 0
                $hasShell = $null -ne $loginShell
                if ($hasWebView -and $hasShell) {
                    $mainWindow = $matchingWindows[0]
                    break
                }
            }
            Start-Sleep -Milliseconds 500
        }
        if ($null -eq $mainWindow) {
            $windows = @([KodadeWindowProbe]::ForProcess([uint32] $process.Id))
            $lastSnapshot = @(Get-ProcessSnapshot)
            Add-TrackedDescendants -Tracked $tracked -Snapshot $lastSnapshot
            $names = @($lastSnapshot | Where-Object {
                $tracked.ContainsKey((Get-ProcessIdentityKey -ProcessRecord $_))
            } | ForEach-Object { $_.Name } | Sort-Object -Unique)
            throw "Installed kodade.exe did not become close-ready with its visible unowned '$expectedWindowTitle' window, WebView2, and managed interactive login shell; windows=$($windows | ConvertTo-Json -Compress -Depth 3) processes=$($names -join ',')"
        }

        $mainHandle = $mainWindow.Handle
        $windowsBefore = @([KodadeWindowProbe]::ForProcess([uint32] $process.Id))
        Write-Host "Kodade close probe before: pid=$($process.Id) main=$mainHandle windows=$($windowsBefore | ConvertTo-Json -Compress -Depth 3)"
        $closeTimer = [System.Diagnostics.Stopwatch]::StartNew()
        $closeReturned = [KodadeWindowProbe]::Close($mainHandle, 10000)
        Write-Host "Kodade SendMessageTimeout(WM_CLOSE) returned $closeReturned for handle $mainHandle"
        if (-not $closeReturned) {
            throw "Installed kodade.exe did not accept WM_CLOSE within 10 seconds on its ready main window"
        }
        Assert-TrackedProcessTreeExited -Tracked $tracked
        $closeTimer.Stop()
        Write-Host "Kodade close completed in $($closeTimer.ElapsedMilliseconds)ms"
        $process.Refresh()
        if (-not $process.HasExited) {
            throw "Installed kodade.exe did not exit after its main window closed"
        }
    }
    catch {
        $process.Refresh()
        $mainHandleAfter = if ($process.HasExited) { 0 } else { $process.MainWindowHandle.ToInt64() }
        $windowsAfter = if ($process.HasExited) {
            @()
        }
        else {
            @([KodadeWindowProbe]::ForProcess([uint32] $process.Id))
        }
        Write-Host "Kodade close probe after failure: exited=$($process.HasExited) main=$mainHandleAfter windows=$($windowsAfter | ConvertTo-Json -Compress -Depth 3)"
        if (Test-Path -LiteralPath $stdoutPath) {
            Write-Host "Kodade stdout:`n$(Read-SharedText -Path $stdoutPath)"
        }
        if (Test-Path -LiteralPath $stderrPath) {
            Write-Host "Kodade stderr:`n$(Read-SharedText -Path $stderrPath)"
        }
        throw
    }
    finally {
        if (-not $process.HasExited) {
            Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
            Wait-Process -Id $process.Id -ErrorAction SilentlyContinue
        }
        Remove-Item -LiteralPath $stdoutPath, $stderrPath -Force -ErrorAction SilentlyContinue
    }
}

function Assert-CurrentUserInstall {
    if (-not (Test-Path -LiteralPath $userUninstallKey)) {
        throw "The installer did not register kodade $Version for the current user"
    }
    if (Test-Path -LiteralPath $machineUninstallKey) {
        throw "The current-user installer unexpectedly registered a machine-wide uninstall entry"
    }
    $entry = Get-ItemProperty -LiteralPath $userUninstallKey
    if ($entry.DisplayName -ine "kodade" -or $entry.DisplayVersion -ne $Version) {
        throw "The current-user uninstall metadata does not match kodade $Version"
    }
    $installLocation = [Environment]::ExpandEnvironmentVariables($entry.InstallLocation).Trim('"')
    if (-not $installLocation) {
        throw "The uninstall entry does not contain an install location"
    }
    return $installLocation
}

if (Test-Path -LiteralPath $userUninstallKey) {
    throw "Refusing to replace an existing Kodade installation; run this proof on a disposable clean Windows user"
}
if (Test-Path -LiteralPath $machineUninstallKey) {
    throw "Refusing to replace an existing machine-wide Kodade installation"
}
if (Test-Path -LiteralPath $fallbackInstallDirectory) {
    throw "Refusing to replace an unregistered Kodade install directory at $fallbackInstallDirectory"
}
if (Test-Path -LiteralPath $appDataDirectory) {
    throw "Refusing to replace existing Kodade user data at $appDataDirectory"
}

try {
    Invoke-SilentProcess -FilePath $InstallerPath -ArgumentList "/S"
    # Establish a registry-derived cleanup path before validating installer
    # scope/metadata. Any assertion below can fail without stranding the app.
    foreach ($key in @($userUninstallKey, $machineUninstallKey)) {
        if (Test-Path -LiteralPath $key) {
            $entry = Get-ItemProperty -LiteralPath $key
            $location = [Environment]::ExpandEnvironmentVariables([string] $entry.InstallLocation).Trim('"')
            if ($location) {
                $candidate = Join-Path $location "uninstall.exe"
                if (Test-Path -LiteralPath $candidate -PathType Leaf) {
                    $uninstaller = $candidate
                    break
                }
            }
        }
    }
    $installLocation = Assert-CurrentUserInstall
    $app = Join-Path $installLocation "kodade.exe"
    $uninstaller = Join-Path $installLocation "uninstall.exe"
    if (-not (Test-Path -LiteralPath $app -PathType Leaf)) {
        throw "Installed executable was not found at $app"
    }
    if (-not (Test-Path -LiteralPath $uninstaller -PathType Leaf)) {
        throw "Uninstaller was not found at $uninstaller"
    }

    New-Item -ItemType Directory -Path $projectDirectory -Force | Out-Null
    [System.IO.File]::WriteAllText(
        (Join-Path $projectDirectory "README ünicode.md"),
        "# Windows RC`n",
        [System.Text.UTF8Encoding]::new($false)
    )
    New-Item -ItemType Directory -Path $appDataDirectory -Force | Out-Null
    $projectDoc = [ordered]@{
        version = 1
        projects = @([ordered]@{
            id = "windows-rc-project"
            name = "Kodade RC Project Ω"
            path = $projectDirectory
        })
        activeProjectId = "windows-rc-project"
        theme = "system"
    }
    [System.IO.File]::WriteAllText(
        $storagePath,
        (($projectDoc | ConvertTo-Json -Depth 5 -Compress) + "`n"),
        [System.Text.UTF8Encoding]::new($false)
    )
    [System.IO.File]::WriteAllText(
        $sentinelPath,
        "preserve current-user data across reinstall and uninstall`n",
        [System.Text.UTF8Encoding]::new($false)
    )
    $sentinelHash = (Get-FileHash -LiteralPath $sentinelPath -Algorithm SHA256).Hash

    # A launch legitimately rewrites kodade.json as terminal session identity
    # changes, so a byte-hash comparison across a launch is wrong. Assert the
    # semantic invariant instead — the
    # seeded project entry and active id survive — then re-baseline the hash
    # for the install/uninstall checks, which run with the app closed and where
    # byte-identity is still the right bar.
    function Assert-SeededProjectSurvived {
        param([string]$Stage)
        $persisted = Get-Content -LiteralPath $storagePath -Raw | ConvertFrom-Json
        $projects = @($persisted.projects)
        if ($projects.Count -ne 1 -or
            $projects[0].id -cne "windows-rc-project" -or
            $projects[0].path -cne $projectDirectory -or
            $persisted.activeProjectId -cne "windows-rc-project") {
            throw "Kodade changed the persisted project path during $Stage"
        }
    }

    Invoke-LaunchAndGracefulQuit -AppPath $app
    Assert-SeededProjectSurvived -Stage "launch"
    $storageHash = (Get-FileHash -LiteralPath $storagePath -Algorithm SHA256).Hash

    # Installing the same package over the current-user install exercises the
    # NSIS maintenance/upgrade path without manufacturing a fake older build.
    Invoke-SilentProcess -FilePath $InstallerPath -ArgumentList "/S"
    $reinstallLocation = Assert-CurrentUserInstall
    if ($reinstallLocation -cne $installLocation) {
        throw "Reinstall changed the current-user install location"
    }
    if ((Get-FileHash -LiteralPath $storagePath -Algorithm SHA256).Hash -cne $storageHash -or
        (Get-FileHash -LiteralPath $sentinelPath -Algorithm SHA256).Hash -cne $sentinelHash) {
        throw "Reinstall changed current-user Kodade data"
    }
    Invoke-LaunchAndGracefulQuit -AppPath $app
    Assert-SeededProjectSurvived -Stage "post-reinstall launch"
    $storageHash = (Get-FileHash -LiteralPath $storagePath -Algorithm SHA256).Hash

    Invoke-SilentProcess -FilePath $uninstaller -ArgumentList "/S"
    for ($attempt = 0; $attempt -lt 20 -and (Test-Path -LiteralPath $app); $attempt++) {
        Start-Sleep -Milliseconds 500
    }
    if (Test-Path -LiteralPath $app) {
        throw "Silent uninstall left the installed executable behind at $app"
    }
    if (Test-Path -LiteralPath $userUninstallKey) {
        throw "Silent uninstall left the current-user uninstall entry behind"
    }
    if ((Get-FileHash -LiteralPath $storagePath -Algorithm SHA256).Hash -cne $storageHash -or
        (Get-FileHash -LiteralPath $sentinelPath -Algorithm SHA256).Hash -cne $sentinelHash) {
        throw "Uninstall removed or changed current-user Kodade data"
    }
    $uninstaller = $null
}
finally {
    if ($uninstaller -and (Test-Path -LiteralPath $uninstaller -PathType Leaf)) {
        Invoke-SilentProcess -FilePath $uninstaller -ArgumentList "/S"
    }
    if (Test-Path -LiteralPath $appDataDirectory) {
        Remove-Item -LiteralPath $appDataDirectory -Recurse -Force
    }
    if (Test-Path -LiteralPath $projectDirectory) {
        Remove-Item -LiteralPath $projectDirectory -Recurse -Force
    }
}

"Installer reinstall, project persistence, graceful quit, process cleanup, and uninstall proof passed."
