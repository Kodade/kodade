# Windows

Kodade targets x64 Windows 10 version 1809 or newer and Windows 11. Automated
native evidence currently runs on Windows Server 2025; Windows 10 compatibility
remains a pre-release human validation gate. The distributable package is a
per-user NSIS `setup.exe`: it installs under the current user's
`%LOCALAPPDATA%`, writes uninstall metadata under `HKCU`, and does not require
administrator access.

The installer embeds Microsoft's small WebView2 bootstrapper. Windows 10 and
11 normally already include the Evergreen WebView2 Runtime. If the runtime is
missing, the bootstrapper needs an internet connection to download it during
installation.

## Install and uninstall

Open `kodade_<version>_x64-setup.exe` and follow the installer. Unsigned preview
builds work, but Windows SmartScreen may ask you to confirm that you want to run
an unrecognized app. Production downloads should be code-signed before broad
distribution.

For unattended testing, Tauri's NSIS packages use an uppercase `/S` flag:

```powershell
.\kodade_1.3.0_x64-setup.exe /S
```

Uninstall Kodade from **Settings → Apps → Installed apps**, or run the installed
uninstaller silently:

```powershell
& "$env:LOCALAPPDATA\kodade\uninstall.exe" /S
```

## Developer setup

Install the current Tauri 2 Windows prerequisites:

- Microsoft C++ Build Tools with the **Desktop development with C++** workload
- the stable `x86_64-pc-windows-msvc` Rust toolchain
- Node.js 24 and pnpm 11.8.0
- Microsoft Edge WebView2 Runtime

Then run from the repository root:

```powershell
pnpm install --frozen-lockfile
pnpm exec tsc --noEmit
pnpm vitest run
cargo test --locked --manifest-path src-tauri/Cargo.toml --all-targets -- --test-threads=1
pnpm tauri dev
```

Kodade opens the user's normal Windows shell. It prefers PowerShell 7 (`pwsh`),
then Windows PowerShell, then `cmd.exe`. Agent providers and the GitHub tab use
the CLIs already installed and authenticated for that user.

## Build the installer

Build on an x64 Windows machine:

```powershell
pnpm install --frozen-lockfile
pnpm tauri build --bundles nsis
```

### KödLocal Windows variants

Ködade intentionally does **not** ship CUDA or cuDNN. Windows has two distinct
`kodade-modeld.exe` build variants so the CPU-only artifact does not link the
Vulkan loader:

- `modeld-vulkan` includes llama.cpp's Vulkan backend and requires the LunarG
  Vulkan SDK at build time plus a Vulkan loader at run time. This is the default
  staged by `pnpm build:modeld` and the normal Windows installer.
- `modeld` includes only llama.cpp's CPU backend. It does not enable the Cargo
  `vulkan` feature and is the separately built CPU-only installer for machines
  without `vulkan-1.dll`.

Build and smoke-run the Vulkan helper on Windows:

```powershell
$env:VULKAN_SDK = "C:\VulkanSDK\<version>"
cargo build --locked --manifest-path src-tauri/Cargo.toml --release --no-default-features --features modeld-vulkan --bin kodade-modeld
& .\src-tauri\target\release\kodade-modeld.exe --help
$env:KODADE_MODELD_VARIANT = "vulkan"
pnpm tauri build --bundles nsis
```

Build and smoke-run the genuinely CPU-only helper without a Vulkan SDK or
loader, then package the CPU-only installer:

```powershell
Remove-Item Env:VULKAN_SDK -ErrorAction SilentlyContinue
cargo build --locked --manifest-path src-tauri/Cargo.toml --release --no-default-features --features modeld --bin kodade-modeld
& .\src-tauri\target\release\kodade-modeld.exe --help
$env:KODADE_MODELD_VARIANT = "cpu"
pnpm tauri build --bundles nsis
```

