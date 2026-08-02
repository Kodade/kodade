---
name: research
description: "The research skill investigates a problem before planning or implementation by clarifying intent, running proportionate parallel research, and synthesizing evidence into a recommendation. Use it for feature planning, bug investigation, refactoring, unfamiliar systems, or explicit deep dives."
---

# Research

Do structured research before planning or implementation when the problem needs evidence. Match the depth to the question, and keep the result useful to the person making the next decision.

## Six-step process

### 1. Clarify before researching (mandatory)

Before opening files or launching agents, identify every ambiguity that could change the research: scope, intent, constraints, priority, suspected cause, proposed solution, compatibility, or affected systems.

Ask about those points with specific choices. Use `AskUserQuestion` where the CLI provides it; otherwise ask in plain text. Batch the questions so the user can answer once, and keep an “other” path available. Do not ask for facts you can determine from the project.

Do not launch research agents until the answers arrive. If the user is unavailable, stop rather than silently choosing a materially different scope.

### 2. Parse intent

After the answers, separate the underlying problem from any proposed fix. Check whether the answers changed the scope or approach. Resolve any remaining material ambiguity with another specific question. Then frame two to four concrete research questions.

Launch the research immediately after framing those questions; do not ask the user to approve the questions first.

### 3. Run parallel research matched to complexity

Use as many parallel agents as the problem warrants, not a fixed roster. Research the problem independently of the proposed solution. Possible lanes include:

- **Codebase:** almost always; inspect patterns, related code, configuration, dependencies, and existing behavior.
- **Documentation:** when a library, framework, API, or platform is involved; prefer official documentation and available documentation tools.
- **Web:** when the problem reaches beyond the repository; prioritize recent, authoritative sources and relevant issue discussions.
- **Dependencies:** when versions, compatibility, or configuration may decide the answer; inspect manifests and release guidance.
- **UI:** when visual design is affected; examine layout, hierarchy, typography, spacing, responsiveness, motion, and the existing design language.
- **UX:** when user-facing behavior is affected; examine flows, affordances, cognitive load, accessibility, errors, edge cases, and similar interactions in the codebase.
- **Delight:** when a user will see or touch the result; look for low-complexity improvements that remove friction or add care.

Each agent returns what it found, where it found it (file path or URL), and the key evidence or snippets. Prefer primary sources over commentary.

### 4. Check in after research (mandatory)

Before synthesis, summarize the main finding in a sentence or two and surface anything unexpected or contradictory. Ask the user how to proceed using specific choices. Use `AskUserQuestion` where available; otherwise ask in plain text.

If the evidence conflicts with the user's understanding, make that conflict explicit before moving on.

### 5. Synthesize

Combine the findings, reconcile contradictions, and label what is confirmed versus uncertain. If the request included a proposed solution, evaluate it directly: keep it, simplify it, or recommend a different approach when the evidence points there.

### 6. Stress-test the recommendation

Look actively for failure modes: degraded UX, missed edge cases, performance costs, maintenance burden, compatibility breaks, and operational risk. Explain the concrete consequence, not just a vague warning.

## Output format

Keep the report tight and use these sections:

### Answer

Give the direct answer. Be brief for a small question and thorough only when the evidence requires it.

### Evidence

Show the code excerpts, documentation details, or data that support the answer. Put code in blocks and label it with its file path.

### Sources

- File paths for repository findings
- URLs for web or documentation findings

### Related

Include useful adjacent findings, patterns, deprecations, or alternatives. Omit this section when there is nothing material.

### Downsides & Risks

Name specific things that could go wrong with the recommendation. Omit this section when the answer is trivially safe.

After presenting the report, enter plan mode if the CLI supports it. Otherwise stop at the research report and let the user choose the next planning step.

## Rules

- Ask specific, input-driven questions at Steps 1 and 4 at minimum.
- Never launch agents before Step 1 is answered.
- Never ask the user to approve the research questions before launching agents.
- Scale the number of agents to the problem; a one-file question rarely needs a team.
- Prefer source code and official documentation, and state which source you trust when sources disagree.
- Do not pad a simple research result.
