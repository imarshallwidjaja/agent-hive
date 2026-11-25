// Stock-host knowledge shared by the host-side runners (run.mjs, exercise.mjs) and the in-container fixture and
// exercise driver. Every fact here is tied to the exact qualified host version; changing a version means re-deriving the
// facts.
import { randomBytes } from 'node:crypto';

export const HOST_IDS = ['v1', 'v2'];

// The plugin is installed by plain npm into /opt/ic/plugin; both hosts load the installed artifact, never a workspace.
export const PLUGIN_DIST = '/opt/ic/plugin/node_modules/oc-arkive/dist';

export const HOSTS = {
  v1: {
    id: 'v1',
    packageName: 'opencode-ai',
    version: '1.18.30',
    binary: '/opt/ic/v1/node_modules/.bin/opencode',
    // packages/opencode/src/plugin/openai/codex.ts@v1.18.30 refreshes only when `expires < Date.now()`;
    // `expires` is epoch milliseconds and there is no early-refresh window.
    refreshWindowMs: 0,
    // packages/opencode/src/server/routes/instance/httpapi/groups/control.ts: PUT /auth/:providerID with Auth.Info.
    auth: { method: 'PUT', path: '/auth/openai' },
    readyPath: '/global/health',
    configFile: 'opencode.json',
  },
  v2: {
    id: 'v2',
    packageName: '@opencode/cli',
    version: '2.4.1',
    binary: '/opt/ic/v2/node_modules/.bin/opencode2',
    // packages/core/src/integration.ts@v2.4.1 connection.resolve refreshes when Credential.expiring
    // (core/src/credential.ts): `expires <= now + 5 minutes`; `expires` is epoch milliseconds.
    refreshWindowMs: 5 * 60_000,
    // @opencode/protocol@2.4.1 groups/credential.js: POST /api/credential with Credential.CreateInput. The
    // `chatgpt-browser` method (plugin/provider/openai.ts) uses the Codex backend with metadata.accountID.
    auth: { method: 'POST', path: '/api/credential' },
    readyPath: '/api/info',
    configFile: 'opencode.jsonc',
  },
};

// Hive role identifiers composed by src/runtime/role-catalog.ts.
export const HIVE_ROLES = [
  'hive-master', 'architect-planner', 'swarm-orchestrator', 'hive-builder', 'scout-researcher', 'forager-worker',
  'forager-investigator', 'hive-helper', 'plan-reviewer', 'code-reviewer', 'simplicity-reviewer', 'approach-advisor', 'vulnerability-reviewer',
  'dash-reviewer', 'vulnerability-review-primary',
];

// Command keys registered by the plugin (src/commands/registry.ts HIVE_COMMANDS); harness.test.ts pins this list to it.
export const HIVE_COMMANDS = [
  'sharpen', 'interview', 'grill', 'investigate', 'walkthrough', 'implementation-brief', 'hive-plan', 'approve-sync-plan', 'start-execution',
  'implement', 'merge-to-main', 'council', 'dash-review', 'test-audit', 'vuln-review', 'worklog', 'handoff',
  'compact-summary',
];

// Hive tool names registered by the plugin (src/utils/plugin-manifest.ts HIVE_TOOL_NAMES), kept here because the
// exercise container carries only the harness. harness.test.ts pins this list to the manifest. A supervised export keeps
// result text only for tools in this list.
export const HIVE_TOOL_NAMES = Object.freeze([
  'hive_feature_create', 'hive_feature_select', 'hive_feature_complete', 'hive_repositories_status', 'hive_repositories_discover', 'hive_repositories_update',
  'hive_plan_write', 'hive_plan_patch', 'hive_plan_read', 'hive_plan_approve', 'hive_tasks_sync', 'hive_task_create', 'hive_task_update',
  'hive_worktree_create', 'hive_worktree_inspect', 'hive_worktree_merge', 'hive_worktree_cleanup', 'hive_adhoc_worktree_create', 'hive_adhoc_worktree_inspect',
  'hive_adhoc_worktree_merge', 'hive_adhoc_worktree_cleanup', 'hive_worktree_recover', 'hive_checkouts_list', 'hive_checkout_inspect', 'hive_checkout_brief',
  'hive_checkout_create', 'hive_checkout_register', 'hive_checkout_readiness', 'hive_checkout_cleanup', 'hive_background_status',
  'hive_background_cancel', 'hive_task_trace', 'hive_task_trace_content', 'hive_context_read', 'hive_context_write',
  'hive_context_append', 'hive_context_edit', 'hive_context_archive', 'hive_constraints_read', 'hive_constraints_add', 'hive_constraints_edit',
  'hive_constraints_clear', 'hive_worklog_list', 'hive_worklog_read', 'hive_worklog_record', 'hive_explore_read', 'hive_explore_update', 'hive_councils_list',
  'hive_status', 'hive_git_snapshot',
]);

// Hive tools whose results carry other sessions' native tool output (traces) or file diffs (Git snapshots). A supervised
// export keeps their call records and replaces the result with an omission marker.
export const HIVE_RESULT_OMITTED_TOOLS = Object.freeze(['hive_task_trace', 'hive_task_trace_content', 'hive_git_snapshot']);

// A non-usable placeholder; the real refresh token never leaves the host auth store.
export const REFRESH_SENTINEL = 'ic-access-only-refresh-disabled';

export function hostSpec(id) {
  const spec = HOSTS[id];
  if (!spec) throw new Error(`unknown host: ${id}`);
  return spec;
}

/** Native credential request for an access-only OpenAI credential. `credential` is { access, expires, accountId? }. */
export function authRequest(id, credential) {
  const spec = hostSpec(id);
  if (id === 'v1') {
    const body = { type: 'oauth', access: credential.access, refresh: REFRESH_SENTINEL, expires: credential.expires };
    if (credential.accountId) body.accountId = credential.accountId;
    return { method: spec.auth.method, path: spec.auth.path, body };
  }
  return {
    method: spec.auth.method,
    path: spec.auth.path,
    body: {
      integrationID: 'openai',
      activate: true,
      value: {
        type: 'oauth',
        methodID: 'chatgpt-browser',
        access: credential.access,
        refresh: REFRESH_SENTINEL,
        expires: credential.expires,
        metadata: credential.accountId ? { accountID: credential.accountId } : {},
      },
    },
  };
}

