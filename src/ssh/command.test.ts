import { describe, expect, it } from "vitest";
import {
  assertHost,
  buildRemoteAgentSpawn,
  buildRemoteExec,
  buildRemoteListArgv,
  buildRemotePreviewArgv,
  buildRemoteProgramLaunch,
  buildSshLaunch,
  buildSshProjectLaunch,
  parseAdHocHost,
  quotePosix,
  quoteRemoteArgv,
} from "./command";

describe("buildSshLaunch", () => {
  it("builds `ssh -t <alias>` for a config host, ignoring its display metadata", () => {
    expect(
      buildSshLaunch({
        alias: "box",
        hostName: "1.2.3.4",
        user: "keith",
        port: 2222,
      }),
    ).toBe("ssh -t box");
  });

  it("builds `ssh -t user@host` for an ad-hoc target", () => {
    expect(buildSshLaunch("keith@1.2.3.4")).toBe("ssh -t keith@1.2.3.4");
  });

  it("builds `ssh -t host` for an ad-hoc target with no user", () => {
    expect(buildSshLaunch("buildbox")).toBe("ssh -t buildbox");
  });

  it("adds -p for an ad-hoc target with a port", () => {
    expect(buildSshLaunch("keith@1.2.3.4:2222")).toBe(
      "ssh -t keith@1.2.3.4 -p 2222",
    );
  });

  it.each([
    ["embedded space", "keith@1.2.3.4 rm -rf /"],
    ["double quote", 'keith@"host"'],
    ["single quote", "keith@'host'"],
    ["semicolon", "keith@host;rm -rf /"],
    ["command substitution", "keith@$(rm -rf /)"],
    ["backtick substitution", "keith@`rm -rf /`"],
    ["leading dash (flag injection)", "-oProxyCommand=evil"],
    ["empty string", ""],
    ["whitespace only", "   "],
    ["multiple @", "a@b@c"],
    ["multiple colons", "host:1:2"],
    ["port out of range", "host:99999"],
    ["non-numeric port", "host:abc"],
  ])("rejects hostile/malformed input: %s", (_label, input) => {
    expect(() => buildSshLaunch(input)).toThrow(/invalid host/);
  });

  it("rejects a hostile alias from an SshHost object too (defense in depth)", () => {
    expect(() => buildSshLaunch({ alias: "-oProxyCommand=evil" })).toThrow(
      /invalid host/,
    );
  });
});

describe("parseAdHocHost", () => {
  it("parses user@host:port", () => {
    expect(parseAdHocHost("keith@box.local:2200")).toEqual({
      user: "keith",
      host: "box.local",
      port: 2200,
    });
  });

  it("parses a bare host with no user or port", () => {
    expect(parseAdHocHost("box.local")).toEqual({
      user: undefined,
      host: "box.local",
    });
  });

  it("returns null (never throws) for hostile input", () => {
    expect(parseAdHocHost("keith@host; rm -rf /")).toBeNull();
    expect(parseAdHocHost("")).toBeNull();
    expect(parseAdHocHost("-x")).toBeNull();
  });
});

describe("quotePosix", () => {
  it("wraps a plain string in single quotes", () => {
    expect(quotePosix("hello")).toBe("'hello'");
  });

  it("escapes embedded single quotes with the '\"'\"' technique", () => {
    expect(quotePosix("it's")).toBe(`'it'"'"'s'`);
  });

  it("neutralizes shell metacharacters by treating them as literal bytes", () => {
    expect(quotePosix("$(rm -rf /); echo pwned")).toBe(
      "'$(rm -rf /); echo pwned'",
    );
  });

  it("handles an empty string", () => {
    expect(quotePosix("")).toBe("''");
  });
});

describe("buildRemoteExec", () => {
  it("builds the ssh_exec argv vector with quoted argv elements", () => {
    expect(
      buildRemoteExec({ host: "box", path: "/home/keith/app" }, [
        "echo",
        "hi there",
      ]),
    ).toEqual(["-o", "BatchMode=yes", "box", "--", "'echo'", "'hi there'"]);
  });

  it("single-quotes an argv element containing a single quote", () => {
    expect(buildRemoteExec({ host: "box", path: "/x" }, ["it's"])).toEqual([
      "-o",
      "BatchMode=yes",
      "box",
      "--",
      `'it'"'"'s'`,
    ]);
  });

  it("rejects a hostile host in the RemoteTarget", () => {
    expect(() =>
      buildRemoteExec({ host: "box; rm -rf /", path: "/x" }, ["ls"]),
    ).toThrow(/invalid host/);
  });

  it("rejects an empty argv element list gracefully (no argv -> just the -- marker)", () => {
    expect(buildRemoteExec({ host: "box", path: "/x" }, [])).toEqual([
      "-o",
      "BatchMode=yes",
      "box",
      "--",
    ]);
  });
});

