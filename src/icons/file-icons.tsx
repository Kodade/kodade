import type { SVGProps } from "react";

export type Category =
  | "code"
  | "markup"
  | "style"
  | "config"
  | "image"
  | "document"
  | "lockfile"
  | "shell"
  | "pdf"
  | "generic"
  | "folder-open"
  | "folder-closed";

const CATEGORY_BY_EXTENSION: Record<string, Category> = {
  ts: "code",
  tsx: "code",
  js: "code",
  jsx: "code",
  mjs: "code",
  cjs: "code",
  rs: "code",
  py: "code",
  go: "code",
  java: "code",
  c: "code",
  h: "code",
  cpp: "code",
  hpp: "code",
  json: "config",
  yaml: "config",
  yml: "config",
  toml: "config",
  ini: "config",
  env: "config",
  md: "markup",
  mdx: "markup",
  html: "markup",
  htm: "markup",
  css: "style",
  scss: "style",
  sass: "style",
  less: "style",
  svg: "image",
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  ico: "image",
  txt: "document",
  rtf: "document",
  doc: "document",
  docx: "document",
  lock: "lockfile",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  fish: "shell",
  pdf: "pdf",
};

const NAME_CATEGORIES: Record<string, Category> = {
  "package-lock.json": "lockfile",
  "pnpm-lock.yaml": "lockfile",
  "yarn.lock": "lockfile",
  "bun.lockb": "lockfile",
  "cargo.lock": "lockfile",
  ".gitignore": "config",
  ".gitattributes": "config",
  ".env": "config",
  ".bashrc": "shell",
  ".zshrc": "shell",
  ".zprofile": "shell",
  dockerfile: "config",
  makefile: "shell",
  license: "document",
  readme: "markup",
};

export function iconCategoryFor(path: string): Category {
  const name = path.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  if (NAME_CATEGORIES[name]) return NAME_CATEGORIES[name];
  if (name.startsWith(".env.")) return "config";
  const extension = name.split(".").pop() ?? "";
  return CATEGORY_BY_EXTENSION[extension] ?? "generic";
}

// Category -> theme-derived tint (see applyCssVars in themes/applier.ts).
// Neutral categories (generic/document/lockfile) stay on currentColor so the
// tree keeps a quiet baseline; the fallback keeps icons legible if a variable
// is ever unset (headless tests, first frame).
const CATEGORY_COLOR: Partial<Record<Category, string>> = {
  "folder-open": "var(--kd-icon-folder, currentColor)",
  "folder-closed": "var(--kd-icon-folder, currentColor)",
  code: "var(--kd-icon-code, currentColor)",
  markup: "var(--kd-icon-markup, currentColor)",
  style: "var(--kd-icon-style, currentColor)",
  config: "var(--kd-icon-config, currentColor)",
  image: "var(--kd-icon-image, currentColor)",
  shell: "var(--kd-icon-shell, currentColor)",
  pdf: "var(--kd-icon-pdf, currentColor)",
};

export function FileIcon({
  category,
  className,
  style,
  ...props
}: { category: Category } & SVGProps<SVGSVGElement>) {
  const color = CATEGORY_COLOR[category];
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={color ? { color, ...style } : style}
      {...props}
    >
      <IconGlyph category={category} />
    </svg>
  );
}

function IconGlyph({ category }: { category: Category }) {
  switch (category) {
    case "code":
      return (
        <>
          <path d="m6 4-4 4 4 4" />
          <path d="m10 4 4 4-4 4" />
        </>
      );
    case "markup":
      return <>
        <path d="M3 1.75h6.5L13 5.25v9H3z" />
        <path d="M9.5 1.75v3.5H13" />
        <path d="M5.5 8h5M5.5 10.5h3.5" />
      </>;
    case "style":
      return <>
        <path d="M3 1.75h6.5L13 5.25v9H3z" />
        <path d="M9.5 1.75v3.5H13" />
        <path d="M5.25 8.25h5.5M5.25 10.5h4" />
      </>;
    case "config":
      return <>
        <path d="M3 1.75h6.5L13 5.25v9H3z" />
        <path d="M9.5 1.75v3.5H13" />
        <path d="M5.25 8h5.5M5.25 10.5h5.5" />
      </>;
    case "image":
      return <>
        <rect x="2" y="2.5" width="12" height="11" rx="1" />
        <circle cx="5.25" cy="5.75" r="1" />
        <path d="m3 12 3.25-3 2.25 2 1.5-1.5L13 12.5" />
      </>;
    case "document":
      return <>
        <path d="M3 1.75h6.5L13 5.25v9H3z" />
        <path d="M9.5 1.75v3.5H13" />
        <path d="M5.25 8h5.5M5.25 10.5h5.5" />
      </>;
    case "lockfile":
      return <>
        <rect x="3.25" y="7" width="9.5" height="6.25" rx="1" />
        <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
        <path d="M8 9.5v1.25" />
      </>;
    case "shell":
      return <>
        <rect x="1.75" y="2.5" width="12.5" height="11" rx="1.5" />
        <path d="m4.5 6 2 2-2 2M8.75 10h2.75" />
      </>;
    case "pdf":
      return <>
        <path d="M3 1.75h6.5L13 5.25v9H3z" />
        <path d="M9.5 1.75v3.5H13" />
        <path d="M5.25 10.75V8h1.3a.9.9 0 0 1 0 1.8h-1.3M8.25 10.75V8h.85a1.38 1.38 0 0 1 0 2.75h-.85M11.5 10.75V8h1.25" />
      </>;
    case "folder-open":
      return <>
        <path d="M1.75 5.25h4l1.3-1.75h3.2l1.25 1.75h2.75v7.25H1.75z" />
        <path d="M1.75 6.75h12.5" />
      </>;
    case "folder-closed":
      return <path d="M1.75 4.25h4l1.3-1.75h3.2l1.25 1.75h2.75v7.25H1.75z" />;
    case "generic":
      return <>
        <path d="M3 1.75h6.5L13 5.25v9H3z" />
        <path d="M9.5 1.75v3.5H13" />
      </>;
  }
}