// Relationship-bearing fields whose descriptions later instruction changes rely on: worktree pins and destination
// targets, approval and sync, report and handoff publication, hash-guarded context operations, and the checkout pair a
// brief compares (a read v2 shows only in Code Mode, v1 as a direct tool). Each must carry a
// non-empty description on the surface the host actually shows the model: the direct tool schema, or the Code Mode
// declaration for a read exposed there. Other undescribed fields are listed for information only.
const MERGE_FIELDS = ['historyIntent', 'strategy', 'message', 'preserveConflicts', 'cleanup', 'sourceCommit', 'sourceCommits', 'expectedTarget', 'expectedTargets'];
export const TOOL_FIELD_CONTRACT = Object.freeze({
  hive_worktree_create: ['baseRef', 'repoIds', 'candidate'],
  hive_worktree_inspect: ['repoIds', 'candidate'],
  hive_worktree_merge: ['repoIds', 'candidate', ...MERGE_FIELDS],
  hive_worktree_cleanup: ['repoIds', 'candidate', 'deleteBranch', 'discard'],
  hive_adhoc_worktree_create: ['runId', 'repoIds', 'sourceDirectory'],
  hive_adhoc_worktree_inspect: ['repoIds', 'sourceDirectory'],
  hive_adhoc_worktree_merge: ['repoIds', 'sourceDirectory', ...MERGE_FIELDS],
  hive_adhoc_worktree_cleanup: ['repoIds', 'sourceDirectory', 'deleteBranch', 'discard'],
  hive_worktree_recover: ['operationId', 'markerDigest', 'observedStateDigest', 'mutatorsStopped', 'sourceDirectory'],
  hive_plan_approve: ['expectedRevision', 'sync', 'refreshPending'],
  hive_tasks_sync: ['refreshPending'],
  hive_task_update: ['status', 'blocker', 'report', 'handoff'],
  hive_context_read: ['name', 'scope', 'view', 'query', 'limit', 'cursor', 'maxBytes', 'scanChars'],
  hive_context_write: ['content', 'kind', 'task', 'expectedRevision', 'expectedContentHash', 'scope'],
  hive_context_append: ['content', 'section', 'task', 'expectedRevision', 'expectedContentHash', 'scope'],
  hive_context_edit: ['name', 'oldText', 'newText', 'expectedRevision', 'expectedContentHash', 'scope', 'feature'],
  hive_context_archive: ['reason', 'expectedRevision', 'expectedContentHashes', 'scope'],
  hive_checkout_brief: ['id', 'against'],
});

/**
 * Checks the field contract against what one host showed the model. `direct` maps tool -> { field: description };
 * `codeMode` maps tool -> { field: doc comment } for tools shown only as Code Mode declarations. A tool or field the
 * model was not shown, or one shown without a description, is a finding; nothing outside the contract is judged.
 */
export function fieldContractFindings(direct, codeMode, contract = TOOL_FIELD_CONTRACT) {
  const absentTools = [];
  const absentFields = [];
  const undescribed = [];
  let checked = 0;
  for (const [tool, fields] of Object.entries(contract)) {
    const surface = direct?.[tool] ?? codeMode?.[tool];
    if (!surface) { absentTools.push(tool); continue; }
    for (const field of fields) {
      checked++;
      if (!(field in surface)) absentFields.push(`${tool}.${field}`);
      else if (!String(surface[field] ?? '').trim()) undescribed.push(`${tool}.${field}`);
    }
  }
  return { checked, absentTools, absentFields, undescribed };
}

/**
 * Minimum remaining credential lifetime at injection: the whole-container deadline, the exact host's early-refresh
 * window, and a safety margin. Anything shorter could make the stock host attempt a refresh with the sentinel.
 */
export function requiredLifetimeMs(id, deadlineMs, marginMs) {
  return deadlineMs + hostSpec(id).refreshWindowMs + marginMs;
}

/**
 * Credential-free model-selection probes. Each source of a model gets its own mock model ID, and each pair its own
 * variant, so the wire and the native message record show where a selection came from: the host default, the primary
 * prompt's model and variant (what an inheriting child should get), two explicit Hive pairs, and a native agent model.
 */
export const PROBE_VARIANTS = { parent: 'parent-variant', hive: 'hive-variant', advisor: 'advisor-variant' };
export function probeModels(model) {
  return { default: model, parent: `${model}-parent`, hive: `${model}-hive`, advisor: `${model}-advisor`, native: `${model}-native` };
}

/**
 * Hive's expected selection for each probed agent of the valid probe. `primary` runs with no model of its own; the
 * children are dispatched by a primary running on `parent` with its variant, which an unconfigured child inherits with
 * the model. On v2 a native agent model replaces a valid Hive pair whole, so a model-only native setting drops the Hive
 * variant; on v1 Hive's agent entry replaces the native one. A custom agent resolves its base role's Hive pair, not the
 * native setting on that base.
 */
export function selectionExpectations(id, model) {
  const m = probeModels(model);
  const v = PROBE_VARIANTS;
  return {
    primary: { model: m.default, variant: null },
    'scout-researcher': { model: m.parent, variant: v.parent },
    'probe-native': { model: m.parent, variant: v.parent },
    'forager-worker': { model: m.hive, variant: v.hive },
    'probe-base': { model: m.hive, variant: v.hive },
    'forager-investigator': id === 'v2' ? { model: m.native, variant: null } : { model: m.advisor, variant: v.advisor },
    'probe-advisor': { model: m.advisor, variant: v.advisor },
  };
}

