# macOS app identity

How Ködade names itself on macOS, and what each name controls.

## What you see

- **Finder, Dock, and the menu bar** show **Ködade**. The bundle carries
  `CFBundleName` and `CFBundleDisplayName` set to `Ködade`, and the window
  title is `Ködade`.
- **On disk** the application is `Kodade.app` and its main executable is
  `Contents/MacOS/Kodade`. These stay ASCII on purpose: filenames, binary
  names, and identifiers must survive shells, scripts, archives, and installers
  that do not handle non-ASCII characters reliably.
- **Activity Monitor** lists the main application process by its executable
  name, so it now reads `Kodade`. Builds before this change displayed the
  lowercase `kodade` there even though Finder already showed Ködade, because
  the display name in the bundle does not affect the process name.
- The **bundle identifier remains `com.kodade.desktop`.** Renaming the app did
  not change app data locations, code-signing identity, or preferences.

## The `tauri://localhost` row in Activity Monitor

Ködade renders its interface in an embedded WebKit web view. macOS runs that
web content in separate system-provided helper processes, and Activity Monitor
attributes each of those rows to the **page origin** loaded by the web view
rather than to the host application's name.

In a packaged Ködade build, the interface is served from the web view's
internal scheme, so that row is labelled `tauri://localhost`. It is a normal
WebKit web-content process belonging to Ködade, not a separate application, a
network server, or an external connection.

That label cannot be renamed. WebKit publishes the active page origin, derived
from the loaded URL, through Launch Services, and macOS displays it as the
process name. Apple exposes no public API or `Info.plist` key that overrides
this attribution.

On macOS, Tauri v2 serves production assets from its internal `tauri://localhost`
scheme and offers no supported way to rebrand that origin; its `useHttpsScheme`
option applies only to Windows and Android. The alternatives — serving the
interface from a loopback `localhost` server, from a remote URL, or from a
different custom scheme — would change the displayed label, but they also reset
web storage tied to the current origin and widen the security surface. Ködade
keeps the default.

Net effect: the main application process shows as Kodade/Ködade, and the
`tauri://localhost` web-content row is expected behavior controlled by macOS
and Tauri rather than by Ködade.

Practical consequences:

- Quitting Ködade ends the associated web-content processes.
- Force-quitting the `tauri://localhost` row terminates the interface only, and
  is equivalent to killing the app's renderer.
- Per-process CPU and memory shown on that row belong to Ködade's interface.
