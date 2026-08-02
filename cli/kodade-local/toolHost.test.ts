/// <reference types="node" />

import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { resolveToolHostBinary, StdioToolHost } from "./toolHost";

const roots: string[] = [];

async function waitForFile(path: string): Promise<string> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    try {
      return await readFile(path, "utf8");
    } catch {
      await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    }
  }
  throw new Error(`timed out waiting for ${path}`);
}

async function waitForExit(pid: number): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  throw new Error(`process ${pid} did not exit`);
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("KödLocal native tool host", () => {
  it("honors the explicit env override and rejects a missing override", async () => {
    const root = await mkdtemp(join(tmpdir(), "kodade-tool-host-path-"));
    roots.push(root);
    const binary = join(root, process.platform === "win32" ? "kodade-tool-host.exe" : "kodade-tool-host");
    await writeFile(binary, "fixture", "utf8");
    if (process.platform !== "win32") await chmod(binary, 0o700);
    expect(resolveToolHostBinary({ env: { KODADE_TOOL_HOST_PATH: binary } })).toBe(binary);
    expect(() =>
      resolveToolHostBinary({ env: { KODADE_TOOL_HOST_PATH: join(root, "missing") } }),
    ).toThrow("does not point to a file");
  });

  it.skipIf(process.platform === "win32")(
    "correlates JSON-lines responses and surfaces native error envelopes",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "kodade-tool-host-"));
      roots.push(root);
      const binary = join(root, "fake-kodade-tool-host");
      await writeFile(
        binary,
        `#!/usr/bin/env node
const readline = require("node:readline").createInterface({ input: process.stdin });
readline.on("line", (line) => {
  const frame = JSON.parse(line);
  const response = frame.cmd === "fail"
    ? { id: frame.id, ok: false, error: "confined error" }
    : { id: frame.id, ok: true, result: frame.args };
  process.stdout.write(JSON.stringify(response) + "\\n");
});
`,
        "utf8",
      );
      await chmod(binary, 0o700);

      const host = new StdioToolHost(binary, root);
      await expect(host.call("echo", { value: 7 })).resolves.toEqual({ value: 7 });
      await expect(host.call("fail", {})).rejects.toThrow("confined error");
      await host.close();
    },
  );

  it.skipIf(process.platform === "win32")(
    "exits the spawned native tool host when the owning CLI terminates",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "kodade-tool-host-lifecycle-"));
      roots.push(root);
      const pidPath = join(root, "host.pid");
      const exitPath = join(root, "host.exited");
      const binary = join(root, "fake-kodade-tool-host");
      await writeFile(
        binary,
        `#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
process.stdin.resume();
process.stdin.on("end", () => fs.writeFileSync(${JSON.stringify(exitPath)}, "exited"));
`,
        "utf8",
      );
      await chmod(binary, 0o700);

      const fixture = join(root, "cli-fixture.ts");
      const moduleUrl = pathToFileURL(resolve("cli/kodade-local/toolHost.ts")).href;
      await writeFile(
        fixture,
        `import { StdioToolHost } from ${JSON.stringify(moduleUrl)};
new StdioToolHost(${JSON.stringify(binary)}, ${JSON.stringify(root)});
process.stdout.write("ready\\n");
setInterval(() => undefined, 1_000);
`,
        "utf8",
      );
      const cli = spawn(
        process.execPath,
        [resolve("node_modules/tsx/dist/cli.mjs"), fixture],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      let stderr = "";
      cli.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      let hostPid = 0;
      try {
        const started = await Promise.race([
          once(cli.stdout, "data").then(() => true),
          once(cli, "exit").then(() => false),
        ]);
        if (!started) throw new Error(`CLI fixture exited before ready: ${stderr}`);
        hostPid = Number((await waitForFile(pidPath)).trim());
        expect(Number.isSafeInteger(hostPid)).toBe(true);

        const cliExit = once(cli, "exit");
        cli.kill("SIGTERM");
        await cliExit;

        await expect(waitForFile(exitPath)).resolves.toBe("exited");
        await waitForExit(hostPid);
      } finally {
        if (cli.exitCode === null && cli.signalCode === null) cli.kill("SIGKILL");
        if (hostPid > 0) {
          try {
            process.kill(hostPid, "SIGKILL");
          } catch {
            // Already exited as required.
          }
        }
      }
    },
  );
});
