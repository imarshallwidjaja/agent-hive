import { describe, expect, it } from 'bun:test';
import {
  appendTaskTraceHint,
  createTaskTraceTools,
  injectTaskTraceHint,
  TASK_TRACE_SUMMARIZER_AGENT,
} from './task-trace.js';

type Call = { method: string; input: any };

function message(
  id: string,
  role: 'user' | 'assistant',
  parts: Array<Record<string, unknown>>,
  options: { completed?: boolean; error?: unknown; summary?: boolean } = {},
) {
  const completed = options.completed ?? true;
  return {
    info: {
      id,
      sessionID: 'child',
      role,
      time: { created: 1, ...(completed ? { completed: 2 } : {}) },
      ...(options.error === undefined ? {} : { error: options.error }),
      ...(options.summary ? { summary: true } : {}),
    },
    parts: parts.map((part, index) => ({
      id: `${id}-part-${index}`,
      sessionID: 'child',
      messageID: id,
      ...part,
    })),
  };
}

function sourceSteps(start: number, end: number): number[] {
  return Array.from({ length: end - start + 1 }, (_, index) => start + index);
}

function balancedRanges(stepCount: number): Array<[number, number]> {
  const phaseCount = stepCount <= 12
    ? stepCount
    : Math.min(12, Math.max(6, Math.ceil(stepCount / 8)));
  const ranges: Array<[number, number]> = [];
  let start = 1;
  for (let index = 0; index < phaseCount; index += 1) {
    const remainingSteps = stepCount - start + 1;
    const remainingPhases = phaseCount - index;
    const size = Math.ceil(remainingSteps / remainingPhases);
    const end = start + size - 1;
    ranges.push([start, end]);
    start = end + 1;
  }
  return ranges;
}

function semanticReduction(stepCount: number, overrides: Record<string, unknown> = {}) {
  return {
    overview: 'The child investigated the task, changed the implementation, and reported the result.',
    phases: balancedRanges(stepCount).map(([start, end], index) => ({
      range: [start, end],
      title: `Work phase ${index + 1}`,
      intent: index === 0 ? 'Understand and implement the requested change.' : 'Advance and verify the implementation.',
      actions: [`Worked through source steps ${start}-${end}.`],
      findings: [`Source coverage includes steps ${start}-${end}.`],
      outcome: `Completed phase ${index + 1}.`,
      unresolved: [],
      source_steps: sourceSteps(start, end),
    })),
    completed: [{ claim: 'Implemented the requested change.', source_steps: sourceSteps(1, stepCount) }],
    unfinished: [],
    safest_next_action: {
      action: 'review_completed_work',
      context: null,
      source_steps: sourceSteps(1, stepCount),
    },
    ...overrides,
  };
}

function semanticMap(request: any, cardOverrides: Record<number, Record<string, unknown>> = {}) {
  return {
    kind: 'map',
    range: request.range,
    cards: [...new Set<number>(request.fragments.map((fragment: any) => Number(fragment.step)))].map((step) => ({
      step,
      intent: step === 1 ? 'Understand the delegated task.' : 'Advance the delegated implementation.',
      actions: [`Handled source step ${step}.`],
      findings: [`Recovered the semantic result of source step ${step}.`],
      outcome: `Source step ${step} completed.`,
      unresolved: [],
      basis: request.fragments.find((fragment: any) => fragment.step === step).source.basis,
      ...cardOverrides[step],
    })),
  };
}

function clientFor(messages: unknown[], options: {
  parentID?: string;
  childID?: string;
  status?: Record<string, unknown>;
  statusResponse?: { data?: unknown; error?: unknown };
  statusError?: unknown;
  mutateMessages?: (reads: number) => unknown[];
  prompt?: (request: any, call: number) => unknown | Promise<unknown>;
  promptError?: (request: any, call: number) => unknown;
  providers?: (input: any) => unknown | Promise<unknown>;
  abort?: (call: number, input: any) => unknown | Promise<unknown>;
  delete?: (call: number, input: any) => unknown | Promise<unknown>;
} = {}) {
  const calls: Call[] = [];
  let messageReads = 0;
  let promptCalls = 0;
  let abortCalls = 0;
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
    prompt: async (input: any) => {
      calls.push({ method: 'prompt', input });
      promptCalls += 1;
      const request = JSON.parse(input.body.parts[0].text);
      const error = options.promptError?.(request, promptCalls);
      if (error) return { error };
      const supplied = await options.prompt?.(request, promptCalls);
      if (
        supplied
        && typeof supplied === 'object'
        && Array.isArray((supplied as { parts?: unknown }).parts)
        && !('kind' in (supplied as object))
      ) {
        return {
          data: {
            model: { providerID: 'observed-provider', modelID: 'observed-model' },
            variant: 'observed-variant',
            ...(supplied as Record<string, unknown>),
          },
        };
      }
      const response = supplied ?? (request.kind === 'map'
        ? semanticMap(request)
        : { kind: 'reduce', semantic: semanticReduction(request.step_count) });
      return {
        data: {
          model: { providerID: 'observed-provider', modelID: 'observed-model' },
          variant: 'observed-variant',
          parts: [{ type: 'text', text: JSON.stringify(response) }],
        },
      };
    },
    abort: async (input: any) => {
      calls.push({ method: 'abort', input });
      abortCalls += 1;
      return await options.abort?.(abortCalls, input) ?? { data: true };
    },
    delete: async (input: any) => {
      calls.push({ method: 'delete', input });
      deleteCalls += 1;
      return await options.delete?.(deleteCalls, input) ?? { data: true };
    },
  };
  const config = {
    providers: async (input: any) => {
      calls.push({ method: 'providers', input });
      return await options.providers?.(input) ?? {
        data: {
          providers: [{ id: 'requested', models: { model: { limit: { context: 10_000, output: 1_000 } } } }],
        },
      };
    },
  };
  return { client: { session, config }, calls };
}

function toolsFor(setup: ReturnType<typeof clientFor>, ephemeralSessionIDs = new Set<string>()) {
  return createTaskTraceTools({
    client: setup.client,
    directory: '/repo',
    summarizer: { model: 'requested/model', variant: 'high', temperature: 0 },
    ephemeralSessionIDs,
  });
}

function executeRaw(
  tools: ReturnType<typeof createTaskTraceTools>,
  name: 'hive_task_trace' | 'hive_task_trace_content',
  args: Record<string, unknown>,
  abort = new AbortController().signal,
) {
  return tools[name].execute(args as never, {
    sessionID: 'parent',
    messageID: 'parent-message',
    agent: 'hive-master',
    abort,
  } as never);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function settleUntil(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 100 && !predicate(); index += 1) await Promise.resolve();
  expect(predicate()).toBe(true);
}

function interceptTimers() {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const timers: Array<{ callback: () => void; delay: number; active: boolean }> = [];
  globalThis.setTimeout = ((callback: () => void, delay = 0) => {
    const timer = { callback, delay, active: true };
    timers.push(timer);
    return timer as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((timer: ReturnType<typeof setTimeout>) => {
    const captured = timer as unknown as { active?: boolean };
    if (captured) captured.active = false;
  }) as typeof clearTimeout;
  return {
    timers,
    active(delay?: number) {
      return timers.filter((timer) => timer.active && (delay === undefined || timer.delay === delay));
    },
    fire(timer: { callback: () => void; active: boolean; delay?: number }) {
      timer.active = false;
      timer.callback();
    },
    restore() {
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    },
  };
}

async function execute(
  tools: ReturnType<typeof createTaskTraceTools>,
  name: 'hive_task_trace' | 'hive_task_trace_content',
  args: Record<string, unknown>,
) {
  return JSON.parse(await executeRaw(tools, name, args));
}

function allKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(allKeys);
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, child]) => [key, ...allKeys(child)]);
}

function realisticTrace() {
  const messages: unknown[] = [];
  messages.push(message('instruction', 'user', [{ type: 'text', text: 'Implement every requested invariant.' }]));
  for (let index = 1; index <= 57; index += 1) {
    const parts: Array<Record<string, unknown>> = [
      { type: 'step-start' },
      { type: 'reasoning', text: `private reasoning ${index}`, tokens: index },
      { type: 'text', text: `progress ${index}` },
      { type: 'tool', tool: index % 2 ? 'bash' : 'read', state: { status: 'completed', input: { index }, output: `output ${index}` } },
      ...(index === 29 ? [{ type: 'retry', error: { name: 'ProviderError', message: 'middle retry' } }] : []),
      { type: 'step-finish' },
    ];
    messages.push(message(`assistant-${index}`, 'assistant', parts));
  }
  messages.push(message('tail', 'assistant', [
    { type: 'step-start' },
    { type: 'text', text: 'All requested work succeeded.' },
    { type: 'patch', files: ['src/final.ts', 'src/shared.ts'], hash: 'not-public' },
    { type: 'step-finish' },
  ]));
  return messages;
}

