import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import { spawnSync } from 'node:child_process';
import { createServer } from "net";
import * as http from 'http';
import {
  createOpencodeClient,
  createOpencodeServer,
  type Config as OpencodeConfig,
} from "@opencode-ai/sdk";
import plugin from "../index";
import type { PluginInput } from "@opencode-ai/plugin";

const EXPECTED_TOOLS = [
  "hive_feature_create",
  "hive_plan_write",
  "hive_plan_read",
  "hive_tasks_sync",
  "hive_worktree_start",
  "hive_worktree_create",
  "hive_task_trace",
  "hive_task_trace_content",
] as const;

const RUNTIME_PROVIDER_ID = 'runtime-stub';
const RUNTIME_MODEL_ID = 'runtime-stub-model';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error
    ? error.name === 'AbortError'
    : isRecord(error) && error.name === 'AbortError';
}

async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (typeof address !== "object" || !address) {
        server.close();
        reject(new Error("Failed to get free port"));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

function safeRm(dir: string) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function getOpencodeRuntimeVersion(): string | null {
  const result = spawnSync('opencode', ['--version'], {
    encoding: 'utf8',
  });

  if (result.error || result.status !== 0) return null;

  const version = result.stdout.trim();
  return version || null;
}

const OPENCODE_RUNTIME_VERSION = getOpencodeRuntimeVersion();

function pickHivePluginEntry(): string {
  const distEntry = path.resolve(import.meta.dir, "..", "..", "dist", "index.js");
  if (fs.existsSync(distEntry)) return distEntry;

  const tsEntry = path.resolve(import.meta.dir, "..", "index.ts");
  if (fs.existsSync(tsEntry)) return tsEntry;

  return tsEntry;
}

function extractStringArray(raw: unknown, depth = 0): string[] {
  if (depth > 4) return [];

  if (Array.isArray(raw) && raw.every((v) => typeof v === "string")) return raw;
  if (!isRecord(raw)) return [];

  if ("data" in raw) {
    return extractStringArray(raw.data, depth + 1);
  }

  const knownArrayKeys = ["ids", "tools", "toolIds", "toolIDs"] as const;
  for (const key of knownArrayKeys) {
    const v = raw[key];
    if (Array.isArray(v) && v.every((x) => typeof x === "string")) return v as string[];
  }

  const idsValue = raw.ids;
  if (isRecord(idsValue)) {
    const keys = Object.keys(idsValue);
    if (keys.length > 0 && keys.every((k) => typeof k === "string")) return keys;
  }

  return [];
}

async function waitForTools(
  idsProvider: () => Promise<string[]>,
  expected: readonly string[],
  timeoutMs: number
): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  let lastIds: string[] = [];

  while (Date.now() < deadline) {
    try {
      const ids = await idsProvider();
      lastIds = ids;
      const ok = expected.every((t) => ids.includes(t));
      if (ok) return ids;
    } catch (err) {
      lastError = err;
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  if (lastError) throw lastError;
  return lastIds.length ? lastIds : await idsProvider();
}

type ChatCompletionRequestMessage = {
  role?: unknown;
  tool_call_id?: unknown;
  content?: unknown;
  tool_calls?: unknown;
};

type ChatCompletionRequestBody = {
  model?: unknown;
  stream?: unknown;
  tools?: unknown;
  messages?: unknown;
};

type StubProviderServer = {
  baseUrl: string;
  close: () => Promise<void>;
  getRequestCount: () => number;
  getRequests: () => ChatCompletionRequestBody[];
};

type ShippingLaunchScenario =
  | 'adhoc-blocking'
  | 'adhoc-background'
  | 'feature-blocking'
  | 'feature-background'
  | 'invalid-id';

type ShippingLaunchEvidence = {
  launchId?: string;
  preparedCall?: Record<string, unknown>;
  childRequests: number;
  childToolResult?: unknown;
  taskSchemaProperties?: string[];
  backgroundChildWaiting: boolean;
  backgroundChildReleased: boolean;
};

type ShippingLaunchProviderServer = {
  baseUrl: string;
  close: () => Promise<void>;
  evidence: (scenario: ShippingLaunchScenario) => ShippingLaunchEvidence;
  releaseBackgroundChild: (scenario: ShippingLaunchScenario) => void;
};

function jsonResponse(body: unknown): string {
  return JSON.stringify(body);
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  if (chunks.length === 0) {
    return null;
  }

  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function startStubProviderServer(): Promise<StubProviderServer> {
  const port = await getFreePort();
  let requestCount = 0;
  const requests: ChatCompletionRequestBody[] = [];

  const server = http.createServer(async (req, res) => {
    if (!req.url) {
      res.writeHead(404).end();
      return;
    }

    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(jsonResponse({
        object: 'list',
        data: [{ id: RUNTIME_MODEL_ID, object: 'model' }],
      }));
      return;
    }

    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      requestCount += 1;
      const body = (await readJsonBody(req)) as ChatCompletionRequestBody;
      requests.push(body);
      const messages = Array.isArray((body as { messages?: unknown })?.messages)
        ? ((body as { messages: unknown[] }).messages as ChatCompletionRequestMessage[])
        : [];
      const hasToolResult = messages.some((message) => message.role === 'tool' && typeof message.tool_call_id === 'string');
      const serializedMessages = JSON.stringify(messages);
      const requestsLargeSnapshot = serializedMessages.includes('runtime_large_snapshot');
      const requestsNativeTask = serializedMessages.includes('runtime_native_task');
      const nativeTaskChild = serializedMessages.includes('NATIVE_TASK_CHILD_FINAL_ONLY');

      if (requestsNativeTask) {
        const tools = Array.isArray(body.tools) ? body.tools : [];
        const taskDefinition = tools.find((entry) => (
          isRecord(entry)
          && isRecord(entry.function)
          && entry.function.name === 'task'
        ));
        const taskFunction = isRecord(taskDefinition) && isRecord(taskDefinition.function)
          ? taskDefinition.function
          : undefined;
        const taskParameters = isRecord(taskFunction?.parameters) ? taskFunction.parameters : undefined;
        const taskProperties = isRecord(taskParameters?.properties) ? taskParameters.properties : undefined;
        const preservesBaseTaskFields = ['description', 'prompt', 'subagent_type'].every((field) => (
          isRecord(taskProperties?.[field])
        ));
        const advertisesHiveLaunchID = isRecord(taskProperties?.hive_launch_id)
          && taskProperties.hive_launch_id.type === 'string';

        if (!preservesBaseTaskFields || !advertisesHiveLaunchID) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(jsonResponse({ error: 'task schema does not preserve base fields and advertise hive_launch_id' }));
          return;
        }
      }

      if (body.stream !== true) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(jsonResponse({ error: 'streaming required' }));
        return;
      }

      res.writeHead(200, {
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'content-type': 'text/event-stream',
      });

      if (!hasToolResult && !nativeTaskChild) {
        const toolName = requestsNativeTask
          ? 'task'
          : requestsLargeSnapshot
            ? 'runtime_large_snapshot'
            : 'hive_feature_create';
        const toolArguments = requestsNativeTask
          ? {
              description: 'Runtime task metadata probe',
              prompt: 'NATIVE_TASK_CHILD_FINAL_ONLY: return a short final response without tools.',
              subagent_type: 'scout-researcher',
              background: false,
              hive_launch_id: 'runtime-launch-contract',
              runtime_unknown_probe: 'survives-model-schema-validation',
            }
          : requestsLargeSnapshot
            ? {}
            : { name: 'rt-feature' };
        res.end([
          `data: ${jsonResponse({
            id: 'chatcmpl-runtime-tool',
            object: 'chat.completion.chunk',
            created: 1,
            model: RUNTIME_MODEL_ID,
            choices: [{
              index: 0,
              delta: {
                role: 'assistant',
                tool_calls: [{
                  index: 0,
                   id: requestsNativeTask ? 'call_runtime_native_task' : 'call_runtime_feature_create',
                  type: 'function',
                  function: {
                    name: toolName,
                    arguments: JSON.stringify(toolArguments),
                  },
                }],
              },
              finish_reason: null,
            }],
          })}\n\n`,
          `data: ${jsonResponse({
            id: 'chatcmpl-runtime-tool',
            object: 'chat.completion.chunk',
            created: 1,
            model: RUNTIME_MODEL_ID,
            choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
          })}\n\n`,
          'data: [DONE]\n\n',
        ].join(''));
        return;
      }

      res.end([
        `data: ${jsonResponse({
          id: 'chatcmpl-runtime-final',
          object: 'chat.completion.chunk',
          created: 2,
          model: RUNTIME_MODEL_ID,
          choices: [{
            index: 0,
            delta: {
              role: 'assistant',
              content: 'rt-feature created. Planning mode is active.',
            },
            finish_reason: null,
          }],
        })}\n\n`,
        `data: ${jsonResponse({
          id: 'chatcmpl-runtime-final',
          object: 'chat.completion.chunk',
          created: 2,
          model: RUNTIME_MODEL_ID,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        })}\n\n`,
        'data: [DONE]\n\n',
      ].join(''));
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(jsonResponse({ error: 'not found' }));
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });

  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    getRequestCount: () => requestCount,
    getRequests: () => requests,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}

