import { describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
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
  parentID?: string | null;
  childID?: string;
  directory?: unknown;
  // Native session records by requested ID; IDs not listed fall back to the traced target record.
  sessions?: Record<string, unknown | ((reads: number) => unknown)>;
  getResponse?: { data?: unknown; error?: unknown };
  getError?: unknown;
  status?: Record<string, unknown>;
  statusResponse?: { data?: unknown; error?: unknown };
  statusError?: unknown;
  mutateStatus?: (reads: number) => { data?: unknown; error?: unknown };
  statusByDirectory?: (directory: unknown) => { data?: unknown; error?: unknown };
  mutateMessages?: (reads: number) => unknown[];
  prompt?: (request: any, call: number) => unknown | Promise<unknown>;
  promptError?: (request: any, call: number) => unknown;
  providers?: (input: any) => unknown | Promise<unknown>;
  create?: (call: number, input: any) => unknown | Promise<unknown>;
  abort?: (call: number, input: any) => unknown | Promise<unknown>;
  delete?: (call: number, input: any) => unknown | Promise<unknown>;
} = {}) {
  const calls: Call[] = [];
  let messageReads = 0;
  let statusReads = 0;
  let createCalls = 0;
  let promptCalls = 0;
  let abortCalls = 0;
  let deleteCalls = 0;
  const sessionReads = new Map<string, number>();
  const session = {
    get: async (input: any) => {
      calls.push({ method: 'get', input });
      if (options.getError) throw options.getError;
      const requested = input?.path?.id;
      const known = options.sessions?.[requested];
      if (known !== undefined) {
        const reads = (sessionReads.get(requested) ?? 0) + 1;
        sessionReads.set(requested, reads);
        const value = typeof known === 'function' ? (known as (reads: number) => unknown)(reads) : known;
        if (value instanceof Error) throw value;
        return value as { data?: unknown; error?: unknown };
      }
      if (options.getResponse) return options.getResponse;
      return {
        data: {
          id: options.childID ?? 'child',
          directory: 'directory' in options ? options.directory : '/repo',
          ...(options.parentID === null ? {} : { parentID: options.parentID ?? 'parent' }),
        },
      };
    },
    messages: async (input: unknown) => {
      calls.push({ method: 'messages', input });
      messageReads += 1;
      return { data: options.mutateMessages?.(messageReads) ?? messages };
    },
    status: async (input: any) => {
      calls.push({ method: 'status', input });
      statusReads += 1;
      if (options.statusError) throw options.statusError;
      if (options.statusByDirectory) return options.statusByDirectory(input?.query?.directory);
      return options.mutateStatus?.(statusReads)
        ?? options.statusResponse
        ?? { data: options.status ?? {} };
    },
    create: async (input: any) => {
      calls.push({ method: 'create', input });
      createCalls += 1;
      if (options.create) return { data: await options.create(createCalls, input) };
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
  sessionID = 'parent',
) {
  return tools[name].execute(args as never, {
    sessionID,
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
  sessionID = 'parent',
) {
  return JSON.parse(await executeRaw(tools, name, args, new AbortController().signal, sessionID));
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

// Native task tool part shapes: OpenCode records the child in state.metadata while running, on
// error, and on completion; part.metadata holds provider metadata and may mirror the key.
function nativeTask(
  callID: string,
  status: 'pending' | 'running' | 'completed' | 'error',
  metadata: { state?: Record<string, unknown>; part?: Record<string, unknown> } = {},
  input: Record<string, unknown> = { description: `Task ${callID}`, prompt: 'Do the work.', subagent_type: 'forager-worker' },
) {
  const state = status === 'pending'
    ? { status }
    : {
        status,
        input,
        title: input.description,
        ...(metadata.state ? { metadata: metadata.state } : {}),
        ...(status === 'completed' ? { output: 'Child finished.' } : {}),
        ...(status === 'error' ? { error: 'Tool execution aborted' } : {}),
        time: status === 'running' ? { start: 1 } : { start: 1, end: 2 },
      };
  return { type: 'tool', tool: 'task', callID, state, ...(metadata.part ? { metadata: metadata.part } : {}) };
}

function childRecord(id: string, parentID = 'child', directory = '/repo') {
  return { data: { id, parentID, directory, projectID: 'project', title: id, version: '1', time: { created: 1, updated: 1 } } };
}

// A worker whose foreground tool never recorded a result, followed by a closed later exchange.
function interruptedTrace() {
  return [
    message('instruction', 'user', [{ type: 'text', text: 'Implement the fix.' }]),
    message('work', 'assistant', [
      { type: 'step-start' },
      { type: 'text', text: 'Running the suite.' },
      { type: 'tool', tool: 'bash', callID: 'call-suite', state: { status: 'running', input: { command: 'bun test' }, time: { start: 1 } } },
    ], { completed: false }),
    message('later', 'user', [{ type: 'text', text: 'Status?' }]),
    message('later-reply', 'assistant', [{ type: 'text', text: 'Still waiting on the suite.' }]),
  ];
}

function token(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function decodeToken(value: string): unknown {
  return JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
}

function bareMessage(parts: Array<Record<string, unknown>>) {
  return { info: { role: 'assistant', time: { created: 1, completed: 2 } }, parts };
}

async function indexPages(tools: ReturnType<typeof createTaskTraceTools>) {
  const pages: any[] = [];
  const serialized: string[] = [];
  let cursor: string | undefined;
  do {
    const raw = await executeRaw(tools, 'hive_task_trace', { task_id: 'child', ...(cursor ? { cursor } : {}) });
    const page = JSON.parse(raw);
    expect(page.ok).toBe(true);
    pages.push(page);
    serialized.push(raw);
    cursor = page.coverage.next_cursor ?? undefined;
  } while (cursor && pages.length < 50);
  return { pages, serialized, events: pages.flatMap((page) => page.events) };
}

async function readEvent(tools: ReturnType<typeof createTaskTraceTools>, event: string) {
  return execute(tools, 'hive_task_trace_content', { task_id: 'child', event });
}

async function readField(tools: ReturnType<typeof createTaskTraceTools>, event: string, field: string, first: any) {
  const chunks: string[] = [first.content];
  let offset = first.next_offset;
  while (offset !== null) {
    const chunk = await execute(tools, 'hive_task_trace_content', { task_id: 'child', event, field, offset });
    expect(chunk).toMatchObject({ ok: true, version: 3, field, offset, bytes: first.bytes, sha256: first.sha256 });
    chunks.push(chunk.content);
    offset = chunk.next_offset;
  }
  return { text: chunks.join(''), chunks };
}

describe('forensic task trace v3 index', () => {
  it('lists every surviving non-reasoning event once in source order across readable bounded pages', async () => {
    const setup = clientFor(realisticTrace());
    const tools = toolsFor(setup);
    const { pages, serialized, events } = await indexPages(tools);

    expect(pages.length).toBeGreaterThan(1);
    expect(events.map((event: any) => event.seq)).toEqual(sourceSteps(1, 118));
    for (const [index, page] of pages.entries()) {
      expect(page).toMatchObject({ ok: true, version: 3, task_id: 'child', target: { id: 'child', relationship: 'direct_child' } });
      expect(page.lifecycle).toEqual({ state: 'terminal', terminal: true, reason: 'idle_and_closed', runtime: 'idle' });
      expect(page.source).toMatchObject({
        messages: 59, parts: 291, events: 118, reasoning_parts: 57, structural_parts: 116,
        fidelity: 'surviving_source', compactions: 0, as_of: expect.any(String),
      });
      expect(page.events.length).toBeGreaterThan(1);
      expect(page.render).toEqual({ bytes: Buffer.byteLength(serialized[index]), budget_bytes: 24_576 });
      expect(page.render.bytes).toBeLessThanOrEqual(24_576);
      expect(page.coverage).toMatchObject({ events: 118, from_seq: page.events[0].seq, to_seq: page.events.at(-1).seq, limitations: [] });
      expect(page.context).toEqual({
        assignment: { seq: 1, text: 'Implement every requested invariant.', bytes: 36, ref: events[0].ref },
        final: { seq: 117, text: 'All requested work succeeded.', bytes: 29, provenance: 'child_self_report', untrusted: true, ref: events[116].ref },
      });
      expect(page.reasoning).toMatchObject({ availability: 'plaintext', parts: 57 });
    }
    expect(pages.slice(0, -1).every((page) => page.coverage.complete === false && typeof page.coverage.next_cursor === 'string')).toBe(true);
    expect(pages.at(-1).coverage).toMatchObject({ complete: true, next_cursor: null, to_seq: 118 });

    expect(events[0]).toEqual({ seq: 1, kind: 'text', actor: 'user', text: 'Implement every requested invariant.', bytes: { text: 36 }, ref: expect.any(String) });
    expect(events[2]).toEqual({
      seq: 3, kind: 'tool', actor: 'assistant', tool: 'bash', status: 'completed',
      input: { index: 1 }, output: 'output 1', bytes: { input: 11, output: 8 }, ref: expect.any(String),
    });
    expect(events.find((event: any) => event.kind === 'retry')).toMatchObject({ seq: 60, actor: 'assistant', error: { name: 'ProviderError', message: 'middle retry' } });
    expect(events.at(-1)).toMatchObject({ seq: 118, kind: 'patch', files: ['src/final.ts', 'src/shared.ts'] });

    const allowed = new Set(['seq', 'kind', 'actor', 'identity', 'tool', 'status', 'call_id', 'title', 'synthetic', 'summary', 'compacted', 'type', 'text', 'input', 'output', 'error', 'files', 'bytes', 'abbreviated', 'ref']);
    expect(events.flatMap((event: any) => Object.keys(event)).filter((key: string) => !allowed.has(key))).toEqual([]);
    const keys = serialized.flatMap((raw) => allKeys(JSON.parse(raw)));
    for (const excluded of ['timeline', 'content_dictionary', 'tool_dictionary', 'tool_rollup', 'r']) expect(keys).not.toContain(excluded);
    const tokens = [...events.map((event: any) => decodeToken(event.ref)), decodeToken(pages[0].coverage.next_cursor)];
    expect(JSON.stringify([serialized, tokens])).not.toContain('private reasoning');
    expect(setup.calls.map((call) => call.method)).toEqual(pages.flatMap(() => ['get', 'messages', 'status']));
  });

  it('shows recorded identifying inputs and head-and-tail excerpts that distinguish repeated command prefixes', async () => {
    const prefix = `cd /workspace/${'nested/'.repeat(40)}project && bun test --timeout 60000 `;
    const alphaInput = { command: `${prefix}src/alpha.test.ts`, description: 'Run suite A', workdir: '/workspace' };
    const betaInput = { command: `${prefix}src/beta.test.ts`, description: 'Run suite B', workdir: '/workspace' };
    const alphaOutput = `${'noise\n'.repeat(400)}alpha: 3 pass 0 fail`;
    const betaError = `${'trace\n'.repeat(400)}beta: 1 fail`;
    const source = [
      message('instruction', 'user', [{ type: 'text', text: 'Verify both suites.' }]),
      message('work', 'assistant', [
        { type: 'tool', tool: 'skill', callID: 'call-skill', state: { status: 'completed', title: 'Loaded skill: verification', input: { name: 'verification' }, output: 'skill body' } },
        { type: 'tool', tool: 'bash', callID: 'call-a', state: { status: 'completed', title: 'Run suite A', input: alphaInput, output: alphaOutput } },
        { type: 'tool', tool: 'bash', callID: 'call-b', state: { status: 'error', title: 'Run suite B', input: betaInput, error: betaError } },
        { type: 'tool', tool: 'read', callID: 'call-read', state: { status: 'completed', title: 'src/alpha.ts', input: { filePath: 'src/alpha.ts' }, output: 'export {}' } },
      ]),
    ];
    const { events } = await indexPages(toolsFor(clientFor(source)));
    const [, skill, alpha, beta, read] = events;

    expect(skill).toMatchObject({ tool: 'skill', call_id: 'call-skill', title: 'Loaded skill: verification', input: { name: 'verification' }, output: 'skill body' });
    expect(skill).not.toHaveProperty('abbreviated');
    expect(read).toMatchObject({ tool: 'read', input: { filePath: 'src/alpha.ts' }, output: 'export {}' });
    for (const [event, suite, input] of [[alpha, 'alpha', alphaInput], [beta, 'beta', betaInput]] as const) {
      expect(event).toMatchObject({ kind: 'tool', tool: 'bash', input: { description: input.description } });
      expect(Object.keys(event.input).sort()).toEqual(['command', 'description']);
      expect(event.input.command.startsWith('cd /workspace/nested/')).toBe(true);
      expect(event.input.command.endsWith(`src/${suite}.test.ts`)).toBe(true);
      expect(event.input.command).toContain(' [...] ');
      expect(event.bytes.input).toBe(Buffer.byteLength(JSON.stringify(input)));
    }
    expect(alpha.input.command).not.toBe(beta.input.command);
    expect(alpha).toMatchObject({ status: 'completed', title: 'Run suite A', abbreviated: ['input', 'output'], bytes: { output: Buffer.byteLength(alphaOutput) } });
    expect(alpha.output.startsWith('noise\n')).toBe(true);
    expect(alpha.output.endsWith('alpha: 3 pass 0 fail')).toBe(true);
    expect(beta).toMatchObject({ status: 'error', title: 'Run suite B', abbreviated: ['input', 'error'] });
    expect(beta.bytes).toEqual({ input: Buffer.byteLength(JSON.stringify(betaInput)), error: Buffer.byteLength(betaError) });
    expect(beta).not.toHaveProperty('output');
    expect(beta.error.endsWith('beta: 1 fail')).toBe(true);
  });

  it('bounds every page by serialized bytes with forward progress for escaped and Unicode-heavy values and names', async () => {
    const hostile = '"\\\u0000\n🙂\u2028';
    const source = Array.from({ length: 40 }, (_, index) => message(`m${index}`, 'assistant', [
      { type: 'tool', tool: `${hostile.repeat(2_000)}-${index}`, callID: `call-${hostile.repeat(100)}`, state: { status: 'completed', title: hostile.repeat(3_000), input: { command: hostile.repeat(3_000) }, output: hostile.repeat(3_000) } },
      { type: `${hostile.repeat(500)}-${index}` },
      { type: 'text', text: hostile.repeat(5_000) },
    ]));
    const { pages, serialized, events } = await indexPages(toolsFor(clientFor(source)));

    expect(pages.length).toBeGreaterThan(1);
    expect(events.map((event: any) => event.seq)).toEqual(sourceSteps(1, 120));
    for (const [index, page] of pages.entries()) {
      expect(page.events.length).toBeGreaterThan(0);
      expect(page.render.bytes).toBe(Buffer.byteLength(serialized[index]));
      expect(page.render.bytes).toBeLessThanOrEqual(24_576);
    }
    for (const event of events) expect(Buffer.byteLength(JSON.stringify(event))).toBeLessThan(4_096);
    const tools = events.filter((event: any) => event.kind === 'tool');
    expect(tools.every((event: any) => ['tool', 'title', 'call_id', 'input', 'output'].every((key) => event.abbreviated.includes(key)))).toBe(true);
    expect(tools[7].tool.endsWith('-7')).toBe(true);
    expect(events.filter((event: any) => event.kind === 'unsupported').every((event: any) => event.abbreviated.includes('type'))).toBe(true);
    expect(pages[0].coverage.limitations).toEqual(['unsupported_parts']);
    expect(serialized.join('')).not.toContain('\uFFFD');
    expect(serialized.join('')).not.toMatch(/\\ud[89ab]/i);
  });

  it('indexes active, uncertain, and terminal sessions and reads their live actions', async () => {
    const instruction = message('instruction', 'user', [{ type: 'text', text: 'Run the suite.' }]);
    const running = [
      instruction,
      message('work', 'assistant', [{ type: 'tool', tool: 'bash', callID: 'call-run', state: { status: 'running', input: { command: 'bun test' } } }], { completed: false }),
    ];
    const finished = [instruction, message('work', 'assistant', [{ type: 'text', text: 'Suite passed.' }])];
    const cases: Array<[unknown[], Record<string, unknown>, Record<string, unknown>]> = [
      [running, { status: { child: { type: 'busy' } } }, { state: 'active', terminal: false, reason: 'runtime_active', runtime: 'busy', unresolved_tools: { latest_message: 1, earlier_messages: 0 } }],
      [running, { statusError: new Error('unavailable') }, { state: 'uncertain', terminal: false, reason: 'status_unavailable', runtime: 'unavailable', unresolved_tools: { latest_message: 1, earlier_messages: 0 } }],
      [finished, { status: {} }, { state: 'terminal', terminal: true, reason: 'idle_and_closed', runtime: 'idle' }],
    ];
    for (const [source, options, lifecycle] of cases) {
      const tools = toolsFor(clientFor(source, options as any));
      const { pages, events } = await indexPages(tools);
      const read = await readEvent(tools, events[1].ref);

      expect(pages[0].lifecycle).toEqual(lifecycle);
      expect(read.ok).toBe(true);
      if (lifecycle.terminal) {
        expect(pages[0].context.final).toMatchObject({ seq: 2, text: 'Suite passed.', provenance: 'child_self_report', untrusted: true });
      } else {
        expect(pages[0].context.final).toBeNull();
        expect(events[1]).toMatchObject({ kind: 'tool', status: 'running', call_id: 'call-run', input: { command: 'bun test' } });
        expect(read.event.fields).toEqual({
          input: { state: 'value', format: 'json', bytes: Buffer.byteLength('{"command":"bun test"}'), value: { command: 'bun test' } },
          output: { state: 'absent' },
          error: { state: 'absent' },
        });
      }
    }
  });

  it('makes compaction, compacted tool output, unsupported parts, and missing native identity visible coverage limits', async () => {
    const source = [
      message('summary', 'assistant', [{ type: 'text', text: 'Summary of earlier work.' }], { summary: true }),
      message('work', 'assistant', [
        { type: 'compaction' },
        { type: 'tool', tool: 'read', callID: 'call-read', state: { status: 'completed', input: { filePath: 'a.ts' }, output: '[Old tool result content cleared]', time: { start: 1, end: 2, compacted: 3 } } },
        { type: 'file', mime: 'text/plain', filename: 'a.txt', url: 'data:text/plain;base64,SECRET_FILE_BODY' },
        { type: 'mystery', error: 'NOT_STRUCTURED' },
      ]),
      bareMessage([{ type: 'text', text: 'No native identity.' }]),
    ];
    const tools = toolsFor(clientFor(source));
    const { pages, serialized, events } = await indexPages(tools);

    expect(pages[0].source).toMatchObject({ fidelity: 'compacted_surviving_source', compactions: 2, events: 6 });
    expect(pages[0].coverage).toMatchObject({
      complete: true,
      limitations: ['compacted_source', 'compacted_tool_output', 'unsupported_parts', 'positional_identity'],
    });
    expect(events.map((event: any) => [event.kind, event.type ?? null])).toEqual([
      ['text', null], ['compaction', null], ['tool', null], ['unsupported', 'file'], ['unsupported', 'mystery'], ['text', null],
    ]);
    expect(events[0]).toMatchObject({ summary: true, text: 'Summary of earlier work.' });
    expect(events[2]).toMatchObject({ compacted: true, output: '[Old tool result content cleared]' });
    expect(events[5]).toMatchObject({ identity: 'positional', text: 'No native identity.' });
    expect(events.slice(0, 5).every((event: any) => event.identity === undefined)).toBe(true);

    const positional = await readEvent(tools, events[5].ref);
    const unsupported = await readEvent(tools, events[3].ref);
    expect(positional.event).toMatchObject({ seq: 6, kind: 'text', identity: 'positional', fields: { text: { state: 'value', value: 'No native identity.' } } });
    expect(positional.event).not.toHaveProperty('message_id');
    expect(unsupported.event).toMatchObject({ seq: 4, kind: 'unsupported', type: 'file', identity: 'native', fields: {} });
    for (const secret of ['SECRET_FILE_BODY', 'NOT_STRUCTURED']) expect(JSON.stringify([serialized, unsupported])).not.toContain(secret);
  });

  it('reads one tool action with paired input, output, and error and keeps absent distinct from empty', async () => {
    const source = [message('work', 'assistant', [
      { type: 'tool', tool: 'bash', callID: 'call-empty', state: { status: 'completed', title: 'Quiet command', input: { command: 'true', description: 'Quiet command' }, output: '' } },
      { type: 'tool', tool: 'bash', callID: 'call-error', state: { status: 'error', input: { command: 'false' }, error: 'exit 1' } },
      { type: 'tool', tool: 'bash', callID: 'call-pending', state: { status: 'pending' } },
      { type: 'text', text: '' },
    ])];
    const tools = toolsFor(clientFor(source));
    const { events } = await indexPages(tools);
    const quietInput = { command: 'true', description: 'Quiet command' };

    expect(events[0]).toMatchObject({ output: '', bytes: { input: Buffer.byteLength(JSON.stringify(quietInput)), output: 0 } });
    expect(events[2].bytes).toEqual({});
    for (const key of ['input', 'output', 'error']) expect(events[2]).not.toHaveProperty(key);
    expect(await readEvent(tools, events[0].ref)).toEqual({
      ok: true,
      version: 3,
      task_id: 'child',
      source: { events: 4, as_of: expect.any(String) },
      event: {
        seq: 1, kind: 'tool', actor: 'assistant', identity: 'native',
        message_id: 'work', part_id: 'work-part-0', call_id: 'call-empty',
        tool: 'bash', status: 'completed', title: 'Quiet command',
        fields: {
          input: { state: 'value', format: 'json', bytes: Buffer.byteLength(JSON.stringify(quietInput)), value: quietInput },
          output: { state: 'value', format: 'text', bytes: 0, value: '' },
          error: { state: 'absent' },
        },
      },
    });
    expect((await readEvent(tools, events[1].ref)).event.fields).toEqual({
      input: { state: 'value', format: 'json', bytes: Buffer.byteLength('{"command":"false"}'), value: { command: 'false' } },
      output: { state: 'absent' },
      error: { state: 'value', format: 'text', bytes: 6, value: 'exit 1' },
    });
    expect((await readEvent(tools, events[2].ref)).event).toMatchObject({
      status: 'pending',
      fields: { input: { state: 'absent' }, output: { state: 'absent' }, error: { state: 'absent' } },
    });
    expect((await readEvent(tools, events[3].ref)).event).toMatchObject({ kind: 'text', fields: { text: { state: 'value', format: 'text', bytes: 0, value: '' } } });
  });

  it('continues oversized fields from exact canonical text across UTF-8 chunk boundaries', async () => {
    const input = { command: `printf '${'🙂'.repeat(3_000)}'`, description: 'Emit emoji', nested: { values: Array.from({ length: 200 }, (_, index) => `v${index}-é`) } };
    const output = `head-${'🙂é\n'.repeat(6_000)}-tail`;
    const setup = clientFor([message('work', 'assistant', [{ type: 'tool', tool: 'bash', callID: 'call-big', state: { status: 'completed', input, output } }])]);
    const tools = toolsFor(setup);
    const { events } = await indexPages(tools);
    const ref = events[0].ref;
    const read = await readEvent(tools, ref);

    expect(events[0].abbreviated).toEqual(['input', 'output']);
    for (const [field, expected, format] of [['input', JSON.stringify(input), 'json'], ['output', output, 'text']] as const) {
      const first = read.event.fields[field];
      expect(first).toMatchObject({ state: 'chunked', format, bytes: Buffer.byteLength(expected), offset: 0 });
      expect(typeof first.next_offset).toBe('number');
      expect(first.sha256).toBe(createHash('sha256').update(expected).digest('base64url'));
      const { text, chunks } = await readField(tools, ref, field, first);
      expect(text).toBe(expected);
      expect(chunks.length).toBeGreaterThan(1);
      expect(chunks.every((chunk) => Buffer.byteLength(chunk) <= 8_192 && !chunk.includes('\uFFFD'))).toBe(true);
    }
    expect(await execute(tools, 'hive_task_trace_content', { task_id: 'child', event: ref, field: 'output', offset: 6 })).toEqual({ ok: false, reason: 'invalid_offset' });
    expect(await execute(tools, 'hive_task_trace_content', { task_id: 'child', event: ref, field: 'error' })).toEqual({ ok: false, reason: 'field_absent' });
    const gets = setup.calls.filter((call) => call.method === 'get').length;
    expect(gets).toBe(setup.calls.filter((call) => call.method === 'messages').length);
    expect(gets).toBeGreaterThan(4);
  });

  it('keeps unchanged action reads valid across unrelated appends and rejects a changed selected action', async () => {
    const instruction = message('instruction', 'user', [{ type: 'text', text: 'Read and test.' }]);
    const done = { type: 'tool', tool: 'read', callID: 'call-done', state: { status: 'completed', input: { filePath: 'a.ts' }, output: `alpha-${'a'.repeat(9_000)}` } };
    const running = { type: 'tool', tool: 'bash', callID: 'call-running', state: { status: 'running', input: { command: 'bun test' } } };
    const before = [instruction, message('work', 'assistant', [done, running], { completed: false })];
    const after = [
      instruction,
      message('work', 'assistant', [done, { ...running, state: { status: 'completed', input: { command: 'bun test' }, output: '1 pass' } }]),
      message('later', 'assistant', [{ type: 'text', text: 'Appended progress.' }], { completed: false }),
    ];
    const setup = clientFor(before, { mutateMessages: (reads) => reads === 1 ? before : after, status: { child: { type: 'busy' } } });
    const tools = toolsFor(setup);
    const { pages, events } = await indexPages(tools);
    const doneRead = await readEvent(tools, events[1].ref);
    const continued = await execute(tools, 'hive_task_trace_content', {
      task_id: 'child', event: events[1].ref, field: 'output', offset: doneRead.event.fields.output.next_offset,
    });

    expect(pages[0].lifecycle.state).toBe('active');
    expect(doneRead).toMatchObject({ ok: true, source: { events: 4 }, event: { seq: 2, call_id: 'call-done', status: 'completed' } });
    expect(doneRead.source.as_of).not.toBe(pages[0].source.as_of);
    expect(continued).toMatchObject({ ok: true, field: 'output', next_offset: null });
    expect(await readEvent(tools, events[2].ref)).toEqual({ ok: false, reason: 'event_changed' });
  });

  it('never attributes a duplicate command to another action after deletion, insertion, replacement, or mutation', async () => {
    const duplicate = (id: string, output = '1 fail') => message(id, 'assistant', [
      { type: 'tool', tool: 'bash', callID: `call-${id}`, state: { status: 'completed', input: { command: 'bun test' }, output } },
    ]);
    const readWith = (source: unknown[], ref: string) => readEvent(toolsFor(clientFor(source)), ref);
    const indexWith = async (source: unknown[]) => (await indexPages(toolsFor(clientFor(source)))).pages[0];
    const nativeRefs = (await indexWith([duplicate('first'), duplicate('second')])).events.map((event: any) => event.ref);

    expect(await readWith([duplicate('second')], nativeRefs[0])).toEqual({ ok: false, reason: 'event_not_found' });
    expect(await readWith([duplicate('second')], nativeRefs[1])).toMatchObject({ ok: true, event: { seq: 1, part_id: 'second-part-0', call_id: 'call-second' } });
    expect(await readWith([duplicate('first', '0 fail'), duplicate('second')], nativeRefs[0])).toEqual({ ok: false, reason: 'event_changed' });
    expect(await readWith([duplicate('first', '0 fail'), duplicate('second')], nativeRefs[1])).toMatchObject({ ok: true, event: { seq: 2, part_id: 'second-part-0' } });
    expect(await readWith([duplicate('second'), duplicate('first'), duplicate('third')], nativeRefs[1])).toMatchObject({ ok: true, event: { seq: 1, part_id: 'second-part-0' } });

    // Without native IDs, byte-identical actions cannot be told apart, so none of them gets a ref.
    const bashPart = (output = '1 fail') => ({ type: 'tool', tool: 'bash', state: { status: 'completed', input: { command: 'bun test' }, output } });
    const bare = (output = '1 fail') => bareMessage([bashPart(output)]);
    const failed = () => ({ info: { role: 'assistant', time: { created: 1 }, error: { name: 'ProviderError', message: 'overloaded' } }, parts: [] });
    for (const ambiguous of [[bare(), bare()], [bareMessage([bashPart(), bashPart()])], [failed(), failed()]]) {
      const page = await indexWith(ambiguous);
      expect(page.events.map((event: any) => event.identity)).toEqual(['ambiguous', 'ambiguous']);
      expect(page.events.some((event: any) => 'ref' in event)).toBe(false);
      expect(page.coverage.limitations).toEqual(['positional_identity']);
    }

    // A positional ref names one event of an unchanged eligible source; any source change fails closed.
    const distinct = [bare('1 fail'), bare('0 fail')];
    const positional = (await indexWith(distinct)).events;
    expect(positional.map((event: any) => event.identity)).toEqual(['positional', 'positional']);
    expect(await readWith(distinct, positional[1].ref)).toMatchObject({ ok: true, event: { seq: 2, identity: 'positional', fields: { output: { value: '0 fail' } } } });
    for (const changed of [
      [bare('0 fail')],
      [bare('0 fail'), bare('1 fail')],
      [bare('1 fail'), bare('0 fail'), bare('1 fail')],
      [bareMessage([{ type: 'text', text: 'inserted' }]), ...distinct],
      [bare('1 fail'), bare('2 fail')],
    ]) {
      for (const event of positional) expect(await readWith(changed, event.ref)).toEqual({ ok: false, reason: 'source_changed' });
    }

    // Deleting one of two identical actions and appending an identical one leaves the same eligible source;
    // a forged selector for either copy still fails closed instead of choosing one.
    const replaced = [bare(), bare()];
    const [, , , guard] = decodeToken((await indexWith([bare(), bare('0 fail')])).events[0].ref) as unknown[];
    const forged = token([3, 'p', 1, guard, (await indexWith(replaced)).source.as_of]);
    expect(await readWith(replaced, forged)).toEqual({ ok: false, reason: 'identity_unavailable' });
  });

  it.each(['partial', 'duplicated'])('rejects positional reads after recorded %s IDs change with the same fields', async (identity) => {
    const sourceFor = (id: string, partID = 'shared-part') => identity === 'partial'
      ? [{ info: { id, role: 'assistant' }, parts: [{ type: 'text', text: 'unchanged' }] }]
      : ['first', 'second'].map((output) => message(id, 'assistant', [
        { id: partID, type: 'tool', tool: 'bash', state: { status: 'completed', input: { command: 'bun test' }, output } },
      ]));
    const before = await execute(toolsFor(clientFor(sourceFor('old-message'))), 'hive_task_trace', { task_id: 'child' });
    const replacement = sourceFor('new-message');
    const after = await execute(toolsFor(clientFor(replacement)), 'hive_task_trace', { task_id: 'child' });

    expect(before.events.every((event: any) => event.identity === 'positional')).toBe(true);
    expect(after.source.as_of).not.toBe(before.source.as_of);
    for (const event of before.events) {
      expect(await readEvent(toolsFor(clientFor(replacement)), event.ref)).toEqual({ ok: false, reason: 'source_changed' });
    }
    if (identity === 'partial') {
      const partOnly = (id: string) => [bareMessage([{ id, type: 'text', text: 'unchanged' }])];
      const original = await execute(toolsFor(clientFor(partOnly('old-part'))), 'hive_task_trace', { task_id: 'child' });
      expect(await readEvent(toolsFor(clientFor(partOnly('new-part'))), original.events[0].ref)).toEqual({ ok: false, reason: 'source_changed' });
    } else {
      const unique = await execute(toolsFor(clientFor(sourceFor('old-message').slice(0, 1))), 'hive_task_trace', { task_id: 'child' });
      expect(await readEvent(toolsFor(clientFor(sourceFor('old-message'))), unique.events[0].ref)).toEqual({ ok: false, reason: 'event_ambiguous' });
      for (const changed of [sourceFor('old-message', 'new-part'), sourceFor('new-message', 'new-part')]) {
        for (const event of before.events) {
          expect(await readEvent(toolsFor(clientFor(changed)), event.ref)).toEqual({ ok: false, reason: 'source_changed' });
        }
      }
    }
  });

  it('continues pagination across appends and requires a restart after earlier source changes', async () => {
    const text = (index: number) => message(`m${index}`, 'assistant', [{ type: 'text', text: `${index}:${'x'.repeat(300)}` }]);
    const source = Array.from({ length: 150 }, (_, index) => text(index));
    const first = await execute(toolsFor(clientFor(source)), 'hive_task_trace', { task_id: 'child' });
    const cursor = first.coverage.next_cursor;
    const continueWith = (messages: unknown[]) => execute(toolsFor(clientFor(messages)), 'hive_task_trace', { task_id: 'child', cursor });

    expect(typeof cursor).toBe('string');
    const appendedTools = toolsFor(clientFor([...source, text(150), text(151)]));
    const pages = [first];
    for (let next = cursor; next;) {
      const page = await execute(appendedTools, 'hive_task_trace', { task_id: 'child', cursor: next });
      pages.push(page);
      next = page.coverage.next_cursor;
    }
    expect(pages[1].coverage.from_seq).toBe(first.coverage.to_seq + 1);
    expect(pages.flatMap((page) => page.events.map((event: any) => event.seq))).toEqual(sourceSteps(1, 152));
    expect(pages.at(-1).coverage).toMatchObject({ complete: true, events: 152 });

    expect((await continueWith(source.map((entry, index) => index === 149 ? text(999) : entry))).ok).toBe(true);
    for (const changed of [[text(999), ...source.slice(1)], source.slice(1), [text(999), ...source]]) {
      expect(await continueWith(changed)).toEqual({ ok: false, reason: 'cursor_stale' });
    }
  });

  it('continues a cursor over events without native identity only while the whole eligible source is unchanged', async () => {
    const bare = (label = 'same') => bareMessage([{ type: 'text', text: `${label}:${'x'.repeat(300)}` }]);
    const source = Array.from({ length: 150 }, () => bare());
    const { pages, events } = await indexPages(toolsFor(clientFor(source)));
    const cursor = pages[0].coverage.next_cursor;
    const continueWith = (messages: unknown[]) => execute(toolsFor(clientFor(messages)), 'hive_task_trace', { task_id: 'child', cursor });

    expect(pages.length).toBeGreaterThan(1);
    expect(events.map((event: any) => event.seq)).toEqual(sourceSteps(1, 150));
    expect(events.every((event: any) => event.identity === 'ambiguous')).toBe(true);
    expect(pages.at(-1).coverage).toMatchObject({ complete: true, events: 150 });
    for (const changed of [
      source.slice(1),
      [...source.slice(1), bare('replacement')],
      [...source, bare()],
      [bare('changed'), ...source.slice(1)],
    ]) {
      expect(await continueWith(changed)).toEqual({ ok: false, reason: 'cursor_stale' });
    }

    const partial = Array.from({ length: 150 }, (_, index) => ({ ...bare(`${index}`), info: { id: `m${index}`, role: 'assistant' } }));
    const first = await execute(toolsFor(clientFor(partial)), 'hive_task_trace', { task_id: 'child' });
    expect(typeof first.coverage.next_cursor).toBe('string');
    const replaced = [{ ...partial[0], info: { id: 'replacement', role: 'assistant' } }, ...partial.slice(1)];
    expect(await execute(toolsFor(clientFor(replaced)), 'hive_task_trace', { task_id: 'child', cursor: first.coverage.next_cursor })).toEqual({ ok: false, reason: 'cursor_stale' });

    const mixed = [bare('early'), ...Array.from({ length: 149 }, (_, index) => message(`native${index}`, 'assistant', [{ type: 'text', text: `${index}:${'x'.repeat(300)}` }]))];
    const mixedFirst = await execute(toolsFor(clientFor(mixed)), 'hive_task_trace', { task_id: 'child' });
    expect(mixedFirst.events[0].identity).toBe('positional');
    expect(decodeToken(mixedFirst.events.at(-1).ref)[1]).toBe('n');
    expect(typeof mixedFirst.coverage.next_cursor).toBe('string');
    expect(await execute(toolsFor(clientFor([...mixed, message('appended', 'assistant', [{ type: 'text', text: 'later' }])])), 'hive_task_trace', { task_id: 'child', cursor: mixedFirst.coverage.next_cursor })).toEqual({ ok: false, reason: 'cursor_stale' });
  });

  it('keeps reasoning out of events, refs, cursors, and read errors while reporting reasoning metadata', async () => {
    const sentinel = 'REASONING_SENTINEL';
    const source = [
      message('instruction', 'user', [{ type: 'text', text: 'Go.' }]),
      message('work', 'assistant', [
        { type: 'reasoning', id: `${sentinel}-part`, text: `${sentinel} plaintext`, tokens: 5 },
        { type: 'reasoning', id: `${sentinel}-opaque`, metadata: { encrypted: sentinel } },
        { type: 'text', text: 'visible' },
      ]),
      ...Array.from({ length: 120 }, (_, index) => message(`pad${index}`, 'assistant', [{ type: 'text', text: 'y'.repeat(300) }])),
    ];
    const tools = toolsFor(clientFor(source));
    const { pages, serialized, events } = await indexPages(tools);
    const reads = [await readEvent(tools, events[0].ref), await readEvent(tools, events[1].ref)];
    const forged = [
      await readEvent(tools, token([3, 'n', 'work', `${sentinel}-part`, 'a'.repeat(43)])),
      await readEvent(tools, token([3, 'p', 2, 'a'.repeat(43), 'a'.repeat(43)])),
    ];
    const tokens = [
      ...events.map((event: any) => decodeToken(event.ref)),
      ...pages.flatMap((page) => page.coverage.next_cursor ? [decodeToken(page.coverage.next_cursor)] : []),
    ];

    expect(pages.length).toBeGreaterThan(1);
    expect(events[1]).toMatchObject({ seq: 2, actor: 'assistant', text: 'visible' });
    expect(forged).toEqual([{ ok: false, reason: 'event_not_found' }, { ok: false, reason: 'source_changed' }]);
    expect(pages[0].reasoning).toMatchObject({ availability: 'mixed', parts: 2, opaque_parts: 1 });
    expect(pages[0].source.reasoning_parts).toBe(2);
    expect(JSON.stringify([serialized, reads, tokens, forged])).not.toContain(sentinel);
  });

  it('reauthorizes and applies one runtime-visible target policy to index pages, event reads, and field chunks', async () => {
    const large = 'x'.repeat(9_000);
    for (const [parentID, relationship] of [
      ['parent', 'direct_child'],
      ['other-parent', 'other_session'],
      [null, 'other_session'],
    ] as const) {
      const setup = clientFor([message('m1', 'assistant', [{ type: 'text', text: large }])], { parentID });
      const tools = toolsFor(setup);
      const { pages, events } = await indexPages(tools);
      const read = await readEvent(tools, events[0].ref);
      const { text } = await readField(tools, events[0].ref, 'text', read.event.fields.text);

      expect(pages[0].target).toEqual({ id: 'child', relationship });
      expect(text).toBe(large);
      expect(setup.calls.filter((call) => call.method === 'get')).toHaveLength(3);
      expect(setup.calls.filter((call) => call.method === 'messages')).toHaveLength(3);
    }
  });

  it('returns opaque unavailability for unresolved targets before messages or status reads', async () => {
    const locator = token([2, 0, 0, 1, 1, 'a'.repeat(43)]);
    const cursor = token([3, 'c', 1, 'a'.repeat(43)]);
    const event = token([3, 'n', 'm1', 'p1', 'a'.repeat(43)]);
    const cases = [
      { getResponse: { data: undefined } },
      { getResponse: { error: 'not found' } },
      { getResponse: { data: [] } },
      { getResponse: { data: { id: 'different', parentID: 'parent' } } },
      { getResponse: { data: { id: 'child', parentID: 42 } } },
      { getError: new Error('api unavailable') },
    ];
    for (const options of cases) {
      const setup = clientFor([], options);
      const tools = toolsFor(setup);
      for (const [name, args] of [
        ['hive_task_trace', {}],
        ['hive_task_trace', { cursor }],
        ['hive_task_trace_content', { content_id: locator }],
        ['hive_task_trace_content', { event }],
        ['hive_task_trace_content', { event, field: 'text', offset: 0 }],
      ] as const) {
        expect(await execute(tools, name, { task_id: 'child', ...args })).toEqual({ ok: false, reason: 'unavailable_or_unauthorized' });
      }
      expect(setup.calls.filter((call) => call.method === 'messages')).toHaveLength(0);
      expect(setup.calls.filter((call) => call.method === 'status')).toHaveLength(0);
    }
  });

  it('rejects invalid or mixed selectors and cursors before authorization', async () => {
    const setup = clientFor([message('m1', 'assistant', [
      { type: 'text', text: 'visible' },
      { type: 'tool', tool: 'bash', state: { status: 'completed', input: { command: 'true' }, output: '' } },
    ])]);
    const tools = toolsFor(setup);
    const [textRef, toolRef] = (await indexPages(tools)).events.map((event: any) => event.ref);
    const locator = token([2, 0, 0, 1, 7, 'a'.repeat(43)]);
    const cursor = token([3, 'c', 1, 'a'.repeat(43)]);
    const before = setup.calls.length;

    for (const args of [{}, { content_id: locator, event: textRef }, { field: 'text' }, { content_id: locator, field: 'text' }, { event: textRef, offset: 0 }]) {
      expect(await execute(tools, 'hive_task_trace_content', { task_id: 'child', ...args })).toEqual({ ok: false, reason: 'invalid_selector' });
    }
    expect(await readEvent(tools, 'not-a-ref')).toEqual({ ok: false, reason: 'invalid_event' });
    expect(await execute(tools, 'hive_task_trace_content', { task_id: 'child', event: textRef, field: 'bogus' })).toEqual({ ok: false, reason: 'invalid_field' });
    expect(await execute(tools, 'hive_task_trace', { task_id: 'child', cursor: 'not-a-cursor' })).toEqual({ ok: false, reason: 'invalid_cursor' });
    expect(await execute(tools, 'hive_task_trace', { task_id: 'child', cursor, recovery: true })).toEqual({ ok: false, reason: 'invalid_selector' });
    expect(setup.calls.length).toBe(before);

    expect(await execute(tools, 'hive_task_trace', { task_id: 'child', cursor })).toEqual({ ok: false, reason: 'cursor_stale' });
    expect(await execute(tools, 'hive_task_trace_content', { task_id: 'child', event: textRef, field: 'output' })).toEqual({ ok: false, reason: 'invalid_field' });
    expect(await execute(tools, 'hive_task_trace_content', { task_id: 'child', event: toolRef, field: 'error' })).toEqual({ ok: false, reason: 'field_absent' });
    expect(await execute(tools, 'hive_task_trace_content', { task_id: 'child', event: toolRef, field: 'output' })).toMatchObject({
      ok: true, field: 'output', format: 'text', content: '', offset: 0, next_offset: null, bytes: 0,
    });
  });

  it('projects a confirmed child_session_id for native task calls from state or part metadata only', async () => {
    const provider = { anthropic: { cacheControl: 'ephemeral', trace: 'PROVIDER_METADATA_SECRET' } };
    const source = [message('dispatch', 'assistant', [
      nativeTask('call-running', 'running', { state: { sessionId: 'ses_running', model: { modelID: 'm' } }, part: provider }),
      nativeTask('call-error', 'error', { state: { sessionId: 'ses_error' } }),
      nativeTask('call-mirrored', 'completed', { state: {}, part: { ...provider, sessionId: 'ses_mirrored' } }),
      nativeTask('call-pending', 'pending'),
      { type: 'tool', tool: 'bash', callID: 'call-bash', state: { status: 'completed', input: { command: 'true' }, output: '', metadata: { sessionId: 'ses_not_a_task' } } },
    ], { completed: false })];
    const setup = clientFor(source, {
      sessions: Object.fromEntries(['ses_running', 'ses_error', 'ses_mirrored', 'ses_not_a_task'].map((id) => [id, childRecord(id)])),
    });
    const tools = toolsFor(setup);
    const { serialized, events } = await indexPages(tools);

    expect(events.map((event: any) => [event.call_id, event.child_session_id ?? null])).toEqual([
      ['call-running', 'ses_running'], ['call-error', 'ses_error'], ['call-mirrored', 'ses_mirrored'], ['call-pending', null], ['call-bash', null],
    ]);
    expect(setup.calls.filter((call) => call.method === 'get').map((call) => call.input.path.id).sort())
      .toEqual(['child', 'ses_error', 'ses_mirrored', 'ses_running']);
    const detail = await readEvent(tools, events[0].ref);
    expect(detail.event).toMatchObject({ call_id: 'call-running', status: 'running', child_session_id: 'ses_running' });
    const keys = [...serialized.flatMap((raw) => allKeys(JSON.parse(raw))), ...allKeys(detail)];
    expect(keys).not.toContain('metadata');
    expect(JSON.stringify([serialized, detail])).not.toContain('PROVIDER_METADATA_SECRET');
  });

  it('fails closed for unconfirmed, invalid, and conflicting recorded child identities', async () => {
    const source = [message('dispatch', 'assistant', [
      nativeTask('call-good', 'running', { state: { sessionId: 'ses_good' } }),
      nativeTask('call-foreign', 'running', { state: { sessionId: 'ses_foreign' } }),
      nativeTask('call-missing', 'running', { state: { sessionId: 'ses_missing' } }),
      nativeTask('call-alias', 'running', { state: { sessionId: 'ses_alias' } }),
      nativeTask('call-throws', 'running', { state: { sessionId: 'ses_throws' } }),
      nativeTask('call-spaced', 'running', { state: { sessionId: 'ses spaced' } }),
      nativeTask('call-number', 'running', { state: { sessionId: 42 } }),
      nativeTask('call-long', 'running', { state: { sessionId: `ses_${'x'.repeat(300)}` } }),
      nativeTask('call-conflict', 'running', { state: { sessionId: 'ses_state' }, part: { sessionId: 'ses_part' } }),
      nativeTask('call-half-invalid', 'running', { state: { sessionId: 'ses_valid_half' }, part: { sessionId: '' } }),
    ], { completed: false })];
    const setup = clientFor(source, {
      sessions: {
        ses_good: childRecord('ses_good'),
        ses_foreign: childRecord('ses_foreign', 'another-parent'),
        ses_missing: { error: { name: 'NotFoundError' } },
        ses_alias: childRecord('ses_real'),
        ses_throws: new Error('lookup failed'),
      },
    });
    const { events } = await indexPages(toolsFor(setup));

    expect(events.filter((event: any) => event.child_session_id).map((event: any) => event.child_session_id)).toEqual(['ses_good']);
    expect(setup.calls.filter((call) => call.method === 'get').map((call) => call.input.path.id).sort())
      .toEqual(['child', 'ses_alias', 'ses_foreign', 'ses_good', 'ses_missing', 'ses_throws']);
  });

  it('reauthorizes child disclosure on every read and guards the recorded child identity', async () => {
    const recorded = (state: Record<string, unknown>, part?: Record<string, unknown>) => [message('dispatch', 'assistant', [
      nativeTask('call-a', 'running', { state, ...(part ? { part } : {}) }),
    ], { completed: false })];
    const original = recorded({ sessionId: 'ses_a' }, { openai: { itemId: 'item' } });
    const setup = clientFor(original, {
      sessions: { ses_a: (reads: number) => childRecord('ses_a', reads === 1 ? 'child' : 'elsewhere') },
    });
    const tools = toolsFor(setup);
    const first = (await indexPages(tools)).events[0];
    const detail = await readEvent(tools, first.ref);
    const second = (await indexPages(tools)).events[0];

    expect(first.child_session_id).toBe('ses_a');
    expect(detail.ok).toBe(true);
    expect(detail.event).not.toHaveProperty('child_session_id');
    expect(second).not.toHaveProperty('child_session_id');
    expect(setup.calls.filter((call) => call.method === 'get' && call.input.path.id === 'ses_a')).toHaveLength(3);

    for (const changed of [
      recorded({ sessionId: 'ses_b' }, { openai: { itemId: 'item' } }),
      recorded({ sessionId: 'ses_a' }, { openai: { itemId: 'item' }, sessionId: 'ses_b' }),
      recorded({}, { openai: { itemId: 'item' } }),
    ]) {
      expect(await readEvent(toolsFor(clientFor(changed)), first.ref)).toEqual({ ok: false, reason: 'event_changed' });
    }
  });

  it('checks each distinct child candidate once and only for displayed rows', async () => {
    const parts = Array.from({ length: 300 }, (_, index) => nativeTask(
      `call-${index}`, 'completed', { state: { sessionId: `ses_c${Math.floor(index / 2)}` } },
    ));
    const setup = clientFor([message('dispatch', 'assistant', parts)], {
      sessions: Object.fromEntries(Array.from({ length: 150 }, (_, index) => [`ses_c${index}`, childRecord(`ses_c${index}`)])),
    });
    const raw = await executeRaw(toolsFor(setup), 'hive_task_trace', { task_id: 'child' });
    const page = JSON.parse(raw);
    const shown = page.events.map((event: any) => event.child_session_id);
    const childGets = setup.calls.filter((call) => call.method === 'get' && call.input.path.id !== 'child');

    expect(page.coverage.complete).toBe(false);
    expect(shown.every((id: unknown) => typeof id === 'string')).toBe(true);
    expect(childGets.map((call) => call.input.path.id).sort()).toEqual([...new Set<string>(shown)].sort());
    expect(childGets.length).toBeLessThan(150);
    expect(Buffer.byteLength(raw)).toBe(page.render.bytes);
    expect(page.render.bytes).toBeLessThanOrEqual(24_576);
  });

  it('reads source and status where the target is placed and never treats a missing placement as idle', async () => {
    const source = [message('m1', 'assistant', [{ type: 'text', text: 'Working in a worktree.' }])];
    const placed = clientFor(source, {
      directory: '/worktree',
      statusByDirectory: (directory) => ({ data: directory === '/worktree' ? { child: { type: 'busy' } } : {} }),
    });
    const placedTools = toolsFor(placed);
    const { pages, events } = await indexPages(placedTools);
    await readEvent(placedTools, events[0].ref);

    expect(pages[0].lifecycle).toEqual({ state: 'active', terminal: false, reason: 'runtime_active', runtime: 'busy' });
    for (const method of ['messages', 'status']) {
      expect(placed.calls.filter((call) => call.method === method).map((call) => call.input.query.directory))
        .toEqual(method === 'messages' ? ['/worktree', '/worktree'] : ['/worktree']);
    }
    expect(placed.calls.filter((call) => call.method === 'get').every((call) => call.input.query.directory === '/repo')).toBe(true);

    for (const directory of [undefined, '', 'relative/worktree', 42]) {
      const setup = clientFor(source, { directory, status: {} });
      const tools = toolsFor(setup);
      const page = (await indexPages(tools)).pages[0];
      const recovered = await execute(tools, 'hive_task_trace', { task_id: 'child', recovery: true });

      expect(page.lifecycle).toEqual({ state: 'uncertain', terminal: false, reason: 'placement_unavailable', runtime: 'unavailable' });
      expect(page.context.final).toBeNull();
      expect(recovered.recovery).toMatchObject({ status: 'unavailable', scope: null, failures: [{ stage: 'eligibility', reasons: ['placement_unavailable'] }] });
      expect(setup.calls.filter((call) => call.method === 'status')).toHaveLength(0);
      expect(setup.calls.filter((call) => call.method === 'create')).toHaveLength(0);
    }
  });

  it('keeps an idle runtime with historical open tool records non-terminal and counts them', async () => {
    const setup = clientFor(interruptedTrace(), { status: {} });
    const page = (await indexPages(toolsFor(setup))).pages[0];

    expect(page.lifecycle).toEqual({
      state: 'uncertain',
      terminal: false,
      reason: 'tool_pending_or_running',
      runtime: 'idle',
      unresolved_tools: { latest_message: 0, earlier_messages: 1 },
    });
    expect(page.context.final).toBeNull();
  });
});

describe('task trace semantic recovery', () => {
  it('returns semantic recovery unavailable for active and invalid or unavailable status maps without model sessions', async () => {
    const source = realisticTrace();
    const active = clientFor(source, { status: { child: { type: 'busy' } } });
    const malformed = clientFor(source, { statusResponse: { data: { child: { type: 'idle', unexpected: true } } } });
    const uncertain = clientFor(source, { statusError: new Error('unavailable') });

    for (const [setup, reason] of [
      [active, 'runtime_active'],
      [malformed, 'status_unavailable'],
      [uncertain, 'status_unavailable'],
    ] as const) {
      const result = await execute(toolsFor(setup), 'hive_task_trace', { task_id: 'child', recovery: true });
      expect(result).toMatchObject({ ok: true, version: 2, task_id: 'child' });
      expect(result.source).toMatchObject({ steps: 59, fidelity: 'surviving_source', compactions: 0 });
      expect(result.recovery).toEqual({
        status: 'unavailable',
        scope: null,
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

  it('treats a missing target entry in a valid status map as idle for finished direct-child recovery', async () => {
    const source = [message('finished', 'assistant', [{ type: 'text', text: 'Finished direct-child work.' }])];
    const setup = clientFor(source, { status: {} });
    const result = await execute(toolsFor(setup), 'hive_task_trace', { task_id: 'child', recovery: true });

    expect(result.lifecycle).toEqual({ state: 'terminal', terminal: true, reason: 'idle_and_closed', runtime: 'idle' });
    expect(result.recovery).toMatchObject({ status: 'complete', scope: 'closed_turn' });
    expect(result.semantic).not.toBeNull();
    expect(result.final_response).toEqual({
      step: 1,
      text: 'Finished direct-child work.',
      provenance: 'child_self_report',
      untrusted: true,
    });
    expect(setup.calls.filter((call) => call.method === 'create').length).toBeGreaterThan(0);
  });

  it('returns an inspect-only evidence snapshot when an idle runtime leaves tool or message records open', async () => {
    const openMessage = [
      message('instruction', 'user', [{ type: 'text', text: 'Implement the fix.' }]),
      message('work', 'assistant', [{ type: 'text', text: 'Editing the parser.' }], { completed: false }),
    ];
    for (const [source, reason] of [
      [interruptedTrace(), 'tool_pending_or_running'],
      [openMessage, 'latest_assistant_open'],
    ] as const) {
      const setup = clientFor([...source], {
        status: {},
        prompt: (request) => request.kind === 'reduce'
          ? {
              kind: 'reduce',
              semantic: semanticReduction(request.step_count, {
                completed: [],
                unfinished: [{ claim: 'Finish the fix.', source_steps: [request.step_count] }],
                safest_next_action: { action: 'launch_fresh_task', context: 'Resume the fix.', source_steps: [request.step_count] },
              }),
            }
          : undefined,
      });
      const result = await execute(toolsFor(setup), 'hive_task_trace', { task_id: 'child', recovery: true });

      expect(result.lifecycle).toMatchObject({ state: 'uncertain', terminal: false, reason, runtime: 'idle' });
      expect(result.recovery).toMatchObject({ status: 'complete', scope: 'evidence_only', failures: [] });
      expect(result.final_response).toBeNull();
      expect(result.semantic.untrusted).toBe(true);
      expect(result.semantic.unfinished).toEqual([{ claim: 'Finish the fix.', source_steps: [expect.any(Number)] }]);
      expect(result.semantic.safest_next_action).toMatchObject({ action: 'inspect', context: null });
      for (const call of setup.calls.filter((entry) => ['prompt', 'abort', 'delete'].includes(entry.method))) {
        expect(call.input.path?.id).not.toBe('child');
      }
    }
  });

  it('refuses recovery for active, unknown, self, empty, and other non-evidence lifecycles without model sessions', async () => {
    const cases: Array<[unknown[], Record<string, unknown>, string, string?]> = [
      [interruptedTrace(), { status: { child: { type: 'busy' } } }, 'runtime_active'],
      [interruptedTrace(), { status: { child: { type: 'retry', attempt: 1, message: 'rate limited', next: 2 } } }, 'runtime_active'],
      [interruptedTrace(), { statusError: new Error('unavailable') }, 'status_unavailable'],
      [interruptedTrace(), { status: {} }, 'self_recovery_not_allowed', 'child'],
      [[], { status: {} }, 'empty_trace'],
      [[message('instruction', 'user', [{ type: 'text', text: 'Start.' }])], { status: {} }, 'latest_message_not_assistant'],
    ];
    for (const [source, options, reason, caller] of cases) {
      const setup = clientFor(source, options as any);
      const result = JSON.parse(await executeRaw(toolsFor(setup), 'hive_task_trace', { task_id: 'child', recovery: true }, undefined, caller));

      expect(result.recovery).toMatchObject({ status: 'unavailable', scope: null, failures: [{ stage: 'eligibility', reasons: [reason] }] });
      expect(result.semantic).toBeNull();
      expect(result.lifecycle.terminal).toBe(false);
      expect(setup.calls.filter((call) => call.method === 'create')).toHaveLength(0);
    }
  });

  it('invalidates an evidence-only snapshot when authorization, parent, placement, status, or source changes during summary', async () => {
    const source = interruptedTrace();
    const target = (change: Record<string, unknown> | Error | { error: unknown }) => (reads: number) => (
      reads === 1 ? childRecord('child', 'parent') : change instanceof Error || 'error' in change ? change : { data: { ...childRecord('child', 'parent').data, ...change } }
    );
    // Both reads are other_session for the caller, so only the exact parent comparison can see the move.
    const reparented = (first: string | undefined, second: string) => (reads: number) => (
      { data: { ...childRecord('child').data, parentID: reads === 1 ? first : second } }
    );
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ sessions: { child: target({ error: { name: 'NotFoundError' } }) } }, 'target_unavailable_after_recovery'],
      [{ sessions: { child: target(new Error('lookup failed')) } }, 'target_unavailable_after_recovery'],
      [{ sessions: { child: target({ id: 'renamed' }) } }, 'target_unavailable_after_recovery'],
      [{ sessions: { child: target({ parentID: 'elsewhere' }) } }, 'target_changed_after_recovery'],
      [{ sessions: { child: reparented('foreign-a', 'foreign-b') } }, 'target_changed_after_recovery'],
      [{ sessions: { child: reparented(undefined, 'foreign-a') } }, 'target_changed_after_recovery'],
      [{ sessions: { child: target({ directory: '/moved' }) } }, 'target_changed_after_recovery'],
      [{ mutateStatus: (reads: number) => ({ data: reads === 1 ? {} : { child: { type: 'busy' } } }) }, 'runtime_active_after_recovery'],
      [{ mutateStatus: (reads: number) => (reads === 1 ? { data: {} } : { error: 'unavailable' }) }, 'status_unavailable_after_recovery'],
      [{ status: {}, mutateMessages: (reads: number) => (reads === 1 ? source : [...source, message('newer', 'assistant', [{ type: 'text', text: 'Suite output arrived.' }])]) }, 'source_changed_after_recovery'],
    ];
    for (const [options, reason] of cases) {
      const setup = clientFor(source, { status: {}, ...options } as any);
      const result = await execute(toolsFor(setup), 'hive_task_trace', { task_id: 'child', recovery: true });

      expect(result.recovery).toMatchObject({ status: 'unavailable', scope: null, failures: [{ stage: 'freshness', reasons: [reason] }] });
      expect(result.semantic).toBeNull();
      expect(result.final_response).toBeNull();
      expect(setup.calls.filter((call) => call.method === 'create').length).toBeGreaterThan(0);
    }
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

    expect(forensic.context.final).toBeNull();
    expect(result.final_response).toBeNull();
    expect(result.errors[0].error).toMatchObject({ content_id: expect.any(String), bytes: Buffer.byteLength(JSON.stringify(error)), sha256: expect.any(String) });
    expect(reducer.cards.find((card: any) => card.step === 2).source).toBe('fallback');
    expect(Buffer.byteLength(reducerText)).toBeLessThan(10_000);
    expect(reducerText).not.toContain(errorTail);
    expect(serialized).not.toContain(errorTail);
    expect(result).not.toHaveProperty('content_dictionary');
  });

  it('runs at most four map batches concurrently and folds reverse completion by batch index', async () => {
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

    await settleUntil(() => gates.length === 4);
    expect(active).toBe(4);
    const resolved = new Set<number>();
    while (gates.length < 12) {
      const index = gates.length - 1;
      const expected = gates.length + 1;
      resolved.add(index);
      gates[index].resolve({ kind: 'map', range: requests[index].range, cards: [] });
      await settleUntil(() => gates.length === expected);
      expect(active).toBeLessThanOrEqual(4);
    }
    for (const index of sourceSteps(0, gates.length - 1).reverse()) {
      if (resolved.has(index)) continue;
      gates[index].resolve({ kind: 'map', range: requests[index].range, cards: [] });
      await Promise.resolve();
    }
    const result = await execution;

    expect(peak).toBe(4);
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
    await settleUntil(() => activeSignals.length === 4);
    controller.abort(new Error('cancel active recovery'));

    await expect(execution).rejects.toThrow('cancel active recovery');
    expect(activeSignals.every((signal) => signal.aborted)).toBe(true);
    expect(during.calls.filter((call) => call.method === 'create')).toHaveLength(4);
    expect(during.calls.filter((call) => call.method === 'abort')).toHaveLength(4);
    expect(during.calls.filter((call) => call.method === 'delete')).toHaveLength(4);
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

  it('guards self recovery before model work while allowing self forensic inspection', async () => {
    const setup = clientFor(
      [message('m1', 'assistant', [{ type: 'text', text: 'done' }])],
      { status: { child: { type: 'busy' } } },
    );
    const result = await execute(toolsFor(setup), 'hive_task_trace', { task_id: 'child', recovery: true }, 'child');

    expect(result.target).toEqual({ id: 'child', relationship: 'self' });
    expect(result.recovery).toMatchObject({
      status: 'unavailable',
      failures: [{ stage: 'eligibility', reasons: ['self_recovery_not_allowed'] }],
    });
    expect(setup.calls.filter((call) => call.method === 'create')).toHaveLength(0);
    expect(setup.calls.filter((call) => call.method === 'prompt')).toHaveLength(0);
  });

  it('preserves direct-child fresh-task guidance and forces other sessions to inspect-only', async () => {
    const source = [message('m1', 'assistant', [{ type: 'text', text: 'unfinished work' }])];
    for (const [parentID, relationship, action] of [
      ['parent', 'direct_child', 'launch_fresh_task'],
      ['another-parent', 'other_session', 'inspect'],
      [null, 'other_session', 'inspect'],
    ] as const) {
      const setup = clientFor(source, {
        parentID,
        prompt: (request) => request.kind === 'reduce'
          ? {
              kind: 'reduce',
              semantic: semanticReduction(1, {
                completed: [],
                unfinished: [{ claim: 'Finish the implementation.', source_steps: [1] }],
                safest_next_action: {
                  action: 'launch_fresh_task',
                  context: 'Continue from the recovered state.',
                  source_steps: [1],
                },
              }),
            }
          : undefined,
      });
      const result = await execute(toolsFor(setup), 'hive_task_trace', { task_id: 'child', recovery: true });

      expect(result.target).toEqual({ id: 'child', relationship });
      expect(result.semantic.safest_next_action.action).toBe(action);
      expect(result.semantic.safest_next_action.source_steps).toEqual([1]);
      if (action === 'inspect') expect(result.semantic.safest_next_action.context).toBeNull();
      for (const call of setup.calls.filter((entry) => ['prompt', 'abort', 'delete'].includes(entry.method))) {
        expect(call.input.path?.id).not.toBe('child');
      }
    }
  });

  it('rejects a summarizer session ID collision before prompting or cleanup touches the inspected session', async () => {
    const source = [message('m1', 'assistant', [{ type: 'text', text: 'done' }])];
    const setup = clientFor(source, { create: () => ({ id: 'child' }) });
    const result = await execute(toolsFor(setup), 'hive_task_trace', { task_id: 'child', recovery: true });

    expect(result.recovery).toMatchObject({
      status: 'unavailable',
      failures: [{ stage: 'map', range: [1, 1], reasons: ['summarizer_id_collision'] }],
    });
    expect(result.semantic).toBeNull();
    expect(setup.calls.filter((call) => ['prompt', 'abort', 'delete'].includes(call.method))).toHaveLength(0);
  });

  it('keeps successful recovery when the post-recovery status map omits the idle target', async () => {
    const source = [message('m1', 'assistant', [{ type: 'text', text: 'done' }])];
    const setup = clientFor(source, {
      mutateStatus: (reads) => ({ data: reads === 1 ? { child: { type: 'idle' } } : {} }),
    });
    const result = await execute(toolsFor(setup), 'hive_task_trace', { task_id: 'child', recovery: true });

    expect(result.lifecycle).toEqual({ state: 'terminal', terminal: true, reason: 'idle_and_closed', runtime: 'idle' });
    expect(result.recovery.status).toBe('complete');
    expect(result.semantic).not.toBeNull();
    expect(setup.calls.filter((call) => call.method === 'status')).toHaveLength(2);
  });

  it('discards recovery when source or target status changes during model work', async () => {
    const source = [message('m1', 'assistant', [{ type: 'text', text: 'done' }])];
    const changedSource = clientFor(source, {
      mutateMessages: (reads) => reads === 1
        ? source
        : [message('m1', 'assistant', [{ type: 'text', text: 'done later' }])],
    });
    const becameActive = clientFor(source, {
      mutateStatus: (reads) => ({ data: { child: { type: reads === 1 ? 'idle' : 'busy' } } }),
    });
    const lostStatus = clientFor(source, {
      mutateStatus: (reads) => reads === 1 ? { data: { child: { type: 'idle' } } } : { error: 'unavailable' },
    });

    for (const [setup, reason] of [
      [changedSource, 'source_changed_after_recovery'],
      [becameActive, 'runtime_active_after_recovery'],
      [lostStatus, 'status_unavailable_after_recovery'],
    ] as const) {
      const result = await execute(toolsFor(setup), 'hive_task_trace', { task_id: 'child', recovery: true });
      expect(result.recovery).toMatchObject({
        status: 'unavailable',
        failures: [{ stage: 'freshness', reasons: [reason] }],
      });
      expect(result.semantic).toBeNull();
      expect(setup.calls.filter((call) => call.method === 'create').length).toBeGreaterThan(0);
      expect(setup.calls.filter((call) => call.method === 'messages')).toHaveLength(2);
      expect(setup.calls.filter((call) => call.method === 'status')).toHaveLength(2);
    }
  });

  it('keeps recovery v2 content IDs readable with reauthorization, staleness checks, and UTF-8-safe 8 KiB chunks', async () => {
    const large = `start-${'🙂'.repeat(5000)}-end`;
    const source = [
      message('m1', 'user', [{ type: 'text', text: large }, { type: 'reasoning', text: 'private' }]),
      message('m2', 'assistant', [{ type: 'text', text: 'done' }]),
    ];
    const setup = clientFor(source, {
      mutateMessages: (reads) => reads <= 4 ? source : [message('m1', 'user', [{ type: 'text', text: `${large}changed` }])],
    });
    const tools = toolsFor(setup);
    const recovered = await execute(tools, 'hive_task_trace', { task_id: 'child', recovery: true });
    const contentID = recovered.task_instruction.text.content_id;
    const first = await execute(tools, 'hive_task_trace_content', { task_id: 'child', content_id: contentID });
    const second = await execute(tools, 'hive_task_trace_content', { task_id: 'child', content_id: contentID, offset: first.next_offset });
    const stale = await execute(tools, 'hive_task_trace_content', { task_id: 'child', content_id: contentID });

    expect(first).toMatchObject({ ok: true, version: 2, task_id: 'child', offset: 0, bytes: Buffer.byteLength(large), sha256: expect.any(String) });
    expect(Buffer.byteLength(first.content)).toBeLessThanOrEqual(8192);
    expect(first.content).not.toContain('�');
    expect(second.offset).toBe(first.next_offset);
    expect(second.content).not.toContain('�');
    expect(stale).toEqual({ ok: false, reason: 'stale_or_not_found' });
    expect(setup.calls.filter((call) => call.method === 'messages')).toHaveLength(5);
    expect(setup.calls.filter((call) => call.method === 'get')).toHaveLength(5);

    const decoded = JSON.parse(Buffer.from(contentID, 'base64url').toString('utf8'));
    expect(decoded).toEqual([2, 0, 0, 1, Buffer.byteLength(large), expect.any(String)]);
    const reasoningLocator = Buffer.from(JSON.stringify([2, 0, 1, 7, 7, 'a'.repeat(43)])).toString('base64url');
    expect(await execute(tools, 'hive_task_trace_content', { task_id: 'child', content_id: reasoningLocator })).toEqual({ ok: false, reason: 'invalid_content_id' });
  });
});

describe('task trace lifecycle hints', () => {
  it('describes concrete failure triggers and the paged forensic index', () => {
    const tools = toolsFor(clientFor([]));
    const description = tools.hive_task_trace.description;
    expect(description).toContain('failed');
    expect(description).toContain('blocked');
    expect(description).toContain('timed out');
    expect(description).toContain('cancelled');
    expect(description).toContain('empty');
    expect(description).toContain('unclear');
    expect(description).toContain('paged forensic v3 index');
    expect(description).toContain('cursor');
    expect(description).toContain('read-only');
    expect(tools.hive_task_trace_content.description).toContain('guarded event');
    expect(tools.hive_task_trace_content.description).toContain('v2 content ID');
    expect(description).toContain('visible to the connected runtime');
    expect(description).toContain('finished turn');
  });

  it('adds bounded metadata hints without parsing rendered task output', () => {
    const output = { title: 'task', output: '', metadata: { sessionId: 'child' } };
    appendTaskTraceHint({ tool: 'task' }, output);
    appendTaskTraceHint({ tool: 'task' }, output);
    expect(output.output).toContain('hive_task_trace({ task_id: "child" })');
    expect(output.output).toContain('failed, blocked, timed out');
    expect(output.output).toContain('Read lifecycle, context, and the chronological event index first; follow coverage.next_cursor');
    expect(output.output).toContain('Every returned task result is terminal; launch a fresh child session for follow-up');
    expect(output.output).toContain('Pass task_id only when an explicit operator instruction or an explicit runtime-owned interruption-recovery mechanism authorizes continuation');
    expect(output.output).toContain('otherwise launch fresh');
    expect(output.output).toContain('If the child may still be active or its lifecycle is uncertain');
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
    await injectTaskTraceHint(messages, authorize);
    await injectTaskTraceHint(messages, authorize);
    expect(messages[0].parts.filter((part: any) => part.type === 'text' && part.synthetic)).toHaveLength(1);
    expect(messages[0].parts.at(-1).text).toContain('hive_task_trace({ task_id: "child" })');
    expect(messages[0].parts.at(-1).text).toContain('This task result is empty or terminally unsuccessful');
    expect(messages[0].parts.at(-1).text).toContain('launch a fresh child session for follow-up');
    expect(messages[0].parts.at(-1).text).toContain('otherwise launch fresh');
  });

  it('injects replay hints for hard terminal failures but not running work', async () => {
    const messages: any[] = [{
      info: { id: 'parent-tool', sessionID: 'parent', role: 'assistant' },
      parts: [
        { id: 'failed-task', type: 'tool', tool: 'task', state: { status: 'cancelled' }, metadata: { sessionId: 'failed-child' } },
        { id: 'running-task', type: 'tool', tool: 'task', state: { status: 'running' }, metadata: { sessionId: 'running-child' } },
      ],
    }];
    await injectTaskTraceHint(messages, async (child) => child === 'failed-child');
    expect(messages[0].parts.filter((part: any) => part.hiveTaskTraceHint)).toHaveLength(1);
    expect(messages[0].parts.at(-1).text).toContain('"failed-child"');
  });

  // Mirrors what the runtime transform receives after a host restart: a freshly loaded array per turn
  // whose earlier foreground task calls never recorded a result.
  function interruptedParent(extraParts: Array<Record<string, unknown>> = []) {
    return [
      {
        info: { id: 'dispatch', sessionID: 'parent', role: 'assistant' },
        parts: [
          { id: 'task-a', ...nativeTask('call-a', 'running', { state: { sessionId: 'ses_a' }, part: { anthropic: { cache: 'x' } } }) },
          { id: 'task-b', ...nativeTask('call-b', 'pending', { part: { sessionId: 'ses_b' } }) },
          ...extraParts,
        ],
      },
      { info: { id: 'after-restart', sessionID: 'parent', role: 'user' }, parts: [{ id: 'ask', type: 'text', text: 'What happened?' }] },
    ];
  }

  it('replays in-flight hints for every unresolved foreground call on each fresh message array', async () => {
    const authorized: string[] = [];
    const authorize = async (child: string, parent: string) => {
      authorized.push(child);
      return parent === 'parent';
    };
    for (let turn = 0; turn < 2; turn += 1) {
      const messages: any[] = interruptedParent();
      await injectTaskTraceHint(messages, authorize);
      await injectTaskTraceHint(messages, authorize);
      const hints = messages[0].parts.filter((part: any) => part.hiveTaskTraceHint);

      expect(hints.map((part: any) => part.hiveTaskTraceChild).sort()).toEqual(['ses_a', 'ses_b']);
      for (const hint of hints) {
        expect(hint).toMatchObject({ type: 'text', synthetic: true, sessionID: 'parent', messageID: 'dispatch' });
        expect(hint.text).toContain(`hive_task_trace({ task_id: "${hint.hiveTaskTraceChild}" })`);
        expect(hint.text).toContain('has no recorded result; the child may still be in flight');
        expect(hint.text).toContain('do not send another prompt or launch an overlapping writer');
        expect(hint.text).not.toMatch(/interrupted|killed|stopped/);
      }
      expect(messages[1].parts).toHaveLength(1);
    }
    expect(authorized.sort()).toEqual(['ses_a', 'ses_a', 'ses_b', 'ses_b']);
  });

  it('does not hint a live latest call, background calls, unauthorized children, or a child twice', async () => {
    const live: any[] = [{
      info: { id: 'dispatch', sessionID: 'parent', role: 'assistant' },
      parts: [{ id: 'task-live', ...nativeTask('call-live', 'running', { state: { sessionId: 'ses_live' } }) }],
    }];
    // Native task records `background: true` in state.metadata; every hint branch must honor it.
    const nativeBackground = (callID: string, status: 'running' | 'completed' | 'error', sessionId: string) => {
      const task: any = nativeTask(callID, status, { state: { parentSessionId: 'parent', sessionId, background: true } });
      if (status === 'completed') task.state.output = '';
      return { id: `task-${callID}`, ...task };
    };
    const background: any[] = interruptedParent([
      { id: 'task-bg', ...nativeTask('call-bg', 'running', { state: { sessionId: 'ses_bg' } }, { description: 'bg', prompt: 'p', subagent_type: 'forager-worker', background: true }) },
      nativeBackground('bg-running', 'running', 'ses_bg_running'),
      nativeBackground('bg-error', 'error', 'ses_bg_error'),
      nativeBackground('bg-empty', 'completed', 'ses_bg_empty'),
      { id: 'task-bg-part', ...nativeTask('call-bg-part', 'error', { part: { sessionId: 'ses_bg_part', background: true } }) },
      { id: 'task-dup', ...nativeTask('call-dup', 'running', { state: { sessionId: 'ses_a' } }) },
    ]);
    const asked: string[] = [];
    await injectTaskTraceHint(live, async (child) => { asked.push(child); return true; });
    await injectTaskTraceHint(background, async (child) => { asked.push(child); return child !== 'ses_b'; });

    expect(live[0].parts.filter((part: any) => part.hiveTaskTraceHint)).toHaveLength(0);
    expect(background[0].parts.filter((part: any) => part.hiveTaskTraceHint).map((part: any) => part.hiveTaskTraceChild)).toEqual(['ses_a']);
    expect(asked.sort()).toEqual(['ses_a', 'ses_b']);
  });

  it('bounds replay authorization to the newest eligible children', async () => {
    const messages: any[] = Array.from({ length: 12 }, (_, index) => ({
      info: { id: `dispatch-${index}`, sessionID: 'parent', role: 'assistant' },
      parts: [{ id: `task-${index}`, ...nativeTask(`call-${index}`, 'running', { state: { sessionId: `ses_${index}` } }) }],
    }));
    messages.push({ info: { id: 'later', sessionID: 'parent', role: 'user' }, parts: [{ type: 'text', text: 'next' }] });
    const asked: string[] = [];
    await injectTaskTraceHint(messages, async (child) => { asked.push(child); return true; });

    expect(asked).toEqual(['ses_11', 'ses_10', 'ses_9', 'ses_8', 'ses_7', 'ses_6', 'ses_5', 'ses_4']);
    expect(messages.flatMap((entry) => entry.parts).filter((part: any) => part.hiveTaskTraceHint)).toHaveLength(8);
  });

  it('lets each child\'s newest recorded call decide its hint and spends the cap only on hinted calls', async () => {
    const dispatch = (id: string, parts: unknown[]) => ({ info: { id, sessionID: 'parent', role: 'assistant' }, parts });
    const messages: any[] = [
      dispatch('first', [
        { id: 'redo-old', ...nativeTask('redo-old', 'running', { state: { sessionId: 'ses_redo' } }) },
        { id: 'stuck', ...nativeTask('stuck', 'running', { state: { sessionId: 'ses_stuck' } }) },
      ]),
      // Later results that need no hint must not exhaust the eight lookups before the stuck call.
      ...Array.from({ length: 10 }, (_, index) => dispatch(`settled-${index}`, [
        { id: `settled-${index}`, ...nativeTask(`settled-${index}`, 'completed', { state: { sessionId: `ses_settled_${index}` } }) },
      ])),
      dispatch('continued', [{ id: 'redo-new', ...nativeTask('redo-new', 'completed', { state: { sessionId: 'ses_redo' } }) }]),
      // Within one message the later part is the newer call.
      dispatch('same-message', [
        { id: 'resolved-old', ...nativeTask('resolved-old', 'running', { state: { sessionId: 'ses_resolved' } }) },
        { id: 'resolved-new', ...nativeTask('resolved-new', 'completed', { state: { sessionId: 'ses_resolved' } }) },
        { id: 'reopened-old', ...nativeTask('reopened-old', 'completed', { state: { sessionId: 'ses_reopened' } }) },
        { id: 'reopened-new', ...nativeTask('reopened-new', 'running', { state: { sessionId: 'ses_reopened' } }) },
      ]),
      { info: { id: 'later', sessionID: 'parent', role: 'user' }, parts: [{ type: 'text', text: 'next' }] },
    ];
    const asked: string[] = [];
    await injectTaskTraceHint(messages, async (child) => { asked.push(child); return true; });
    await injectTaskTraceHint(messages, async (child) => { asked.push(child); return true; });
    const hints = messages.flatMap((entry) => entry.parts).filter((part: any) => part.hiveTaskTraceHint);

    expect(hints.map((part: any) => [part.messageID, part.hiveTaskTraceChild])).toEqual([['first', 'ses_stuck'], ['same-message', 'ses_reopened']]);
    expect(asked).toEqual(['ses_reopened', 'ses_stuck']);
  });

  it('keeps the recovery agent name reserved for hidden internal use', () => {
    expect(TASK_TRACE_SUMMARIZER_AGENT).toBe('__hive_task_trace_summarizer');
  });
});
