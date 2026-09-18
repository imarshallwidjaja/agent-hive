import { describe, it, expect } from 'bun:test';
import { createVariantHook, classifySession } from './variant-hook.js';

const createMockConfigService = (
  agentVariants: Record<string, string | undefined>,
  configuredAgents: string[] = Object.keys(agentVariants),
) => ({
  hasConfiguredAgent: (agent: string) => configuredAgents.includes(agent),
  getAgentConfig: (agent: string) => ({ variant: agentVariants[agent] }),
});

const createOutput = (variant?: string) => ({ message: { variant }, parts: [] });

describe('createVariantHook', () => {
  describe('applies variant to configured agents', () => {
    it('sets variant when message has no variant and agent has configured variant', async () => {
      const configService = createMockConfigService({
        'forager-worker': 'high',
      });

      const hook = createVariantHook(configService as any);

      const input = {
        sessionID: 'session-123',
        agent: 'forager-worker',
        model: { providerID: 'anthropic', modelID: 'claude-sonnet' },
        messageID: 'msg-1',
        variant: undefined,
      };

      const output = createOutput(undefined);

      await hook(input, output);

      expect(output.message.variant).toBe('high');
    });

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
    ])('applies variant %s = %s', async (agent, variant) => {
      const hook = createVariantHook(createMockConfigService({ [agent]: variant }) as any);
      const output = createOutput(undefined);

      await hook({ sessionID: 'session-123', agent }, output);

      expect(output.message.variant).toBe(variant);
    });
  });

  describe('respects explicit variant', () => {
    it('does not override already-set variant', async () => {
      const configService = createMockConfigService({
        'forager-worker': 'high',
      });

      const hook = createVariantHook(configService as any);

      const output = createOutput('low'); // Already set

      await hook(
        { sessionID: 'session-123', agent: 'forager-worker', variant: 'low' },
        output,
      );

      expect(output.message.variant).toBe('low');
    });
  });

  describe('does not apply to non-Hive agents', () => {
    it('does not set variant for unknown agent', async () => {
      const configService = createMockConfigService({
        'forager-worker': 'high',
      });

      const hook = createVariantHook(configService as any);

      const output = createOutput(undefined);

      await hook(
        { sessionID: 'session-123', agent: 'some-other-agent' },
        output,
      );

      expect(output.message.variant).toBeUndefined();
    });

    it.each(['build', 'plan', 'code'])('does not set variant for built-in OpenCode agent %s', async (agent) => {
      const configService = createMockConfigService({
        'forager-worker': 'high',
      });

      const hook = createVariantHook(configService as any);
      const output = createOutput(undefined);

      await hook({ sessionID: 'session-123', agent }, output);

      expect(output.message.variant).toBeUndefined();
    });
  });

  describe('handles edge cases', () => {
    it('handles missing agent in input', async () => {
      const configService = createMockConfigService({
        'forager-worker': 'high',
      });

      const hook = createVariantHook(configService as any);

      const output = createOutput(undefined);

      await hook(
        { sessionID: 'session-123', agent: undefined },
        output,
      );

      expect(output.message.variant).toBeUndefined();
    });

    for (const variant of ['', '   ', undefined]) {
      it(`treats ${String(variant)} as unset`, async () => {
        const hook = createVariantHook(createMockConfigService({
          'forager-worker': variant,
        }) as any);

        const output = createOutput(undefined);

        await hook(
          { sessionID: 'session-123', agent: 'forager-worker' },
          output,
        );

        expect(output.message.variant).toBeUndefined();
      });
    }

    it('trims variant before applying', async () => {
      const configService = createMockConfigService({
        'forager-worker': '  high  ',
      });

      const hook = createVariantHook(configService as any);

      const output = createOutput(undefined);

      await hook(
        { sessionID: 'session-123', agent: 'forager-worker' },
        output,
      );

      expect(output.message.variant).toBe('high');
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
      createMockConfigService({ 'forager-worker': 'high' }) as any,
      mockSessionService as any,
      { 'forager-ui': { baseAgent: 'forager-worker' } },
    );

    const output = createOutput(undefined);
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
      createMockConfigService({ 'hive-master': 'max' }) as any,
      mockSessionService as any,
    );

    const output = createOutput(undefined);
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

    const output = createOutput(undefined);
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
      createMockConfigService({ 'scout-custom': 'low' }, ['scout-custom']) as any,
      mockSessionService as any,
      { 'scout-custom': { baseAgent: 'scout-researcher' } },
    );

    const output = createOutput(undefined);
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
      createMockConfigService({ 'forager-worker': 'high' }) as any,
    );

    const output = createOutput(undefined);
    await hook({ sessionID: 'sess-no-svc', agent: 'forager-worker' }, output);

    expect(output.message.variant).toBe('high');
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

    const output = createOutput(undefined);
    await hook({ sessionID: 'sess-no-agent' }, output);

    expect(tracked.length).toBe(0);
  });
});
