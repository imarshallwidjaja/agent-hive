import type { CustomAgentBase, ResolvedCustomAgentConfig } from 'hive-core';

type PermissionAction = 'allow' | 'ask' | 'deny';

/** A registered agent's settings. `model` and `variant` are present only when Hive configuration chose them. */
export type RuntimeSubagentConfig = {
  model?: string;
  variant?: string;
  mode: 'subagent';
  description: string;
  prompt?: string;
  permission?: Record<string, PermissionAction | Record<string, PermissionAction>>;
};

type BuildCustomSubagentsInput = {
  customAgents: Record<string, ResolvedCustomAgentConfig>;
  baseAgents: Partial<Record<CustomAgentBase, RuntimeSubagentConfig>>;
  baseRuntimePrompts?: Partial<Record<CustomAgentBase, string>>;
  autoLoadSkillAppendices?: Record<string, string>;
  registerRuntimePrompt?: (agentName: string, prompt: string) => void;
};

export function buildCustomSubagents({
  customAgents,
  baseAgents,
  baseRuntimePrompts = {},
  autoLoadSkillAppendices = {},
  registerRuntimePrompt,
}: BuildCustomSubagentsInput): Record<string, RuntimeSubagentConfig> {
  const derived: Record<string, RuntimeSubagentConfig> = {};

  for (const [agentName, customConfig] of Object.entries(customAgents)) {
    const baseAgent = baseAgents[customConfig.baseAgent];
    if (!baseAgent) {
      continue;
    }

    const autoLoadSkillAppendix = autoLoadSkillAppendices[agentName] ?? '';
    const baseRuntimePrompt = baseRuntimePrompts[customConfig.baseAgent];
    const prompt = baseRuntimePrompt === undefined && baseAgent.prompt !== undefined
      ? baseAgent.prompt + autoLoadSkillAppendix
      : undefined;
    if (baseRuntimePrompt !== undefined) {
      registerRuntimePrompt?.(agentName, baseRuntimePrompt + autoLoadSkillAppendix);
    }

    // The resolved custom configuration already carries any model and variant inherited from its Hive base role.
    derived[agentName] = {
      ...(customConfig.model !== undefined ? { model: customConfig.model } : {}),
      ...(customConfig.variant !== undefined ? { variant: customConfig.variant } : {}),
      mode: 'subagent',
      description: customConfig.description,
      ...(prompt !== undefined ? { prompt } : {}),
      permission: baseAgent.permission,
    };
  }

  return derived;
}
