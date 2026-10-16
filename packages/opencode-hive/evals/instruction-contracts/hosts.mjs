// Stock-host knowledge shared by the host-side runner (run.mjs) and the in-container fixture (fixture.ts).
// Every fact here is tied to the exact qualified host version; changing a version means re-deriving the facts.

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
    version: '2.0.26',
    binary: '/opt/ic/v2/node_modules/.bin/opencode2',
    // packages/core/src/integration.ts@v2.0.26 connection.resolve refreshes when
    // `expires <= now + 5 minutes`; `expires` is epoch milliseconds.
    refreshWindowMs: 5 * 60_000,
    // packages/protocol/src/groups/credential.ts: POST /api/credential with Credential.CreateInput. The
    // `chatgpt-browser` method (plugin/provider/openai.ts) uses the Codex backend with metadata.accountID.
    auth: { method: 'POST', path: '/api/credential' },
    readyPath: '/api/info',
    configFile: 'opencode.jsonc',
  },
};

// Hive role identifiers composed by src/runtime/role-catalog.ts.
export const HIVE_ROLES = [
  'hive-master', 'architect-planner', 'swarm-orchestrator', 'hive-builder', 'scout-researcher', 'forager-worker',
  'hive-helper', 'plan-reviewer', 'code-reviewer', 'simplicity-reviewer', 'approach-advisor', 'vulnerability-reviewer',
  'dash-reviewer', 'vulnerability-review-primary',
];

export const HIVE_COMMANDS = [
  'interview', 'grill', 'implementation-brief', 'hive-plan', 'approve-sync-plan', 'start-execution',
  'council-directive', 'council', 'dash-review', 'vuln-review', 'compact-summary',
];

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
// targets, approval and sync, report and handoff publication, and hash-guarded context operations. Each must carry a
// non-empty description on the surface the host actually shows the model: the direct tool schema, or the Code Mode
// declaration for a read exposed there. Other undescribed fields are listed for information only.
const MERGE_FIELDS = ['strategy', 'message', 'preserveConflicts', 'cleanup', 'sourceCommit', 'sourceCommits', 'expectedTarget', 'expectedTargets'];
export const TOOL_FIELD_CONTRACT = Object.freeze({
  hive_worktree_create: ['baseRef', 'repoIds', 'candidate'],
  hive_worktree_inspect: ['repoIds', 'candidate'],
  hive_worktree_merge: ['repoIds', 'candidate', ...MERGE_FIELDS],
  hive_worktree_cleanup: ['repoIds', 'candidate', 'deleteBranch', 'discard'],
  hive_adhoc_worktree_create: ['runId', 'repoIds', 'sourceDirectory'],
  hive_adhoc_worktree_inspect: ['repoIds', 'sourceDirectory'],
  hive_adhoc_worktree_merge: ['repoIds', 'sourceDirectory', ...MERGE_FIELDS],
  hive_adhoc_worktree_cleanup: ['repoIds', 'sourceDirectory', 'deleteBranch', 'discard'],
  hive_plan_approve: ['expectedRevision', 'sync', 'refreshPending'],
  hive_tasks_sync: ['refreshPending'],
  hive_task_update: ['status', 'blocker', 'report', 'handoff'],
  hive_context_read: ['name', 'scope', 'view', 'query', 'limit', 'cursor', 'maxBytes', 'scanChars'],
  hive_context_write: ['content', 'kind', 'task', 'expectedRevision', 'expectedContentHash', 'scope'],
  hive_context_append: ['content', 'section', 'task', 'expectedRevision', 'expectedContentHash', 'scope'],
  hive_context_archive: ['reason', 'expectedRevision', 'expectedContentHashes', 'scope'],
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
 * Native configuration for one host. `provider` is 'mock' (credential-free scripted provider on loopback) or 'openai'.
 * `permissive` adds a global allow rule so headless runs cannot block on permission prompts; Hive's own role guards
 * still apply. Wiring runs `permissive: false` to observe stock permissions.
 */
export function hostConfig(id, { provider, model, mockPort, serverPort, userSkillsDir, observer, permissive = true }) {
  const modelRef = provider === 'mock' ? `mock/${model}` : `openai/${model}`;
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
          models: { [model]: { name: model, tool_call: true, limit: { context: 200000, output: 8192 } } },
        },
      };
    }
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
        models: { [model]: { name: model, capabilities: { tools: true } } },
      },
    };
  }
  return cfg;
}

/** Agent Hive global configuration: every Hive role uses the one frozen model so no default provider is contacted. */
export function hiveConfig({ provider, model, variant, agentMode }) {
  const modelRef = provider === 'mock' ? `mock/${model}` : `openai/${model}`;
  const agents = {};
  for (const role of HIVE_ROLES) {
    if (role === 'dash-reviewer' || role === 'vulnerability-review-primary') continue;
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
export function runArgs(id, { port, session, agent, modelRef, prompt, command }) {
  const base = id === 'v1'
    ? ['run', '--attach', `http://127.0.0.1:${port}`]
    : ['run', '--server', `http://127.0.0.1:${port}`];
  const args = [...base, '--session', session, '--agent', agent, '--format', 'json'];
  if (modelRef) args.push('--model', modelRef);
  if (command) args.push('--command', command);
  args.push(prompt);
  return args;
}

/**
 * Translates a host-neutral scripted step into the native tool call the mock provider emits. `tools` is the
 * provider-facing tool list from the current request; Hive reads that v2 exposes only through Code Mode are wrapped
 * in `execute`.
 */
export function nativeToolCall(id, step, tools) {
  const has = (name) => tools.includes(name);
  switch (step.op) {
    case 'hive':
      if (has(step.tool)) return { tool: step.tool, args: step.args ?? {} };
      if (id === 'v2' && has('execute')) {
        return { tool: 'execute', args: { code: `return await tools.${step.tool}(${JSON.stringify(step.args ?? {})})` } };
      }
      return { tool: step.tool, args: step.args ?? {} };
    case 'dispatch':
      return id === 'v1'
        ? { tool: 'task', args: { subagent_type: step.agent, description: step.description ?? 'fixture step', prompt: step.prompt } }
        : { tool: 'subagent', args: { agent: step.agent, description: step.description ?? 'fixture step', prompt: step.prompt, background: false } };
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
