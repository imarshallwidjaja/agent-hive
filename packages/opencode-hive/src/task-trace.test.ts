import { describe, expect, it } from 'bun:test';
import {
  appendTaskTraceHint,
  createTaskTraceTools,
  injectTaskTraceHint,
  segmentTaskTrace,
  TASK_TRACE_SUMMARIZER_AGENT,
} from './task-trace.js';

type Call = { method: string; input: unknown };

function message(id: string, role: 'user' | 'assistant', parts: Array<Record<string, unknown>>, completed = 2) {
  return {
    info: {
      id,
      sessionID: 'child',
      role,
      time: { created: 1, ...(completed ? { completed } : {}) },
    },
    parts: parts.map((part, index) => ({
      id: `${id}-part-${index}`,
      sessionID: 'child',
      messageID: id,
      ...part,
    })),
  };
}

function clientFor(messages: unknown[], options: {
  parentID?: string;
  childID?: string;
  status?: Record<string, unknown>;
  statusResponse?: { data?: unknown; error?: unknown };
  statusError?: unknown;
  promptText?: string | ((index: number, input: unknown) => string);
  promptParts?: Array<Record<string, unknown>>;
  mutateMessages?: (calls: number) => unknown[];
  deleteError?: unknown | ((index: number, input: unknown) => unknown | undefined);
} = {}) {
  const calls: Call[] = [];
  let messageReads = 0;
  let promptCalls = 0;
  let deleteCalls = 0;
  const session = {
    get: async (input: unknown) => {
      calls.push({ method: 'get', input });
      return { data: { id: options.childID ?? 'child', parentID: options.parentID ?? 'parent' } };
    },
    messages: async (input: unknown) => {
      calls.push({ method: 'messages', input });
      messageReads += 1;
      return { data: options.mutateMessages?.(messageReads) ?? messages };
    },
    status: async (input: unknown) => {
      calls.push({ method: 'status', input });
      if (options.statusError) throw options.statusError;
      return options.statusResponse ?? { data: options.status ?? {} };
    },
    create: async (input: unknown) => {
      calls.push({ method: 'create', input });
      return { data: { id: `summary-${calls.filter((call) => call.method === 'create').length}` } };
    },
    prompt: async (input: unknown) => {
      calls.push({ method: 'prompt', input });
      promptCalls += 1;
      if (options.promptParts) return { data: { parts: options.promptParts } };
      const text = typeof options.promptText === 'function'
        ? options.promptText(promptCalls, input)
        : options.promptText ?? '{"batch_id":"batch-1","steps":[]}';
      return { data: { parts: [{ type: 'text', text }] } };
    },
    delete: async (input: unknown) => {
      calls.push({ method: 'delete', input });
      deleteCalls += 1;
      const error = typeof options.deleteError === 'function'
        ? options.deleteError(deleteCalls, input)
        : options.deleteError;
      return error ? { error } : { data: true };
    },
  };
  return { client: { session }, calls };
}

function executeRaw(tools: ReturnType<typeof createTaskTraceTools>, name: 'hive_task_trace' | 'hive_task_trace_content', args: Record<string, unknown>) {
  return tools[name].execute(args as never, {
    sessionID: 'parent',
    messageID: 'parent-message',
    agent: 'hive-master',
    abort: new AbortController().signal,
  } as never);
}

function execute(tools: ReturnType<typeof createTaskTraceTools>, name: 'hive_task_trace' | 'hive_task_trace_content', args: Record<string, unknown>) {
  return executeRaw(tools, name, args).then((value) => JSON.parse(value));
}

