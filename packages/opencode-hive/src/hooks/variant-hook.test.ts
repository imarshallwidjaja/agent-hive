import { describe, it, expect } from 'bun:test';
import { createVariantHook, classifySession } from './variant-hook.js';

const createMockConfigService = (
  agents: Record<string, { model?: string; variant?: string }>,
  configuredAgents: string[] = Object.keys(agents),
) => ({
  hasConfiguredAgent: (agent: string) => configuredAgents.includes(agent),
  getAgentConfig: (agent: string) => ({ ...agents[agent] }),
});

/** The v1.18.30 `chat.message` output: the message records its model selection as `message.model`. */
const createOutput = (model = 'anthropic/claude-sonnet', variant?: string, agent?: string) => {
  const [providerID, modelID] = model.split('/');
  return { message: { ...(agent ? { agent } : {}), model: { providerID, modelID, ...(variant !== undefined ? { variant } : {}) } }, parts: [] as unknown[] };
};

describe('createVariantHook', () => {
  describe('fills the Hive variant on the agent\'s own Hive model', () => {
    it.each([
      ['hive-master', 'max'],
      ['architect-planner', 'high'],
      ['swarm-orchestrator', 'medium'],
      ['scout-researcher', 'low'],
      ['forager-worker', 'high'],
      ['hive-helper', 'medium'],
      ['plan-reviewer', 'medium'],
      ['code-reviewer', 'medium'],
      ['approach-advisor', 'medium'],
      ['forager-ui', 'high'],
      ['reviewer-security', 'medium'],
    ])('sets message.model.variant for %s = %s', async (agent, variant) => {
      const hook = createVariantHook(createMockConfigService({ [agent]: { model: 'anthropic/claude-sonnet', variant } }) as any);
      const output = createOutput();

      await hook({ sessionID: 'session-123', agent }, output);

      expect(output.message.model.variant).toBe(variant);
      expect(output.message).not.toHaveProperty('variant');
    });

    it('uses the message agent when the hook input names none', async () => {
      const hook = createVariantHook(createMockConfigService({ 'forager-worker': { model: 'anthropic/claude-sonnet', variant: 'high' } }) as any);
      const output = createOutput('anthropic/claude-sonnet', undefined, 'forager-worker');

      await hook({ sessionID: 'session-123' }, output);

      expect(output.message.model.variant).toBe('high');
    });
  });

  describe('keeps the native selection', () => {
    it('does not replace a variant the caller or the agent catalog already chose', async () => {
      const hook = createVariantHook(createMockConfigService({ 'forager-worker': { model: 'anthropic/claude-sonnet', variant: 'high' } }) as any);
      const output = createOutput('anthropic/claude-sonnet', 'low');

      await hook({ sessionID: 'session-123', agent: 'forager-worker', variant: 'low' }, output);

      expect(output.message.model.variant).toBe('low');
    });

    it('leaves a message on another model with that model\'s native variant', async () => {
      const hook = createVariantHook(createMockConfigService({ 'forager-worker': { model: 'anthropic/claude-sonnet', variant: 'high' } }) as any);
      const output = createOutput('openai/gpt-5');

      await hook({ sessionID: 'session-123', agent: 'forager-worker', model: { providerID: 'openai', modelID: 'gpt-5' } }, output);

      expect(output.message.model).toEqual({ providerID: 'openai', modelID: 'gpt-5' });
    });

    it.each([
      ['an inheriting agent', {}],
      ['a model-only agent', { model: 'anthropic/claude-sonnet' }],
    ])('sets no variant for %s', async (_label, settings) => {
      const hook = createVariantHook(createMockConfigService({ 'forager-worker': settings }) as any);
      const output = createOutput();

      await hook({ sessionID: 'session-123', agent: 'forager-worker' }, output);

      expect(output.message.model).not.toHaveProperty('variant');
    });
  });

  describe('does not apply to non-Hive agents', () => {
    it.each(['some-other-agent', 'build', 'plan', 'code'])('does not set a variant for %s', async (agent) => {
      const hook = createVariantHook(createMockConfigService({ 'forager-worker': { model: 'anthropic/claude-sonnet', variant: 'high' } }) as any);
      const output = createOutput();

      await hook({ sessionID: 'session-123', agent }, output);

      expect(output.message.model).not.toHaveProperty('variant');
    });

    it('does nothing when neither the input nor the message names an agent', async () => {
      const hook = createVariantHook(createMockConfigService({ 'forager-worker': { model: 'anthropic/claude-sonnet', variant: 'high' } }) as any);
      const output = createOutput();

      await hook({ sessionID: 'session-123', agent: undefined }, output);

      expect(output.message.model).not.toHaveProperty('variant');
    });
  });
});

