import * as fs from 'fs';
import * as path from 'path';
import {
  BUILT_IN_AGENT_NAMES,
  CUSTOM_AGENT_BASES,
  CUSTOM_AGENT_RESERVED_NAMES,
  DEFAULT_HIVE_CONFIG,
  DEFAULT_ROUTING_AGENT_DESCRIPTIONS,
  STARTER_CUSTOM_AGENTS,
} from '../types.js';
import { isValidRepositoryConfig } from '../utils/repositoryConfig.js';
import { acquireLockSync, writeAtomic } from '../utils/paths.js';
import type {
  AgentModelConfig,
  BuiltInAgentName,
  CouncilConfig,
  CustomAgentBase,
  HiveConfig,
  ResolvedCustomAgentConfig,
} from '../types.js';

const STORED_CONFIG_KEYS = new Set([
  '$schema',
  'repositoryRoot',
  'repositories',
  'enableToolsFor',
  'disableSkills',
  'agentMode',
  'hook_cadence',
  'council',
  'taskTraceSummarizer',
  'agents',
  'customAgents',
]);

type ConfigReadFailureReason = 'parse_error' | 'validation_error' | 'read_error';

interface AgentModelVariantOverride {
  model?: string;
  variant?: string;
}

interface ProjectAgentOverrides {
  $schema?: string;
  agents?: Record<string, AgentModelVariantOverride>;
  customAgents?: Record<string, AgentModelVariantOverride>;
}

type ProjectAgentOverrideRead =
  | { ok: true; value: ProjectAgentOverrides | null }
  | { ok: false; reason: ConfigReadFailureReason };

/**
 * ConfigService resolves global Agent Hive config and an optional project agent model/variant override.
 * Writes remain scoped to ~/.config/opencode/agent_hive.json.
 */
export class ConfigService {
  private configPath: string;
  private projectAgentOverridePath: string | null;
  private cachedConfig: HiveConfig | null = null;
  private cachedCustomAgentConfigs: Record<string, ResolvedCustomAgentConfig> | null = null;
  private cachedProjectAgentOverrideRead: ProjectAgentOverrideRead | null = null;
  private lastFallbackWarning: {
    message: string;
    sourceType: 'project' | 'global';
    sourcePath: string;
    fallbackType: 'global' | 'defaults';
    fallbackPath?: string;
    reason: ConfigReadFailureReason;
  } | null = null;

  constructor(projectRoot?: string) {
    const homeDir = process.env.HOME || process.env.USERPROFILE || '';
    const configDir = path.join(homeDir, '.config', 'opencode');
    this.configPath = path.join(configDir, 'agent_hive.json');
    this.projectAgentOverridePath = projectRoot
      ? path.join(path.resolve(projectRoot), '.hive', 'agent-hive.override.json')
      : null;
  }

  /**
   * Get config path
   */
  getPath(): string {
    return this.configPath;
  }

  /**
   * Get the full config, merged with defaults.
   */
  get(): HiveConfig {
    if (this.cachedConfig !== null) {
      return this.cachedConfig;
    }

    if (!fs.existsSync(this.configPath)) {
      return this.cacheEffectiveConfig({ ...DEFAULT_HIVE_CONFIG }, 'defaults');
    }

    const globalStored = this.readStoredConfig(this.configPath);
    if (globalStored.ok) {
      return this.cacheEffectiveConfig(this.mergeWithDefaults(globalStored.value), 'global');
    }

    const fallbackReason = 'reason' in globalStored ? globalStored.reason : 'read_error';
    return this.cacheEffectiveConfig({ ...DEFAULT_HIVE_CONFIG }, 'defaults', fallbackReason);
  }

  getActiveReadSourceType(): 'project' | 'global' {
    return 'global';
  }

  getActiveReadPath(): string {
    return this.configPath;
  }

  readStored(): Partial<HiveConfig> {
    if (!fs.existsSync(this.configPath)) {
      return {};
    }

    const stored = this.readStoredConfig(this.configPath);
    if (!stored.ok) {
      throw new Error(`Invalid global Agent Hive config: ${this.configPath}`);
    }
    return stored.value;
  }

