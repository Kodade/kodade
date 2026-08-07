// One 16px stroke icon per settings section (plus the gear used by the sidebar
// entry). Kept together so the registry stays a flat list of data.

import type { ReactNode } from "react";

function Icon({ children }: { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 16 16"
      className="h-4 w-4 shrink-0"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export function GearIcon() {
  return (
    <Icon>
      <circle cx="8" cy="8" r="2.25" />
      <path d="M8 2.5v1.25M8 12.25v1.25M13.5 8h-1.25M3.75 8H2.5M11.9 4.1l-.9.9M5 11l-.9.9M11.9 11.9l-.9-.9M5 5l-.9-.9" />
    </Icon>
  );
}

export function ChatIcon() {
  return (
    <Icon>
      <path d="M13.5 10.5a1 1 0 0 1-1 1H6l-2.5 2.25V11.5a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1z" />
    </Icon>
  );
}

export function SlidersIcon() {
  return (
    <Icon>
      <path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" />
      <circle cx="6" cy="4.5" r="1.25" />
      <circle cx="10" cy="8" r="1.25" />
      <circle cx="5" cy="11.5" r="1.25" />
    </Icon>
  );
}

export function PluginIcon() {
  return (
    <Icon>
      <path d="M3 6.5h10v6H3z" />
      <path d="M5.5 6.5V3.5M10.5 6.5V3.5" />
    </Icon>
  );
}

export function HarnessGlyph() {
  return (
    <Icon>
      <path d="M3 3.5h10v9H3z" />
      <path d="M5.5 6.5l1.5 1.5-1.5 1.5M8.5 9.5h2.5" />
    </Icon>
  );
}

export function MemoryGlyph() {
  return (
    <Icon>
      <path d="M4 3.25h8.5v9.5H5.75A1.75 1.75 0 0 0 4 14.5V3.25Z" />
      <path d="M4 11.75A1.75 1.75 0 0 1 5.75 10h6.75M6.75 5.5h3M6.75 7.5h3.75" />
    </Icon>
  );
}

export function ChipIcon() {
  return (
    <Icon>
      <path d="M5 5h6v6H5z" />
      <path d="M6.5 2.5v2.5M9.5 2.5v2.5M6.5 11v2.5M9.5 11v2.5M2.5 6.5H5M2.5 9.5H5M11 6.5h2.5M11 9.5h2.5" />
    </Icon>
  );
}

export function MicIcon() {
  return (
    <Icon>
      <path d="M8 2.5a1.75 1.75 0 0 1 1.75 1.75v3.5a1.75 1.75 0 0 1-3.5 0v-3.5A1.75 1.75 0 0 1 8 2.5z" />
      <path d="M4.5 7.5a3.5 3.5 0 0 0 7 0M8 11.5v2" />
    </Icon>
  );
}

export function RemoteIcon() {
  return (
    <Icon>
      <path d="M2.5 3.5h11v3h-11zM2.5 9.5h11v3h-11z" />
      <path d="M4.5 5h.01M4.5 11h.01" />
    </Icon>
  );
}

export function WebIcon() {
  return (
    <Icon>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M2.75 8h10.5M8 2.5c1.5 1.5 2.25 3.35 2.25 5.5S9.5 12 8 13.5M8 2.5C6.5 4 5.75 5.85 5.75 8S6.5 12 8 13.5" />
    </Icon>
  );
}

export function KeyboardIcon() {
  return (
    <Icon>
      <path d="M2 4.5h12v7H2z" />
      <path d="M4.5 7h.01M7 7h.01M9.5 7h.01M11.5 7h.01M5 9.5h6" />
    </Icon>
  );
}

