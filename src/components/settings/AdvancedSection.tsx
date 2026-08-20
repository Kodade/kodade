// Advanced settings page: KödHarness first (always available and open) — the
// background prompt plus the skills/MCP tools — then the development-only
// surfaces. The build gate that used to live in the registry lives here now,
// so a public build shows the harness block alone.
//
// The development blocks are collapsed until asked for: mounting them runs
// real side effects (SSH host probes, microphone enumeration), and those
// belong to a user who opened that block, not to anyone visiting the page.

import {
  RELEASE_MANIFEST,
  developmentFeatureEnabled,
  type ReleaseManifest,
} from "../../release/manifest";
import { AmbientPromptSettings } from "./AmbientPromptSettings";
import { HarnessTools } from "./HarnessTools";
import { LocalSection } from "./LocalSection";
import { CollapsibleSettingsBlock, SettingsBlock } from "./SettingsCard";
import { SshSection } from "./SshSection";
import { VoiceSection } from "./VoiceSection";

export function AdvancedSection({
  manifest = RELEASE_MANIFEST,
}: {
  manifest?: ReleaseManifest;
} = {}) {
  return (
    <div className="space-y-6">
      <SettingsBlock
        title="ködharness"
        description="What your agents read and can use."
      >
        <AmbientPromptSettings />
        <HarnessTools />
      </SettingsBlock>

      {developmentFeatureEnabled("local", manifest) && (
        <CollapsibleSettingsBlock
          title="ködlocal"
          description="Embedded local models that run on this machine."
        >
          <LocalSection />
        </CollapsibleSettingsBlock>
      )}

      {developmentFeatureEnabled("voice", manifest) && (
        <CollapsibleSettingsBlock
          title="ködwhisper"
          description="Voice input, dictation model, and voice commands."
        >
          <VoiceSection />
        </CollapsibleSettingsBlock>
      )}

      {developmentFeatureEnabled("ssh", manifest) && (
        <CollapsibleSettingsBlock
          title="ködssh"
          description="Remote hosts from ~/.ssh/config and saved remote projects."
        >
          <SshSection />
        </CollapsibleSettingsBlock>
      )}
    </div>
  );
}
