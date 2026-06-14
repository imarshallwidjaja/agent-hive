import * as path from 'path';
import * as fs from 'fs';
import { tool, type Plugin } from "@opencode-ai/plugin";
import { prepareNativeHiveSkills } from './skills/native-materializer.js';
import type { PreparedHiveSkill, PreparedNativeHiveSkills, PreparedNativeSkill } from './skills/native-materializer.js';
// Bee agents (lean, focused)
import { QUEEN_BEE_PROMPT } from './agents/hive.js';
import { ARCHITECT_BEE_PROMPT } from './agents/architect.js';
import { SWARM_BEE_PROMPT } from './agents/swarm.js';
import { SCOUT_BEE_PROMPT } from './agents/scout.js';
import { FORAGER_BEE_PROMPT } from './agents/forager.js';
import { HIVE_HELPER_PROMPT } from './agents/hive-helper.js';
import { HIVE_BUILDER_PROMPT } from './agents/hive-builder.js';
import { PLAN_REVIEWER_PROMPT } from './agents/plan-reviewer.js';
import { CODE_REVIEWER_PROMPT } from './agents/code-reviewer.js';
import { SIMPLICITY_REVIEWER_PROMPT } from './agents/simplicity-reviewer.js';
import { APPROACH_ADVISOR_PROMPT } from './agents/approach-advisor.js';
import { buildCustomSubagents } from './agents/custom-agents.js';
import { createBuiltinMcps } from './mcp/index.js';

const BACKGROUND_DELEGATION_SKILL_ID = 'background-delegation';

function isTruthyEnv(value: string | undefined): boolean {
  if (value === undefined) return false;
  const normalized = value.trim().toLowerCase();
  return normalized !== '' && normalized !== '0' && normalized !== 'false' && normalized !== 'no';
}

function isBackgroundSubagentsExperimentEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return isTruthyEnv(env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS)
    || isTruthyEnv(env.OPENCODE_EXPERIMENTAL);
}

function blankToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeOptionalStringList(values: string[] | undefined): string[] | undefined {
  const normalized = values
    ?.map((value) => value.trim())
    .filter(Boolean);
  return normalized && normalized.length > 0 ? normalized : undefined;
}

/**
 * Build compact auto-load skill guidance for an agent.
 * Native discovered skills win over Hive bundled skills so user/native definitions can shadow Hive bundles.
 */
function buildAutoLoadSkillsPromptAppendix(
  agentName: string,
  configService: ConfigService,
  nativeSkillsByName: Map<string, PreparedNativeSkill>,
  eligibleHiveSkills: Map<string, PreparedHiveSkill>,
  skippedHiveSkills: Map<string, PreparedNativeHiveSkills['skipped'][number]>,
  autoLoadSkillsOverride?: string[],
): string {
  const autoLoadSkills = autoLoadSkillsOverride
    ?? (configService.getAgentConfig(agentName).autoLoadSkills ?? []);

  if (autoLoadSkills.length === 0) {
    return '';
  }

  const skillNames: string[] = [];

  for (const skillId of autoLoadSkills) {
    const nativeSkill = nativeSkillsByName.get(skillId);
    if (nativeSkill) {
      skillNames.push(nativeSkill.name);
      continue;
    }

    const bundledSkill = eligibleHiveSkills.get(skillId);
    if (bundledSkill) {
      skillNames.push(bundledSkill.name);
      continue;
    }

    const skippedSkill = skippedHiveSkills.get(skillId);
    if (skippedSkill?.reason === 'disabled') {
      console.warn(
        `[hive] Auto-load skill "${skillId}" was not added to guidance for agent "${agentName}" because it is disabled in Hive config.`,
      );
      continue;
    }

    if (skippedSkill?.reason === 'url-scan-incomplete') {
      console.warn(
        `[hive] Auto-load skill "${skillId}" was not added to guidance for agent "${agentName}" because configured skills URLs could not be fully scanned for conflicts during this config-hook run.`,
      );
      continue;
    }

    console.warn(
      `[hive] Auto-load skill "${skillId}" was not added to guidance for agent "${agentName}" because it was not found in OpenCode native skill discovery or eligible Hive bundled skills.`,
    );
  }

  if (skillNames.length === 0) {
    return '';
  }

  const skillCalls = skillNames
    .map((skillName) => `- \`skill({ name: ${JSON.stringify(skillName)} })\``)
    .join('\n');
  return `\n\n## Configured Auto-Load Skills
High-priority instruction: load these OpenCode native skills with the \`skill\` tool before work covered by them.
${skillCalls}
Follow the loaded skill output. Skill bodies are not preloaded.`;
}

function buildBackgroundDelegationPromptAppendix(
  agentName: string,
  nativeSkillsByName: Map<string, PreparedNativeSkill>,
  eligibleHiveSkills: Map<string, PreparedHiveSkill>,
  skippedHiveSkills: Map<string, PreparedNativeHiveSkills['skipped'][number]>,
  env: Record<string, string | undefined> = process.env,
): string {
  if (!isBackgroundSubagentsExperimentEnabled(env)) return '';

  if (nativeSkillsByName.has(BACKGROUND_DELEGATION_SKILL_ID) || eligibleHiveSkills.has(BACKGROUND_DELEGATION_SKILL_ID)) {
    return `\n\n## Background-First Orchestration\nOpenCode background subagents are enabled for this session. This appendix is the gate-open policy boundary: when this heading is present, background-delegation governs scheduling and wait mode; other loaded skills govern domain workflow and safety. On non-trivial work, operate in background-first scheduler mode: first look for independent background lanes that can run through native task({ background: true, ... }) while you continue safe foreground work. Before launching or managing background lanes, load/use skill({ name: "background-delegation" }). Track work with hive_background_status, wait for native completion notification before dependent decisions, reconcile terminal native jobs with hive_background_reconcile or hive_background_reconcile_batch, and request cancellation with hive_background_cancel. Allowed foreground/blocking escape reasons: dependency, risk, simplicity, user interaction, or ownership conflict. Gate-closed sessions keep the normal direct/blocking workflow and must not simulate background orchestration.`;
  }

  const skippedSkill = skippedHiveSkills.get(BACKGROUND_DELEGATION_SKILL_ID);
  if (skippedSkill?.reason === 'disabled') {
    console.warn(`[hive] Background delegation guidance was not advertised for agent "${agentName}" because skill "${BACKGROUND_DELEGATION_SKILL_ID}" is disabled in Hive config.`);
    return '';
  }

  if (skippedSkill?.reason === 'url-scan-incomplete') {
    console.warn(`[hive] Background delegation guidance was not advertised for agent "${agentName}" because configured skills URLs could not be fully scanned for conflicts during this config-hook run.`);
    return '';
  }

  console.warn(`[hive] Background delegation guidance was not advertised for agent "${agentName}" because skill "${BACKGROUND_DELEGATION_SKILL_ID}" was not found in OpenCode native skill discovery or eligible Hive bundled skills.`);
  return '';
}

type CompatibleCustomAgentConfig = {
  baseAgent: CustomAgentBase;
  description: string;
  autoLoadSkills?: string[];
};

function getCustomAgentConfigsCompat(configService: ConfigService): Record<string, CompatibleCustomAgentConfig> {
  const serviceWithMethod = configService as ConfigService & {
    getCustomAgentConfigs?: () => Record<string, CompatibleCustomAgentConfig>;
    get?: () => { customAgents?: Record<string, unknown> };
  };

  if (typeof serviceWithMethod.getCustomAgentConfigs === 'function') {
    return serviceWithMethod.getCustomAgentConfigs();
  }

  const rawConfig = serviceWithMethod.get?.() as { customAgents?: Record<string, unknown> } | undefined;
  const rawCustomAgents = rawConfig?.customAgents;
  if (!rawCustomAgents || typeof rawCustomAgents !== 'object') {
    return {};
  }

  const compatibleEntries = Object.entries(rawCustomAgents).flatMap(([name, config]) => {
    if (!config || typeof config !== 'object') {
      return [];
    }

    const record = config as Record<string, unknown>;
    const baseAgent = record.baseAgent;
    if (typeof baseAgent !== 'string' || !(CUSTOM_AGENT_BASES as readonly string[]).includes(baseAgent)) {
      return [];
    }

    return [[name, {
      baseAgent: baseAgent as CustomAgentBase,
      description: typeof record.description === 'string' ? record.description : 'Custom subagent',
      autoLoadSkills: Array.isArray(record.autoLoadSkills)
        ? record.autoLoadSkills.filter((skill): skill is string => typeof skill === 'string')
        : [],
    } satisfies CompatibleCustomAgentConfig]];
  });

  return Object.fromEntries(compatibleEntries);
}

// ============================================================================
import {
  WorktreeService,
  AdhocWorktreeService,
  FeatureService,
  PlanService,
  TaskService,
  ContextService,
  ConfigService,
  RepositoryService,
  RepositoryManifestService,
  CUSTOM_AGENT_BASES,
  DockerSandboxService,
  BackgroundJobService,
  SessionService,
  buildEffectiveDependencies,
  computeRunnableAndBlocked,
  detectContext,
  normalizePath,
  resolveFeatureDirectoryName,
  type CustomAgentBase,
  type WorktreeInfo,
  type AdhocWorktreeInfo,
  type AdhocCommitResult,
  type AdhocMergeResult,
  type AdhocCleanupResult,
} from "hive-core";
import { buildWorkerPrompt, type ContextFile as WorkerPromptContextFile, type CompletedTask } from "./utils/worker-prompt";
import { calculatePromptMeta, calculatePayloadMeta, checkWarnings } from "./utils/prompt-observability";
import { applyTaskBudget, applyContextBudget, DEFAULT_BUDGET, type TruncationEvent } from "./utils/prompt-budgeting";
import { writeWorkerPromptFile } from "./utils/prompt-file";
import { formatRelativeTime } from "./utils/format";
import { createVariantHook } from "./hooks/variant-hook.js";
import { HIVE_SYSTEM_PROMPT, shouldExecuteHook } from "./hooks/system-hook.js";
import { HIVE_COMMANDS, HIVE_TOOL_NAMES } from './utils/plugin-manifest.js';
import { createBackgroundJobAdapter } from './background/backgroundJobAdapter.js';
import { createBackgroundTools } from './background/backgroundTools.js';

/**
 * Core plugin implementation.
 */
type ToolContext = {
  sessionID: string;
  messageID: string;
  agent: string;
  abort: AbortSignal;
};

type SystemTransformHook = (
  input: { sessionID?: string; agent?: string },
  output: { system: string[] },
) => Promise<void>;