describe('task trace segmentation', () => {
  it('preserves API order and closes malformed nested, orphan, implicit, and open steps deterministically', () => {
    const trace = segmentTaskTrace([
      message('m1', 'assistant', [
        { type: 'text', text: 'before' },
        { type: 'step-start' },
        { type: 'text', text: 'progress' },
        { type: 'step-start' },
        { type: 'step-finish' },
        { type: 'step-finish' },
        { type: 'step-start' },
      ]),
    ]);

    expect(trace.steps.map((step) => ({ id: step.step_id, close: step.close_reason }))).toEqual([
      { id: 'm1:step:1', close: 'implicit-boundary' },
      { id: 'm1:step:2', close: 'malformed:nested-start' },
      { id: 'm1:step:3', close: 'step-finish' },
      { id: 'm1:step:4', close: 'malformed:orphan-finish' },
      { id: 'm1:step:5', close: 'open' },
    ]);
    expect(trace.steps.flatMap((step) => step.evidence.map((item) => item.part_ordinal))).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('keeps reasoning out of evidence while reporting bounded opaque metadata and unknown mixed token totals', () => {
    const trace = segmentTaskTrace([
      message('m1', 'assistant', [
        { type: 'step-start' },
        { type: 'reasoning', text: 'private chain', tokens: 8 },
        {
          type: 'reasoning',
          metadata: { providerItemId: 'opaque-1', format: 'opaque', encrypted: 'secret', payload: 'ciphertext' },
          time: { start: 10, end: 11, payload: 'hidden timestamp payload' },
        },
        { type: 'text', text: 'answer', time: { end: 12 } },
        { type: 'step-finish' },
      ]),
    ]);

    expect(trace.reasoning).toMatchObject({
      availability: 'mixed',
      part_count: 2,
      plaintext_bytes: 13,
      token_count: null,
      known_token_count: 8,
      unknown_token_part_count: 1,
    });
    expect(trace.reasoning.opaque_parts[0]).toMatchObject({
      part_id: 'm1-part-2',
      metadata_keys: ['encrypted', 'format', 'providerItemId'],
      metadata: { format: 'opaque', providerItemId: 'opaque-1' },
      time: { start: 10, end: 11 },
    });
    expect(JSON.stringify(trace.steps)).not.toContain('private chain');
    expect(JSON.stringify(trace)).not.toContain('secret');
    expect(JSON.stringify(trace)).not.toContain('ciphertext');
    expect(JSON.stringify(trace)).not.toContain('hidden timestamp payload');
  });

  it('reports missing plaintext, opaque, and mixed reasoning token counts as unknown rather than zero', () => {
    for (const setup of [
      { parts: [{ type: 'reasoning', text: 'plaintext' }], availability: 'plaintext', known: 0 },
      { parts: [{ type: 'reasoning', metadata: { providerItemId: 'opaque-1' } }], availability: 'opaque', known: 0 },
      {
        parts: [{ type: 'reasoning', text: 'known', tokens: 3 }, { type: 'reasoning', metadata: { providerItemId: 'opaque-2' } }],
        availability: 'mixed',
        known: 3,
      },
    ]) {
      const trace = segmentTaskTrace([message('m1', 'assistant', setup.parts)]);
      const unknownEvidence = trace.steps[0].evidence.find((item) => item.representation === (setup.availability === 'plaintext' ? 'plaintext' : 'opaque') && item.tokens === undefined);

      expect(trace.reasoning).toMatchObject({
        availability: setup.availability,
        token_count: null,
        known_token_count: setup.known,
        unknown_token_part_count: 1,
      });
      expect(trace.messages[0].reasoning_token_count).toBeNull();
      expect(trace.steps[0].reasoning_token_count).toBeNull();
      expect(unknownEvidence).toBeDefined();
      expect(unknownEvidence).not.toHaveProperty('tokens');
    }
  });

  it('emits a remaining implicit step as open', () => {
    const trace = segmentTaskTrace([message('m1', 'assistant', [{ type: 'text', text: 'still working' }], 0)]);
    expect(trace.steps).toHaveLength(1);
    expect(trace.steps[0].close_reason).toBe('open');
  });

  it('marks compaction loss and distinguishes tool lifecycle, input, output, and patch provenance', () => {
    const compacted = message('m1', 'assistant', [
      { type: 'step-start' },
      { type: 'tool', tool: 'bash', state: { status: 'completed', input: { command: 'pwd' }, output: '/repo' } },
      { type: 'patch', patch: 'diff --git a/a b/a' },
      { type: 'compaction' },
      { type: 'step-finish' },
    ]);
    compacted.info.summary = true;

    const trace = segmentTaskTrace([compacted]);

    expect(trace.loss_markers).toHaveLength(2);
    expect(trace.loss_markers.every((marker) => marker.raw_fidelity === false)).toBe(true);
    expect(trace.steps[0].evidence.map((item) => item.provenance)).toEqual([
      'lifecycle_event',
      'lifecycle_event',
      'tool_input',
      'tool_output',
      'patch',
      'lifecycle_event',
      'lifecycle_event',
    ]);
  });

  it('associates reasoning and final text with the exact source step', () => {
    const trace = segmentTaskTrace([message('m1', 'assistant', [
      { type: 'step-start' },
      { type: 'reasoning', text: 'first reason' },
      { type: 'text', text: 'progress' },
      { type: 'step-finish' },
      { type: 'step-start' },
      { type: 'reasoning', text: 'second reason' },
      { type: 'text', text: 'final' },
      { type: 'step-finish' },
    ])]);

    expect(trace.steps.map((step) => step.reasoning_part_ids)).toEqual([['m1-part-1'], ['m1-part-5']]);
    expect(trace.steps[0].evidence.find((item) => item.type === 'text')?.provenance).toBe('assistant_progress_text');
    expect(trace.steps[1].evidence.find((item) => item.type === 'text')?.provenance).toBe('assistant_final_response');
  });
});

describe('task trace tools', () => {
  it('authorizes only a direct child and performs one get/messages/status read without polling', async () => {
    const { client, calls } = clientFor([message('m1', 'assistant', [{ type: 'text', text: 'done' }])]);
    const tools = createTaskTraceTools({ client, directory: '/repo', summarizer: { temperature: 0 }, ephemeralSessionIDs: new Set() });

    const result = await execute(tools, 'hive_task_trace', { task_id: 'child', mode: 'audit' });

    expect(result.ok).toBe(true);
    expect(calls.map((call) => call.method)).toEqual(['get', 'messages', 'status']);
  });

  it('returns one generic response for missing, sibling, and grandchild sessions', async () => {
    const { client, calls } = clientFor([], { parentID: 'other' });
    const tools = createTaskTraceTools({ client, directory: '/repo', summarizer: { temperature: 0 }, ephemeralSessionIDs: new Set() });

    const result = await execute(tools, 'hive_task_trace', { task_id: 'child' });

    expect(result).toEqual({ ok: false, reason: 'unavailable_or_unauthorized' });
    expect(calls.map((call) => call.method)).toEqual(['get']);
  });

  it('withholds recovery when status is active or the latest assistant/tool is open', async () => {
    const openMessages = [message('m1', 'assistant', [
      { type: 'tool', tool: 'bash', state: { status: 'running', input: { command: 'sleep 1' } } },
    ], 0)];
    for (const setup of [
      clientFor([message('m1', 'assistant', [{ type: 'text', text: 'done' }])], { status: { child: { type: 'busy' } } }),
      clientFor(openMessages),
    ]) {
      const tools = createTaskTraceTools({ client: setup.client, directory: '/repo', summarizer: { temperature: 0 }, ephemeralSessionIDs: new Set() });
      const result = await execute(tools, 'hive_task_trace', { task_id: 'child', mode: 'recovery' });
      expect(result.recovery).toEqual({ available: false, reason: expect.any(String) });
      expect(setup.calls.some((call) => call.method === 'create')).toBe(false);
    }
  });

  it('returns exact status_unavailable lifecycle and recovery results for every unusable status capability', async () => {
    const source = [message('m1', 'assistant', [{ type: 'text', text: 'done' }])];
    const missing = clientFor(source);
    delete (missing.client.session as { status?: unknown }).status;
    const setups = [
      missing,
      clientFor(source, { statusError: new Error('status failed') }),
      clientFor(source, { statusResponse: { error: 'status failed' } }),
      clientFor(source, { statusResponse: { data: [] } }),
      clientFor(source, { status: { bogus: 'not-a-status' } }),
      clientFor(source, { status: { other: null } }),
      clientFor(source, { status: { child: 'busy' } }),
      clientFor(source, { status: { child: { type: 'retry', attempt: 1, message: 'wait' } } }),
      clientFor(source, { status: { child: { type: 'retry', attempt: '1', message: 'wait', next: 2 } } }),
      clientFor(source, { status: { ok: { type: 'idle' }, bad: { type: 'busy', extra: true } } }),
    ];

    for (const setup of setups) {
      const tools = createTaskTraceTools({ client: setup.client, directory: '/repo', summarizer: { temperature: 0 }, ephemeralSessionIDs: new Set() });
      const result = await execute(tools, 'hive_task_trace', { task_id: 'child', mode: 'recovery' });

      expect(result.lifecycle).toEqual({
        state: 'uncertain',
        stable_terminal: false,
        incomplete: true,
        reason: 'status_unavailable',
      });
      expect(result.recovery).toEqual({ available: false, reason: 'status_unavailable' });
      expect(setup.calls.some((call) => call.method === 'create')).toBe(false);
    }
  });

  it('accepts complete valid session status maps and classifies busy or retry as active', async () => {
    const source = [message('m1', 'assistant', [{ type: 'text', text: 'done' }])];
    const validMaps = [
      {},
      { other: { type: 'idle' } },
      {
        other: {
          type: 'retry',
          attempt: 2,
          message: 'provider backoff',
          next: 1_700_000_000_000,
          action: {
            reason: 'rate_limit',
            provider: 'openai',
            title: 'Retry',
            message: 'Wait and retry',
            label: 'retry',
            link: 'https://example.test/retry',
          },
        },
      },
    ];

    for (const status of validMaps) {
      const { client, calls } = clientFor(source, { status });
      const tools = createTaskTraceTools({ client, directory: '/repo', summarizer: { temperature: 0 }, ephemeralSessionIDs: new Set() });
      const result = await execute(tools, 'hive_task_trace', { task_id: 'child', mode: 'recovery' });
      expect(result.lifecycle.reason).not.toBe('status_unavailable');
      expect(result.lifecycle.state).toBe('terminal');
      expect(calls.some((call) => call.method === 'create')).toBe(true);
    }

    for (const status of [
      { child: { type: 'busy' } },
      { child: { type: 'retry', attempt: 1, message: 'retrying', next: 99 } },
    ]) {
      const { client, calls } = clientFor(source, { status });
      const tools = createTaskTraceTools({ client, directory: '/repo', summarizer: { temperature: 0 }, ephemeralSessionIDs: new Set() });
      const result = await execute(tools, 'hive_task_trace', { task_id: 'child', mode: 'recovery' });
      expect(result.lifecycle).toEqual({
        state: 'active',
        stable_terminal: false,
        incomplete: true,
        reason: 'runtime_active',
      });
      expect(result.recovery).toEqual({ available: false, reason: 'runtime_active' });
      expect(calls.some((call) => call.method === 'create')).toBe(false);
    }

    const idleChild = clientFor(source, { status: { child: { type: 'idle' } } });
    const idleTools = createTaskTraceTools({
      client: idleChild.client,
      directory: '/repo',
      summarizer: { temperature: 0 },
      ephemeralSessionIDs: new Set(),
    });
    const idleResult = await execute(idleTools, 'hive_task_trace', { task_id: 'child', mode: 'recovery' });
    expect(idleResult.lifecycle.state).toBe('terminal');
    expect(idleResult.lifecycle.reason).toBe('idle_and_closed');
    expect(idleChild.calls.some((call) => call.method === 'create')).toBe(true);
  });

  it('withholds recovery when any source message still has a pending tool part', async () => {
    const source = [
      message('m1', 'assistant', [{ type: 'tool', tool: 'bash', state: { status: 'pending' } }]),
      message('m2', 'assistant', [{ type: 'reasoning', text: 'later reason' }, { type: 'text', text: 'later response' }]),
    ];
    const { client, calls } = clientFor(source);
    const tools = createTaskTraceTools({ client, directory: '/repo', summarizer: { temperature: 0 }, ephemeralSessionIDs: new Set() });

    const result = await execute(tools, 'hive_task_trace', { task_id: 'child', mode: 'recovery' });

    expect(result.lifecycle.reason).toBe('tool_pending_or_running');
    expect(result.recovery).toEqual({ available: false, reason: 'tool_pending_or_running' });
    expect(calls.some((call) => call.method === 'create')).toBe(false);
  });

  it('withholds recovery when the latest source turn is a user message or compaction-only assistant record', async () => {
    const summary = message('m2', 'assistant', [{ type: 'summary' }]);
    summary.info.summary = true;
    for (const setup of [
      {
        source: [
          message('m1', 'assistant', [{ type: 'text', text: 'done' }]),
          message('m2', 'user', [{ type: 'text', text: 'one more request' }]),
        ],
        reason: 'latest_message_not_assistant',
      },
      {
        source: [message('m1', 'assistant', [{ type: 'text', text: 'done' }]), summary],
        reason: 'latest_message_summary_or_compaction',
      },
      {
        source: [
          message('m1', 'assistant', [{ type: 'text', text: 'done' }]),
          message('m2', 'assistant', [{ type: 'compaction' }]),
        ],
        reason: 'latest_message_summary_or_compaction',
      },
    ]) {
      const { client, calls } = clientFor(setup.source);
      const tools = createTaskTraceTools({ client, directory: '/repo', summarizer: { temperature: 0 }, ephemeralSessionIDs: new Set() });

      const result = await execute(tools, 'hive_task_trace', { task_id: 'child', mode: 'recovery' });

      expect(result.lifecycle.reason).toBe(setup.reason);
      expect(result.recovery).toEqual({ available: false, reason: setup.reason });
      expect(calls.some((call) => call.method === 'create')).toBe(false);
    }
  });

  it('preserves complete-response ordinals and reports messages omitted from snapshots', async () => {
    const source = Array.from({ length: 25 }, (_, index) => message(`m${index + 1}`, 'assistant', [{ type: 'text', text: `answer-${index + 1}` }]));
    const { client, calls } = clientFor(source);
    const tools = createTaskTraceTools({ client, directory: '/repo', summarizer: { temperature: 0 }, ephemeralSessionIDs: new Set() });

    const result = await execute(tools, 'hive_task_trace', { task_id: 'child', mode: 'snapshot' });

    expect(result.messages.map((entry: any) => entry.message_ordinal)).toEqual(Array.from({ length: 20 }, (_, index) => index + 6));
    expect(result.steps.flatMap((step: any) => step.evidence).map((entry: any) => entry.message_ordinal)).toEqual(Array.from({ length: 20 }, (_, index) => index + 6));
    expect(result.truncation).toMatchObject({
      truncated: true,
      omitted_message_count: 5,
      omitted_part_count: 5,
      represented_range: {
        first_message_ordinal: 6,
        last_message_ordinal: 25,
        first_part: { message_ordinal: 6, part_ordinal: 1 },
        last_part: { message_ordinal: 25, part_ordinal: 1 },
      },
    });
    expect(calls.filter((call) => call.method === 'messages')).toHaveLength(1);
  });

  it('aggregate-bounds parts and bytes in every mode and never recovers a truncated trace', async () => {
    const source = [message('m1', 'assistant', Array.from({ length: 400 }, (_, index) => ({
      type: 'text',
      text: `part-${index + 1}:${'x'.repeat(6000)}`,
    })))];

    for (const mode of ['snapshot', 'audit', 'recovery'] as const) {
      const { client, calls } = clientFor(source);
      const tools = createTaskTraceTools({ client, directory: '/repo', summarizer: { temperature: 0 }, ephemeralSessionIDs: new Set() });

      const serialized = await executeRaw(tools, 'hive_task_trace', { task_id: 'child', mode });
      const result = JSON.parse(serialized);
      const evidence = result.steps.flatMap((step: any) => step.evidence);

      expect(result.bounded).toBe(true);
      expect(result.incomplete).toBe(true);
      expect(result.truncation.truncated).toBe(true);
      expect(result.truncation.omitted_message_count).toBe(0);
      expect(result.truncation.omitted_part_count).toBeGreaterThan(0);
      expect(evidence.length).toBeLessThanOrEqual(result.truncation.limits.max_parts);
      expect(result.truncation.represented_bytes).toBeLessThanOrEqual(result.truncation.limits.max_bytes);
      expect(result.truncation.limits.max_bytes).toBe(128 * 1024);
      expect(Buffer.byteLength(serialized, 'utf8')).toBeLessThanOrEqual(result.truncation.limits.max_bytes);
      expect(result.truncation.represented_range.first_message_ordinal).toBe(1);
      expect(result.truncation.represented_range.last_message_ordinal).toBe(1);
      expect(result.truncation.represented_range.first_part.message_ordinal).toBe(1);
      expect(result.truncation.represented_range.last_part.message_ordinal).toBe(1);
      if (mode === 'snapshot') {
        expect(result.truncation.represented_range.first_part.part_ordinal).toBeGreaterThan(1);
        expect(result.truncation.represented_range.last_part.part_ordinal).toBe(400);
      } else {
        expect(result.truncation.represented_range.first_part.part_ordinal).toBe(1);
        expect(result.truncation.represented_range.last_part.part_ordinal).toBeLessThan(400);
      }
      expect(calls.filter((call) => call.method === 'messages')).toHaveLength(1);
      if (mode === 'recovery') {
        expect(result.recovery).toEqual({ available: false, reason: 'trace_truncated' });
        expect(calls.some((call) => call.method === 'create')).toBe(false);
      }
    }
  });

  it('caps aggregate recovery summaries while retaining a bounded deterministic trace', async () => {
    const source = Array.from({ length: 64 }, (_, index) => message(`m${index + 1}`, 'assistant', [
      { type: 'text', text: `completed-${index + 1}` },
    ]));
    const { client } = clientFor(source, {
      promptText: (index, input) => {
        const request = JSON.parse((input as any).body.parts[0].text);
        return JSON.stringify({
          batch_id: `batch-${index}`,
          steps: request.steps.map((step: any) => ({
            step_id: step.step_id,
            summary: `Outcome for ${step.step_id}: ${'x'.repeat(1900)}`,
            reasoning_part_ids: step.reasoning_part_ids,
          })),
        });
      },
    });
    const tools = createTaskTraceTools({ client, directory: '/repo', summarizer: { temperature: 0 }, ephemeralSessionIDs: new Set() });

    const serialized = await executeRaw(tools, 'hive_task_trace', { task_id: 'child', mode: 'recovery' });
    const result = JSON.parse(serialized);
    const representedStepIDs = new Set(result.steps.map((step: any) => step.step_id));

    expect(result.ok).toBe(true);
    expect(result.steps.length).toBeGreaterThan(0);
    expect(Buffer.byteLength(serialized, 'utf8')).toBeLessThanOrEqual(128 * 1024);
    expect(result.recovery).toMatchObject({ available: false, reason: 'summary_output_too_large' });
    expect(result.recovery.summaries.every((summary: any) => representedStepIDs.has(summary.step_id))).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(result.recovery.summaries), 'utf8')).toBeLessThanOrEqual(
      result.truncation.limits.max_recovery_summary_bytes,
    );
    expect(Buffer.byteLength(serialized, 'utf8')).toBeLessThanOrEqual(result.truncation.limits.max_bytes);
  });

  it('returns a compact explicit limit result when envelope data exceeds the reserved budget', async () => {
    const taskID = `child-${'x'.repeat(140 * 1024)}`;
    const { client } = clientFor([message('m1', 'assistant', [{ type: 'text', text: 'done' }])], { childID: taskID });
    const tools = createTaskTraceTools({ client, directory: '/repo', summarizer: { temperature: 0 }, ephemeralSessionIDs: new Set() });

    const serialized = await executeRaw(tools, 'hive_task_trace', { task_id: taskID, mode: 'audit' });

    expect(Buffer.byteLength(serialized, 'utf8')).toBeLessThanOrEqual(128 * 1024);
    expect(JSON.parse(serialized)).toEqual({
      ok: false,
      reason: 'result_size_limit',
      mode: 'audit',
      bounded: true,
      incomplete: true,
      limits: { max_bytes: 128 * 1024 },
    });
    expect(serialized).not.toContain(taskID);
  });

  it('keeps raw reasoning out of snapshot, audit, and content retrieval', async () => {
    const large = 'x'.repeat(5000);
    const reasoning = 'never retrievable as deterministic trace content';
    const source = [message('m1', 'assistant', [
      { type: 'text', text: large },
      { type: 'reasoning', text: reasoning },
    ])];

    for (const mode of ['snapshot', 'audit'] as const) {
      const { client } = clientFor(source, {
        mutateMessages: (count) => count < 3 ? source : [message('m1', 'assistant', [{ type: 'text', text: `${large}changed` }])],
      });
      const tools = createTaskTraceTools({ client, directory: '/repo', summarizer: { temperature: 0 }, ephemeralSessionIDs: new Set() });
      const trace = await execute(tools, 'hive_task_trace', { task_id: 'child', mode });
      const evidence = trace.steps.flatMap((step: any) => step.evidence).find((item: any) => item.provenance === 'assistant_final_response');

      expect(JSON.stringify(trace)).not.toContain(reasoning);
      expect(trace.reasoning).toMatchObject({ availability: 'plaintext', plaintext_part_count: 1 });
      expect(evidence.text.preview).toHaveLength(512);
      expect(evidence.text.content_id).toBeString();
      expect(await execute(tools, 'hive_task_trace_content', { content_id: evidence.text.content_id })).toEqual({
        ok: true,
        content: large,
        bytes: 5000,
        sha256: expect.any(String),
      });
      expect(await execute(tools, 'hive_task_trace_content', { content_id: evidence.text.content_id })).toEqual({
        ok: false,
        reason: 'stale_or_not_found',
      });
      const forbidden = Buffer.from(JSON.stringify({ v: 1, sessionID: 'child', messageID: 'm1', partID: 'm1-part-1', field: 'reasoning.text', bytes: 5000, sha256: 'a'.repeat(64) })).toString('base64url');
      expect(await execute(tools, 'hive_task_trace_content', { content_id: forbidden })).toEqual({ ok: false, reason: 'invalid_content_id' });
    }
  });

  it('returns a restated reasoning summary only as an untrusted reasoning-derived interpretation', async () => {
    const reasoning = 'Considered the failure, checked tool evidence, and chose the smallest fix.';
    const source = [message('m1', 'assistant', [
      { type: 'step-start' },
      { type: 'reasoning', text: reasoning },
      { type: 'text', text: 'Checking the failing path.' },
      { type: 'tool', tool: 'test', state: { status: 'completed', input: { file: 'task-trace.test.ts' }, output: '1 failed' } },
      { type: 'text', text: 'Fixed the reasoning summary contract.' },
      { type: 'step-finish' },
    ])];
    const promptText = JSON.stringify({
      batch_id: 'batch-1',
      steps: [{ step_id: 'm1:step:1', summary: reasoning, reasoning_part_ids: ['m1-part-1'] }],
    });
    const { client, calls } = clientFor(source, { promptText });
    const ephemeralSessionIDs = new Set<string>();
    const tools = createTaskTraceTools({
      client,
      directory: '/repo',
      summarizer: { model: 'provider/model', variant: 'high', temperature: 0.2 },
      ephemeralSessionIDs,
    });

    const result = await execute(tools, 'hive_task_trace', { task_id: 'child', mode: 'recovery' });

    expect(result.recovery.available).toBe(true);
    expect(result.recovery.summaries[0]).toEqual({
      step_id: 'm1:step:1',
      summary: reasoning,
      provenance: 'summarizer_interpretation',
      reasoning_part_ids: ['m1-part-1'],
      untrusted: true,
    });
    const evidence = result.steps[0].evidence;
    expect(evidence.find((item: any) => item.provenance === 'assistant_progress_text')?.text).toBe('Checking the failing path.');
    expect(evidence.find((item: any) => item.provenance === 'assistant_final_response')?.text).toBe('Fixed the reasoning summary contract.');
    expect(evidence.find((item: any) => item.provenance === 'tool_output')?.output).toBe('1 failed');
    expect(JSON.stringify(evidence)).not.toContain(reasoning);
    expect(result.reasoning).toMatchObject({ availability: 'plaintext', plaintext_part_count: 1 });
    expect(calls.map((call) => call.method)).toEqual(['get', 'messages', 'status', 'create', 'prompt', 'delete']);
    expect((calls.find((call) => call.method === 'create')!.input as any).body.parentID).toBeUndefined();
    expect((calls.find((call) => call.method === 'prompt')!.input as any).body).toMatchObject({
      agent: TASK_TRACE_SUMMARIZER_AGENT,
      model: { providerID: 'provider', modelID: 'model' },
    });
    expect((calls.find((call) => call.method === 'prompt')!.input as any).body).not.toHaveProperty('variant');
    const request = JSON.parse((calls.find((call) => call.method === 'prompt')!.input as any).body.parts[0].text);
    expect(request.steps[0].source.reasoning).toEqual([{ part_id: 'm1-part-1', text: reasoning }]);
    expect(ephemeralSessionIDs.size).toBe(0);
  });

  it('rejects malformed JSON, IDs, order, extra fields, and per-summary bounds without retry', async () => {
    const source = [
      message('m1', 'assistant', [{ type: 'reasoning', text: 'first basis' }]),
      message('m2', 'assistant', [{ type: 'reasoning', text: 'second basis' }]),
    ];
    const validSteps = [
      { step_id: 'm1:step:1', summary: 'First interpretation.', reasoning_part_ids: ['m1-part-0'] },
      { step_id: 'm2:step:1', summary: 'Second interpretation.', reasoning_part_ids: ['m2-part-0'] },
    ];
    const invalidOutputs = [
      'not json',
      JSON.stringify({ batch_id: 'wrong', steps: validSteps }),
      JSON.stringify({ batch_id: 'batch-1', steps: validSteps, extra: true }),
      JSON.stringify({ batch_id: 'batch-1', steps: [...validSteps].reverse() }),
      JSON.stringify({ batch_id: 'batch-1', steps: [{ ...validSteps[0], step_id: 'wrong' }, validSteps[1]] }),
      JSON.stringify({ batch_id: 'batch-1', steps: [{ ...validSteps[0], reasoning_part_ids: ['wrong'] }, validSteps[1]] }),
      JSON.stringify({ batch_id: 'batch-1', steps: [{ ...validSteps[0], provenance: 'assistant_final_response', untrusted: false }, validSteps[1]] }),
      JSON.stringify({ batch_id: 'batch-1', steps: [{ ...validSteps[0], summary: 'x'.repeat(2049) }, validSteps[1]] }),
    ];

    for (const promptText of invalidOutputs) {
      const { client, calls } = clientFor(source, { promptText });
      const tools = createTaskTraceTools({ client, directory: '/repo', summarizer: { temperature: 0 }, ephemeralSessionIDs: new Set() });

      const result = await execute(tools, 'hive_task_trace', { task_id: 'child', mode: 'recovery' });

      expect(result.recovery).toEqual({ available: false, reason: 'invalid_summary_output', summaries: [] });
      expect(calls.filter((call) => call.method === 'prompt')).toHaveLength(1);
      expect(calls.filter((call) => call.method === 'delete')).toHaveLength(1);
    }
  });

  it('rejects an oversized single summarizer text part before parsing without retry', async () => {
    const source = [message('m1', 'assistant', [{ type: 'reasoning', text: 'private basis' }])];
    const valid = JSON.stringify({
      batch_id: 'batch-1',
      steps: [{ step_id: 'm1:step:1', summary: 'The assistant evaluated the evidence.', reasoning_part_ids: ['m1-part-0'] }],
    });
    const { client, calls } = clientFor(source, {
      promptParts: [{ type: 'text', text: `${' '.repeat(40 * 1024)}${valid}` }],
    });
    const tools = createTaskTraceTools({ client, directory: '/repo', summarizer: { temperature: 0 }, ephemeralSessionIDs: new Set() });

    const result = await execute(tools, 'hive_task_trace', { task_id: 'child', mode: 'recovery' });

    expect(result.recovery).toEqual({ available: false, reason: 'summarizer_response_limit_exceeded', summaries: [] });
    expect(calls.filter((call) => call.method === 'prompt')).toHaveLength(1);
    expect(calls.filter((call) => call.method === 'delete')).toHaveLength(1);
  });

  it('rejects too many summarizer text parts before concatenation without retry', async () => {
    const source = [message('m1', 'assistant', [{ type: 'reasoning', text: 'private basis' }])];
    const valid = JSON.stringify({
      batch_id: 'batch-1',
      steps: [{ step_id: 'm1:step:1', summary: 'The assistant evaluated the evidence.', reasoning_part_ids: ['m1-part-0'] }],
    });
    const { client, calls } = clientFor(source, {
      promptParts: [
        ...Array.from({ length: 32 }, () => ({ type: 'text', text: ' ' })),
        { type: 'text', text: valid },
      ],
    });
    const tools = createTaskTraceTools({ client, directory: '/repo', summarizer: { temperature: 0 }, ephemeralSessionIDs: new Set() });

    const result = await execute(tools, 'hive_task_trace', { task_id: 'child', mode: 'recovery' });

    expect(result.recovery).toEqual({ available: false, reason: 'summarizer_response_limit_exceeded', summaries: [] });
    expect(calls.filter((call) => call.method === 'prompt')).toHaveLength(1);
    expect(calls.filter((call) => call.method === 'delete')).toHaveLength(1);
  });

  it('summarizes stable contiguous steps even when a step has no plaintext reasoning', async () => {
    const source = [message('m1', 'assistant', [{ type: 'text', text: 'observed final response' }])];
    const { client } = clientFor(source, {
      promptText: JSON.stringify({
        batch_id: 'batch-1',
        steps: [{ step_id: 'm1:step:1', summary: 'The assistant produced a final response.', reasoning_part_ids: [] }],
      }),
    });
    const tools = createTaskTraceTools({ client, directory: '/repo', summarizer: { temperature: 0 }, ephemeralSessionIDs: new Set() });

    const result = await execute(tools, 'hive_task_trace', { task_id: 'child', mode: 'recovery' });

    expect(result.recovery.available).toBe(true);
    expect(result.recovery.summaries[0]).toMatchObject({
      provenance: 'summarizer_interpretation',
      reasoning_part_ids: [],
      untrusted: true,
    });
  });

  it('keeps an undeleted summarizer session isolated after cleanup failure', async () => {
    const source = [message('m1', 'assistant', [{ type: 'reasoning', text: 'reason' }])];
    const { client } = clientFor(source, {
      promptText: JSON.stringify({
        batch_id: 'batch-1',
        steps: [{ step_id: 'm1:step:1', summary: 'Interpretation.', reasoning_part_ids: ['m1-part-0'] }],
      }),
      deleteError: 'failed',
    });
    const ephemeralSessionIDs = new Set<string>();
    const tools = createTaskTraceTools({ client, directory: '/repo', summarizer: { temperature: 0 }, ephemeralSessionIDs });

    const result = await execute(tools, 'hive_task_trace', { task_id: 'child', mode: 'recovery' });

    expect(result.recovery).toMatchObject({ available: false, reason: 'ephemeral_cleanup_failed' });
    expect(ephemeralSessionIDs).toEqual(new Set(['summary-1']));
  });

  it('batches at most eight ordered steps per ephemeral session', async () => {
    const source = Array.from({ length: 9 }, (_, index) => message(`m${index + 1}`, 'assistant', [
      { type: 'step-start' },
      { type: 'reasoning', text: `private-basis-qwzxvut-${index + 1}-xykjmnp` },
      { type: 'step-finish' },
    ]));
    const { client, calls } = clientFor(source, {
      promptText: (index, input) => {
        const body = (input as any).body;
        const request = JSON.parse(body.parts[0].text);
        return JSON.stringify({
          batch_id: `batch-${index}`,
          steps: request.steps.map((step: any) => ({
            step_id: step.step_id,
            summary: `Interpretation for ${step.step_id}`,
            reasoning_part_ids: step.reasoning_part_ids,
          })),
        });
      },
    });
    const tools = createTaskTraceTools({ client, directory: '/repo', summarizer: { temperature: 0 }, ephemeralSessionIDs: new Set() });

    const result = await execute(tools, 'hive_task_trace', { task_id: 'child', mode: 'recovery' });

    expect(result.recovery.available).toBe(true);
    expect(result.recovery.summaries.map((summary: any) => summary.step_id)).toEqual(source.map((_, index) => `m${index + 1}:step:1`));
    expect(calls.filter((call) => call.method === 'create')).toHaveLength(2);
    expect(calls.filter((call) => call.method === 'prompt')).toHaveLength(2);
    expect(calls.filter((call) => call.method === 'delete')).toHaveLength(2);
  });

  it('validates a near-limit recovery batch within a bounded test timeout', async () => {
    const source = Array.from({ length: 8 }, (_, index) => message(`m${index + 1}`, 'assistant', [
      { type: 'reasoning', text: 'q'.repeat(3500) },
    ]));
    const { client, calls } = clientFor(source, {
      promptText: (_index, input) => {
        const request = JSON.parse((input as any).body.parts[0].text);
        return JSON.stringify({
          batch_id: 'batch-1',
          steps: request.steps.map((step: any) => ({
            step_id: step.step_id,
            summary: 'z'.repeat(1800),
            reasoning_part_ids: step.reasoning_part_ids,
          })),
        });
      },
    });
    const tools = createTaskTraceTools({ client, directory: '/repo', summarizer: { temperature: 0 }, ephemeralSessionIDs: new Set() });

    const result = await execute(tools, 'hive_task_trace', { task_id: 'child', mode: 'recovery' });

    expect(result.recovery.available).toBe(true);
    expect(result.recovery.summaries).toHaveLength(8);
    expect(calls.filter((call) => call.method === 'prompt')).toHaveLength(1);
  }, 5000);
});