function toolCallNames(messages: ChatCompletionRequestMessage[]): string[] {
  return messages.flatMap((message) => Array.isArray(message.tool_calls)
    ? message.tool_calls.flatMap((call) => isRecord(call) && isRecord(call.function)
      && typeof call.function.name === 'string' ? [call.function.name] : [])
    : []);
}

function readToolResult(messages: ChatCompletionRequestMessage[], callID: string): unknown {
  const message = [...messages].reverse().find((candidate) => (
    candidate.role === 'tool' && candidate.tool_call_id === callID
  ));
  if (!message) return undefined;
  if (typeof message.content === 'string') {
    try {
      return JSON.parse(message.content);
    } catch {
      return message.content;
    }
  }
  return message.content;
}

function sendStreamingToolCall(
  res: http.ServerResponse,
  callID: string,
  name: string,
  args: Record<string, unknown>,
): void {
  res.end([
    `data: ${jsonResponse({
      id: `chatcmpl-${callID}`,
      object: 'chat.completion.chunk',
      created: 1,
      model: RUNTIME_MODEL_ID,
      choices: [{
        index: 0,
        delta: {
          role: 'assistant',
          tool_calls: [{
            index: 0,
            id: callID,
            type: 'function',
            function: { name, arguments: JSON.stringify(args) },
          }],
        },
        finish_reason: null,
      }],
    })}\n\n`,
    `data: ${jsonResponse({
      id: `chatcmpl-${callID}`,
      object: 'chat.completion.chunk',
      created: 1,
      model: RUNTIME_MODEL_ID,
      choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
    })}\n\n`,
    'data: [DONE]\n\n',
  ].join(''));
}

function sendStreamingFinal(res: http.ServerResponse, content: string): void {
  res.end([
    `data: ${jsonResponse({
      id: 'chatcmpl-shipping-final',
      object: 'chat.completion.chunk',
      created: 2,
      model: RUNTIME_MODEL_ID,
      choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }],
    })}\n\n`,
    `data: ${jsonResponse({
      id: 'chatcmpl-shipping-final',
      object: 'chat.completion.chunk',
      created: 2,
      model: RUNTIME_MODEL_ID,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    })}\n\n`,
    'data: [DONE]\n\n',
  ].join(''));
}

async function startShippingLaunchProviderServer(): Promise<ShippingLaunchProviderServer> {
  const port = await getFreePort();
  const evidenceByScenario = new Map<ShippingLaunchScenario, ShippingLaunchEvidence>();
  const backgroundReleases = new Map<ShippingLaunchScenario, () => void>();
  let activeScenario: Exclude<ShippingLaunchScenario, 'invalid-id'> | undefined;

  const evidence = (scenario: ShippingLaunchScenario): ShippingLaunchEvidence => {
    const existing = evidenceByScenario.get(scenario);
    if (existing) return existing;
    const created: ShippingLaunchEvidence = {
      childRequests: 0,
      backgroundChildWaiting: false,
      backgroundChildReleased: false,
    };
    evidenceByScenario.set(scenario, created);
    return created;
  };

  const server = http.createServer(async (req, res) => {
    if (!req.url) {
      res.writeHead(404).end();
      return;
    }
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(jsonResponse({ object: 'list', data: [{ id: RUNTIME_MODEL_ID, object: 'model' }] }));
      return;
    }
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(jsonResponse({ error: 'not found' }));
      return;
    }

    const body = (await readJsonBody(req)) as ChatCompletionRequestBody;
    const messages = Array.isArray(body.messages) ? body.messages as ChatCompletionRequestMessage[] : [];
    const serialized = JSON.stringify(messages);
    const tools = Array.isArray(body.tools) ? body.tools : [];
    const availableToolNames = tools.flatMap((entry) => isRecord(entry) && isRecord(entry.function)
      && typeof entry.function.name === 'string' ? [entry.function.name] : []);
    const markerScenario = (['adhoc-blocking', 'adhoc-background', 'feature-blocking', 'feature-background', 'invalid-id'] as const)
      .find(candidate => serialized.includes(`SHIPPING_${candidate.toUpperCase().replaceAll('-', '_')}`));
    const scenario = markerScenario ?? (availableToolNames.includes('hive_context_read') ? activeScenario : undefined);
    if (!scenario || body.stream !== true) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(jsonResponse({ error: 'unknown shipping launch scenario or non-streaming request' }));
      return;
    }

    res.writeHead(200, {
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'content-type': 'text/event-stream',
    });
    const scenarioEvidence = evidence(scenario);
    const names = toolCallNames(messages);
    const taskDefinition = tools.find((entry) => isRecord(entry) && isRecord(entry.function)
      && entry.function.name === 'task');
    const taskFunction = isRecord(taskDefinition) && isRecord(taskDefinition.function)
      ? taskDefinition.function
      : undefined;
    const taskParameters = isRecord(taskFunction?.parameters) ? taskFunction.parameters : undefined;
    const taskProperties = isRecord(taskParameters?.properties) ? taskParameters.properties : undefined;
    if (taskProperties) scenarioEvidence.taskSchemaProperties = Object.keys(taskProperties);
    const isChild = scenario !== 'invalid-id'
      && activeScenario === scenario
      && markerScenario === undefined
      && availableToolNames.includes('hive_context_read');

    if (isChild) {
      scenarioEvidence.childRequests += 1;
      if (scenario.endsWith('background') && !scenarioEvidence.backgroundChildReleased) {
        scenarioEvidence.backgroundChildWaiting = true;
        await new Promise<void>((resolve) => backgroundReleases.set(scenario, resolve));
      }
      const childCallID = `call_${scenario}_context_read`;
      if (!names.includes('hive_context_read')) {
        sendStreamingToolCall(res, childCallID, 'hive_context_read', scenario.startsWith('feature')
          ? { feature: `runtime-${scenario}`, view: 'catalog' }
          : { scope: 'project', view: 'catalog' });
        return;
      }
      scenarioEvidence.childToolResult = readToolResult(messages, childCallID);
      activeScenario = undefined;
      sendStreamingFinal(res, `SHIPPING_CHILD_COMPLETE_${scenario}`);
      return;
    }

    if (scenario === 'invalid-id') {
      if (!names.includes('task')) {
        sendStreamingToolCall(res, 'call_invalid_task', 'task', {
          description: 'Invalid prepared launch probe',
          prompt: 'SHIPPING_INVALID_ID child must never spawn.',
          subagent_type: 'forager-worker',
          background: false,
          hive_launch_id: 'shipping-invalid-launch-id',
        });
        return;
      }
      sendStreamingFinal(res, 'SHIPPING_INVALID_ID_REJECTED');
      return;
    }

    const feature = `runtime-${scenario}`;
    const workerMarker = `SHIPPING_WORKER_${scenario.toUpperCase().replaceAll('-', '_')}`;
    if (scenario.startsWith('feature')) {
      if (!names.includes('hive_feature_create')) {
        sendStreamingToolCall(res, `call_${scenario}_feature_create`, 'hive_feature_create', { name: feature });
        return;
      }
      if (!names.includes('hive_plan_write')) {
        sendStreamingToolCall(res, `call_${scenario}_plan_write`, 'hive_plan_write', {
          feature,
          content: `# Runtime launch\n\n## Discovery\n\n**Q: Is this isolated runtime fixture ready?**\nA: Yes.\n\n**Research:** The fixture repository has one committed README and no external dependencies.\n\n## Non-Goals\n\n- No production file changes.\n\n## Ghost Diffs\n\n- Direct child creation was rejected because the launch must come from Hive preparation.\n\n## Tasks\n\n### 1. Runtime Task\n${workerMarker}`,
        });
        return;
      }
      if (!names.includes('hive_plan_approve')) {
        sendStreamingToolCall(res, `call_${scenario}_plan_approve`, 'hive_plan_approve', { feature });
        return;
      }
      if (!names.includes('hive_tasks_sync')) {
        sendStreamingToolCall(res, `call_${scenario}_tasks_sync`, 'hive_tasks_sync', { feature });
        return;
      }
      if (!names.includes('hive_worktree_start')) {
        sendStreamingToolCall(res, `call_${scenario}_prepare`, 'hive_worktree_start', {
          feature,
          task: '01-runtime-task',
        });
        return;
      }
    } else if (!names.includes('hive_adhoc_worktree_create')) {
      sendStreamingToolCall(res, `call_${scenario}_prepare`, 'hive_adhoc_worktree_create', {
        runId: `runtime-${scenario}`,
        workerInstructions: workerMarker,
      });
      return;
    }

    if (!names.includes('task')) {
      const preparation = readToolResult(messages, `call_${scenario}_prepare`);
      if (!isRecord(preparation) || typeof preparation.launchId !== 'string') {
        res.end(`data: ${jsonResponse({ error: 'shipping preparation omitted launchId' })}\n\ndata: [DONE]\n\n`);
        return;
      }
      const callKey = scenario.endsWith('background') ? 'backgroundTaskCall' : 'taskToolCall';
      const preparedCall = isRecord(preparation[callKey]) ? preparation[callKey] : undefined;
      if (!preparedCall) {
        res.end(`data: ${jsonResponse({ error: `shipping preparation omitted ${callKey}` })}\n\ndata: [DONE]\n\n`);
        return;
      }
      const dispatchedCall = {
        ...preparedCall,
        prompt: `CALLER_TAMPERED_${scenario}`,
      };
      scenarioEvidence.launchId = preparation.launchId;
      scenarioEvidence.preparedCall = preparedCall;
      activeScenario = scenario;
      sendStreamingToolCall(res, `call_${scenario}_task`, 'task', dispatchedCall);
      return;
    }

    sendStreamingFinal(res, `SHIPPING_PARENT_COMPLETE_${scenario}`);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });

  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    evidence,
    releaseBackgroundChild: (scenario) => {
      evidence(scenario).backgroundChildReleased = true;
      backgroundReleases.get(scenario)?.();
      backgroundReleases.delete(scenario);
    },
    close: async () => {
      for (const scenario of backgroundReleases.keys()) {
        evidence(scenario).backgroundChildReleased = true;
        backgroundReleases.get(scenario)?.();
      }
      backgroundReleases.clear();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}