  removeLegacyRepositoryManifestIfMatches(
    repositoryRoot: string,
    repositories: NonNullable<HiveConfig['repositories']>,
  ): 'removed' | 'skipped' {
    const release = acquireLockSync(this.configPath);
    try {
      const stored = this.readStored();
      if (
        stored.repositoryRoot !== repositoryRoot
        || JSON.stringify(stored.repositories) !== JSON.stringify(repositories)
      ) {
        this.cachedConfig = null;
        this.cachedCustomAgentConfigs = null;
        return 'skipped';
      }
      const next = { ...stored } as Record<string, unknown>;
      delete next.repositoryRoot;
      delete next.repositories;
      writeAtomic(this.configPath, JSON.stringify(next, null, 2));
      this.cachedConfig = null;
      this.cachedCustomAgentConfigs = null;
      return 'removed';
    } finally {
      release();
    }
  }

  getLastFallbackWarning(): {
    message: string;
    sourceType: 'project' | 'global';
    sourcePath: string;
    fallbackType: 'global' | 'defaults';
    fallbackPath?: string;
    reason: ConfigReadFailureReason;
  } | null {
    return this.lastFallbackWarning;
  }

  /**
   * Update config (partial merge).
   */
  set(updates: Partial<HiveConfig>): HiveConfig {
    const release = acquireLockSync(this.configPath);
    try {
      const current = this.readStored();
      const mergedAgentUpdates = updates.agents
        ? Object.fromEntries(
            Object.entries(updates.agents).map(([agentName, incoming]) => {
              const declaration: AgentModelConfig & { description?: string } = {
                ...current.agents?.[agentName as BuiltInAgentName],
                ...incoming,
              };
              if (
                this.isObjectRecord(incoming)
                && 'description' in incoming
                && (
                  incoming.description === undefined
                  || (typeof incoming.description === 'string' && incoming.description.trim() === '')
                )
              ) {
                delete declaration.description;
              }
              return [agentName, declaration];
            }),
          ) as NonNullable<HiveConfig['agents']>
        : undefined;
      const stored: Partial<HiveConfig> = {
        ...current,
        ...updates,
        agents: mergedAgentUpdates ? {
          ...current.agents,
          ...mergedAgentUpdates,
        } : current.agents,
        customAgents: updates.customAgents
          ? {
              ...current.customAgents,
              ...updates.customAgents,
            }
          : current.customAgents,
      };

      if (!this.isValidStoredConfig(stored)) {
        throw new Error('Invalid global Agent Hive config');
      }
      if (stored.repositoryRoot !== undefined && !fs.existsSync(stored.repositoryRoot)) {
        throw new Error(`Repository root does not exist: ${stored.repositoryRoot}`);
      }

      writeAtomic(this.configPath, JSON.stringify(stored, null, 2));
      const merged = this.mergeWithDefaults(stored);
      return this.cacheEffectiveConfig(merged, 'global');
    } finally {
      release();
    }
  }

  /**
   * Check if config file exists.
   */
  exists(): boolean {
    return fs.existsSync(this.configPath);
  }

  /**
   * Initialize config with defaults if it doesn't exist.
   * A newly created file includes the starter custom agent templates; existing
   * files keep only the custom agents they declare.
   */
  init(): HiveConfig {
    const resolved = this.get();

    if (!this.exists()) {
      return this.set({
        ...DEFAULT_HIVE_CONFIG,
        customAgents: { ...STARTER_CUSTOM_AGENTS },
      });
    }
    return resolved;
  }

  /**
   * Get agent-specific model config
   */
  getAgentConfig(agent: BuiltInAgentName): AgentModelConfig;
  getAgentConfig(agent: string): AgentModelConfig | ResolvedCustomAgentConfig;
  getAgentConfig(agent: string): AgentModelConfig | ResolvedCustomAgentConfig {
    const config = this.get();

    if (this.isBuiltInAgent(agent)) {
      const agentConfig = config.agents?.[agent] ?? {};
      const defaultAutoLoadSkills = DEFAULT_HIVE_CONFIG.agents?.[agent]?.autoLoadSkills ?? [];
      const effectiveAutoLoadSkills = agent === 'hive-helper'
        ? defaultAutoLoadSkills
        : this.resolveAutoLoadSkills(
            defaultAutoLoadSkills,
            agentConfig.autoLoadSkills ?? [],
            this.isPlannerAgent(agent),
          );

      return {
        ...agentConfig,
        autoLoadSkills: effectiveAutoLoadSkills,
      };
    }

    const customAgents = this.getCustomAgentConfigs();
    return customAgents[agent] ?? {};
  }

