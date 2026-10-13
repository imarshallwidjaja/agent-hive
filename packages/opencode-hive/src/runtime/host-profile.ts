import type { NativeObservationOwner } from 'hive-core';

/**
 * The native surface an agent prompt, command or skill is rendered for. Policy text is host-neutral; only the
 * names the host gives its native subagent call, shell and Hive reads come from the profile. A host adapter
 * creates its profile once and passes it to every renderer, so one prompt never mixes two hosts' syntax.
 */

/** The host is identified by its native observation owner so stores, prompts and skills agree on it. */
export type HostId = NativeObservationOwner;

/** How agents reach the Hive reads that v2 can run inside Code Mode (`execute`). */
export type ReadTransport = 'codemode' | 'direct';

/** The only Hive tools a codemode transport carries; every other Hive tool is a direct call on every host. */
export const CODEMODE_READ_TOOLS = ['hive_repositories_status', 'hive_git_snapshot', 'hive_task_trace_content'] as const;

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
   * `experiment-env`: background subagents exist only while an `OPENCODE_EXPERIMENTAL*` variable enables them.
   * `native`: the host's subagent call always accepts `background`.
   */
  readonly backgroundGate: 'experiment-env' | 'native';
}

/** Every native name a prompt, command or skill can mention, per host. Prose takes these through the profile, never as literals. */
const HOST_SURFACE = {
  'opencode-v1': {
    nativeTask: { tool: 'task', agentField: 'subagent_type', continuationField: 'task_id' },
    shell: { tool: 'bash', sentence: 'Bash' },
    nativeSkill: { tool: 'skill', field: 'name' },
    backgroundGate: 'experiment-env',
  },
  'opencode-v2': {
    nativeTask: { tool: 'subagent', agentField: 'agent', continuationField: 'sessionID' },
    shell: { tool: 'shell', sentence: 'Shell' },
    nativeSkill: { tool: 'skill', field: 'id' },
    backgroundGate: 'native',
  },
} as const satisfies Record<HostId, Pick<HostProfile, 'nativeTask' | 'shell' | 'nativeSkill' | 'backgroundGate'>>;

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
