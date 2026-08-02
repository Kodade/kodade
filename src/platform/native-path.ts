// Native path operations shared by stores and views. Paths stay in the OS form
// returned by Rust; this module only interprets separators and components.

type ParsedPath = {
  root: string;
  comparisonRoot: string;
  parts: string[];
  separator: "/" | "\\";
  windows: boolean;
  verbatim: boolean;
};

const DRIVE_ROOT = /^[A-Za-z]:\\/;
const RESERVED_WINDOWS_NAME =
  /^(con|prn|aux|nul|com(?:[1-9¹²³])|lpt(?:[1-9¹²³]))(?:\.|$)/i;
const INVALID_WINDOWS_CHAR = /[<>:"/\\|?*\u0000-\u001f]/;

export function isWindowsNativePath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\");
}

function parseAbsolute(path: string): ParsedPath | null {
  if (isWindowsNativePath(path)) {
    const verbatim = path.startsWith("\\\\?\\");
    // The verbatim namespace deliberately disables slash conversion and dot
    // component expansion. Only normalize separators for normal Win32 paths.
    const value = verbatim ? path : path.replaceAll("/", "\\");
    let root = "";
    let comparisonRoot = "";
    let rest = "";

    if (/^\\\\\?\\UNC\\/i.test(value)) {
      const prefix = "\\\\?\\UNC\\";
      const components = value.slice(prefix.length).split("\\").filter(Boolean);
      if (components.length < 2) return null;
      root = `${prefix}${components[0]}\\${components[1]}\\`;
      comparisonRoot = `\\\\${components[0]}\\${components[1]}\\`;
      rest = components.slice(2).join("\\");
    } else if (/^\\\\\?\\[A-Za-z]:\\/i.test(value)) {
      root = value.slice(0, 7);
      comparisonRoot = value.slice(4, 7);
      rest = value.slice(7);
    } else if (verbatim || value.startsWith("\\\\.\\")) {
      // Device namespaces and unsupported verbatim roots are not file paths
      // that Kodade can safely persist or compare.
      return null;
    } else if (value.startsWith("\\\\")) {
      const components = value.slice(2).split("\\").filter(Boolean);
      if (components.length < 2) return null;
      root = `\\\\${components[0]}\\${components[1]}\\`;
      comparisonRoot = root;
      rest = components.slice(2).join("\\");
    } else if (DRIVE_ROOT.test(value)) {
      root = value.slice(0, 3);
      comparisonRoot = root;
      rest = value.slice(3);
    } else {
      return null;
    }

    return {
      root,
      comparisonRoot,
      parts: verbatim ? literalParts(rest.split("\\")) : collapse(rest.split("\\")),
      separator: "\\",
      windows: true,
      verbatim,
    };
  }

  if (!path.startsWith("/")) return null;
  return {
    root: "/",
    comparisonRoot: "/",
    parts: collapse(path.split("/")),
    separator: "/",
    windows: false,
    verbatim: false,
  };
}

function literalParts(raw: string[]): string[] {
  return raw.filter((part) => part !== "");
}

function collapse(raw: string[]): string[] {
  const parts: string[] = [];
  for (const part of raw) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return parts;
}

function render(path: ParsedPath): string {
  if (path.parts.length === 0) return path.root;
  return path.root + path.parts.join(path.separator);
}

function comparable(path: string): string {
  const parsed = parseAbsolute(path);
  if (!parsed) return "";
  const value = parsed.comparisonRoot + parsed.parts.join(parsed.separator);
  return parsed.windows ? value.toLocaleLowerCase("en-US") : value;
}

export function normalizeNativeAbsolutePath(path: string): string {
  const parsed = parseAbsolute(path);
  return parsed ? render(parsed) : "";
}

export function nativeEquals(left: string, right: string): boolean {
  const a = comparable(left);
  return a !== "" && a === comparable(right);
}

export function nativeIsDescendant(path: string, directory: string): boolean {
  const child = parseAbsolute(path);
  const parent = parseAbsolute(directory);
  if (!child || !parent || child.windows !== parent.windows) return false;
  const childRoot = child.windows
    ? child.comparisonRoot.toLocaleLowerCase("en-US")
    : child.comparisonRoot;
  const parentRoot = parent.windows
    ? parent.comparisonRoot.toLocaleLowerCase("en-US")
    : parent.comparisonRoot;
  if (childRoot !== parentRoot || child.parts.length <= parent.parts.length) return false;
  return parent.parts.every((part, index) =>
    child.windows
      ? part.toLocaleLowerCase("en-US") === child.parts[index].toLocaleLowerCase("en-US")
      : part === child.parts[index],
  );
}

export function nativeBasename(path: string): string {
  const parsed = parseAbsolute(path);
  if (parsed) return parsed.parts.at(-1) ?? parsed.root;
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

export function nativeDirname(path: string): string | null {
  const parsed = parseAbsolute(path);
  if (!parsed || parsed.parts.length === 0) return null;
  parsed.parts.pop();
  return render(parsed);
}

export function nativeJoin(parent: string, name: string): string {
  const parsed = parseAbsolute(parent);
  if (!parsed) return parent + (isWindowsNativePath(parent) ? "\\" : "/") + name;
  parsed.parts.push(name);
  return render(parsed);
}

// Return PATH relative to DIRECTORY while preserving the path's native case
// and separators. Comparison follows native Windows rules, but the returned
// value is never lowercased or slash-normalized in TypeScript.
export function nativeRelativePath(path: string, directory: string): string | null {
  if (!nativeIsDescendant(path, directory)) return null;
  const child = parseAbsolute(path)!;
  const parent = parseAbsolute(directory)!;
  return child.parts.slice(parent.parts.length).join(child.separator);
}

export function remapNativePath(path: string, from: string, to: string): string | null {
  if (nativeEquals(path, from)) return normalizeNativeAbsolutePath(to) || to;
  if (!nativeIsDescendant(path, from)) return null;
  const source = parseAbsolute(path)!;
  const prefix = parseAbsolute(from)!;
  const destination = parseAbsolute(to);
  if (!destination) return null;
  destination.parts.push(...source.parts.slice(prefix.parts.length));
  return render(destination);
}

export function validateNativeName(name: string, parent: string): string | null {
  if (name.includes("/") || name.includes("\\")) return 'name cannot contain "/" or "\\"';
  if (!isWindowsNativePath(parent)) return null;
  if (INVALID_WINDOWS_CHAR.test(name)) return "name contains a character Windows does not allow";
  if (/[. ]$/.test(name)) return "Windows names cannot end with a dot or space";
  if (RESERVED_WINDOWS_NAME.test(name)) return "that name is reserved by Windows";
  return null;
}
