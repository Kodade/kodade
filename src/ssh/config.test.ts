import { describe, expect, it } from "vitest";
import { parseSshConfig } from "./config";

describe("parseSshConfig", () => {
  it("parses multiple hosts with their keys", () => {
    const text = `
Host buildbox
  HostName 10.0.0.5
  User keith
  Port 2222

Host homelab
  HostName homelab.local
  User admin
`;
    const { hosts } = parseSshConfig(text);
    expect(hosts).toEqual([
      { alias: "buildbox", hostName: "10.0.0.5", user: "keith", port: 2222 },
      { alias: "homelab", hostName: "homelab.local", user: "admin" },
    ]);
  });

  it("skips wildcard-pattern aliases", () => {
    const text = `
Host *
  User fallback

Host *.example.com
  User web

Host realhost
  HostName 1.2.3.4
`;
    const { hosts } = parseSshConfig(text);
    expect(hosts).toEqual([{ alias: "realhost", hostName: "1.2.3.4" }]);
  });

  it("skips negated aliases", () => {
    const text = `
Host !excluded good
  HostName 1.2.3.4
`;
    const { hosts } = parseSshConfig(text);
    expect(hosts).toEqual([{ alias: "good", hostName: "1.2.3.4" }]);
  });

  it("collects Include directives without resolving them", () => {
    const text = `
Include ~/.ssh/conf.d/*
Include extra.conf

Host box
  HostName 1.1.1.1
`;
    const { hosts, includes } = parseSshConfig(text);
    expect(includes).toEqual(["~/.ssh/conf.d/*", "extra.conf"]);
    expect(hosts).toEqual([{ alias: "box", hostName: "1.1.1.1" }]);
  });

  it("treats keys case-insensitively and accepts '=' or whitespace separators", () => {
    const text = `
HOST mixedcase
  hostname=2.2.2.2
  USER = root
  pORT 22
`;
    const { hosts } = parseSshConfig(text);
    expect(hosts).toEqual([{ alias: "mixedcase", hostName: "2.2.2.2", user: "root", port: 22 }]);
  });

  it("handles a multi-alias Host line, applying keys to every concrete alias", () => {
    const text = `
Host a b c*
  HostName shared.example.com
`;
    const { hosts } = parseSshConfig(text);
    expect(hosts).toEqual([
      { alias: "a", hostName: "shared.example.com" },
      { alias: "b", hostName: "shared.example.com" },
    ]);
  });

  it("ignores comment lines and blank lines", () => {
    const text = `
# a leading comment
Host commented
  # another comment
  HostName 3.3.3.3

# trailing comment
`;
    const { hosts } = parseSshConfig(text);
    expect(hosts).toEqual([{ alias: "commented", hostName: "3.3.3.3" }]);
  });

  it("ignores unknown keys and a Host line with only pattern aliases", () => {
    const text = `
Host onlypattern*
  HostName should.not.apply
  IdentityFile ~/.ssh/id_ed25519

Host known
  HostName 4.4.4.4
  ProxyJump bastion
`;
    const { hosts } = parseSshConfig(text);
    expect(hosts).toEqual([{ alias: "known", hostName: "4.4.4.4" }]);
  });

  it("does not leak Match-block keys into the preceding Host", () => {
    const text = `
Host real
  HostName 1.2.3.4

Match user deploy
  HostName should.not.leak
  User deployer
  Port 2022

Host after
  HostName 5.6.7.8
`;
    const { hosts } = parseSshConfig(text);
    expect(hosts).toEqual([
      { alias: "real", hostName: "1.2.3.4" },
      { alias: "after", hostName: "5.6.7.8" },
    ]);
  });

  it("returns empty results for empty text", () => {
    expect(parseSshConfig("")).toEqual({ hosts: [], includes: [] });
  });
});