/**
 * The managed-model-control probe as data, shared by the fixture that runs it and the wiring check that judges it.
 * Only v2 has the control: its subagent wrapper (src/v2/dispatch.ts) refuses a `model` argument for a Hive-managed agent
 * and a continuation of a child whose model an operator changed away from the agent's configured one. A model view is
 * `{ model: <probe model ID>, variant: <probe variant | null> }`; the unit tests own the full local matrix, so these
 * cases only need to reach the real wrapper through the real host: built-in and custom agents, configured and
 * inheriting ones, the same model and another, with and without a variant.
 */
export const MANAGED_CONTROL_HOST = 'v2';
export function managedControlPlan(model) {
  const m = probeModels(model);
  const v = PROBE_VARIANTS;
  const view = (id, variant = null) => ({ model: id, variant });
  const effective = selectionExpectations(MANAGED_CONTROL_HOST, model);
  return {
    refusals: [
      { id: 'inheriting-built-in-other-model', agent: 'scout-researcher', sent: view(m.hive) },
      { id: 'built-in-pair-same', agent: 'forager-worker', sent: view(m.hive, v.hive) },
      { id: 'custom-same-model-no-variant', agent: 'probe-base', sent: view(m.hive) },
      { id: 'native-model-other-variant', agent: 'forager-investigator', sent: view(m.parent, v.parent) },
      { id: 'custom-pair-same', agent: 'probe-advisor', sent: view(m.advisor, v.advisor) },
    ],
    // The host's own catalog entry for each probed agent: its configured model, null when it inherits the parent's.
    catalog: {
      'scout-researcher': null,
      'forager-worker': effective['forager-worker'], 'probe-base': effective['probe-base'],
      'forager-investigator': effective['forager-investigator'], 'probe-advisor': effective['probe-advisor'],
    },
    // The unmanaged native agent without a model inherits the parent's, and with the same argument as a refusal above it must
    // run on that argument: the host accepts it, so a refusal above is Hive's own, and the argument is what changed the model.
    baseline: { agent: 'general', expected: view(m.parent, v.parent) },
    control: { agent: 'general', sent: view(m.hive, v.hive) },
    // Fresh children without a `model`; each runs on its effective configured model.
    children: [
      { id: 'reviewer', agent: 'forager-worker', expected: effective['forager-worker'] },
      { id: 'custom', agent: 'probe-base', expected: effective['probe-base'] },
      { id: 'plain', agent: 'forager-investigator', expected: effective['forager-investigator'] },
      { id: 'bearing', agent: 'probe-advisor', expected: effective['probe-advisor'] },
    ],
    // What the operator switches an idle child to between the parent's turns.
    operator: { reviewer: view(m.parent, v.parent), custom: view(m.hive) },
    // Continuations without a `model`, in one parent turn. An accepted one keeps the configured model; a refused one finds the operator's.
    continuations: [
      { child: 'reviewer', expect: 'refused' },
      { child: 'plain', expect: 'accepted' },
      { child: 'custom', expect: 'refused' },
      { child: 'bearing', expect: 'accepted' },
    ],
  };
}

/** Two model views name one model. The host reports a stored model without a variant as `default`, and a configured one omits it. */
export function sameModelView(a, b) {
  return Boolean(a) && Boolean(b) && a.model === b.model && (a.variant ?? 'default') === (b.variant ?? 'default');
}

/** A model view written as a `providerID/modelID#variant` argument of the mock provider; `default` is no variant. */
export function modelArgument(view) {
  return `mock/${view.model}${view.variant && view.variant !== 'default' ? `#${view.variant}` : ''}`;
}

/** The variant a probe declares on one of its mock models, if any. */
function probeVariant(probe, modelID) {
  const key = probe ? Object.keys(probe).find((name) => probe[name] === modelID) : undefined;
  return key ? PROBE_VARIANTS[key] : undefined;
}

/** Native agent settings each probe adds: a native model for a Hive role, which must not complete or override wrongly. */
function probeNativeAgents(selection, model) {
  const native = `mock/${probeModels(model).native}`;
  if (selection === 'valid') return { 'forager-investigator': native };
  if (selection === 'invalid') return { 'forager-worker': native };
  return {};
}

/**
 * Native configuration for one host. `provider` is 'mock' (credential-free scripted provider on loopback) or 'openai'.
 * `permissive` adds a global allow rule so headless runs cannot block on permission prompts; Hive's own role guards
 * still apply. Wiring runs `permissive: false` to observe stock permissions. `selection` adds a model-selection probe's
 * mock models and native agent settings; the paid path never sets it.
 */
export function hostConfig(id, { provider, model, mockPort, serverPort, userSkillsDir, observer, permissive = true, selection }) {
  const modelRef = provider === 'mock' ? `mock/${model}` : `openai/${model}`;
  const probe = provider === 'mock' && selection ? probeModels(model) : null;
  const nativeAgents = probe ? probeNativeAgents(selection, model) : {};
  const mockModelIDs = probe ? Object.values(probe) : [model];
  if (id === 'v1') {
    const cfg = {
      $schema: 'https://opencode.ai/config.json',
      // The read-only observer loads after the subject so it sees the final request settings.
      plugin: [`${PLUGIN_DIST}/index.js`, `${observer}/index.js`],
      model: modelRef,
      small_model: modelRef,
      autoupdate: false,
      share: 'disabled',
      snapshot: false,
      enabled_providers: [provider === 'mock' ? 'mock' : 'openai'],
    };
    if (permissive) cfg.permission = { '*': 'allow' };
    if (userSkillsDir) cfg.skills = { paths: [userSkillsDir] };
    if (provider === 'mock') {
      cfg.provider = {
        mock: {
          npm: '@ai-sdk/openai-compatible',
          name: 'Mock',
          options: { baseURL: `http://127.0.0.1:${mockPort}/v1`, apiKey: 'mock-not-a-secret' },
          models: Object.fromEntries(mockModelIDs.map((id) => [id, {
            name: id, tool_call: true, limit: { context: 200000, output: 8192 },
            ...(probeVariant(probe, id) ? { variants: { [probeVariant(probe, id)]: {} } } : {}),
          }])),
        },
      };
    }
    if (Object.keys(nativeAgents).length > 0) cfg.agent = Object.fromEntries(Object.entries(nativeAgents).map(([name, ref]) => [name, { model: ref }]));
    return cfg;
  }
  const cfg = {
    plugins: [{
      package: PLUGIN_DIST,
      options: { server: { url: `http://127.0.0.1:${serverPort}`, passwordEnv: 'OPENCODE_SERVER_PASSWORD' } },
    }, { package: observer }],
    model: modelRef,
    experimental: { subagent_depth: 2 },
  };
  if (permissive) cfg.permissions = [{ action: '*', resource: '*', effect: 'allow' }];
  if (userSkillsDir) cfg.skills = [userSkillsDir];
  if (provider === 'mock') {
    cfg.providers = {
      mock: {
        name: 'Mock',
        package: '@ai-sdk/openai-compatible',
        env: ['MOCK_PROVIDER_KEY'],
        settings: { baseURL: `http://127.0.0.1:${mockPort}/v1` },
        models: Object.fromEntries(mockModelIDs.map((id) => [id, {
          name: id, capabilities: { tools: true },
          ...(probeVariant(probe, id) ? { variants: [{ id: probeVariant(probe, id) }] } : {}),
        }])),
      },
    };
  }
  if (Object.keys(nativeAgents).length > 0) cfg.agents = Object.fromEntries(Object.entries(nativeAgents).map(([name, ref]) => [name, { model: ref }]));
  return cfg;
}

