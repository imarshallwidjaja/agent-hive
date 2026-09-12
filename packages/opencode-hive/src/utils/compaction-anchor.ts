import type { WorkerAssignmentDescriptor } from 'hive-core';

export interface CompactionSessionContext {
  agent?: string;
  baseAgent?: string;
  sessionKind?: 'primary' | 'subagent' | 'task-worker' | 'unknown';
  featureName?: string;
  taskFolder?: string;
  workerPromptPath?: string;
  workerAssignment?: WorkerAssignmentDescriptor;
  directivePrompt?: string;
}

export interface CompactionReanchor {
  prompt: string;
  context: string[];
}

const AGENT_ROLE_MAP: Record<string, string> = {
  'hive-master': 'Hive',
  'architect-planner': 'Architect',
  'swarm-orchestrator': 'Swarm',
  'hive-builder': 'Hive Builder',
  'forager-worker': 'Forager',
  'scout-researcher': 'Scout',
  'hive-helper': 'Hive Helper',
  'plan-reviewer': 'Plan Reviewer',
  'code-reviewer': 'Code Reviewer',
  'simplicity-reviewer': 'Simplicity Reviewer',
  'approach-advisor': 'Approach Advisor',
};

const BASE_AGENT_ROLE_MAP: Record<string, string> = {
  'forager-worker': 'Forager',
  'plan-reviewer': 'Plan Reviewer',
  'code-reviewer': 'Code Reviewer',
  'approach-advisor': 'Approach Advisor',
  'scout-researcher': 'Scout',
  'hive-helper': 'Hive Helper',
  'hive-builder': 'Hive Builder',
};

function resolveRole(ctx: CompactionSessionContext): string | undefined {
  if (ctx.agent && AGENT_ROLE_MAP[ctx.agent]) {
    return AGENT_ROLE_MAP[ctx.agent];
  }
  if (ctx.baseAgent && BASE_AGENT_ROLE_MAP[ctx.baseAgent]) {
    return BASE_AGENT_ROLE_MAP[ctx.baseAgent];
  }
  return undefined;
}

export function buildCompactionReanchor(ctx: CompactionSessionContext): CompactionReanchor {
  const role = resolveRole(ctx);
  const kind = ctx.sessionKind ?? 'unknown';
  const lines: string[] = [];
  const context: string[] = [];

  lines.push('Compaction recovery — you were compacted mid-session.');

  if (role) {
    lines.push(`Role: ${role}`);
  }

  lines.push('Do not switch roles.');
  lines.push('Do not call status tools to rediscover state.');
  lines.push('Do not re-read the full codebase.');

   if (kind === 'primary' || kind === 'subagent') {
    lines.push('Keep the handoff compact and explicit.');
    lines.push('Do not broaden the scope or re-read the full codebase.');
  }

  if (kind === 'task-worker') {
    lines.push('Do not delegate.');
    if (ctx.workerAssignment?.format === 'hive-worker-assignment/v1') {
      lines.push('The runtime will replay the hash-verified immutable assignment for this exact attempt.');
    } else if (ctx.workerPromptPath) {
      lines.push('Legacy mutable assignment recovery is unavailable; return to the parent for a fresh launch.');
    } else {
      lines.push('Wait for runtime assignment recovery; return to the parent if exact provenance is unavailable.');
    }
  }

  if ((kind === 'primary' || kind === 'subagent') && ctx.directivePrompt) {
    lines.push('Original directive survives via post-compaction replay.');
  }

  lines.push('Next action: resume from where you left off.');

  return {
    prompt: lines.join('\n'),
    context,
  };
}
