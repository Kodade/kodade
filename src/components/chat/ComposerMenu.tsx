// The composer's styled dropdown: a chip trigger + an upward-opening listbox.
// Native <select> can't render icons, descriptions, or a selected checkmark,
// which is exactly what the t3-style run controls need — so this owns the
// popover behaviour once (click-away, Escape with focus return, arrow-key
// traversal) and the provider/model/access menus all reuse it.

import { useEffect, useRef, useState, type ReactNode } from "react";

export type ComposerMenuOption = {
  id: string;
  label: string;
  description?: string;
  icon?: ReactNode;
  // Dimmed and non-selectable (e.g. a terminal-only provider).
  disabled?: boolean;
  disabledHint?: string;
};

export function ComposerMenu({
  label,
  value,
  options,
  onSelect,
  children,
  menuWidthClass = "min-w-[220px]",
}: {
  label: string; // aria-label for both the trigger and the listbox
  value: string;
  options: ComposerMenuOption[];
  onSelect(id: string): void;
  children: ReactNode; // chip content; the chevron is appended here
  menuWidthClass?: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  // Click-away dismisses without stealing focus; Escape (below) returns it.
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", dismiss);
    return () => window.removeEventListener("mousedown", dismiss);
  }, [open]);

  // Opening puts focus on the selected option so arrows continue from there.
  useEffect(() => {
    if (!open) return;
    const selected = listRef.current?.querySelector<HTMLButtonElement>(
      '[role="option"][aria-selected="true"]',
    );
    const first = listRef.current?.querySelector<HTMLButtonElement>(
      '[role="option"]:not(:disabled)',
    );
    (selected ?? first)?.focus();
  }, [open]);

  const close = (returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  };

  const moveFocus = (delta: 1 | -1) => {
    const items = [
      ...(listRef.current?.querySelectorAll<HTMLButtonElement>(
        '[role="option"]:not(:disabled)',
      ) ?? []),
    ];
    if (items.length === 0) return;
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    items[(index + delta + items.length) % items.length]?.focus();
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
          event.preventDefault();
          setOpen(true);
        }}
        className="flex h-8 items-center gap-1.5 rounded-lg border border-border bg-bg px-2.5 text-xs font-medium text-text hover:bg-surface-hover focus:outline-none focus:ring-1 focus:ring-accent"
      >
        {children}
        <svg
          viewBox="0 0 16 16"
          className="h-3 w-3 text-text-dim"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          aria-hidden="true"
        >
          <path d="m4.5 6.5 3.5 3.5 3.5-3.5" />
        </svg>
      </button>
      {open && (
        <div
          ref={listRef}
          role="listbox"
          aria-label={label}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              close(true);
              return;
            }
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              moveFocus(event.key === "ArrowDown" ? 1 : -1);
            }
          }}
          className={`absolute bottom-full left-0 z-30 mb-1.5 max-h-72 overflow-y-auto rounded-lg border border-border bg-surface p-1 shadow-lg ${menuWidthClass}`}
        >
          {options.map((option) => {
            const selected = option.id === value;
            return (
              <button
                key={option.id}
                type="button"
                role="option"
                aria-selected={selected}
                disabled={option.disabled}
                title={option.disabled ? option.disabledHint : option.description}
                onClick={() => {
                  onSelect(option.id);
                  close(true);
                }}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-text hover:bg-surface-hover focus:outline-none focus:ring-1 focus:ring-accent disabled:cursor-not-allowed disabled:opacity-45"
              >
                {option.icon}
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{option.label}</span>
                  {option.description && (
                    <span className="block truncate text-[10px] text-text-dim">
                      {option.description}
                    </span>
                  )}
                </span>
                {selected && (
                  <svg
                    viewBox="0 0 16 16"
                    className="h-3.5 w-3.5 shrink-0 text-accent"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    aria-hidden="true"
                  >
                    <path d="m3.5 8.5 3 3 6-7" />
                  </svg>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
