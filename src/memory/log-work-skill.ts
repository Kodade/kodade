import type { ProjectSkillSourceBundle } from "../ipc/contract";
import SKILL from "../../resources/kodmem/kodmem-project/SKILL.md?raw";

export const KODMEM_LOG_WORK_SKILL: ProjectSkillSourceBundle = {
  root: "kodade://bundled/kodmem-project",
  files: [{ path: "SKILL.md", contents: SKILL }],
};
