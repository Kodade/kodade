// Shared layout primitives for the full-page settings sections: a grouped
// rounded card, and a row that reads "name + one-line description" on the left
// with its control on the right.

import type { ReactNode } from "react";

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