const plugin: Plugin = async (ctx) => {
  const { directory, client, worktree } = ctx;

  const emitConfigWarning = (message: string): void => {
    const prefixedMessage = `[hive:config] ${message}`;
    const maybeClient = client as unknown as {
      notify?: (payload: { type?: string; level?: string; title?: string; message: string }) => unknown;
      notification?: {
        create?: (payload: { type?: string; level?: string; title?: string; message: string }) => unknown;
      };
    };

    const notified =
      (typeof maybeClient.notify === 'function' && maybeClient.notify({
        type: 'warning',
        level: 'warning',
        title: 'Agent Hive Config Warning',
        message: prefixedMessage,
      })) ||
      (typeof maybeClient.notification?.create === 'function' && maybeClient.notification.create({
        type: 'warning',
        level: 'warning',
        title: 'Agent Hive Config Warning',
        message: prefixedMessage,
      }));

    if (!notified) {
      console.warn(prefixedMessage);
    }
  };

  const featureService = new FeatureService(directory);
  const planService = new PlanService(directory);
  const taskService = new TaskService(directory);
  const contextService = new ContextService(directory);
  const configService = new ConfigService(directory);
  const sessionService = new SessionService(directory);
  const backgroundJobService = new BackgroundJobService(directory);
  const runtimeAgentPrompts = new Map<string, string>();
  const disabledMcps = configService.getDisabledMcps();
  const configFallbackWarning = configService.getLastFallbackWarning()?.message ?? null;
  if (configFallbackWarning) {
    emitConfigWarning(configFallbackWarning);
  }
  const builtinMcps = createBuiltinMcps(disabledMcps);
  const repositoryService = new RepositoryService(directory, configService);
  const repositoryManifestService = new RepositoryManifestService(directory);
  const hasRepositoryManifest = (): boolean => {
    // Only treat the project as multi-repo when an explicit project-scoped
    // `repositories` manifest exists. Without a manifest, RepositoryService
    // would return an implicit `[{ id: 'root' }]` for any git project — but
    // that would force every task to declare Repos and break legacy projects.
    // Global manifests are intentionally ignored here for orchestration.
    const projectConfig = configService.getProjectConfig();
    return Array.isArray(projectConfig?.repositories) && projectConfig.repositories.length > 0;
  };
  const isProjectRootGitRepo = (): boolean => {
    // `.git` may be a directory (normal repo) or a file (git worktree link).
    return fs.existsSync(path.join(directory, '.git'));
  };
  const worktreeService = new WorktreeService({
    baseDir: directory,
    hiveDir: path.join(directory, '.hive'),
    repositoryResolver: {
      // When a project repository manifest exists, resolve through
      // RepositoryService and let its explicit errors (missing repo path,
      // duplicate id, etc.) propagate so worktree creation fails loud before
      // any filesystem changes. When no manifest is configured, preserve
      // implicit legacy single-worktree behavior for git project roots by
      // returning [] (WorktreeService then falls back to the legacy path).
      // For non-git roots without a manifest, fail loud with explicit
      // manifest-required wording instead of letting the legacy git path
      // produce a cryptic git error. Global manifests are intentionally
      // ignored for orchestration.
      resolveRepositories: () => {
        if (hasRepositoryManifest()) {
          return repositoryService.resolveRepositories();
        }
        if (!isProjectRootGitRepo()) {
          throw new Error(
            `Repository manifest is required: project root is not a git repository (${directory}). ` +
            `Add a project-scoped .hive/agent-hive.json with a "repositories" manifest before creating worktrees.`,
          );
        }
        return [];
      },
    },
    taskRepoResolver: {
      resolveTaskRepoIds: (feature, step) => {
        const status = taskService.getRawStatus(feature, step);
        return status?.repoIds;
      },
    },
  });

  const adhocWorktreeService = new AdhocWorktreeService({
    baseDir: directory,
    hiveDir: path.join(directory, '.hive'),
    repositoryResolver: {
      resolveRepositories: () => hasRepositoryManifest() ? repositoryService.resolveRepositories() : [],
    },
  });

  const customAgentConfigsForClassification = getCustomAgentConfigsCompat(configService);
  const runtimeContext = detectContext(worktree || directory);
  const taskWorkerRecovery = runtimeContext.isWorktree && runtimeContext.feature && runtimeContext.task
    ? {
        featureName: runtimeContext.feature,
        taskFolder: runtimeContext.task,
        workerPromptPath: path.posix.join(
          '.hive',
          'features',
          resolveFeatureDirectoryName(directory, runtimeContext.feature),
          'tasks',
          runtimeContext.task,
          'worker-prompt.md',
        ),
      }
    : undefined;

  const backgroundJobAdapter = createBackgroundJobAdapter({
    projectRoot: directory,
    service: backgroundJobService,
    isEnabled: () => isBackgroundSubagentsExperimentEnabled(),
    getSession: (sessionId) => sessionService.getGlobal(sessionId),
    isPrimaryAgent: (_agentName, session) => session?.sessionKind === 'primary',
  });

  /**
   * Check if OMO-Slim delegation is enabled via user config.
   * Config read precedence:
   * 1. <project>/.hive/agent-hive.json
   * 2. <project>/.opencode/agent_hive.json
   * 3. ~/.config/opencode/agent_hive.json
   */
  const isOmoSlimEnabled = (): boolean => {
    return configService.isOmoSlimEnabled();
  };

  const resolveFeature = (explicit?: string): string | null => {
    if (explicit) return explicit;

    const context = detectContext(directory);
    if (context.feature) return context.feature;

    return featureService.getActive()?.name ?? null;
  };

  const captureSession = (feature: string, toolContext: unknown) => {
    const ctx = toolContext as ToolContext;
    if (ctx?.sessionID) {
      const currentSession = featureService.getSession(feature);
      if (currentSession !== ctx.sessionID) {
        featureService.setSession(feature, ctx.sessionID);
      }
    }
  };

  const bindFeatureSession = (
    feature: string,
    toolContext: unknown,
    patch?: Partial<{ taskFolder: string; workerPromptPath: string }>,
  ) => {
    const ctx = toolContext as ToolContext;
    if (!ctx?.sessionID) return;
    sessionService.bindFeature(ctx.sessionID, feature, patch as any);
  };

  type ReplayMessageInfo = {
    id: string;
    sessionID: string;
    role: 'user' | 'assistant';
    time: { created: number };
  };

  type ReplayPart = {
    id: string;
    sessionID: string;
    messageID: string;
    type: string;
    text?: string;
    synthetic?: boolean;
  };

  type ReplayMessageEntry = {
    info: ReplayMessageInfo;
    parts: ReplayPart[];
  };

  const extractTextParts = (parts: ReplayPart[] | unknown): string[] => {
    if (!Array.isArray(parts)) return [];
    return parts
      .filter((part): part is ReplayPart & { type: 'text'; text: string; synthetic?: boolean } => {
        return !!part && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string';
      })
      .map((part) => part.text.trim())
      .filter(Boolean);
  };

  const shouldCaptureDirective = (info: ReplayMessageInfo, parts: ReplayPart[]): boolean => {
    if (info.role !== 'user') return false;
    const textParts = parts.filter((part): part is ReplayPart & { type: 'text'; synthetic?: boolean } => {
      return !!part && typeof part === 'object' && part.type === 'text';
    });
    if (textParts.length === 0) return false;
    return !textParts.every((part) => part.synthetic === true);
  };

  const buildDirectiveReplayText = (session: { agent?: string; baseAgent?: string; directivePrompt?: string; sessionKind?: string }): string | null => {
    if (!session.directivePrompt) return null;
    const agentName = session.agent ?? session.baseAgent;
    const roleByAgent: Record<string, string> = {
      'scout-researcher': 'Scout',
      'hive-helper': 'Hive Helper',
      'plan-reviewer': 'Plan Reviewer',
      'code-reviewer': 'Code Reviewer',
      'simplicity-reviewer': 'Simplicity Reviewer',
      'approach-advisor': 'Approach Advisor',
      'architect-planner': 'Architect',
      'swarm-orchestrator': 'Swarm',
      'hive-master': 'Hive',
    };
    const role = agentName ? roleByAgent[agentName] ?? 'current role' : 'current role';

    return [
      `Post-compaction recovery: You are still ${role}.`,
      'Resume the original assignment below. Do not replace it with a new goal.',
      'Do not broaden the scope or re-read the full codebase.',
      'If the exact next step is not explicit in the original assignment, return control to the parent/orchestrator immediately instead of improvising.',
      '',
      session.directivePrompt,
    ].join('\n');
  };

  const shouldUseDirectiveReplay = (session: { sessionKind?: string } | undefined): boolean => {
    return session?.sessionKind === 'primary' || session?.sessionKind === 'subagent';
  };

  const getDirectiveReplayCompactionPatch = (session: { directivePrompt?: string; directiveRecoveryState?: 'available' | 'consumed' | 'escalated'; sessionKind?: string } | undefined) => {
    if (!session?.directivePrompt || !shouldUseDirectiveReplay(session)) {
      return null;
    }

    if (session.directiveRecoveryState === 'escalated') {
      return null;
    }

    if (session.directiveRecoveryState === 'consumed') {
      return {
        directiveRecoveryState: 'escalated' as const,
        replayDirectivePending: true,
      };
    }

    return {
      directiveRecoveryState: 'available' as const,
      replayDirectivePending: true,
    };
  };

  const shouldUseWorkerReplay = (session: { sessionKind?: string; featureName?: string; taskFolder?: string; workerPromptPath?: string } | undefined): boolean => {
    return session?.sessionKind === 'task-worker'
      && !!session.featureName
      && !!session.taskFolder
      && !!session.workerPromptPath;
  };

  const buildWorkerReplayText = (session: { agent?: string; baseAgent?: string; featureName?: string; taskFolder?: string; workerPromptPath?: string }): string | null => {
    if (!session.featureName || !session.taskFolder || !session.workerPromptPath) return null;
    const role = 'Forager';
    return [
      `Post-compaction recovery: You are still the ${role} worker for task ${session.taskFolder}.`,
      `Resume only this task. Do not merge, do not start the next task, and do not replace this assignment with a new goal.`,
      `Do not call orchestration tools unless the worker prompt explicitly says so.`,
      `Re-read @${session.workerPromptPath} and continue from the existing worktree state.`,
    ].join('\n');
  };

  /**
   * Check if a feature is blocked by the Beekeeper.
   * Returns the block message if blocked, null otherwise.
   * 
   * File protocol: .hive/features/<name>/BLOCKED
   * - If file exists, feature is blocked
   * - File contents = reason for blocking
   */
  const checkBlocked = (feature: string): string | null => {
    const fs = require('fs');
    const featureDir = resolveFeatureDirectoryName(directory, feature);
    const blockedPath = path.join(directory, '.hive', 'features', featureDir, 'BLOCKED');
    if (fs.existsSync(blockedPath)) {
      const reason = fs.readFileSync(blockedPath, 'utf-8').trim();
      return `⛔ BLOCKED by Beekeeper

${reason || '(No reason provided)'}

The human has blocked this feature. Wait for them to unblock it.
To unblock: Remove .hive/features/${featureDir}/BLOCKED`;
    }
    return null;
  };

  // ============================================================================
  // Hook Cadence Management
  // ============================================================================
  
  /**
   * Turn counters for hook cadence management.
   * Each hook tracks its own invocation count to determine when to fire.
   */
  const turnCounters: Record<string, number> = {};

  const checkDependencies = (feature: string, taskFolder: string): { allowed: boolean; error?: string } => {
    const taskStatus = taskService.getRawStatus(feature, taskFolder);
    if (!taskStatus) {
      return { allowed: true };
    }

    const tasks = taskService.list(feature).map(task => {
      const status = taskService.getRawStatus(feature, task.folder);
      return {
        folder: task.folder,
        status: task.status,
        dependsOn: status?.dependsOn,
      };
    });

    const effectiveDeps = buildEffectiveDependencies(tasks);
    const deps = effectiveDeps.get(taskFolder) ?? [];

    if (deps.length === 0) {
      return { allowed: true };
    }

    const unmetDeps: Array<{ folder: string; status: string }> = [];

    for (const depFolder of deps) {
      const depStatus = taskService.getRawStatus(feature, depFolder);

      if (!depStatus || depStatus.status !== 'done') {
        unmetDeps.push({
          folder: depFolder,
          status: depStatus?.status ?? 'unknown',
        });
      }
    }

    if (unmetDeps.length > 0) {
      const depList = unmetDeps
        .map(d => `"${d.folder}" (${d.status})`)
        .join(', ');

      return {
        allowed: false,
        error: `Dependency constraint: Task "${taskFolder}" cannot start - dependencies not done: ${depList}. ` +
          `Only tasks with status 'done' satisfy dependencies.`,
      };
    }

    return { allowed: true };
  };

  const respond = (payload: Record<string, unknown>) => JSON.stringify(payload, null, 2);

  const buildWorktreeLaunchResponse = async ({
    feature,
    task,
    taskInfo,
    worktree,
    continueFrom,
    decision,
    toolContext,
  }: {
    feature: string;
    task: string;
    taskInfo: NonNullable<ReturnType<typeof taskService.get>>;
    worktree: WorktreeInfo;
    continueFrom?: 'blocked';
    decision?: string;
    toolContext?: unknown;
  }) => {
    taskService.update(feature, task, {
      status: 'in_progress',
      baseCommit: worktree.commit,
    });

    const planResult = planService.read(feature);
    const allTasks = taskService.list(feature);

    const executionContextFiles = contextService.listExecutionContext(feature);

    const rawContextFiles = executionContextFiles.map(f => ({
      name: f.name,
      content: f.content,
    }));

    const rawPreviousTasks = allTasks
      .filter(t => t.status === 'done' && t.summary)
      .map(t => ({ name: t.folder, summary: t.summary! }));

    const taskBudgetResult = applyTaskBudget(rawPreviousTasks, { ...DEFAULT_BUDGET, feature });
    const contextBudgetResult = applyContextBudget(rawContextFiles, { ...DEFAULT_BUDGET, feature });

    const contextFiles: WorkerPromptContextFile[] = contextBudgetResult.files.map(f => ({
      name: f.name,
      content: f.content,
    }));
    const previousTasks: CompletedTask[] = taskBudgetResult.tasks.map(t => ({
      name: t.name,
      summary: t.summary,
    }));

    const truncationEvents: TruncationEvent[] = [
      ...taskBudgetResult.truncationEvents,
      ...contextBudgetResult.truncationEvents,
    ];

    const droppedTasksHint = taskBudgetResult.droppedTasksHint;

    const taskOrder = parseInt(taskInfo.folder.match(/^(\d+)/)?.[1] || '0', 10);
    const status = taskService.getRawStatus(feature, task);
    const dependsOn = status?.dependsOn ?? [];

    let specContent: string;
    const existingManualSpec = status?.origin === 'manual'
      ? taskService.readSpec(feature, task)
      : null;

    if (existingManualSpec) {
      specContent = existingManualSpec;
    } else {
      specContent = taskService.buildSpecContent({
        featureName: feature,
        task: {
          folder: task,
          name: taskInfo.planTitle ?? taskInfo.name,
          order: taskOrder,
          description: undefined,
        },
        dependsOn,
        allTasks: allTasks.map(t => ({
          folder: t.folder,
          name: t.name,
          order: parseInt(t.folder.match(/^(\d+)/)?.[1] || '0', 10),
        })),
        planContent: planResult?.content ?? null,
        contextFiles,
        completedTasks: previousTasks,
      });

      taskService.writeSpec(feature, task, specContent);
    }

    const workspacePath = worktree.workspacePath ?? worktree.path;
    const repoLaunchInfo = worktree.repos
      ? Object.fromEntries(
          Object.entries(worktree.repos).map(([id, info]) => [id, {
            path: info.path,
            branch: info.branch,
            commit: info.commit,
          }]),
        )
      : undefined;
    const promptRepoInfo = worktree.repos
      ? Object.fromEntries(
          Object.entries(worktree.repos).map(([id, info]) => [id, {
            path: info.path,
            branch: info.branch,
          }]),
        )
      : undefined;

    const workerPrompt = buildWorkerPrompt({
      feature,
      task,
      taskOrder,
      worktreePath: workspacePath,
      branch: worktree.branch,
      plan: planResult?.content || 'No plan available',
      contextFiles,
      spec: specContent,
      previousTasks,
      continueFrom: continueFrom === 'blocked' ? {
        status: 'blocked',
        previousSummary: (taskInfo as any).summary || 'No previous summary',
        decision: decision || 'No decision provided',
      } : undefined,
      workspacePath: worktree.workspacePath,
      repos: promptRepoInfo,
    });

    const customAgentConfigs = getCustomAgentConfigsCompat(configService);
    const defaultAgent = 'forager-worker';
    const eligibleAgents = [
      {
        name: defaultAgent,
        baseAgent: defaultAgent,
        description: 'Default implementation worker',
      },
      ...Object.entries(customAgentConfigs)
        .filter(([, config]) => config.baseAgent === 'forager-worker')
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, config]) => ({
          name,
          baseAgent: config.baseAgent,
          description: config.description,
        })),
    ];
    const agent = defaultAgent;

    const rawStatus = taskService.getRawStatus(feature, task);
    const attempt = (rawStatus?.workerSession?.attempt || 0) + 1;
    const idempotencyKey = `hive-${feature}-${task}-${attempt}`;

    taskService.patchBackgroundFields(feature, task, { idempotencyKey });

    const contextContent = contextFiles.map(f => f.content).join('\n\n');
    const previousTasksContent = previousTasks.map(t => `- **${t.name}**: ${t.summary}`).join('\n');
    const promptMeta = calculatePromptMeta({
      plan: planResult?.content || '',
      context: contextContent,
      previousTasks: previousTasksContent,
      spec: specContent,
      workerPrompt,
    });

    const hiveDir = path.join(directory, '.hive');
    const workerPromptPath = writeWorkerPromptFile(feature, task, workerPrompt, hiveDir);
    const relativePromptPath = normalizePath(path.relative(directory, workerPromptPath));

    const PREVIEW_MAX_LENGTH = 200;
    const workerPromptPreview = workerPrompt.length > PREVIEW_MAX_LENGTH
      ? workerPrompt.slice(0, PREVIEW_MAX_LENGTH) + '...'
      : workerPrompt;

    const taskToolPrompt = `Follow instructions in @${relativePromptPath}`;
    const backgroundTaskCall = {
      background: true,
      subagent_type: agent,
      description: `Hive: ${task}`,
      prompt: taskToolPrompt,
    };
    const backgroundEnabled = isBackgroundSubagentsExperimentEnabled();
    const parentSessionId = (toolContext as ToolContext | undefined)?.sessionID;

    if (backgroundEnabled && parentSessionId) {
      bindFeatureSession(feature, toolContext, { taskFolder: task, workerPromptPath: relativePromptPath });
      backgroundJobService.registerPendingLaunch({
        parentSessionId,
        expectedDescription: backgroundTaskCall.description,
        expectedPrompt: backgroundTaskCall.prompt,
        agentName: agent,
        scope: {
          projectRoot: directory,
          parentSessionId,
          primaryAgent: (toolContext as ToolContext | undefined)?.agent,
          feature,
          task,
        },
        ownership: {
          worktreePath: workspacePath,
          branch: worktree.branch,
          workerPromptPath: relativePromptPath,
          repoIds: status?.repoIds ?? [],
        },
      });
    }

    const taskToolInstructions = `## Delegation Required

Choose one of the eligible forager-derived agents below.
Default to \`${defaultAgent}\` if no specialist is a better match.

${eligibleAgents.map((candidate) => `- \`${candidate.name}\` — ${candidate.description}`).join('\n')}

