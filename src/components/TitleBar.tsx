import { useRef, type KeyboardEvent, type ReactNode } from "react";
import { useStore } from "zustand";
import { appStore, filesStore } from "../store/appStore";
import {
  browserPaneAvailable,
  capabilitiesStore,
} from "../platform/capabilities";
import { RELEASE_MANIFEST } from "../release/manifest";
import { KodadeMark, KodadeWordmark } from "./KodadeBrand";
import type { ShellTabId } from "./shell/shell-layout";
import { shellTabButtonId, shellTabPanelId } from "./shell/tab-ids";
import {
  BrowserIcon,
  GithubIcon,
  ReviewIcon,
} from "./TabStrip";

// The v2 shell's tabs, in the order they read across the title bar.
const SHELL_TABS: readonly { id: ShellTabId; label: string }[] = [
  { id: "agents", label: "Agents" },
  { id: "code", label: "Code" },
  { id: "editor", label: "Editor" },
];

// Matches the native title-bar height while leaving room for macOS traffic lights.
export function TitleBar() {
  // Archived embedded browser (#62): compiled out of public builds, and still
  // hidden on any platform that cannot host the native child view.
  const browserPaneCapable = useStore(capabilitiesStore, (state) =>
    browserPaneAvailable(state.capabilities),
  );
  // v2 shell (issues #62/#65): shipped and on by default; the title-bar
  // action below is the escape hatch back to the classic v1 layout.
  const shellFeature = RELEASE_MANIFEST.features.shell;
  const shellV2Enabled = useStore(appStore, (s) => s.shellV2Enabled);
  const activeTab = useStore(appStore, (s) => s.shellLayout.activeTab);
  const showShellTabs = shellFeature && shellV2Enabled;

  return (
    <header
      data-tauri-drag-region
      // `relative` only when the pills need a positioning context, so a build
      // without them keeps the exact class list it always had.
      className={`${showShellTabs ? "relative " : ""}flex h-[34px] shrink-0 items-center justify-between border-b border-border bg-surface pl-[78px] text-text`}
    >
      <div data-tauri-drag-region className="flex items-center gap-1.5">
        <KodadeMark size={10} />
        <KodadeWordmark className="text-xs" />
      </div>
      {showShellTabs && (
        <ShellTabPills
          activeTab={activeTab}
          onSelect={(tab) => {
            const { shellLayout, setShellLayout } = appStore.getState();
            setShellLayout({ ...shellLayout, activeTab: tab });
          }}
        />
      )}
      <div className="flex h-full items-stretch">
        {shellFeature && (
          // v2.0.0 escape hatch back to the classic v1 shell: always visible,
          // in both states, so either layout is one click away. Planned for
          // retirement one release after v2.0.0.
          <TitleAction
            label={
              shellV2Enabled ? "Use the classic layout" : "Use the tabbed layout"
            }
            onClick={() =>
              appStore.getState().setShellV2Enabled(!shellV2Enabled)
            }
          >
            <ShellToggleIcon active={shellV2Enabled} />
          </TitleAction>
        )}
        {browserPaneCapable && (
          <TitleAction
            label="open browser"
            onClick={() => filesStore.getState().openBrowserTab()}
          >
            <BrowserIcon />
          </TitleAction>
        )}
        <TitleAction
          label="open github"
          onClick={() => filesStore.getState().openGithubTab()}
        >
          <GithubIcon />
        </TitleAction>
        <TitleAction
          label="open review"
          onClick={() => filesStore.getState().openReviewTab()}
        >
          <ReviewIcon />
        </TitleAction>
      </div>
    </header>
  );
}

// Centered segmented control for the v2 shell's tabs. Absolutely centered on
// the title bar so it stays put no matter how many right-hand actions show.
// None of these elements carry data-tauri-drag-region: only elements that have
// the attribute start a window drag, so the buttons stay clickable — the same
// way the TitleAction buttons do.
function ShellTabPills({
  activeTab,
  onSelect,
}: {
  activeTab: ShellTabId;
  onSelect(tab: ShellTabId): void;
}) {
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);

  // Roving focus with automatic activation: only the selected pill is in the
  // tab order, and Left/Right move selection AND focus together. Enter/Space
  // need no handling — these are real buttons, so the browser fires onClick.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step =
      event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    const index = SHELL_TABS.findIndex((tab) => tab.id === activeTab);
    const next = (index + step + SHELL_TABS.length) % SHELL_TABS.length;
    onSelect(SHELL_TABS[next].id);
    buttons.current[next]?.focus();
  };

  return (
    <div
      role="tablist"
      aria-label="Ködade shell tabs"
      onKeyDown={onKeyDown}
      className="absolute left-1/2 flex -translate-x-1/2 items-center gap-0.5 rounded-full bg-surface p-0.5"
    >
      {SHELL_TABS.map((tab, index) => {
        const active = tab.id === activeTab;
        return (
          <button
            key={tab.id}
            ref={(node) => {
              buttons.current[index] = node;
            }}
            type="button"
            role="tab"
            id={shellTabButtonId(tab.id)}
            aria-controls={shellTabPanelId(tab.id)}
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            title={tab.label}
            onClick={() => onSelect(tab.id)}
            className={`rounded-full px-3 py-0.5 text-[11px] font-medium transition-colors ${
              active
                ? "bg-accent text-accent-text"
                : "text-text-dim hover:bg-surface-hover hover:text-text"
            }`}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}

// Simple state-carrying glyph for the development shell toggle: filled when the
// v2 shell is on, outlined when it isn't.
function ShellToggleIcon({ active }: { active: boolean }) {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <rect
        x="1.5"
        y="2.5"
        width="13"
        height="11"
        rx="2"
        fill="none"
        stroke="currentColor"
      />
      <rect
        x="1.5"
        y="2.5"
        width="4.5"
        height="11"
        rx="2"
        fill={active ? "currentColor" : "none"}
        stroke="currentColor"
      />
    </svg>
  );
}

function TitleAction({
  label,
  disabled = false,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick(): void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="flex h-full w-9 shrink-0 items-center justify-center border-l border-border text-text-dim hover:bg-surface-hover hover:text-text disabled:cursor-wait disabled:opacity-50"
    >
      {children}
    </button>
  );
}
