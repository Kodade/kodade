import { projectColorHex } from "../projects/colors";

type ProjectColorSource = { id: string; color?: string };

export function hexToRgba(hex: string, opacity: number): string {
  const value = hex.replace("#", "");
  const red = Number.parseInt(value.slice(0, 2), 16);
  const green = Number.parseInt(value.slice(2, 4), 16);
  const blue = Number.parseInt(value.slice(4, 6), 16);
  return `rgba(${red}, ${green}, ${blue}, ${opacity})`;
}

export function projectTileStyle(
  project: ProjectColorSource,
  appearance: "dark" | "light",
): { color: string; backgroundColor: string } {
  const color = projectColorHex(project, appearance);
  return { color, backgroundColor: hexToRgba(color, 0.22) };
}

export function ProjectTile({
  project,
  appearance,
  size = 20,
}: {
  project: ProjectColorSource;
  appearance: "dark" | "light";
  size?: number;
}) {
  return (
    <span
      aria-hidden="true"
      className="flex shrink-0 items-center justify-center rounded-[5px]"
      style={{ width: size, height: size, ...projectTileStyle(project, appearance) }}
    >
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="h-3.5 w-3.5"
      >
        <path d="m4.5 5 2.5 3-2.5 3M9 11h2.5" />
      </svg>
    </span>
  );
}
