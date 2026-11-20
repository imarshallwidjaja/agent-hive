import { tool, type Plugin } from '@opencode-ai/plugin';
import {
  canonicalProjectRoot,
  detectContext,
  getNativeSessionsPath,
  type SessionInfo,
} from 'hive-core';
import { prepareNativeHiveSkills } from './skills/native-materializer.js';
import { createBackgroundJobAdapter } from './background/backgroundJobAdapter.js';
import { createBackgroundTools } from './background/backgroundTools.js';
import { isBackgroundSubagentsExperimentEnabled } from './utils/background-gate.js';
import { SUBAGENT_CLARIFICATION_PROMPT } from './hooks/system-hook.js';
import { OPENCODE_V1_PROFILE } from './runtime/host-profile.js';
import { classifySession, createVariantHook } from './hooks/variant-hook.js';
import { buildHiveCommandMap } from './commands/runtime.js';
import { HIVE_COMMANDS } from './commands/registry.js';
import { hiveCommandRenderers } from './commands/renderers.js';
import type { HiveCommandAgentDescriptor, HiveCommandContext } from './commands/types.js';
import { createTaskTraceTools, injectTaskTraceHint, isDirectChildSession, TASK_TRACE_SUMMARIZER_AGENT, TASK_TRACE_SUMMARIZER_PROMPT } from './task-trace.js';
import { childAssociation, childRouteRecord, composeDispatchPrompt, provenChildBinding, resolveAssignment } from './task-brief.js';
import { createHiveServices, type RouteSnapshot } from './runtime/hive-services.js';
import { createHiveOperations, presentHiveResult } from './runtime/hive-tools.js';
import { buildRoleCatalog, createCommandContext as createSharedCommandContext } from './runtime/role-catalog.js';
import { LIVE_PARENT_CHECKED_TOOLS, authorizeHiveCall, createRolePolicy, mergePrimaryOnlyTools, nativeSubagentBoundary, resolveCallerAuthority } from './runtime/role-policy.js';
import { isRootSession } from './trace/v1-source.js';

function taskChildBinding(event: unknown): { parent: string; call: string; child: string; agent?: string } | undefined {
  if (!event || typeof event !== 'object') return undefined;
  const record = event as Record<string, any>;
  const part = record.type === 'message.part.updated' ? record.properties?.part : undefined;
  if (part?.type !== 'tool' || part.tool !== 'task' || typeof part.sessionID !== 'string' || typeof part.callID !== 'string') return undefined;
  const state = part.state && typeof part.state === 'object' ? part.state : undefined;
  const child = part.metadata?.sessionId ?? state?.metadata?.sessionId;
  if (typeof child !== 'string' || !child.trim()) return undefined;
  return {
    parent: part.sessionID,
    call: part.callID,
    child,
    ...(typeof state?.input?.subagent_type === 'string' ? { agent: state.input.subagent_type } : {}),
  };
}

