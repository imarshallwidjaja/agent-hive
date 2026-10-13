import { tool, type Plugin } from '@opencode-ai/plugin';
import {
  canonicalProjectRoot,
  detectContext,
  getNativeSessionsPath,
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
import { composeTaskBrief, TASK_BRIEF_BLOCK } from './task-brief.js';
import { createHiveServices, type RouteSnapshot } from './runtime/hive-services.js';
import { createHiveOperations, presentHiveResult } from './runtime/hive-tools.js';
import { buildRoleCatalog, createCommandContext as createSharedCommandContext } from './runtime/role-catalog.js';
import { mergePrimaryOnlyTools, nativeSubagentBoundary } from './runtime/role-policy.js';

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

/**
 * Matches a generated route snapshot block and its separator. The start marker must open the
 * generated heading line, so an authored prompt that quotes the marker pair inline is preserved.
 */
const ROUTE_SNAPSHOT_BLOCK = /(?:\n\n)?<!-- hive-route-snapshot:start -->\n## Hive route snapshot\n(?:(?!<!-- hive-route-snapshot:(?:start|end) -->)[\s\S])*?<!-- hive-route-snapshot:end -->/g;

function escapeRouteSnapshotMarkers(text: string): string {
  return text
    .replaceAll('<!-- hive-route-snapshot:start -->', '&lt;!-- hive-route-snapshot:start -->')
    .replaceAll('<!-- hive-route-snapshot:end -->', '&lt;!-- hive-route-snapshot:end -->');
}

function routeFooter(snapshot: RouteSnapshot, separated: boolean): string {
  const payload = {
    projectRoot: snapshot.projectRoot,
    featureRoute: { selected: snapshot.hasFeatureRoute, feature: snapshot.featureName ?? null },
  };
  const constraints = [
    `Session constraints (revision ${snapshot.sessionConstraints.revision}):\n${escapeRouteSnapshotMarkers(snapshot.sessionConstraints.constraints || '(none)')}`,
    snapshot.featureConstraints
      ? `Feature constraints for ${JSON.stringify(snapshot.featureName)} (revision ${snapshot.featureConstraints.revision}):\n${escapeRouteSnapshotMarkers(snapshot.featureConstraints.constraints || '(none)')}`
      : 'Feature constraints: (none)',
  ].join('\n\n');
  return [
    `${separated ? '\n\n' : ''}<!-- hive-route-snapshot:start -->`,
    '## Hive route snapshot',
    `Route snapshot (JSON): ${JSON.stringify(payload)}`,
    '',
    '## Standing Constraints',
    constraints,
    'This is a dispatch-time snapshot. If directives conflict, report the conflict; runtime routing does not decide it.',
    '<!-- hive-route-snapshot:end -->',
  ].join('\n');
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
  const ephemeralSessionIDs = new Set<string>();
  const taskTraceConfig = configService.get().taskTraceSummarizer ?? { temperature: 0 };
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
    sessionService.trackGlobal(binding.child, {
      parentSessionId: binding.parent,
      projectRoot: snapshot.projectRoot,
      featureName: snapshot.hasFeatureRoute ? snapshot.featureName : undefined,
      agent: binding.agent,
      standingConstraintEntries: snapshot.sessionConstraints.entries,
      standingConstraintsRevision: snapshot.sessionConstraints.revision,
      standingConstraints: snapshot.sessionConstraints.constraints || undefined,
    });
  };

  // V1 registration: each shared operation becomes a plugin tool whose result is the operation's JSON presentation.
  const hiveTools = Object.fromEntries(Object.entries(createHiveOperations(services)).map(([name, operation]) => [name, tool({
    description: operation.description,
    args: operation.args,
    execute: async (input, context) => presentHiveResult(operation, await operation.execute(input, { sessionID: context?.sessionID })),
  })]));
  const tools: Record<string, any> = {
    ...taskTraceTools,
    ...createBackgroundTools({
      backgroundJobService,
      projectRoot,
      isEnabled: isBackgroundSubagentsExperimentEnabled,
      currentRuntimeId: runtimeId,
      cancelRuntimeTask: async (sessionId) => {
        const result = await ctx.client.session.abort({ path: { id: sessionId }, query: { directory: projectRoot } });
        return { cancelled: result.data === true, message: result.data === true ? 'Runtime task abort requested.' : String(result.error ?? 'Abort not confirmed.') };
      },
    }),
    ...hiveTools,
  };

  let runtimeCommandAgents: Record<string, HiveCommandAgentDescriptor> = {};
  const createCommandContext = (): HiveCommandContext => createSharedCommandContext({
    host,
    configService,
    agents: runtimeCommandAgents,
    backgroundGuidance: { available: isBackgroundSubagentsExperimentEnabled(), reason: isBackgroundSubagentsExperimentEnabled() ? undefined : 'experiment-disabled' } as any,
  });

  return {
    tool: tools,
    command: buildHiveCommandMap(hiveCommandRenderers, createCommandContext),
    event: async (input) => {
      const binding = taskChildBinding(input.event);
      if (binding) {
        try { bindChildSnapshot(binding); }
        catch (error) { console.warn(`[hive:routing] child snapshot conflict for ${binding.child}: ${(error as Error).message}`); }
      }
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
      const agent = (input as { agent?: string }).agent ?? (input.sessionID ? runtimeSessionAgents.get(input.sessionID) : undefined);
      const prompt = agent ? runtimeAgentPrompts.get(agent) : undefined;
      const suffix = input.sessionID && runtimeTaskChildren.has(input.sessionID) ? SUBAGENT_CLARIFICATION_PROMPT : '';
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
        const snapshot = services.captureRoute(input.sessionID);
        dispatchSnapshots.set(`${input.sessionID}\0${input.callID}`, snapshot);
        const prompt = typeof output.args?.prompt === 'string'
          ? output.args.prompt.replace(ROUTE_SNAPSHOT_BLOCK, '').replace(TASK_BRIEF_BLOCK, '')
          : '';
        const agent = output.args?.subagent_type;
        const foragerDispatch = typeof agent === 'string'
          && classifySession(agent, configService.getCustomAgentConfigs()).baseAgent === 'forager-worker';
        const brief = foragerDispatch && snapshot.hasFeatureRoute && typeof snapshot.featureName === 'string'
          ? `\n\n${composeTaskBrief({ projectRoot, taskService, contextService }, snapshot.featureName, prompt)}`
          : '';
        output.args.prompt = `${prompt}${routeFooter(snapshot, prompt.length > 0)}${brief}`;
      }
      await backgroundAdapter['tool.execute.before'](input, output);
    },
    'tool.execute.after': async (input, output) => {
      try {
        await backgroundAdapter['tool.execute.after'](input, output);
        const child = input.tool === 'task' ? (output?.metadata as any)?.sessionId : undefined;
        if (typeof child === 'string' && input.callID) {
          const binding = { type: 'message.part.updated', properties: { part: { type: 'tool', tool: 'task', sessionID: input.sessionID, callID: input.callID, metadata: { sessionId: child }, state: { input: input.args } } } };
          const parsed = taskChildBinding(binding);
          if (parsed) {
            try { bindChildSnapshot(parsed); }
            catch (error) { console.warn(`[hive:routing] child snapshot conflict for ${parsed.child}: ${(error as Error).message}`); }
          }
        }
      } finally {
        if (input.tool === 'task' && input.callID) dispatchSnapshots.delete(`${input.sessionID}\0${input.callID}`);
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
      const agents: Record<string, any> = catalog.agents;
      runtimeCommandAgents = catalog.commandAgents;
      const nativeAgents = Object.fromEntries((['general', 'explore'] as const).map((name) => {
        const existing = mutableConfig.agent?.[name] ?? {};
        const boundary = nativeSubagentBoundary(name, existing.permission);
        if (boundary.warning) console.warn(boundary.warning);
        return [name, { ...existing, permission: boundary.permission }];
      }));
      mutableConfig.agent = { ...(mutableConfig.agent ?? {}), ...nativeAgents, ...agents, [TASK_TRACE_SUMMARIZER_AGENT]: { mode: 'primary', hidden: true, temperature: taskTraceConfig.temperature ?? 0, permission: { '*': 'deny' }, prompt: TASK_TRACE_SUMMARIZER_PROMPT } };
      const commandConfig = Object.fromEntries(await Promise.all(HIVE_COMMANDS.map(async (command) => [command.key, { description: command.description, ...('agent' in command ? { agent: command.agent } : {}), template: await hiveCommandRenderers[command.key]('$ARGUMENTS', createCommandContext()) }])));
      mutableConfig.command = { ...(mutableConfig.command ?? {}), ...commandConfig };
      mutableConfig.default_agent = catalog.defaultAgent;
      const experimental = typeof mutableConfig.experimental === 'object' && mutableConfig.experimental ? mutableConfig.experimental : {};
      mutableConfig.experimental = { ...experimental, primary_tools: mergePrimaryOnlyTools(experimental.primary_tools) };
    },
  };
};

export default plugin;