  getRoutingAgentDescription(baseAgent: CustomAgentBase): string {
    const configured = this.get().agents?.[baseAgent]?.description?.trim();
    return configured || DEFAULT_ROUTING_AGENT_DESCRIPTIONS[baseAgent];
  }

  getCustomAgentConfigs(): Record<string, ResolvedCustomAgentConfig> {
    if (this.cachedCustomAgentConfigs !== null) {
      return this.cachedCustomAgentConfigs;
    }

    const config = this.get();
    const customAgents = this.isObjectRecord(config.customAgents)
      ? config.customAgents
      : {};
    const resolved: Record<string, ResolvedCustomAgentConfig> = {};

    for (const [agentName, declaration] of Object.entries(customAgents)) {
      if (!this.isValidCustomAgentName(agentName)) {
        console.warn(
          `[hive:config] Skipping custom agent \"${agentName}\": invalid name (native permission wildcard characters \"*\" and \"?\" are not allowed)`,
        );
        continue;
      }

      if (this.isReservedCustomAgentName(agentName)) {
        console.warn(`[hive:config] Skipping custom agent \"${agentName}\": reserved name`);
        continue;
      }

      if (!this.isObjectRecord(declaration)) {
        console.warn(
          `[hive:config] Skipping custom agent \"${agentName}\": invalid declaration (expected object)`,
        );
        continue;
      }

      const baseAgent = declaration['baseAgent'];

      if (typeof baseAgent !== 'string' || !this.isSupportedCustomAgentBase(baseAgent)) {
        console.warn(
          `[hive:config] Skipping custom agent \"${agentName}\": unsupported baseAgent \"${String(baseAgent)}\"`,
        );
        continue;
      }

      const autoLoadSkillsValue = declaration['autoLoadSkills'];
      const additionalAutoLoadSkills = Array.isArray(autoLoadSkillsValue)
        ? autoLoadSkillsValue.filter((skill): skill is string => typeof skill === 'string')
        : [];
      const baseAgentConfig = this.getAgentConfig(baseAgent);
      const effectiveAutoLoadSkills = this.resolveAutoLoadSkills(
        baseAgentConfig.autoLoadSkills ?? [],
        additionalAutoLoadSkills,
        this.isPlannerAgent(baseAgent),
      );

      const descriptionValue = declaration['description'];
      const description = typeof descriptionValue === 'string'
        ? descriptionValue.trim()
        : '';
      if (!description) {
        console.warn(
          `[hive:config] Skipping custom agent "${agentName}": description must be a non-empty string`,
        );
        continue;
      }

      const modelValue = declaration['model'];
      const temperatureValue = declaration['temperature'];
      const variantValue = declaration['variant'];
      const model = typeof modelValue === 'string'
        ? modelValue.trim() || baseAgentConfig.model
        : baseAgentConfig.model;
      const variant = typeof variantValue === 'string'
        ? variantValue.trim() || baseAgentConfig.variant
        : baseAgentConfig.variant;

      resolved[agentName] = {
        baseAgent,
        description,
        model,
        temperature: typeof temperatureValue === 'number'
          ? temperatureValue
          : baseAgentConfig.temperature,
        variant,
        autoLoadSkills: effectiveAutoLoadSkills,
      };
    }

    this.cachedCustomAgentConfigs = resolved;
    return this.cachedCustomAgentConfigs;
  }

  hasConfiguredAgent(agent: string): boolean {
    if (this.isBuiltInAgent(agent)) {
      return true;
    }

    const customAgents = this.getCustomAgentConfigs();
    return customAgents[agent] !== undefined;
  }

  private isBuiltInAgent(agent: string): agent is BuiltInAgentName {
    return (BUILT_IN_AGENT_NAMES as readonly string[]).includes(agent);
  }