const plugin: Plugin = async (ctx) => {
  const workTarget = ctx.project?.id === 'global' && ctx.worktree === '/' ? ctx.directory : ctx.worktree || ctx.directory;
  const detected = detectContext(workTarget);
  const projectRoot = canonicalProjectRoot(detected.projectRoot);
  const runtimeId = `pid-${process.pid}-${Date.now().toString(36)}`;
  // This entry is the OpenCode v1 server; the v2 adapter builds its own profile.
  const host = OPENCODE_V1_PROFILE;

  const services = createHiveServices({ projectRoot, detectedFeature: detected.feature, nativeObservationOwner: 'opencode-v1' });
  const { sessionService, contextService, taskService, configService, backgroundJobService } = services;
  const runtimeAgentPrompts = new Map<string, string>();
  const runtimeSessionAgents = new Map<string, string>();
  const runtimeTaskChildren = new Set<string>();
  const dispatchSnapshots = new Map<string, RouteSnapshot>();
  // The child binding each captured task call wrote, or what the stored binding proves when its write failed.
  const confirmedChildren = new Map<string, SessionInfo>();
  const ephemeralSessionIDs = new Set<string>();
  const taskTraceConfig = configService.get().taskTraceSummarizer ?? {};
  const configFallbackWarning = services.configFallbackWarning;
  if (configFallbackWarning) {
    const message = `[hive:config] ${configFallbackWarning}`;
    const client = ctx.client as unknown as { notify?: (payload: { type: string; level: string; title: string; message: string }) => unknown; notification?: { create?: (payload: { type: string; level: string; title: string; message: string }) => unknown } };
    const notified = client.notify?.({ type: 'warning', level: 'warning', title: 'Agent Hive Config Warning', message })
      || client.notification?.create?.({ type: 'warning', level: 'warning', title: 'Agent Hive Config Warning', message });
    if (!notified) console.warn(message);
  }
  const taskTraceClient = ctx.client as unknown as Parameters<typeof createTaskTraceTools>[0]['client'];
  const taskTraceTools = createTaskTraceTools({
    client: taskTraceClient,
    directory: projectRoot,
    summarizer: taskTraceConfig,
    ephemeralSessionIDs,
  });
  const backgroundAdapter = createBackgroundJobAdapter({
    projectRoot,
    service: backgroundJobService,
    isEnabled: isBackgroundSubagentsExperimentEnabled,
    runtimeId,
    getSession: (sessionId) => sessionService.getGlobal(sessionId),
    getBoundChild: ({ childSessionId, parentSessionId, callId }) => {
      const confirmed = callId === undefined ? undefined : confirmedChildren.get(`${parentSessionId}\0${callId}`);
      return confirmed?.sessionId === childSessionId ? confirmed : undefined;
    },
  });

  const bindChildSnapshot = (binding: { parent: string; call: string; child: string; agent?: string }): void => {
    runtimeTaskChildren.add(binding.child);
    const key = `${binding.parent}\0${binding.call}`;
    const snapshot = dispatchSnapshots.get(key);
    if (!snapshot) return;
    const existing = sessionService.getGlobal(binding.child);
    if (existing?.parentSessionId !== undefined && existing.parentSessionId !== binding.parent) {
      throw new Error('existing child snapshot parent cannot change');
    }
    const stored = existing?.parentSessionId === binding.parent ? existing : undefined;
    const route = childRouteRecord(snapshot, binding.parent, binding.agent);
    const association = childAssociation(snapshot);
    try {
      confirmedChildren.set(key, sessionService.trackGlobal(binding.child, { ...route, ...association }));
    } catch (error) {
      // An earlier write of this call still stands; otherwise the launch row gets only what the old binding proves.
      const proven = confirmedChildren.has(key) ? undefined : provenChildBinding(stored, route, association);
      if (proven) confirmedChildren.set(key, proven);
      throw error;
    }
  };

  // V1 reports a failed child binding and lets the native task call continue.
  const bindReportedChild = (binding: { parent: string; call: string; child: string; agent?: string }): void => {
    try {
      bindChildSnapshot(binding);
    } catch (error) {
      console.warn(`[hive:routing] could not bind child session ${binding.child} to the route call ${binding.call} captured (${(error as Error).message}); whether this attempt changed the stored binding is unknown, and a launch row of this call names only the feature, task or run that the binding read before the attempt proves for the call.`);
    }
  };

  /** A read-only lookup of the session's persisted record; an unreadable index reads as no record and is left as found. */
  const readStoredSession = (sessionID: string) => {
    try {
      return sessionService.peekGlobal(sessionID);
    } catch (error) {
      console.warn(`[hive:sessions] Could not read session ${sessionID} from ${getNativeSessionsPath(projectRoot, services.nativeObservationOwner)}: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  };

  // Permissions decide v1 access for most tools; the authored writes and the council roster also check the caller's
  // role and live parent here, failing closed when the session cannot be read. The session is read in its own directory.
  const guardLiveParent = async (name: string, context: { sessionID?: string; agent?: string; directory?: string } | undefined): Promise<void> => {
    if (!LIVE_PARENT_CHECKED_TOOLS.includes(name)) return;
    const sessionID = context?.sessionID;
    const root = sessionID ? await isRootSession(taskTraceClient, context?.directory ?? projectRoot, sessionID) : undefined;
    if (root === undefined) throw new Error(`Hive could not read session ${sessionID ?? '(none)'} to check its parent; ${name} is denied.`);
    const customAgents = configService.getCustomAgentConfigs();
    const policy = createRolePolicy(customAgents);
    const decision = authorizeHiveCall(policy, { tool: name, caller: resolveCallerAuthority(context?.agent ?? '', policy, customAgents), isChild: !root });
    if ('reason' in decision) throw new Error(decision.reason);
  };

  // The agents commands and council rosters read, built by the config hook. V1 configuration is fixed after startup,
  // so the catalog that hook builds, with each operator `disable`, is the live one; before it runs there is none.
  let runtimeCommandAgents: Record<string, HiveCommandAgentDescriptor> | undefined;
  const readCouncilAgents = async () => {
    if (!runtimeCommandAgents) throw new Error('Hive agent catalog not initialized');
    return runtimeCommandAgents;
  };

  // V1 registration: each shared operation becomes a plugin tool whose result is the operation's JSON presentation.
  const hiveTools = Object.fromEntries(Object.entries(createHiveOperations(services, readCouncilAgents)).map(([name, operation]) => [name, tool({
    description: operation.description,
    args: operation.args,
    execute: async (input, context) => {
      await guardLiveParent(name, context);
      return presentHiveResult(operation, await operation.execute(input, { sessionID: context?.sessionID, agent: context?.agent, signal: context?.abort }));
    },
  })]));
  const tools: Record<string, any> = {
    ...taskTraceTools,
    ...createBackgroundTools({
      backgroundJobService,
      projectRoot,
      isEnabled: isBackgroundSubagentsExperimentEnabled,
      currentRuntimeId: runtimeId,
      unrecordedLaunches: backgroundAdapter.unrecordedLaunches,
      cancelRuntimeTask: async (sessionId) => {
        const result = await ctx.client.session.abort({ path: { id: sessionId }, query: { directory: projectRoot } });
        return { cancelled: result.data === true, message: result.data === true ? 'Runtime task abort requested.' : String(result.error ?? 'Abort not confirmed.') };
      },
    }),
    ...hiveTools,
  };

  const createCommandContext = (): HiveCommandContext => createSharedCommandContext({
    host,
    configService,
    agents: runtimeCommandAgents ?? {},
    backgroundGuidance: { available: isBackgroundSubagentsExperimentEnabled(), reason: isBackgroundSubagentsExperimentEnabled() ? undefined : 'experiment-disabled' } as any,
  });

  return {
    tool: tools,
    command: buildHiveCommandMap(hiveCommandRenderers, createCommandContext),
    event: async (input) => {
      const binding = taskChildBinding(input.event);
      if (binding) bindReportedChild(binding);
      await backgroundAdapter.event(input);
    },
    'chat.message': (async (input, output) => {
      const agent = (input as { agent?: string }).agent ?? output.message.agent;
      if (agent) {
        runtimeSessionAgents.set(input.sessionID, agent);
        try {
          sessionService.trackGlobal(input.sessionID, { agent, projectRoot });
        } catch (error) {
          const reason = error instanceof Error ? (error as NodeJS.ErrnoException).code ?? error.name : 'unknown error';
          console.warn(`[hive:sessions] Could not track session ${input.sessionID} in ${getNativeSessionsPath(projectRoot, services.nativeObservationOwner)} (${reason}); continuing reply.`);
        }
      }
      await createVariantHook(configService)(input, output);
    }) as any,
    'experimental.chat.system.transform': async (input, output) => {
      // v1 passes only the session and model here, and a compaction request reaches this hook without a
      // `chat.message` first, so after a restart the process caches are empty. The persisted session record (agent from
      // its last message, parent from its dispatch binding) then selects the instructions; it grants no authority.
      const sessionID = input.sessionID;
      const cachedAgent = (input as { agent?: string }).agent ?? (sessionID ? runtimeSessionAgents.get(sessionID) : undefined);
      const cachedChild = sessionID ? runtimeTaskChildren.has(sessionID) : false;
      const stored = sessionID && (cachedAgent === undefined || !cachedChild) ? readStoredSession(sessionID) : undefined;
      const agent = cachedAgent ?? stored?.agent;
      const prompt = agent ? runtimeAgentPrompts.get(agent) : undefined;
      const suffix = cachedChild || stored?.parentSessionId !== undefined ? SUBAGENT_CLARIFICATION_PROMPT : '';
      if (!prompt && !suffix) return;
      output.system[0] = `${output.system[0] ?? ''}\n\n${prompt ?? ''}${suffix}`;
    },
    'experimental.chat.messages.transform': async (_input, output) => {
      const sessionID = output.messages?.[0]?.info?.sessionID;
      if (!sessionID) return;
      await backgroundAdapter['experimental.chat.messages.transform'](_input, output);
      await injectTaskTraceHint(output.messages, (childID, parentID) => (
        isDirectChildSession(taskTraceClient, projectRoot, childID, parentID)
      ));
    },
    'tool.execute.before': async (input, output) => {
      if (input.tool === 'task' && input.sessionID && input.callID) {
        const captured = services.captureRoute(input.sessionID);
        const snapshot = { ...captured, assignment: await resolveAssignment(services, captured, output.args?.prompt) };
        dispatchSnapshots.set(`${input.sessionID}\0${input.callID}`, snapshot);
        const agent = output.args?.subagent_type;
        const foragerDispatch = typeof agent === 'string'
          && classifySession(agent, configService.getCustomAgentConfigs()).baseAgent === 'forager-worker';
        output.args.prompt = composeDispatchPrompt({ sources: { projectRoot, taskService, contextService }, snapshot, prompt: output.args?.prompt, foragerDispatch });
      }
      await backgroundAdapter['tool.execute.before'](input, output);
    },
    'tool.execute.after': async (input, output) => {
      try {
        // The child is bound first, so a background launch row takes its feature, task and run from the binding this
        // call confirmed.
        const child = input.tool === 'task' ? (output?.metadata as any)?.sessionId : undefined;
        if (typeof child === 'string' && input.callID) {
          const binding = { type: 'message.part.updated', properties: { part: { type: 'tool', tool: 'task', sessionID: input.sessionID, callID: input.callID, metadata: { sessionId: child }, state: { input: input.args } } } };
          const parsed = taskChildBinding(binding);
          if (parsed) bindReportedChild(parsed);
        }
        await backgroundAdapter['tool.execute.after'](input, output);
      } finally {
        if (input.tool === 'task' && input.callID) {
          dispatchSnapshots.delete(`${input.sessionID}\0${input.callID}`);
          confirmedChildren.delete(`${input.sessionID}\0${input.callID}`);
        }
      }
    },
    config: async (opencodeConfig) => {
      const mutableConfig = opencodeConfig as any;
      configService.init();
      const existingSkills = typeof mutableConfig.skills === 'object' && mutableConfig.skills ? mutableConfig.skills : {};
      const prepared = await prepareNativeHiveSkills({ host, directory: projectRoot, worktree: workTarget, disableSkills: configService.getDisabledSkills(), opencodeConfig: { skills: existingSkills } });
      mutableConfig.skills = { ...existingSkills, paths: prepared.skillPaths };
      mutableConfig.subagent_depth = 2;
      const catalog = buildRoleCatalog(host, configService, prepared);
      runtimeAgentPrompts.clear();
      for (const [name, prompt] of catalog.requestPrompts) runtimeAgentPrompts.set(name, prompt);
      // Config hooks run after OpenCode's deprecated tools normalization. Ordered permissions are enforced at agent construction.
      // An operator's `disable: true` on a Hive subagent survives the merge below and marks that agent unavailable.
      const agents: Record<string, any> = {};
      const commandAgents: Record<string, HiveCommandAgentDescriptor> = {};
      for (const [name, entry] of Object.entries(catalog.agents)) {
        const disabled = entry.mode === 'subagent' && mutableConfig.agent?.[name]?.disable === true;
        agents[name] = disabled ? { ...entry, disable: true } : entry;
        commandAgents[name] = disabled ? { ...catalog.commandAgents[name]!, available: false } : catalog.commandAgents[name]!;
      }
      runtimeCommandAgents = commandAgents;
      const nativeAgents = Object.fromEntries((['general', 'explore'] as const).map((name) => {
        const existing = mutableConfig.agent?.[name] ?? {};
        const boundary = nativeSubagentBoundary(name, existing.permission);
        if (boundary.warning) console.warn(boundary.warning);
        return [name, { ...existing, permission: boundary.permission }];
      }));
      mutableConfig.agent = { ...(mutableConfig.agent ?? {}), ...nativeAgents, ...agents, [TASK_TRACE_SUMMARIZER_AGENT]: { mode: 'primary', hidden: true, permission: { '*': 'deny' }, prompt: TASK_TRACE_SUMMARIZER_PROMPT } };
      const commandConfig = Object.fromEntries(await Promise.all(HIVE_COMMANDS.map(async (command) => {
        const template = await hiveCommandRenderers[command.key]('$ARGUMENTS', createCommandContext());
        return [command.key, { description: command.description, ...('agent' in command ? { agent: command.agent } : {}), template }];
      })));
      mutableConfig.command = { ...(mutableConfig.command ?? {}), ...commandConfig };
      mutableConfig.default_agent = catalog.defaultAgent;
      const experimental = typeof mutableConfig.experimental === 'object' && mutableConfig.experimental ? mutableConfig.experimental : {};
      mutableConfig.experimental = { ...experimental, primary_tools: mergePrimaryOnlyTools(experimental.primary_tools) };
    },
  };
};

export default plugin;