describe('classifySession', () => {
  const NO_CUSTOM_AGENTS: Record<string, { baseAgent: string }> = {};

  describe('built-in agent classification', () => {
    it.each([
      ['hive-master', 'primary'],
      ['architect-planner', 'primary'],
      ['swarm-orchestrator', 'primary'],
      ['forager-worker', 'task-worker'],
      ['scout-researcher', 'subagent'],
      ['plan-reviewer', 'subagent'],
      ['code-reviewer', 'subagent'],
      ['approach-advisor', 'subagent'],
      ['vulnerability-reviewer', 'subagent'],
      ['simplicity-reviewer', 'subagent'],
      ['hive-helper', 'subagent'],
    ] as const)('classifies %s as %s', (agent, sessionKind) => {
      expect(classifySession(agent, NO_CUSTOM_AGENTS)).toEqual({ sessionKind, baseAgent: agent });
    });
  });

  describe('custom agent classification', () => {
    const customAgents: Record<string, { baseAgent: string }> = {
      'forager-ui': { baseAgent: 'forager-worker' },
      'scout-custom': { baseAgent: 'scout-researcher' },
      'reviewer-security': { baseAgent: 'code-reviewer' },
      'reviewer-minimalist': { baseAgent: 'simplicity-reviewer' },
      'reviewer-vulnerability': { baseAgent: 'vulnerability-reviewer' },
    };

    it.each([
      ['forager-ui', 'task-worker', 'forager-worker'],
      ['reviewer-security', 'subagent', 'code-reviewer'],
      ['reviewer-minimalist', 'subagent', 'simplicity-reviewer'],
      ['reviewer-vulnerability', 'subagent', 'vulnerability-reviewer'],
      ['scout-custom', 'subagent', 'scout-researcher'],
    ] as const)('classifies %s as %s based on %s', (agent, sessionKind, baseAgent) => {
      expect(classifySession(agent, customAgents)).toEqual({ sessionKind, baseAgent });
    });
  });

  describe('unknown agent classification', () => {
    it('classifies unconfigured custom-like agent as unknown', () => {
      const result = classifySession('scout-custom', NO_CUSTOM_AGENTS);
      expect(result.sessionKind).toBe('unknown');
      expect(result.baseAgent).toBeUndefined();
    });

    it('classifies completely unknown agent as unknown', () => {
      const result = classifySession('some-random-agent', NO_CUSTOM_AGENTS);
      expect(result.sessionKind).toBe('unknown');
      expect(result.baseAgent).toBeUndefined();
    });
  });
});

