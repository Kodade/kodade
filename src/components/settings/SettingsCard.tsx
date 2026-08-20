// Shared layout primitives for the full-page settings sections: a grouped
// rounded card, and a row that reads "name + one-line description" on the left
// with its control on the right.

import { useState, type ReactNode } from "react";

// A labelled area inside a settings page, used where one page stacks several
// distinct surfaces (general, advanced) so they stay tellable apart.
export function SettingsBlock({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className="space-y-3">
      <BlockHeading title={title} description={description} />
      {children}
    </section>
  );
}

// Same block, closed by default. Its children are NOT mounted until the first
// expand, so a heavy surface (device enumeration, host probes) never runs its
// effects just because the user opened the page it lives on.
export function CollapsibleSettingsBlock({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);

  return (
    <section className="space-y-3">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className="flex w-full items-start gap-2 rounded px-1 py-1 text-left hover:bg-surface focus:outline-none focus:ring-1 focus:ring-accent"
      >
        <span
          aria-hidden="true"
          className="mt-0.5 text-[10px] text-text-dim"
        >
          {open ? "▾" : "▸"}
        </span>
        <BlockHeading title={title} description={description} />
      </button>
      {open && children}
    </section>
  );
}

function BlockHeading({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="min-w-0">
      <h3 className="text-xs font-semibold tracking-[0.08em] text-text">
        {title}
      </h3>
      <p className="mt-0.5 text-[11px] text-text-dim">{description}</p>
    </div>
  );
}

export function SettingsCard({
  title,
  action,
  children,
}: {
  title?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-md border border-border bg-surface">
      {title && (
        <div className="flex items-center justify-between gap-4 border-b border-border px-4 py-2.5">
          <h3 className="text-xs font-semibold text-text">{title}</h3>
          {action}
        </div>
      )}
      <div className="divide-y divide-border">{children}</div>
    </section>
  );
}

export function SettingsRow({
  name,
  description,
  children,
}: {
  name: string;
  description?: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-6 px-4 py-3">
      <div className="min-w-0">
        <div className="text-xs text-text">{name}</div>
        {description && (
          <p className="mt-0.5 text-[11px] text-text-dim">{description}</p>
        )}
      </div>
      {children && <div className="shrink-0">{children}</div>}
    </div>
  );
}

// Sections whose existing component owns its own internal layout (voice, local
// models, remote hosts, license) render inside this plain card body instead of
// the row grid, so they keep working untouched.
export function SettingsPanel({ children }: { children: ReactNode }) {
  return (
    <section className="rounded-md border border-border bg-surface px-4 py-3 text-xs">
      {children}
    </section>
  );
}