describe("buildRemoteProgramLaunch", () => {
  it("quotes each selected backend argument for the remote shell", () => {
    expect(
      buildRemoteProgramLaunch("kodade-local", [
        "--base-url",
        "https://gpu.example.test/v1?box=$(nope)",
      ]),
    ).toBe(
      "exec 'kodade-local' '--base-url' 'https://gpu.example.test/v1?box=$(nope)'",
    );
  });

  it("rejects a program name that is not a catalog-style executable", () => {
    expect(() =>
      buildRemoteProgramLaunch("kodade-local; rm -rf /", []),
    ).toThrow(/invalid remote program/);
  });
});

describe("buildRemoteAgentSpawn", () => {
  it("expands a saved home-relative path before starting the headless agent", () => {
    const spawn = buildRemoteAgentSpawn(
      { host: "studio", path: "~/code/projects" },
      "claude",
      ["-p"],
    );

    expect(spawn.args.at(-1)).toBe(
      `cd "$HOME"/'code/projects' && exec 'claude' '-p'`,
    );
  });

  it("runs the headless agent in the pinned project over non-interactive SSH", () => {
    expect(
      buildRemoteAgentSpawn(
        { host: "studio", path: "/srv/kodade" },
        "claude",
        ["-p", "--output-format", "stream-json"],
      ),
    ).toEqual({
      bin: "ssh",
      args: [
        "-o",
        "BatchMode=yes",
        "-T",
        "studio",
        "--",
        "cd '/srv/kodade' && exec 'claude' '-p' '--output-format' 'stream-json'",
      ],
    });
  });

  it("quotes the path and every agent argument and rejects hostile hosts", () => {
    const spawn = buildRemoteAgentSpawn(
      { host: "box", path: "/srv/it's $(safe)" },
      "codex",
      ["exec", "--model", "name; touch nope"],
    );
    expect(spawn.args.at(-1)).toBe(
      `cd '/srv/it'"'"'s $(safe)' && exec 'codex' 'exec' '--model' 'name; touch nope'`,
    );
    expect(() =>
      buildRemoteAgentSpawn(
        { host: "-oProxyCommand=evil", path: "/srv/app" },
        "codex",
        [],
      ),
    ).toThrow(/invalid host/);
  });
});

describe("quoteRemoteArgv", () => {
  it("single-quotes each element (survives the ssh_exec host+argv split)", () => {
    expect(quoteRemoteArgv(["command", "-v", "claude"])).toEqual([
      "'command'",
      "'-v'",
      "'claude'",
    ]);
  });

  it("keeps the bare bin name recoverable inside the quotes (mock keys on it)", () => {
    // The detection MockSsh scripts outcomes by matching the bin substring in
    // the joined argv, so quoting must not obscure it.
    expect(quoteRemoteArgv(["command", "-v", "codex"]).join(" ")).toContain(
      "codex",
    );
  });
});

describe("assertHost", () => {
  it("returns a valid host unchanged", () => {
    expect(assertHost("build-box")).toBe("build-box");
    expect(assertHost("keith@1.2.3.4")).toBe("keith@1.2.3.4");
  });

  it("throws on a hostile host (defense in depth mirroring Rust)", () => {
    expect(() => assertHost("-oProxyCommand=evil")).toThrow(/invalid host/);
    expect(() => assertHost("box; rm -rf /")).toThrow(/invalid host/);
    expect(() => assertHost("")).toThrow(/invalid host/);
  });
});

// Minimal POSIX-ish word splitter standing in for the LOCAL shell the launch
// line is typed into: honors single- and double-quoted spans (the only quoting
// quotePosix emits), splits on spaces otherwise. Lets tests assert what the
// local shell would actually hand ssh as discrete arguments.
function shellWords(line: string): string[] {
  const words: string[] = [];
  let current = "";
  let inWord = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "'" || c === '"') {
      inWord = true;
      i++;
      while (i < line.length && line[i] !== c) {
        current += line[i];
        i++;
      }
    } else if (c === " ") {
      if (inWord) words.push(current);
      current = "";
      inWord = false;
    } else {
      inWord = true;
      current += c;
    }
  }
  if (inWord) words.push(current);
  return words;
}

