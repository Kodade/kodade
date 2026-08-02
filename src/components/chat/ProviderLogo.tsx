// Small brand badges for the agent CLIs — the t3-style "who am I talking to"
// glyphs the composer chips and menus render next to provider names. Drawn
// inline (no asset fetches, theme-independent); a provider without a bespoke
// glyph gets a monogram badge so new catalog entries never render blank.

const BADGE: Record<string, { bg: string; fg: string }> = {
  claude: { bg: "#D97757", fg: "#FFFFFF" }, // Anthropic coral
  codex: { bg: "#1A1A1A", fg: "#FFFFFF" },
  grok: { bg: "#000000", fg: "#FFFFFF" },
  opencode: { bg: "#2E3440", fg: "#E8EAF0" },
  ollama: { bg: "#ECECEC", fg: "#1A1A1A" },
  "kodade-local": { bg: "#E7A33B", fg: "#FFFFFF" }, // Ködade amber
};

const FALLBACK = { bg: "#3A3F58", fg: "#E8EAF0" };

export function ProviderLogo({
  providerId,
  size = 18,
}: {
  providerId: string;
  size?: number;
}) {
  const colors = BADGE[providerId] ?? FALLBACK;
  return (
    <span
      aria-hidden="true"
      className="flex shrink-0 items-center justify-center rounded-full"
      style={{
        width: size,
        height: size,
        backgroundColor: colors.bg,
        color: colors.fg,
      }}
    >
      <Glyph providerId={providerId} size={Math.round(size * 0.62)} />
    </span>
  );
}

function Glyph({ providerId, size }: { providerId: string; size: number }) {
  switch (providerId) {
    case "claude":
      // The Claude spark: an eight-ray starburst.
      return (
        <svg
          viewBox="0 0 16 16"
          width={size}
          height={size}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.9"
          strokeLinecap="round"
        >
          <path d="M8 2.1v11.8M2.1 8h11.8M3.8 3.8l8.4 8.4M12.2 3.8l-8.4 8.4" />
        </svg>
      );
    case "codex":
      // Hexagonal knot, the OpenAI shape family.
      return (
        <svg
          viewBox="0 0 16 16"
          width={size}
          height={size}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinejoin="round"
        >
          <path d="M8 1.9 13.3 5v6L8 14.1 2.7 11V5Z" />
          <path d="M8 5.4 10.3 6.7v2.6L8 10.6 5.7 9.3V6.7Z" />
        </svg>
      );
    case "grok":
      // The xAI slash mark: one full diagonal, one broken.
      return (
        <svg
          viewBox="0 0 16 16"
          width={size}
          height={size}
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        >
          <path d="M12.6 3.4 3.4 12.6M3.4 3.4l3.3 3.3M9.6 9.6l3 3" />
        </svg>
      );
    case "opencode":
      return (
        <svg
          viewBox="0 0 16 16"
          width={size}
          height={size}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.9"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="m3.5 4.5 4 3.5-4 3.5M9.5 12.5h3" />
        </svg>
      );
    default:
      return (
        <span
          style={{ fontSize: Math.max(7, Math.round(size * 0.72)) }}
          className="font-semibold leading-none"
        >
          {monogram(providerId)}
        </span>
      );
  }
}

// "kodade-local" → "kö" would need the umlaut ASCII-side, so monograms come
// from display-safe initials of the id's segments.
function monogram(providerId: string): string {
  const segments = providerId.split(/[-_ ]+/).filter(Boolean);
  if (segments.length >= 2) return (segments[0][0] + segments[1][0]).toLowerCase();
  return providerId.slice(0, 2).toLowerCase();
}
