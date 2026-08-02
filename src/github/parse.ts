export type GithubItem = {
  number: number;
  title: string;
  author: string;
  labels: string[];
  updatedAt: string;
};

export type AuthStatus = "missing" | "unauthenticated" | "ok";

export function parseAuthStatus(result: {
  ok: boolean;
  error?: unknown;
}): AuthStatus {
  if (result.ok) return "ok";
  const message = errorMessage(result.error).toLowerCase();
  if (
    message.includes("gh is not installed") ||
    message.includes("command not found") ||
    message.includes("no such file")
  ) {
    return "missing";
  }
  return "unauthenticated";
}

export function parseGithubList(raw: string): GithubItem[] {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("gh returned malformed JSON");
  }
  if (!Array.isArray(value)) throw new Error("gh returned malformed JSON");
  return value.map((entry) => {
    if (!entry || typeof entry !== "object") throw new Error("gh returned malformed JSON");
    const item = entry as Record<string, unknown>;
    const author = item.author as Record<string, unknown> | null | undefined;
    if (
      typeof item.number !== "number" ||
      typeof item.title !== "string" ||
      typeof item.updatedAt !== "string" ||
      !Array.isArray(item.labels)
    ) {
      throw new Error("gh returned malformed JSON");
    }
    const labels = item.labels.map((label) => {
      if (
        !label ||
        typeof label !== "object" ||
        typeof (label as Record<string, unknown>).name !== "string"
      ) {
        throw new Error("gh returned malformed JSON");
      }
      return (label as { name: string }).name;
    });
    return {
      number: item.number,
      title: item.title,
      author: author && typeof author.login === "string" ? author.login : "ghost",
      labels,
      updatedAt: item.updatedAt,
    };
  });
}

export function parseGithubRepoUrl(raw: string): string {
  try {
    const value = JSON.parse(raw) as { url?: unknown };
    if (typeof value.url !== "string") throw new Error();
    const url = new URL(value.url);
    if (url.protocol !== "https:" || url.hostname !== "github.com") throw new Error();
    return value.url.replace(/\.git\/?$/, "").replace(/\/$/, "");
  } catch {
    throw new Error("gh returned malformed repository JSON");
  }
}

export function isNoGithubRemoteError(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase();
  return [
    "no remotes found",
    "no git remotes found",
    "not a git repository",
    "unable to determine current repository",
    "do not point to a known github host",
  ].some((fragment) => message.includes(fragment));
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? "unknown error");
}
