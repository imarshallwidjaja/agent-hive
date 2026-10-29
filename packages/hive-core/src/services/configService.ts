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
  RepositoryConfig,
  ResolvedCustomAgentConfig,
} from '../types.js';

/** The legacy global repository topology: migration-only input for the project manifest. */
export interface LegacyRepositoryTopology {
  repositoryRoot: string;
  repositories: RepositoryConfig[];
}

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

// A Hive model is `provider/model-id` as both hosts parse it: a provider before the first slash and a non-empty id
// after it. Whitespace and `#` are rejected because OpenCode v2 reads `#` as the start of a variant.
const MODEL_REFERENCE = /^[^\s/#]+\/[^\s#]+$/;
const VARIANT_NAME = /^[^\s#]+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Removes the retired `temperature` setting from agent, custom-agent and summarizer declarations, whatever its value,
 * so a legacy key never invalidates the rest of the configuration. Returns copies; the input is not modified.
 */
function withoutRemovedSampling(document: Record<string, unknown>): { value: Record<string, unknown>; removed: boolean } {
  let removed = false;
  const strip = (entry: unknown): unknown => {
    if (!isRecord(entry) || !Object.prototype.hasOwnProperty.call(entry, 'temperature')) return entry;
    removed = true;
    const { temperature: _removed, ...rest } = entry;
    return rest;
  };
  const value = { ...document };
  for (const key of ['agents', 'customAgents'] as const) {
    const declarations = value[key];
    if (isRecord(declarations)) {
      value[key] = Object.fromEntries(Object.entries(declarations).map(([name, entry]) => [name, strip(entry)]));
    }
  }
  if (Object.prototype.hasOwnProperty.call(value, 'taskTraceSummarizer')) value.taskTraceSummarizer = strip(value.taskTraceSummarizer);
  return { value, removed };
}

function removedSamplingWarning(source: string): string {
  return `[hive:config] Ignoring removed setting temperature in ${source}. Hive no longer sets sampling, so each model's `
    + 'native defaults apply. Delete temperature from agents, customAgents and taskTraceSummarizer.';
}

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
      return this.publishEffectiveConfig(this.buildEffectiveConfig({ ...DEFAULT_HIVE_CONFIG }), 'defaults');
    }

    const globalStored = this.readStoredConfig(this.configPath);
    if (globalStored.ok) {
      return this.publishEffectiveConfig(this.buildEffectiveConfig(this.mergeWithDefaults(globalStored.value)), 'global');
    }

    const fallbackReason = 'reason' in globalStored ? globalStored.reason : 'read_error';
    return this.publishEffectiveConfig(this.buildEffectiveConfig({ ...DEFAULT_HIVE_CONFIG }), 'defaults', fallbackReason);
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

  /**
   * Reads only the legacy `repositoryRoot`/`repositories` pair, so repository topology never depends on the validity of
   * unrelated settings. Returns null when the file or the pair is absent. Throws when the file is not a JSON object or
   * the pair breaks the rules a full read applies to it.
   */
  readLegacyRepositoryTopology(): LegacyRepositoryTopology | null {
    const document = this.readStoredDocument();
    return document === null ? null : this.parseLegacyRepositoryTopology(document);
  }

  /**
   * Removes the legacy topology pair when it still matches, under the config lock. Every other key keeps its stored
   * value, valid or not: this is a topology write, not a full config write, so it neither validates nor sanitizes them.
   */
  removeLegacyRepositoryManifestIfMatches(
    repositoryRoot: string,
    repositories: NonNullable<HiveConfig['repositories']>,
  ): 'removed' | 'skipped' {
    const release = acquireLockSync(this.configPath);
    try {
      const document = this.readStoredDocument();
      const topology = document === null ? null : this.parseLegacyRepositoryTopology(document);
      if (
        document === null
        || topology?.repositoryRoot !== repositoryRoot
        || JSON.stringify(topology.repositories) !== JSON.stringify(repositories)
      ) {
        this.cachedConfig = null;
        this.cachedCustomAgentConfigs = null;
        return 'skipped';
      }
      const { repositoryRoot: _repositoryRoot, repositories: _repositories, ...next } = document;
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
      const sanitized = withoutRemovedSampling(updates as Record<string, unknown>);
      if (sanitized.removed) console.warn(removedSamplingWarning('the requested update'));
      const incomingUpdates = sanitized.value as Partial<HiveConfig>;
      const mergedAgentUpdates = incomingUpdates.agents
        ? Object.fromEntries(
            Object.entries(incomingUpdates.agents).map(([agentName, incoming]) => {
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
        ...incomingUpdates,
        agents: mergedAgentUpdates ? {
          ...current.agents,
          ...mergedAgentUpdates,
        } : current.agents,
        customAgents: incomingUpdates.customAgents
          ? {
              ...current.customAgents,
              ...incomingUpdates.customAgents,
            }
          : current.customAgents,
      };

      if (!this.isValidStoredConfig(stored)) {
        throw new Error('Invalid global Agent Hive config');
      }
      if (stored.repositoryRoot !== undefined && !fs.existsSync(stored.repositoryRoot)) {
        throw new Error(`Repository root does not exist: ${stored.repositoryRoot}`);
      }

      const effective = this.validatePersistable(stored);
      writeAtomic(this.configPath, JSON.stringify(stored, null, 2));
      return this.publishEffectiveConfig(effective, 'global');
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
    if (this.isBuiltInAgent(agent)) {
      return this.resolveBuiltInAgentConfig(this.get(), agent);
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

    this.cachedCustomAgentConfigs = this.resolveCustomAgentConfigs(this.get(), (message) => console.warn(message));
    return this.cachedCustomAgentConfigs;
  }

  private resolveBuiltInAgentConfig(config: HiveConfig, agent: BuiltInAgentName): AgentModelConfig {
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

  /**
   * Resolves custom agents against one configuration snapshot: fieldwise inheritance from the base role's Hive
   * settings, with invalid declarations skipped and reported through `warn`. A supplied model or variant is used as
   * given (trimmed); only an omitted field inherits the base value.
   */
  private resolveCustomAgentConfigs(
    config: HiveConfig,
    warn: (message: string) => void,
  ): Record<string, ResolvedCustomAgentConfig> {
    const customAgents = this.isObjectRecord(config.customAgents)
      ? config.customAgents
      : {};
    const resolved: Record<string, ResolvedCustomAgentConfig> = {};

    for (const [agentName, declaration] of Object.entries(customAgents)) {
      if (!this.isValidCustomAgentName(agentName)) {
        warn(
          `[hive:config] Skipping custom agent \"${agentName}\": invalid name (native permission wildcard characters \"*\" and \"?\" are not allowed)`,
        );
        continue;
      }

      if (this.isReservedCustomAgentName(agentName)) {
        warn(`[hive:config] Skipping custom agent \"${agentName}\": reserved name (managed agent identity; custom replacement could change its tool permissions). Rename the custom agent.`);
        continue;
      }

      if (!this.isObjectRecord(declaration)) {
        warn(
          `[hive:config] Skipping custom agent \"${agentName}\": invalid declaration (expected object)`,
        );
        continue;
      }

      const baseAgent = declaration['baseAgent'];

      if (typeof baseAgent !== 'string' || !this.isSupportedCustomAgentBase(baseAgent)) {
        warn(
          `[hive:config] Skipping custom agent \"${agentName}\": unsupported baseAgent \"${String(baseAgent)}\"`,
        );
        continue;
      }

      const autoLoadSkillsValue = declaration['autoLoadSkills'];
      const additionalAutoLoadSkills = Array.isArray(autoLoadSkillsValue)
        ? autoLoadSkillsValue.filter((skill): skill is string => typeof skill === 'string')
        : [];
      const baseAgentConfig = this.resolveBuiltInAgentConfig(config, baseAgent);
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
        warn(
          `[hive:config] Skipping custom agent "${agentName}": description must be a non-empty string`,
        );
        continue;
      }

      const modelValue = declaration['model'];
      const variantValue = declaration['variant'];
      const model = typeof modelValue === 'string' ? modelValue.trim() : baseAgentConfig.model;
      const variant = typeof variantValue === 'string' ? variantValue.trim() : baseAgentConfig.variant;

      resolved[agentName] = {
        baseAgent,
        description,
        ...(model !== undefined ? { model } : {}),
        ...(variant !== undefined ? { variant } : {}),
        autoLoadSkills: effectiveAutoLoadSkills,
      };
    }

    return resolved;
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
      const sanitized = withoutRemovedSampling(parsed as Record<string, unknown>);
      const record = sanitized.value;
      if (sanitized.removed) console.warn(removedSamplingWarning(configPath));
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

  /**
   * Applies the project override to a base configuration and checks the effective model settings. Throws without
   * touching any cache, so a rejected candidate is never served and the next read checks the files again.
   */
  private buildEffectiveConfig(baseConfig: HiveConfig): HiveConfig {
    const projectRead = this.readProjectAgentOverrides();
    const projectApplies = projectRead.ok && projectRead.value !== null;
    const effective = projectApplies
      ? this.applyProjectAgentOverrides(baseConfig, projectRead.value!)
      : baseConfig;
    this.assertModelSelections(
      effective,
      projectApplies ? [this.configPath, this.projectAgentOverridePath!] : [this.configPath],
    );
    return effective;
  }

  private publishEffectiveConfig(
    effective: HiveConfig,
    baseSource: 'global' | 'defaults',
    globalFailureReason?: ConfigReadFailureReason,
  ): HiveConfig {
    const projectRead = this.readProjectAgentOverrides();
    const projectFailureReason = 'reason' in projectRead ? projectRead.reason : undefined;
    this.cachedConfig = effective;
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
        // A supplied blank string is structurally a string; effective validation rejects it for a matching role.
        if ('model' in declaration && typeof declaration.model !== 'string') {
          return false;
        }
        if ('variant' in declaration && typeof declaration.variant !== 'string') {
          return false;
        }
      }
    }

    return true;
  }

  /**
   * The effective model rule shared by both hosts: a supplied model must be an explicit `provider/model-id`, a supplied
   * variant a non-empty name, and a variant needs a Hive model on the same effective declaration. A custom agent's
   * model may come from its base role. Neither field means the host's native model applies. Problems are reported by
   * file and property path, never by value, and nothing is repaired: no default model, no dropped variant.
   */
  private assertModelSelections(config: HiveConfig, files: readonly string[]): void {
    const problems: string[] = [];
    const checkSupplied = (path: string, declaration: Record<string, unknown> | undefined) => {
      const model = declaration?.model;
      const variant = declaration?.variant;
      if (model !== undefined && (typeof model !== 'string' || !MODEL_REFERENCE.test(model.trim()))) {
        problems.push(`${path}.model must be an explicit provider/model-id without spaces or "#". Correct it, or remove model and variant to inherit the native model.`);
      }
      if (variant !== undefined && (typeof variant !== 'string' || !VARIANT_NAME.test(variant.trim()))) {
        problems.push(`${path}.variant must be a variant name without spaces or "#". Correct it, or remove it.`);
      }
    };
    const missingModel = (path: string, modelHint: string) => problems.push(
      `${path}.variant is set without a Hive model. Set ${modelHint} to an explicit provider/model-id, or remove the variant to inherit the native model.`,
    );

    for (const agentName of BUILT_IN_AGENT_NAMES) {
      const declaration = config.agents?.[agentName] as Record<string, unknown> | undefined;
      checkSupplied(`agents.${agentName}`, declaration);
      if (declaration?.variant !== undefined && declaration.model === undefined) missingModel(`agents.${agentName}`, `agents.${agentName}.model`);
    }

    const declarations = this.isObjectRecord(config.customAgents) ? config.customAgents : {};
    for (const [agentName, resolved] of Object.entries(this.resolveCustomAgentConfigs(config, () => {}))) {
      const declaration = declarations[agentName] as unknown as Record<string, unknown>;
      checkSupplied(`customAgents.${agentName}`, declaration);
      // A variant inherited from the base role is reported once, on the base.
      if (declaration.variant !== undefined && resolved.model === undefined) {
        missingModel(`customAgents.${agentName}`, `customAgents.${agentName}.model or agents.${resolved.baseAgent}.model`);
      }
    }

    const summarizer = config.taskTraceSummarizer as Record<string, unknown> | undefined;
    checkSupplied('taskTraceSummarizer', summarizer);
    if (summarizer?.variant !== undefined && summarizer.model === undefined) missingModel('taskTraceSummarizer', 'taskTraceSummarizer.model');

    if (problems.length > 0) {
      throw new Error(`[hive:config] Invalid Agent Hive model settings (${files.join(', ')}):\n- ${problems.join('\n- ')}`);
    }
  }

  /**
   * Checks a document before it is written, so every writer shares one rule: the file must be valid on its own (a
   * project override cannot supply the model a global variant needs) and its effective project view must stay valid.
   * Returns that effective view for cache publication.
   */
  private validatePersistable(stored: Partial<HiveConfig>): HiveConfig {
    const merged = this.mergeWithDefaults(stored);
    this.assertModelSelections(merged, [this.configPath]);
    return this.buildEffectiveConfig(merged);
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
        if (typeof mergedAgent.model === 'string') mergedAgent.model = mergedAgent.model.trim();
        if (typeof mergedAgent.variant === 'string') mergedAgent.variant = mergedAgent.variant.trim();
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
      ...(stored.taskTraceSummarizer !== undefined ? {
        taskTraceSummarizer: {
          ...stored.taskTraceSummarizer,
          ...(stored.taskTraceSummarizer.model !== undefined ? { model: stored.taskTraceSummarizer.model.trim() } : {}),
          ...(stored.taskTraceSummarizer.variant !== undefined ? { variant: stored.taskTraceSummarizer.variant.trim() } : {}),
        },
      } : {}),
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

    return this.legacyRepositoryTopologyProblem(config) === null;
  }

  /** The one rule for the legacy topology pair, shared by full reads and topology-only reads. */
  private legacyRepositoryTopologyProblem(config: Record<string, unknown>): string | null {
    if (config.repositories !== undefined && !this.isValidRepositoryConfigArray(config.repositories)) {
      return 'repositories must be a non-empty array of repository entries';
    }
    if (config.repositoryRoot !== undefined && (typeof config.repositoryRoot !== 'string' || !path.isAbsolute(config.repositoryRoot))) {
      return 'repositoryRoot must be an absolute path';
    }
    if ((config.repositories === undefined) !== (config.repositoryRoot === undefined)) {
      return 'repositoryRoot and repositories must be set together';
    }
    return null;
  }

  private parseLegacyRepositoryTopology(document: Record<string, unknown>): LegacyRepositoryTopology | null {
    const problem = this.legacyRepositoryTopologyProblem(document);
    if (problem !== null) {
      throw new Error(`Invalid global Agent Hive config: ${this.configPath}: ${problem}`);
    }
    return document.repositoryRoot === undefined
      ? null
      : { repositoryRoot: document.repositoryRoot as string, repositories: document.repositories as RepositoryConfig[] };
  }

  /** The stored global document as written, without validation or removed-setting cleanup; null when absent. */
  private readStoredDocument(): Record<string, unknown> | null {
    if (!fs.existsSync(this.configPath)) {
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(this.configPath, 'utf-8'));
    } catch (error) {
      const reason = error instanceof SyntaxError ? 'invalid JSON' : (error instanceof Error ? error.message : String(error));
      throw new Error(`Invalid global Agent Hive config: ${this.configPath}: ${reason}`);
    }
    if (!isRecord(parsed)) {
      throw new Error(`Invalid global Agent Hive config: ${this.configPath}: root must be a JSON object`);
    }
    return parsed;
  }

  private isStringArray(value: unknown): value is string[] {
    return Array.isArray(value) && value.every((item) => typeof item === 'string');
  }

  private isValidTaskTraceSummarizerConfig(value: unknown): boolean {
    if (!this.isObjectRecord(value)) return false;
    if (Object.keys(value).some((key) => key !== 'model' && key !== 'variant')) return false;
    return (['model', 'variant'] as const).every((key) => value[key] === undefined || typeof value[key] === 'string');
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