describe('createVariantHook with session tracking', () => {
  it('records global session with baseAgent and sessionKind on first message', async () => {
    const tracked: Array<{ sessionId: string; patch: Record<string, unknown> }> = [];
    const mockSessionService = {
      trackGlobal: (sessionId: string, patch?: Record<string, unknown>) => {
        tracked.push({ sessionId, patch: patch ?? {} });
        return { sessionId, startedAt: '', lastActiveAt: '' };
      },
    };

    const hook = createVariantHook(
      createMockConfigService({ 'forager-worker': { model: 'anthropic/claude-sonnet', variant: 'high' } }) as any,
      mockSessionService as any,
      { 'forager-ui': { baseAgent: 'forager-worker' } },
    );

    const output = createOutput();
    await hook({ sessionID: 'sess-123', agent: 'forager-ui' }, output);

    expect(tracked.length).toBe(1);
    expect(tracked[0].sessionId).toBe('sess-123');
    expect(tracked[0].patch).toEqual({
      agent: 'forager-ui',
      baseAgent: 'forager-worker',
      sessionKind: 'task-worker',
    });
  });

  it('classifies primary agents on the chat.message path', async () => {
    const tracked: Array<{ sessionId: string; patch: Record<string, unknown> }> = [];
    const mockSessionService = {
      trackGlobal: (sessionId: string, patch?: Record<string, unknown>) => {
        tracked.push({ sessionId, patch: patch ?? {} });
        return { sessionId, startedAt: '', lastActiveAt: '' };
      },
    };

    const hook = createVariantHook(
      createMockConfigService({ 'hive-master': { model: 'anthropic/claude-sonnet', variant: 'max' } }) as any,
      mockSessionService as any,
    );

    const output = createOutput();
    await hook({ sessionID: 'sess-primary', agent: 'hive-master' }, output);

    expect(tracked.length).toBe(1);
    expect(tracked[0].patch).toEqual({
      agent: 'hive-master',
      baseAgent: 'hive-master',
      sessionKind: 'primary',
    });
  });

  it('classifies unknown agents that are not in customAgents', async () => {
    const tracked: Array<{ sessionId: string; patch: Record<string, unknown> }> = [];
    const mockSessionService = {
      trackGlobal: (sessionId: string, patch?: Record<string, unknown>) => {
        tracked.push({ sessionId, patch: patch ?? {} });
        return { sessionId, startedAt: '', lastActiveAt: '' };
      },
    };

    const hook = createVariantHook(
      createMockConfigService({}) as any,
      mockSessionService as any,
    );

    const output = createOutput();
    await hook({ sessionID: 'sess-unknown', agent: 'scout-custom' }, output);

    expect(tracked.length).toBe(1);
    expect(tracked[0].patch).toEqual({
      agent: 'scout-custom',
      sessionKind: 'unknown',
    });
  });

  it('tracks custom scout-derived agents as subagents', async () => {
    const tracked: Array<{ sessionId: string; patch: Record<string, unknown> }> = [];
    const mockSessionService = {
      trackGlobal: (sessionId: string, patch?: Record<string, unknown>) => {
        tracked.push({ sessionId, patch: patch ?? {} });
        return { sessionId, startedAt: '', lastActiveAt: '' };
      },
    };

    const hook = createVariantHook(
      createMockConfigService({ 'scout-custom': { model: 'anthropic/claude-sonnet', variant: 'low' } }, ['scout-custom']) as any,
      mockSessionService as any,
      { 'scout-custom': { baseAgent: 'scout-researcher' } },
    );

    const output = createOutput();
    await hook({ sessionID: 'sess-scout-custom', agent: 'scout-custom' }, output);

    expect(tracked.length).toBe(1);
    expect(tracked[0].patch).toEqual({
      agent: 'scout-custom',
      sessionKind: 'subagent',
      baseAgent: 'scout-researcher',
    });
  });

  it('skips session tracking when no sessionService provided', async () => {
    const hook = createVariantHook(
      createMockConfigService({ 'forager-worker': { model: 'anthropic/claude-sonnet', variant: 'high' } }) as any,
    );

    const output = createOutput();
    await hook({ sessionID: 'sess-no-svc', agent: 'forager-worker' }, output);

    expect(output.message.model.variant).toBe('high');
  });

  it('skips session tracking when no agent in input', async () => {
    const tracked: Array<{ sessionId: string; patch: Record<string, unknown> }> = [];
    const mockSessionService = {
      trackGlobal: (sessionId: string, patch?: Record<string, unknown>) => {
        tracked.push({ sessionId, patch: patch ?? {} });
        return { sessionId, startedAt: '', lastActiveAt: '' };
      },
    };

    const hook = createVariantHook(
      createMockConfigService({}) as any,
      mockSessionService as any,
    );

    const output = createOutput();
    await hook({ sessionID: 'sess-no-agent' }, output);

    expect(tracked.length).toBe(0);
  });
});
