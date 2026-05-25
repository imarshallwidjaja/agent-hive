import type { CustomAgentBase, ResolvedCustomAgentConfig } from 'hive-core';

export type RuntimeSubagentConfig = {
  model?: string;
  variant?: string;
  temperature?: number;
  mode: 'subagent';
  description: string;
  prompt?: string;
  tools?: Record<string, boolean>;
  permission?: Record<string, string>;
};

type BuildCustomSubagentsInput = {
  customAgents: Record<string, ResolvedCustomAgentConfig>;
  baseAgents: Record<CustomAgentBase, RuntimeSubagentConfig>;
  baseRuntimePrompts?: Partial<Record<CustomAgentBase, string>>;
  autoLoadedSkills?: Record<string, string>;
  registerRuntimePrompt?: (agentName: string, prompt: string) => void;
};

export function buildCustomSubagents({
  customAgents,
  baseAgents,
  baseRuntimePrompts = {},
  autoLoadedSkills = {},
  registerRuntimePrompt,
}: BuildCustomSubagentsInput): Record<string, RuntimeSubagentConfig> {
  const derived: Record<string, RuntimeSubagentConfig> = {};

  for (const [agentName, customConfig] of Object.entries(customAgents)) {
    const baseAgent = baseAgents[customConfig.baseAgent];
    if (!baseAgent) {
      continue;
    }

    const autoLoadedSkillsContent = autoLoadedSkills[agentName] ?? '';
    const baseRuntimePrompt = baseRuntimePrompts[customConfig.baseAgent];
    const prompt = baseRuntimePrompt === undefined && baseAgent.prompt !== undefined
      ? baseAgent.prompt + autoLoadedSkillsContent
      : undefined;
    if (baseRuntimePrompt !== undefined) {
      registerRuntimePrompt?.(agentName, baseRuntimePrompt + autoLoadedSkillsContent);
    }

    derived[agentName] = {
      model: customConfig.model ?? baseAgent.model,
      variant: customConfig.variant ?? baseAgent.variant,
      temperature: customConfig.temperature ?? baseAgent.temperature,
      mode: 'subagent',
      description: customConfig.description,
      ...(prompt !== undefined ? { prompt } : {}),
      tools: baseAgent.tools,
      permission: baseAgent.permission,
    };
  }

  return derived;
}