/**
 * Agent Hive global configuration. Wiring and cases pin every Hive role to the one frozen model so no default provider
 * is contacted. A `selection` probe instead leaves most roles to native inheritance: the valid probe pins only an
 * explicit pair and a role that a native setting also names, and derives an inheriting custom agent from each; the
 * invalid probe configures a variant with no Hive model.
 */
export function hiveConfig({ provider, model, variant, agentMode, selection }) {
  if (selection === 'valid') {
    const { hive, advisor } = probeModels(model);
    return {
      agentMode,
      agents: {
        'forager-worker': { model: `mock/${hive}`, variant: PROBE_VARIANTS.hive },
        'forager-investigator': { model: `mock/${advisor}`, variant: PROBE_VARIANTS.advisor },
      },
      customAgents: {
        'probe-native': { baseAgent: 'scout-researcher', description: 'Model-selection probe without Hive model settings.' },
        'probe-base': { baseAgent: 'forager-worker', description: 'Model-selection probe inheriting its base Hive pair.' },
        'probe-advisor': { baseAgent: 'forager-investigator', description: 'Model-selection probe inheriting a base Hive pair that a native setting overrides.' },
      },
    };
  }
  if (selection === 'invalid') return { agentMode, agents: { 'forager-worker': { variant: PROBE_VARIANTS.hive } }, customAgents: {} };
  const modelRef = provider === 'mock' ? `mock/${model}` : `openai/${model}`;
  const agents = {};
  for (const role of HIVE_ROLES) {
    agents[role] = variant ? { model: modelRef, variant } : { model: modelRef };
  }
  return { agentMode, agents, customAgents: {} };
}

/** Server start arguments. Servers bind loopback inside the container's own network namespace only. */
export function serveArgs(id, port) {
  return id === 'v1'
    ? ['serve', '--hostname', '127.0.0.1', '--port', String(port), '--print-logs', '--log-level', 'INFO']
    : ['serve', '--hostname', '127.0.0.1', '--port', String(port), '--print-logs'];
}

/** Native session creation request; the harness creates the primary session itself so its ID is known exactly. */
export function sessionCreateRequest(id, { agent, directory }) {
  return id === 'v1'
    ? { path: `/session?directory=${encodeURIComponent(directory)}`, body: { title: 'evaluation' } }
    : { path: '/api/session', body: { title: 'evaluation', agent, location: { directory } } };
}

/** Headless prompt arguments for one primary session. */
export function runArgs(id, { port, session, agent, modelRef, variant, prompt, command }) {
  const base = id === 'v1'
    ? ['run', '--attach', `http://127.0.0.1:${port}`]
    : ['run', '--server', `http://127.0.0.1:${port}`];
  const args = [...base, '--session', session, '--agent', agent, '--format', 'json'];
  // The v2 CLI selects a variant inside the model reference; the v1 CLI has its own flag.
  if (modelRef) args.push('--model', variant && id === 'v2' ? `${modelRef}#${variant}` : modelRef);
  if (variant && id === 'v1') args.push('--variant', variant);
  if (command) args.push('--command', command);
  args.push(prompt);
  return args;
}

/** Effective tool ID of a Code Mode call path, as the host forms it: `tools.hive.worklog_read` -> `hive_worklog_read`. */
export function codeModePathId(path) {
  return path.replace(/^tools\./, '').replace('.', '_');
}

// Reading the TypeScript declarations v2 2.4.1 renders for Code Mode tools. Brackets of every kind nest; comments and
// string literals are skipped, so a bracket, quote or `//` inside a field doc or a literal type never ends a group.
const CLOSERS = { '(': ')', '{': '}', '[': ']', '<': '>' };
const isOpener = (c) => Object.hasOwn(CLOSERS, c);

/** Index just past the comment or string literal starting at `i`, `i` when none starts there, -1 when it never ends. */
function skipLiteral(text, i) {
  if (text.startsWith('/*', i)) {
    const end = text.indexOf('*/', i + 2);
    return end < 0 ? -1 : end + 2;
  }
  const quote = text[i];
  if (quote !== '"' && quote !== "'" && quote !== '`') return i;
  for (let j = i + 1; j < text.length; j++) {
    if (text[j] === '\\') j++;
    else if (text[j] === quote) return j + 1;
  }
  return -1;
}

