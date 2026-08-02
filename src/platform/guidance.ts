import { detectMacPlatform } from "../shortcuts/bindings";

export const REVEAL_IN_FILE_MANAGER_LABEL = "reveal in file manager";

export type GithubCliInstallGuidance = {
  command: string;
  copyTitle: string;
};

export function githubCliInstallGuidance(
  isMac = detectMacPlatform(),
): GithubCliInstallGuidance {
  const command = isMac
    ? "brew install gh"
    : "winget install --id GitHub.cli";
  return { command, copyTitle: `copy ${command}` };
}
