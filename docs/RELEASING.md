# Releasing kodade

Kodade ships platform-native desktop packages:

- macOS: `.app` and `.dmg` (instructions below)
- Windows x64: NSIS `setup.exe` (see [Windows](WINDOWS.md))

How to build a shippable macOS DMG of kodade. Two modes:

- **Unsigned dev build** — works today, no Apple account needed. The DMG opens
  on your own Mac but Gatekeeper will warn other users ("kodade can't be opened
  because Apple cannot check it for malicious software"). Fine for local testing
  and sharing with people willing to right-click → Open.
- **Signed + notarized release** — what ships at kodade.com. Needs an Apple
  Developer account ($99/yr) and the steps in [Signing & notarizing](#signing--notarizing).

The macOS signing config in `src-tauri/tauri.macos.conf.json` currently reads:

```json
"macOS": {
  "minimumSystemVersion": "13.0",
  "hardenedRuntime": true,
  "signingIdentity": null
}
```

`signingIdentity: null` means **do not sign** — the build produces an unsigned
`.app`/`.dmg`. Leave it `null` and drive signing from the environment (below), or
hardcode your Developer ID string here once you have one. The env-var approach is
preferred so no cert identity is committed to the repo.

---

## Unsigned dev build (works now)

```bash
pnpm install
pnpm tauri build
```

This is a full-feature development/QA package. It deliberately includes
unsupported development features and must not be published as a public
release.

Output lands in:

- App: `src-tauri/target/release/bundle/macos/kodade.app`
- DMG: `src-tauri/target/release/bundle/dmg/kodade_<version>_aarch64.dmg`

To open the unsigned app on your own machine without the Gatekeeper prompt:
right-click the app → **Open** → **Open** (only needed the first time), or

```bash
xattr -dr com.apple.quarantine /Applications/kodade.app
```

Do **not** ship the unsigned DMG to other users — they'll hit Gatekeeper.

---

## Signing & notarizing (release build)

Human-only, one-time setup. Requires an Apple Developer account.

### 1. Install your Developer ID Application certificate

1. In Xcode → **Settings → Accounts**, add your Apple ID, then
   **Manage Certificates → +→ Developer ID Application**. (Or create it in the
   Apple Developer portal → Certificates and download the `.cer`.)
2. Double-click the cert to install it into your **login keychain**.
3. Verify it's present and usable for code signing:

   ```bash
   security find-identity -v -p codesigning
   ```

   You should see a line like:

   ```
   1) ABCDEF0123... "Developer ID Application: Your Name (TEAMID)"
   ```

   The quoted string is your **signing identity**. If this command prints
   `0 valid identities found`, signing cannot proceed because the certificate
   is not installed.

### 2. Create an app-specific password for notarization

`notarytool` authenticates to Apple with an app-specific password, not your
main Apple ID password.

1. Go to <https://appleid.apple.com> → **Sign-In and Security → App-Specific
   Passwords** → generate one (label it e.g. `kodade-notarize`).
2. Note your **Team ID** (Apple Developer portal → Membership).

### 3. Set the build environment

```bash
# The exact quoted identity string from `security find-identity` above.
export APPLE_SIGNING_IDENTITY="Developer ID Application: Your Name (TEAMID)"

# Notarization credentials (used by Tauri's built-in notarize step).
export APPLE_ID="you@example.com"
export APPLE_PASSWORD="the-app-specific-password"
export APPLE_TEAM_ID="TEAMID"
```

When `APPLE_SIGNING_IDENTITY` is set, Tauri signs the `.app` with a hardened
runtime; when the `APPLE_ID`/`APPLE_PASSWORD`/`APPLE_TEAM_ID` trio is also set,
Tauri notarizes and staples automatically during `pnpm tauri:build:public`.

(You can instead set `signingIdentity` in `tauri.conf.json` to the identity
string and skip `APPLE_SIGNING_IDENTITY` — but keep it out of git if you do.)

### 4. Build

```bash
export CARGO_TARGET_DIR=/Users/Shared/kodade-target
export APPLE_SIGNING_IDENTITY="Developer ID Application: Your Name (TEAMID)"
pnpm tauri:build:public
```

Use a target outside a FileProvider-managed `~/Documents` tree. The public
build script also places `/usr/bin` first so Tauri calls Apple's recursive
`xattr`, not the incompatible command installed by Python Framework builds.

This now: builds the public feature manifest → stages only public resources →
signs (hardened runtime) → notarizes → staples. KödWork is supported; KödLocal,
KödWhisper, and KödSSH remain in source but are unavailable in the app. The
public staging script packages the supported KödMem helper, KödSkills, and the
project and bundled-asset notices plus the generated dependency license bundle:

```text
kodade-mcp                 → Contents/Resources/helpers/kodade-mcp
KödSkills                  → Contents/Resources/kodskills/
Apache/third-party notices → Contents/Resources/legal/
JavaScript/Rust reports     → Contents/Resources/legal/dependencies/
```

The checked-in dependency reports cover the production JavaScript tree and the
Rust crates selected for the Apple Silicon public app. Their manifest records
the exact lockfile, package, Cargo, generator, override, and output hashes. A
public build fails closed if any input changes without regeneration:

```bash
cargo install cargo-about --version 0.9.1 --locked --features cli
pnpm licenses:generate
pnpm licenses:verify
```

`THIRD_PARTY_NOTICES.md` remains the concise source-level inventory; the HTML
reports under `licenses/dependencies/generated/` carry the complete license
and attribution texts distributed inside the app.

When `APPLE_SIGNING_IDENTITY` is set, `scripts/stage-public-resources.mjs` signs
the staged helper with `--options runtime`, the same
`src-tauri/Entitlements.plist`, and a timestamp before it enters the `.app`.
Tauri then signs the containing app. Do not sign helpers after Tauri has
notarized the bundle: that invalidates the enclosing signature. The DMG in
`src-tauri/target/release/bundle/dmg/` is ready to distribute only after the
verification below succeeds.

If the build environment does not contain the Apple credential variables,
Tauri will sign but skip notarization. Prefer rebuilding with the complete
credential trio so Tauri can complete the flow. A manual Keychain-profile
fallback is a two-stage packaging operation, not just three post-build
commands:

```bash
DMG="$CARGO_TARGET_DIR/release/bundle/dmg/kodade_<version>_aarch64.dmg"
xcrun notarytool submit "$DMG" --keychain-profile kodade-notarize --wait
```

After Apple accepts that submission:

1. Extract the exact notarized app from the accepted DMG and staple and
   validate that app.
2. Rebuild and sign the distributable DMG around the stapled app. Stapling a
   separate standalone app does not modify the copy already sealed inside the
   original DMG.
3. Submit the rebuilt DMG to Apple, wait for `Accepted`, then staple and
   validate the rebuilt DMG.
4. Mount the final DMG read-only and validate the app inside it. Do not publish
   unless both the final DMG and its mounted app pass `stapler validate`,
   `codesign`, and Gatekeeper.

The 1.4.13 audit caught this distinction: the first DMG submission was accepted
by Apple, but the mounted app did not have an offline stapled ticket. Acceptance
of the outer DMG alone is therefore insufficient release evidence.

### 5. Verify the result

```bash
APP="${CARGO_TARGET_DIR:-src-tauri/target}/release/bundle/macos/kodade.app"
HELPERS=(
  "$APP/Contents/Resources/helpers/kodade-mcp"
)

# The packaged resource allowlist must also pass.
node scripts/verify-public-release.mjs --bundle "$APP"

# Signature is valid and satisfies the Developer ID policy.
codesign --verify --deep --strict --verbose=2 "$APP"
for helper in "${HELPERS[@]}"; do
  test -x "$helper"
  codesign --verify --strict --verbose=2 "$helper"
  codesign -d --verbose=4 "$helper" 2>&1 | grep -E 'Identifier=|Runtime Version|Authority='
done
spctl -a -vvv -t exec "$APP"          # expect: "accepted", source=Notarized Developer ID

# Notarization ticket is stapled (works offline).
xcrun stapler validate "$APP"          # expect: "The validate action worked!"
```

Repeat the resource, signature, Gatekeeper, and stapler checks against the app
inside a read-only mount of the final DMG. That mounted copy—not only the
standalone build output—is what users receive.

Expected Gatekeeper result on a **clean machine** (one that never built the app):
double-clicking the DMG mounts it, dragging kodade to Applications and launching
it opens **with no Gatekeeper warning** — exactly the ship-ready experience.

---

## Version bumps

Ködade uses Semantic Versioning: `major.minor.patch`.

- Major: an intentionally incompatible product or data-contract change.
- Minor: a meaningful backward-compatible feature release.
- Patch: fixes and polish to the current minor release.
- A local rebuild does **not** consume a version. Any DMG or installer handed to
  a tester must have a unique version so feedback can be tied to exact code.
- macOS and Windows desktop packages share one product version. Platform
  readiness is a validation status on that version, not a separate version
  stream.

For the current private QA cycle, increment the patch for each distributed test
build (`1.3.3`, `1.3.4`, and so on). Once public prerelease automation is in
place, release candidates may use SemVer prerelease tags such as `1.4.0-rc.1`.

Before building a distributed artifact:

1. Move its changes from `[Unreleased]` into a dated entry in `CHANGELOG.md`.
2. Bump the version in **all three** places below (they must match):

- `package.json` → `"version"`
- `src-tauri/tauri.conf.json` → `"version"`
- `src-tauri/Cargo.toml` → `version`

3. Run `pnpm check:version`, the source gates, and the platform build.
4. Record automated and human status for each supported desktop platform in the
   changelog entry. Untested is a valid status; it must not be implied as passed.
5. Record artifact checksums. Publish a stable GitHub Release/tag only after the
   required platform, signing, and clean-install gates pass. Release notes should
   mirror the changelog entry and its platform status table.

The DMG filename encodes the version and target arch, e.g.
`kodade_1.3.4_aarch64.dmg`.

The Windows NSIS filename follows the same version, e.g.
`kodade_1.3.4_x64-setup.exe`. Windows pull-request builds remain unsigned until
a signing provider is selected; no signing secrets or inactive placeholder
credentials are committed to the workflow.