/** Index just past the bracket group that opens at `i`; -1 when it is unbalanced. `=>` is an arrow, not a closer. */
function groupEnd(text, i) {
  const expected = [];
  for (let j = i; j < text.length;) {
    const skipped = skipLiteral(text, j);
    if (skipped < 0) return -1;
    if (skipped !== j) { j = skipped; continue; }
    const c = text[j];
    if (isOpener(c)) expected.push(CLOSERS[c]);
    else if (')}]>'.includes(c) && !(c === '>' && text[j - 1] === '=')) {
      if (expected.pop() !== c) return -1;
      if (expected.length === 0) return j + 1;
    }
    j++;
  }
  return -1;
}

/** A doc comment's text without its `*` gutter, on one line. */
function docText(body) {
  return body.split('\n').map((line) => line.replace(/^\s*\*?\s?/, '')).join(' ').trim();
}

/**
 * The top-level fields of an argument list `()` or `({ ... })`: field -> the doc comment directly before it, `''` when
 * there is none. Nested object fields are part of their parent's type. Null when the list is not one object literal.
 */
function signatureParams(args) {
  const inner = args.slice(1, -1).trim();
  if (inner === '') return {};
  if (inner[0] !== '{' || groupEnd(inner, 0) !== inner.length) return null;
  const params = {};
  let doc = '';
  for (let j = 1; j < inner.length - 1;) {
    if (/[\s,]/.test(inner[j])) { j++; continue; }
    if (inner.startsWith('/*', j)) {
      const end = skipLiteral(inner, j);
      if (inner.startsWith('/**', j)) doc = docText(inner.slice(j + 3, end - 2));
      j = end;
      continue;
    }
    const field = /^([A-Za-z_$][\w$]*)\??:/.exec(inner.slice(j));
    if (!field) return null;
    params[field[1]] = doc;
    doc = '';
    // The field's type runs to the next comma outside any bracket group.
    for (j += field[0].length; j < inner.length - 1 && inner[j] !== ',';) {
      const skipped = skipLiteral(inner, j);
      if (skipped < 0) return null;
      if (skipped !== j) j = skipped;
      else if (isOpener(inner[j])) {
        j = groupEnd(inner, j);
        if (j < 0) return null;
      } else j++;
    }
  }
  return params;
}

/**
 * One Code Mode declaration signature starting at `start`: `tools.<namespace>.<name>(<args>): <return type>`, or the
 * flat `tools.<name>(...)`. The return type ends at the end of its line or at the ` // ` that starts a description,
 * which is not part of the signature. Returns the call path, the effective ID, the top-level argument fields with their
 * doc comments, and the index just past the signature; null when the text there is not such a signature.
 */
function codeModeSignature(text, start = 0) {
  const head = /^tools\.[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)?\(/.exec(text.slice(start));
  if (!head) return null;
  const open = start + head[0].length - 1;
  const close = groupEnd(text, open);
  if (close < 0 || !text.startsWith(': ', close)) return null;
  const params = signatureParams(text.slice(open, close));
  if (!params) return null;
  let end = close + 2;
  while (end < text.length && text[end] !== '\n' && !text.startsWith(' // ', end)) {
    const skipped = skipLiteral(text, end);
    if (skipped < 0) return null;
    if (skipped !== end) end = skipped;
    else if (isOpener(text[end])) {
      end = groupEnd(text, end);
      if (end < 0) return null;
    } else if (')}]'.includes(text[end]) || (text[end] === '>' && text[end - 1] !== '=')) return null;
    else end++;
  }
  if (!text.slice(close + 2, end).trim()) return null;
  const path = head[0].slice(0, -1);
  return { path, id: codeModePathId(path), params, end };
}

/** The heading v2 2.4.1 puts over its Code Mode catalog; the catalog is the contiguous entry list right after it. */
const CODE_MODE_CATALOG_HEADING = '## Code Mode tools (call only inside `execute`)';

// A namespace header line. v2 names a namespace after its MCP server or tool, so the name may hold `-` or other
// characters a JavaScript identifier cannot; its members are then reached with bracket notation.
const NAMESPACE_HEADER = /^- (\S+) \((\d+) tools?(?:, (?:\d+|none) shown)?\)(?: \/\/ .*)?$/;
const isHiveNamespace = (name) => name === 'hive' || name.startsWith('hive_');

/**
 * The Code Mode catalog one v2 request showed the model, read only from the contiguous entry list under
 * {@link CODE_MODE_CATALOG_HEADING}. `namespaces` maps every header to the tool count it states. Only Hive namespaces
 * (`hive` and flat `hive_*`) are decoded: `members` maps each of their declared members to its call path, the full
 * signature the host rendered, its description (the text after the signature's ` // `, `''` when there is none) and its
 * argument fields, keyed by effective tool ID (the host joins a namespace and a local name with `_`, so
 * `tools.hive.worklog_read` is `hive_worklog_read`, and a flat `tools.hive_worklog_read` is the same ID). Another
 * namespace's block is skipped line by line up to the next header: a member line, or a line continuing its declaration
 * (indented, or a closing bracket at the margin). The catalog ends at the first line that fits none of these, or at a
 * Hive member line that is not one declaration of its namespace. A member the catalog folds away is counted in its
 * header but declared only by `search`, so a header is never evidence that a member exists or is callable.
 */
export function codeModeCatalog(system) {
  const namespaces = {};
  const members = {};
  const at = `\n${system}`.indexOf(`\n${CODE_MODE_CATALOG_HEADING}\n`);
  if (at < 0) return { namespaces, members };
  const lineEnd = (i) => (system.indexOf('\n', i) < 0 ? system.length : system.indexOf('\n', i));
  let i = at + CODE_MODE_CATALOG_HEADING.length + 1;
  if (system[i] === '\n') i++;
  let namespace = null;
  while (i < system.length) {
    const line = system.slice(i, lineEnd(i));
    const header = NAMESPACE_HEADER.exec(line);
    if (header) {
      namespace = header[1];
      namespaces[namespace] = Number(header[2]);
      i = lineEnd(i) + 1;
      continue;
    }
    if (namespace === null) break;
    if (!isHiveNamespace(namespace)) {
      if (!/^(?:\s+\S|[)}\]>])/.test(line)) break;
      i = lineEnd(i) + 1;
      continue;
    }
    if (!line.startsWith('  - ')) break;
    const declaration = codeModeSignature(system, i + 4);
    if (!declaration || declaration.path.split('.')[1] !== namespace) break;
    const described = system.startsWith(' // ', declaration.end);
    const end = described ? lineEnd(declaration.end) : declaration.end;
    const { path, id, params } = declaration;
    members[id] = { path, signature: system.slice(i + 4, declaration.end), description: described ? system.slice(declaration.end + 4, end).trim() : '', params };
    i = end + 1;
  }
  return { namespaces, members };
}

