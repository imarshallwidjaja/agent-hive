import type { ConfigService, SessionService, SessionKind } from 'hive-core';

const BUILT_IN_AGENTS: Record<string, { sessionKind: SessionKind; baseAgent: string }> = {
  'hive-master': { sessionKind: 'primary', baseAgent: 'hive-master' },
  'architect-planner': { sessionKind: 'primary', baseAgent: 'architect-planner' },
  'swarm-orchestrator': { sessionKind: 'primary', baseAgent: 'swarm-orchestrator' },
  'hive-builder': { sessionKind: 'primary', baseAgent: 'hive-builder' },
  'forager-worker': { sessionKind: 'task-worker', baseAgent: 'forager-worker' },
  'forager-investigator': { sessionKind: 'subagent', baseAgent: 'forager-investigator' },
  'scout-researcher': { sessionKind: 'subagent', baseAgent: 'scout-researcher' },
  'hive-helper': { sessionKind: 'subagent', baseAgent: 'hive-helper' },
  'plan-reviewer': { sessionKind: 'subagent', baseAgent: 'plan-reviewer' },
  'code-reviewer': { sessionKind: 'subagent', baseAgent: 'code-reviewer' },
  'simplicity-reviewer': { sessionKind: 'subagent', baseAgent: 'simplicity-reviewer' },
  'approach-advisor': { sessionKind: 'subagent', baseAgent: 'approach-advisor' },
  'vulnerability-reviewer': { sessionKind: 'subagent', baseAgent: 'vulnerability-reviewer' },
};

const BASE_AGENT_KIND: Record<string, SessionKind> = {
  'scout-researcher': 'subagent',
  'forager-worker': 'task-worker',
  'forager-investigator': 'subagent',
  'plan-reviewer': 'subagent',
  'code-reviewer': 'subagent',
  'simplicity-reviewer': 'subagent',
  'approach-advisor': 'subagent',
  'vulnerability-reviewer': 'subagent',
};

export function classifySession(
  agent: string,
  customAgents: Record<string, { baseAgent: string }> = {},
): { sessionKind: SessionKind; baseAgent?: string } {
  const builtIn = BUILT_IN_AGENTS[agent];
  if (builtIn) {
    return { sessionKind: builtIn.sessionKind, baseAgent: builtIn.baseAgent };
  }

  const custom = customAgents[agent];
  if (custom) {
    const kind = BASE_AGENT_KIND[custom.baseAgent];
    if (kind) {
      return { sessionKind: kind, baseAgent: custom.baseAgent };
    }
  }

  return { sessionKind: 'unknown', baseAgent: undefined };
}

/**
 * The OpenCode v1 `chat.message` hook. v1.18.30 records the message's model selection as `message.model`
 * (`{ providerID, modelID, variant }`) and has already applied the caller's variant or the agent's catalog variant
 * there. Hive fills only a missing variant, and only when the message runs the agent's own Hive model: a variant
 * belongs to its model, so a message on another model keeps that model's native variant.
 */
export function createVariantHook(
  configService: ConfigService,
  sessionService?: SessionService,
  customAgents?: Record<string, { baseAgent: string }>,
) {
  return async (
    input: {
      sessionID: string;
      agent?: string;
      model?: { providerID: string; modelID: string };
      messageID?: string;
      variant?: string;
    },
    output: {
      message: { agent?: string; model?: { providerID: string; modelID: string; variant?: string } };
      parts: unknown[];
    },
  ): Promise<void> => {
    const effectiveAgent = input.agent ?? output.message.agent;

    if (effectiveAgent && sessionService) {
      const { sessionKind, baseAgent } = classifySession(effectiveAgent, customAgents);
      const patch: Record<string, unknown> = { agent: effectiveAgent, sessionKind };
      if (baseAgent) {
        patch.baseAgent = baseAgent;
      }
      sessionService.trackGlobal(input.sessionID, patch as any);
    }

    if (!effectiveAgent || !configService.hasConfiguredAgent(effectiveAgent)) return;
    const selected = output.message.model;
    if (!selected || selected.variant !== undefined) return;

    const { model, variant } = configService.getAgentConfig(effectiveAgent);
    if (model === undefined || variant === undefined) return;
    if (`${selected.providerID}/${selected.modelID}` !== model) return;
    selected.variant = variant;
  };
}