describe("buildSshProjectLaunch", () => {
  it("expands a saved home-relative project path on the remote host", () => {
    const launch = buildSshProjectLaunch(
      { host: "studio", path: "~/code/projects" },
      undefined,
      "posix",
    );

    expect(shellWords(launch)).toEqual([
      "ssh",
      "-t",
      "studio",
      `cd "$HOME"/'code/projects' && exec "$SHELL" -l`,
    ]);
  });

  it("wraps the whole remote command (cd && exec) as ONE local argument", () => {
    // Explicit "posix" throughout this describe block: happy-dom's navigator
    // reports a non-Mac platform, so the default (OS-detected) localShell
    // would otherwise resolve to "powershell" here — see the dedicated
    // Windows describe block below for that branch.
    const launch = buildSshProjectLaunch(
      { host: "box", path: "/home/keith/app" },
      undefined,
      "posix",
    );
    expect(launch).toBe(
      `ssh -t box 'cd '"'"'/home/keith/app'"'"' && exec "$SHELL" -l'`,
    );
    // What the LOCAL shell hands ssh: exactly [ssh, -t, box, <remote command>].
    // The `&&`, the cd path, and $SHELL all live INSIDE that single quoted
    // argument, so the REMOTE shell — never the local one — interprets them.
    expect(shellWords(launch)).toEqual([
      "ssh",
      "-t",
      "box",
      `cd '/home/keith/app' && exec "$SHELL" -l`,
    ]);
  });

  it("runs a provider launch instead when a remote command is given", () => {
    const launch = buildSshProjectLaunch(
      { host: "box", path: "/srv/api" },
      "exec claude",
      "posix",
    );
    expect(launch).toBe(`ssh -t box 'cd '"'"'/srv/api'"'"' && exec claude'`);
    expect(shellWords(launch)).toEqual([
      "ssh",
      "-t",
      "box",
      `cd '/srv/api' && exec claude`,
    ]);
  });

  it.each([
    ["spaces", "/home/keith/my app"],
    ["single quote", "/home/it's"],
    ["semicolon", "/tmp/x;rm -rf /"],
    ["command substitution", "/tmp/$(rm -rf /)"],
    ["double quote", '/tmp/a"b'],
  ])("neutralizes a hostile path (%s) through BOTH quoting layers", (_label, path) => {
    const launch = buildSshProjectLaunch({ host: "box", path }, undefined, "posix");
    // Local layer: still exactly one remote-command argument after `ssh -t box`
    // — no hostile byte escapes the outer single-quoting onto the local line.
    const local = shellWords(launch);
    expect(local).toHaveLength(4);
    expect(local.slice(0, 3)).toEqual(["ssh", "-t", "box"]);
    expect(local[3]).toBe(`cd ${quotePosix(path)} && exec "$SHELL" -l`);
    // Remote layer: when the remote shell splits that argument, the path comes
    // back byte-for-byte as cd's single operand (nested quoting held).
    expect(shellWords(local[3])[1]).toBe(path);
  });

  it("nests the '\"'\"' escaping correctly for a path containing a single quote", () => {
    const launch = buildSshProjectLaunch({ host: "box", path: "/home/it's" }, undefined, "posix");
    const local = shellWords(launch);
    expect(local).toHaveLength(4);
    expect(shellWords(local[3])).toEqual(["cd", "/home/it's", "&&", "exec", "$SHELL", "-l"]);
  });

  it("rejects a hostile host before building anything", () => {
    expect(() => buildSshProjectLaunch({ host: "box; rm -rf /", path: "/x" })).toThrow(
      /invalid host/,
    );
  });

  // M11e: the outer (LOCAL shell) quoting must match whatever shell
  // launchInSession actually types the line into. POSIX quoting typed into a
  // Windows local shell is the bug this branch fixes — PowerShell doesn't
  // understand '"'"' escaping and cmd doesn't treat single quotes as quoting
  // at all, so unconditionally reusing quotePosix as the outer layer breaks
  // (or silently mis-parses) the line on Windows.
  describe("Windows local-shell outer quoting", () => {
    it("wraps the remote command with PowerShell single-quote escaping", () => {
      const launch = buildSshProjectLaunch(
        { host: "box", path: "/home/keith/app" },
        undefined,
        "powershell",
      );
      // Inner layer (remote/POSIX) is unchanged: cd's argument is still
      // POSIX single-quoted (quotePosix wraps the path in '...'). Outer layer
      // (PowerShell) wraps THAT string in its own single quotes, doubling the
      // two `'` characters quotePosix already emitted around the path.
      const inner = `cd ${quotePosix("/home/keith/app")} && exec "$SHELL" -l`;
      expect(launch).toBe(`ssh -t box '${inner.replace(/'/g, "''")}'`);
    });

    it("doubles an embedded single quote for PowerShell (never '\"'\"')", () => {
      const launch = buildSshProjectLaunch(
        { host: "box", path: "/home/it's" },
        undefined,
        "powershell",
      );
      // Inner POSIX quoting still wraps the path for the remote shell; the
      // OUTER PowerShell layer doubles the ' that closes/reopens the inner
      // POSIX escape, instead of emitting POSIX's '"'"' sequence (which
      // PowerShell would parse as string-end + two bogus tokens).
      const inner = `cd ${quotePosix("/home/it's")} && exec "$SHELL" -l`;
      expect(launch).toBe(`ssh -t box '${inner.replace(/'/g, "''")}'`);
      expect(launch).not.toContain(`'"'"'`);
    });

    it("wraps the remote command in cmd-safe double quotes", () => {
      const launch = buildSshProjectLaunch(
        { host: "box", path: "/srv/api" },
        "exec claude",
        "cmd",
      );
      const inner = `cd ${quotePosix("/srv/api")} && exec claude`;
      // cmd has no single-quote quoting, so the outer wrap must be double
      // quotes (which DO suppress cmd's own &/| handling for the span); any
      // embedded " is backslash-escaped for the receiving argv parser.
      expect(launch).toBe(`ssh -t box "${inner.replace(/"/g, '\\"')}"`);
    });

    it("omitting localShell falls back to OS detection, not the old hardcoded POSIX path", () => {
      // Regression guard for the actual M11e bug: pre-fix, buildSshProjectLaunch
      // ALWAYS used POSIX outer quoting regardless of OS. happy-dom reports a
      // non-Mac navigator (see src/shortcuts/bindings.ts's detectMacPlatform),
      // so the omitted-3rd-arg default now resolves to "powershell" here —
      // proving the branch is live, not just reachable via an explicit arg.
      const launch = buildSshProjectLaunch({
        host: "box",
        path: "/home/keith/app",
      });
      expect(launch).toBe(
        buildSshProjectLaunch(
          { host: "box", path: "/home/keith/app" },
          undefined,
          "powershell",
        ),
      );
      expect(launch).not.toContain(`'"'"'`);
    });
  });
});