/**
 * A member the host's `search` listed (`{ path, signature, description }`), read as strictly as a catalog declaration:
 * its signature must be exactly one declaration of its own path. Null otherwise. A missing or blank description is
 * `''`, never borrowed from the signature's field docs.
 */
export function codeModeSearchMember(item) {
  const signature = typeof item?.signature === 'string' ? item.signature : '';
  const declaration = codeModeSignature(signature);
  if (!declaration || declaration.end !== signature.length || declaration.path !== item.path) return null;
  const description = typeof item.description === 'string' ? item.description.trim() : '';
  return { path: declaration.path, signature, description, params: declaration.params };
}

/**
 * Translates a host-neutral scripted step into the native tool call the mock provider emits. `tools` is the
 * provider-facing tool list from the current request. A Hive read that v2 exposes only through Code Mode is wrapped in
 * `execute` with the call path in `codeModePaths` (effective tool ID -> path), which the host's own catalog or search
 * supplied; a read with no known path goes out as a direct call, which the host refuses unless it is one.
 */
export function nativeToolCall(id, step, tools, codeModePaths = {}) {
  const has = (name) => tools.includes(name);
  switch (step.op) {
    case 'hive':
      if (has(step.tool)) return { tool: step.tool, args: step.args ?? {} };
      if (id === 'v2' && has('execute') && codeModePaths[step.tool]) {
        return { tool: 'execute', args: { code: `return await ${codeModePaths[step.tool]}(${JSON.stringify(step.args ?? {})})` } };
      }
      return { tool: step.tool, args: step.args ?? {} };
    case 'dispatch':
      return id === 'v1'
        ? { tool: 'task', args: { subagent_type: step.agent, description: step.description ?? 'fixture step', prompt: step.prompt } }
        // The v2 subagent call has no `background` field: it always runs the child in the background.
        : { tool: 'subagent', args: { agent: step.agent, description: step.description ?? 'fixture step', prompt: step.prompt } };
    case 'shell':
      return id === 'v1'
        ? { tool: 'bash', args: { command: step.command, description: 'fixture step' } }
        : { tool: 'shell', args: { command: step.command } };
    case 'write':
      return id === 'v1'
        ? { tool: 'write', args: { filePath: step.path, content: step.content } }
        : { tool: 'write', args: { path: step.path, content: step.content } };
    case 'read':
      return id === 'v1' ? { tool: 'read', args: { filePath: step.path } } : { tool: 'read', args: { path: step.path } };
    case 'skill':
      return id === 'v1' ? { tool: 'skill', args: { name: step.name } } : { tool: 'skill', args: { id: step.name } };
    case 'native':
      // An exact native call, for host behavior the neutral vocabulary does not cover (for example `question`).
      return { tool: step.tool, args: step.args ?? {} };
    default:
      throw new Error(`unknown scripted op: ${step.op}`);
  }
}

// -----------------------------------------------------------------------------------------------------------------
// Supervised exercises (exercise.mjs, exercise-driver.ts). Native routes and configuration for the same two exact
// hosts, driven only through their public server APIs; no CLI attaches to a session.
//
// v1 (opencode-ai 1.18.30, packages/opencode/src/server/routes/instance/httpapi/groups/{session,question,permission}.ts):
//   POST /session/:id/prompt_async {messageID, agent, model, variant, parts}; GET /session/status; GET
//   /session/:id/children; GET /session/:id/message?limit&before; GET /session/:id/message/:messageID; GET /question,
//   POST /question/:id/reply {answers}; GET /permission, POST /permission/:id/reply {reply}; POST /session/:id/abort.
//   GET /command lists each command with its bound `agent`; POST /session/:id/command {messageID, agent, model,
//   variant, command, arguments} answers only when the whole turn has ended (handlers/session.ts command ->
//   session/prompt.ts SessionPrompt.command -> prompt -> loop). The turn itself runs in the instance's session runner
//   (effect/runner.ts startRun forks into the instance scope), so a client that disconnects once the user message exists
//   and the session is busy leaves the turn running.
// v2 (@opencode/cli 2.4.1; routes from @opencode/protocol@2.4.1 dist/groups/{session,permission,command,agent,model}.js):
//   POST /api/session {agent, model, location}; POST /api/session/:id/prompt {id, text}; POST /api/session/:id/agent at idle; GET /api/session?parentID&limit&cursor; GET /api/session/active; GET /api/session/:id/form,
//   POST .../form/:formID/reply {answer}; GET /api/session/:id/permission, POST .../permission/:id/reply {decision};
//   POST /api/session/:id/interrupt. The v2 question tool (packages/core/src/tool/plugin/question.ts) asks one form
//   whose fields are `q<index>`, string or multiselect, with option labels as values. GET /api/command lists names
//   and descriptions only; POST /api/session/:id/command {name, text} runs the plugin's command callback and answers
//   once it returns (core/src/session/command.ts), after the callback has admitted its prompt. It takes no message ID.
// Both hosts accept a caller-chosen message ID (`msg_` + 12 hex time digits + 14 base62 characters) on a prompt, and
// v1 on a command, so that submission can be found again by its exact ID after a lost acknowledgement.

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/**
 * A message ID in the format both pinned hosts generate and accept from callers: `msg_`, the 48-bit big-endian value
 * of (milliseconds * 0x1000 + counter) in 12 hex digits, then 14 base62 characters. A supervisor-chosen ID recorded
 * before submission is what lets a lost acknowledgement be resolved by exact lookup instead of by text or recency.
 */
