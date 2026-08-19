param(
    [Parameter(Mandatory = $true)]
    [string] $InstallerPath,

    [Parameter(Mandatory = $true)]
    [string] $Version,

    [Parameter(Mandatory = $true)]
    [string] $OutputDirectory
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$installer = Get-Item -LiteralPath $InstallerPath
$expectedName = "Kodade_${Version}_x64-setup.exe"
if ($installer.Name -cne $expectedName) {
    throw "Expected installer $expectedName, found $($installer.Name)"
}

$output = New-Item -ItemType Directory -Path $OutputDirectory -Force
$hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $installer.FullName).Hash.ToLowerInvariant()
$checksumPath = Join-Path $output.FullName "$($installer.Name).sha256"
[System.IO.File]::WriteAllText(
    $checksumPath,
    "$hash  $($installer.Name)`n",
    [System.Text.UTF8Encoding]::new($false)
)

$manifestPath = Join-Path $output.FullName "Kodade_${Version}_windows-x64.json"
$manifest = [ordered]@{
    schemaVersion = 1
    product = "kodade"
    version = $Version
    platform = "windows"
    architecture = "x64"
    packageType = "nsis"
    installer = $installer.Name
    sha256 = $hash
    commit = $env:GITHUB_SHA
    runId = $env:GITHUB_RUN_ID
    runNumber = $env:GITHUB_RUN_NUMBER
}
[System.IO.File]::WriteAllText(
    $manifestPath,
    (($manifest | ConvertTo-Json -Depth 3) + "`n"),
    [System.Text.UTF8Encoding]::new($false)
)

$parsed = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
if ($parsed.installer -cne $installer.Name -or $parsed.sha256 -cne $hash) {
    throw "Release manifest does not match the installer checksum"
}
if ($parsed.version -cne $Version -or $parsed.platform -cne "windows" -or $parsed.architecture -cne "x64") {
    throw "Release manifest identity does not match the Windows x64 build"
}

@{
    Installer = $installer.FullName
    Checksum = $checksumPath
    Manifest = $manifestPath
    Sha256 = $hash
}