Each installer contains one helper at the stable resource name
`kodade-local\bin\kodade-modeld.exe`; the app does not switch engines at run
time. `KODADE_MODELD_VARIANT` selects which Cargo feature set
`scripts/stage-modeld.mjs` stages before Tauri builds the installer. Label a
CPU-only installer explicitly when publishing it. The removed runtime-only
switch was not a no-loader fallback: it changed layer offload in a
Vulkan-linked process and therefore could not help the process start when
`vulkan-1.dll` was absent.

Outputs land in:

- Installer: `src-tauri/target/release/bundle/nsis/kodade_<version>_x64-setup.exe`
- Unpacked executable: `src-tauri/target/release/kodade.exe`
- Debug symbols: `src-tauri/target/release/kodade.pdb`

Tauri automatically merges `src-tauri/tauri.windows.conf.json` on Windows. The
shared config contains app metadata, while `tauri.windows.conf.json` selects
NSIS, the current-user install mode, and the embedded WebView2 bootstrapper.
The separate `tauri.macos.conf.json` preserves the macOS app/DMG bundle lane.

## CI proof and artifacts

The `Windows verification` workflow runs on `windows-2025`. After frontend and
Rust checks, it builds the NSIS package and emits SHA-256 plus JSON release
metadata. It silently installs for the current user, launches and gracefully
quits twice, proves reinstall/uninstall preserve seeded app data, and checks the
identity-matched `msedgewebview2.exe` child tree exits. A successful run uploads:

- `kodade-windows-installer-<version>-<run>` with the versioned installer,
  `.sha256`, and JSON manifest
- `kodade-windows-unpacked-<run>` with `kodade.exe`, its PDB, and frontend output

The unpacked artifact is useful for diagnostics; users should install the NSIS
package. The same workflow exercises the isolated browser child in a real Win32
window against a loopback fixture, including lifecycle, navigation policy, and
the disabled WebView2 page-to-native messaging boundary. Authenticated
providers/`gh`, visible UI interaction, WebView2 recovery, and visual browser
inspection remain human release-candidate gates.
Record the human-gate results with the release issue before publishing.

## Release procedure

1. Update the version in `package.json`, `src-tauri/tauri.conf.json`, and
   `src-tauri/Cargo.toml`.
