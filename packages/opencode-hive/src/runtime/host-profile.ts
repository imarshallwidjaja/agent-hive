import type { NativeObservationOwner } from 'hive-core';
import { RESUMABLE_SUBAGENT_ROLES } from './role-policy.js';

/**
 * The native surface an agent prompt, command or skill is rendered for. Policy text is host-neutral; only the
 * names the host gives its native subagent call, shell and Hive reads come from the profile. A host adapter
 * creates its profile once and passes it to every renderer, so one prompt never mixes two hosts' syntax.
 */

/** The host is identified by its native observation owner so stores, prompts and skills agree on it. */
export type HostId = NativeObservationOwner;

/** How agents reach the Hive reads that v2 can run inside Code Mode (`execute`). */
export type ReadTransport = 'codemode' | 'direct';

/**
 * The only Hive tools a codemode transport carries; every other Hive tool is a direct call on every host. Each one
 * writes no Hive state, and its guard needs no host session read because none is primary-only.
 */
export const CODEMODE_READ_TOOLS = [
  'hive_repositories_status',
  'hive_git_snapshot',
  'hive_task_trace_content',
  'hive_worklog_list',
  'hive_worklog_read',
  'hive_explore_read',
] as const;

export interface HostProfile {
  readonly host: HostId;
  /** Native subagent call: tool name, the field that names the agent, and the field that continues a child. */
  readonly nativeTask: {
    readonly tool: string;
    readonly agentField: string;
    readonly continuationField: string;
  };
  /** Native shell tool, as named in backticks and at the start of a sentence. */
  readonly shell: { readonly tool: string; readonly sentence: string };
  /**
   * Native skill tool and the field that selects the skill. `name`: the skill's own name. `id`: the id of an
   * entry in the host's available-skills catalog, which is not assumed to equal the entry's name.
   */
  readonly nativeSkill: { readonly tool: string; readonly field: 'name' | 'id' };
  readonly readTransport: ReadTransport;
  /**
   * `false`: the subagent call blocks and returns the child's result. `true`: every subagent call runs its child in
   * the background and returns at once; the host reports the result in a later message.
   */
  readonly backgroundSubagents: boolean;
}

/** Every native name a prompt, command or skill can mention, per host. Prose takes these through the profile, never as literals. */
const HOST_SURFACE = {
  'opencode-v1': {
    nativeTask: { tool: 'task', agentField: 'subagent_type', continuationField: 'task_id' },
    shell: { tool: 'bash', sentence: 'Bash' },
    nativeSkill: { tool: 'skill', field: 'name' },
    backgroundSubagents: false,
  },
  'opencode-v2': {
    nativeTask: { tool: 'subagent', agentField: 'agent', continuationField: 'sessionID' },
    shell: { tool: 'shell', sentence: 'Shell' },
    nativeSkill: { tool: 'skill', field: 'id' },
    backgroundSubagents: true,
  },
} as const satisfies Record<HostId, Pick<HostProfile, 'nativeTask' | 'shell' | 'nativeSkill' | 'backgroundSubagents'>>;

/**
 * v1 has no Code Mode, so its reads are always direct; asking for `codemode` there is a configuration error.
 * v2 defaults to `codemode`.
 */
export function createHostProfile(host: HostId, options: { readTransport?: ReadTransport } = {}): HostProfile {
  const readTransport = options.readTransport ?? (host === 'opencode-v2' ? 'codemode' : 'direct');
  if (host === 'opencode-v1' && readTransport !== 'direct') {
    throw new Error('OpenCode v1 has no Code Mode; its Hive reads are always direct');
  }
  return Object.freeze({ host, ...HOST_SURFACE[host], readTransport });
}

export const OPENCODE_V1_PROFILE: HostProfile = createHostProfile('opencode-v1');

/** A resolved catalog entry; v1 discovery identifies it by name, v2 by its exact id. */
export type NativeSkillIdentity = { readonly name: string; readonly id?: string };

/** The native subagent call as it is named in prose, for example `task()`. */
export function nativeCall(profile: HostProfile): string {
  return `${profile.nativeTask.tool}()`;
}

/**
 * The native skill call as it is named in prose, wrapped in backticks unless `code` is false. Without a name it is the
 * generic call shape. With a name on a host that selects skills by catalog id, the call carries no invented id: it
 * says which catalog entry supplies it.
 */