export function exerciseMessageId(now = Date.now(), counter = 1, random = randomBytes(14)) {
  const value = BigInt(now) * 0x1000n + BigInt(counter);
  const time = (value & 0xffffffffffffn).toString(16).padStart(12, '0');
  return `msg_${time}${Array.from(random, (byte) => BASE62[byte % 62]).join('')}`;
}

export const MESSAGE_ID = /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/;

/**
 * Whether a project-relative path (or directory prefix ending in "/") names, or lies inside, one of the Agent Hive
 * native session and background stores of either owner: `.hive/sessions.json`, `.hive/background-jobs.json`,
 * `.hive/runtime/**`, and per feature `<feature directory>/sessions.json` and `<feature directory>/runtime/**`. The
 * feature directory is any single segment under `.hive/features/`, so indexed and unprefixed names are both covered.
 */
export function nativeStorePath(path) {
  const parts = String(path).split('/').filter(Boolean);
  if (parts[0] !== '.hive') return false;
  if (parts.length === 2 && ['sessions.json', 'background-jobs.json'].includes(parts[1])) return true;
  if (parts[1] === 'runtime') return true;
  if (parts[1] === 'features' && parts.length >= 4) return parts[3] === 'sessions.json' || parts[3] === 'runtime';
  return false;
}

/** Splits an explicit `provider/model` reference. */
export function splitModelRef(ref) {
  const slash = typeof ref === 'string' ? ref.indexOf('/') : -1;
  if (slash <= 0 || slash === ref.length - 1) throw new Error('model reference invalid');
  return { providerID: ref.slice(0, slash), modelID: ref.slice(slash + 1) };
}

/**
 * Native configuration for one supervised exercise. Explicit model, no permission rules of its own beyond the stock
 * host defaults, the installed plugin and the read-only observer. `askExternalReads` is the credential-free
 * qualification's one explicit `ask` rule, so a permission request is deterministic there; live runs never set it.
 */
export function exerciseHostConfig(id, { modelRef, variant, provider, mockPort, serverPort, observer, askExternalReads = false }) {
  const mockModel = provider === 'mock' ? splitModelRef(modelRef).modelID : null;
  if (id === 'v1') {
    const cfg = {
      $schema: 'https://opencode.ai/config.json',
      plugin: [`${PLUGIN_DIST}/index.js`, `${observer}/index.js`],
      model: modelRef,
      small_model: modelRef,
      autoupdate: false,
      share: 'disabled',
      snapshot: false,
      enabled_providers: [provider],
    };
    if (askExternalReads) cfg.permission = { external_directory: 'ask' };
    if (provider === 'mock') {
      cfg.provider = { mock: { npm: '@ai-sdk/openai-compatible', name: 'Mock', options: { baseURL: `http://127.0.0.1:${mockPort}/v1`, apiKey: 'mock-not-a-secret' }, models: { [mockModel]: { name: mockModel, tool_call: true, limit: { context: 200000, output: 8192 } } } } };
    }
    return cfg;
  }
  const cfg = {
    plugins: [{ package: PLUGIN_DIST, options: { server: { url: `http://127.0.0.1:${serverPort}`, passwordEnv: 'OPENCODE_SERVER_PASSWORD' } } }, { package: observer }],
    model: variant ? `${modelRef}#${variant}` : modelRef,
    experimental: { subagent_depth: 2 },
  };
  if (askExternalReads) cfg.permissions = [{ action: 'external_directory', resource: '*', effect: 'ask' }];
  if (provider === 'mock') {
    cfg.providers = { mock: { name: 'Mock', package: '@ai-sdk/openai-compatible', env: ['MOCK_PROVIDER_KEY'], settings: { baseURL: `http://127.0.0.1:${mockPort}/v1` }, models: { [mockModel]: { name: mockModel, capabilities: { tools: true } } } } };
  }
  return cfg;
}

/**
 * Agent Hive configuration for an exercise: only the request's explicit per-role model overrides. Every other role
 * inherits the selected native model; there is no provider fallback and no all-role pin.
 */
export function exerciseHiveConfig({ agentMode, agentModels = {} }) {
  const agents = {};
  for (const [role, choice] of Object.entries(agentModels)) agents[role] = choice.variant ? { model: choice.model, variant: choice.variant } : { model: choice.model };
  return { agentMode, agents, customAgents: {} };
}

