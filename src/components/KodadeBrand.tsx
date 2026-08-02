import { KODADE_AMBER } from "../themes/brand";

type KodadeMarkProps = {
  /** Height of each rounded-square dot, in pixels. */
  size?: number;
  className?: string;
};

// The standalone umlaut mark. Its amber now anchors the app's active accents.
export function KodadeMark({ size = 12, className }: KodadeMarkProps) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      height={size}
      viewBox="0 0 22 10"
      width={size * 2.2}
    >
      <rect width="10" height="10" rx="2.5" fill={KODADE_AMBER} />
      <rect x="12" width="10" height="10" rx="2.5" fill="currentColor" />
    </svg>
  );
}

export function KodadeWordmark({ className }: { className?: string }) {
  return (
    <span
      className={className}
      style={{ fontFamily: '"JetBrains Mono", ui-monospace, monospace', fontWeight: 700, letterSpacing: "-0.02em" }}
    >
      ködade
    </span>
  );
}