export function skillCall(profile: HostProfile, name?: string, options: { code?: boolean; id?: string } = {}): string {
  const { tool, field } = profile.nativeSkill;
  const wrap = (text: string) => (options.code === false ? text : `\`${text}\``);
  if (field === 'name') return wrap(`${tool}({ name: ${JSON.stringify(name ?? '...')} })`);
  if (options.id !== undefined) return wrap(`${tool}({ id: ${JSON.stringify(options.id)} })`);
  const call = wrap(`${tool}({ ${field} })`);
  return name === undefined ? call : `${call} for the catalog entry named ${JSON.stringify(name)}`;
}

/** What an audit looks for in a skill call to confirm that a required skill was loaded. */
export function requiredSkillIdentity(profile: HostProfile): string {
  return profile.nativeSkill.field === 'name' ? 'the exact required names' : 'the catalog ids of the exact required names';
}

/**
 * How a skill named anywhere in the instructions becomes the argument of the native skill call. Empty when the
 * host takes the name itself. Appended after a sentence, so it starts with a space.
 */
export function renderSkillResolution(profile: HostProfile): string {
  if (profile.nativeSkill.field === 'name') return '';
  return ` On this host the native \`${profile.nativeSkill.tool}\` tool takes \`id\`, not a name. An explicit catalog id selects that exact entry. For a requirement naming a skill, use the Hive Skill Name Lookup below when it has that name; it prefers a unique user skill over the bundled skill. Otherwise use the \`<id>\` of the available-skills catalog entry whose \`<name>\` is exactly the skill's name, because an id may differ from its name. The same lookup applies wherever these instructions name a skill. When no entry or multiple user entries match, the identity is unresolved: report it and pause only the affected work.`;
}

/** Request-time name resolution also covers canonical instructions, not just configured auto-loads. */
export function renderSkillNameLookup(profile: HostProfile, names: ReadonlyMap<string, NativeSkillIdentity>, ambiguous: ReadonlyMap<string, readonly string[]> = new Map()): string {
  if (profile.nativeSkill.field === 'name') return '';
  const entries = [...names].filter(([name, skill]) => skill.id !== undefined && name !== skill.id)
    .map(([name, skill]) => `- ${JSON.stringify(name)}: ${skillCall(profile, name, { id: skill.id })}`);
  for (const [name, ids] of ambiguous) entries.push(`- ${JSON.stringify(name)}: unresolved (multiple user catalog ids: ${ids.map((id) => JSON.stringify(id)).join(', ')}). Report the ambiguity for name-based requirements; an explicit id still selects its exact entry.`);
  return entries.length ? `\n\n## Hive Skill Name Lookup\nUse this lookup for skill names in any instruction, including canonical requirements.\n${entries.join('\n')}` : '';
}

/**
 * How a host whose subagent calls always run in the background meets instructions written around blocking calls.
 * Empty where a blocking call exists. Policy text stays host-neutral; this section is the one owner of the wait rule,
 * the continuation limit Hive enforces at dispatch, and when to use the live child tools. Skills point here instead of
 * restating it. It names the report's `state` attribute, not the message's tag, which differs between host versions.
 */
export function renderSubagentWait(profile: HostProfile): string {
  if (!profile.backgroundSubagents) return '';
  const call = nativeCall(profile);
  const { continuationField } = profile.nativeTask;
  return `\n## Native Subagent Wait

On this host every \`${call}\` call runs its child in the background and returns a launch receipt (status \`running\` and the child's \`${continuationField}\`), not the child's result. The host later posts a subagent report message for that \`${continuationField}\` each time the child stops, with a \`state\` attribute:
- \`state="running"\` is interim: the child stopped while its own background work (a \`${profile.shell.tool}\` command, a helper subagent, a script) still runs. Its text is not the result.
- \`state="completed"\` is the final report, and its text is the child's result. \`state="error"\` and \`state="cancelled"\` end that execution: handle them as a failed or interrupted worker run. Any \`${profile.shell.tool}\` commands and descendant jobs the child had already moved to the background may still run, so confirm that the child's tree has settled before you start overlapping work.

When an instruction calls a \`${call}\` call blocking or treats its return as the result, wait for the child's final report instead. Until it arrives, continue only independent work, then end your turn; do not poll, sleep, or repeat the launch, and make no lifecycle decision (accept, integrate, retry, replace, clean up) from a launch receipt or an interim report.

A foreground \`${profile.shell.tool}\` command that exceeds its timeout moves to the background instead of stopping, and interrupting a session does not stop \`${profile.shell.tool}\` commands or descendant jobs it already backgrounded. Keep one active writer or mutating \`${profile.shell.tool}\` command per worktree or shared resource.

${renderContinuationRule(profile)}

Call \`hive_background_status\` only when a child's or its descendants' liveness is uncertain (an interrupted run, a timeout, a restart), and \`hive_background_cancel\` only to stop a wrong, stale, or unneeded child.\n`;
}