describe('task trace lifecycle hints', () => {
  it('adds bounded metadata hints without parsing rendered task output', () => {
    const output = { title: 'task', output: '', metadata: { sessionId: 'child' } };
    appendTaskTraceHint({ tool: 'task' }, output);
    appendTaskTraceHint({ tool: 'task' }, output);
    expect(output.output).toContain('hive_task_trace({ task_id: "child" })');
    expect(output.output.match(/\[hive task trace\]/g)).toHaveLength(1);

    const longOutput = { title: 'task', output: 'x'.repeat(20_000), metadata: { sessionId: 'child' } };
    appendTaskTraceHint({ tool: 'task' }, longOutput);
    expect(longOutput.output.startsWith('x'.repeat(20_000))).toBe(true);
    expect(longOutput.output).toContain('[hive task trace]');
  });

  it('injects one idempotent synthetic hint only for an authorized metadata child', async () => {
    const messages: any[] = [{
      info: { id: 'parent-tool', sessionID: 'parent', role: 'assistant' },
      parts: [{ id: 'task-part', type: 'tool', tool: 'task', state: { status: 'completed', output: '' }, metadata: { sessionId: 'child' } }],
    }];
    const authorize = async (child: string, parent: string) => child === 'child' && parent === 'parent';
    const seen = new Set<string>();
    await injectTaskTraceHint(messages, authorize, seen);
    await injectTaskTraceHint(messages, authorize, seen);
    expect(messages[0].parts.filter((part: any) => part.type === 'text' && part.synthetic)).toHaveLength(1);

    const replayed = [{ info: messages[0].info, parts: [messages[0].parts[0]] }] as any[];
    await injectTaskTraceHint(replayed, authorize, seen);
    expect(replayed[0].parts).toHaveLength(1);
  });

  it('attempts lifecycle-hint authorization once per candidate even when authorization fails', async () => {
    const messages: any[] = [{
      info: { id: 'parent-tool', sessionID: 'parent', role: 'assistant' },
      parts: [{ id: 'task-part', type: 'tool', tool: 'task', state: { status: 'error' }, metadata: { sessionId: 'child' } }],
    }];
    const seen = new Set<string>();
    let authorizationCalls = 0;
    const authorize = async () => {
      authorizationCalls += 1;
      return false;
    };

    await injectTaskTraceHint(messages, authorize, seen);
    await injectTaskTraceHint(messages, authorize, seen);

    expect(authorizationCalls).toBe(1);
    expect(messages[0].parts).toHaveLength(1);
  });
});
