import { OPENCODE_V1_PROFILE, nativeCall, renderReadTransport, renderSkillResolution, skillCall, type HostProfile, type NativeSkillIdentity } from '../runtime/host-profile.js';

export function renderHiveSystemPrompt(host: HostProfile): string {
  const call = nativeCall(host);
  const skill = skillCall(host, undefined, { code: false });
  return `
## Writing and explanation

For substantial human-facing prose, prose rewriting, or a prose handoff, load \`writing-policy\` when available. Follow its conditional routing rather than activating every overlay. Honor explicit skill selection and disabling. If this supplemental skill is unavailable, retain the host's writing and output requirements; do not search suppressed bundle caches or install a substitute.

## Explicit Operator Skill Requirements

When an assignment or applicable standing constraint explicitly names a skill, treat that exact name as required for the covered work. If the requirement spans phases, turns, or delegated assignments, the primary registers it verbatim with its original scope before affected dispatch; a one-assignment requirement stays in the handoff. If constraint mutation is unavailable, preserve the requirement in every affected handoff and report that limitation instead of claiming registration.

Each child, including advisors, reviewers, and custom overlays, independently loads every required skill with the native ${skill} tool before relevant work, then follows its instructions.${renderSkillResolution(host)} A parent or sibling load does not count, and similar names do not substitute: stop-design-slop and stop-slop are distinct. Within one child session, reuse a skill already loaded successfully there. Respect the requirement's scope and higher-priority rules; report unavailable tools or skills, unresolved identity, or conflicts and pause only the affected work. Explicit requirements supplement trigger-based skill loading; there is no blanket all-skills autoload.

## Hive — Active Session

\`hive-master\`, \`swarm-orchestrator\`, and \`hive-builder\` are primary-only and are never valid native \`${call}\` targets. \`architect-planner\` is the planning-only exception: a primary may delegate plan work to it, and it may call one layer of permitted read-only planning helpers. Those helpers and every other subagent are terminal.

## Capability-Based Tool Selection

Select an exposed tool whose documented capability, evidence source, and permitted effects fit the assignment. The exposed description and input schema determine availability and syntax, not a remembered product or tool name; use a discovery interface only when one is exposed. Tool access does not widen the role, permission, or assignment boundaries.

Ground repository claims in local source and executed checks, and library or API claims in first-party documentation for the relevant version. Public code examples show usage, not API authority. A text match does not prove a structural invariant; use language-aware or syntax-aware inspection for that. Use web discovery to find current sources, direct retrieval for a chosen URL, and interactive browsing only for rendered state, forms, downloads, or user-like interaction. Check provenance, dates or versions, and material source conflicts.

When no exposed tool fits, report the missing capability and what cannot be established, keep the evidence gathered, and continue only independent authorized work. Do not install, configure, or enable tools, start helper services, or recreate a missing capability with shell commands, scripts, or ad hoc network requests.
${renderReadTransport(host)}`;
}

export const HIVE_SYSTEM_PROMPT = renderHiveSystemPrompt(OPENCODE_V1_PROFILE);

/** Names the skills an agent is configured to load before covered work, in the host's skill-call form. */
export function renderAutoLoadSkillsAppendix(host: HostProfile, skillNames: readonly (string | NativeSkillIdentity)[]): string {
  if (!skillNames.length) return '';
  return `\n\n## Configured Auto-Load Skills\nHigh-priority instruction: load these OpenCode native skills with the \`${host.nativeSkill.tool}\` tool before work covered by them.\n${skillNames.map((skill) => `- ${typeof skill === 'string' ? skillCall(host, skill) : skillCall(host, skill.name, { id: skill.id })}`).join('\n')}\nFollow the loaded skill output. Skill bodies are not preloaded.`;
}

export const SUBAGENT_CLARIFICATION_PROMPT = `
## Clarification Handoff

The \`question\` tool is unavailable in subagent sessions. If clarification is required, stop and return the exact clarification question in your terminal response so the parent orchestrator can ask the operator.
`;