/** Native request descriptors for one host. Paths are relative to the in-container server; bodies are plain data. */
export function exerciseRoutes(id, directory) {
  if (id === 'v1') {
    return {
      createSession: () => ({ method: 'POST', path: `/session?directory=${encodeURIComponent(directory)}`, body: { title: 'exercise' } }),
      prompt: ({ sessionId, messageId, agent, model, text }) => ({
        method: 'POST', path: `/session/${sessionId}/prompt_async`,
        body: { messageID: messageId, agent, model: { providerID: splitModelRef(model.ref).providerID, modelID: splitModelRef(model.ref).modelID }, ...(model.variant ? { variant: model.variant } : {}), parts: [{ type: 'text', text }] },
      }),
      commands: () => ({ method: 'GET', path: '/command' }),
      command: ({ sessionId, messageId, agent, model, name, text }) => ({
        method: 'POST', path: `/session/${sessionId}/command`,
        body: { messageID: messageId, agent, model: model.ref, ...(model.variant ? { variant: model.variant } : {}), command: name, arguments: text },
      }),
      message: (sessionId, messageId) => ({ method: 'GET', path: `/session/${sessionId}/message/${messageId}` }),
      messages: (sessionId, { limit, before }) => ({ method: 'GET', path: `/session/${sessionId}/message?limit=${limit}${before ? `&before=${encodeURIComponent(before)}` : ''}` }),
      session: (sessionId) => ({ method: 'GET', path: `/session/${sessionId}` }),
      children: (sessionId) => ({ method: 'GET', path: `/session/${sessionId}/children` }),
      status: () => ({ method: 'GET', path: '/session/status' }),
      questions: () => ({ method: 'GET', path: '/question' }),
      questionReply: (_sessionId, requestId, answers) => ({ method: 'POST', path: `/question/${requestId}/reply`, body: { answers } }),
      permissions: () => ({ method: 'GET', path: '/permission' }),
      permissionReply: (_sessionId, requestId, decision) => ({ method: 'POST', path: `/permission/${requestId}/reply`, body: { reply: decision } }),
      interrupt: (sessionId) => ({ method: 'POST', path: `/session/${sessionId}/abort`, body: {} }),
      agents: () => ({ method: 'GET', path: '/agent' }),
      models: () => ({ method: 'GET', path: `/config/providers?directory=${encodeURIComponent(directory)}` }),
    };
  }
  return {
    createSession: ({ agent, model }) => ({
      method: 'POST', path: '/api/session',
      body: { title: 'exercise', agent, model: { providerID: splitModelRef(model.ref).providerID, id: splitModelRef(model.ref).modelID, ...(model.variant ? { variant: model.variant } : {}) }, location: { directory } },
    }),
    prompt: ({ sessionId, messageId, text }) => ({ method: 'POST', path: `/api/session/${sessionId}/prompt`, body: { id: messageId, text } }),
    commands: () => ({ method: 'GET', path: `/api/command?${v2LocationQuery(directory)}` }),
    command: ({ sessionId, name, text }) => ({ method: 'POST', path: `/api/session/${sessionId}/command`, body: { name, text } }),
    switchAgent: (sessionId, agent) => ({ method: 'POST', path: `/api/session/${sessionId}/agent`, body: { agent } }),
    message: (sessionId, messageId) => ({ method: 'GET', path: `/api/session/${sessionId}/message/${messageId}` }),
    messages: (sessionId, { limit, cursor }) => ({ method: 'GET', path: `/api/session/${sessionId}/message?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : '&order=asc'}` }),
    session: (sessionId) => ({ method: 'GET', path: `/api/session/${sessionId}` }),
    children: (sessionId, cursor) => ({ method: 'GET', path: `/api/session?parentID=${sessionId}&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : '&order=asc'}` }),
    active: () => ({ method: 'GET', path: '/api/session/active' }),
    // Jobs of the session and every descendant, settled ones included until they are consumed, and one session's
    // queued inbox: with `active`, the signals the pinned `opencode run` reads, in that order, before it calls a run done.
    jobs: (sessionId) => ({ method: 'GET', path: `/api/experimental/job?sessionID=${sessionId}&descendants=true` }),
    inbox: (sessionId) => ({ method: 'GET', path: `/api/session/${sessionId}/inbox` }),
    forms: (sessionId) => ({ method: 'GET', path: `/api/session/${sessionId}/form` }),
    form: (sessionId, formId) => ({ method: 'GET', path: `/api/session/${sessionId}/form/${formId}` }),
    formReply: (sessionId, formId, answer) => ({ method: 'POST', path: `/api/session/${sessionId}/form/${formId}/reply`, body: { answer } }),
    permissions: (sessionId) => ({ method: 'GET', path: `/api/session/${sessionId}/permission` }),
    permissionReply: (sessionId, requestId, decision) => ({ method: 'POST', path: `/api/session/${sessionId}/permission/${requestId}/reply`, body: { decision } }),
    interrupt: (sessionId) => ({ method: 'POST', path: `/api/session/${sessionId}/interrupt`, body: {} }),
    agents: () => ({ method: 'GET', path: `/api/agent?${v2LocationQuery(directory)}` }),
    models: () => ({ method: 'GET', path: `/api/model?${v2LocationQuery(directory)}` }),
  };
}

/**
 * The child session a dispatch call's text output names: v1's `task id="..."` or `sessionID="..."`, or the v2 launch
 * receipt's `(sessionID: ...)` (core/src/tool/plugin/subagent.ts). Null when the output names none.
 */
export function dispatchedChild(output) {
  const found = /(?:task id|sessionID)="(ses_[A-Za-z0-9]+)"|\(sessionID: (ses_[A-Za-z0-9]+)\)/.exec(typeof output === 'string' ? output : '');
  return found ? found[1] ?? found[2] : null;
}

/**
 * A v2 `<background-result kind="subagent">` report as the parent reads it (core/src/session/subagent-completion.ts
 * renders it through session/background-result.ts): the child and the state
 * attribute. The host sends one each time the child stops; `running` is interim (the child's own background work
 * continues and it will report again), while `completed`, `error` and `cancelled` are terminal. Null for other text.
 */
export function subagentReport(text) {
  const found = /^<background-result kind="subagent" sessionID="(ses_[A-Za-z0-9]+)" state="(running|completed|error|cancelled)"/.exec(typeof text === 'string' ? text : '');
  return found ? { child: found[1], state: found[2], terminal: found[2] !== 'running' } : null;
}

/**
 * The query that selects a location on the v2 server. The pinned server reads `location[directory]` or the
 * `x-opencode-directory` header and otherwise falls back to its own working directory (server/src/location.ts
 * requestRef), so a wrong selector is silently ignored; every v2 catalog read names the location with this.
 */
export function v2LocationQuery(directory) {
  return `location%5Bdirectory%5D=${encodeURIComponent(directory)}`;
}

/** Normalizes a native tool name to the host-neutral vocabulary used by scenario checks. */
export function neutralTool(name) {
  return { task: 'dispatch', subagent: 'dispatch', bash: 'shell', shell: 'shell' }[name] ?? name;
}

/** Host-neutral view of native tool arguments. */
export function neutralArgs(name, input) {
  const args = input && typeof input === 'object' ? input : {};
  switch (neutralTool(name)) {
    case 'dispatch':
      return { agent: args.subagent_type ?? args.agent, description: args.description, prompt: args.prompt, background: args.background === true };
    case 'read':
    case 'write':
    case 'edit':
      return { path: args.filePath ?? args.path };
    case 'skill':
      return { name: args.name ?? args.id };
    default:
      return args;
  }
}