describe('compact task trace v2', () => {
  it('returns every realistic source step once with compact indexes and no v1 fields', async () => {
    const source = realisticTrace();
    const setup = clientFor(source);
    const serialized = await executeRaw(toolsFor(setup), 'hive_task_trace', { task_id: 'child' });
    const explicitSetup = clientFor(source);
    const explicitForensic = await executeRaw(toolsFor(explicitSetup), 'hive_task_trace', { task_id: 'child', recovery: false });
    const result = JSON.parse(serialized);

    expect(result).toMatchObject({ ok: true, version: 2, task_id: 'child' });
    expect(result.source).toMatchObject({ messages: 59, parts: 291, steps: 59, fidelity: 'surviving_source' });
    expect(result.timeline.map((step: any) => step.step)).toEqual(Array.from({ length: 59 }, (_, index) => index + 1));
    expect(result.timeline.filter((step: any) => step.actor === 'user')).toHaveLength(1);
    expect(result.instruction).toEqual({ step: 1, text: 1 });
    expect(result.latest.final).toEqual({ step: 59, text: 1 });
    expect(result.changed_files).toEqual({ files: ['src/final.ts', 'src/shared.ts'], exhaustive: false });
    expect(result.errors.some((entry: any) => JSON.stringify(entry).includes('middle retry'))).toBe(true);
    expect(result.tool_dictionary).toEqual(['bash', 'read']);
    expect(result.tool_rollup).toEqual([
      { tool: 1, statuses: { completed: 29 } },
      { tool: 2, statuses: { completed: 28 } },
    ]);
    expect(setup.calls.map((call) => call.method)).toEqual(['get', 'messages', 'status']);
    expect(Buffer.byteLength(serialized)).toBe(result.render.actual_bytes);
    expect(result.render).toMatchObject({ soft_target_bytes: 24_576, externalized_count: expect.any(Number) });
    expect(explicitForensic).toBe(serialized);
    expect(explicitSetup.calls.map((call) => call.method)).toEqual(['get', 'messages', 'status']);

    const forbidden = new Set([
      'mode', 'evidence', 'message_id', 'part_id', 'message_ordinal', 'part_ordinal', 'step_id',
      'reasoning_part_ids', 'provenance', 'truncation', 'bounded', 'incomplete', 'trace_truncated', 'result_size_limit',
      'soft_target', 'over_soft_target',
    ]);
    expect(allKeys(result).filter((key) => forbidden.has(key))).toEqual([]);
    expect(result).not.toHaveProperty('messages');
    expect(serialized).not.toContain('private reasoning');
    expect(serialized).not.toContain('assistant-57-part');
  });

  it('preserves robust malformed/open boundaries and closes implicit steps with their message', async () => {
    const source = [message('m1', 'assistant', [
      { type: 'text', text: 'before' },
      { type: 'step-start' },
      { type: 'text', text: 'nested' },
      { type: 'step-start' },
      { type: 'step-finish' },
      { type: 'step-finish' },
      { type: 'step-start' },
    ], { completed: false })];
    const result = await execute(toolsFor(clientFor(source)), 'hive_task_trace', { task_id: 'child' });

    expect(result.timeline.map((step: any) => step.state)).toEqual(['closed', 'malformed', 'closed', 'malformed', 'open']);
    expect(result.timeline.map((step: any) => step.text?.length ?? 0)).toEqual([1, 1, 0, 0, 0]);
  });

  it('derives only structured errors, patch files, tool status, open tools, and honest reasoning totals', async () => {
    const source = [
      message('user', 'user', [{ type: 'text', text: 'Run it.' }]),
      message('m1', 'assistant', [
        { type: 'reasoning', text: 'secret', tokens: 4 },
        { type: 'reasoning', metadata: { providerItemId: 'opaque', encrypted: 'ciphertext' } },
        { type: 'tool', tool: 'bash', state: { status: 'running', input: { command: 'sleep' }, output: 'incidental error text' } },
        { type: 'tool', tool: 'read', state: { status: 'error', error: { message: 'tool failed' } } },
        { type: 'retry', error: 'retry failed' },
        { type: 'patch', files: ['a.ts'], patch: 'not a source of files b.ts' },
        { type: 'unknown', error: 'not structured' },
      ], { completed: false, error: { message: 'assistant failed' } }),
    ];
    const setup = clientFor(source, { status: { child: { type: 'busy' } } });
    const result = await execute(toolsFor(setup), 'hive_task_trace', { task_id: 'child', recovery: false });
    const serialized = JSON.stringify(result);

    expect(result.reasoning).toEqual({
      availability: 'mixed', parts: 2, plaintext_parts: 1, plaintext_bytes: 6, opaque_parts: 1,
      tokens: null, known_tokens: 4, unknown_token_parts: 1,
    });
    expect(result.timeline[1].reasoning).toEqual({ presence: 'mixed', parts: 2, tokens: null });
    expect(result.timeline[1].unknown_parts).toBe(1);
    expect(result.changed_files).toEqual({ files: ['a.ts'], exhaustive: false });
    expect(result.errors.map((entry: any) => entry.kind)).toEqual(['assistant', 'tool', 'retry']);
    expect(result.open_tools).toEqual([{ step: 2, call: 1, tool: 1, status: 'running' }]);
    expect(result.lifecycle.state).toBe('active');
    expect(result).not.toHaveProperty('recovery');
    expect(serialized).not.toContain('secret');
    expect(serialized).not.toContain('ciphertext');
    expect(serialized).not.toContain('not structured');
    expect(serialized).not.toContain('b.ts');
    expect(setup.calls.filter((call) => call.method === 'create')).toHaveLength(0);
  });

  it('returns semantic recovery unavailable for active and uncertain traces without model sessions', async () => {
    const source = realisticTrace();
    const active = clientFor(source, { status: { child: { type: 'busy' } } });
    const uncertain = clientFor(source, { statusError: new Error('unavailable') });

    for (const [setup, reason] of [[active, 'runtime_active'], [uncertain, 'status_unavailable']] as const) {
      const result = await execute(toolsFor(setup), 'hive_task_trace', { task_id: 'child', recovery: true });
      expect(result).toMatchObject({ ok: true, version: 2, task_id: 'child' });
      expect(result.source).toMatchObject({ steps: 59, fidelity: 'surviving_source', compactions: 0 });
      expect(result.recovery).toEqual({
        status: 'unavailable',
        failures: [{ stage: 'eligibility', reasons: [reason] }],
        model: { requested: { model: 'requested/model', variant: 'high' } },
        cards_source: null,
        phases_source: null,
      });
      expect(result.semantic).toBeNull();
      expect(result).not.toHaveProperty('timeline');
      expect(result).not.toHaveProperty('content_dictionary');
      expect(setup.calls.filter((call) => call.method === 'create')).toHaveLength(0);
      expect(setup.calls.filter((call) => call.method === 'messages')).toHaveLength(1);
      expect(setup.calls.filter((call) => call.method === 'status')).toHaveLength(1);
    }
  });

  it('externalizes realistic large values toward the soft target without losing steps', async () => {
    const source = Array.from({ length: 59 }, (_, index) => message(`m${index}`, index === 0 ? 'user' : 'assistant', [
      { type: 'step-start' },
      { type: 'text', text: `${index}:${'x'.repeat(700)}` },
      { type: 'tool', tool: 'bash', state: { status: 'completed', input: { command: 'x'.repeat(500) }, output: 'y'.repeat(500) } },
      { type: 'step-finish' },
    ]));
    const serialized = await executeRaw(toolsFor(clientFor(source)), 'hive_task_trace', { task_id: 'child' });
    const result = JSON.parse(serialized);

    expect(result.timeline).toHaveLength(59);
    expect(Buffer.byteLength(JSON.stringify(source))).toBeGreaterThan(90 * 1024);
    expect(Buffer.byteLength(serialized)).toBeLessThanOrEqual(24_576);
    expect(result.render.actual_bytes).toBeLessThanOrEqual(result.render.soft_target_bytes);
    expect(result.render.externalized_count).toBeGreaterThan(100);
  });

  it('externalizes instruction and latest text only at their timeline positions', async () => {
    const source = [
      message('instruction', 'user', [{ type: 'text', text: `instruction:${'i'.repeat(600)}` }]),
      message('final', 'assistant', [{ type: 'text', text: `final:${'f'.repeat(600)}` }]),
    ];
    const result = await execute(toolsFor(clientFor(source)), 'hive_task_trace', { task_id: 'child' });

    expect(result.instruction).toEqual({ step: 1, text: 1 });
    expect(result.latest.final).toEqual({ step: 2, text: 1 });
    expect(result.timeline.map((step: any) => step.text)).toEqual([[{ r: 1 }], [{ r: 2 }]]);
    expect(result.content_dictionary).toHaveLength(2);
    expect(result.render.externalized_count).toBe(2);
  });

  it('keeps render bytes exact at the soft target and actual-byte digit transitions', async () => {
    const renderNear = async (target: number) => {
      const probeID = 'x';
      const probe = await executeRaw(
        toolsFor(clientFor([], { childID: probeID })),
        'hive_task_trace',
        { task_id: probeID },
      );
      const estimatedLength = Math.max(1, target - Buffer.byteLength(probe) + probeID.length);
      const samples: Array<{ bytes: number; result: any }> = [];
      for (let length = Math.max(1, estimatedLength - 24); length <= estimatedLength + 24; length += 1) {
        const taskID = 'x'.repeat(length);
        const serialized = await executeRaw(
          toolsFor(clientFor([], { childID: taskID })),
          'hive_task_trace',
          { task_id: taskID },
        );
        samples.push({ bytes: Buffer.byteLength(serialized), result: JSON.parse(serialized) });
      }
      return samples;
    };

    const softTargetSamples = await renderNear(24_576);
    const exactSoftTarget = softTargetSamples.find(({ bytes }) => bytes === 24_576);
    expect(exactSoftTarget).toBeDefined();
    for (const { bytes, result } of softTargetSamples) {
      expect(result.render).toEqual({
        actual_bytes: bytes,
        soft_target_bytes: 24_576,
        externalized_count: 0,
      });
    }

    const digitTransitionSamples = await renderNear(10_000);
    expect(digitTransitionSamples.some(({ bytes }) => bytes < 10_000)).toBe(true);
    expect(digitTransitionSamples.some(({ bytes }) => bytes >= 10_000)).toBe(true);
    for (const { bytes, result } of digitTransitionSamples) {
      expect(result.render.actual_bytes).toBe(bytes);
    }
  });

  it('returns pathological reports complete and ok when mandatory structure exceeds the target', async () => {
    const source = Array.from({ length: 900 }, (_, index) => message(`m${index}`, 'assistant', [
      { type: 'step-start' }, { type: `unknown-${index}` }, { type: 'step-finish' },
    ]));
    const serialized = await executeRaw(toolsFor(clientFor(source)), 'hive_task_trace', { task_id: 'child' });
    const result = JSON.parse(serialized);

    expect(result.ok).toBe(true);
    expect(result.timeline).toHaveLength(900);
    expect(result.render.actual_bytes).toBeGreaterThan(result.render.soft_target_bytes);
    expect(result.render.actual_bytes).toBe(Buffer.byteLength(serialized));
  });

  it('does not externalize short values when their locator dictionary makes the report larger', async () => {
    const source = Array.from({ length: 900 }, (_, index) => message(`m${index}`, 'assistant', [
      { type: 'text', text: `${index}:${'x'.repeat(80)}` },
    ]));
    const serialized = await executeRaw(toolsFor(clientFor(source)), 'hive_task_trace', { task_id: 'child' });
    const result = JSON.parse(serialized);

    expect(result.render.actual_bytes).toBeGreaterThan(result.render.soft_target_bytes);
    expect(result.render.externalized_count).toBe(0);
    expect(result.content_dictionary).toEqual([]);
    expect(result.timeline).toHaveLength(900);
  });

  it('externalizes remaining candidates when final render metadata alone exceeds the soft target', async () => {
    const candidate = 'c'.repeat(487);
    const source = [message('u', 'user', [{ type: 'text', text: 'go' }]), message('a0', 'assistant', [{ type: 'text', text: candidate }])];
    for (let index = 0; index < 344; index += 1) {
      source.push(message(`p${index}`, 'assistant', [
        { type: 'step-start' },
        { type: `unk${index}` },
        { type: 'step-finish' },
      ]));
    }
    const serialized = await executeRaw(toolsFor(clientFor(source)), 'hive_task_trace', { task_id: 'child' });
    const result = JSON.parse(serialized);

    expect(serialized.includes(candidate)).toBe(false);
    expect(result.render.externalized_count).toBeGreaterThanOrEqual(1);
    expect(result.content_dictionary).toHaveLength(result.render.externalized_count);
    expect(Buffer.byteLength(serialized)).toBeLessThanOrEqual(24_576);
    expect(result.render.actual_bytes).toBeLessThanOrEqual(result.render.soft_target_bytes);
    expect(result.render.actual_bytes).toBe(Buffer.byteLength(serialized));
    expect(result.timeline).toHaveLength(346);
  });

  it('maps all 59 source steps into meaningful coverage-gated phases and returns only the semantic projection', async () => {
    const source = realisticTrace();
    const forensic = await executeRaw(toolsFor(clientFor(source)), 'hive_task_trace', { task_id: 'child', recovery: false });
    const setup = clientFor(source);
    const serialized = await executeRaw(toolsFor(setup), 'hive_task_trace', { task_id: 'child', recovery: true });
    const result = JSON.parse(serialized);
    const requests = setup.calls.filter((call) => call.method === 'prompt').map((call) => JSON.parse(call.input.body.parts[0].text));
    const mapRequests = requests.filter((request) => request.kind === 'map');
    const reduceRequests = requests.filter((request) => request.kind === 'reduce');
    const mapped = new Set(mapRequests.flatMap((request) => request.fragments.map((fragment: any) => fragment.step)));
    const ranges = result.semantic.phases.map((phase: any) => phase.range);

    expect(mapped).toEqual(new Set(sourceSteps(1, 59)));
    expect(reduceRequests).toHaveLength(1);
    expect(reduceRequests[0].cards.map((card: any) => card.step)).toEqual(sourceSteps(1, 59));
    expect(reduceRequests[0].cards.every((card: any) => card.provenance === 'summarizer_interpretation' && card.untrusted === true)).toBe(true);
    expect(result.source).toEqual({ steps: 59, fidelity: 'surviving_source', compactions: 0, as_of: expect.any(String) });
    expect(result.task_instruction).toEqual({ step: 1, text: 'Implement every requested invariant.' });
    expect(result.final_response).toEqual({
      step: 59,
      text: 'All requested work succeeded.',
      provenance: 'child_self_report',
      untrusted: true,
    });
    expect(result.recovery).toMatchObject({
      status: 'complete',
      failures: [],
      cards_source: 'generated',
      phases_source: 'generated',
      model: {
        requested: { model: 'requested/model', variant: 'high' },
        observed: { model: 'observed-provider/observed-model', variant: 'observed-variant' },
      },
    });
    expect(result.semantic).toMatchObject({
      provenance: 'summarizer_interpretation',
      untrusted: true,
      overview: expect.stringContaining('investigated'),
      safest_next_action: { action: 'inspect', context: null, source_steps: sourceSteps(1, 59) },
    });
    expect(ranges.length).toBeGreaterThanOrEqual(6);
    expect(ranges.length).toBeLessThanOrEqual(12);
    expect(ranges[0][0]).toBe(1);
    expect(ranges.at(-1)[1]).toBe(59);
    expect(ranges.flatMap(([start, end]: [number, number]) => sourceSteps(start, end))).toEqual(sourceSteps(1, 59));
    expect(result.semantic.phases.find((phase: any) => phase.range[0] <= 30 && phase.range[1] >= 30).error_steps).toEqual([30]);
    expect(result.errors).toEqual([{ kind: 'retry', step: 30, error: { name: 'ProviderError', message: 'middle retry' } }]);
    expect(result.changed_files).toEqual({ files: ['src/final.ts', 'src/shared.ts'], exhaustive: false });
    expect(Buffer.byteLength(serialized)).toBe(result.render.actual_bytes);
    expect(result.render).toEqual({ actual_bytes: Buffer.byteLength(serialized), soft_target_bytes: 24_576 });
    expect(Buffer.byteLength(serialized)).toBeLessThan(Buffer.byteLength(forensic));
    for (const excluded of ['timeline', 'content_dictionary', 'tool_dictionary', 'tool_rollup', 'open_tools', 'cards']) {
      expect(result).not.toHaveProperty(excluded);
    }
    expect(serialized).not.toContain('private reasoning');
    expect(serialized).not.toContain('output 29');
  });

  it('retains failed-work errors, patch files, blocker self-report, and unfinished claims while forcing inspection', async () => {
    const source = [
      message('instruction', 'user', [{ type: 'text', text: 'Investigate, patch, and verify the failing command.' }]),
      message('investigation', 'assistant', [
        { type: 'step-start' },
        { type: 'reasoning', text: 'private diagnosis' },
        { type: 'text', text: 'The failure originates in trace recovery.' },
        { type: 'tool', tool: 'read', state: { status: 'completed', input: { filePath: 'src/a.ts' }, output: 'source payload' } },
        { type: 'step-finish' },
      ]),
      message('patch', 'assistant', [
        { type: 'step-start' },
        { type: 'text', text: 'Applied the focused patch.' },
        { type: 'patch', files: ['src/a.ts'] },
        { type: 'step-finish' },
      ]),
      message('failed-test', 'assistant', [
        { type: 'step-start' },
        { type: 'tool', tool: 'bash', state: { status: 'error', input: { command: 'bun test' }, error: { message: 'one test failed' } } },
        { type: 'retry', error: { message: 'retry also failed' } },
        { type: 'step-finish' },
      ]),
      message('blocker', 'assistant', [{ type: 'text', text: 'Blocked because the upstream fixture is unavailable.' }]),
    ];
    const setup = clientFor(source, {
      prompt: (request) => request.kind === 'reduce'
        ? {
            kind: 'reduce',
            semantic: semanticReduction(5, {
              completed: [{ claim: 'Investigated and patched the failure.', source_steps: [2, 3] }],
              unfinished: [{ claim: 'The failing verification remains unresolved.', source_steps: [4, 5] }],
              safest_next_action: {
                action: 'launch_fresh_task',
                context: 'Inspect src/a.ts and rerun bun test; the prior run failed because the upstream fixture was unavailable.',
                source_steps: [4, 5],
              },
            }),
          }
        : undefined,
    });
    const result = await execute(toolsFor(setup), 'hive_task_trace', { task_id: 'child', recovery: true });

    expect(result.final_response).toEqual({
      step: 5,
      text: 'Blocked because the upstream fixture is unavailable.',
      provenance: 'child_self_report',
      untrusted: true,
    });
    expect(result.errors.map((entry: any) => [entry.kind, entry.step, entry.error.message])).toEqual([
      ['tool', 4, 'one test failed'],
      ['retry', 4, 'retry also failed'],
    ]);
    expect(result.changed_files).toEqual({ files: ['src/a.ts'], exhaustive: false });
    expect(result.semantic.unfinished).toEqual([{ claim: 'The failing verification remains unresolved.', source_steps: [4, 5] }]);
    expect(result.semantic.safest_next_action).toEqual({ action: 'inspect', context: null, source_steps: sourceSteps(1, 5) });
    expect(result.semantic.phases.find((phase: any) => phase.range[0] <= 4 && phase.range[1] >= 4).error_steps).toEqual([4]);
    expect(JSON.stringify(result)).not.toContain('source payload');
    expect(JSON.stringify(result)).not.toContain('private diagnosis');
  });

  it('returns null when the terminal assistant step has no self-report text', async () => {
    const source = [message('terminal', 'assistant', [
      { type: 'step-start' },
      { type: 'reasoning', text: 'private terminal reasoning' },
      { type: 'tool', tool: 'bash', state: { status: 'completed', input: { command: 'bun test' } } },
      { type: 'patch', files: ['src/a.ts'] },
      { type: 'step-finish' },
    ])];
    const result = await execute(toolsFor(clientFor(source)), 'hive_task_trace', { task_id: 'child', recovery: true });

    expect(result.final_response).toBeNull();
    expect(result.changed_files).toEqual({ files: ['src/a.ts'], exhaustive: false });
  });

  it('uses the configured model context to collapse formerly fragmented map input', async () => {
    const observed = `${'\\"\n'.repeat(12_000)}🙂observed-tail`;
    const reasoning = `${'"\n\\'.repeat(12_000)}🙂reasoning-tail`;
    const source = [message('m1', 'assistant', [
      { type: 'step-start' },
      { type: 'reasoning', text: reasoning },
      { type: 'text', text: observed },
      { type: 'step-finish' },
    ])];
    const setup = clientFor(source, {
      providers: () => ({
        data: {
          providers: [{ id: 'requested', models: { model: { limit: { context: 500_000, output: 16_000 } } } }],
        },
      }),
    });
    const result = await execute(toolsFor(setup), 'hive_task_trace', { task_id: 'child', recovery: true });
    const requests = setup.calls.filter((call) => call.method === 'prompt').map((call) => JSON.parse(call.input.body.parts[0].text));
    const maps = requests.filter((request) => request.kind === 'map');

    expect(maps).toHaveLength(1);
    expect(maps.every((request) => Buffer.byteLength(JSON.stringify(request), 'utf8') <= 700_000)).toBe(true);
    expect(result.recovery.status).toBe('complete');
  });

  it('uses the smaller model input limit and merges split-step fragments in order', async () => {
    const observed = `${'\\"\n'.repeat(12_000)}🙂observed-tail`;
    const reasoning = `${'"\n\\'.repeat(12_000)}🙂reasoning-tail`;
    const source = [message('m1', 'assistant', [
      { type: 'step-start' },
      { type: 'reasoning', text: reasoning },
      { type: 'text', text: observed },
      { type: 'step-finish' },
    ])];
    const setup = clientFor(source, {
      providers: () => ({
        data: {
          providers: [{ id: 'requested', models: { model: { limit: { context: 500_000, input: 20_000, output: 16_000 } } } }],
        },
      }),
      prompt: (request) => request.kind === 'map'
        ? semanticMap(request, {
            1: {
              actions: request.fragments.map((fragment: any) => `fragment ${fragment.fragment}`),
              findings: [],
              intent: null,
              outcome: null,
            },
          })
        : undefined,
    });
    const result = await execute(toolsFor(setup), 'hive_task_trace', { task_id: 'child', recovery: true });
    const requests = setup.calls.filter((call) => call.method === 'prompt').map((call) => JSON.parse(call.input.body.parts[0].text));
    const maps = requests.filter((request) => request.kind === 'map');
    const fragments = maps.flatMap((request) => request.fragments);
    const reducer = requests.find((request) => request.kind === 'reduce');

    expect(maps.length).toBeGreaterThan(1);
    expect(maps.every((request) => Buffer.byteLength(JSON.stringify(request), 'utf8') <= 28_000)).toBe(true);
    expect(fragments.map((fragment: any) => fragment.fragment)).toEqual(sourceSteps(1, fragments.length));
    expect(fragments.every((fragment: any) => fragment.fragments === fragments.length)).toBe(true);
    expect(JSON.parse(fragments.map((fragment: any) => fragment.source.observed ?? '').join('')).text).toEqual([observed]);
    expect(fragments.map((fragment: any) => fragment.source.reasoning ?? '').join('')).toBe(reasoning);
    expect(reducer.cards).toHaveLength(1);
    expect(reducer.cards[0].actions).toEqual(fragments.map((fragment: any) => `fragment ${fragment.fragment}`));
    expect(result.recovery.status).toBe('complete');
  });

  it('uses the fallback map envelope when provider metadata lookup fails', async () => {
    const source = [message('m1', 'assistant', [{ type: 'text', text: 'x'.repeat(300_000) }])];
    const setup = clientFor(source, {
      providers: () => { throw new Error('metadata unavailable'); },
    });
    const result = await execute(toolsFor(setup), 'hive_task_trace', { task_id: 'child', recovery: true });
    const maps = setup.calls.filter((call) => call.method === 'prompt')
      .map((call) => JSON.parse(call.input.body.parts[0].text))
      .filter((request) => request.kind === 'map');

    expect(maps.length).toBeGreaterThan(1);
    expect(maps.every((request) => Buffer.byteLength(JSON.stringify(request), 'utf8') <= 256 * 1024)).toBe(true);
    expect(result.recovery.status).toBe('complete');
    expect(result.recovery.failures).toEqual([]);
  });

  it('falls back the whole split step after one fragment failure and skips the reducer when no generated card survives', async () => {
    const value = `start-${'🙂'.repeat(20_000)}-end`;
    const setup = clientFor([message('m1', 'assistant', [{ type: 'text', text: value }])], {
      promptError: (request, call) => request.kind === 'map' && call === 2 ? 'provider failed' : undefined,
    });
    const result = await execute(toolsFor(setup), 'hive_task_trace', { task_id: 'child', recovery: true });
    const requests = setup.calls.filter((call) => call.method === 'prompt').map((call) => JSON.parse(call.input.body.parts[0].text));
    const maps = requests.filter((request) => request.kind === 'map');

    expect(maps.length).toBeGreaterThan(1);
    expect(maps.every((request) => Buffer.byteLength(JSON.stringify(request), 'utf8') <= 20_480)).toBe(true);
    expect(requests.filter((request) => request.kind === 'reduce')).toHaveLength(0);
    expect(result.recovery).toMatchObject({ status: 'partial', cards_source: 'fallback', phases_source: 'fallback' });
    expect(result.recovery.failures).toContainEqual({ stage: 'map', range: [1, 1], reasons: ['summarizer_unavailable'] });
    expect(result.recovery.failures).toContainEqual({ stage: 'reduce', reasons: ['no_successful_map_ranges'] });
    expect(result.semantic.phases).toHaveLength(1);
    expect(result.semantic.phases[0]).toMatchObject({ range: [1, 1], source_steps: [1], basis: 'observed' });
    expect(result.semantic.safest_next_action).toEqual({ action: 'inspect', context: null, source_steps: [1] });
  });

  it('falls back only substantive steps whose mapper card is entirely empty', async () => {
    const source = [
      message('m1', 'assistant', [{ type: 'text', text: 'Observed source result one.' }]),
      message('m2', 'assistant', [{ type: 'text', text: 'Observed source result two.' }]),
    ];
    const setup = clientFor(source, {
      prompt: (request) => request.kind === 'map'
        ? semanticMap(request, { 1: { intent: null, actions: [], findings: [], outcome: null, unresolved: [] } })
        : undefined,
    });
    const result = await execute(toolsFor(setup), 'hive_task_trace', { task_id: 'child', recovery: true });
    const reducer = setup.calls.filter((call) => call.method === 'prompt')
      .map((call) => JSON.parse(call.input.body.parts[0].text))
      .find((request) => request.kind === 'reduce');

    expect(result.recovery).toMatchObject({ status: 'partial', cards_source: 'mixed', phases_source: 'generated' });
    expect(result.recovery.failures).toContainEqual({ stage: 'map', range: [1, 2], reasons: ['invalid_map_output'] });
    expect(reducer.cards.map((card: any) => card.source)).toEqual(['fallback', 'generated']);
    expect(reducer.cards[0].findings).toEqual(['Observed source result one.']);
    expect(result.semantic.safest_next_action).toEqual({ action: 'inspect', context: null, source_steps: [1, 2] });
  });

  it('accepts only mapper bases supported by each step source capability', async () => {
    const cases = [
      {
        name: 'observed from both channels',
        parts: [{ type: 'reasoning', text: 'private reasoning' }, { type: 'text', text: 'visible evidence' }],
        basis: 'observed',
        cardsSource: 'generated',
      },
      {
        name: 'reasoning from both channels',
        parts: [{ type: 'reasoning', text: 'private reasoning' }, { type: 'text', text: 'visible evidence' }],
        basis: 'reasoning',
        cardsSource: 'generated',
      },
      {
        name: 'mixed from both channels',
        parts: [{ type: 'reasoning', text: 'private reasoning' }, { type: 'text', text: 'visible evidence' }],
        basis: 'mixed',
        cardsSource: 'generated',
      },
      {
        name: 'observed from observed-only source',
        parts: [{ type: 'text', text: 'visible evidence' }],
        basis: 'observed',
        cardsSource: 'generated',
      },
      {
        name: 'observed from observed plus opaque source',
        parts: [{ type: 'reasoning', metadata: { encrypted: 'opaque' } }, { type: 'text', text: 'visible evidence' }],
        basis: 'observed',
        cardsSource: 'generated',
      },
      {
        name: 'observed from tool name and status only',
        parts: [{ type: 'tool', tool: 'read', state: { status: 'completed' } }],
        basis: 'observed',
        cardsSource: 'generated',
      },
      {
        name: 'mixed from observed-only source',
        parts: [{ type: 'text', text: 'visible evidence' }],
        basis: 'mixed',
        cardsSource: 'fallback',
      },
      {
        name: 'mixed from observed plus opaque source',
        parts: [{ type: 'reasoning', metadata: { encrypted: 'opaque' } }, { type: 'text', text: 'visible evidence' }],
        basis: 'mixed',
        cardsSource: 'fallback',
      },
      {
        name: 'reasoning from reasoning-only source',
        parts: [{ type: 'reasoning', text: 'private reasoning' }],
        basis: 'reasoning',
        cardsSource: 'generated',
      },
      {
        name: 'observed from reasoning-only source',
        parts: [{ type: 'reasoning', text: 'private reasoning' }],
        basis: 'observed',
        cardsSource: 'fallback',
      },
      {
        name: 'observed from opaque-only source',
        parts: [{ type: 'reasoning', metadata: { encrypted: 'opaque' } }],
        basis: 'observed',
        cardsSource: 'fallback',
      },
    ] as const;

    for (const variant of cases) {
      const setup = clientFor([message(variant.name, 'assistant', [...variant.parts])], {
        prompt: (request) => request.kind === 'map'
          ? semanticMap(request, { 1: { basis: variant.basis } })
          : undefined,
      });
      const result = await execute(toolsFor(setup), 'hive_task_trace', { task_id: 'child', recovery: true });

      expect(result.recovery.cards_source, variant.name).toBe(variant.cardsSource);
      expect(result.recovery.status, variant.name).toBe(variant.cardsSource === 'generated' ? 'complete' : 'partial');
      expect(result.semantic.safest_next_action.action, variant.name).toBe(variant.cardsSource === 'generated' ? 'review_completed_work' : 'inspect');
    }
  });

  it('rejects an empty generated card for tool-name-and-status-only observed evidence', async () => {
    const setup = clientFor([message('tool-only', 'assistant', [
      { type: 'tool', tool: 'read', state: { status: 'completed' } },
    ])], {
      prompt: (request) => request.kind === 'map'
        ? semanticMap(request, { 1: { intent: null, actions: [], findings: [], outcome: null, unresolved: [] } })
        : undefined,
    });
    const result = await execute(toolsFor(setup), 'hive_task_trace', { task_id: 'child', recovery: true });

    expect(result.recovery).toMatchObject({ status: 'partial', cards_source: 'fallback' });
    expect(result.recovery.failures).toContainEqual({ stage: 'map', range: [1, 1], reasons: ['invalid_map_output'] });
    expect(result.semantic.phases[0].actions).toEqual(['read [completed] x1']);
  });

  it('keeps failed-map fallback compact and externalizes long instruction and assistant text at top level', async () => {
    const instructionTail = 'PRIVATE_INSTRUCTION_RAW_TAIL';
    const assistantTail = 'PRIVATE_ASSISTANT_RAW_TAIL';
    const instruction = `instruction:${'i'.repeat(4_000)}:${instructionTail}`;
    const assistant = `assistant:${'🙂'.repeat(8_000)}:${assistantTail}`;
    const setup = clientFor([
      message('instruction', 'user', [{ type: 'text', text: instruction }]),
      message('terminal', 'assistant', [{ type: 'text', text: assistant }]),
    ], {
      promptError: (request) => request.kind === 'map' ? 'provider failed' : undefined,
    });
    const serialized = await executeRaw(toolsFor(setup), 'hive_task_trace', { task_id: 'child', recovery: true });
    const result = JSON.parse(serialized);

    expect(Buffer.byteLength(serialized)).toBeLessThan(10_000);
    expect(serialized).not.toContain(instructionTail);
    expect(serialized).not.toContain(assistantTail);
    expect(serialized).not.toContain('�');
    expect(result.task_instruction.text).toMatchObject({ content_id: expect.any(String), bytes: Buffer.byteLength(instruction), sha256: expect.any(String) });
    expect(result.final_response.text).toMatchObject({ content_id: expect.any(String), bytes: Buffer.byteLength(assistant), sha256: expect.any(String) });
    expect(JSON.stringify(result.semantic)).toContain('truncated');
    expect(JSON.stringify(result.semantic)).toContain('recovery:false');
    expect(result).not.toHaveProperty('content_dictionary');
  });

  it('bounds fallback card aggregates and reports tool status counts without publishing private source fields', async () => {
    const reasoningTail = 'PRIVATE_REASONING_RAW_TAIL';
    const inputTail = 'PRIVATE_TOOL_INPUT_RAW_TAIL';
    const outputTail = 'PRIVATE_TOOL_OUTPUT_RAW_TAIL';
    const parts: Array<Record<string, unknown>> = [
      { type: 'step-start' },
      { type: 'reasoning', text: `reasoning:${'r'.repeat(2_000)}:${reasoningTail}` },
      ...Array.from({ length: 200 }, (_, index) => ({ type: 'text', text: `item-${index}:${'x'.repeat(100)}` })),
      { type: 'tool', tool: 'read', state: { status: 'completed', input: `input:${'i'.repeat(2_000)}:${inputTail}`, output: `output:${'o'.repeat(2_000)}:${outputTail}` } },
      { type: 'tool', tool: 'read', state: { status: 'completed', input: { filePath: 'src/a.ts' }, output: 'short output' } },
      { type: 'tool', tool: 'bash', state: { status: 'error', error: { message: 'verification failed' } } },
      { type: 'step-finish' },
    ];
    const setup = clientFor([message('m1', 'assistant', parts)], {
      promptError: (request) => request.kind === 'map' ? 'provider failed' : undefined,
    });
    const serialized = await executeRaw(toolsFor(setup), 'hive_task_trace', { task_id: 'child', recovery: true });
    const result = JSON.parse(serialized);
    const phase = result.semantic.phases[0];

    expect(Buffer.byteLength(serialized)).toBeLessThan(10_000);
    expect(phase.actions).toEqual(['read [completed] x2', 'bash [error] x1']);
    expect(JSON.stringify(phase.findings)).toContain('reasoning present');
    expect(JSON.stringify(phase.findings)).toContain('additional source items omitted');
    expect(JSON.stringify(phase.unresolved)).toContain('tool error present');
    expect(serialized).not.toContain(reasoningTail);
    expect(serialized).not.toContain(inputTail);
    expect(serialized).not.toContain(outputTail);
  });

  it('bounds failed-map error fallback in reducer requests and does not promote earlier progress to final response', async () => {
    const errorTail = 'PRIVATE_ERROR_RAW_TAIL';
    const error = { name: 'ProviderError', message: `failure:${'e'.repeat(30_000)}:${errorTail}` };
    const source = [
      message('progress', 'assistant', [{ type: 'text', text: 'Earlier progress update.' }]),
      message('terminal-error', 'assistant', [], { error }),
    ];
    const setup = clientFor(source, {
      prompt: (request) => request.kind === 'map'
        ? semanticMap(request, { 2: { intent: null, actions: [], findings: [], outcome: null, unresolved: [] } })
        : undefined,
    });
    const forensic = await execute(toolsFor(clientFor(source)), 'hive_task_trace', { task_id: 'child', recovery: false });
    const serialized = await executeRaw(toolsFor(setup), 'hive_task_trace', { task_id: 'child', recovery: true });
    const result = JSON.parse(serialized);
    const reducer = setup.calls.filter((call) => call.method === 'prompt')
      .map((call) => JSON.parse(call.input.body.parts[0].text))
      .find((request) => request.kind === 'reduce');
    const reducerText = JSON.stringify(reducer);

    expect(forensic.latest.final).toEqual({ step: 1, text: 1 });
    expect(result.final_response).toBeNull();
    expect(result.errors[0].error).toMatchObject({ content_id: expect.any(String), bytes: Buffer.byteLength(JSON.stringify(error)), sha256: expect.any(String) });
    expect(reducer.cards.find((card: any) => card.step === 2).source).toBe('fallback');
    expect(Buffer.byteLength(reducerText)).toBeLessThan(10_000);
    expect(reducerText).not.toContain(errorTail);
    expect(serialized).not.toContain(errorTail);
    expect(result).not.toHaveProperty('content_dictionary');
  });

  it('starts every map batch concurrently and folds reverse completion by batch index', async () => {
    const source = Array.from({ length: 12 }, (_, index) => message(`m${index}`, 'assistant', [
      { type: 'text', text: `${index}:${'x'.repeat(12_000)}` },
    ]));
    const gates: Array<ReturnType<typeof deferred<unknown>>> = [];
    const requests: any[] = [];
    let active = 0;
    let peak = 0;
    const setup = clientFor(source, {
      prompt: async (request) => {
        if (request.kind === 'reduce') return undefined;
        requests.push(request);
        const gate = deferred<unknown>();
        gates.push(gate);
        active += 1;
        peak = Math.max(peak, active);
        const result = await gate.promise;
        active -= 1;
        return result;
      },
    });
    const execution = execute(toolsFor(setup), 'hive_task_trace', { task_id: 'child', recovery: true });

    await settleUntil(() => gates.length === 12);
    expect(active).toBe(12);
    for (const index of sourceSteps(0, gates.length - 1).reverse()) {
      gates[index].resolve({ kind: 'map', range: requests[index].range, cards: [] });
      await Promise.resolve();
    }
    const result = await execution;

    expect(peak).toBe(12);
    expect(result.recovery.failures.filter((entry: any) => entry.stage === 'map')).toEqual(
      requests.map((request) => ({ stage: 'map', range: request.range, reasons: ['invalid_map_output'] })),
    );
    expect(result.recovery.cards_source).toBe('fallback');
  });

  it('propagates caller abort before recovery work, during metadata lookup, and during all active prompts', async () => {
    const source = Array.from({ length: 12 }, (_, index) => message(`m${index}`, 'assistant', [
      { type: 'text', text: `${index}:${'x'.repeat(12_000)}` },
    ]));
    const before = clientFor(source);
    const beforeAbort = new AbortController();
    beforeAbort.abort(new Error('cancel before recovery'));
    await expect(executeRaw(toolsFor(before), 'hive_task_trace', { task_id: 'child', recovery: true }, beforeAbort.signal)).rejects.toThrow('cancel before recovery');
    expect(before.calls).toHaveLength(0);

    let metadataSignal: AbortSignal | undefined;
    const metadata = clientFor(source, {
      providers: (input) => new Promise((_resolve, reject) => {
        metadataSignal = input.signal;
        input.signal.addEventListener('abort', () => reject(input.signal.reason), { once: true });
      }),
    });
    const metadataController = new AbortController();
    const metadataExecution = executeRaw(toolsFor(metadata), 'hive_task_trace', { task_id: 'child', recovery: true }, metadataController.signal);
    await settleUntil(() => metadataSignal !== undefined);
    metadataController.abort(new Error('cancel metadata lookup'));
    await expect(metadataExecution).rejects.toThrow('cancel metadata lookup');
    expect(metadataSignal?.aborted).toBe(true);
    expect(metadata.calls.filter((call) => call.method === 'create')).toHaveLength(0);

    const activeSignals: AbortSignal[] = [];
    const during = clientFor(source, {
      prompt: (_request, call) => new Promise((_resolve, reject) => {
        const promptCall = during.calls.filter((entry) => entry.method === 'prompt')[call - 1];
        const signal = promptCall.input.signal as AbortSignal;
        activeSignals.push(signal);
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
    });
    const controller = new AbortController();
    const execution = executeRaw(toolsFor(during), 'hive_task_trace', { task_id: 'child', recovery: true }, controller.signal);
    await settleUntil(() => activeSignals.length === 12);
    controller.abort(new Error('cancel active recovery'));

    await expect(execution).rejects.toThrow('cancel active recovery');
    expect(activeSignals.every((signal) => signal.aborted)).toBe(true);
    expect(during.calls.filter((call) => call.method === 'create')).toHaveLength(12);
    expect(during.calls.filter((call) => call.method === 'abort')).toHaveLength(12);
    expect(during.calls.filter((call) => call.method === 'delete')).toHaveLength(12);
    for (const call of during.calls.filter((entry) => entry.method === 'abort' || entry.method === 'delete')) {
      expect(call.input.signal).not.toBe(controller.signal);
    }
  });

  it('shares one 120-second create-plus-prompt attempt budget so slow create cannot approach 240 seconds', async () => {
    const timers = interceptTimers();
    const originalNow = Date.now;
    let now = 0;
    Date.now = () => now;
    try {
      const setup = clientFor([message('m1', 'assistant', [{ type: 'text', text: 'completed work' }])], {
        prompt: (request) => request.kind === 'reduce' ? new Promise(() => {}) : undefined,
      });
      let creates = 0;
      const originalCreate = setup.client.session.create.bind(setup.client.session);
      setup.client.session.create = async (input: unknown) => {
        creates += 1;
        const created = await originalCreate(input);
        if (creates === 2) now += 100_000;
        return created;
      };
      const execution = execute(toolsFor(setup), 'hive_task_trace', { task_id: 'child', recovery: true });
      await settleUntil(() => (
        setup.calls.some((call) => call.method === 'prompt' && JSON.parse(call.input.body.parts[0].text).kind === 'reduce')
        && (timers.active(20_000).length === 1 || timers.active(120_000).length === 1)
      ));
      expect(timers.active(20_000)).toHaveLength(1);
      expect(timers.active(120_000)).toHaveLength(0);
      timers.fire(timers.active(20_000)[0]);
      await settleUntil(() => setup.calls.some((call) => call.method === 'abort') || setup.calls.filter((call) => call.method === 'delete').length > 1);
      for (let index = 0; index < 4; index += 1) {
        const cleanup = timers.active(10_000)[0];
        if (!cleanup) break;
        timers.fire(cleanup);
        await Promise.resolve();
      }
      const result = await execution;
      expect(result.recovery.failures).toContainEqual({ stage: 'reduce', reasons: ['summarizer_timeout'] });
      expect(now + 20_000).toBeLessThan(240_000);
    } finally {
      Date.now = originalNow;
      timers.restore();
    }
  });

  it('reserves abort and delete windows so generation timeout still runs both cleanups in order', async () => {
    const timers = interceptTimers();
    const originalNow = Date.now;
    let now = 0;
    Date.now = () => now;
    try {
      const order: string[] = [];
      const setup = clientFor([message('m1', 'assistant', [{ type: 'text', text: 'completed work' }])], {
        prompt: (request) => {
          if (request.kind === 'map') return undefined;
          return new Promise(() => {});
        },
        abort: () => {
          order.push('abort');
          return new Promise(() => {});
        },
        delete: (call) => {
          order.push(`delete-${call}`);
          if (call === 1) {
            now = 200_000;
            return { data: true };
          }
          return new Promise(() => {});
        },
      });
      const execution = execute(toolsFor(setup), 'hive_task_trace', { task_id: 'child', recovery: true });
      await settleUntil(() => {
        const reducePrompt = setup.calls.find((call) => (
          call.method === 'prompt' && JSON.parse(call.input.body.parts[0].text).kind === 'reduce'
        ));
        return Boolean(reducePrompt) && timers.active().some((timer) => timer.delay > 0 && timer.delay <= 100_000);
      });
      const promptTimer = timers.active().find((timer) => timer.delay > 0 && timer.delay <= 100_000)!;
      expect(promptTimer.delay).toBe(80_000);
      now += promptTimer.delay;
      expect(now).toBe(280_000);
      timers.fire(promptTimer);
      await settleUntil(() => setup.calls.some((call) => call.method === 'abort'));
      expect(timers.active(10_000)).toHaveLength(1);
      const abortTimer = timers.active(10_000)[0];
      now += abortTimer.delay;
      expect(now).toBe(290_000);
      timers.fire(abortTimer);
      await settleUntil(() => setup.calls.filter((call) => call.method === 'delete').length >= 2);
      expect(timers.active(10_000)).toHaveLength(1);
      const deleteTimer = timers.active(10_000)[0];
      now += deleteTimer.delay;
      expect(now).toBe(300_000);
      timers.fire(deleteTimer);
      const result = await execution;
      expect(order.filter((entry) => entry === 'abort' || entry.startsWith('delete-'))).toEqual([
        'delete-1',
        'abort',
        'delete-2',
      ]);
      expect(result.recovery.failures).toContainEqual({
        stage: 'reduce',
        reasons: ['recovery_deadline_exceeded', 'ephemeral_cleanup_failed'],
      });
      expect(now).toBeLessThanOrEqual(300_000);
    } finally {
      Date.now = originalNow;
      timers.restore();
    }
  });

  it('keeps a reserved delete window when abort consumes its full cleanup budget', async () => {
    const timers = interceptTimers();
    const originalNow = Date.now;
    let now = 0;
    Date.now = () => now;
    try {
      const cleanupOrder: string[] = [];
      const source = [message('m1', 'assistant', [{ type: 'text', text: 'completed work' }])];
      const setup = clientFor(source, {
        providers: () => {
          now = 100_000;
          return {
            data: {
              providers: [{ id: 'requested', models: { model: { limit: { context: 10_000, output: 1_000 } } } }],
            },
          };
        },
        prompt: (request) => {
          if (request.kind !== 'map') return undefined;
          return new Promise(() => {});
        },
        delete: async () => {
          cleanupOrder.push('delete');
          return new Promise(() => {});
        },
        abort: async () => {
          cleanupOrder.push('abort');
          return new Promise(() => {});
        },
      });
      const execution = execute(toolsFor(setup), 'hive_task_trace', { task_id: 'child', recovery: true });
      await settleUntil(() => timers.active(60_000).length >= 1);
      const promptTimer = timers.active(60_000)[0];
      now += promptTimer.delay;
      expect(now).toBe(160_000);
      timers.fire(promptTimer);
      await settleUntil(() => cleanupOrder.includes('abort') && timers.active(10_000).length === 1);
      const abortTimer = timers.active(10_000)[0];
      expect(abortTimer.delay).toBe(10_000);
      now += abortTimer.delay;
      expect(now).toBe(170_000);
      timers.fire(abortTimer);
      await settleUntil(() => cleanupOrder.includes('delete') && timers.active(10_000).length === 1);
      const deleteTimer = timers.active(10_000)[0];
      expect(deleteTimer.delay).toBe(10_000);
      now += deleteTimer.delay;
      expect(now).toBe(180_000);
      timers.fire(deleteTimer);
      const result = await execution;
      expect(cleanupOrder.filter((entry) => entry === 'abort' || entry === 'delete')).toEqual(['abort', 'delete']);
      expect(result.recovery.failures.some((entry: any) => (
        entry.stage === 'map'
        && entry.reasons.includes('recovery_deadline_exceeded')
        && entry.reasons.includes('ephemeral_cleanup_failed')
      ))).toBe(true);
    } finally {
      Date.now = originalNow;
      timers.restore();
    }
  });

  it('skips session create when stage time cannot reserve abort and delete cleanup', async () => {
    const originalNow = Date.now;
    let now = 0;
    Date.now = () => now;
    try {
      const source = Array.from({ length: 12 }, (_, index) => message(`m${index}`, 'assistant', [
        { type: 'text', text: `${index}:${'x'.repeat(12_000)}` },
      ]));
      const setup = clientFor(source, {
        providers: () => {
          now = 179_001;
          return {
            data: {
              providers: [{ id: 'requested', models: { model: { limit: { context: 10_000, output: 1_000 } } } }],
            },
          };
        },
      });
      const result = await execute(toolsFor(setup), 'hive_task_trace', { task_id: 'child', recovery: true });
      const mapCreates = setup.calls.filter((call) => call.method === 'create' && call.input.body.title.includes(' map '));
      const cutoffFailures = result.recovery.failures.filter((entry: any) => (
        entry.stage === 'map' && entry.reasons.includes('recovery_deadline_exceeded')
      ));
      expect(mapCreates).toHaveLength(0);
      expect(cutoffFailures).toHaveLength(12);
      expect(result.recovery).toMatchObject({ status: 'partial', cards_source: 'fallback', phases_source: 'fallback' });
    } finally {
      Date.now = originalNow;
    }
  });

  it('propagates caller abort after bounded reducer and map cleanup instead of returning fallback', async () => {
    for (const stage of ['reduce', 'map'] as const) {
      const timers = interceptTimers();
      const originalNow = Date.now;
      let now = 0;
      Date.now = () => now;
      try {
        const cleanupStarted = deferred<void>();
        const setup = clientFor([message('m1', 'assistant', [{ type: 'text', text: 'completed work' }])], {
          prompt: (request) => (
            request.kind === stage ? new Promise(() => {}) : undefined
          ),
          abort: async () => {
            cleanupStarted.resolve();
            return new Promise(() => {});
          },
          delete: (call) => {
            if (stage === 'reduce' && call === 1) return { data: true };
            return new Promise(() => {});
          },
        });
        const controller = new AbortController();
        const execution = executeRaw(toolsFor(setup), 'hive_task_trace', { task_id: 'child', recovery: true }, controller.signal);
        await settleUntil(() => (
          setup.calls.some((call) => call.method === 'prompt' && JSON.parse(call.input.body.parts[0].text).kind === stage)
          && timers.active(120_000).length >= 1
        ));
        const promptTimer = timers.active(120_000)[0];
        now += promptTimer.delay;
        timers.fire(promptTimer);
        await cleanupStarted.promise;
        controller.abort(new Error(`cancel during ${stage} cleanup`));
        await settleUntil(() => timers.active(10_000).length >= 1);
        const abortTimer = timers.active(10_000)[0];
        now += abortTimer.delay;
        timers.fire(abortTimer);
        await settleUntil(() => {
          const deletes = setup.calls.filter((call) => call.method === 'delete');
          return (stage === 'map' ? deletes.length >= 1 : deletes.length >= 2) && timers.active(10_000).length >= 1;
        });
        const deleteTimer = timers.active(10_000)[0];
        now += deleteTimer.delay;
        timers.fire(deleteTimer);
        await expect(execution).rejects.toThrow(`cancel during ${stage} cleanup`);
        const methods = setup.calls.map((call) => call.method);
        const abortAt = methods.indexOf('abort');
        const deleteAt = methods.lastIndexOf('delete');
        expect(abortAt).toBeGreaterThan(-1);
        expect(deleteAt).toBeGreaterThan(abortAt);
      } finally {
        Date.now = originalNow;
        timers.restore();
      }
    }
  });

  it('falls back only a timed-out map range while successful maps still reduce', async () => {
    const timers = interceptTimers();
    const originalNow = Date.now;
    let now = 0;
    Date.now = () => now;
    try {
      const source = Array.from({ length: 8 }, (_, index) => message(`m${index}`, 'assistant', [
        { type: 'text', text: `${index}:${'x'.repeat(12_000)}` },
      ]));
      const setup = clientFor(source, {
        prompt: (request, call) => request.kind === 'map' && call === 1 ? new Promise(() => {}) : undefined,
      });
      const execution = execute(toolsFor(setup), 'hive_task_trace', { task_id: 'child', recovery: true });
      await settleUntil(() => setup.calls.some((call) => call.method === 'prompt') && timers.active(120_000).length === 1);
      const promptTimer = timers.active(120_000)[0];
      now += promptTimer.delay;
      timers.fire(promptTimer);
      const result = await execution;
      const mapFailures = result.recovery.failures.filter((entry: any) => entry.stage === 'map');

      expect(mapFailures).toHaveLength(1);
      expect(mapFailures[0].reasons).toEqual(['summarizer_timeout']);
      expect(result.recovery).toMatchObject({ status: 'partial', cards_source: 'mixed', phases_source: 'generated' });
      expect(setup.calls.filter((call) => call.method === 'abort')).toHaveLength(1);
      expect(setup.calls.filter((call) => call.method === 'delete').length).toBeGreaterThanOrEqual(1);
    } finally {
      Date.now = originalNow;
      timers.restore();
    }
  });

  it('starts all maps before the global cutoff and reserves reduction time', async () => {
    const originalNow = Date.now;
    let now = 0;
    Date.now = () => now;
    try {
      const source = Array.from({ length: 12 }, (_, index) => message(`m${index}`, 'assistant', [
        { type: 'text', text: `${index}:${'x'.repeat(12_000)}` },
      ]));
      const setup = clientFor(source, {
        prompt: () => undefined,
        delete: async (call) => {
          if (call === 12) now = 180_001;
          return { data: true };
        },
      });
      const result = await execute(toolsFor(setup), 'hive_task_trace', { task_id: 'child', recovery: true });
      const requests = setup.calls.filter((call) => call.method === 'prompt')
        .map((call) => JSON.parse(call.input.body.parts[0].text));
      const mapRequests = requests.filter((request) => request.kind === 'map');
      const cutoffFailures = result.recovery.failures.filter((entry: any) => (
        entry.stage === 'map' && entry.reasons.includes('recovery_deadline_exceeded')
      ));

      expect(setup.calls.filter((call) => call.method === 'create' && call.input.body.title.includes(' map '))).toHaveLength(12);
      expect(mapRequests).toHaveLength(12);
      expect(requests.some((request) => request.kind === 'reduce')).toBe(true);
      expect(cutoffFailures).toHaveLength(0);
      expect(result.recovery).toMatchObject({ status: 'complete', cards_source: 'generated', phases_source: 'generated' });
    } finally {
      Date.now = originalNow;
    }
  });

  it('keeps generated cards and uses deterministic phases when reduction times out', async () => {
    const timers = interceptTimers();
    const originalNow = Date.now;
    let now = 0;
    Date.now = () => now;
    try {
      const setup = clientFor([message('m1', 'assistant', [{ type: 'text', text: 'completed work' }])], {
        prompt: (request) => request.kind === 'reduce' ? new Promise(() => {}) : undefined,
      });
      const execution = execute(toolsFor(setup), 'hive_task_trace', { task_id: 'child', recovery: true });
      await settleUntil(() => (
        setup.calls.filter((call) => call.method === 'prompt').length === 2
        && timers.active(120_000).length === 1
      ));
      const promptTimer = timers.active(120_000)[0];
      now += promptTimer.delay;
      timers.fire(promptTimer);
      const result = await execution;

      expect(result.recovery).toMatchObject({ status: 'partial', cards_source: 'generated', phases_source: 'fallback' });
      expect(result.recovery.failures).toContainEqual({ stage: 'reduce', reasons: ['summarizer_timeout'] });
      expect(result.semantic.phases).toEqual(expect.arrayContaining([expect.objectContaining({ source_steps: [1] })]));
    } finally {
      Date.now = originalNow;
      timers.restore();
    }
  });

  it('bounds hanging abort and delete cleanup and retains an unconfirmed hidden session id', async () => {
    const timers = interceptTimers();
    const originalNow = Date.now;
    let now = 0;
    Date.now = () => now;
    try {
      const cleanupSignals: AbortSignal[] = [];
      const setup = clientFor([message('m1', 'assistant', [{ type: 'text', text: 'completed work' }])], {
        prompt: (request) => request.kind === 'map' ? new Promise(() => {}) : undefined,
        abort: () => new Promise(() => {}),
        delete: () => new Promise(() => {}),
      });
      const ephemeral = new Set<string>();
      const execution = execute(toolsFor(setup, ephemeral), 'hive_task_trace', { task_id: 'child', recovery: true });
      await settleUntil(() => setup.calls.some((call) => call.method === 'prompt') && timers.active(120_000).length === 1);
      const promptTimer = timers.active(120_000)[0];
      now += promptTimer.delay;
      timers.fire(promptTimer);
      await settleUntil(() => setup.calls.some((call) => call.method === 'abort') && timers.active(10_000).length === 1);
      cleanupSignals.push(setup.calls.find((call) => call.method === 'abort')!.input.signal);
      const abortTimer = timers.active(10_000)[0];
      now += abortTimer.delay;
      timers.fire(abortTimer);
      await settleUntil(() => setup.calls.some((call) => call.method === 'delete') && timers.active(10_000).length === 1);
      cleanupSignals.push(setup.calls.find((call) => call.method === 'delete')!.input.signal);
      const deleteTimer = timers.active(10_000)[0];
      now += deleteTimer.delay;
      timers.fire(deleteTimer);
      const result = await execution;

      expect(result.recovery.failures).toContainEqual({
        stage: 'map',
        range: [1, 1],
        reasons: ['summarizer_timeout', 'ephemeral_cleanup_failed'],
      });
      expect(ephemeral).toEqual(new Set(['summary-1']));
      expect(cleanupSignals[0]).not.toBe(cleanupSignals[1]);
      expect(cleanupSignals.every((signal) => signal.aborted)).toBe(true);
    } finally {
      Date.now = originalNow;
      timers.restore();
    }
  });

  it('falls back affected map steps while retaining ordered provider/schema and cleanup causes', async () => {
    const source = Array.from({ length: 20 }, (_, index) => message(`m${index}`, 'assistant', [
      { type: 'text', text: `${index}:${'x'.repeat(2500)}` },
    ]));
    for (const failure of ['schema', 'provider', 'cleanup', 'schema+cleanup', 'provider+cleanup'] as const) {
      const setup = clientFor(source, {
        prompt: (request, call) => failure.startsWith('schema') && request.kind === 'map' && call === 2
          ? { kind: 'map', range: request.range, cards: [] }
          : undefined,
        promptError: (request, call) => failure.startsWith('provider') && request.kind === 'map' && call === 2 ? 'provider failed' : undefined,
        delete: (_call, input) => failure.includes('cleanup') && input.path.id === 'summary-2'
          ? { error: 'delete failed' }
          : { data: true },
      });
      const ephemeral = new Set<string>();
      const result = await execute(toolsFor(setup, ephemeral), 'hive_task_trace', { task_id: 'child', recovery: true });
      const failed = result.recovery.failures.find((entry: any) => entry.stage === 'map');
      const expectedPrimary = failure.startsWith('schema')
        ? ['invalid_map_output']
        : failure.startsWith('provider') ? ['summarizer_unavailable'] : [];
      const expected = [...expectedPrimary, ...(failure.includes('cleanup') ? ['ephemeral_cleanup_failed'] : [])];
      const reducer = setup.calls.filter((call) => call.method === 'prompt')
        .map((call) => JSON.parse(call.input.body.parts[0].text))
        .find((request) => request.kind === 'reduce');

      expect(failed.reasons).toEqual(expected);
      expect(result.recovery).toMatchObject({ status: 'partial', cards_source: 'mixed', phases_source: 'generated' });
      expect(reducer.cards.map((card: any) => card.step)).toEqual(sourceSteps(1, 20));
      expect(reducer.cards.some((card: any) => card.source === 'generated')).toBe(true);
      expect(reducer.cards.some((card: any) => card.source === 'fallback')).toBe(true);
      expect(result.semantic.safest_next_action).toEqual({ action: 'inspect', context: null, source_steps: sourceSteps(1, 20) });
      if (failure.includes('cleanup')) expect(ephemeral).toEqual(new Set(['summary-2']));
    }
  });

  it('uses balanced fallback phases for reducer provider, schema, cleanup, and concurrent causes', async () => {
    const source = Array.from({ length: 20 }, (_, index) => message(`m${index}`, 'assistant', [{ type: 'text', text: `work ${index}` }]));
    for (const failure of ['schema', 'provider', 'cleanup', 'schema+cleanup', 'provider+cleanup'] as const) {
      const setup = clientFor(source, {
        prompt: (request) => failure.startsWith('schema') && request.kind === 'reduce'
          ? { kind: 'reduce', semantic: { overview: 'missing fields' } }
          : undefined,
        promptError: (request) => failure.startsWith('provider') && request.kind === 'reduce' ? 'provider failed' : undefined,
        delete: (_call, input) => failure.includes('cleanup') && input.path.id === 'summary-2'
          ? { error: 'delete failed' }
          : { data: true },
      });
      const ephemeral = new Set<string>();
      const result = await execute(toolsFor(setup, ephemeral), 'hive_task_trace', { task_id: 'child', recovery: true });
      const failed = result.recovery.failures.find((entry: any) => entry.stage === 'reduce');
      const expectedPrimary = failure.startsWith('schema')
        ? ['invalid_reducer_output']
        : failure.startsWith('provider') ? ['summarizer_unavailable'] : [];
      const expected = [...expectedPrimary, ...(failure.includes('cleanup') ? ['ephemeral_cleanup_failed'] : [])];

      expect(failed.reasons).toEqual(expected);
      expect(result.recovery).toMatchObject({ status: 'partial', cards_source: 'generated', phases_source: 'fallback' });
      expect(result.semantic.phases.length).toBeGreaterThanOrEqual(6);
      expect(result.semantic.phases.length).toBeLessThanOrEqual(12);
      expect(result.semantic.phases.flatMap((phase: any) => sourceSteps(phase.range[0], phase.range[1]))).toEqual(sourceSteps(1, 20));
      expect(result.semantic.safest_next_action).toEqual({ action: 'inspect', context: null, source_steps: sourceSteps(1, 20) });
      if (failure.includes('cleanup')) expect(ephemeral).toEqual(new Set(['summary-2']));
    }
  });

  it('rejects phase gaps, overlap, reverse ranges, invalid source coverage, duplicate source steps, and excess phases', async () => {
    const phase = (start: number, end: number, covered = sourceSteps(start, end)) => ({
      range: [start, end],
      title: `Phase ${start}-${end}`,
      intent: null,
      actions: [],
      findings: [],
      outcome: null,
      unresolved: [],
      source_steps: covered,
    });
    const variants = [
      { stepCount: 4, phases: [phase(1, 1), phase(3, 4)] },
      { stepCount: 4, phases: [phase(1, 2), phase(2, 4)] },
      { stepCount: 4, phases: [phase(1, 1), { ...phase(2, 4), range: [4, 2] }] },
      { stepCount: 4, phases: [phase(1, 4, [1, 2, 5])] },
      { stepCount: 4, phases: [phase(1, 4, [1, 2, 2, 3, 4])] },
      { stepCount: 13, phases: sourceSteps(1, 13).map((step) => phase(step, step)) },
    ];

    for (const variant of variants) {
      const source = Array.from({ length: variant.stepCount }, (_, index) => message(`m${index}`, 'assistant', [{ type: 'text', text: `work ${index}` }]));
      const setup = clientFor(source, {
        prompt: (request) => request.kind === 'reduce'
          ? { kind: 'reduce', semantic: semanticReduction(variant.stepCount, { phases: variant.phases }) }
          : undefined,
      });
      const result = await execute(toolsFor(setup), 'hive_task_trace', { task_id: 'child', recovery: true });

      expect(result.recovery).toMatchObject({ status: 'partial', cards_source: 'generated', phases_source: 'fallback' });
      expect(result.recovery.failures).toContainEqual({ stage: 'reduce', reasons: ['invalid_phase_coverage'] });
      expect(result.semantic.phases.flatMap((entry: any) => sourceSteps(entry.range[0], entry.range[1]))).toEqual(sourceSteps(1, variant.stepCount));
      expect(result.semantic.safest_next_action).toEqual({ action: 'inspect', context: null, source_steps: sourceSteps(1, variant.stepCount) });
    }
  });

  it('accepts split JSON text parts but never publishes summarizer reasoning or captured raw reasoning', async () => {
    const source = [message('m1', 'assistant', [
      { type: 'step-start' },
      { type: 'reasoning', text: 'private chain-of-thought that must not be public' },
      { type: 'text', text: 'completed work' },
      { type: 'step-finish' },
    ])];
    const setup = clientFor(source, {
      prompt: (request) => {
        const body = JSON.stringify(request.kind === 'map'
          ? semanticMap(request)
          : { kind: 'reduce', semantic: semanticReduction(1) });
        const middle = Math.floor(body.length / 2);
        return {
          parts: [
            { type: 'step-start' },
            { type: 'reasoning', text: 'summarizer reasoning must not be public' },
            { type: 'text', text: body.slice(0, middle) },
            { type: 'text', text: body.slice(middle) },
            { type: 'step-finish' },
          ],
        };
      },
    });
    const result = await execute(toolsFor(setup), 'hive_task_trace', { task_id: 'child', recovery: true });
    const serialized = JSON.stringify(result);

    expect(result.recovery.status).toBe('complete');
    expect(serialized).not.toContain('summarizer reasoning');
    expect(serialized).not.toContain('private chain-of-thought');
  });

  it('falls back only opaque-only mapper fabrications without exposing or inventing their contents', async () => {
    const source = [
      message('m1', 'assistant', [{ type: 'reasoning', metadata: { providerItemId: 'opaque-id', encrypted: 'ciphertext' } }]),
      message('m2', 'assistant', [{ type: 'text', text: 'Visible peer step.' }]),
    ];
    const setup = clientFor(source);
    const result = await execute(toolsFor(setup), 'hive_task_trace', { task_id: 'child', recovery: true });
    const mapRequest = setup.calls.filter((call) => call.method === 'prompt')
      .map((call) => JSON.parse(call.input.body.parts[0].text))
      .find((request) => request.kind === 'map');
    const reducer = setup.calls.filter((call) => call.method === 'prompt')
      .map((call) => JSON.parse(call.input.body.parts[0].text))
      .find((request) => request.kind === 'reduce');
    const serialized = JSON.stringify(result);

    expect(mapRequest.fragments[0].source).toMatchObject({ basis: 'observed', opaque_reasoning_parts: 1 });
    expect(mapRequest.fragments[0].source).not.toHaveProperty('reasoning');
    expect(result.recovery).toMatchObject({ status: 'partial', cards_source: 'mixed', phases_source: 'generated' });
    expect(result.recovery.failures).toContainEqual({ stage: 'map', range: [1, 2], reasons: ['invalid_map_output'] });
    expect(reducer.cards.map((card: any) => card.source)).toEqual(['fallback', 'generated']);
    expect(reducer.cards[0]).toMatchObject({ intent: null, actions: [], findings: [], outcome: null, unresolved: [] });
    expect(result.semantic.safest_next_action).toEqual({ action: 'inspect', context: null, source_steps: [1, 2] });
    expect(serialized).not.toContain('opaque-id');
    expect(serialized).not.toContain('ciphertext');
    expect(serialized).not.toContain('opaque reasoning part');
    expect(result).not.toHaveProperty('content_dictionary');
  });

  it('reauthorizes v2 content, detects staleness, and returns UTF-8-safe 8 KiB chunks', async () => {
    const large = `start-${'🙂'.repeat(5000)}-end`;
    const source = [message('m1', 'assistant', [{ type: 'text', text: large }, { type: 'reasoning', text: 'private' }])];
    const setup = clientFor(source, {
      mutateMessages: (reads) => reads <= 3 ? source : [message('m1', 'assistant', [{ type: 'text', text: `${large}changed` }])],
    });
    const tools = toolsFor(setup);
    const trace = await execute(tools, 'hive_task_trace', { task_id: 'child' });
    const contentID = trace.content_dictionary[trace.timeline[0].text[0].r - 1];
    const first = await execute(tools, 'hive_task_trace_content', { task_id: 'child', content_id: contentID });
    const second = await execute(tools, 'hive_task_trace_content', { task_id: 'child', content_id: contentID, offset: first.next_offset });
    const stale = await execute(tools, 'hive_task_trace_content', { task_id: 'child', content_id: contentID });

    expect(first).toMatchObject({ ok: true, version: 2, task_id: 'child', offset: 0, bytes: Buffer.byteLength(large), sha256: expect.any(String) });
    expect(Buffer.byteLength(first.content)).toBeLessThanOrEqual(8192);
    expect(first.content).not.toContain('�');
    expect(second.offset).toBe(first.next_offset);
    expect(second.content).not.toContain('�');
    expect(stale).toEqual({ ok: false, reason: 'stale_or_not_found' });
    expect(setup.calls.filter((call) => call.method === 'messages')).toHaveLength(4);
    expect(setup.calls.filter((call) => call.method === 'get')).toHaveLength(4);

    const decoded = JSON.parse(Buffer.from(contentID, 'base64url').toString('utf8'));
    expect(decoded).toEqual([2, 0, 0, 1, Buffer.byteLength(large), expect.any(String)]);
    const reasoningLocator = Buffer.from(JSON.stringify([2, 0, 1, 7, 7, 'a'.repeat(43)])).toString('base64url');
    expect(await execute(tools, 'hive_task_trace_content', { task_id: 'child', content_id: reasoningLocator })).toEqual({ ok: false, reason: 'invalid_content_id' });
  });

  it('authorizes only direct children and performs no mutation, polling, retry, or resume', async () => {
    const denied = clientFor([], { parentID: 'other' });
    expect(await execute(toolsFor(denied), 'hive_task_trace', { task_id: 'child' })).toEqual({ ok: false, reason: 'unavailable_or_unauthorized' });
    expect(denied.calls.map((call) => call.method)).toEqual(['get']);

    const allowed = clientFor([message('m1', 'assistant', [{ type: 'text', text: 'done' }])]);
    await execute(toolsFor(allowed), 'hive_task_trace', { task_id: 'child' });
    expect(allowed.calls.map((call) => call.method)).toEqual(['get', 'messages', 'status']);
  });
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
  });

  it('keeps the recovery agent name reserved for hidden internal use', () => {
    expect(TASK_TRACE_SUMMARIZER_AGENT).toBe('__hive_task_trace_summarizer');
  });
});