2. Run the local Windows verification commands above.
3. Push the release branch and wait for `Windows verification` to pass.
4. On the dedicated Windows release machine, import the human-selected signing
   certificate into the current user's certificate store. Set the helper
   signing environment and pass the same certificate and timestamp settings to
   Tauri through a temporary config overlay:

   ```powershell
   $env:SIGNTOOL_CERT_SHA1 = "<certificate-thumbprint-without-spaces>"
   $env:SIGNTOOL_TIMESTAMP_URL = "<RFC3161-timestamp-url>"
   $env:KODADE_MODELD_VARIANT = "vulkan" # use "cpu" for the CPU-only installer
   $signingConfig = Join-Path $env:TEMP "kodade-windows-signing.conf.json"
   $signingSettings = @{
     bundle = @{
       windows = @{
         certificateThumbprint = $env:SIGNTOOL_CERT_SHA1
         digestAlgorithm = "sha256"
         timestampUrl = $env:SIGNTOOL_TIMESTAMP_URL
         tsp = $true
       }
     }
   } | ConvertTo-Json -Depth 4
   [System.IO.File]::WriteAllText(
     $signingConfig,
     $signingSettings,
     [System.Text.UTF8Encoding]::new($false)
   )
   try {
     pnpm tauri build --bundles nsis --config $signingConfig
     if ($LASTEXITCODE -ne 0) { throw "Signed Tauri build failed" }
   }
   finally {
     Remove-Item -LiteralPath $signingConfig -Force -ErrorAction SilentlyContinue
   }
   ```

   The build order is intentional. `scripts/stage-modeld.mjs` signs all three
   resource helpers first. Tauri then signs `target\release\kodade.exe` before
   NSIS embeds that exact executable and signs the finished installer. This is
   Tauri's documented [Windows code-signing
   flow](https://v2.tauri.app/distribute/sign/windows/); do not sign the main
   executable after the installer already exists. `SIGNTOOL_PATH` may name a
   specific `signtool.exe` when it is not already on `PATH`.
5. After all signing is complete, regenerate the checksum and release manifest:

   ```powershell
   $version = (Get-Content "src-tauri\tauri.conf.json" -Raw | ConvertFrom-Json).version
   $installers = @(Get-ChildItem "src-tauri\target\release\bundle\nsis" -Filter "*_x64-setup.exe")
   if ($installers.Count -ne 1) { throw "Expected exactly one x64 installer" }
   $metadata = & .\scripts\windows-release-metadata.ps1 `
     -InstallerPath $installers[0].FullName `
     -Version $version `
     -OutputDirectory "src-tauri\target\release\bundle\nsis"
   ```

6. Verify the signed build outputs and the newly generated checksum, then
   install that exact installer:

   ```powershell
   $builtArtifacts = @(
     "src-tauri\target\release\kodade.exe",
     "src-tauri\binaries\kodade-modeld.exe",
     "src-tauri\binaries\kodade-tool-host.exe",
     "src-tauri\binaries\kodade-mcp.exe",
     $metadata.Installer
   )
   foreach ($artifact in $builtArtifacts) {
     signtool verify /pa /v $artifact
     if ($LASTEXITCODE -ne 0) { throw "Signature verification failed: $artifact" }
   }
   $expected = (Get-Content $metadata.Checksum).Split()[0]
   $actual = (Get-FileHash $metadata.Installer -Algorithm SHA256).Hash.ToLowerInvariant()
   if ($actual -cne $expected) { throw "Checksum mismatch" }
   & $metadata.Installer /S
   if ($LASTEXITCODE -ne 0) { throw "Installer failed" }
   ```

7. Resolve the installed location from the current-user uninstall entry and
   verify the installed main executable plus all three installed helpers:

   ```powershell
   $entry = Get-ItemProperty "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\kodade"
   $installLocation = [Environment]::ExpandEnvironmentVariables($entry.InstallLocation).Trim('"')
   $installedArtifacts = @(
     (Join-Path $installLocation "kodade.exe"),
     (Join-Path $installLocation "kodade-local\bin\kodade-modeld.exe"),
     (Join-Path $installLocation "kodade-local\bin\kodade-tool-host.exe"),
     (Join-Path $installLocation "kodade-local\bin\kodade-mcp.exe")
   )
   foreach ($artifact in $installedArtifacts) {
     if (-not (Test-Path -LiteralPath $artifact -PathType Leaf)) { throw "Missing installed artifact: $artifact" }
     signtool verify /pa /v $artifact
     if ($LASTEXITCODE -ne 0) { throw "Installed signature verification failed: $artifact" }
   }
   ```

8. Attach the exact signed artifact and verification proof to the release
   issue. Do not put a certificate
   thumbprint, timestamp URL, certificate, or signing secret in the repository
   or the ordinary pull-request workflow. Certificate/provider selection and
   installed-artifact verification remain the private archive items 70/71 human release gate.

Unsigned pull-request builds intentionally require no certificate or repository
secret. No Windows signing command, certificate thumbprint, or credential hook
is active in CI; release signing remains a human gate.

## Troubleshooting

- **SmartScreen warns about an unknown publisher:** expected for unsigned
  preview artifacts. Verify the SHA-256 value and source workflow before
  continuing; do not distribute unsigned builds as production releases.
- **The window does not open or WebView2 reports an error:** install or repair
  the Evergreen WebView2 Runtime, then relaunch Kodade.
- **Kodade opens Windows PowerShell instead of PowerShell 7:** install `pwsh` and
  restart Kodade so it can resolve the updated user `PATH`.
- **An agent CLI is not detected:** confirm it runs in a fresh terminal for the
  same Windows user, including any npm `.cmd` shim, then restart Kodade.
- **A silent command opens the installer UI:** the NSIS switch is uppercase
  `/S`; lowercase `/s` is not the documented Tauri silent flag.
