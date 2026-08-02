import type { ReactNode } from "react";

type PaneProps = {
  title: string;
  children: ReactNode;
  className?: string;
  headerAction?: ReactNode;
  compactHeader?: boolean;
};

// Provides the shared frame and header used by every workspace pane. Fills its
// resizable panel; Separators (not per-pane borders) divide the panes now.
export function Pane({
  title,
  children,
  className = "",
  headerAction,
  compactHeader = false,
}: PaneProps) {
  return (
    <section className={`flex h-full min-w-0 flex-col ${className}`}>
      {/* Toolbar row: 38px (DESIGN.md §4.3). Titles arrive already-cased by the
          caller (lowercase kodade chrome; real filenames keep their case), so no
          text-transform here. Wide tracking keeps the label feel. */}
      <header
        className={`flex h-[38px] shrink-0 items-center justify-between border-b border-border text-[11px] font-semibold tracking-[0.16em] text-text-dim ${
          compactHeader ? "px-2" : "px-3"
        }`}
      >
        <span>{title}</span>
        {headerAction}
      </header>
      <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
    </section>
  );
}