describe("buildRemoteListArgv", () => {
  it("expands a saved home-relative directory before listing it", () => {
    const argv = buildRemoteListArgv("~/code/projects", 4, 2000);
    const probe = shellWords(`x ${argv[2]}`)[1];

    expect(probe).toContain(
      `cd "$HOME"/'code/projects' && find . -maxdepth 4`,
    );
  });

  it("wraps the whole find pipeline in a single sh -c argument", () => {
    const argv = buildRemoteListArgv("/repo", 4, 2000);
    // Three quoted argv elements: 'sh' '-c' '<probe>' — the probe (with its
    // |, &&-free pipeline and -exec escapes) never leaks as separate words.
    expect(argv).toHaveLength(3);
    expect(argv[0]).toBe("'sh'");
    expect(argv[1]).toBe("'-c'");
    // The remote shell sees the probe as ONE word once it strips the quoting.
    const probe = shellWords(`x ${argv[2]}`)[1];
    expect(probe).toContain("cd '/repo' && find . -maxdepth 4");
    expect(probe).toContain("head -n 2001");
    expect(probe).toContain("-name .git");
    expect(probe).toContain("-name node_modules");
  });

  it.each([
    ["spaces", "/home/keith/my app"],
    ["single quote", "/home/it's"],
    ["semicolon", "/tmp/x;rm -rf /"],
    ["command substitution", "/tmp/$(rm -rf /)"],
    ["pipe", "/tmp/a|b"],
  ])("neutralizes a hostile path (%s) inside the probe", (_label, path) => {
    const argv = buildRemoteListArgv(path, 4, 2000);
    expect(argv).toHaveLength(3);
    // Unwrap the outer remote-shell quoting on the probe element, then split
    // the probe as the remote shell would: the hostile path must come back
    // byte-for-byte as cd's single operand.
    const probe = shellWords(`x ${argv[2]}`)[1];
    expect(shellWords(probe)[1]).toBe(path);
  });
});

describe("buildRemotePreviewArgv", () => {
  it("expands a saved home-relative file before reading it", () => {
    const argv = buildRemotePreviewArgv(
      "~/code/projects/README.md",
      1024,
    );

    expect(argv[3]).toBe(
      `"$HOME"/'code/projects/README.md'`,
    );
  });

  it("requests cap+1 bytes via a POSIX head -c", () => {
    expect(buildRemotePreviewArgv("/repo/a.ts", 262144)).toEqual([
      "'head'",
      "'-c'",
      "'262145'",
      "'/repo/a.ts'",
    ]);
  });

  it.each([
    ["spaces", "/repo/my file.txt"],
    ["single quote", "/repo/it's.txt"],
    ["semicolon", "/repo/x;rm -rf /"],
    ["command substitution", "/repo/$(whoami).txt"],
  ])("neutralizes a hostile file path (%s)", (_label, path) => {
    const argv = buildRemotePreviewArgv(path, 1024);
    // The path survives the remote shell's word-split as ONE argument.
    expect(shellWords(`x ${argv[3]}`)[1]).toBe(path);
  });
});