/** Which settled children may be continued, as `dispatch.ts` admits them. Shared by the wait section and unbound text. */
function renderContinuationRule(profile: HostProfile): string {
  const { agentField, continuationField } = profile.nativeTask;
  const resumable = [...RESUMABLE_SUBAGENT_ROLES].map((role) => `\`${role}\``).join(', ');
  return `Only a settled child of a resumable role (${resumable}, or a custom agent derived from one) may be continued with \`${continuationField}\`, on the same \`${agentField}\` and the same task or investigation, for one or two bounded follow-ups. Scouts, reviewers, advisors, and \`hive-helper\` are one-shot. A new task, an independent review or challenge pass, and a retry after a dead end always omit \`${continuationField}\`.`;
}

/**
 * The wait and continuation rules for text that an agent without the Hive system prompt can receive, such as an
 * unbound command, which cannot point at `## Native Subagent Wait`. Empty where a blocking call exists.
 */
export function subagentWaitInstruction(profile: HostProfile): string {
  if (!profile.backgroundSubagents) return '';
  const { continuationField } = profile.nativeTask;
  return `On this host every \`${nativeCall(profile)}\` call returns a launch receipt (status \`running\` and the child's \`${continuationField}\`), not the child's result. Wait for the child's final report, a subagent report with \`state="completed"\`, \`state="error"\`, or \`state="cancelled"\`, before any decision that depends on it; a \`state="running"\` report is an interim stop, and an error or cancellation report is a failed or interrupted run. ${renderContinuationRule(profile)}`;
}

/**
 * Where an agent finds the Hive reads that the host can run inside Code Mode. Empty on v1, which has no Code
 * Mode. Prose never names a read that the selected transport cannot reach: Code Mode needs `execute`, so the
 * text tells an agent without it to report the missing capability instead of trying a direct call.
 */
export function renderReadTransport(profile: HostProfile): string {
  if (profile.host !== 'opencode-v2') return '';
  const reads = CODEMODE_READ_TOOLS.map((name) => `\`${name}\``).join(', ');
  if (profile.readTransport === 'direct') {
    return `\n## Hive Read Transport\n\nHive tools, including ${reads}, are direct tool calls. The host's \`execute\` tool is not their transport.\n`;
  }
  return `\n## Hive Read Transport\n\nWhen your role exposes them, ${reads} run inside the host's Code Mode: call them from code passed to \`execute\`, using the exact paths its Code Mode catalog lists. They are not direct tool calls. Every other Hive tool is a direct call. When \`execute\` is not among your exposed tools, these reads are unavailable to you; report the missing capability and what it blocks instead of attempting a direct call or a substitute.\n`;
}

/**
 * One instruction naming how the given Code Mode reads are reached, for text that an agent without the Hive system
 * prompt can receive, such as an unbound command. Empty on v1, where every Hive tool is a direct call.
 */
export function readTransportInstruction(profile: HostProfile, tools: readonly (typeof CODEMODE_READ_TOOLS)[number][]): string {
  if (profile.host !== 'opencode-v2') return '';
  const reads = tools.map((name) => `\`${name}\``).join(' and ');
  if (profile.readTransport === 'direct') {
    return `On this host ${reads} are direct tool calls; the host's \`execute\` tool is not their transport.`;
  }
  return `On this host ${reads} run inside Code Mode: call them from code passed to the host's \`execute\` tool, using the exact paths its Code Mode catalog lists, not as direct tool calls. When \`execute\` is not among your exposed tools, these reads are unavailable to you. In that case, report the missing capability and what it blocks, and say that the operator can set the oc-arkive option \`readTransport\` to \`direct\` or allow \`execute\`; do not attempt a direct call or a substitute.`;
}
