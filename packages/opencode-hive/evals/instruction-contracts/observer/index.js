// Read-only model-request observer, loaded by both stock hosts next to the plugin under test through each host's
// supported plugin hooks. It changes nothing: it appends the selected model and a fixed allowlist of generation
// settings for every model request to /work/state/observer.jsonl inside the container. Headers, prompts, messages,
// tool schemas and response bodies are never recorded. Baseline and candidate load the same committed file.
//
// v1 (opencode-ai 1.18.30): `chat.params` receives the resolved model and the final provider options.
// v2 (@opencode/cli 2.4.1): `model.request` names every model call; `http.request` and `experimental.ws.send` expose
// the outbound payload for the HTTP and WebSocket transports, so a call whose payload is not observed is detectable.
// `context` and `compaction` also record request parity: SHA-256 digests and counts of the system parts and tool
// definitions, never their text, so a compaction request's prefix can be compared with the ordinary request's.
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';

const OUT_DIR = '/work/state';
const OUT = `${OUT_DIR}/observer.jsonl`;
// Generation settings that change model behavior. Values are kept only when they are primitives.
const SETTINGS = ['reasoningEffort', 'reasoningSummary', 'textVerbosity', 'temperature', 'topP', 'topK', 'maxOutputTokens', 'serviceTier'];

function record(entry) {
  try {
    mkdirSync(OUT_DIR, { recursive: true });
    appendFileSync(OUT, JSON.stringify({ at: Date.now(), ...entry }) + '\n');
  } catch {
    // An unwritable record shows up as a missing observation, which the harness treats as invalid evidence.
  }
}

function primitive(value) {
  return ['string', 'number', 'boolean'].includes(typeof value) ? value : undefined;
}

export function pickSettings(source) {
  const out = {};
  for (const key of SETTINGS) {
    const value = primitive(source?.[key]);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/** Model and settings from an OpenAI-style payload (Responses or Chat Completions), HTTP body or WebSocket frame. */
export function payloadFacts(text) {
  let body;
  try { body = JSON.parse(text); } catch { return null; }
  if (!body || typeof body !== 'object') return null;
  const source = body.type === 'response.create' && body.response && typeof body.response === 'object' ? body.response : body;
  if (typeof source.model !== 'string') return null;
  const settings = {};
  const effort = primitive(source.reasoning?.effort ?? source.reasoning_effort);
  if (effort !== undefined) settings.reasoningEffort = effort;
  const summary = primitive(source.reasoning?.summary);
  if (summary !== undefined) settings.reasoningSummary = summary;
  const verbosity = primitive(source.text?.verbosity ?? source.verbosity);
  if (verbosity !== undefined) settings.textVerbosity = verbosity;
  for (const [from, to] of [['temperature', 'temperature'], ['top_p', 'topP'], ['service_tier', 'serviceTier']]) {
    const value = primitive(source[from]);
    if (value !== undefined) settings[to] = value;
  }
  return { model: source.model, settings };
}

const sha256 = (value) => createHash('sha256').update(JSON.stringify(value) ?? '').digest('hex');
const CHECKPOINT = '<conversation-checkpoint>';

function messageText(message) {
  const content = message?.content;
  if (typeof content === 'string') return content;
  return Array.isArray(content) ? content.filter((p) => p?.type === 'text' && typeof p.text === 'string').map((p) => p.text).join('') : '';
}

/**
 * Prefix parity of one v2 request in digests and counts only. System parts are hashed by their text in order, tools by
 * name and by name, description and input schema, in the order the request carries them. Null fields mean the request
 * could not be read in that shape.
 */
export function requestParity(input) {
  const out = { systemCount: null, systemSha256: null, toolCount: null, toolKeysSha256: null, toolDefsSha256: null, firstMessageHasCheckpoint: null };
  try {
    if (Array.isArray(input?.system)) {
      out.systemCount = input.system.length;
      out.systemSha256 = sha256(input.system.map((part) => (typeof part?.text === 'string' ? part.text : null)));
    }
    if (input?.tools && typeof input.tools === 'object' && !Array.isArray(input.tools)) {
      const entries = Object.entries(input.tools);
      out.toolCount = entries.length;
      out.toolKeysSha256 = sha256(entries.map(([name]) => name));
      out.toolDefsSha256 = sha256(entries.map(([name, def]) => [name, def?.description ?? null, def?.input ?? null]));
    }
    if (Array.isArray(input?.messages)) out.firstMessageHasCheckpoint = messageText(input.messages[0]).trimStart().startsWith(CHECKPOINT);
  } catch {
    // An unserializable request leaves the remaining fields null.
  }
  return out;
}

export default {
  id: 'ic-observer',
  // v1 plugin entry.
  server: async () => ({
    'chat.params': async (input, output) => {
      record({
        host: 'v1', hook: 'chat.params', sessionID: input.sessionID, agent: input.agent,
        providerID: input.model?.providerID, modelID: input.model?.id, apiModelID: input.model?.api?.id,
        settings: { ...pickSettings(output.options), ...pickSettings(output) },
      });
    },
  }),
  // v2 plugin entry.
  setup: async (context) => {
    const base = (input) => ({
      host: 'v2', sessionID: input.sessionID, agent: input.agent, kind: input.kind ?? null,
      providerID: input.model?.providerID, modelID: input.model?.id, variant: input.model?.variant ?? null,
    });
    await context.session.hook('model.request', (input) => record({ ...base(input), hook: 'model.request' }));
    await context.session.hook('context', (input) => record({ ...base(input), hook: 'context', settings: pickSettings(input.options), ...requestParity(input) }));
    await context.session.hook('compaction', (input) => record({ ...base(input), hook: 'compaction', settings: pickSettings(input.options), ...requestParity(input) }));
    await context.session.hook('http.request', async (input) => {
      let facts = null;
      try { facts = payloadFacts(await input.request.clone().text()); } catch { facts = null; }
      record({ ...base(input), hook: 'http.request', transport: 'http', payload: facts });
    });
    await context.session.hook('experimental.ws.send', (input) => {
      const facts = payloadFacts(input.frame);
      if (facts) record({ ...base(input), hook: 'experimental.ws.send', transport: 'ws', payload: facts });
    });
  },
};
