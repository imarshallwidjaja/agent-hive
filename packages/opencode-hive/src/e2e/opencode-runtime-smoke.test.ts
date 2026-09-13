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
export const RuntimeLargeSnapshotPlugin = async () => ({
  config: async (config: any) => {
    config.agent ??= {}
    config.agent['scout-researcher'] = {
      ...config.agent['scout-researcher'],
      model: '${RUNTIME_PROVIDER_ID}/${RUNTIME_MODEL_ID}',
    }
  },
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
