import type { ConfigService, SessionService, SessionKind } from 'hive-core';

export function normalizeVariant(variant: string | undefined): string | undefined {
  if (variant === undefined) return undefined;
  const trimmed = variant.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

const BUILT_IN_AGENTS: Record<string, { sessionKind: SessionKind; baseAgent: string }> = {
  'hive-master': { sessionKind: 'primary', baseAgent: 'hive-master' },
  'architect-planner': { sessionKind: 'primary', baseAgent: 'architect-planner' },
  'swarm-orchestrator': { sessionKind: 'primary', baseAgent: 'swarm-orchestrator' },
  'hive-builder': { sessionKind: 'primary', baseAgent: 'hive-builder' },
  'forager-worker': { sessionKind: 'task-worker', baseAgent: 'forager-worker' },
  'scout-researcher': { sessionKind: 'subagent', baseAgent: 'scout-researcher' },
  'hive-helper': { sessionKind: 'subagent', baseAgent: 'hive-helper' },
  'plan-reviewer': { sessionKind: 'subagent', baseAgent: 'plan-reviewer' },
  'code-reviewer': { sessionKind: 'subagent', baseAgent: 'code-reviewer' },
  'simplicity-reviewer': { sessionKind: 'subagent', baseAgent: 'simplicity-reviewer' },
  'approach-advisor': { sessionKind: 'subagent', baseAgent: 'approach-advisor' },
};

const BASE_AGENT_KIND: Record<string, SessionKind> = {
  'scout-researcher': 'subagent',
  'forager-worker': 'task-worker',
  'plan-reviewer': 'subagent',
  'code-reviewer': 'subagent',
  'simplicity-reviewer': 'subagent',
  'approach-advisor': 'subagent',
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

export function createVariantHook(
  configService: ConfigService,
  sessionService?: SessionService,
  customAgents?: Record<string, { baseAgent: string }>,
  taskWorkerRecovery?: {
    featureName: string;
    taskFolder: string;
    workerPromptPath: string;
  },
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
      message: { variant?: string };
      parts: unknown[];
    },
  ): Promise<void> => {
    const { agent } = input;

    if (agent && sessionService) {
      const { sessionKind, baseAgent } = classifySession(agent, customAgents);
      const patch: Record<string, unknown> = { agent, sessionKind };
      if (baseAgent) {
        patch.baseAgent = baseAgent;
      }
      if (sessionKind === 'task-worker' && taskWorkerRecovery) {
        patch.featureName = taskWorkerRecovery.featureName;
        patch.taskFolder = taskWorkerRecovery.taskFolder;
        patch.workerPromptPath = taskWorkerRecovery.workerPromptPath;
      }
      sessionService.trackGlobal(input.sessionID, patch as any);
    }

    if (!agent) return;
    if (!configService.hasConfiguredAgent(agent)) return;
    if (output.message.variant !== undefined) return;

    const agentConfig = configService.getAgentConfig(agent);
    const configuredVariant = normalizeVariant(agentConfig.variant);

    if (configuredVariant !== undefined) {
      output.message.variant = configuredVariant;
    }
  };
}