  private isReservedCustomAgentName(agent: string): boolean {
    return (CUSTOM_AGENT_RESERVED_NAMES as readonly string[]).includes(agent);
  }

  private isValidCustomAgentName(agent: string): boolean {
    return !/[?*]/.test(agent);
  }

  private isSupportedCustomAgentBase(baseAgent: string): baseAgent is CustomAgentBase {
    return (CUSTOM_AGENT_BASES as readonly string[]).includes(baseAgent);
  }

  private isPlannerAgent(agent: BuiltInAgentName | CustomAgentBase): boolean {
    return agent === 'hive-master' || agent === 'architect-planner';
  }

  private isObjectRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  private resolveAutoLoadSkills(
    baseAutoLoadSkills: string[],
    additionalAutoLoadSkills: string[],
    isPlannerAgent: boolean,
  ): string[] {
    const effectiveAdditionalSkills = isPlannerAgent
      ? additionalAutoLoadSkills
      : additionalAutoLoadSkills.filter((skill) => skill !== 'onboarding');
    const combinedAutoLoadSkills = [...baseAutoLoadSkills, ...effectiveAdditionalSkills];
    const uniqueAutoLoadSkills = Array.from(new Set(combinedAutoLoadSkills));
    return uniqueAutoLoadSkills;
  }

  /**
   * Get list of globally disabled skills.
   */
  getDisabledSkills(): string[] {
    const config = this.get();
    return config.disableSkills ?? [];
  }

  /**
   * Get hook execution cadence for a specific hook.
   * Returns the configured cadence or 1 (every turn) if not set.
   * Validates cadence values and defaults to 1 for invalid values.
   * 
   * @param hookName - The OpenCode hook name (e.g., 'experimental.chat.system.transform')
   * @returns Validated cadence value (always >= 1)
   */
  getHookCadence(hookName: string): number {
    const config = this.get();
    const configuredCadence = config.hook_cadence?.[hookName];

    // Validate and clamp cadence
    if (configuredCadence === undefined || configuredCadence === null) {
      return 1;
    }
    if (configuredCadence <= 0 || !Number.isInteger(configuredCadence)) {
      console.warn(
        `[hive:cadence] Invalid cadence ${configuredCadence} for ${hookName}, using 1`
      );
      return 1;
    }

    return configuredCadence;
  }

