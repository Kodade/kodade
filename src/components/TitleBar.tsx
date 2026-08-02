import { type ReactNode } from "react";
import { useStore } from "zustand";
import { filesStore } from "../store/appStore";
import {
  canUseBrowserPane,
  capabilitiesStore,
} from "../platform/capabilities";
import { KodadeMark, KodadeWordmark } from "./KodadeBrand";
import {
  BrowserIcon,
  GithubIcon,
  ReviewIcon,
} from "./TabStrip";

// Matches the native title-bar height while leaving room for macOS traffic lights.
export function TitleBar() {
  const browserPaneCapable = useStore(capabilitiesStore, (state) =>
    canUseBrowserPane(state.capabilities),
  );

  return (
    <header
      data-tauri-drag-region
      className="flex h-[34px] shrink-0 items-center justify-between border-b border-border bg-surface pl-[78px] text-text"
    >
      <div data-tauri-drag-region className="flex items-center gap-1.5">
        <KodadeMark size={10} />
        <KodadeWordmark className="text-xs" />
      </div>
      <div className="flex h-full items-stretch">
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
