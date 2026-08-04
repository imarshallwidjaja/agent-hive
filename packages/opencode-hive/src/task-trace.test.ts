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

function synthesis(overrides: Record<string, unknown> = {}) {
  return {
    overview: 'The task was implemented and checked.',
    attempted: ['implement trace v2'],
    completed: ['captured every step'],
    unfinished: [],
    risks: [],
    safest_next_action: 'Review the result.',
    ...overrides,
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
  deleteError?: (call: number) => unknown;
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
        ? {
            kind: 'map',
            range: request.range,
            interpretations: [...new Set(request.fragments.map((fragment: any) => fragment.step))].map((step) => ({
              step,
              summary: `Interpretation for step ${step}`,
              basis: request.fragments.find((fragment: any) => fragment.step === step).source.basis,
            })),
          }
        : { kind: 'reduce', synthesis: synthesis() });
      return {
        data: {
          model: { providerID: 'observed-provider', modelID: 'observed-model' },
          variant: 'observed-variant',
          parts: [{ type: 'text', text: JSON.stringify(response) }],
        },
      };
    },
    delete: async (input: unknown) => {
      calls.push({ method: 'delete', input });
      deleteCalls += 1;
      const error = options.deleteError?.(deleteCalls);
      return error ? { error } : { data: true };
    },
  };
  return { client: { session }, calls };
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
) {
  return tools[name].execute(args as never, {
    sessionID: 'parent',
    messageID: 'parent-message',
    agent: 'hive-master',
    abort: new AbortController().signal,
  } as never);
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
    { type: 'text', text: 'final tail response' },
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
    const result = await execute(toolsFor(setup), 'hive_task_trace', { task_id: 'child', recovery: true });
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
    expect(result.recovery).toEqual({ available: false, reasons: ['runtime_active'] });
    expect(serialized).not.toContain('secret');
    expect(serialized).not.toContain('ciphertext');
    expect(serialized).not.toContain('not structured');
    expect(serialized).not.toContain('b.ts');
    expect(setup.calls.filter((call) => call.method === 'create')).toHaveLength(0);
  });

  it('reports complete active and uncertain traces without model calls', async () => {
    const source = realisticTrace();
    const active = clientFor(source, { status: { child: { type: 'busy' } } });
    const uncertain = clientFor(source, { statusError: new Error('unavailable') });

    for (const [setup, reason] of [[active, 'runtime_active'], [uncertain, 'status_unavailable']] as const) {
      const result = await execute(toolsFor(setup), 'hive_task_trace', { task_id: 'child', recovery: true });
      expect(result.timeline).toHaveLength(59);
      expect(result.recovery).toEqual({ available: false, reasons: [reason] });
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

  it('maps every terminal step including the middle, then performs one synthesis', async () => {
    const source = realisticTrace();
    const setup = clientFor(source);
    const result = await execute(toolsFor(setup), 'hive_task_trace', { task_id: 'child', recovery: true });
    const mapRequests = setup.calls.filter((call) => call.method === 'prompt')
      .map((call) => JSON.parse(call.input.body.parts[0].text))
      .filter((request) => request.kind === 'map');
    const reduceRequests = setup.calls.filter((call) => call.method === 'prompt')
      .map((call) => JSON.parse(call.input.body.parts[0].text))
      .filter((request) => request.kind === 'reduce');
    const mapped = new Set(mapRequests.flatMap((request) => request.fragments.map((fragment: any) => fragment.step)));

    expect(mapped).toEqual(new Set(Array.from({ length: 59 }, (_, index) => index + 1)));
    expect(mapped.has(30)).toBe(true);
    expect(reduceRequests).toHaveLength(1);
    expect(reduceRequests[0].interpretations).toHaveLength(59);
    expect(result.timeline.every((step: any) => step.interpretation?.untrusted === true)).toBe(true);
    expect(result.timeline.every((step: any) => step.interpretation?.provenance === 'summarizer_interpretation')).toBe(true);
    expect(result.recovery).toMatchObject({
      available: true,
      failed_ranges: [],
      synthesis: synthesis(),
      model: {
        requested: { model: 'requested/model', variant: 'high' },
        observed: { model: 'observed-provider/observed-model', variant: 'observed-variant' },
      },
    });
  });

  it('uses adaptive target as guidance and accepts valid longer summaries', async () => {
    const source = Array.from({ length: 100 }, (_, index) => message(`m${index}`, 'assistant', [{ type: 'text', text: `step ${index}` }]));
    const setup = clientFor(source, {
      prompt: (request) => request.kind === 'map'
        ? {
            kind: 'map', range: request.range,
            interpretations: [...new Set(request.fragments.map((fragment: any) => fragment.step))].map((step) => ({
              step, summary: 's'.repeat(400), basis: 'observed',
            })),
          }
        : { kind: 'reduce', synthesis: synthesis() },
    });
    const result = await execute(toolsFor(setup), 'hive_task_trace', { task_id: 'child', recovery: true });
    const map = setup.calls.find((call) => call.method === 'prompt')!;
    const request = JSON.parse(map.input.body.parts[0].text);

    expect(request.target_chars).toBe(140);
    expect(result.timeline.every((step: any) => step.interpretation)).toBe(true);
    expect(result.timeline[50].interpretation.summary).toHaveLength(400);
    expect(result.ok).toBe(true);
    expect(result.render.actual_bytes).toBeGreaterThan(result.render.soft_target_bytes);
  });

  it('bounds encoded map prompts while reconstructing escape-heavy observed and reasoning atoms', async () => {
    const observed = `${'\\"\n'.repeat(12_000)}🙂observed-tail`;
    const reasoning = `${'"\n\\'.repeat(12_000)}🙂reasoning-tail`;
    const source = [message('m1', 'assistant', [
      { type: 'step-start' },
      { type: 'reasoning', text: reasoning },
      { type: 'text', text: observed },
      { type: 'step-finish' },
    ])];
    const setup = clientFor(source);
    const result = await execute(toolsFor(setup), 'hive_task_trace', { task_id: 'child', recovery: true });
    const promptCalls = setup.calls.filter((call) => call.method === 'prompt' && JSON.parse(call.input.body.parts[0].text).kind === 'map');
    const fragments = promptCalls.flatMap((call) => JSON.parse(call.input.body.parts[0].text).fragments);

    expect(promptCalls.every((call) => Buffer.byteLength(call.input.body.parts[0].text, 'utf8') <= 20_480)).toBe(true);
    expect(fragments.map((fragment: any) => fragment.fragment)).toEqual(Array.from({ length: fragments.length }, (_, index) => index + 1));
    expect(fragments.every((fragment: any) => fragment.fragments === fragments.length)).toBe(true);
    expect(JSON.parse(fragments.map((fragment: any) => fragment.source.observed ?? '').join('')).text).toEqual([observed]);
    expect(fragments.map((fragment: any) => fragment.source.reasoning ?? '').join('')).toBe(reasoning);
    expect(result.timeline[0].interpretation).toBeDefined();
  });

  it('splits oversized singleton observed and reasoning atoms on UTF-8 boundaries without gaps', async () => {
    for (const channel of ['observed', 'reasoning'] as const) {
      const value = `start-${'🙂'.repeat(20_000)}-${channel}-end`;
      const parts = channel === 'observed'
        ? [{ type: 'text', text: value }]
        : [{ type: 'reasoning', text: value }];
      const setup = clientFor([message('m1', 'assistant', parts)]);
      const result = await execute(toolsFor(setup), 'hive_task_trace', { task_id: 'child', recovery: true });
      const promptCalls = setup.calls.filter((call) => call.method === 'prompt' && JSON.parse(call.input.body.parts[0].text).kind === 'map');
      const fragments = promptCalls.flatMap((call) => JSON.parse(call.input.body.parts[0].text).fragments);
      const reconstructed = fragments.map((fragment: any) => fragment.source[channel] ?? '').join('');

      expect(promptCalls.every((call) => Buffer.byteLength(call.input.body.parts[0].text, 'utf8') <= 20_480)).toBe(true);
      expect(fragments.length).toBeGreaterThan(1);
      expect(fragments.map((fragment: any) => fragment.fragment)).toEqual(Array.from({ length: fragments.length }, (_, index) => index + 1));
      expect(reconstructed).not.toContain('�');
      if (channel === 'observed') expect(JSON.parse(reconstructed).text).toEqual([value]);
      else expect(reconstructed).toBe(value);
      expect(result.timeline[0].interpretation).toBeDefined();
    }
  });

  it('reports map/provider/cleanup failures as explicit partial ranges without retry', async () => {
    for (const failure of ['schema', 'provider', 'cleanup'] as const) {
      const source = Array.from({ length: 20 }, (_, index) => message(`m${index}`, 'assistant', [
        { type: 'text', text: `${index}:${'x'.repeat(2500)}` },
      ]));
      const setup = clientFor(source, {
        prompt: (request, call) => failure === 'schema' && request.kind === 'map' && call === 2
          ? { kind: 'map', range: request.range, interpretations: [] }
          : undefined,
        promptError: (request, call) => failure === 'provider' && request.kind === 'map' && call === 2 ? 'provider failed' : undefined,
        deleteError: (call) => failure === 'cleanup' && call === 2 ? 'delete failed' : undefined,
      });
      const ephemeral = new Set<string>();
      const result = await execute(toolsFor(setup, ephemeral), 'hive_task_trace', { task_id: 'child', recovery: true });

      expect(result.ok).toBe(true);
      expect(result.recovery.available).toBe(false);
      expect(result.recovery.failed_ranges).toHaveLength(1);
      expect(result.recovery.failed_ranges[0].reasons).toEqual([{ schema: 'invalid_map_output', provider: 'summarizer_unavailable', cleanup: 'ephemeral_cleanup_failed' }[failure]]);
      expect(result.recovery.failed_ranges[0]).not.toHaveProperty('reason');
      expect(result.timeline.some((step: any) => step.interpretation)).toBe(true);
      expect(result.timeline.some((step: any) => !step.interpretation)).toBe(true);
      expect(setup.calls.filter((call) => call.method === 'prompt').length).toBeLessThanOrEqual(
        setup.calls.filter((call) => call.method === 'create').length,
      );
      if (failure === 'cleanup') expect(ephemeral.size).toBe(1);
    }
  });

  it('preserves concurrent map provider or schema and cleanup causes with successful-range interpretations', async () => {
    for (const failure of ['schema', 'provider'] as const) {
      const source = Array.from({ length: 20 }, (_, index) => message(`m${index}`, 'assistant', [
        { type: 'text', text: `${index}:${'x'.repeat(2500)}` },
      ]));
      const setup = clientFor(source, {
        prompt: (request, call) => failure === 'schema' && request.kind === 'map' && call === 2
          ? { kind: 'map', range: request.range, interpretations: [] }
          : undefined,
        promptError: (request, call) => failure === 'provider' && request.kind === 'map' && call === 2 ? 'provider failed' : undefined,
        deleteError: (call) => call === 2 ? 'delete failed' : undefined,
      });
      const ephemeral = new Set<string>();
      const result = await execute(toolsFor(setup, ephemeral), 'hive_task_trace', { task_id: 'child', recovery: true });
      const failed = result.recovery.failed_ranges[0];
      const expectedPrimary = failure === 'schema' ? 'invalid_map_output' : 'summarizer_unavailable';

      expect(result.timeline.map((step: any) => step.step)).toEqual(Array.from({ length: 20 }, (_, index) => index + 1));
      expect(failed.reasons).toEqual([expectedPrimary, 'ephemeral_cleanup_failed']);
      expect(failed).not.toHaveProperty('reason');
      expect(result.timeline.some((step: any) => step.interpretation)).toBe(true);
      expect(result.timeline.filter((step: any) => step.step >= failed.range[0] && step.step <= failed.range[1]).every((step: any) => !step.interpretation)).toBe(true);
      expect(ephemeral).toEqual(new Set(['summary-2']));
    }
  });

  it('keeps map interpretations but marks synthesis unavailable on reducer schema, provider, or cleanup failure', async () => {
    const source = [message('m1', 'assistant', [{ type: 'text', text: 'completed work' }])];
    for (const failure of ['schema', 'provider', 'cleanup'] as const) {
      const setup = clientFor(source, {
        prompt: (request) => failure === 'schema' && request.kind === 'reduce'
          ? { kind: 'reduce', synthesis: { overview: 'missing fields' } }
          : undefined,
        promptError: (request) => failure === 'provider' && request.kind === 'reduce' ? 'provider failed' : undefined,
        deleteError: (call) => failure === 'cleanup' && call === 2 ? 'delete failed' : undefined,
      });
      const ephemeral = new Set<string>();
      const result = await execute(toolsFor(setup, ephemeral), 'hive_task_trace', { task_id: 'child', recovery: true });

      expect(result.timeline.every((step: any) => step.interpretation)).toBe(true);
      expect(result.recovery.available).toBe(false);
      expect(result.recovery.synthesis).toEqual({
        available: false,
        reasons: [{ schema: 'invalid_reducer_output', provider: 'summarizer_unavailable', cleanup: 'ephemeral_cleanup_failed' }[failure]],
      });
      expect(setup.calls.filter((call) => call.method === 'prompt' && JSON.parse(call.input.body.parts[0].text).kind === 'reduce')).toHaveLength(1);
      if (failure === 'cleanup') expect(ephemeral).toEqual(new Set(['summary-2']));
    }
  });

  it('preserves concurrent reducer provider or schema and cleanup causes without dropping map interpretations', async () => {
    const source = [message('m1', 'assistant', [{ type: 'text', text: 'completed work' }])];
    for (const failure of ['schema', 'provider'] as const) {
      const setup = clientFor(source, {
        prompt: (request) => failure === 'schema' && request.kind === 'reduce'
          ? { kind: 'reduce', synthesis: { overview: 'missing fields' } }
          : undefined,
        promptError: (request) => failure === 'provider' && request.kind === 'reduce' ? 'provider failed' : undefined,
        deleteError: (call) => call === 2 ? 'delete failed' : undefined,
      });
      const ephemeral = new Set<string>();
      const result = await execute(toolsFor(setup, ephemeral), 'hive_task_trace', { task_id: 'child', recovery: true });
      const expectedPrimary = failure === 'schema' ? 'invalid_reducer_output' : 'summarizer_unavailable';

      expect(result.timeline.map((step: any) => step.step)).toEqual([1]);
      expect(result.timeline[0].interpretation).toMatchObject({
        provenance: 'summarizer_interpretation',
        untrusted: true,
      });
      expect(result.recovery.synthesis).toEqual({
        available: false,
        reasons: [expectedPrimary, 'ephemeral_cleanup_failed'],
      });
      expect(result.recovery.synthesis).not.toHaveProperty('reason');
      expect(ephemeral).toEqual(new Set(['summary-2']));
    }
  });

  it('accepts realistic multi-part map and reducer responses including split JSON text parts', async () => {
    const source = [message('m1', 'assistant', [
      { type: 'step-start' },
      { type: 'reasoning', text: 'private chain-of-thought that must not be parsed' },
      { type: 'text', text: 'completed work' },
      { type: 'step-finish' },
    ])];
    const reduceBody = JSON.stringify({ kind: 'reduce', synthesis: synthesis() });
    const setup = clientFor(source, {
      prompt: (request) => {
        if (request.kind === 'map') {
          const mapBody = JSON.stringify({
            kind: 'map',
            range: request.range,
            interpretations: [...new Set(request.fragments.map((fragment: any) => fragment.step))].map((step) => ({
              step,
              summary: 'Mapped from split parts',
              basis: request.fragments.some((fragment: any) => fragment.step === step && fragment.source.reasoning)
                ? request.fragments.some((fragment: any) => fragment.step === step && fragment.source.observed) ? 'mixed' : 'reasoning'
                : 'observed',
            })),
          });
          const mid = Math.floor(mapBody.length / 2);
          return {
            parts: [
              { type: 'step-start' },
              { type: 'reasoning', text: 'do not concatenate this into JSON' },
              { type: 'text', text: mapBody.slice(0, mid) },
              { type: 'text', text: mapBody.slice(mid) },
              { type: 'step-finish' },
            ],
          };
        }
        const mid = Math.floor(reduceBody.length / 2);
        return {
          parts: [
            { type: 'step-start' },
            { type: 'reasoning', text: 'reducer private reasoning' },
            { type: 'text', text: reduceBody.slice(0, mid) },
            { type: 'text', text: reduceBody.slice(mid) },
            { type: 'step-finish' },
          ],
        };
      },
    });
    const result = await execute(toolsFor(setup), 'hive_task_trace', { task_id: 'child', recovery: true });

    expect(result.recovery.available).toBe(true);
    expect(result.timeline[0].interpretation).toMatchObject({
      summary: 'Mapped from split parts',
      basis: 'mixed',
      provenance: 'summarizer_interpretation',
      untrusted: true,
    });
    expect(result.recovery.synthesis).toEqual(synthesis());
    expect(JSON.stringify(result)).not.toContain('do not concatenate this into JSON');
    expect(JSON.stringify(result)).not.toContain('reducer private reasoning');
    expect(JSON.stringify(result)).not.toContain('private chain-of-thought');
  });

  it('rejects multi-part summarizer output with no text parts as invalid map/reducer output', async () => {
    const source = [message('m1', 'assistant', [{ type: 'text', text: 'completed work' }])];
    const setup = clientFor(source, {
      prompt: () => ({
        parts: [
          { type: 'step-start' },
          { type: 'reasoning', text: '{"kind":"map"}' },
          { type: 'step-finish' },
        ],
      }),
    });
    const result = await execute(toolsFor(setup), 'hive_task_trace', { task_id: 'child', recovery: true });

    expect(result.ok).toBe(true);
    expect(result.recovery.available).toBe(false);
    expect(result.recovery.failed_ranges).toEqual([{ range: [1, 1], reasons: ['invalid_map_output'] }]);
    expect(result.recovery.synthesis).toEqual({ available: false, reasons: ['no_successful_map_ranges'] });
    expect(result.timeline[0].interpretation).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('{"kind":"map"}');
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
