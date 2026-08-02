import { PROJECT_COLORS } from "../../projects/colors";

export function ProjectColorChoices({
  appearance,
  selectedColor,
  onSelect,
}: {
  appearance: "dark" | "light";
  selectedColor: string | undefined;
  onSelect(colorId: string | null): void;
}) {
  return (
    <>
      {PROJECT_COLORS.map((color) => (
        <button
          key={color.id}
          type="button"
          aria-label={color.name}
          aria-pressed={selectedColor === color.id}
          onClick={() => onSelect(color.id)}
          className="flex h-6 items-center justify-center rounded text-[10px] text-text-dim hover:bg-surface-hover focus:outline-none focus:ring-1 focus:ring-accent"
        >
          <span
            data-project-color-swatch
            aria-hidden="true"
            className="h-3 w-3 rounded-[3px]"
            style={{ backgroundColor: color[appearance] }}
          />
        </button>
      ))}
      <button
        type="button"
        aria-label="Auto color"
        aria-pressed={!selectedColor}
        onClick={() => onSelect(null)}
        className="h-6 rounded text-[10px] text-text-dim hover:bg-surface-hover focus:outline-none focus:ring-1 focus:ring-accent"
      >
        auto
      </button>
    </>
  );
}