describe('e2e: OpenCode runtime capability smoke', () => {
  it.skipIf(OPENCODE_RUNTIME_VERSION === null)('loads Hive tools and validates a synthetic-plugin native task capability', async () => {
    const tmpBase = "/tmp/hive-e2e-runtime";
    safeRm(tmpBase);
    fs.mkdirSync(tmpBase, { recursive: true });

    const projectDir = fs.mkdtempSync(path.join(tmpBase, "project-"));
    fs.mkdirSync(path.join(projectDir, ".opencode", "plugin"), { recursive: true });

    const hivePluginEntry = pickHivePluginEntry();
    const pluginRuntimeEntry = import.meta.resolve('@opencode-ai/plugin');
    const effectRuntimeEntry = import.meta.resolve('effect');
    const pluginFile = path.join(projectDir, ".opencode", "plugin", "hive.ts");
    const correlationFile = path.join(projectDir, 'runtime-task-correlation.json');
    const pluginSource = `import hive from ${JSON.stringify(hivePluginEntry)}
import { tool } from ${JSON.stringify(pluginRuntimeEntry)}
import { Schema } from ${JSON.stringify(effectRuntimeEntry)}
import * as fs from 'node:fs'

const runtimeCorrelatedChildren = new Set<string>()
const runtimeTaskBefore = new Map<string, { callID: string; sessionID: string }>()
const runtimeTaskCorrelationFile = ${JSON.stringify(correlationFile)}

export const HivePlugin = hive
export const ARuntimeLargeSnapshotPlugin = async () => ({
  'tool.definition': async (input: any, output: any) => {
    if (input.toolID !== 'task') return
    if (!output.parameters?.fields) throw new Error('Native task parameters are not an Effect Struct')
    output.parameters = Schema.Struct({
      ...output.parameters.fields,
      hive_launch_id: Schema.String.annotate({ description: 'Prepared Hive launch identity.' }),
    })
  },
  'tool.execute.before': async (input: any, output: any) => {
    if (input.tool !== 'task' || output.args?.hive_launch_id !== 'runtime-launch-contract') return
    if (output.args.runtime_unknown_probe !== 'survives-model-schema-validation') {
      throw new Error('Unadvertised task argument did not reach tool.execute.before')
    }
    if (typeof input.callID !== 'string' || typeof input.sessionID !== 'string') {
      throw new Error('Native task before-hook omitted callID or sessionID')
    }
    runtimeTaskBefore.set(input.callID, { callID: input.callID, sessionID: input.sessionID })
    output.args.prompt += '\\nRUNTIME_BEFORE_HOOK_SAW_LAUNCH_ID'
    delete output.args.hive_launch_id
    delete output.args.runtime_unknown_probe
  },
  event: async ({ event }: any) => {
    if (event.type !== 'message.part.updated') return
    const part = event.properties?.part
    if (part?.tool !== 'task') return
    const callID = part.callID
    const parentSessionID = part.sessionID
    const childSessionID = part.state?.metadata?.sessionId
    if (typeof callID !== 'string' || typeof parentSessionID !== 'string' || typeof childSessionID !== 'string') return
    const before = runtimeTaskBefore.get(callID)
    if (!before) throw new Error('Task-part event has no matching before-hook observation')
    fs.writeFileSync(runtimeTaskCorrelationFile, JSON.stringify({
      before,
      part: { callID, sessionID: parentSessionID },
      metadata: { sessionId: childSessionID },
    }))
    runtimeCorrelatedChildren.add(childSessionID)
  },
  'chat.message': async (input: any, output: any) => {
    const text = output.parts?.find((part: any) => (
      part?.type === 'text' && part.text.includes('NATIVE_TASK_CHILD_FINAL_ONLY')
    ))
    if (!text) return
    if (!runtimeCorrelatedChildren.has(input.sessionID)) {
      throw new Error('Child chat.message ran before parent task metadata correlation')
    }
    text.text += '\\nRUNTIME_CHILD_CORRELATION_SYNC_PREFIX_SEEN'
  },
  tool: {
    runtime_large_snapshot: tool({
      description: 'Return envelope-first oversized snapshot output for runtime truncation verification.',
      args: {},
      async execute() {
        return JSON.stringify({
          provenance: {
            schema: 'hive-review-provenance/v1',
            sourceFingerprint: 'runtime-envelope-source-fingerprint',
          } as any,
          sourceResolution: {
            schema: 'hive-review-source-resolution/v1',
            marker: 'runtime-source-resolution-before-optional-data',
          } as any,
          optionalPatch: 'x'.repeat(70 * 1024),
          tailMarker: 'TAIL_MARKER_SHOULD_BE_TRUNCATED',
        }, null, 2)
      },
    }),
  },
})
export const ZRuntimeModelPlugin = async () => ({
  config: async (config: any) => {
    config.agent ??= {}
    config.agent['scout-researcher'] = {
      ...config.agent['scout-researcher'],
      model: '${RUNTIME_PROVIDER_ID}/${RUNTIME_MODEL_ID}',
    }
  },
})
`;
    fs.writeFileSync(pluginFile, pluginSource);

    const previousCwd = process.cwd();
    const previousHome = process.env.HOME;
    const previousConfigDir = process.env.OPENCODE_CONFIG_DIR;
    const previousDisableDefault = process.env.OPENCODE_DISABLE_DEFAULT_PLUGINS;

    process.chdir(projectDir);
    process.env.HOME = tmpBase;
    process.env.OPENCODE_CONFIG_DIR = path.join(projectDir, ".opencode");
    process.env.OPENCODE_DISABLE_DEFAULT_PLUGINS = "true";

    const providerServer = await startStubProviderServer();
    const port = await getFreePort();

    const config: OpencodeConfig = {
      plugin: [],
      provider: {
        [RUNTIME_PROVIDER_ID]: {
          npm: '@ai-sdk/openai-compatible',
          name: 'Runtime stub provider',
          options: {
            apiKey: 'runtime-stub-key',
            baseURL: providerServer.baseUrl,
          },
          models: {
            [RUNTIME_MODEL_ID]: {
              name: 'Runtime stub model',
              tool_call: true,
            },
          },
        },
      },
    };

    let server: Awaited<ReturnType<typeof createOpencodeServer>> | null = null;
    server = await createOpencodeServer({
      hostname: "127.0.0.1",
      port,
      timeout: 20000,
      config,
    });
    expect(server).not.toBeNull();

    const client = createOpencodeClient({
      baseUrl: server.url,
      responseStyle: "data",
      throwOnError: true,
    });

    const abortController = new AbortController();

    async function approvePermissions(sessionID: string) {
      try {
        const sse = await client.event.subscribe({
          query: { directory: projectDir },
          signal: abortController.signal,
        });

        for await (const evt of sse.stream) {
          if (!evt || typeof evt !== "object") continue;
          const maybeType = (evt as { type?: unknown }).type;
          if (maybeType !== "permission.updated") continue;

          const properties = (evt as { properties?: unknown }).properties;
          if (!isRecord(properties)) continue;
          if (properties.sessionID !== sessionID) continue;

          const permissionID = typeof properties.id === "string" ? properties.id : null;
          if (!permissionID) continue;

          await client.postSessionIdPermissionsPermissionId({
            path: { id: sessionID, permissionID },
            body: { response: "once" },
            query: { directory: projectDir },
          });
        }
      } catch (error) {
        if (isAbortError(error)) {
          return;
        }
        throw error;
      }
    }

    try {
      const runtimeSuccess = {
        serverStarted: true,
        toolsLoaded: false,
        promptCompleted: false,
        promptReachedProvider: false,
      };
      const runtimeEnvironment = {
        opencodeVersion: OPENCODE_RUNTIME_VERSION,
        experimentalBackgroundSubagents: process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS ?? null,
        experimental: process.env.OPENCODE_EXPERIMENTAL ?? null,
      };

      const ids = await waitForTools(
        async () => {
          const raw = (await client.tool.ids({ query: { directory: projectDir } })) as unknown;
          return extractStringArray(raw);
        },
        [...EXPECTED_TOOLS, 'runtime_large_snapshot'],
        15000
      );

      for (const toolName of EXPECTED_TOOLS) {
        expect(ids).toContain(toolName);
      }
      expect(ids).toContain('runtime_large_snapshot');
      runtimeSuccess.toolsLoaded = true;

      const session = (await client.session.create({
        body: { title: "hive runtime e2e" },
        query: { directory: projectDir },
      })) as unknown;

      const sessionID = isRecord(session) && typeof session.id === "string" ? session.id : null;
      expect(sessionID).not.toBeNull();
      if (!sessionID) return;

      const runtimeSession = client.session as unknown as {
        create(input: unknown): Promise<unknown>;
        get(input: unknown): Promise<unknown>;
        messages(input: unknown): Promise<unknown>;
        status?: (input: unknown) => Promise<unknown>;
        delete(input: unknown): Promise<unknown>;
      };
      const probe = await runtimeSession.create({
        body: { title: 'hive task trace runtime probe', parentID: sessionID },
        query: { directory: projectDir },
      });
      const probeID = isRecord(probe) && typeof probe.id === 'string' ? probe.id : null;
      expect(probeID).not.toBeNull();
      if (!probeID) return;
      const probeGet = await runtimeSession.get({ path: { id: probeID }, query: { directory: projectDir } });
      expect(probeGet).toMatchObject({ id: probeID, parentID: sessionID });
      const probeMessages = await runtimeSession.messages({ path: { id: probeID }, query: { directory: projectDir } });
      expect(probeMessages).toEqual([]);
      if (typeof runtimeSession.status === 'function') {
        const probeStatuses = await runtimeSession.status({ query: { directory: projectDir } });
        expect(isRecord(probeStatuses) ? probeStatuses : {}).not.toHaveProperty(probeID);
      } else {
        expect(runtimeSession.status).toBeUndefined();
      }
      expect(await runtimeSession.delete({ path: { id: probeID }, query: { directory: projectDir } })).toBe(true);
      await expect(runtimeSession.get({ path: { id: probeID }, query: { directory: projectDir } })).rejects.toThrow();
      await expect(runtimeSession.messages({ path: { id: probeID }, query: { directory: projectDir } })).rejects.toThrow();

      const permissionTask = approvePermissions(sessionID);

      // Prevent CI hangs: bound the prompt request time.
      const promptAbort = new AbortController();
      const promptTimer = setTimeout(() => promptAbort.abort(), 120000);
      let promptResult: unknown;
      try {
        promptResult = await client.session.prompt({
          path: { id: sessionID },
            query: { directory: projectDir },
            signal: promptAbort.signal,
            body: {
              model: {
                providerID: RUNTIME_PROVIDER_ID,
                modelID: RUNTIME_MODEL_ID,
              },
              system:
                "Call the tool hive_feature_create exactly once with {\"name\":\"rt-feature\"}.",
              tools: {
              hive_feature_create: true,
            },
            parts: [
              {
                type: "text",
                text: "Create a Hive feature named rt-feature.",
              },
            ],
          },
        });
      } finally {
        clearTimeout(promptTimer);
      }

      runtimeSuccess.promptCompleted = true;

      const providerRequests = providerServer.getRequests();
      expect(providerServer.getRequestCount()).toBe(2);
      expect(providerRequests).toHaveLength(2);
      expect(providerRequests[0]).toMatchObject({
        model: RUNTIME_MODEL_ID,
        stream: true,
        tools: expect.arrayContaining([
          expect.objectContaining({
            type: 'function',
            function: expect.objectContaining({
              name: 'hive_feature_create',
            }),
          }),
        ]),
      });

      const firstRequestMessages = Array.isArray(providerRequests[0]?.messages)
        ? (providerRequests[0].messages as ChatCompletionRequestMessage[])
        : [];
      expect(firstRequestMessages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: 'system',
            content: expect.stringMatching(/Call the tool hive_feature_create exactly once/i),
          }),
          expect.objectContaining({
            role: 'user',
            content: 'Create a Hive feature named rt-feature.',
          }),
        ]),
      );

      const secondRequestMessages = Array.isArray(providerRequests[1]?.messages)
        ? (providerRequests[1].messages as ChatCompletionRequestMessage[])
        : [];
      expect(secondRequestMessages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: 'assistant',
            tool_calls: expect.arrayContaining([
              expect.objectContaining({
                id: 'call_runtime_feature_create',
                type: 'function',
                function: expect.objectContaining({
                  name: 'hive_feature_create',
                  arguments: JSON.stringify({ name: 'rt-feature' }),
                }),
              }),
            ]),
          }),
          expect.objectContaining({
            role: 'tool',
            tool_call_id: 'call_runtime_feature_create',
            content: expect.any(String),
          }),
        ]),
      );
      runtimeSuccess.promptReachedProvider = true;

      const promptParts = Array.isArray((promptResult as { parts?: unknown }).parts)
        ? (promptResult as { parts: Array<Record<string, unknown>> }).parts
        : [];
      expect(promptParts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'step-start' }),
          expect.objectContaining({ type: 'step-finish' }),
        ]),
      );
      const stepStartIndex = promptParts.findIndex((part) => part.type === 'step-start');
      const stepFinishIndex = promptParts.findIndex((part) => part.type === 'step-finish');
      expect(stepStartIndex).toBeGreaterThanOrEqual(0);
      expect(stepFinishIndex).toBeGreaterThan(stepStartIndex);
      for (const part of promptParts) {
        expect(typeof part.id).toBe('string');
        expect(typeof part.messageID).toBe('string');
        expect(typeof part.sessionID).toBe('string');
      }

      const largeSession = (await client.session.create({
        body: { title: 'runtime tool-output truncation' },
        query: { directory: projectDir },
      })) as unknown;
      const largeSessionID = isRecord(largeSession) && typeof largeSession.id === 'string'
        ? largeSession.id
        : null;
      expect(largeSessionID).not.toBeNull();
      if (!largeSessionID) return;
      const largePermissionTask = approvePermissions(largeSessionID);
      const largePromptAbort = new AbortController();
      const largePromptTimer = setTimeout(() => largePromptAbort.abort(), 120000);
      try {
        await client.session.prompt({
          path: { id: largeSessionID },
          query: { directory: projectDir },
          signal: largePromptAbort.signal,
          body: {
            model: {
              providerID: RUNTIME_PROVIDER_ID,
              modelID: RUNTIME_MODEL_ID,
            },
            system: 'Call runtime_large_snapshot exactly once with no arguments.',
            tools: { runtime_large_snapshot: true },
            parts: [{ type: 'text', text: 'Run runtime_large_snapshot.' }],
          },
        });
      } finally {
        clearTimeout(largePromptTimer);
      }
      const truncationRequests = providerServer.getRequests();
      expect(providerServer.getRequestCount()).toBe(4);
      expect(truncationRequests).toHaveLength(4);
      const truncationMessages = Array.isArray(truncationRequests[3]?.messages)
        ? truncationRequests[3].messages as ChatCompletionRequestMessage[]
        : [];
      const truncatedToolMessage = truncationMessages.find((message) => (
        message.role === 'tool'
        && message.tool_call_id === 'call_runtime_feature_create'
      ));
      expect(typeof truncatedToolMessage?.content).toBe('string');
      const truncatedContent = String(truncatedToolMessage?.content ?? '');
      expect(Buffer.byteLength(truncatedContent, 'utf8')).toBeLessThan(55 * 1024);
      expect(truncatedContent).toContain('hive-review-provenance/v1');
      expect(truncatedContent).toContain('runtime-envelope-source-fingerprint');
      expect(truncatedContent).toContain('runtime-source-resolution-before-optional-data');
      expect(truncatedContent).toContain('truncated');
      expect(truncatedContent).not.toContain('TAIL_MARKER_SHOULD_BE_TRUNCATED');

      const taskParent = (await runtimeSession.create({
        body: { title: 'runtime native task metadata' },
        query: { directory: projectDir },
      })) as unknown;
      const taskParentID = isRecord(taskParent) && typeof taskParent.id === 'string'
        ? taskParent.id
        : null;
      expect(taskParentID).not.toBeNull();
      if (!taskParentID) return;
      const decoy = (await runtimeSession.create({
        body: { title: 'same-parent decoy', parentID: taskParentID },
        query: { directory: projectDir },
      })) as unknown;
      const decoyID = isRecord(decoy) && typeof decoy.id === 'string' ? decoy.id : null;
      expect(decoyID).not.toBeNull();
      const taskPermissionTask = approvePermissions(taskParentID);
      const taskPromptAbort = new AbortController();
      const taskPromptTimer = setTimeout(() => taskPromptAbort.abort(), 120000);
      try {
        await client.session.prompt({
          path: { id: taskParentID },
          query: { directory: projectDir },
          signal: taskPromptAbort.signal,
          body: {
            model: {
              providerID: RUNTIME_PROVIDER_ID,
              modelID: RUNTIME_MODEL_ID,
            },
            system: 'Call runtime_native_task by invoking task exactly once.',
            tools: { task: true },
            parts: [{ type: 'text', text: 'Run runtime_native_task now.' }],
          },
        });
      } finally {
        clearTimeout(taskPromptTimer);
      }
      const taskMessages = await runtimeSession.messages({
        path: { id: taskParentID },
        query: { directory: projectDir },
      });
      const taskParts = Array.isArray(taskMessages)
        ? taskMessages.flatMap((entry) => isRecord(entry) && Array.isArray(entry.parts) ? entry.parts : [])
        : [];
      const nativeTaskPart = taskParts.find((part) => isRecord(part) && part.type === 'tool' && part.tool === 'task');
      const nativeTaskState = isRecord(nativeTaskPart) && isRecord(nativeTaskPart.state)
        ? nativeTaskPart.state
        : undefined;
      const nativeTaskMetadata = isRecord(nativeTaskState?.metadata)
        ? nativeTaskState.metadata
        : undefined;
      const nativeTaskChildID = typeof nativeTaskMetadata?.sessionId === 'string'
        ? nativeTaskMetadata.sessionId
        : null;
      expect(nativeTaskState?.error).toBeUndefined();
      expect(nativeTaskState?.status).toBe('completed');
      expect(nativeTaskChildID).not.toBeNull();
      expect(nativeTaskChildID).not.toBe(decoyID);
      expect(isRecord(nativeTaskState?.input)).toBe(true);
      if (!isRecord(nativeTaskState?.input)) {
        throw new Error('Completed native task state omitted its input record');
      }
      const nativeTaskInput = nativeTaskState.input;
      expect(nativeTaskInput.subagent_type).toBe('scout-researcher');
      expect(nativeTaskInput.background).toBe(false);
      expect(nativeTaskInput.prompt).toEqual(expect.stringContaining('NATIVE_TASK_CHILD_FINAL_ONLY'));
      expect(nativeTaskInput.prompt).toEqual(expect.stringContaining('RUNTIME_BEFORE_HOOK_SAW_LAUNCH_ID'));
      expect(nativeTaskInput).not.toHaveProperty('hive_launch_id');
      expect(nativeTaskInput).not.toHaveProperty('runtime_unknown_probe');
      if (nativeTaskChildID) {
        expect(await runtimeSession.get({
          path: { id: nativeTaskChildID },
          query: { directory: projectDir },
        })).toMatchObject({ id: nativeTaskChildID, parentID: taskParentID });
      }

      const nativeTaskRequests = providerServer.getRequests().filter((request) => (
        JSON.stringify(request.messages).includes('runtime_native_task')
        || JSON.stringify(request.messages).includes('NATIVE_TASK_CHILD_FINAL_ONLY')
      ));
      const parentTaskRequest = nativeTaskRequests.find((request) => (
        JSON.stringify(request.messages).includes('runtime_native_task')
      ));
      const taskDefinitions = Array.isArray(parentTaskRequest?.tools) ? parentTaskRequest.tools : [];
      const taskDefinition = taskDefinitions.find((entry) => (
        isRecord(entry)
        && isRecord(entry.function)
        && entry.function.name === 'task'
      ));
      const taskFunction = isRecord(taskDefinition) && isRecord(taskDefinition.function)
        ? taskDefinition.function
        : undefined;
      const taskParameters = isRecord(taskFunction?.parameters) ? taskFunction.parameters : undefined;
      const taskProperties = isRecord(taskParameters?.properties) ? taskParameters.properties : undefined;
      expect(taskProperties?.description).toBeDefined();
      expect(taskProperties?.prompt).toBeDefined();
      expect(taskProperties?.subagent_type).toBeDefined();
      expect(taskProperties?.hive_launch_id).toMatchObject({ type: 'string' });

      expect(fs.existsSync(correlationFile)).toBe(true);
      const correlation = JSON.parse(fs.readFileSync(correlationFile, 'utf8')) as unknown;
      expect(isRecord(correlation)).toBe(true);
      const correlationBefore = isRecord(correlation) && isRecord(correlation.before)
        ? correlation.before
        : undefined;
      const correlationPart = isRecord(correlation) && isRecord(correlation.part)
        ? correlation.part
        : undefined;
      const correlationMetadata = isRecord(correlation) && isRecord(correlation.metadata)
        ? correlation.metadata
        : undefined;
      expect(correlationBefore?.sessionID).toBe(taskParentID);
      expect(correlationPart?.sessionID).toBe(taskParentID);
      expect(correlationBefore?.callID).toBe(correlationPart?.callID);
      expect(correlationPart?.callID).toBe(isRecord(nativeTaskPart) ? nativeTaskPart.callID : undefined);
      expect(correlationMetadata?.sessionId).toBe(nativeTaskChildID);
      expect(isRecord(nativeTaskPart) ? nativeTaskPart.sessionID : undefined).toBe(taskParentID);

      const childTaskRequest = nativeTaskRequests.find((request) => (
        JSON.stringify(request.messages).includes('RUNTIME_CHILD_CORRELATION_SYNC_PREFIX_SEEN')
      ));
      const childTaskMessages = JSON.stringify(childTaskRequest?.messages);
      expect(childTaskMessages).toContain('RUNTIME_BEFORE_HOOK_SAW_LAUNCH_ID');
      expect(childTaskMessages).toContain('RUNTIME_CHILD_CORRELATION_SYNC_PREFIX_SEEN');
      console.info(JSON.stringify({
        probe: 'synthetic-plugin native task capability',
        ...runtimeEnvironment,
        observedNativeTaskWaitMode: 'blocking',
        productionHiveSelectorExercised: false,
      }));

      abortController.abort();
      await permissionTask.catch(() => undefined);
      await largePermissionTask.catch(() => undefined);
      await taskPermissionTask.catch(() => undefined);

      expect(runtimeSuccess).toEqual({
        serverStarted: true,
        toolsLoaded: true,
        promptCompleted: true,
        promptReachedProvider: true,
      });
    } finally {
      abortController.abort();
      await server?.close();
      await providerServer.close();
      process.chdir(previousCwd);

      if (previousConfigDir === undefined) {
        delete process.env.OPENCODE_CONFIG_DIR;
      } else {
        process.env.OPENCODE_CONFIG_DIR = previousConfigDir;
      }

      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }

      if (previousDisableDefault === undefined) {
        delete process.env.OPENCODE_DISABLE_DEFAULT_PLUGINS;
      } else {
        process.env.OPENCODE_DISABLE_DEFAULT_PLUGINS = previousDisableDefault;
      }

      safeRm(tmpBase);
    }
  }, 150000);

  it.skipIf(OPENCODE_RUNTIME_VERSION === null)('binds shipping Hive preparations to real blocking and background Forager children', async () => {
    const tmpBase = `/tmp/hive-e2e-runtime-shipping-${process.pid}`;
    safeRm(tmpBase);
    fs.mkdirSync(tmpBase, { recursive: true });
    const projectDir = fs.mkdtempSync(path.join(tmpBase, 'project-'));
    fs.mkdirSync(path.join(projectDir, '.opencode', 'plugin'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, '.gitignore'), '.hive/\n');
    fs.writeFileSync(path.join(projectDir, 'README.md'), 'shipping runtime fixture\n');
    for (const args of [
      ['init', '-b', 'main'],
      ['config', 'user.email', 'runtime@example.com'],
      ['config', 'user.name', 'Runtime Test'],
      ['add', '.gitignore', 'README.md'],
      ['commit', '-m', 'test: initialize runtime fixture'],
    ]) {
      const result = spawnSync('git', args, { cwd: projectDir, encoding: 'utf8' });
      if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
    }

    const hivePluginEntry = pickHivePluginEntry();
    const pluginFile = path.join(projectDir, '.opencode', 'plugin', 'hive.ts');
    fs.writeFileSync(pluginFile, `import hive from ${JSON.stringify(hivePluginEntry)}

export const HivePlugin = hive
export const ZRuntimeModelPlugin = async () => ({
  config: async (config: any) => {
    config.agent ??= {}
    for (const agent of ['hive-builder', 'forager-worker']) {
      config.agent[agent] = {
        ...config.agent[agent],
        model: '${RUNTIME_PROVIDER_ID}/${RUNTIME_MODEL_ID}',
      }
    }
  },
})
`);

    const previousCwd = process.cwd();
    const previousHome = process.env.HOME;
    const previousConfigDir = process.env.OPENCODE_CONFIG_DIR;
    const previousDisableDefault = process.env.OPENCODE_DISABLE_DEFAULT_PLUGINS;
    const previousBackground = process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS;
    process.chdir(projectDir);
    process.env.HOME = tmpBase;
    process.env.OPENCODE_CONFIG_DIR = path.join(projectDir, '.opencode');
    process.env.OPENCODE_DISABLE_DEFAULT_PLUGINS = 'true';
    process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS = '1';

    const providerServer = await startShippingLaunchProviderServer();
    const port = await getFreePort();
    const config: OpencodeConfig = {
      plugin: [],
      provider: {
        [RUNTIME_PROVIDER_ID]: {
          npm: '@ai-sdk/openai-compatible',
          name: 'Shipping launch runtime stub provider',
          options: { apiKey: 'runtime-stub-key', baseURL: providerServer.baseUrl },
          models: { [RUNTIME_MODEL_ID]: { name: 'Runtime stub model', tool_call: true } },
        },
      },
    };
    let server: Awaited<ReturnType<typeof createOpencodeServer>> | null = null;
    const eventAbort = new AbortController();

    try {
      server = await createOpencodeServer({ hostname: '127.0.0.1', port, timeout: 20000, config });
      const client = createOpencodeClient({ baseUrl: server.url, responseStyle: 'data', throwOnError: true });
      const runtimeSession = client.session as unknown as {
        create(input: unknown): Promise<unknown>;
        get(input: unknown): Promise<unknown>;
        messages(input: unknown): Promise<unknown>;
        status(input: unknown): Promise<unknown>;
      };
      const permissionTask = (async () => {
        try {
          const sse = await client.event.subscribe({
            query: { directory: projectDir },
            signal: eventAbort.signal,
          });
          for await (const evt of sse.stream) {
            if (!isRecord(evt) || evt.type !== 'permission.updated' || !isRecord(evt.properties)) continue;
            const sessionID = typeof evt.properties.sessionID === 'string' ? evt.properties.sessionID : undefined;
            const permissionID = typeof evt.properties.id === 'string' ? evt.properties.id : undefined;
            if (!sessionID || !permissionID) continue;
            await client.postSessionIdPermissionsPermissionId({
              path: { id: sessionID, permissionID },
              body: { response: 'once' },
              query: { directory: projectDir },
            });
          }
        } catch (error) {
          if (!isAbortError(error)) throw error;
        }
      })();

      const waitFor = async (predicate: () => boolean | Promise<boolean>, label: string, timeoutMs = 15000): Promise<void> => {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          if (await predicate()) return;
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        throw new Error(`Timed out waiting for ${label}`);
      };
      const scenarioTools = (scenario: ShippingLaunchScenario): Record<string, boolean> => scenario.startsWith('adhoc')
        ? { hive_adhoc_worktree_create: true, task: true }
        : scenario.startsWith('feature')
          ? {
              hive_feature_create: true,
              hive_plan_write: true,
              hive_plan_approve: true,
              hive_tasks_sync: true,
              hive_worktree_start: true,
              task: true,
            }
          : { task: true };
      const runScenario = async (scenario: ShippingLaunchScenario): Promise<{
        parentID: string;
        childID?: string;
        taskPart: Record<string, unknown>;
        taskState: Record<string, unknown>;
      }> => {
        const marker = `SHIPPING_${scenario.toUpperCase().replaceAll('-', '_')}`;
        const parent = await runtimeSession.create({
          body: { title: `shipping ${scenario}` },
          query: { directory: projectDir },
        });
        const parentID = isRecord(parent) && typeof parent.id === 'string' ? parent.id : undefined;
        if (!parentID) throw new Error(`Runtime omitted parent session ID for ${scenario}`);
        const promptAbort = new AbortController();
        const promptTimer = setTimeout(() => promptAbort.abort(), 120000);
        const emergencyRelease = scenario.endsWith('background')
          ? setTimeout(() => providerServer.releaseBackgroundChild(scenario), 30000)
          : undefined;
        try {
          await client.session.prompt({
            path: { id: parentID },
            query: { directory: projectDir },
            signal: promptAbort.signal,
            body: {
              agent: 'hive-builder',
              model: { providerID: RUNTIME_PROVIDER_ID, modelID: RUNTIME_MODEL_ID },
              system: `Execute ${marker} exactly as directed by the provider.`,
              tools: scenarioTools(scenario),
              parts: [{ type: 'text', text: marker }],
            } as any,
          });
        } finally {
          clearTimeout(promptTimer);
          if (emergencyRelease) clearTimeout(emergencyRelease);
        }

        const parentMessages = await runtimeSession.messages({
          path: { id: parentID },
          query: { directory: projectDir },
        });
        const parts = Array.isArray(parentMessages)
          ? parentMessages.flatMap(message => isRecord(message) && Array.isArray(message.parts) ? message.parts : [])
          : [];
        const taskPart = [...parts].reverse().find(part => isRecord(part) && part.type === 'tool' && part.tool === 'task');
        if (!isRecord(taskPart) || !isRecord(taskPart.state)) {
          const toolStates = parts.filter(part => isRecord(part) && part.type === 'tool').map(part => ({
            tool: (part as Record<string, unknown>).tool,
            state: (part as Record<string, unknown>).state,
          }));
          throw new Error(`Runtime omitted task tool state for ${scenario}: ${JSON.stringify(toolStates)}`);
        }
        const taskState = taskPart.state;
        const metadata = isRecord(taskState.metadata) ? taskState.metadata : undefined;
        return {
          parentID,
          childID: typeof metadata?.sessionId === 'string' ? metadata.sessionId : undefined,
          taskPart,
          taskState,
        };
      };

      for (const scenario of ['adhoc-blocking', 'feature-blocking', 'adhoc-background', 'feature-background'] as const) {
        const result = await runScenario(scenario);
        const scenarioEvidence = providerServer.evidence(scenario);
        expect(scenarioEvidence.taskSchemaProperties).toEqual(expect.arrayContaining([
          'description', 'prompt', 'subagent_type', 'hive_launch_id',
        ]));
        expect(scenarioEvidence.launchId).toEqual(expect.any(String));
        expect(result.taskPart.sessionID).toBe(result.parentID);
        expect(result.taskPart.callID).toBe(`call_${scenario}_task`);
        if (result.taskState.status !== 'completed') {
          throw new Error(`${scenario} native task failed: ${JSON.stringify(result.taskState)}`);
        }
        expect(result.taskState.status).toBe('completed');
        expect(result.childID).toEqual(expect.any(String));
        expect(isRecord(result.taskState.input)).toBe(true);
        if (!isRecord(result.taskState.input) || !result.childID) throw new Error(`Incomplete task state for ${scenario}`);
        const nativeInput = result.taskState.input;
        expect(nativeInput.description).toBe(scenarioEvidence.preparedCall?.description);
        expect(nativeInput.subagent_type).toBe(scenarioEvidence.preparedCall?.subagent_type);
        expect(nativeInput.background).toBe(scenarioEvidence.preparedCall?.background);
        if (scenario.endsWith('background')) expect(nativeInput.background).toBe(true);
        expect(nativeInput).not.toHaveProperty('hive_launch_id');
        expect(String(nativeInput.prompt)).not.toContain(`CALLER_TAMPERED_${scenario}`);
        if (scenario.startsWith('adhoc')) {
          expect(nativeInput.prompt).toBe(scenarioEvidence.preparedCall?.prompt);
          expect(String(nativeInput.prompt).match(/You are an ad-hoc implementation worker\./g)).toHaveLength(1);
          expect(String(nativeInput.prompt).match(new RegExp(`SHIPPING_WORKER_${scenario.toUpperCase().replaceAll('-', '_')}`, 'g'))).toHaveLength(1);
        } else {
          expect(String(nativeInput.prompt)).toContain('# Hive Worker Assignment');
          expect(String(nativeInput.prompt)).toContain(`| Feature | runtime-${scenario} |`);
          expect(String(nativeInput.prompt)).toContain('| Task | 01-runtime-task |');
        }
        expect(await runtimeSession.get({
          path: { id: result.childID },
          query: { directory: projectDir },
        })).toMatchObject({ id: result.childID, parentID: result.parentID });

        if (scenario.endsWith('background')) {
          expect(scenarioEvidence.backgroundChildWaiting).toBe(true);
          expect(scenarioEvidence.backgroundChildReleased).toBe(false);
          const beforeRelease = await runtimeSession.messages({
            path: { id: result.childID },
            query: { directory: projectDir },
          });
          expect(Array.isArray(beforeRelease) && beforeRelease.some(message => isRecord(message)
            && isRecord(message.info) && message.info.role === 'assistant'
            && isRecord(message.info.time) && typeof message.info.time.completed === 'number')).toBe(false);
          providerServer.releaseBackgroundChild(scenario);
        }

        await waitFor(async () => {
          const childMessages = await runtimeSession.messages({
            path: { id: result.childID! },
            query: { directory: projectDir },
          });
          return Array.isArray(childMessages) && childMessages.some(message => isRecord(message)
            && isRecord(message.info) && message.info.role === 'assistant'
            && isRecord(message.info.time) && typeof message.info.time.completed === 'number');
        }, `${scenario} child completion`, 30000);
        await waitFor(() => scenarioEvidence.childToolResult !== undefined, `${scenario} governed tool result`);
        const childToolResult = scenarioEvidence.childToolResult;
        expect(isRecord(childToolResult) ? childToolResult.success : undefined).toBe(true);
        expect(scenarioEvidence.childRequests).toBeGreaterThanOrEqual(2);

        const sessions = JSON.parse(fs.readFileSync(path.join(projectDir, '.hive', 'sessions.json'), 'utf8')) as {
          sessions: Array<Record<string, unknown>>;
        };
        const bound = sessions.sessions.find(session => session.sessionId === result.childID);
        expect(bound).toMatchObject({ parentSessionId: result.parentID, sessionKind: 'task-worker' });
        if (scenario.startsWith('adhoc')) {
          expect(bound?.adHocRunId).toBe(`runtime-${scenario}`);
        } else {
          expect(bound?.featureName).toBe(`runtime-${scenario}`);
          expect(bound?.workerAssignment).toMatchObject({
            featureName: `runtime-${scenario}`,
            taskFolder: '01-runtime-task',
          });
        }
      }

      const sessionsBeforeInvalid = JSON.parse(fs.readFileSync(path.join(projectDir, '.hive', 'sessions.json'), 'utf8')).sessions.length;
      const invalid = await runScenario('invalid-id');
      expect(invalid.childID).toBeUndefined();
      expect(invalid.taskState.status).toBe('error');
      expect(JSON.stringify(invalid.taskState.error)).toContain('launch_binding_error');
      expect(providerServer.evidence('invalid-id').childRequests).toBe(0);
      const sessionsAfterInvalid = JSON.parse(fs.readFileSync(path.join(projectDir, '.hive', 'sessions.json'), 'utf8')).sessions.length;
      expect(sessionsAfterInvalid).toBe(sessionsBeforeInvalid + 1);

      eventAbort.abort();
      await permissionTask.catch(() => undefined);
      console.info(JSON.stringify({
        probe: 'shipping Hive prepared-worker launch lifecycle',
        opencodeVersion: OPENCODE_RUNTIME_VERSION,
        modes: ['adhoc-blocking', 'feature-blocking', 'adhoc-background', 'feature-background'],
        invalidIdRejectedBeforeChild: true,
      }));
    } finally {
      eventAbort.abort();
      await providerServer.close();
      await server?.close();
      process.chdir(previousCwd);
      if (previousConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR;
      else process.env.OPENCODE_CONFIG_DIR = previousConfigDir;
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousDisableDefault === undefined) delete process.env.OPENCODE_DISABLE_DEFAULT_PLUGINS;
      else process.env.OPENCODE_DISABLE_DEFAULT_PLUGINS = previousDisableDefault;
      if (previousBackground === undefined) delete process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS;
      else process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS = previousBackground;
      safeRm(tmpBase);
    }
  }, 300000);
});