  private readStoredConfig(configPath: string):
    | { ok: true; value: Partial<HiveConfig> }
    | { ok: false; reason: 'parse_error' | 'validation_error' | 'read_error' } {
    try {
      const raw = fs.readFileSync(configPath, 'utf-8');
      const parsed = JSON.parse(raw) as unknown;
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { ok: false, reason: 'validation_error' };
      }
      const record = { ...(parsed as Record<string, unknown>) };
      // Removed setting: keep existing files readable while ignoring the dead key.
      if ('omoSlimEnabled' in record) {
        delete record.omoSlimEnabled;
        console.warn('[hive:config] Ignoring removed setting omoSlimEnabled');
      }
      if (!this.isValidStoredConfig(record)) {
        return { ok: false, reason: 'validation_error' };
      }
      return { ok: true, value: record as Partial<HiveConfig> };
    } catch (error) {
      if (error instanceof SyntaxError) {
        return { ok: false, reason: 'parse_error' };
      }
      return { ok: false, reason: 'read_error' };
    }
  }

  private readProjectAgentOverrides(): ProjectAgentOverrideRead {
    if (this.cachedProjectAgentOverrideRead !== null) {
      return this.cachedProjectAgentOverrideRead;
    }

    const overridePath = this.projectAgentOverridePath;
    if (!overridePath || !fs.existsSync(overridePath)) {
      this.cachedProjectAgentOverrideRead = { ok: true, value: null };
      return this.cachedProjectAgentOverrideRead;
    }

    try {
      const parsed = JSON.parse(fs.readFileSync(overridePath, 'utf-8')) as unknown;
      this.cachedProjectAgentOverrideRead = this.isValidProjectAgentOverrides(parsed)
        ? { ok: true, value: parsed }
        : { ok: false, reason: 'validation_error' };
    } catch (error) {
      this.cachedProjectAgentOverrideRead = {
        ok: false,
        reason: error instanceof SyntaxError ? 'parse_error' : 'read_error',
      };
    }

    return this.cachedProjectAgentOverrideRead;
  }

  private cacheEffectiveConfig(
    baseConfig: HiveConfig,
    baseSource: 'global' | 'defaults',
    globalFailureReason?: ConfigReadFailureReason,
  ): HiveConfig {
    const projectRead = this.readProjectAgentOverrides();
    const projectFailureReason = 'reason' in projectRead ? projectRead.reason : undefined;
    this.cachedConfig = projectRead.ok && projectRead.value
      ? this.applyProjectAgentOverrides(baseConfig, projectRead.value)
      : baseConfig;
    this.cachedCustomAgentConfigs = null;

    const messages: string[] = [];
    if (globalFailureReason) {
      const projectOverridesApply = projectRead.ok && projectRead.value !== null;
      messages.push(
        `Failed to read global config at ${this.configPath}; using defaults${projectOverridesApply ? ' with valid project agent overrides applied' : ''}`,
      );
    }
    if (projectFailureReason) {
      const fallback = baseSource === 'global'
        ? `global config at ${this.configPath}`
        : 'defaults';
      messages.push(
        `Failed to read project agent override at ${this.projectAgentOverridePath}; ignoring it and using ${fallback}`,
      );
    }

    if (messages.length === 0) {
      this.lastFallbackWarning = null;
    } else {
      const projectFailed = projectFailureReason !== undefined;
      this.lastFallbackWarning = {
        message: messages.join('. '),
        sourceType: projectFailed ? 'project' : 'global',
        sourcePath: projectFailed ? this.projectAgentOverridePath! : this.configPath,
        fallbackType: baseSource,
        ...(baseSource === 'global' ? { fallbackPath: this.configPath } : {}),
        reason: projectFailureReason ?? globalFailureReason!,
      };
    }

    return this.cachedConfig;
  }

  private applyProjectAgentOverrides(
    baseConfig: HiveConfig,
    overrides: ProjectAgentOverrides,
  ): HiveConfig {
    const agents = { ...(baseConfig.agents ?? {}) };
    for (const [agentName, override] of Object.entries(overrides.agents ?? {})) {
      if (
        !this.isBuiltInAgent(agentName)
        || !Object.prototype.hasOwnProperty.call(agents, agentName)
      ) {
        continue;
      }

      const agentConfig = { ...agents[agentName] };
      if (override.model !== undefined) agentConfig.model = override.model.trim();
      if (override.variant !== undefined) agentConfig.variant = override.variant.trim();
      agents[agentName] = agentConfig;
    }

    const customAgents = { ...(baseConfig.customAgents ?? {}) };
    for (const [agentName, override] of Object.entries(overrides.customAgents ?? {})) {
      if (!Object.prototype.hasOwnProperty.call(customAgents, agentName)) {
        continue;
      }

      const agentConfig = { ...customAgents[agentName] };
      if (override.model !== undefined) agentConfig.model = override.model.trim();
      if (override.variant !== undefined) agentConfig.variant = override.variant.trim();
      customAgents[agentName] = agentConfig;
    }

    return {
      ...baseConfig,
      agents,
      customAgents,
    };
  }

  private isValidProjectAgentOverrides(value: unknown): value is ProjectAgentOverrides {
    if (!this.isObjectRecord(value)) {
      return false;
    }

    if (Object.keys(value).some((key) => !['$schema', 'agents', 'customAgents'].includes(key))) {
      return false;
    }
    if (value.$schema !== undefined && typeof value.$schema !== 'string') {
      return false;
    }

    for (const mapName of ['agents', 'customAgents'] as const) {
      const overrides = value[mapName];
      if (overrides === undefined) {
        continue;
      }
      if (!this.isObjectRecord(overrides)) {
        return false;
      }

      for (const declaration of Object.values(overrides)) {
        if (!this.isObjectRecord(declaration)) {
          return false;
        }
        const fields = Object.keys(declaration);
        if (
          fields.length === 0
          || fields.some((field) => field !== 'model' && field !== 'variant')
        ) {
          return false;
        }
        if (
          'model' in declaration
          && (typeof declaration.model !== 'string' || declaration.model.trim() === '')
        ) {
          return false;
        }
        if (
          'variant' in declaration
          && (typeof declaration.variant !== 'string' || declaration.variant.trim() === '')
        ) {
          return false;
        }
      }
    }

    return true;
  }

  private mergeWithDefaults(stored: Partial<HiveConfig>): HiveConfig {
    const storedCustomAgents = this.isObjectRecord(stored.customAgents)
      ? stored.customAgents
      : {};

    const mergedBuiltInAgents = BUILT_IN_AGENT_NAMES.reduce<NonNullable<HiveConfig['agents']>>(
      (acc, agentName) => {
        const storedAgent = stored.agents?.[agentName];
        const mergedAgent: AgentModelConfig & { description?: string } = {
          ...DEFAULT_HIVE_CONFIG.agents?.[agentName],
          ...storedAgent,
        };
        if (
          this.isSupportedCustomAgentBase(agentName)
          && storedAgent
          && 'description' in storedAgent
          && storedAgent.description !== undefined
        ) {
          const description = storedAgent.description.trim();
          if (description) {
            mergedAgent.description = description;
          } else {
            delete mergedAgent.description;
          }
        }
        acc[agentName] = mergedAgent;
        return acc;
      },
      {},
    );

    return {
      ...DEFAULT_HIVE_CONFIG,
      ...stored,
      agents: {
        ...DEFAULT_HIVE_CONFIG.agents,
        ...stored.agents,
        ...mergedBuiltInAgents,
      },
      customAgents: storedCustomAgents,
      council: this.mergeCouncilConfig(DEFAULT_HIVE_CONFIG.council, stored.council),
      taskTraceSummarizer: {
        ...DEFAULT_HIVE_CONFIG.taskTraceSummarizer,
        ...stored.taskTraceSummarizer,
        ...(stored.taskTraceSummarizer?.model !== undefined ? { model: stored.taskTraceSummarizer.model.trim() } : {}),
        ...(stored.taskTraceSummarizer?.variant !== undefined ? { variant: stored.taskTraceSummarizer.variant.trim() } : {}),
      },
    };
  }

  private mergeCouncilConfig(defaults: CouncilConfig | undefined, stored: CouncilConfig | undefined): CouncilConfig | undefined {
    if (!defaults && !stored) {
      return undefined;
    }

    return {
      ...defaults,
      ...(stored?.defaultGroup !== undefined ? { defaultGroup: stored.defaultGroup } : {}),
      ...(stored?.maxMembers !== undefined ? { maxMembers: stored.maxMembers } : {}),
      ...(stored?.excludedAgents !== undefined ? { excludedAgents: stored.excludedAgents } : {}),
      groups: {
        ...defaults?.groups,
        ...stored?.groups,
      },
    };
  }

  private isValidStoredConfig(value: unknown): value is Partial<HiveConfig> {
    if (!this.isObjectRecord(value)) {
      return false;
    }

    const config = value as Record<string, unknown>;

    if (Object.keys(config).some((key) => !STORED_CONFIG_KEYS.has(key))) {
      return false;
    }

    if (config.$schema !== undefined && typeof config.$schema !== 'string') {
      return false;
    }

    if (config.enableToolsFor !== undefined && !this.isStringArray(config.enableToolsFor)) {
      return false;
    }

    if (config.disableSkills !== undefined && !this.isStringArray(config.disableSkills)) {
      return false;
    }

    if (
      config.agentMode !== undefined
      && config.agentMode !== 'unified'
      && config.agentMode !== 'dedicated'
    ) {
      return false;
    }

    if (config.agents !== undefined && !this.isObjectRecord(config.agents)) {
      return false;
    }

    if (this.isObjectRecord(config.agents)) {
      for (const [agentName, declaration] of Object.entries(config.agents)) {
        if (!this.isValidAgentConfigDeclaration(agentName, declaration)) {
          return false;
        }
      }
    }

    if (config.council !== undefined && !this.isValidCouncilConfig(config.council)) {
      return false;
    }

    if (config.taskTraceSummarizer !== undefined && !this.isValidTaskTraceSummarizerConfig(config.taskTraceSummarizer)) {
      return false;
    }

    if (config.hook_cadence !== undefined && !this.isHookCadenceRecord(config.hook_cadence)) {
      return false;
    }

    if (
      config.repositories !== undefined
      && !this.isValidRepositoryConfigArray(config.repositories)
    ) {
      return false;
    }
    if (config.repositoryRoot !== undefined && (typeof config.repositoryRoot !== 'string' || !path.isAbsolute(config.repositoryRoot))) {
      return false;
    }
    if ((config.repositories === undefined) !== (config.repositoryRoot === undefined)) {
      return false;
    }

    return true;
  }

  private isStringArray(value: unknown): value is string[] {
    return Array.isArray(value) && value.every((item) => typeof item === 'string');
  }

  private isValidTaskTraceSummarizerConfig(value: unknown): boolean {
    if (!this.isObjectRecord(value)) return false;
    const keys = Object.keys(value);
    if (keys.some((key) => !['model', 'variant', 'temperature'].includes(key))) return false;
    for (const key of ['model', 'variant'] as const) {
      const entry = value[key];
      if (entry !== undefined && (typeof entry !== 'string' || entry.trim().length === 0)) return false;
    }
    const temperature = value.temperature;
    return temperature === undefined
      || (typeof temperature === 'number' && Number.isFinite(temperature) && temperature >= 0 && temperature <= 2);
  }

  private isPositiveInteger(value: unknown): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value > 0;
  }

  private isValidCouncilConfig(value: unknown): boolean {
    if (!this.isObjectRecord(value)) {
      return false;
    }

    const council = value as Record<string, unknown>;

    if (council.defaultGroup !== undefined && typeof council.defaultGroup !== 'string') {
      return false;
    }

    if (council.maxMembers !== undefined && !this.isPositiveInteger(council.maxMembers)) {
      return false;
    }

    if (council.excludedAgents !== undefined && !this.isStringArray(council.excludedAgents)) {
      return false;
    }

    if (council.groups !== undefined && !this.isObjectRecord(council.groups)) {
      return false;
    }

    if (this.isObjectRecord(council.groups)) {
      for (const group of Object.values(council.groups)) {
        if (!this.isValidCouncilGroupConfig(group)) {
          return false;
        }
      }
    }

    return true;
  }

  private isValidCouncilGroupConfig(value: unknown): boolean {
    if (!this.isObjectRecord(value)) {
      return false;
    }

    const group = value as Record<string, unknown>;

    if (!this.isStringArray(group.members) || group.members.length === 0) {
      return false;
    }

    if (group.description !== undefined && typeof group.description !== 'string') {
      return false;
    }

    if (group.maxMembers !== undefined && !this.isPositiveInteger(group.maxMembers)) {
      return false;
    }

    return true;
  }

  private isValidAgentConfigDeclaration(agentName: string, value: unknown): boolean {
    if (!this.isObjectRecord(value)) {
      return false;
    }

    const declaration = value as Record<string, unknown>;

    if (
      declaration.description !== undefined
      && (
        !this.isSupportedCustomAgentBase(agentName)
        || typeof declaration.description !== 'string'
      )
    ) {
      return false;
    }

    if (declaration.model !== undefined && typeof declaration.model !== 'string') {
      return false;
    }

    if (declaration.temperature !== undefined && typeof declaration.temperature !== 'number') {
      return false;
    }

    if (declaration.skills !== undefined && !this.isStringArray(declaration.skills)) {
      return false;
    }

    if (declaration.autoLoadSkills !== undefined && !this.isStringArray(declaration.autoLoadSkills)) {
      return false;
    }

    if (declaration.variant !== undefined && typeof declaration.variant !== 'string') {
      return false;
    }

    return true;
  }

  private isValidRepositoryConfigArray(value: unknown): boolean {
    return Array.isArray(value) && value.length > 0 && value.every(isValidRepositoryConfig);
  }

  private isHookCadenceRecord(value: unknown): value is Record<string, number> {
    if (!this.isObjectRecord(value)) {
      return false;
    }

    return Object.values(value).every((entry) => this.isPositiveInteger(entry));
  }

}