Use OpenCode's built-in \`task\` tool with the chosen \`subagent_type\` and the provided ${backgroundEnabled ? '\`backgroundTaskCall.prompt\` value. Prefer \`backgroundTaskCall\` so this task runs in the background and remains visible on the Hive background board.' : '\`taskToolCall.prompt\` value.'}
\`taskToolCall.subagent_type\` is prefilled with the default for convenience; override it when a specialist in \`eligibleAgents\` is a better match.

\`\`\`
task({
  subagent_type: "<chosen-agent>",
  description: "Hive: ${task}",
  prompt: "${taskToolPrompt}"${backgroundEnabled ? ',\n  background: true' : ''}
})
\`\`\`

${backgroundEnabled ? 'Use blocking foreground `task()` only when dependency, risk, simplicity, user interaction, or ownership conflict makes waiting the safer path. Keep the same `subagent_type`, `description`, and `prompt` if you use that escape path.\n\n' : ''}

Use the \`@path\` attachment syntax in the prompt to reference the file. Do not inline the file contents.

`;

    const responseBase = {
      success: true,
      terminal: false,
      worktreePath: workspacePath,
      workspacePath,
      branch: worktree.branch,
      mode: 'delegate',
      worktreeMode: worktree.mode ?? 'legacy',
      baseCommits: worktree.baseCommits,
      repos: repoLaunchInfo,
      agent,
      defaultAgent,
      eligibleAgents,
      delegationRequired: true,
      workerPromptPath: relativePromptPath,
      workerPromptPreview,
      taskPromptMode: 'opencode-at-file',
      taskToolCall: {
        subagent_type: agent,
        description: `Hive: ${task}`,
        prompt: taskToolPrompt,
      },
      ...(backgroundEnabled ? { backgroundTaskCall } : {}),
      instructions: taskToolInstructions,
    };

    const jsonPayload = JSON.stringify(responseBase, null, 2);
    const payloadMeta = calculatePayloadMeta({
      jsonPayload,
      promptInlined: false,
      promptReferencedByFile: true,
    });

    const sizeWarnings = checkWarnings(promptMeta, payloadMeta);
    const budgetWarnings = truncationEvents.map(event => ({
      type: event.type as string,
      severity: 'info' as const,
      message: event.message,
      affected: event.affected,
      count: event.count,
    }));
    const allWarnings = [...sizeWarnings, ...budgetWarnings];

    return respond({
      ...responseBase,
      promptMeta,
      payloadMeta,
      budgetApplied: {
        maxTasks: DEFAULT_BUDGET.maxTasks,
        maxSummaryChars: DEFAULT_BUDGET.maxSummaryChars,
        maxContextChars: DEFAULT_BUDGET.maxContextChars,
        maxTotalContextChars: DEFAULT_BUDGET.maxTotalContextChars,
        tasksIncluded: previousTasks.length,
        tasksDropped: rawPreviousTasks.length - previousTasks.length,
        droppedTasksHint,
      },
      warnings: allWarnings.length > 0 ? allWarnings : undefined,
    });
  };

  const executeWorktreeStart = async ({
    task,
    feature: explicitFeature,
    toolContext,
  }: {
    task: string;
    feature?: string;
    toolContext?: unknown;
  }) => {
    const feature = resolveFeature(explicitFeature);
    if (!feature) {
      return respond({
        success: false,
        terminal: true,
        error: 'No feature specified. Create a feature or provide feature param.',
        reason: 'feature_required',
        task,
        hints: [
          'Create/select a feature first or pass the feature parameter explicitly.',
          'Use hive_status to inspect the active feature state before retrying.',
        ],
      });
    }

    const blockedMessage = checkBlocked(feature);
    if (blockedMessage) {
      return respond({
        success: false,
        terminal: true,
        error: blockedMessage,
        reason: 'feature_blocked',
        feature,
        task,
        hints: [
          'Wait for the human to unblock the feature before retrying.',
          `If approved, remove .hive/features/${resolveFeatureDirectoryName(directory, feature)}/BLOCKED and retry hive_worktree_start.`,
        ],
      });
    }

    const taskInfo = taskService.get(feature, task);
    if (!taskInfo) {
      return respond({
        success: false,
        terminal: true,
        error: `Task "${task}" not found`,
        reason: 'task_not_found',
        feature,
        task,
        hints: [
          'Check the task folder name in tasks.json or hive_status output.',
          'Run hive_tasks_sync if the approved plan has changed and tasks need regeneration.',
        ],
      });
    }

    if (taskInfo.status === 'done') {
      return respond({
        success: false,
        terminal: true,
        error: `Task "${task}" is already completed (status: done). It cannot be restarted.`,
        currentStatus: 'done',
        hints: [
          'Use hive_merge to integrate the completed task branch if not already merged.',
          'Use hive_status to see all task states and find the next runnable task.',
        ],
      });
    }

    if (taskInfo.status === 'blocked') {
      return respond({
        success: false,
        terminal: true,
        error: `Task "${task}" is blocked and must be resumed with hive_worktree_create using continueFrom: 'blocked'.`,
        currentStatus: 'blocked',
        feature,
        task,
        hints: [
          'Ask the user the blocker question, then call hive_worktree_create({ task, continueFrom: "blocked", decision }).',
          'Use hive_status to inspect blocker details before retrying.',
        ],
      });
    }

    const depCheck = checkDependencies(feature, task);
    if (!depCheck.allowed) {
      return respond({
        success: false,
        terminal: true,
        reason: 'dependencies_not_done',
        feature,
        task,
        error: depCheck.error,
        hints: [
          'Complete the required dependencies before starting this task.',
          'Use hive_status to see current task states.',
        ],
      });
    }

    const worktree = await worktreeService.create(feature, task);
    return buildWorktreeLaunchResponse({ feature, task, taskInfo, worktree, toolContext });
  };

  const executeBlockedResume = async ({
    task,
    feature: explicitFeature,
    continueFrom,
    decision,
    toolContext,
  }: {
    task: string;
    feature?: string;
    continueFrom?: 'blocked';
    decision?: string;
    toolContext?: unknown;
  }) => {
    const feature = resolveFeature(explicitFeature);
    if (!feature) {
      return respond({
        success: false,
        terminal: true,
        error: 'No feature specified. Create a feature or provide feature param.',
        reason: 'feature_required',
        task,
        hints: [
          'Create/select a feature first or pass the feature parameter explicitly.',
          'Use hive_status to inspect the active feature state before retrying.',
        ],
      });
    }

    const blockedMessage = checkBlocked(feature);
    if (blockedMessage) {
      return respond({
        success: false,
        terminal: true,
        error: blockedMessage,
        reason: 'feature_blocked',
        feature,
        task,
        hints: [
          'Wait for the human to unblock the feature before retrying.',
          `If approved, remove .hive/features/${resolveFeatureDirectoryName(directory, feature)}/BLOCKED and retry hive_worktree_create.`,
        ],
      });
    }

    const taskInfo = taskService.get(feature, task);
    if (!taskInfo) {
      return respond({
        success: false,
        terminal: true,
        error: `Task "${task}" not found`,
        reason: 'task_not_found',
        feature,
        task,
        hints: [
          'Check the task folder name in tasks.json or hive_status output.',
          'Run hive_tasks_sync if the approved plan has changed and tasks need regeneration.',
        ],
      });
    }

    if (taskInfo.status === 'done') {
      return respond({
        success: false,
        terminal: true,
        error: `Task "${task}" is already completed (status: done). It cannot be restarted.`,
        currentStatus: 'done',
        hints: [
          'Use hive_merge to integrate the completed task branch if not already merged.',
          'Use hive_status to see all task states and find the next runnable task.',
        ],
      });
    }

    if (continueFrom !== 'blocked') {
      return respond({
        success: false,
        terminal: true,
        error: 'hive_worktree_create is only for resuming blocked tasks.',
        reason: 'blocked_resume_required',
        currentStatus: taskInfo.status,
        feature,
        task,
        hints: [
          'Use hive_worktree_start({ feature, task }) to start a pending or in-progress task normally.',
          'Use hive_worktree_create({ task, continueFrom: "blocked", decision }) only after hive_status confirms the task is blocked.',
        ],
      });
    }

    if (taskInfo.status !== 'blocked') {
      return respond({
        success: false,
        terminal: true,
        reason: 'task_not_blocked',
        canRetry: false,
        retryReason: `Task is in ${taskInfo.status} state. Run hive_status() and follow the current status flow instead of blocked resume.`,
        error: `continueFrom: 'blocked' was specified but task "${task}" is not in blocked state (current status: ${taskInfo.status}).`,
        currentStatus: taskInfo.status,
        hints: [
          'This blocked-resume call cannot be retried with the same parameters.',
          'Use hive_worktree_start({ feature, task }) for normal starts or re-dispatch.',
          'Use hive_status to verify the current task status before retrying.',
        ],
      });
    }

    const worktree = await worktreeService.get(feature, task);
    if (!worktree) {
      return respond({
        success: false,
        terminal: true,
        error: `Cannot resume blocked task "${task}": no existing worktree record found.`,
        currentStatus: taskInfo.status,
        hints: [
          'The worktree may have been removed manually. Use hive_worktree_discard to reset the task to pending, then restart it with hive_worktree_start.',
          'Use hive_status to inspect the current state of the task and its worktree.',
        ],
      });
    }

    return buildWorktreeLaunchResponse({
      feature,
      task,
      taskInfo,
      worktree,
      continueFrom,
      decision,
      toolContext,
    });
  };

  return {
    event: async (input) => {
      await backgroundJobAdapter.event(input);
      if (input.event.type !== 'session.compacted') {
        return;
      }

      const sessionID = input.event.properties.sessionID;
      const existing = sessionService.getGlobal(sessionID);
      const directiveReplayPatch = getDirectiveReplayCompactionPatch(existing);
      if (directiveReplayPatch) {
        sessionService.trackGlobal(sessionID, directiveReplayPatch);
        return;
      }
      if (shouldUseWorkerReplay(existing)) {
        sessionService.trackGlobal(sessionID, { replayDirectivePending: true });
        return;
      }
    },

    // Apply per-agent variant to messages (covers built-in and accepted custom task() agents)
    // Type assertion needed because TypeScript's contravariance rules are too strict
    // for the hook's output parameter type. The hook only accesses output.message.variant
    // which exists on UserMessage.
    "chat.message": createVariantHook(configService, sessionService, customAgentConfigsForClassification, taskWorkerRecovery) as any,

    "experimental.chat.system.transform": (async (
      input: { sessionID?: string; agent?: string },
      output: { system: string[] },
    ) => {
      if (!Array.isArray(output.system)) {
        return;
      }

      const trackedAgent = input.sessionID ? sessionService.getGlobal(input.sessionID)?.agent : undefined;
      const agentName = input.agent ?? trackedAgent;
      const agentPrompt = agentName ? runtimeAgentPrompts.get(agentName) : undefined;
      if (!agentPrompt) {
        return;
      }

      if (output.system.length === 0) {
        output.system.push(agentPrompt);
        return;
      }

      output.system[0] = `${output.system[0]}\n\n${agentPrompt}`;
    }) satisfies SystemTransformHook,

    "experimental.chat.messages.transform": async (
      _input: {},
      output: { messages: ReplayMessageEntry[] },
    ) => {
      if (!Array.isArray(output.messages) || output.messages.length === 0) {
        return;
      }

      const firstMessage = output.messages[0];
      const sessionID = firstMessage?.info?.sessionID;
      if (!sessionID) {
        return;
      }

      const session = sessionService.getGlobal(sessionID);

      const captureCandidates = output.messages.filter(
        ({ info, parts }) => info.sessionID === sessionID && shouldCaptureDirective(info, parts),
      );
      const latestDirective = captureCandidates.at(-1);
      if (latestDirective) {
        const directiveText = extractTextParts(latestDirective.parts).join('\n\n');
        const existingDirective = session?.directivePrompt;
        if (directiveText && directiveText !== existingDirective && shouldUseDirectiveReplay(session ?? { sessionKind: 'subagent' })) {
          sessionService.trackGlobal(sessionID, {
            directivePrompt: directiveText,
            directiveRecoveryState: undefined,
            replayDirectivePending: false,
          });
        }
      }

      const refreshed = sessionService.getGlobal(sessionID);
      await backgroundJobAdapter['experimental.chat.messages.transform'](_input, output);
      if (!refreshed?.replayDirectivePending) {
        return;
      }

      if (shouldUseWorkerReplay(refreshed)) {
        const workerText = buildWorkerReplayText(refreshed);
        if (!workerText) {
          sessionService.trackGlobal(sessionID, { replayDirectivePending: false });
          return;
        }

        const now = Date.now();
        output.messages.push({
          info: {
            id: `msg_replay_${sessionID}`,
            sessionID,
            role: 'user',
            time: { created: now },
          },
          parts: [
            {
              id: `prt_replay_${sessionID}`,
              sessionID,
              messageID: `msg_replay_${sessionID}`,
              type: 'text',
              text: workerText,
              synthetic: true,
            },
          ],
        });

        sessionService.trackGlobal(sessionID, { replayDirectivePending: false });
        return;
      }

      if (!shouldUseDirectiveReplay(refreshed)) {
        sessionService.trackGlobal(sessionID, { replayDirectivePending: false });
        return;
      }

      const replayText = buildDirectiveReplayText(refreshed);
      if (!replayText) {
        sessionService.trackGlobal(sessionID, { replayDirectivePending: false });
        return;
      }

      const now = Date.now();
      output.messages.push({
        info: {
          id: `msg_replay_${sessionID}`,
          sessionID,
          role: 'user',
          time: { created: now },
        },
        parts: [
          {
            id: `prt_replay_${sessionID}`,
            sessionID,
            messageID: `msg_replay_${sessionID}`,
            type: 'text',
            text: replayText,
            synthetic: true,
          },
        ],
      });

      sessionService.trackGlobal(sessionID, {
        replayDirectivePending: false,
        directiveRecoveryState: refreshed.directiveRecoveryState === 'available'
          ? 'consumed'
          : refreshed.directiveRecoveryState,
      });
    },

    "tool.execute.before": async (input, output) => {
      await backgroundJobAdapter['tool.execute.before'](input, output);

      // Cadence gate: check if this hook should execute this turn
      // SAFETY-CRITICAL: This hook wraps commands for Docker sandbox isolation.
      // Setting cadence > 1 could allow unsafe commands through.
      // The safetyCritical flag enforces cadence=1 regardless of config.
      if (!shouldExecuteHook("tool.execute.before", configService, turnCounters, { safetyCritical: true })) {
        return;
      }

      if (input.tool !== "bash") return;
      
      const sandboxConfig = configService.getSandboxConfig();
      if (sandboxConfig.mode === 'none') return;
      
      const command = output.args?.command?.trim();
      if (!command) return;
      
      // Escape hatch: HOST: prefix (case-insensitive)
      if (/^HOST:\s*/i.test(command)) {
        const strippedCommand = command.replace(/^HOST:\s*/i, '');
        console.warn(`[hive:sandbox] HOST bypass: ${strippedCommand.slice(0, 80)}${strippedCommand.length > 80 ? '...' : ''}`);
        output.args.command = strippedCommand;
        return;
      }
      
      // Only wrap commands with explicit workdir inside hive worktrees
      const workdir = output.args?.workdir;
      if (!workdir) return;
      
      const hiveWorktreeBase = path.join(directory, '.hive', '.worktrees');
      if (!workdir.startsWith(hiveWorktreeBase)) return;
      
      // Wrap command using static method (with persistent config)
      const wrapped = DockerSandboxService.wrapCommand(workdir, command, sandboxConfig);
      output.args.command = wrapped;
      output.args.workdir = undefined; // docker command runs on host
    },

    "tool.execute.after": backgroundJobAdapter['tool.execute.after'],

    mcp: builtinMcps,

    tool: {
      ...createBackgroundTools({
        backgroundJobService,
        projectRoot: directory,
        isEnabled: isBackgroundSubagentsExperimentEnabled,
        cancelRuntimeTask: async (taskId) => {
          const result = await client.session.abort({ path: { id: taskId }, query: { directory } });
          if (result.error) {
            return { cancelled: false, message: `Runtime cancellation failed: ${String(result.error)}` };
          }
          return {
            cancelled: result.data === true,
            message: result.data === true ? 'Runtime task abort requested.' : 'Runtime task abort was not confirmed.',
          };
        },
      }),

      hive_repositories_status: tool({
        description: 'Inspect project repository mode and the current project-scoped repository manifest.',
        args: {},
        async execute() {
          return JSON.stringify(repositoryManifestService.getStatus(), null, 2);
        },
      }),

      hive_repositories_discover: tool({
        description: 'Discover in-workspace git repositories that could be added to the project repository manifest. Read-only.',
        args: {},
        async execute() {
          return JSON.stringify(repositoryManifestService.discover(), null, 2);
        },
      }),

      hive_repositories_update: tool({
        description: 'Add project-relative repositories to the project-scoped repository manifest. Add-only and atomic; preserves other project config fields.',
        args: {
          repositories: tool.schema.array(tool.schema.object({
            id: tool.schema.string().describe('Stable repository ID, e.g. api or web-ui'),
            path: tool.schema.string().describe('Project-relative repository path, such as ./api'),
          })).describe('Repositories to add to .hive/agent-hive.json'),
        },
        async execute({ repositories }) {
          return JSON.stringify(repositoryManifestService.add(repositories), null, 2);
        },
      }),

      hive_feature_create: tool({
        description: 'Create a new feature and set it as active',
        args: {
          name: tool.schema.string().describe('Feature name'),
          ticket: tool.schema.string().optional().describe('Ticket reference'),
        },
        async execute({ name, ticket }) {
          const feature = featureService.create(name, ticket);
          return `Feature "${name}" created.

## Discovery Phase Required

Before writing a plan, you MUST:
1. Ask clarifying questions about the feature
2. Document Q&A in plan.md with a \`## Discovery\` section
3. Research the codebase (grep, read existing code)
4. Save findings with hive_context_write

Example discovery section:
\`\`\`markdown
## Discovery

**Q: What authentication system do we use?**
A: JWT with refresh tokens, see src/auth/

**Q: Should this work offline?**
A: No, online-only is fine

**Research:**
- Found existing theme system in src/theme/
- Uses CSS variables pattern
\`\`\`

## Planning Guidelines

When writing your plan, include:
- \`## Non-Goals\` - What we're explicitly NOT building (scope boundaries)
- \`## Ghost Diffs\` - Alternatives you considered but rejected

These prevent scope creep and re-proposing rejected solutions.

NEXT: Ask your first clarifying question about this feature.`;
        },
      }),

      hive_feature_complete: tool({
        description: 'Mark feature as completed (irreversible)',
        args: { name: tool.schema.string().optional().describe('Feature name (defaults to active)') },
        async execute({ name }) {
          const feature = resolveFeature(name);
          if (!feature) return "Error: No feature specified. Create a feature or provide name.";
          featureService.complete(feature);
          return `Feature "${feature}" marked as completed`;
        },
      }),

      hive_plan_write: tool({
        description: 'Write plan.md (clears plan review comments)',
        args: {
          content: tool.schema.string().describe('Plan markdown content'),
          feature: tool.schema.string().optional().describe('Feature name (defaults to detection or single feature)'),
        },
        async execute({ content, feature: explicitFeature }, toolContext) {
          const feature = resolveFeature(explicitFeature);
          if (!feature) return "Error: No feature specified. Create a feature or provide feature param.";

          // GATE: Check for discovery section with substantive content
          const discoveryMatch = content.match(/^##\s+Discovery\s*$/im);
          if (!discoveryMatch) {
            return `BLOCKED: Discovery section required before planning.

Your plan must include a \`## Discovery\` section documenting:
- Questions you asked and answers received
- Research findings from codebase exploration
- Key decisions made

Add this section to your plan content and try again.`;
          }
          
          // Extract content between ## Discovery and next ## heading (or end)
          const afterDiscovery = content.slice(discoveryMatch.index! + discoveryMatch[0].length);
          const nextHeading = afterDiscovery.search(/^##\s+/m);
          const discoveryContent = nextHeading > -1
            ? afterDiscovery.slice(0, nextHeading).trim()
            : afterDiscovery.trim();
          
          if (discoveryContent.length < 100) {
            return `BLOCKED: Discovery section is too thin (${discoveryContent.length} chars, minimum 100).

A substantive Discovery section should include:
- Original request quoted
- Interview summary (key decisions)
- Research findings with file:line references

Expand your Discovery section and try again.`;
          }

          captureSession(feature, toolContext);
          const planPath = planService.write(feature, content);
          return `Plan written to ${planPath}. Comments cleared for fresh review. Refresh the primary human-facing overview with hive_context_write({ name: "overview", content }) using ## At a Glance, ## Workstreams, and ## Revision History. Review context/overview.md first; plan.md remains execution truth.`;
        },
      }),

      hive_plan_read: tool({
        description: 'Read plan.md and related review comments',
        args: {
          feature: tool.schema.string().optional().describe('Feature name (defaults to detection or single feature)'),
        },
        async execute({ feature: explicitFeature }, toolContext) {
          const feature = resolveFeature(explicitFeature);
          if (!feature) return "Error: No feature specified. Create a feature or provide feature param.";
          captureSession(feature, toolContext);
          bindFeatureSession(feature, toolContext);
          const result = planService.read(feature);
          if (!result) return "Error: No plan.md found";
          return JSON.stringify(result, null, 2);
        },
      }),

      hive_plan_approve: tool({
        description: 'Approve plan for execution',
        args: {
          feature: tool.schema.string().optional().describe('Feature name (defaults to detection or single feature)'),
        },
        async execute({ feature: explicitFeature }, toolContext) {
          const feature = resolveFeature(explicitFeature);
          if (!feature) return "Error: No feature specified. Create a feature or provide feature param.";
          captureSession(feature, toolContext);
          const info = featureService.getInfo(feature);
          const planComments = info?.reviewCounts.plan ?? 0;
          if (planComments > 0) {
            return `Error: Cannot approve - ${planComments} unresolved plan review comment(s) remain. Address them first.`;
          }
          planService.approve(feature);
          return 'Plan approved. Run hive_tasks_sync to generate tasks. Refresh the plan summary if approval changed the narrative, workstreams, or milestones; plan.md remains execution truth.';
        },
      }),

      hive_tasks_sync: tool({
        description: 'Generate tasks from approved plan. When refreshPending is true, refresh pending plan tasks from current plan.md and delete removed pending tasks. Manual tasks and tasks with execution history are preserved.',
        args: {
          feature: tool.schema.string().optional().describe('Feature name (defaults to detection or single feature)'),
          refreshPending: tool.schema.boolean().optional().describe('When true, refresh pending plan tasks from current plan.md (rewrite dependsOn, planTitle, spec.md) and delete pending tasks removed from plan'),
        },
        async execute({ feature: explicitFeature, refreshPending }) {
          const feature = resolveFeature(explicitFeature);
          if (!feature) return "Error: No feature specified. Create a feature or provide feature param.";
          const featureData = featureService.get(feature);
          if (!featureData || featureData.status === 'planning') {
            return "Error: Plan must be approved first";
          }
          const result = taskService.sync(feature, { refreshPending });
          if (featureData.status === 'approved') {
            featureService.updateStatus(feature, 'executing');
          }
          return `Tasks synced: ${result.created.length} created, ${result.removed.length} removed, ${result.kept.length} kept, ${result.manual.length} manual`;
        },
      }),

      hive_task_create: tool({
        description: 'Create append-only manual task (not from plan). Omit order to use the next slot. Explicit dependsOn defaults to [] and is only allowed when every dependency already exists and is done. Provide structured metadata for useful spec.md and worker prompt.',
        args: {
          name: tool.schema.string().describe('Task name'),
          order: tool.schema.number().optional().describe('Task order. Omit to use the next append-only slot; explicit order must equal that next slot.'),
          feature: tool.schema.string().optional().describe('Feature name (defaults to detection or single feature)'),
          description: tool.schema.string().optional().describe('What the worker needs to achieve'),
          goal: tool.schema.string().optional().describe('Why this task exists and what done means'),
          acceptanceCriteria: tool.schema.array(tool.schema.string()).optional().describe('Specific observable outcomes'),
          references: tool.schema.array(tool.schema.string()).optional().describe('File paths or line ranges relevant to this task'),
          files: tool.schema.array(tool.schema.string()).optional().describe('Files likely to be modified'),
          dependsOn: tool.schema.array(tool.schema.string()).optional().describe('Task folder names this task depends on (default: [] for no dependencies). Explicit dependsOn is allowed only when every dependency already exists and is done; review-sourced tasks must omit it.'),
          reason: tool.schema.string().optional().describe('Why this task was created'),
          source: tool.schema.string().optional().describe('Origin: review, operator, or ad_hoc'),
          repos: tool.schema.array(tool.schema.string()).optional().describe('Repository IDs this task targets (must match project-scoped repository manifest). Required for manifest-backed projects; omit for legacy single-root projects.'),
        },
        async execute({ name, order, feature: explicitFeature, description, goal, acceptanceCriteria, references, files, dependsOn, reason, source, repos }) {
          const feature = resolveFeature(explicitFeature);
          if (!feature) return "Error: No feature specified. Create a feature or provide feature param.";
          const metadata: Record<string, unknown> = {};
          if (description) metadata.description = description;
          if (goal) metadata.goal = goal;
          if (acceptanceCriteria) metadata.acceptanceCriteria = acceptanceCriteria;
          if (references) metadata.references = references;
          if (files) metadata.files = files;
          if (dependsOn) metadata.dependsOn = dependsOn;
          if (reason) metadata.reason = reason;
          if (source) metadata.source = source;
          if (repos) metadata.repoIds = repos;
          if (repos && hasRepositoryManifest()) {
            // Only check manifest membership for grammar-valid IDs; grammar
            // violations are surfaced by taskService.create() with the
            // canonical "Invalid repository ID" wording.
            const grammarValid = repos.filter(id => RepositoryService.isValidRepositoryId(id));
            const knownIds = new Set(repositoryService.resolveRepositories().map(r => r.id));
            const unknown = grammarValid.filter(id => !knownIds.has(id));
            if (unknown.length > 0) {
              throw new Error(
                `Unknown repository ID(s) in repos: ${unknown.join(', ')}. ` +
                `Allowed manifest IDs: ${[...knownIds].join(', ') || '(none)'}.`,
              );
            }
          }
          const folder = taskService.create(feature, name, order, Object.keys(metadata).length > 0 ? metadata as any : undefined);
          return `Manual task created: ${folder}\nDependencies: [${(dependsOn ?? []).join(', ')}]${repos ? `\nRepos: [${repos.join(', ')}]` : ''}\nReminder: start work with hive_worktree_start to use its worktree, and ensure any subagents work in that worktree too.`;
        },
      }),

      hive_task_update: tool({
        description: 'Update task status or summary',
        args: {
          task: tool.schema.string().describe('Task folder name'),
          status: tool.schema.string().optional().describe('New status: pending, in_progress, done, cancelled'),
          summary: tool.schema.string().optional().describe('Summary of work'),
          feature: tool.schema.string().optional().describe('Feature name (defaults to detection or single feature)'),
        },
        async execute({ task, status, summary, feature: explicitFeature }) {
          const feature = resolveFeature(explicitFeature);
          if (!feature) return "Error: No feature specified. Create a feature or provide feature param.";
          const updated = taskService.update(feature, task, {
            status: status as any,
            summary,
          });
          return `Task "${task}" updated: status=${updated.status}`;
        },
      }),

      hive_worktree_start: tool({
        description: 'Create worktree and begin work on pending/in-progress task. Spawns Forager worker automatically.',
        args: {
          task: tool.schema.string().describe('Task folder name'),
          feature: tool.schema.string().optional().describe('Feature name (defaults to detection or single feature)'),
        },
        async execute({ task, feature: explicitFeature }, toolContext) {
          return executeWorktreeStart({ task, feature: explicitFeature, toolContext });
        },
      }),

      hive_worktree_create: tool({
        description: 'Resume a blocked task in its existing worktree. Spawns Forager worker automatically.',
        args: {
          task: tool.schema.string().describe('Task folder name'),
          feature: tool.schema.string().optional().describe('Feature name (defaults to detection or single feature)'),
          continueFrom: tool.schema.enum(['blocked']).optional().describe('Resume a blocked task'),
          decision: tool.schema.string().optional().describe('Answer to blocker question when continuing'),
        },
        async execute({ task, feature: explicitFeature, continueFrom, decision }, toolContext) {
          return executeBlockedResume({ task, feature: explicitFeature, continueFrom, decision, toolContext });
        },
      }),

      hive_worktree_commit: tool({
        description: 'Complete task: commit changes to branch, write report. Supports blocked/failed/partial status for worker communication. Returns JSON with ok/terminal semantics for worker control flow.',
        args: {
          task: tool.schema.string().describe('Task folder name'),
          summary: tool.schema.string().describe('Summary of what was done'),
          message: tool.schema.string().optional().describe('Optional git commit message. Empty uses default.'),
          status: tool.schema.enum(['completed', 'blocked', 'failed', 'partial']).optional().default('completed').describe('Task completion status'),
          blocker: tool.schema.object({
            reason: tool.schema.string().describe('Why the task is blocked'),
            options: tool.schema.array(tool.schema.string()).optional().describe('Available options for the user'),
            recommendation: tool.schema.string().optional().describe('Your recommended choice'),
            context: tool.schema.string().optional().describe('Additional context for the decision'),
          }).optional().describe('Blocker info when status is blocked'),
          feature: tool.schema.string().optional().describe('Feature name (defaults to detection or single feature)'),
        },
        async execute({ task, summary, message, status = 'completed', blocker, feature: explicitFeature }, toolContext) {
          const respond = (payload: Record<string, unknown>) => JSON.stringify(payload, null, 2);
          const feature = resolveFeature(explicitFeature);
          if (!feature) {
            return respond({
              ok: false,
              terminal: false,
              status: 'error',
              reason: 'feature_required',
              task,
              taskState: 'unknown',
              message: 'No feature specified. Create a feature or provide feature param.',
              nextAction: 'Provide feature explicitly or create/select an active feature, then retry hive_worktree_commit.',
            });
          }

          const taskInfo = taskService.get(feature, task);
          if (!taskInfo) {
            return respond({
              ok: false,
              terminal: false,
              status: 'error',
              reason: 'task_not_found',
              feature,
              task,
              taskState: 'unknown',
              message: `Task "${task}" not found`,
              nextAction: 'Check the task folder name in your worker-prompt.md and retry hive_worktree_commit with the correct task id.',
            });
          }
          if (taskInfo.status !== 'in_progress' && taskInfo.status !== 'blocked') {
            return respond({
              ok: false,
              terminal: false,
              status: 'error',
              reason: 'invalid_task_state',
              feature,
              task,
              taskState: taskInfo.status,
              message: 'Task not in progress',
              nextAction: 'Only in_progress or blocked tasks can be committed. Start/resume the task first.',
            });
          }

          const featureDir = resolveFeatureDirectoryName(directory, feature);
          const workerPromptPath = path.posix.join('.hive', 'features', featureDir, 'tasks', task, 'worker-prompt.md');
          bindFeatureSession(feature, toolContext, { taskFolder: task, workerPromptPath });

          // ADVISORY: Track verification status (workers do best-effort)
          let verificationNote: string | undefined;
          if (status === 'completed') {
            const verificationKeywords = ['test', 'build', 'lint', 'vitest', 'jest', 'npm run', 'pnpm', 'cargo', 'pytest', 'verified', 'passes', 'succeeds', 'ast-grep', 'scan'];
            const summaryLower = summary.toLowerCase();
            const hasVerificationMention = verificationKeywords.some(kw => summaryLower.includes(kw));

            if (!hasVerificationMention) {
              verificationNote = 'No verification evidence in summary. Orchestrator should run build+test after merge.';
            }
          }

          // Handle blocked status - don't commit, just update status
          if (status === 'blocked') {
            taskService.update(feature, task, {
              status: 'blocked',
              summary,
              blocker: blocker as any,
            } as any);

            const worktree = await worktreeService.get(feature, task);
            return respond({
              ok: true,
              terminal: true,
              status: 'blocked',
              reason: 'user_decision_required',
              feature,
              task,
              taskState: 'blocked',
              summary,
              blocker,
              worktreePath: worktree?.path,
              branch: worktree?.branch,
              message: 'Task blocked. Hive Master will ask user and resume with hive_worktree_create(continueFrom: "blocked", decision: answer)',
              nextAction: 'Wait for orchestrator to collect user decision and resume with continueFrom: "blocked".',
            });
          }

          // For failed/partial, still commit what we have
          const commitMessage = message || `hive(${task}): ${summary.slice(0, 50)}`;
          const commitResult = await worktreeService.commitChanges(feature, task, commitMessage);

          // Aggregate composite partial failure: at least one repo committed, at
          // least one repo failed. Do not let this silently become `done`; keep
          // task state and surface the per-repo breakdown so the worker can
          // resolve, retry, or explicitly report blocked/failed.
          if (status === 'completed' && commitResult.partial) {
            return respond({
              ok: false,
              terminal: false,
              status: 'rejected',
              reason: 'commit_partial',
              feature,
              task,
              taskState: taskInfo.status,
              summary,
              commit: {
                committed: commitResult.committed,
                sha: commitResult.sha,
                message: commitResult.message,
                partial: true,
                ...(commitResult.error !== undefined ? { error: commitResult.error } : {}),
                ...(commitResult.repos !== undefined ? { repos: commitResult.repos } : {}),
              },
              message: `Partial commit failure: ${commitResult.error || 'one or more repos failed to commit after an earlier repo succeeded'}.`,
              nextAction: 'Resolve the failed repo, then call hive_worktree_commit again. If unrecoverable, report blocked or failed.',
            });
          }

          if (status === 'completed' && !commitResult.committed && commitResult.message !== 'No changes to commit') {
            return respond({
              ok: false,
              terminal: false,
              status: 'rejected',
              reason: 'commit_failed',
              feature,
              task,
              taskState: taskInfo.status,
              summary,
              commit: {
                committed: commitResult.committed,
                sha: commitResult.sha,
                message: commitResult.message,
                ...(commitResult.repos !== undefined ? { repos: commitResult.repos } : {}),
              },
              message: `Commit failed: ${commitResult.message || 'unknown error'}`,
              nextAction: 'Resolve git/worktree issue, then call hive_worktree_commit again.',
            });
          }

          const diff = await worktreeService.getDiff(feature, task);

          const statusLabel = status === 'completed' ? 'success' : status;
          const reportLines: string[] = [
            `# Task Report: ${task}`,
            '',
            `**Feature:** ${feature}`,
            `**Completed:** ${new Date().toISOString()}`,
            `**Status:** ${statusLabel}`,
            `**Commit:** ${commitResult.sha || 'none'}`,
            '',
            '---',
            '',
            '## Summary',
            '',
            summary,
            '',
          ];

          if (diff?.hasDiff) {
            reportLines.push(
              '---',
              '',
              '## Changes',
              '',
              `- **Files changed:** ${diff.filesChanged.length}`,
              `- **Insertions:** +${diff.insertions}`,
              `- **Deletions:** -${diff.deletions}`,
              '',
            );

            if (diff.filesChanged.length > 0) {
              reportLines.push('### Files Modified', '');
              for (const file of diff.filesChanged) {
                reportLines.push(`- \`${file}\``);
              }
              reportLines.push('');
            }
          } else {
            reportLines.push('---', '', '## Changes', '', '_No file changes detected_', '');
          }

          const reportPath = taskService.writeReport(feature, task, reportLines.join('\n'));

          const finalStatus = status === 'completed' ? 'done' : status;
          taskService.update(feature, task, { status: finalStatus as any, summary });

          const worktree = await worktreeService.get(feature, task);
          return respond({
            ok: true,
            terminal: true,
            status,
            feature,
            task,
            taskState: finalStatus,
            summary,
            ...(verificationNote && { verificationNote }),
            commit: {
              committed: commitResult.committed,
              sha: commitResult.sha,
              message: commitResult.message,
              ...(commitResult.partial !== undefined ? { partial: commitResult.partial } : {}),
              ...(commitResult.error !== undefined ? { error: commitResult.error } : {}),
              ...(commitResult.repos !== undefined ? { repos: commitResult.repos } : {}),
            },
            worktreePath: worktree?.path,
            branch: worktree?.branch,
            reportPath,
            message: `Task "${task}" ${status}.`,
            nextAction: 'Use hive_merge to integrate changes. Worktree is preserved for review.',
          });
        },
      }),

      hive_worktree_discard: tool({
        description: 'Abort task: discard changes, reset status',
        args: {
          task: tool.schema.string().describe('Task folder name'),
          feature: tool.schema.string().optional().describe('Feature name (defaults to detection or single feature)'),
        },
        async execute({ task, feature: explicitFeature }) {
          const feature = resolveFeature(explicitFeature);
          if (!feature) return "Error: No feature specified. Create a feature or provide feature param.";

          await worktreeService.remove(feature, task);
          taskService.update(feature, task, { status: 'pending' });

          return `Task "${task}" aborted. Status reset to pending.`;
        },
      }),


      hive_merge: tool({
        description: 'Merge completed task branch into current branch (explicit integration)',
        args: {
          task: tool.schema.string().describe('Task folder name to merge'),
          strategy: tool.schema.enum(['merge', 'squash', 'rebase']).optional().describe('Merge strategy (default: merge)'),
          message: tool.schema.string().optional().describe('Optional merge message for merge/squash. Empty uses default.'),
          preserveConflicts: tool.schema.boolean().optional().describe('Keep merge conflict state intact instead of auto-aborting (default: false).'),
          cleanup: tool.schema.enum(['none', 'worktree', 'worktree+branch']).optional().describe('Cleanup mode after a successful merge (default: none).'),
          feature: tool.schema.string().optional().describe('Feature name (defaults to active)'),
        },
        async execute({ task, strategy = 'merge', message, preserveConflicts, cleanup, feature: explicitFeature }) {
          const failure = (error: string) => respond({
            success: false,
            merged: false,
            strategy,
            filesChanged: [],
            conflicts: [],
            conflictState: 'none',
            cleanup: {
              worktreeRemoved: false,
              branchDeleted: false,
              pruned: false,
            },
            error,
            message: `Merge failed: ${error}`,
          });

          const feature = resolveFeature(explicitFeature);
          if (!feature) return failure('No feature specified. Create a feature or provide feature param.');

          const taskInfo = taskService.get(feature, task);
          if (!taskInfo) return failure(`Task "${task}" not found`);
          if (taskInfo.status !== 'done') return failure('Task must be completed before merging. Use hive_worktree_commit first.');

          const result = await worktreeService.merge(feature, task, strategy, message, {
            preserveConflicts,
            cleanup,
          });

          const responseMessage = result.success && result.merged === false && result.reasonCode === 'NO_TRACKED_CHANGES'
            ? `Task "${task}" had no tracked changes to merge; cleanup ${result.cleanup.worktreeRemoved || result.cleanup.branchDeleted || result.cleanup.pruned ? 'completed' : 'available'}.`
            : result.success
              ? `Task "${task}" merged successfully using ${strategy} strategy.`
              : `Merge failed: ${result.error}`;

          return respond({
            ...result,
            message: responseMessage,
          });
        },
      }),

      hive_adhoc_worktree_create: tool({
        description: 'Create a short-lived ad-hoc worktree (no feature/task required). For manifest-backed projects, pass repoIds to create a composite workspace. Set autoSpawnWorker to false for inspection, routing, or setup-only worktrees that should not register a pending background worker launch. Returns structured JSON with workspacePath, branch, runId, and nextAction.',
        args: {
          runId: tool.schema.string().optional().describe('Explicit run identifier. Omit or leave blank to generate a unique safe id.'),
          label: tool.schema.string().optional().describe('Optional slug label folded into the generated runId; ignored when runId is provided. Omit or leave blank for no label.'),
          baseBranch: tool.schema.string().optional().describe('Optional base ref/commit. Omit or leave blank to use current HEAD.'),
          repoIds: tool.schema.array(tool.schema.string()).optional().describe('Explicit repo IDs for composite ad-hoc workspaces. Omit or pass an empty array for single-root mode.'),
          autoSpawnWorker: tool.schema.boolean().optional().describe('When false, create the worktree without registering a pending background worker launch (inspection/routing/setup only). Default true when omitted.'),
        },
        async execute({ runId, label, baseBranch, repoIds, autoSpawnWorker }, toolContext) {
          if (!hasRepositoryManifest() && !isProjectRootGitRepo()) {
            return respond({
              success: false,
              reason: 'repo_manifest_required',
              error:
                `Repository manifest is required: project root is not a git repository (${directory}). ` +
                `Add a project-scoped .hive/agent-hive.json with a "repositories" manifest before creating ad-hoc worktrees.`,
              nextAction: 'Add a project-scoped .hive/agent-hive.json with a "repositories" manifest, then retry hive_adhoc_worktree_create.',
            });
          }
          try {
            const normalizedRepoIds = normalizeOptionalStringList(repoIds);
            const info: AdhocWorktreeInfo = await adhocWorktreeService.create({
              runId: blankToUndefined(runId),
              label: blankToUndefined(label),
              baseBranch: blankToUndefined(baseBranch),
              repoIds: normalizedRepoIds,
            });
            const workspacePath = info.workspacePath ?? info.path;
            const parentSessionId = (toolContext as ToolContext | undefined)?.sessionID;
            const backgroundEnabled = isBackgroundSubagentsExperimentEnabled();
            const backgroundScope = backgroundEnabled && parentSessionId
              ? {
                  adHocRunId: info.runId,
                  projectRoot: directory,
                  parentSessionId,
                }
              : undefined;
            const backgroundOwnership = backgroundScope
              ? {
                  worktreePath: workspacePath,
                  branch: info.branch,
                  repoIds: normalizedRepoIds ?? [],
                }
              : undefined;
            const shouldAutoSpawnWorker = autoSpawnWorker !== false;
            const backgroundTaskCall = backgroundScope && shouldAutoSpawnWorker
              ? {
                  background: true,
                  subagent_type: 'forager-worker',
                  description: `Ad-hoc: ${info.runId}`,
                  prompt: `Work in ${workspacePath} for ad-hoc run ${info.runId}. Follow the user's current instructions, keep changes scoped to that worktree, and report verification evidence before commit or merge.`,
                }
              : undefined;
            if (backgroundTaskCall && backgroundScope && backgroundOwnership) {
              backgroundJobService.registerPendingLaunch({
                parentSessionId: backgroundScope.parentSessionId,
                expectedDescription: backgroundTaskCall.description,
                expectedPrompt: backgroundTaskCall.prompt,
                agentName: backgroundTaskCall.subagent_type,
                scope: backgroundScope,
                ownership: backgroundOwnership,
              });
            }
            const workerLaunchSuppressed = backgroundScope && !shouldAutoSpawnWorker;
            return respond({
              success: true,
              runId: info.runId,
              workspacePath,
              branch: info.branch,
              commit: info.commit,
              mode: info.mode,
              ...(info.repos ? { repos: info.repos } : {}),
              ...(info.baseCommits ? { baseCommits: info.baseCommits } : {}),
              ...(backgroundScope ? { backgroundScope } : {}),
              ...(backgroundOwnership ? { backgroundOwnership } : {}),
              ...(backgroundTaskCall ? { backgroundTaskCall } : {}),
              ...(workerLaunchSuppressed ? { workerLaunch: 'suppressed' as const } : {}),
              nextAction: workerLaunchSuppressed
                ? 'Use this worktree for inspection, routing, or setup. Delegate execution lanes explicitly when needed; call hive_adhoc_worktree_commit only after changes are ready to commit.'
                : 'Work in the ad-hoc worktree, then call hive_adhoc_worktree_commit({ runId, workspacePath, branch, message }) to commit changes.',
            });
          } catch (error: unknown) {
            const err = error as { message?: string };
            return respond({
              success: false,
              reason: 'adhoc_create_failed',
              error: err?.message ?? String(error),
              nextAction: 'Resolve the underlying error (collision, missing repo, git failure) and retry hive_adhoc_worktree_create.',
            });
          }
        },
      }),

      hive_adhoc_worktree_commit: tool({
        description: 'Commit changes in an ad-hoc worktree. Returns structured JSON with workspacePath, branch, and nextAction.',
        args: {
          runId: tool.schema.string().describe('Ad-hoc run identifier returned from hive_adhoc_worktree_create.'),
          workspacePath: tool.schema.string().describe('Workspace path returned from hive_adhoc_worktree_create.'),
          branch: tool.schema.string().describe('Branch returned from hive_adhoc_worktree_create.'),
          message: tool.schema.string().describe('Git commit message.'),
        },
        async execute({ runId, workspacePath: expectedWorkspacePath, branch: expectedBranch, message }) {
          try {
            const info = await adhocWorktreeService.get(runId);
            if (!info) {
              return respond({
                success: false,
                reason: 'adhoc_run_not_found',
                runId,
                error: `Ad-hoc run "${runId}" not found.`,
                nextAction: 'Verify the runId or create a new ad-hoc worktree with hive_adhoc_worktree_create.',
              });
            }
            const workspacePath = info.workspacePath ?? info.path;
            if (path.resolve(workspacePath) !== path.resolve(expectedWorkspacePath) || info.branch !== expectedBranch) {
              return respond({
                success: false,
                reason: 'adhoc_run_mismatch',
                runId,
                workspacePath,
                branch: info.branch,
                error: 'Provided workspacePath or branch does not match the ad-hoc run.',
                nextAction: 'Use the workspacePath and branch returned by hive_adhoc_worktree_create, or create a new ad-hoc worktree.',
              });
            }
            const result: AdhocCommitResult = await adhocWorktreeService.commit(runId, message);
            return respond({
              success: result.committed || result.message === 'No changes to commit',
              runId,
              workspacePath,
              branch: info.branch,
              commit: {
                committed: result.committed,
                sha: result.sha,
                message: result.message,
                ...(result.partial !== undefined ? { partial: result.partial } : {}),
                ...(result.error !== undefined ? { error: result.error } : {}),
                ...(result.repos !== undefined ? { repos: result.repos } : {}),
              },
              nextAction: result.committed
                ? 'Call hive_adhoc_merge({ runId }) to squash-merge the ad-hoc branch by default, pass strategy: "merge" when needed, or call hive_adhoc_cleanup to discard.'
                : (result.message === 'No changes to commit'
                  ? 'No changes were committed. Modify the worktree and retry hive_adhoc_worktree_commit.'
                  : 'Resolve the commit failure (per-repo error or git state) and retry hive_adhoc_worktree_commit.'),
            });
          } catch (error: unknown) {
            const err = error as { message?: string };
            return respond({
              success: false,
              reason: 'adhoc_commit_failed',
              runId,
              error: err?.message ?? String(error),
              nextAction: 'Resolve the underlying error and retry hive_adhoc_worktree_commit.',
            });
          }
        },
      }),

      hive_adhoc_merge: tool({
        description: 'Merge an ad-hoc worktree branch into the current branch. Defaults to squash; pass strategy: "merge" for an explicit normal merge. Returns structured JSON with workspacePath, branch, and nextAction.',
        args: {
          runId: tool.schema.string().describe('Ad-hoc run identifier.'),
          strategy: tool.schema.enum(['merge', 'squash', 'rebase']).optional().describe('Merge strategy (default: squash). Use merge explicitly when preserving branch topology is more important than minimizing commit churn.'),
          message: tool.schema.string().optional().describe('Optional merge message for merge/squash. Not supported for rebase.'),
          preserveConflicts: tool.schema.boolean().optional().describe('Keep merge conflict state intact instead of auto-aborting (default: false).'),
          cleanup: tool.schema.enum(['none', 'worktree', 'worktree+branch']).optional().describe('Cleanup mode after a successful merge (default: none).'),
        },
        async execute({ runId, strategy = 'squash', message, preserveConflicts, cleanup }) {
          try {
            const info = await adhocWorktreeService.get(runId);
            if (!info) {
              return respond({
                success: false,
                reason: 'adhoc_run_not_found',
                runId,
                error: `Ad-hoc run "${runId}" not found.`,
                nextAction: 'Verify the runId or create a new ad-hoc worktree with hive_adhoc_worktree_create.',
              });
            }
            const workspacePath = info.workspacePath ?? info.path;
            const result: AdhocMergeResult = await adhocWorktreeService.merge(runId, strategy, message, {
              preserveConflicts,
              cleanup,
            });
            return respond({
              ...result,
              runId,
              workspacePath,
              branch: info.branch,
              nextAction: result.success
                ? (result.cleanup.worktreeRemoved
                  ? 'Ad-hoc worktree cleaned up. No further action required.'
                  : 'Call hive_adhoc_cleanup({ runId, deleteBranch }) to remove the worktree when finished.')
                : 'Resolve the merge failure (conflicts, dirty target, missing branch) and retry hive_adhoc_merge.',
            });
          } catch (error: unknown) {
            const err = error as { message?: string };
            return respond({
              success: false,
              reason: 'adhoc_merge_failed',
              runId,
              error: err?.message ?? String(error),
              nextAction: 'Resolve the underlying error and retry hive_adhoc_merge.',
            });
          }
        },
      }),

      hive_adhoc_cleanup: tool({
        description: 'Remove the ad-hoc worktree (and optionally delete the branch). Returns structured JSON with workspacePath, branch, and nextAction.',
        args: {
          runId: tool.schema.string().describe('Ad-hoc run identifier.'),
          deleteBranch: tool.schema.boolean().optional().describe('Delete the ad-hoc branch in addition to the worktree (default: false).'),
        },
        async execute({ runId, deleteBranch }) {
          try {
            const info = await adhocWorktreeService.get(runId);
            if (!info) {
              return respond({
                success: false,
                reason: 'adhoc_run_not_found',
                runId,
                error: `Ad-hoc run "${runId}" not found.`,
                nextAction: 'Verify the runId or create a new ad-hoc worktree with hive_adhoc_worktree_create.',
              });
            }
            const workspacePath = info.workspacePath ?? info.path;
            const branch = info.branch;
            const result: AdhocCleanupResult = await adhocWorktreeService.cleanup(runId, deleteBranch ?? false);
            return respond({
              success: result.worktreeRemoved,
              runId,
              workspacePath,
              branch,
              cleanup: result,
              nextAction: result.worktreeRemoved
                ? 'Ad-hoc worktree removed. No further action required.'
                : 'Worktree could not be fully removed. Inspect the workspace path manually.',
            });
          } catch (error: unknown) {
            const err = error as { message?: string };
            return respond({
              success: false,
              reason: 'adhoc_cleanup_failed',
              runId,
              error: err?.message ?? String(error),
              nextAction: 'Resolve the underlying error and retry hive_adhoc_cleanup.',
            });
          }
        },
      }),

      // Context Tools
      hive_context_write: tool({
        description: 'Write a context file for the feature. System-known names: overview = human-facing summary/history, draft = planner scratchpad, execution-decisions = orchestration log; all other names stay durable free-form context.',
        args: {
          name: tool.schema.string().describe('Context file name (e.g., "overview", "draft", "execution-decisions", "learnings"). overview is the human-facing summary/history file, draft is planner scratchpad, execution-decisions is the orchestration log; other names remain durable free-form context.'),
          content: tool.schema.string().describe('Markdown content to write'),
          feature: tool.schema.string().optional().describe('Feature name (defaults to active)'),
        },
        async execute({ name, content, feature: explicitFeature }, toolContext) {
          const feature = resolveFeature(explicitFeature);
          if (!feature) return "Error: No feature specified. Create a feature or provide feature param.";
          if (!featureService.get(feature)) return `Error: Feature '${feature}' not found. Create it first with hive_feature_create.`;

          bindFeatureSession(feature, toolContext);
          const filePath = contextService.write(feature, name, content);
          return `Context file written: ${filePath}. Known names: overview = human-facing summary/history, draft = planner scratchpad, execution-decisions = orchestration log; all other context names remain durable free-form notes.`;
        },
      }),

      // Status Tool
      hive_status: tool({
        description: 'Get comprehensive status of a feature including plan, tasks, and context. Returns JSON with all relevant state for resuming work.',
        args: {
          feature: tool.schema.string().optional().describe('Feature name (defaults to active)'),
        },
        async execute({ feature: explicitFeature }) {
          const respond = (payload: Record<string, unknown>) => JSON.stringify(payload, null, 2);
          const feature = resolveFeature(explicitFeature);
          if (!feature) {
            return respond({
              success: false,
              terminal: true,
              reason: 'feature_required',
              error: 'No feature specified and no active feature found',
              hint: 'Use hive_feature_create to create a new feature',
            });
          }

          const featureData = featureService.get(feature);
          if (!featureData) {
            return respond({
              success: false,
              terminal: true,
              reason: 'feature_not_found',
              error: `Feature '${feature}' not found`,
              availableFeatures: featureService.list(),
            });
          }

          const blocked = checkBlocked(feature);
          if (blocked) {
            return respond({
              success: false,
              terminal: true,
              blocked: true,
              error: blocked,
              hints: [
                'Read the blocker details and resolve them before retrying hive_status.',
                `Remove .hive/features/${resolveFeatureDirectoryName(directory, feature)}/BLOCKED once the blocker is resolved.`,
              ],
            });
          }

          const plan = planService.read(feature);
          const tasks = taskService.list(feature);
          const featureContextFiles = contextService.list(feature);
          const overview = contextService.getOverview(feature);
          const readThreads = (filePath: string): Array<unknown> | null => {
            if (!fs.existsSync(filePath)) {
              return null;
            }

            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as { threads?: Array<unknown> };
              return data.threads ?? [];
            } catch {
              return [];
            }
          };
          const featurePath = path.join(directory, '.hive', 'features', resolveFeatureDirectoryName(directory, feature));
          const reviewDir = path.join(featurePath, 'comments');
          const planThreads = readThreads(path.join(reviewDir, 'plan.json')) ?? readThreads(path.join(featurePath, 'comments.json'));
          const overviewThreads = readThreads(path.join(reviewDir, 'overview.json'));
          const reviewCounts = {
            plan: planThreads?.length ?? 0,
            overview: overviewThreads?.length ?? 0,
          };

          const tasksSummary = await Promise.all(tasks.map(async t => {
            const rawStatus = taskService.getRawStatus(feature, t.folder);
            const worktree = await worktreeService.get(feature, t.folder);
            const hasChanges = worktree
              ? await worktreeService.hasUncommittedChanges(worktree.feature, worktree.step)
              : null;

            return {
              folder: t.folder,
              name: t.name,
              status: t.status,
              origin: t.origin || 'plan',
              dependsOn: rawStatus?.dependsOn ?? null,
              repoIds: t.repoIds ?? null,
              worktree: worktree ? {
                branch: worktree.branch,
                hasChanges,
              } : null,
            };
          }));

          const contextSummary = featureContextFiles.map(c => ({
            name: c.name,
            chars: c.content.length,
            updatedAt: c.updatedAt,
            role: c.role,
            includeInExecution: c.includeInExecution,
            includeInNetwork: c.includeInNetwork,
          }));

          const pendingTasks = tasksSummary.filter(t => t.status === 'pending');
          const inProgressTasks = tasksSummary.filter(t => t.status === 'in_progress');
          const doneTasks = tasksSummary.filter(t => t.status === 'done');
          const doneTasksWithLiveWorktrees = tasksSummary
            .filter(t => t.status === 'done' && t.worktree)
            .map(t => t.folder);
          const dirtyWorktrees = tasksSummary
            .filter(t => t.worktree && t.worktree.hasChanges === true)
            .map(t => t.folder);
          const nonInProgressTasksWithWorktrees = tasksSummary
            .filter(t => t.status !== 'in_progress' && t.worktree)
            .map(t => t.folder);
          const mergeEligibility = tasksSummary.map(t => {
            const eligible = t.status === 'done' && !!t.worktree;
            const reasonCode = eligible
              ? 'TASK_DONE_WITH_LIVE_WORKTREE'
              : t.status !== 'done'
                ? 'TASK_NOT_DONE'
                : 'NO_LIVE_WORKTREE';

            return {
              task: t.folder,
              eligible,
              reasonCode,
              ...(eligible ? { recommendedCommand: `hive_merge({ task: "${t.folder}" })` } : {}),
            };
          });

          const tasksWithDeps = tasksSummary.map(t => ({
            folder: t.folder,
            status: t.status,
            dependsOn: t.dependsOn ?? undefined,
          }));
          const effectiveDeps = buildEffectiveDependencies(tasksWithDeps);
          const normalizedTasks = tasksWithDeps.map(task => ({
            ...task,
            dependsOn: effectiveDeps.get(task.folder),
          }));
          const { runnable, blocked: blockedBy } = computeRunnableAndBlocked(normalizedTasks);
          const ambiguityFlags: string[] = [];

          if (doneTasksWithLiveWorktrees.length > 0) {
            ambiguityFlags.push('done_task_has_live_worktree');
          }

          if (dirtyWorktrees.some(folder => nonInProgressTasksWithWorktrees.includes(folder))) {
            ambiguityFlags.push('dirty_non_in_progress_worktree');
          }

          if (runnable.length > 1) {
            ambiguityFlags.push('multiple_runnable_tasks');
          }

          if (pendingTasks.length > 0 && runnable.length === 0) {
            ambiguityFlags.push('pending_tasks_blocked');
          }

          const getNextAction = (
            planStatus: string | null,
            tasks: Array<{ status: string; folder: string }>,
            runnableTasks: string[],
            hasPlan: boolean,
            hasOverview: boolean,
          ): string => {
            if (planStatus === 'review') {
              return 'Wait for plan approval or revise based on comments';
            }
            if (!hasPlan || planStatus === 'draft') {
              return 'Write or revise plan with hive_plan_write. Refresh context/overview.md first for human review; plan.md remains execution truth and pre-task Mermaid overview diagrams are optional.';
            }
            if (tasks.length === 0) {
              return 'Generate tasks from plan with hive_tasks_sync';
            }
            const inProgress = tasks.find(t => t.status === 'in_progress');
            if (inProgress) {
              return `Continue work on task: ${inProgress.folder}`;
            }
            if (runnableTasks.length > 1) {
              return `${runnableTasks.length} tasks are ready to start in parallel: ${runnableTasks.join(', ')}`;
            }
            if (runnableTasks.length === 1) {
              return `Start next task with hive_worktree_start: ${runnableTasks[0]}`;
            }
            const pending = tasks.find(t => t.status === 'pending');
            if (pending) {
              return `Pending tasks exist but are blocked by dependencies. Check blockedBy for details.`;
            }
            return 'All tasks complete. Review and merge or complete feature.';
          };

          const planStatus = featureData.status === 'planning' ? 'draft' :
            featureData.status === 'approved' ? 'approved' :
              featureData.status === 'executing' ? 'locked' : 'none';

          return respond({
            feature: {
              name: feature,
              status: featureData.status,
              ticket: featureData.ticket || null,
              createdAt: featureData.createdAt,
            },
            plan: {
              exists: !!plan,
              status: planStatus,
              approved: planStatus === 'approved' || planStatus === 'locked',
            },
            overview: {
              exists: !!overview,
              path: `.hive/features/${feature}/context/overview.md`,
              updatedAt: overview?.updatedAt ?? null,
            },
            review: {
              unresolvedTotal: reviewCounts.plan + reviewCounts.overview,
              byDocument: {
                overview: reviewCounts.overview,
                plan: reviewCounts.plan,
              },
            },
            tasks: {
              total: tasks.length,
              pending: pendingTasks.length,
              inProgress: inProgressTasks.length,
              done: doneTasks.length,
              list: tasksSummary,
              runnable,
              blockedBy,
            },
            helperStatus: {
              doneTasksWithLiveWorktrees,
              dirtyWorktrees,
              nonInProgressTasksWithWorktrees,
              mergeEligibility,
              manualTaskPolicy: {
                order: {
                  omitted: 'append_next_order',
                  explicitNextOrder: 'append_next_order',
                  explicitOtherOrder: 'plan_amendment_required',
                },
                dependsOn: {
                  omitted: 'store_empty_array',
                  explicitDoneTargetsOnly: 'allowed',
                  explicitMissingTarget: 'plan_amendment_required',
                  explicitNotDoneTarget: 'plan_amendment_required',
                  reviewSourceWithExplicitDependsOn: 'plan_amendment_required',
                },
              },
              ambiguityFlags,
            },
            context: {
              fileCount: featureContextFiles.length,
              files: contextSummary,
            },
            warning: configFallbackWarning ?? undefined,
            nextAction: getNextAction(planStatus, tasksSummary, runnable, !!plan, !!overview),
          });
        },
      }),

    },

    command: {
      [HIVE_COMMANDS[0].key]: {
        description: HIVE_COMMANDS[0].description,
        async run(args: string) {
          const name = args.trim();
          if (!name) return "Usage: /hive <feature-name>";
          return `Create feature "${name}" using hive_feature_create tool.`;
        },
      },
    },

    // Config hook - merge agents into opencodeConfig.agent
    config: async (opencodeConfig: Record<string, unknown>) => {
      runtimeAgentPrompts.clear();

      function agentTools(allowed: string[]): Record<string, boolean> {
        const result: Record<string, boolean> = {};
        for (const tool of HIVE_TOOL_NAMES) {
          if (!allowed.includes(tool)) {
            result[tool] = false;
          }
        }
        return result;
      }
      // Auto-generate config file with defaults if it doesn't exist
      configService.init();
      const existingSkillsConfig =
        typeof opencodeConfig.skills === 'object' && opencodeConfig.skills !== null
          ? opencodeConfig.skills as { paths?: string[]; urls?: string[] }
          : undefined;
      const preparedNativeHiveSkills = await prepareNativeHiveSkills({
        directory,
        worktree: worktree || directory,
        disableSkills: configService.getDisabledSkills(),
        opencodeConfig: {
          skills: {
            paths: existingSkillsConfig?.paths,
            urls: existingSkillsConfig?.urls,
          },
        },
      });
      const skippedHiveSkills = new Map(
        preparedNativeHiveSkills.skipped.map((skill) => [skill.name, skill] as const),
      );
      opencodeConfig.skills = {
        ...(existingSkillsConfig ?? {}),
        paths: preparedNativeHiveSkills.skillPaths,
      };
      const hiveConfigData = configService.get();
      const agentMode = hiveConfigData.agentMode ?? 'unified';

      const customAgentConfigs = getCustomAgentConfigsCompat(configService);
      const customSubagentAppendix = Object.keys(customAgentConfigs).length === 0
        ? ''
        : `\n\n## Configured Custom Subagents\nCustom subagents are scoped specialists, not automatic model upgrades.
Choose a custom subagent when its description matches the task's domain, workflow, artifact type, or review/approach risk lens, or when the operator explicitly names it.
Use the built-in base agent when no configured custom description is a closer task fit.
Do not choose a custom subagent only because the task is important, complex, or quality-sensitive.\n${Object.entries(customAgentConfigs)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([name, config]) => `- \`${name}\` — derived from \`${config.baseAgent}\`; ${config.description}`)
          .join('\n')}`;

      // Build auto-load skill guidance for each agent
      const hiveUserConfig = configService.getAgentConfig('hive-master');
      const hiveAutoLoadSkillsAppendix = buildAutoLoadSkillsPromptAppendix(
        'hive-master',
        configService,
        preparedNativeHiveSkills.nativeSkillsByName,
        preparedNativeHiveSkills.skillsByName,
        skippedHiveSkills,
      );
      const hiveBackgroundDelegationAppendix = buildBackgroundDelegationPromptAppendix(
        'hive-master',
        preparedNativeHiveSkills.nativeSkillsByName,
        preparedNativeHiveSkills.skillsByName,
        skippedHiveSkills,
      );
      const hivePrompt = QUEEN_BEE_PROMPT + HIVE_SYSTEM_PROMPT + hiveAutoLoadSkillsAppendix + hiveBackgroundDelegationAppendix + (agentMode === 'unified' ? customSubagentAppendix : '');
      runtimeAgentPrompts.set('hive-master', hivePrompt);
      const hiveConfig = {
        model: hiveUserConfig.model,
        variant: hiveUserConfig.variant,
        temperature: hiveUserConfig.temperature ?? 0.5,
        description: 'Hive (Hybrid) - Plans + orchestrates. Detects phase, loads skills on-demand.',
        permission: {
          question: "allow",
          skill: "allow",
          todowrite: "allow",
          todoread: "allow",
        },
      };

      const architectUserConfig = configService.getAgentConfig('architect-planner');
      const architectAutoLoadSkillsAppendix = buildAutoLoadSkillsPromptAppendix(
        'architect-planner',
        configService,
        preparedNativeHiveSkills.nativeSkillsByName,
        preparedNativeHiveSkills.skillsByName,
        skippedHiveSkills,
      );
      const architectBackgroundDelegationAppendix = buildBackgroundDelegationPromptAppendix(
        'architect-planner',
        preparedNativeHiveSkills.nativeSkillsByName,
        preparedNativeHiveSkills.skillsByName,
        skippedHiveSkills,
      );
      const architectConfig = {
        model: architectUserConfig.model,
        variant: architectUserConfig.variant,
        temperature: architectUserConfig.temperature ?? 0.7,
        description: 'Architect (Planner) - Plans features, interviews, writes plans. NEVER executes.',
        prompt: ARCHITECT_BEE_PROMPT + HIVE_SYSTEM_PROMPT + architectAutoLoadSkillsAppendix + architectBackgroundDelegationAppendix + (agentMode === 'dedicated' ? customSubagentAppendix : ''),
        tools: agentTools([
          'hive_feature_create', 'hive_plan_write', 'hive_plan_read', 'hive_context_write', 'hive_status',
          'hive_repositories_status', 'hive_repositories_discover', 'hive_repositories_update',
          'hive_background_status', 'hive_background_reconcile', 'hive_background_reconcile_batch', 'hive_background_cancel',
        ]),
        permission: {
          edit: "deny",  // Planners don't edit code
          task: "allow",
          question: "allow",
          skill: "allow",
          todowrite: "allow",
          todoread: "allow",
          webfetch: "allow",
        },
      };

      const swarmUserConfig = configService.getAgentConfig('swarm-orchestrator');
      const swarmAutoLoadSkillsAppendix = buildAutoLoadSkillsPromptAppendix(
        'swarm-orchestrator',
        configService,
        preparedNativeHiveSkills.nativeSkillsByName,
        preparedNativeHiveSkills.skillsByName,
        skippedHiveSkills,
      );
      const swarmBackgroundDelegationAppendix = buildBackgroundDelegationPromptAppendix(
        'swarm-orchestrator',
        preparedNativeHiveSkills.nativeSkillsByName,
        preparedNativeHiveSkills.skillsByName,
        skippedHiveSkills,
      );
      const swarmPrompt = SWARM_BEE_PROMPT + HIVE_SYSTEM_PROMPT + swarmAutoLoadSkillsAppendix + swarmBackgroundDelegationAppendix + (agentMode === 'dedicated' ? customSubagentAppendix : '');
      runtimeAgentPrompts.set('swarm-orchestrator', swarmPrompt);
      const swarmConfig = {
        model: swarmUserConfig.model,
        variant: swarmUserConfig.variant,
        temperature: swarmUserConfig.temperature ?? 0.5,
        description: 'Swarm (Orchestrator) - Orchestrates execution. Delegates, spawns workers, verifies, merges.',
        tools: agentTools([
          'hive_feature_create', 'hive_feature_complete', 'hive_plan_read', 'hive_plan_approve',
          'hive_repositories_status', 'hive_repositories_discover', 'hive_repositories_update',
          'hive_tasks_sync', 'hive_task_create', 'hive_task_update',
          'hive_worktree_start', 'hive_worktree_create', 'hive_worktree_discard', 'hive_merge',
          'hive_context_write', 'hive_status',
          'hive_background_status', 'hive_background_reconcile', 'hive_background_reconcile_batch', 'hive_background_cancel',
        ]),
        permission: {
          question: "allow",
          skill: "allow",
          todowrite: "allow",
          todoread: "allow",
        },
      };

      const scoutUserConfig = configService.getAgentConfig('scout-researcher');
      const scoutAutoLoadSkillsAppendix = buildAutoLoadSkillsPromptAppendix(
        'scout-researcher',
        configService,
        preparedNativeHiveSkills.nativeSkillsByName,
        preparedNativeHiveSkills.skillsByName,
        skippedHiveSkills,
      );
      const scoutConfig = {
        model: scoutUserConfig.model,
        variant: scoutUserConfig.variant,
        temperature: scoutUserConfig.temperature ?? 0.5,
        mode: 'subagent' as const,
        description: 'Scout (Explorer/Researcher/Retrieval) - Researches codebase + external docs/data.',
        prompt: SCOUT_BEE_PROMPT + HIVE_SYSTEM_PROMPT + scoutAutoLoadSkillsAppendix,
        tools: agentTools(['hive_plan_read', 'hive_context_write', 'hive_status']),
        permission: {
          edit: "deny",  // Researchers don't edit code
          task: "deny",
          delegate: "deny",
          skill: "allow",
          webfetch: "allow",
        },
      };

      const foragerUserConfig = configService.getAgentConfig('forager-worker');
      const foragerAutoLoadSkillsAppendix = buildAutoLoadSkillsPromptAppendix(
        'forager-worker',
        configService,
        preparedNativeHiveSkills.nativeSkillsByName,
        preparedNativeHiveSkills.skillsByName,
        skippedHiveSkills,
      );
      const foragerPrompt = FORAGER_BEE_PROMPT + HIVE_SYSTEM_PROMPT + foragerAutoLoadSkillsAppendix;
      runtimeAgentPrompts.set('forager-worker', foragerPrompt);
      const foragerConfig = {
        model: foragerUserConfig.model,
        variant: foragerUserConfig.variant,
        temperature: foragerUserConfig.temperature ?? 0.3,
        mode: 'subagent' as const,
        description: 'Forager (Worker/Coder) - Executes tasks directly in isolated worktrees. Never delegates.',
        tools: agentTools(['hive_plan_read', 'hive_worktree_commit', 'hive_context_write']),
        permission: {
          task: "deny",
          delegate: "deny",
          skill: "allow",
        },
      };

      const hiveHelperUserConfig = configService.getAgentConfig('hive-helper');
      const hiveHelperConfig = {
        model: hiveHelperUserConfig.model,
        variant: hiveHelperUserConfig.variant,
        temperature: hiveHelperUserConfig.temperature ?? 0.3,
        mode: 'subagent' as const,
        description: 'Hive Helper - Runtime-only bounded hard-task operational assistant for merge recovery, state clarification, and safe manual follow-up assistance.',
        prompt: HIVE_HELPER_PROMPT + HIVE_SYSTEM_PROMPT,
        tools: agentTools(['hive_merge', 'hive_status', 'hive_context_write', 'hive_task_create']),
        permission: {
          task: 'deny',
          delegate: 'deny',
          skill: 'allow',
        },
      };

      const reviewerPermissions = {
        edit: 'deny',
        task: 'deny',
        delegate: 'deny',
        skill: 'allow',
      };

      function buildReviewerConfig(
        agentName: 'plan-reviewer' | 'code-reviewer' | 'simplicity-reviewer' | 'approach-advisor',
        prompt: string,
        description: string,
      ) {
        const userConfig = configService.getAgentConfig(agentName);
        const autoLoadSkillsAppendix = buildAutoLoadSkillsPromptAppendix(
          agentName,
          configService,
          preparedNativeHiveSkills.nativeSkillsByName,
          preparedNativeHiveSkills.skillsByName,
          skippedHiveSkills,
        );
        return {
          model: userConfig.model,
          variant: userConfig.variant,
          temperature: userConfig.temperature ?? 0.3,
          mode: 'subagent' as const,
          description,
          prompt: prompt + HIVE_SYSTEM_PROMPT + autoLoadSkillsAppendix,
          tools: agentTools(['hive_plan_read', 'hive_context_write', 'hive_status']),
          permission: reviewerPermissions,
        };
      }

      const planReviewerConfig = buildReviewerConfig(
        'plan-reviewer',
        PLAN_REVIEWER_PROMPT,
        'Plan Reviewer - Reviews Hive plans for worker readiness, references, dependencies, and executable verification. OKAY/REJECT verdict.',
      );
      const codeReviewerConfig = buildReviewerConfig(
        'code-reviewer',
        CODE_REVIEWER_PROMPT,
        'Code Reviewer - Reviews implementation diffs against task or plan requirements for correctness, tests, risk, scope creep, YAGNI, and dead code.',
      );
      const simplicityReviewerConfig = buildReviewerConfig(
        'simplicity-reviewer',
        SIMPLICITY_REVIEWER_PROMPT,
        'Simplicity Reviewer - Final post-implementation cleanup reviewer for YAGNI, dead code, duplication, unnecessary abstractions, and safe deletion-biased simplification.',
      );
      const approachAdvisorConfig = buildReviewerConfig(
        'approach-advisor',
        APPROACH_ADVISOR_PROMPT,
        'Approach Advisor - Read-only technical advisor for approach, architecture, hard debugging direction, and tradeoffs.',
      );

      const builderUserConfig = configService.getAgentConfig('hive-builder');
      const builderAutoLoadSkillsAppendix = buildAutoLoadSkillsPromptAppendix(
        'hive-builder',
        configService,
        preparedNativeHiveSkills.nativeSkillsByName,
        preparedNativeHiveSkills.skillsByName,
        skippedHiveSkills,
      );
      const builderBackgroundDelegationAppendix = buildBackgroundDelegationPromptAppendix(
        'hive-builder',
        preparedNativeHiveSkills.nativeSkillsByName,
        preparedNativeHiveSkills.skillsByName,
        skippedHiveSkills,
      );
      const builderPrompt = HIVE_BUILDER_PROMPT + builderAutoLoadSkillsAppendix + builderBackgroundDelegationAppendix + customSubagentAppendix;
      runtimeAgentPrompts.set('hive-builder', builderPrompt);
      const builderConfig = {
        model: builderUserConfig.model,
        variant: builderUserConfig.variant,
        temperature: builderUserConfig.temperature ?? 0.4,
        description: 'Hive Builder - Hive-aware ad-hoc executor with lightweight worktree, verification, merge, and cleanup flow.',
        tools: agentTools([
          'hive_repositories_status', 'hive_repositories_discover', 'hive_repositories_update',
          'hive_adhoc_worktree_create', 'hive_adhoc_worktree_commit', 'hive_adhoc_merge', 'hive_adhoc_cleanup',
          'hive_background_status', 'hive_background_reconcile', 'hive_background_reconcile_batch', 'hive_background_cancel',
          'hive_context_write',
        ]),
        permission: {
          task: 'allow',
          question: 'allow',
          skill: 'allow',
          todowrite: 'allow',
          todoread: 'allow',
        },
      };

      const builtInAgentConfigs = {
        'hive-master': hiveConfig,
        'architect-planner': architectConfig,
        'swarm-orchestrator': swarmConfig,
        'scout-researcher': scoutConfig,
        'forager-worker': foragerConfig,
        'hive-helper': hiveHelperConfig,
        'plan-reviewer': planReviewerConfig,
        'code-reviewer': codeReviewerConfig,
        'simplicity-reviewer': simplicityReviewerConfig,
        'approach-advisor': approachAdvisorConfig,
        'hive-builder': builderConfig,
      };

      const customAutoLoadSkillsAppendices = Object.fromEntries(
        Object.entries(customAgentConfigs).map(([customAgentName, customAgentConfig]) => {
            const inheritedBaseSkills = configService.getAgentConfig(customAgentConfig.baseAgent).autoLoadSkills ?? [];
            const deltaAutoLoadSkills = (customAgentConfig.autoLoadSkills ?? []).filter(
              (skill) => !inheritedBaseSkills.includes(skill),
            );

            return [
              customAgentName,
              buildAutoLoadSkillsPromptAppendix(
                customAgentName,
                configService,
                preparedNativeHiveSkills.nativeSkillsByName,
                preparedNativeHiveSkills.skillsByName,
                skippedHiveSkills,
                deltaAutoLoadSkills,
              ),
            ];
        }),
      );

      const customSubagents = buildCustomSubagents({
        customAgents: customAgentConfigs,
        baseAgents: {
          'scout-researcher': scoutConfig,
          'forager-worker': foragerConfig,
          'plan-reviewer': planReviewerConfig,
          'code-reviewer': codeReviewerConfig,
          'simplicity-reviewer': simplicityReviewerConfig,
          'approach-advisor': approachAdvisorConfig,
        },
        baseRuntimePrompts: {
          'forager-worker': foragerPrompt,
        },
        autoLoadSkillAppendices: customAutoLoadSkillsAppendices,
        registerRuntimePrompt: (agentName, prompt) => runtimeAgentPrompts.set(agentName, prompt),
      });

      // Build agents map based on agentMode
      const allAgents: Record<string, unknown> = {};
      
      if (agentMode === 'unified') {
        allAgents['hive-master'] = builtInAgentConfigs['hive-master'];
        allAgents['scout-researcher'] = builtInAgentConfigs['scout-researcher'];
        allAgents['forager-worker'] = builtInAgentConfigs['forager-worker'];
        allAgents['hive-helper'] = builtInAgentConfigs['hive-helper'];
        allAgents['plan-reviewer'] = builtInAgentConfigs['plan-reviewer'];
        allAgents['code-reviewer'] = builtInAgentConfigs['code-reviewer'];
        allAgents['simplicity-reviewer'] = builtInAgentConfigs['simplicity-reviewer'];
        allAgents['approach-advisor'] = builtInAgentConfigs['approach-advisor'];
      } else {
        allAgents['architect-planner'] = builtInAgentConfigs['architect-planner'];
        allAgents['swarm-orchestrator'] = builtInAgentConfigs['swarm-orchestrator'];
        allAgents['scout-researcher'] = builtInAgentConfigs['scout-researcher'];
        allAgents['forager-worker'] = builtInAgentConfigs['forager-worker'];
        allAgents['hive-helper'] = builtInAgentConfigs['hive-helper'];
        allAgents['plan-reviewer'] = builtInAgentConfigs['plan-reviewer'];
        allAgents['code-reviewer'] = builtInAgentConfigs['code-reviewer'];
        allAgents['simplicity-reviewer'] = builtInAgentConfigs['simplicity-reviewer'];
        allAgents['approach-advisor'] = builtInAgentConfigs['approach-advisor'];
      }
      allAgents['hive-builder'] = builtInAgentConfigs['hive-builder'];

      Object.assign(allAgents, customSubagents);

      // Merge agents into opencodeConfig.agent (config hook is sufficient for agent discovery)
      const configAgent = opencodeConfig.agent as Record<string, unknown> | undefined;
      if (!configAgent) {
        opencodeConfig.agent = allAgents;
      } else {
        // Clean up old single-word agent names
        delete (configAgent as Record<string, unknown>).hive;
        delete (configAgent as Record<string, unknown>).architect;
        delete (configAgent as Record<string, unknown>).swarm;
        delete (configAgent as Record<string, unknown>).scout;
        delete (configAgent as Record<string, unknown>).forager;
        delete (configAgent as Record<string, unknown>).hygienic;
        delete (configAgent as Record<string, unknown>)['plan-reviewer'];
        delete (configAgent as Record<string, unknown>)['code-reviewer'];
        delete (configAgent as Record<string, unknown>)['simplicity-reviewer'];
        delete (configAgent as Record<string, unknown>)['approach-advisor'];
        delete (configAgent as Record<string, unknown>).receiver;
        // Clean up old kebab-case names (in case they exist)
        delete (configAgent as Record<string, unknown>)['hive-master'];
        delete (configAgent as Record<string, unknown>)['architect-planner'];
        delete (configAgent as Record<string, unknown>)['swarm-orchestrator'];
        delete (configAgent as Record<string, unknown>)['scout-researcher'];
        delete (configAgent as Record<string, unknown>)['forager-worker'];
        delete (configAgent as Record<string, unknown>)['hive-helper'];
        delete (configAgent as Record<string, unknown>)['hygienic-reviewer'];
        delete (configAgent as Record<string, unknown>)['hive-builder'];
        Object.assign(configAgent, allAgents);
      }

      // Set default agent based on mode
      (opencodeConfig as Record<string, unknown>).default_agent = 
        agentMode === 'unified' ? 'hive-master' : 'architect-planner';

      // Merge built-in MCP servers (OMO-style remote endpoints)
      const configMcp = opencodeConfig.mcp as Record<string, unknown> | undefined;
      if (!configMcp) {
        opencodeConfig.mcp = builtinMcps;
      } else {
        Object.assign(configMcp, builtinMcps);
      }

    },
  };
};

export default plugin;