const TEST_ROOT_BASE_LOOP = "/tmp/hive-e2e-loop-mitigation";

function createStubShellForLoop(): PluginInput["$"] {
  const fn = ((..._args: unknown[]) => {
    throw new Error("shell not available in this test");
  }) as unknown as PluginInput["$"];
  return Object.assign(fn, {
    braces(pattern: string) { return [pattern]; },
    escape(input: string) { return input; },
    env() { return fn; },
    cwd() { return fn; },
    nothrow() { return fn; },
    throws() { return fn; },
  });
}

describe("e2e: Forager compaction loop mitigation (in-process)", () => {
  let testRoot: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    originalHome = process.env.HOME;
    fs.rmSync(TEST_ROOT_BASE_LOOP, { recursive: true, force: true });
    fs.mkdirSync(TEST_ROOT_BASE_LOOP, { recursive: true });
    testRoot = fs.mkdtempSync(path.join(TEST_ROOT_BASE_LOOP, "project-"));
    process.env.HOME = testRoot;
  });

  afterEach(() => {
    fs.rmSync(TEST_ROOT_BASE_LOOP, { recursive: true, force: true });
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
  });

  it("runtime contract excludes unsupported compaction hooks", async () => {
    const { createOpencodeClient: mkClient } = await import("@opencode-ai/sdk");
    const OPENCODE_CLIENT = mkClient({ baseUrl: "http://localhost:1" }) as unknown as PluginInput["client"];

    const ctx: PluginInput = {
      directory: testRoot,
      worktree: testRoot,
      serverUrl: new URL("http://localhost:1"),
      project: { id: "test", worktree: testRoot, time: { created: Date.now() } },
      client: OPENCODE_CLIENT,
      $: createStubShellForLoop(),
    };
    const hooks = await plugin(ctx);

    expect(hooks["experimental.session.compacting" as keyof typeof hooks]).toBeUndefined();
  });

  it("does not expose the removed projected-todo field in hive_status", async () => {
    const { createOpencodeClient: mkClient } = await import("@opencode-ai/sdk");
    const OPENCODE_CLIENT = mkClient({ baseUrl: "http://localhost:1" }) as unknown as PluginInput["client"];

    const ctx: PluginInput = {
      directory: testRoot,
      worktree: testRoot,
      serverUrl: new URL("http://localhost:1"),
      project: { id: "test", worktree: testRoot, time: { created: Date.now() } },
      client: OPENCODE_CLIENT,
      $: createStubShellForLoop(),
    };

    const hooks = await plugin(ctx);
    const toolContext = { sessionID: "sess_todo_projection_runtime", messageID: "msg_test", agent: "hive-master", abort: new AbortController().signal };

    await hooks.tool!.hive_feature_create.execute({ name: "runtime-todo-feature" }, toolContext);

    const statusRaw = await hooks.tool!.hive_status.execute(
      { feature: "runtime-todo-feature" },
      toolContext,
    );
    const status = JSON.parse(statusRaw as string) as Record<string, unknown>;

    expect(status).not.toHaveProperty(['todo', 'Projection'].join(''));
  });

  it("compacted forager flow reaches commit-capable step without hive_status stall", async () => {
    const { execSync } = await import("child_process");
    const { createOpencodeClient: mkClient } = await import("@opencode-ai/sdk");
    const OPENCODE_CLIENT = mkClient({ baseUrl: "http://localhost:1" }) as unknown as PluginInput["client"];

    execSync("git init", { cwd: testRoot });
    execSync('git config user.email "test@example.com"', { cwd: testRoot });
    execSync('git config user.name "Test"', { cwd: testRoot });
    fs.writeFileSync(path.join(testRoot, "README.md"), "test");
    fs.writeFileSync(path.join(testRoot, '.gitignore'), '.hive/\n');
    execSync("git add README.md .gitignore", { cwd: testRoot });
    execSync('git commit -m "init"', { cwd: testRoot });

    const ctx: PluginInput = {
      directory: testRoot,
      worktree: testRoot,
      serverUrl: new URL("http://localhost:1"),
      project: { id: "test", worktree: testRoot, time: { created: Date.now() } },
      client: OPENCODE_CLIENT,
      $: createStubShellForLoop(),
    };
    const hooks = await plugin(ctx);
    const toolContext = { sessionID: "sess_compaction_loop", messageID: "msg_test", agent: "forager-worker", abort: new AbortController().signal };

    await hooks.tool!.hive_feature_create.execute({ name: "compaction-test-feature" }, toolContext);

    const plan = `# Compaction Test Feature

## Discovery

**Q: Is this a test?**
A: Yes, this is a regression test for the compaction loop mitigation. Validates that after a compaction event, the Forager worker can resume its task without calling hive_status or re-reading the codebase.

## Tasks

### 1. Compaction Task
Test compaction resume flow.
`;
    await hooks.tool!.hive_plan_write.execute({ content: plan, feature: "compaction-test-feature" }, toolContext);
    await hooks.tool!.hive_plan_approve.execute({ feature: "compaction-test-feature" }, toolContext);
    await hooks.tool!.hive_tasks_sync.execute({ feature: "compaction-test-feature" }, toolContext);

    const worktreeRaw = await hooks.tool!.hive_worktree_start.execute(
      { feature: "compaction-test-feature", task: "01-compaction-task" },
      toolContext,
    );
    const worktreeResult = JSON.parse(worktreeRaw as string) as { worktreePath?: string };
    expect(worktreeResult.worktreePath).toBeDefined();

    const worktreePath = worktreeResult.worktreePath!;
    fs.writeFileSync(path.join(worktreePath, "change.txt"), "compaction resume test\n");

    const commitRaw = await hooks.tool!.hive_worktree_commit.execute(
      {
        feature: "compaction-test-feature",
        task: "01-compaction-task",
        status: "completed",
        summary: "Compaction resume test complete. Tests pass (bun test).",
        message: "test: record compaction resume flow\n\nRecord the verified compaction resume behavior.",
      },
      toolContext,
    );
    const commitResult = JSON.parse(commitRaw as string) as { ok: boolean; terminal: boolean; status: string };

    expect(commitResult.ok).toBe(true);
    expect(commitResult.terminal).toBe(true);
    expect(commitResult.status).toBe("completed");
  });

  it('plugin exposes the supported post-tool hook', async () => {
    const { createOpencodeClient: mkClient } = await import('@opencode-ai/sdk');
    const OPENCODE_CLIENT = mkClient({ baseUrl: 'http://localhost:1' }) as unknown as PluginInput['client'];

    const ctx: PluginInput = {
      directory: testRoot,
      worktree: testRoot,
      serverUrl: new URL('http://localhost:1'),
      project: { id: 'test', worktree: testRoot, time: { created: Date.now() } },
      client: OPENCODE_CLIENT,
      $: createStubShellForLoop(),
    };

    const hooks = await plugin(ctx);

    const postToolHook = 'tool.execute' + '.after';
    expect(hooks[postToolHook as keyof typeof hooks]).toBeDefined();
  });

});
