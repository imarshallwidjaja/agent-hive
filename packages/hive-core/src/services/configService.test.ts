import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ConfigService } from "./configService";
import { CUSTOM_AGENT_BASES, DEFAULT_HIVE_CONFIG, DEFAULT_ROUTING_AGENT_DESCRIPTIONS, STARTER_CUSTOM_AGENTS } from "../types";

let originalHome: string | undefined;
let tempHome: string;

const makeTempHome = () => fs.mkdtempSync(path.join(os.tmpdir(), "hive-home-"));
const projectOverridePath = (projectRoot: string) => path.join(projectRoot, '.hive', 'agent-hive.override.json');
const writeProjectOverride = (projectRoot: string, value: unknown) => {
  const overridePath = projectOverridePath(projectRoot);
  fs.mkdirSync(path.dirname(overridePath), { recursive: true });
  fs.writeFileSync(overridePath, JSON.stringify(value));
  return overridePath;
};

beforeEach(() => {
  originalHome = process.env.HOME;
  tempHome = makeTempHome();
  process.env.HOME = tempHome;
});

afterEach(() => {
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  fs.rmSync(tempHome, { recursive: true, force: true });
});

describe("ConfigService defaults", () => {
  it("returns DEFAULT_HIVE_CONFIG when config is missing", () => {
    const service = new ConfigService();
    const config = service.get();

    expect(config).toEqual(DEFAULT_HIVE_CONFIG);
    expect(Object.keys(config.agents ?? {}).sort()).toEqual([
      "approach-advisor",
      "architect-planner",
      "code-reviewer",
      "forager-worker",
      "hive-builder",
      "hive-helper",
      "hive-master",
      "plan-reviewer",
      "scout-researcher",
      "simplicity-reviewer",
      "swarm-orchestrator",
      "vulnerability-reviewer",
    ]);
    for (const [agentName, agentConfig] of Object.entries(config.agents ?? {})) {
      expect(agentConfig, agentName).not.toHaveProperty('model');
      expect(agentConfig, agentName).not.toHaveProperty('variant');
      expect(agentConfig, agentName).not.toHaveProperty('temperature');
    }
    expect(config.agents?.['hive-helper']).toEqual({ autoLoadSkills: ['hive-config'] });
    expect(config.customAgents).toEqual({});
    expect(config.taskTraceSummarizer).toBeUndefined();
  });

  it('ignores removed omoSlimEnabled without invalidating the rest of the config', () => {
    const service = new ConfigService();
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    fs.mkdirSync(path.dirname(service.getPath()), { recursive: true });
    fs.writeFileSync(service.getPath(), JSON.stringify({
      agentMode: 'dedicated',
      omoSlimEnabled: true,
    }));

    expect(service.get().agentMode).toBe('dedicated');
    expect(service.get()).not.toHaveProperty('omoSlimEnabled');
    expect(warn.mock.calls.map((call) => call.join(' ')).some((line) => line.includes('omoSlimEnabled'))).toBe(true);
    warn.mockRestore();
  });

  it('ignores legacy temperature of any value without resetting or rewriting the rest of the config', () => {
    for (const legacy of [0.4, 7, -1, null, 'warm', { value: 1 }, [0.2]]) {
      const service = new ConfigService();
      const warn = spyOn(console, 'warn').mockImplementation(() => {});
      try {
        fs.mkdirSync(path.dirname(service.getPath()), { recursive: true });
        const bytes = JSON.stringify({
          agentMode: 'unified',
          council: { maxMembers: 2 },
          agents: {
            'forager-worker': { model: 'github-copilot/gpt-5.2-codex', variant: 'high', temperature: legacy, autoLoadSkills: ['extra'] },
            'scout-researcher': { temperature: legacy, description: 'Scout routing' },
          },
          customAgents: {
            'forager-ui': { baseAgent: 'forager-worker', description: 'UI work', temperature: legacy, autoLoadSkills: ['ui'] },
          },
          taskTraceSummarizer: { model: 'provider/summary', variant: 'low', temperature: legacy },
        });
        fs.writeFileSync(service.getPath(), bytes);

        const config = service.get();
        expect(service.getLastFallbackWarning()).toBeNull();
        expect(config.agentMode).toBe('unified');
        expect(config.council?.maxMembers).toBe(2);
        expect(config.agents?.['forager-worker']).toEqual({ model: 'github-copilot/gpt-5.2-codex', variant: 'high', autoLoadSkills: ['extra'] });
        expect(config.agents?.['scout-researcher']).toEqual({ autoLoadSkills: [], description: 'Scout routing' });
        expect(config.taskTraceSummarizer).toEqual({ model: 'provider/summary', variant: 'low' });
        expect(service.getCustomAgentConfigs()['forager-ui']).toEqual({
          baseAgent: 'forager-worker',
          description: 'UI work',
          model: 'github-copilot/gpt-5.2-codex',
          variant: 'high',
          autoLoadSkills: ['verification', 'extra', 'ui'],
        });
        const removalWarnings = warn.mock.calls.map((call) => call.join(' ')).filter((line) => line.includes('temperature'));
        expect(removalWarnings).toHaveLength(1);
        expect(removalWarnings[0]).toContain(service.getPath());
        // The temporary path is random and may contain the probed digits, so only the rest of the message is checked.
        expect(removalWarnings[0].replace(service.getPath(), '')).not.toContain(JSON.stringify(legacy));
        expect(fs.readFileSync(service.getPath(), 'utf-8')).toBe(bytes);
      } finally {
        warn.mockRestore();
      }
    }
  });

  it('loads a strict task trace summarizer override', () => {
    const service = new ConfigService();
    fs.mkdirSync(path.dirname(service.getPath()), { recursive: true });
    fs.writeFileSync(service.getPath(), JSON.stringify({
      taskTraceSummarizer: {
        model: 'provider/model',
        variant: 'high',
      },
    }));

    expect(service.get().taskTraceSummarizer).toEqual({
      model: 'provider/model',
      variant: 'high',
    });
  });

  it('trims task trace summarizer model and variant strings', () => {
    const service = new ConfigService();
    fs.mkdirSync(path.dirname(service.getPath()), { recursive: true });
    fs.writeFileSync(service.getPath(), JSON.stringify({
      taskTraceSummarizer: { model: ' provider/model ', variant: ' high ' },
    }));

    expect(service.get().taskTraceSummarizer).toEqual({
      model: 'provider/model',
      variant: 'high',
    });
  });

  it('falls back to defaults for structurally invalid task trace summarizer declarations', () => {
    for (const taskTraceSummarizer of [
      { model: 5 },
      { unknown: true },
    ]) {
      const service = new ConfigService();
      fs.mkdirSync(path.dirname(service.getPath()), { recursive: true });
      fs.writeFileSync(service.getPath(), JSON.stringify({ taskTraceSummarizer }));
      expect(service.get()).toEqual(DEFAULT_HIVE_CONFIG);
      expect(service.getLastFallbackWarning()?.reason).toBe('validation_error');
    }
  });

  it('includes default council groups with stock read-only members only', () => {
    const config = new ConfigService().get();

    expect(config.council).toEqual(DEFAULT_HIVE_CONFIG.council);
    expect(config.council?.defaultGroup).toBe('decision');
    expect(config.council?.maxMembers).toBe(4);
    expect(config.council?.excludedAgents).toEqual(['hive-master', 'swarm-orchestrator', 'forager-worker', 'hive-builder', 'hive-helper']);
    expect(config.council?.groups).toEqual({
      design: {
        description: 'Architecture and implementation-shape advice',
        members: ['scout-researcher', 'approach-advisor', 'plan-reviewer', 'code-reviewer'],
      },
      decision: {
        description: 'Hard tradeoff decision support',
        members: ['scout-researcher', 'approach-advisor', 'plan-reviewer'],
      },
      'minimal-change': {
        description: 'Smallest correct change and cleanup lens',
        members: ['scout-researcher', 'simplicity-reviewer', 'code-reviewer'],
      },
      documents: {
        description: 'Documentation and prose-oriented review',
        members: ['scout-researcher', 'code-reviewer', 'plan-reviewer'],
      },
    });
    expect(Object.values(config.council?.groups ?? {}).flatMap((group) => group.members)).not.toContain('forager-worker');
    expect(Object.values(config.council?.groups ?? {}).flatMap((group) => group.members)).not.toContain('hive-master');
  });

  it('merges partial global council config with defaults deterministically', () => {
    const service = new ConfigService();
    const configPath = service.getPath();

    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        council: {
          defaultGroup: 'documents',
          maxMembers: 2,
          excludedAgents: ['simplicity-reviewer'],
          groups: {
            custom: {
              description: 'Custom structural member references',
              members: ['unknown-specialist'],
              maxMembers: 1,
            },
          },
        },
      }),
    );

    const config = service.get();

    expect(config.council?.defaultGroup).toBe('documents');
    expect(config.council?.maxMembers).toBe(2);
    expect(config.council?.excludedAgents).toEqual(['simplicity-reviewer']);
    expect(Object.keys(config.council?.groups ?? {})).toEqual(['design', 'decision', 'minimal-change', 'documents', 'custom']);
    expect(config.council?.groups?.custom).toEqual({
      description: 'Custom structural member references',
      members: ['unknown-specialist'],
      maxMembers: 1,
    });
  });

  it('replaces only the declared council group while preserving omitted default groups', () => {
    const service = new ConfigService();
    const configPath = service.getPath();

    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        council: {
          groups: {
            decision: {
              members: ['code-reviewer'],
            },
          },
        },
      }),
    );

    const config = service.get();

    expect(config.council?.groups?.design).toEqual(DEFAULT_HIVE_CONFIG.council?.groups?.design);
    expect(config.council?.groups?.documents).toEqual(DEFAULT_HIVE_CONFIG.council?.groups?.documents);
    expect(config.council?.groups?.decision).toEqual({ members: ['code-reviewer'] });
  });

  it("loads customAgents from config", () => {
    const service = new ConfigService();
    const configPath = service.getPath();

    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify(
        {
          customAgents: {
            "forager-ui": {
              baseAgent: "forager-worker",
              description: "Use for UI-heavy implementation tasks.",
              model: "anthropic/claude-sonnet-4-20250514",
              variant: "high",
              autoLoadSkills: ["ui-focus"],
            },
          },
        },
        null,
        2,
      ),
    );

    const config = service.get();
    expect(config.customAgents?.["forager-ui"]).toEqual({
      baseAgent: "forager-worker",
      description: "Use for UI-heavy implementation tasks.",
      model: "anthropic/claude-sonnet-4-20250514",
      variant: "high",
      autoLoadSkills: ["ui-focus"],
    });
  });

  it('loads and trims routing descriptions for customizable built-in agents', () => {
    const service = new ConfigService();
    const configPath = service.getPath();

    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        agents: {
          'scout-researcher': {
            description: '  Default for repository-local research.  ',
          },
          'forager-worker': {
            model: 'provider/forager',
            variant: 'high',
          },
        },
      }),
    );

    const config = service.get();
    expect(config.agents?.['scout-researcher']?.description).toBe('Default for repository-local research.');
    expect(config.agents?.['forager-worker']?.description).toBeUndefined();
    expect(service.getRoutingAgentDescription('scout-researcher')).toBe('Default for repository-local research.');
    expect(service.getRoutingAgentDescription('forager-worker')).toBe(
      DEFAULT_ROUTING_AGENT_DESCRIPTIONS['forager-worker'],
    );
  });

  it('treats a blank configurable built-in routing description as omitted', () => {
    const service = new ConfigService();
    const configPath = service.getPath();

    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        agents: {
          'forager-worker': {
            description: '   ',
            model: 'provider/forager',
            variant: 'high',
          },
        },
      }),
    );

    expect(service.get().agents?.['forager-worker']).toMatchObject({ variant: 'high' });
    expect(service.get().agents?.['forager-worker']?.description).toBeUndefined();
    expect(service.getRoutingAgentDescription('forager-worker')).toBe(
      DEFAULT_ROUTING_AGENT_DESCRIPTIONS['forager-worker'],
    );
    expect(service.getLastFallbackWarning()).toBeNull();
  });

  it('falls back when a non-customizable built-in declares a routing description', () => {
    const service = new ConfigService();
    const configPath = service.getPath();

    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        agents: {
          'hive-builder': {
            description: 'Not configurable',
          },
        },
      }),
    );

    expect(service.get()).toEqual(DEFAULT_HIVE_CONFIG);
    expect(service.getLastFallbackWarning()?.reason).toBe('validation_error');
  });

  it("treats non-object customAgents as empty without dropping other config", () => {
    const service = new ConfigService();
    const configPath = service.getPath();

    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify(
        {
          agentMode: "dedicated",
          customAgents: null,
          agents: {
            "forager-worker": {
              model: "provider/forager",
              variant: "high",
            },
          },
        },
        null,
        2,
      ),
    );

    const config = service.get();
    expect(config.agentMode).toBe("dedicated");
    expect(config.customAgents).toEqual({});
    expect(config.agents?.["forager-worker"]?.variant).toBe("high");
  });

  it("returns 'dedicated' as default agentMode", () => {
    const service = new ConfigService();
    expect(service.get().agentMode).toBe('dedicated');
  });

  it("ignores both project config filenames", () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'project-local-config-test-'));
    try {
      const service = new ConfigService(projectDir);
      const newProjectConfigPath = path.join(projectDir, '.hive', 'agent-hive.json');
      const legacyProjectConfigPath = path.join(projectDir, '.opencode', 'agent_hive.json');

      fs.mkdirSync(path.dirname(newProjectConfigPath), { recursive: true });
      fs.writeFileSync(newProjectConfigPath, '{invalid json');

      fs.mkdirSync(path.dirname(legacyProjectConfigPath), { recursive: true });
      fs.writeFileSync(
        legacyProjectConfigPath,
        JSON.stringify({
          disableSkills: ['ignored-project-skill'],
        }),
      );

      const config = service.get();

      expect(config).toEqual(DEFAULT_HIVE_CONFIG);
      expect(service.getActiveReadSourceType()).toBe('global');
      expect(service.getLastFallbackWarning()).toBeNull();
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('init() writes global defaults with starter custom agents even when a project root is supplied', () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'project-init-config-test-'));
    try {
      const service = new ConfigService(projectDir);
      const projectConfigPath = path.join(projectDir, '.hive', 'agent-hive.json');

      fs.mkdirSync(path.dirname(projectConfigPath), { recursive: true });
      fs.writeFileSync(
        projectConfigPath,
        JSON.stringify({
          disableSkills: ['ignored-project-skill'],
        }),
      );

      const config = service.init();

      expect(config).toEqual({ ...DEFAULT_HIVE_CONFIG, customAgents: STARTER_CUSTOM_AGENTS });
      expect(service.getActiveReadSourceType()).toBe('global');
      expect(fs.existsSync(service.getPath())).toBe(true);
      const stored = JSON.parse(fs.readFileSync(service.getPath(), 'utf-8'));
      expect(stored.customAgents).toEqual(STARTER_CUSTOM_AGENTS);
      for (const declaration of [...Object.values(stored.agents), ...Object.values(stored.customAgents)]) {
        expect(declaration).not.toHaveProperty('model');
        expect(declaration).not.toHaveProperty('variant');
        expect(declaration).not.toHaveProperty('temperature');
      }
      expect(stored).not.toHaveProperty('taskTraceSummarizer');
      for (const baseAgent of CUSTOM_AGENT_BASES) {
        expect(stored.agents?.[baseAgent]).not.toHaveProperty('description');
        expect(service.getRoutingAgentDescription(baseAgent)).toBe(
          DEFAULT_ROUTING_AGENT_DESCRIPTIONS[baseAgent],
        );
      }
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("keeps stored explicit models, including values equal to former generated defaults", () => {
    const service = new ConfigService();
    const configPath = service.getPath();

    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify(
        {
          agents: {
            "hive-master": { model: "github-copilot/claude-opus-4.5" },
            "forager-worker": { model: " github-copilot/gpt-5.2-codex ", variant: " high " },
          },
        },
        null,
        2,
      ),
    );

    expect(service.getAgentConfig("hive-master")).toEqual({
      model: "github-copilot/claude-opus-4.5",
      autoLoadSkills: ["parallel-exploration"],
    });
    expect(service.getAgentConfig("forager-worker")).toEqual({
      model: "github-copilot/gpt-5.2-codex",
      variant: "high",
      autoLoadSkills: ["verification"],
    });
    expect(service.getAgentConfig("scout-researcher")).toEqual({ autoLoadSkills: [] });
  });

  it("merges autoLoadSkills defaults and overrides", () => {
    const service = new ConfigService();
    const configPath = service.getPath();

    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify(
        {
          agents: {
            "forager-worker": {
              autoLoadSkills: ["test-driven-development", "custom-skill", "verification"],
            },
          },
        },
        null,
        2,
      ),
    );

    const config = service.getAgentConfig("forager-worker");
    expect(config.autoLoadSkills).toEqual([
      "verification",
      "test-driven-development",
      "custom-skill",
    ]);
  });

  it('keeps hive-helper autoLoadSkills at the default whether the user adds or clears them', () => {
    for (const autoLoadSkills of [['test-driven-development'], []]) {
      const service = new ConfigService();
      const configPath = service.getPath();

      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(
        configPath,
        JSON.stringify({ agents: { 'hive-helper': { autoLoadSkills } } }, null, 2),
      );

      expect(service.getAgentConfig('hive-helper').autoLoadSkills).toEqual(['hive-config']);
    }
  });

  it("keeps disabled names in autoLoadSkills so native skills can still shadow Hive bundles", () => {
    const service = new ConfigService();
    const configPath = service.getPath();

    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify(
        {
          disableSkills: ["parallel-exploration", "custom-skill"],
          agents: {
            "hive-master": {
              autoLoadSkills: ["custom-skill"],
            },
          },
        },
        null,
        2,
      ),
    );

    const config = service.getAgentConfig("hive-master");
    expect(config.autoLoadSkills).toEqual(["parallel-exploration", "custom-skill"]);
  });

  it("getAgentConfig('hive-builder') returns only its default skills, leaving the model to the host", () => {
    const config = new ConfigService().getAgentConfig("hive-builder");

    expect(config).toEqual({ autoLoadSkills: ["verification", "parallel-exploration"] });
  });

  it("hive-builder merges safe default autoLoadSkills with user overrides", () => {
    const service = new ConfigService();
    const configPath = service.getPath();

    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify(
        {
          agents: {
            "hive-builder": {
              autoLoadSkills: ["custom-skill"],
            },
          },
        },
        null,
        2,
      ),
    );

    const config = service.getAgentConfig("hive-builder");
    // Non-planner agents get their defaults merged with user overrides
    expect(config.autoLoadSkills).toEqual(["verification", "parallel-exploration", "custom-skill"]);
  });

  it("preserves named reviewer overlays and warns why managed custom-agent identities are skipped", () => {
    const service = new ConfigService();
    const configPath = service.getPath();
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    const reservedNames = ["hive-builder", "builder", "general", "explore", "dash-reviewer", "vulnerability-review-primary"];

    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify(
        {
          customAgents: {
            "reviewer-dashboard": {
              baseAgent: "code-reviewer",
              description: "Existing custom reviewer.",
              model: "provider/custom-reviewer",
              variant: "high",
            },
            ...Object.fromEntries(reservedNames.map((name) => [name, {
              baseAgent: "forager-worker",
              description: "Should be skipped as reserved.",
            }])),
          },
        },
        null,
        2,
      ),
    );

    const custom = service.getCustomAgentConfigs();
    expect(custom).toHaveProperty("reviewer-dashboard");
    expect(service.getAgentConfig("reviewer-dashboard")).toMatchObject({
      model: "provider/custom-reviewer",
      variant: "high",
    });
    const warnedLines = warnSpy.mock.calls.map((call) => call.join(" "));
    expect(
      warnedLines.some(
        (line) => line.includes("reserved") && line.includes('"reviewer-dashboard"'),
      ),
    ).toBe(false);
    for (const name of reservedNames) {
      expect(custom).not.toHaveProperty(name);
      expect(warnedLines).toContain(
        `[hive:config] Skipping custom agent "${name}": reserved name (managed agent identity; custom replacement could change its tool permissions). Rename the custom agent.`,
      );
    }
    expect(warnedLines).toHaveLength(reservedNames.length);

    warnSpy.mockRestore();
  });

  it("scout-researcher autoLoadSkills does NOT include parallel-exploration", () => {
    // Scout should not auto-load parallel-exploration to prevent recursive delegation.
    // Scouts are leaf agents that should not spawn further scouts.
    const service = new ConfigService();
    const scoutConfig = service.getAgentConfig("scout-researcher");

    expect(scoutConfig.autoLoadSkills).not.toContain("parallel-exploration");
  });

  it("normalizes custom agents with base inheritance and overrides", () => {
    const service = new ConfigService();
    const configPath = service.getPath();

    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify(
        {
          agents: {
            "scout-researcher": {
              model: "provider/scout",
              variant: "medium",
              autoLoadSkills: ["onboarding", "research-focus"],
            },
            "forager-worker": {
              model: "provider/forager",
              variant: "high",
              autoLoadSkills: ["verification", "onboarding", "ui-focus"],
            },
          },
          customAgents: {
            "scout-docs": {
              baseAgent: "scout-researcher",
              description: "Scout focused on documentation research.",
              autoLoadSkills: ["research-focus"],
            },
            "forager-lite": {
              baseAgent: "forager-worker",
              description: "General forager with inherited defaults.",
              variant: "low",
            },
            "forager-ui": {
              baseAgent: "forager-worker",
              description: "Forager focused on frontend tasks.",
              autoLoadSkills: ["ui-focus"],
            },
            "reviewer-security": {
              baseAgent: "code-reviewer",
              description: "Security-focused reviewer.",
              model: "anthropic/claude-sonnet-4-20250514",
            },
            "reviewer-native": {
              baseAgent: "code-reviewer",
              description: "Reviewer on the native model.",
            },
          },
        },
        null,
        2,
      ),
    );

    const custom = service.getCustomAgentConfigs();

    expect(custom["scout-docs"]).toMatchObject({
      baseAgent: "scout-researcher",
      model: "provider/scout",
      variant: "medium",
    });
    expect(custom["scout-docs"]?.autoLoadSkills).toEqual([
      "research-focus",
    ]);
    expect(custom["forager-lite"]).toMatchObject({
      baseAgent: "forager-worker",
      model: "provider/forager",
      variant: "low",
    });
    expect(custom["forager-ui"]?.variant).toBe("high");
    expect(custom["forager-ui"]?.autoLoadSkills).toEqual([
      "verification",
      "ui-focus",
    ]);
    expect(custom["reviewer-security"]?.model).toBe("anthropic/claude-sonnet-4-20250514");
    expect(custom["reviewer-security"]).not.toHaveProperty("variant");
    expect(custom["reviewer-native"]).toEqual({
      baseAgent: "code-reviewer",
      description: "Reviewer on the native model.",
      autoLoadSkills: [],
    });
  });

  it("skips reserved/invalid custom agent names for runtime lookups", () => {
    const service = new ConfigService();
    const configPath = service.getPath();
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify(
        {
          customAgents: {
            "forager-worker": {
              baseAgent: "forager-worker",
              description: "Reserved built-in ID.",
            },
            build: {
              baseAgent: "forager-worker",
              description: "Reserved plugin alias.",
            },
            "unsupported-base": {
              baseAgent: "hive-master",
              description: "Should be skipped at runtime.",
            },
            "architect-*": {
              baseAgent: "scout-researcher",
              description: "Wildcard custom Scout.",
            },
            "forager-*": {
              baseAgent: "approach-advisor",
              description: "Wildcard custom advisor.",
            },
            "hive-*": {
              baseAgent: "plan-reviewer",
              description: "Wildcard custom plan reviewer.",
            },
            "*": {
              baseAgent: "scout-researcher",
              description: "Catch-all custom Scout.",
            },
            "?": {
              baseAgent: "approach-advisor",
              description: "Single-character custom advisor.",
            },
            "scout-docs": {
              baseAgent: "scout-researcher",
              description: "Valid named custom Scout.",
            },
            "plan-risk-reviewer": {
              baseAgent: "plan-reviewer",
              description: "Valid named custom plan reviewer.",
            },
            "approach-specialist": {
              baseAgent: "approach-advisor",
              description: "Valid named custom advisor.",
            },
            "forager-ui": {
              baseAgent: "forager-worker",
              description: "Valid custom agent.",
            },
          },
        },
        null,
        2,
      ),
    );

    const custom = service.getCustomAgentConfigs();
    expect(custom).not.toHaveProperty("forager-worker");
    expect(custom).not.toHaveProperty("build");
    expect(custom).not.toHaveProperty("unsupported-base");
    for (const name of ["architect-*", "forager-*", "hive-*", "*", "?"]) {
      expect(custom).not.toHaveProperty(name);
    }
    expect(custom).toHaveProperty("scout-docs");
    expect(custom).toHaveProperty("plan-risk-reviewer");
    expect(custom).toHaveProperty("approach-specialist");
    expect(custom).toHaveProperty("forager-ui");
    expect(service.getLastFallbackWarning()).toBeNull();

    const warnedLines = warnSpy.mock.calls.map((call) => call.join(" "));
    const expectWarnedAboutReservedName = (name: string) => {
      expect(
        warnedLines.some(
          (line) => line.includes("reserved") && line.includes(`\"${name}\"`),
        ),
      ).toBe(true);
    };

    expectWarnedAboutReservedName("build");
    for (const name of ["architect-*", "forager-*", "hive-*", "*", "?"]) {
      expect(
        warnedLines.some(
          (line) => line.includes("invalid name") && line.includes(`\"${name}\"`),
        ),
      ).toBe(true);
    }
    expect(service.hasConfiguredAgent("forager-worker")).toBe(true);
    expect(service.hasConfiguredAgent("forager-ui")).toBe(true);
    expect(service.hasConfiguredAgent("build")).toBe(false);
    expect(service.hasConfiguredAgent("unsupported-base")).toBe(false);
    expect(service.hasConfiguredAgent("missing-agent")).toBe(false);

    warnSpy.mockRestore();
  });

  it("skips non-object custom agent declarations and keeps valid ones", () => {
    const service = new ConfigService();
    const configPath = service.getPath();
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify(
        {
          customAgents: {
            "forager-ui": {
              baseAgent: "forager-worker",
              description: "Valid custom agent.",
            },
            "broken-null": null,
            "broken-string": "bad",
          },
        },
        null,
        2,
      ),
    );

    const custom = service.getCustomAgentConfigs();
    expect(custom).toHaveProperty("forager-ui");
    expect(custom).not.toHaveProperty("broken-null");
    expect(custom).not.toHaveProperty("broken-string");

    const warnedLines = warnSpy.mock.calls.map((call) => call.join(" "));
    expect(
      warnedLines.some(
        (line) => line.includes("invalid declaration") && line.includes("\"broken-null\""),
      ),
    ).toBe(true);
    expect(
      warnedLines.some(
        (line) => line.includes("invalid declaration") && line.includes("\"broken-string\""),
      ),
    ).toBe(true);

    warnSpy.mockRestore();
  });

  it("skips custom agents with missing or whitespace description", () => {
    const service = new ConfigService();
    const configPath = service.getPath();
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify(
        {
          customAgents: {
            "missing-description": {
              baseAgent: "forager-worker",
            },
            "blank-description": {
              baseAgent: "forager-worker",
              description: "   ",
            },
            "forager-ui": {
              baseAgent: "forager-worker",
              description: "Use for UI-heavy implementation tasks.",
            },
          },
        },
        null,
        2,
      ),
    );

    const custom = service.getCustomAgentConfigs();
    expect(custom).toHaveProperty("forager-ui");
    expect(custom).not.toHaveProperty("missing-description");
    expect(custom).not.toHaveProperty("blank-description");

    const warnedLines = warnSpy.mock.calls.map((call) => call.join(" "));
    expect(
      warnedLines.some(
        (line) => line.includes("description must be a non-empty string") && line.includes("\"missing-description\""),
      ),
    ).toBe(true);
    expect(
      warnedLines.some(
        (line) => line.includes("description must be a non-empty string") && line.includes("\"blank-description\""),
      ),
    ).toBe(true);

    warnSpy.mockRestore();
  });

  it("caches custom agent resolution and emits warnings once per cache cycle", () => {
    const service = new ConfigService();
    const configPath = service.getPath();
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify(
        {
          customAgents: {
            build: {
              baseAgent: "forager-worker",
              description: "Reserved plugin alias.",
            },
            "forager-ui": {
              baseAgent: "forager-worker",
              description: "Valid custom agent.",
            },
          },
        },
        null,
        2,
      ),
    );

    service.getCustomAgentConfigs();
    service.hasConfiguredAgent("forager-ui");
    service.hasConfiguredAgent("missing-agent");
    service.getCustomAgentConfigs();

    const reservedWarnings = warnSpy.mock.calls.filter((call) =>
      call.join(" ").includes("Skipping custom agent \"build\": reserved name"),
    );
    expect(reservedWarnings.length).toBe(1);

    warnSpy.mockRestore();
  });
});

describe("ConfigService disabled skills", () => {
  it("returns empty arrays when not configured", () => {
    const service = new ConfigService();
    expect(service.getDisabledSkills()).toEqual([]);
  });

  it("returns configured disabled skills", () => {
    const service = new ConfigService();
    const configPath = service.getPath();

    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        disableSkills: ["brainstorming", "writing-plans"],
      }),
    );

    expect(service.getDisabledSkills()).toEqual(["brainstorming", "writing-plans"]);
  });
});

describe('ConfigService hook cadence', () => {
  it('defaults to cadence 1 when hook_cadence is not configured', () => {
    expect(new ConfigService().getHookCadence('chat.message')).toBe(1);
  });

  it('returns a configured cadence', () => {
    const service = new ConfigService();
    fs.mkdirSync(path.dirname(service.getPath()), { recursive: true });
    fs.writeFileSync(service.getPath(), JSON.stringify({ hook_cadence: { 'chat.message': 5 } }));

    expect(service.getHookCadence('chat.message')).toBe(5);
    expect(service.getLastFallbackWarning()).toBeNull();
  });

  it('defaults missing hooks to cadence 1 when other hooks are configured', () => {
    const service = new ConfigService();
    fs.mkdirSync(path.dirname(service.getPath()), { recursive: true });
    fs.writeFileSync(service.getPath(), JSON.stringify({ hook_cadence: { 'chat.message': 3 } }));

    expect(service.getHookCadence('experimental.chat.messages.transform')).toBe(1);
  });
});

describe('ConfigService global-only read source selection', () => {
  it('ignores both project config filenames and reads all runtime policy from global config', () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-project-'));
    const projectConfigPath = path.join(projectRoot, '.hive', 'agent-hive.json');
    const legacyProjectConfigPath = path.join(projectRoot, '.opencode', 'agent_hive.json');
    const globalConfigPath = path.join(tempHome, '.config', 'opencode', 'agent_hive.json');

    fs.mkdirSync(path.dirname(projectConfigPath), { recursive: true });
    fs.writeFileSync(
      projectConfigPath,
      JSON.stringify({
        agentMode: 'dedicated',
        customAgents: {
          'project-agent': { baseAgent: 'forager-worker', description: 'Project agent' },
        },
      }),
    );
    fs.mkdirSync(path.dirname(legacyProjectConfigPath), { recursive: true });
    fs.writeFileSync(legacyProjectConfigPath, '{malformed project config');

    fs.mkdirSync(path.dirname(globalConfigPath), { recursive: true });
    fs.writeFileSync(
      globalConfigPath,
      JSON.stringify({
        agentMode: 'unified',
        agents: {
          'forager-worker': { autoLoadSkills: ['global-skill'] },
        },
        customAgents: {
          'global-agent': { baseAgent: 'forager-worker', description: 'Global agent' },
        },
      }),
    );

    const service = new ConfigService(projectRoot);
    const config = service.get();

    expect(config.agentMode).toBe('unified');
    expect(service.getAgentConfig('forager-worker').autoLoadSkills).toContain('global-skill');
    expect(service.getCustomAgentConfigs()).toHaveProperty('global-agent');
    expect(service.getCustomAgentConfigs()).not.toHaveProperty('project-agent');
    expect(service.getActiveReadSourceType()).toBe('global');
    expect(service.getActiveReadPath()).toBe(globalConfigPath);
    expect(service.getLastFallbackWarning()).toBeNull();

    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it('reads global config when project config is missing', () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-project-'));
    const globalConfigPath = path.join(tempHome, '.config', 'opencode', 'agent_hive.json');

    fs.mkdirSync(path.dirname(globalConfigPath), { recursive: true });
    fs.writeFileSync(
      globalConfigPath,
      JSON.stringify({
        agentMode: 'unified',
      }),
    );

    const service = new ConfigService(projectRoot);
    const config = service.get();

    expect(config.agentMode).toBe('unified');
    expect(service.getActiveReadSourceType()).toBe('global');
    expect(service.getActiveReadPath()).toBe(globalConfigPath);
    expect(service.getLastFallbackWarning()).toBeNull();

    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it('falls back to defaults and records a global warning when global config is invalid', () => {
    const globalConfigPath = path.join(tempHome, '.config', 'opencode', 'agent_hive.json');

    fs.mkdirSync(path.dirname(globalConfigPath), { recursive: true });
    fs.writeFileSync(
      globalConfigPath,
      JSON.stringify({
        agentMode: 'bogus',
      }),
    );

    const service = new ConfigService();
    const config = service.get();

    expect(config).toEqual(DEFAULT_HIVE_CONFIG);
    expect(service.getActiveReadSourceType()).toBe('global');
    expect(service.getActiveReadPath()).toBe(globalConfigPath);
    expect(service.getLastFallbackWarning()).toEqual({
      message: `Failed to read global config at ${globalConfigPath}; using defaults`,
      sourceType: 'global',
      sourcePath: globalConfigPath,
      fallbackType: 'defaults',
      reason: 'validation_error',
    });
  });

  it.each([
    { name: 'a non-object council value', council: [] },
    { name: 'a non-string defaultGroup', council: { defaultGroup: 123 } },
    { name: 'a non-positive maxMembers', council: { maxMembers: 0 } },
    { name: 'a non-integer maxMembers', council: { maxMembers: 1.5 } },
    { name: 'non-string excludedAgents', council: { excludedAgents: ['code-reviewer', 123] } },
    { name: 'a non-object groups value', council: { groups: [] } },
    { name: 'a group without members', council: { groups: { review: { description: 'missing members' } } } },
    { name: 'a group with empty members', council: { groups: { review: { members: [] } } } },
    { name: 'a group with non-string members', council: { groups: { review: { members: ['code-reviewer', 123] } } } },
    { name: 'a group with non-string description', council: { groups: { review: { description: 123, members: ['code-reviewer'] } } } },
    { name: 'a group with invalid maxMembers', council: { groups: { review: { members: ['code-reviewer'], maxMembers: 0 } } } },
  ])('falls back to defaults when global config has $name', ({ council }) => {
    const globalConfigPath = path.join(tempHome, '.config', 'opencode', 'agent_hive.json');

    fs.mkdirSync(path.dirname(globalConfigPath), { recursive: true });
    fs.writeFileSync(globalConfigPath, JSON.stringify({ council }));

    const service = new ConfigService();

    expect(service.get()).toEqual(DEFAULT_HIVE_CONFIG);
    expect(service.getLastFallbackWarning()?.reason).toBe('validation_error');
  });

  it('structurally accepts unknown council member names in global config', () => {
    const service = new ConfigService();
    const configPath = service.getPath();

    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        council: {
          groups: {
            specialists: {
              members: ['not-registered-yet'],
            },
          },
        },
      }),
    );

    expect(service.get().council?.groups?.specialists).toEqual({
      members: ['not-registered-yet'],
    });
    expect(service.getLastFallbackWarning()).toBeNull();
  });

  it('reports only the global failure when project and global configs are invalid', () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-project-'));
    const projectConfigPath = path.join(projectRoot, '.hive', 'agent-hive.json');
    const globalConfigPath = path.join(tempHome, '.config', 'opencode', 'agent_hive.json');

    fs.mkdirSync(path.dirname(projectConfigPath), { recursive: true });
    fs.writeFileSync(
      projectConfigPath,
      JSON.stringify({
        agents: {
          'forager-worker': {
            autoLoadSkills: 'bad-skill-shape',
          },
        },
      }),
    );

    fs.mkdirSync(path.dirname(globalConfigPath), { recursive: true });
    fs.writeFileSync(
      globalConfigPath,
      JSON.stringify({
        agentMode: 'bogus',
      }),
    );

    const service = new ConfigService(projectRoot);
    const config = service.get();

    expect(config).toEqual(DEFAULT_HIVE_CONFIG);
    expect(service.getActiveReadSourceType()).toBe('global');
    expect(service.getActiveReadPath()).toBe(globalConfigPath);
    expect(service.getLastFallbackWarning()).toEqual({
      message: `Failed to read global config at ${globalConfigPath}; using defaults`,
      sourceType: 'global',
      sourcePath: globalConfigPath,
      fallbackType: 'defaults',
      reason: 'validation_error',
    });

    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it('uses defaults without warning when project config is invalid and global config is missing', () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-project-'));
    const projectConfigPath = path.join(projectRoot, '.hive', 'agent-hive.json');
    const globalConfigPath = path.join(tempHome, '.config', 'opencode', 'agent_hive.json');

    fs.mkdirSync(path.dirname(projectConfigPath), { recursive: true });
    fs.writeFileSync(
      projectConfigPath,
      JSON.stringify({
        agents: {
          'forager-worker': {
            autoLoadSkills: 'bad-skill-shape',
          },
        },
      }),
    );

    const service = new ConfigService(projectRoot);
    const config = service.get();

    expect(config).toEqual(DEFAULT_HIVE_CONFIG);
    expect(service.getActiveReadSourceType()).toBe('global');
    expect(service.getActiveReadPath()).toBe(globalConfigPath);
    expect(service.getLastFallbackWarning()).toBeNull();

    fs.rmSync(projectRoot, { recursive: true, force: true });
  });
});

describe('ConfigService repository manifest validation', () => {
  it('accepts repositories as an array of repository ID and path entries', () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-project-repositories-'));
    try {
      const globalConfigPath = path.join(tempHome, '.config', 'opencode', 'agent_hive.json');
      fs.mkdirSync(path.dirname(globalConfigPath), { recursive: true });
      fs.writeFileSync(
        globalConfigPath,
        JSON.stringify({
          repositoryRoot: projectRoot,
          repositories: [
            { id: 'api', path: 'api' },
            { id: 'web-ui', path: './web-ui' },
            { id: 'data.v2', path: './data-v2' },
            { id: 'api_v2', path: './api-v2' },
          ],
        }),
      );

      const config = new ConfigService(projectRoot).get();

      expect(config.repositories).toEqual([
        { id: 'api', path: 'api' },
        { id: 'web-ui', path: './web-ui' },
        { id: 'data.v2', path: './data-v2' },
        { id: 'api_v2', path: './api-v2' },
      ]);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it.each([
    { name: 'an empty array', repositories: [] },
    { name: 'a non-array value', repositories: { id: 'api', path: 'api' } },
    { name: 'an invalid repository ID', repositories: [{ id: 'Api', path: 'api' }] },
    { name: 'a double-dot repository ID', repositories: [{ id: 'api..v2', path: 'api' }] },
    { name: 'a non-string repository path', repositories: [{ id: 'api', path: 123 }] },
    { name: 'an empty repository path', repositories: [{ id: 'api', path: '' }] },
    { name: 'a repository path outside repositoryRoot', repositories: [{ id: 'api', path: '../outside' }] },
    { name: 'a repository entry with extra fields', repositories: [{ id: 'api', path: 'api', branch: 'main' }] },
  ])('falls back when repositories contains $name', ({ repositories }) => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-project-repositories-'));
    try {
      const globalConfigPath = path.join(tempHome, '.config', 'opencode', 'agent_hive.json');
      fs.mkdirSync(path.dirname(globalConfigPath), { recursive: true });
      fs.writeFileSync(globalConfigPath, JSON.stringify({ repositoryRoot: projectRoot, repositories }));

      const service = new ConfigService(projectRoot);

      expect(service.get()).toEqual(DEFAULT_HIVE_CONFIG);
      expect(service.getLastFallbackWarning()?.reason).toBe('validation_error');
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('rejects raw parent repository path segments on read and set without changing stored state', () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-project-repositories-'));
    try {
      const service = new ConfigService(projectRoot);
      const configPath = service.getPath();
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, JSON.stringify({
        repositoryRoot: projectRoot,
        repositories: [{ id: 'api', path: 'packages/../api' }],
      }));

      expect(service.get()).toEqual(DEFAULT_HIVE_CONFIG);
      expect(service.getLastFallbackWarning()?.reason).toBe('validation_error');

      const original = `${JSON.stringify({
        agentMode: 'unified',
        repositoryRoot: projectRoot,
        repositories: [{ id: 'api', path: './api' }],
      }, null, 2)}\n`;
      fs.writeFileSync(configPath, original);
      const writeService = new ConfigService(projectRoot);
      const cached = writeService.get();

      expect(() => writeService.set({
        repositories: [{ id: 'api', path: 'packages/../api' }],
      })).toThrow('Invalid global Agent Hive config');
      expect(fs.readFileSync(configPath, 'utf-8')).toBe(original);
      expect(writeService.get()).toBe(cached);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

describe('ConfigService write validation and persistence', () => {
  it.each([
    ['undefined', undefined],
    ['whitespace', '   '],
  ] as const)('preserves an existing agent declaration when %s clears its routing description', (_label, description) => {
    const service = new ConfigService();
    const configPath = service.getPath();
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({
      agents: {
        'forager-worker': {
          model: 'user/forager-model',
          variant: 'high',
          autoLoadSkills: ['custom-skill'],
          description: 'Use for backend implementation.',
        },
      },
    }));

    const updated = service.set({
      agents: {
        'forager-worker': {
          description,
        },
      },
    });

    const expectedAgent = {
      model: 'user/forager-model',
      variant: 'high',
      autoLoadSkills: ['custom-skill'],
    };
    expect(updated.agents?.['forager-worker']).toMatchObject(expectedAgent);
    expect(updated.agents?.['forager-worker']?.description).toBeUndefined();
    expect(service.getRoutingAgentDescription('forager-worker')).toBe(
      DEFAULT_ROUTING_AGENT_DESCRIPTIONS['forager-worker'],
    );
    const stored = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(stored.agents['forager-worker']).toEqual(expectedAgent);

    const reloaded = new ConfigService();
    expect(reloaded.get().agents?.['forager-worker']).toMatchObject(expectedAgent);
    expect(reloaded.get().agents?.['forager-worker']?.description).toBeUndefined();
    expect(reloaded.getRoutingAgentDescription('forager-worker')).toBe(
      DEFAULT_ROUTING_AGENT_DESCRIPTIONS['forager-worker'],
    );
  });

  it('persists only stored values and requested updates without restoring omitted defaults', () => {
    const service = new ConfigService();
    const configPath = service.getPath();
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({
      agents: {
        'hive-master': { model: 'user/hive-model' },
      },
      customAgents: {
        'forager-ui': {
          baseAgent: 'forager-worker',
          description: 'User-defined UI implementer',
        },
      },
    }));

    const updated = service.set({
      agentMode: 'unified',
      agents: {
        'forager-worker': { model: 'user/forager-model', variant: 'high' },
      },
      customAgents: {
        'reviewer-local': {
          baseAgent: 'code-reviewer',
          description: 'User-defined local reviewer',
        },
      },
    });

    const expectedStored = {
      agentMode: 'unified',
      agents: {
        'hive-master': { model: 'user/hive-model' },
        'forager-worker': { model: 'user/forager-model', variant: 'high' },
      },
      customAgents: {
        'forager-ui': {
          baseAgent: 'forager-worker',
          description: 'User-defined UI implementer',
        },
        'reviewer-local': {
          baseAgent: 'code-reviewer',
          description: 'User-defined local reviewer',
        },
      },
    };
    expect(JSON.parse(fs.readFileSync(configPath, 'utf-8'))).toEqual(expectedStored);
    expect(updated.agents?.['hive-master']).toEqual({ model: 'user/hive-model', autoLoadSkills: ['parallel-exploration'] });
    expect(updated.agents?.['scout-researcher']).toEqual({ autoLoadSkills: [] });
    expect(updated.customAgents).not.toHaveProperty('scout-example-template');
    expect(updated.customAgents).not.toHaveProperty('forager-example-template');
    expect(updated.customAgents).not.toHaveProperty('reviewer-example-template');
    expect(service.get()).toEqual(updated);
    expect(new ConfigService().get()).toEqual(updated);
  });

  it('conditionally removes matching legacy topology from a fresh read and preserves unrelated settings', () => {
    const service = new ConfigService();
    const configPath = service.getPath();
    const repositoryRoot = path.join(tempHome, 'project');
    fs.mkdirSync(repositoryRoot);
    const repositories = [{ id: 'api', path: './api' }];
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({ agentMode: 'unified', repositoryRoot, repositories }));
    service.get();
    new ConfigService().set({ disableSkills: ['example'] });

    expect(service.removeLegacyRepositoryManifestIfMatches(repositoryRoot, repositories)).toBe('removed');
    expect(JSON.parse(fs.readFileSync(configPath, 'utf-8'))).toMatchObject({ agentMode: 'unified', disableSkills: ['example'] });
  });

  it('skips conditional legacy cleanup when a fresh global read no longer matches', () => {
    const service = new ConfigService();
    const configPath = service.getPath();
    const repositoryRoot = path.join(tempHome, 'project');
    const changedRoot = path.join(tempHome, 'changed');
    fs.mkdirSync(repositoryRoot);
    fs.mkdirSync(changedRoot);
    const repositories = [{ id: 'api', path: './api' }];
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({ repositoryRoot, repositories }));
    service.get();
    fs.writeFileSync(configPath, JSON.stringify({ repositoryRoot: changedRoot, repositories }));

    expect(service.removeLegacyRepositoryManifestIfMatches(repositoryRoot, repositories)).toBe('skipped');
    expect(JSON.parse(fs.readFileSync(configPath, 'utf-8')).repositoryRoot).toBe(changedRoot);
    expect(service.get().repositoryRoot).toBe(changedRoot);
  });

  it('merges a preference update with fresh stored config instead of a stale instance cache', () => {
    const staleService = new ConfigService();
    const configPath = staleService.getPath();
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({ hook_cadence: { 'chat.message': 1 }, disableSkills: ['existing'] }));
    staleService.get();

    new ConfigService().set({ agentMode: 'unified' });
    const updated = staleService.set({ hook_cadence: { 'chat.message': 2 } });

    expect(updated.agentMode).toBe('unified');
    expect(updated.disableSkills).toEqual(['existing']);
    expect(JSON.parse(fs.readFileSync(configPath, 'utf-8'))).toMatchObject({
      hook_cadence: { 'chat.message': 2 },
      disableSkills: ['existing'],
      agentMode: 'unified',
    });
  });

  it('does not reintroduce legacy topology from a writer cached before cleanup', () => {
    const writer = new ConfigService();
    const configPath = writer.getPath();
    const repositoryRoot = path.join(tempHome, 'project');
    const repositories = [{ id: 'api', path: './api' }];
    fs.mkdirSync(repositoryRoot);
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({ agentMode: 'dedicated', repositoryRoot, repositories }));
    writer.get();

    expect(new ConfigService().removeLegacyRepositoryManifestIfMatches(repositoryRoot, repositories)).toBe('removed');
    const updated = writer.set({ agentMode: 'unified' });
    const stored = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

    expect(updated.repositoryRoot).toBeUndefined();
    expect(updated.repositories).toBeUndefined();
    expect(stored.repositoryRoot).toBeUndefined();
    expect(stored.repositories).toBeUndefined();
    expect(stored.agentMode).toBe('unified');
  });

  it('rejects an invalid merged config without changing the stored file', () => {
    const service = new ConfigService();
    const configPath = service.getPath();
    const original = `${JSON.stringify({ agentMode: 'unified' }, null, 2)}\n`;
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, original);

    expect(() => service.set({ repositories: [] })).toThrow('Invalid global Agent Hive config');
    expect(fs.readFileSync(configPath, 'utf-8')).toBe(original);
  });

  it('rejects unknown top-level fields and non-positive hook cadence on read', () => {
    const configPath = new ConfigService().getPath();
    fs.mkdirSync(path.dirname(configPath), { recursive: true });

    for (const invalid of [{ unknown: true }, { hook_cadence: { 'chat.message': 0 } }]) {
      fs.writeFileSync(configPath, JSON.stringify(invalid));
      const service = new ConfigService();
      expect(service.get()).toEqual(DEFAULT_HIVE_CONFIG);
      expect(service.getLastFallbackWarning()?.reason).toBe('validation_error');
    }
  });

  it('keeps the existing file and cache when atomic persistence fails', () => {
    const service = new ConfigService();
    const configPath = service.getPath();
    const original = `${JSON.stringify({ agentMode: 'unified' }, null, 2)}\n`;
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, original);
    expect(service.get().agentMode).toBe('unified');

    const renameSpy = spyOn(fs, 'renameSync').mockImplementation(() => {
      throw new Error('rename failed');
    });
    try {
      expect(() => service.set({ agentMode: 'dedicated' })).toThrow('rename failed');
    } finally {
      renameSpy.mockRestore();
    }

    expect(fs.readFileSync(configPath, 'utf-8')).toBe(original);
    expect(service.get().agentMode).toBe('unified');
  });

  it('rejects writing a manifest whose active repository root does not exist', () => {
    const service = new ConfigService();
    const configPath = service.getPath();
    const original = `${JSON.stringify({ agentMode: 'dedicated' }, null, 2)}\n`;
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, original);

    expect(() => service.set({
      repositoryRoot: path.join(tempHome, 'missing-project'),
      repositories: [{ id: 'api', path: './api' }],
    })).toThrow('Repository root does not exist');
    expect(fs.readFileSync(configPath, 'utf-8')).toBe(original);
  });

  describe('project agent overrides', () => {
    it('changes built-in model or variant while preserving the other global settings', () => {
      const projectRoot = path.join(tempHome, 'project');
      const service = new ConfigService(projectRoot);
      const configPath = service.getPath();
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, JSON.stringify({
        agents: {
          'forager-worker': { model: 'global/forager', variant: 'medium' },
          'hive-builder': { model: 'global/builder' },
        },
      }));
      writeProjectOverride(projectRoot, {
        agents: {
          'forager-worker': { model: 'project/forager' },
          'hive-builder': { variant: 'high' },
        },
      });

      expect(service.getAgentConfig('forager-worker')).toMatchObject({
        model: 'project/forager',
        variant: 'medium',
      });
      expect(service.getAgentConfig('hive-builder')).toMatchObject({
        model: 'global/builder',
        variant: 'high',
      });
    });

    it('applies overrides over defaults when global config is missing', () => {
      const projectRoot = path.join(tempHome, 'project');
      const service = new ConfigService(projectRoot);
      writeProjectOverride(projectRoot, {
        agents: {
          'hive-builder': { model: 'project/builder' },
          'forager-worker': { model: 'project/forager', variant: 'high' },
        },
      });

      expect(fs.existsSync(service.getPath())).toBe(false);
      expect(service.getAgentConfig('hive-builder')).toEqual({
        model: 'project/builder',
        autoLoadSkills: ['verification', 'parallel-exploration'],
      });
      expect(service.getAgentConfig('forager-worker')).toMatchObject({
        model: 'project/forager',
        variant: 'high',
      });
      expect(service.getAgentConfig('scout-researcher')).not.toHaveProperty('model');
      expect(service.getLastFallbackWarning()).toBeNull();
    });

    it('trims project model and variant overrides before exposing built-in and custom agent config', () => {
      const projectRoot = path.join(tempHome, 'project');
      const service = new ConfigService(projectRoot);
      fs.mkdirSync(path.dirname(service.getPath()), { recursive: true });
      fs.writeFileSync(service.getPath(), JSON.stringify({
        customAgents: {
          'forager-direct': {
            baseAgent: 'forager-worker',
            description: 'Directly configured custom agent.',
          },
        },
      }));
      writeProjectOverride(projectRoot, {
        agents: { 'forager-worker': { model: ' project/forager ', variant: ' high ' } },
        customAgents: { 'forager-direct': { model: ' project/direct ', variant: ' low ' } },
      });

      expect(service.getAgentConfig('forager-worker')).toMatchObject({
        model: 'project/forager',
        variant: 'high',
      });
      expect(service.getCustomAgentConfigs()['forager-direct']).toMatchObject({
        model: 'project/direct',
        variant: 'low',
      });
    });

    it('overrides matching custom agents and preserves built-in inheritance precedence', () => {
      const projectRoot = path.join(tempHome, 'project');
      const service = new ConfigService(projectRoot);
      const configPath = service.getPath();
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, JSON.stringify({
        agents: {
          'forager-worker': { model: 'global/forager', variant: 'medium' },
        },
        customAgents: {
          'forager-inherited': {
            baseAgent: 'forager-worker',
            description: 'Inherits its model settings.',
          },
          'forager-direct': {
            baseAgent: 'forager-worker',
            description: 'Has a direct global variant.',
            variant: 'global-custom',
          },
        },
      }));
      writeProjectOverride(projectRoot, {
        agents: { 'forager-worker': { model: 'project/forager', variant: 'high' } },
        customAgents: { 'forager-direct': { variant: 'low' } },
      });

      expect(service.getCustomAgentConfigs()['forager-inherited']).toMatchObject({
        model: 'project/forager',
        variant: 'high',
      });
      expect(service.getCustomAgentConfigs()['forager-direct']).toMatchObject({
        model: 'project/forager',
        variant: 'low',
      });
    });

    it('ignores unmatched built-in and custom agent names without creating agents', () => {
      const projectRoot = path.join(tempHome, 'project');
      const service = new ConfigService(projectRoot);
      const configPath = service.getPath();
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, JSON.stringify({
        customAgents: {
          'known-specialist': {
            baseAgent: 'forager-worker',
            description: 'Existing specialist.',
          },
        },
      }));
      writeProjectOverride(projectRoot, {
        agents: { 'unknown-built-in': { model: 'project/unknown' } },
        customAgents: { 'unknown-custom': { variant: 'high' } },
      });

      const config = service.get();
      expect(config.agents).not.toHaveProperty('unknown-built-in');
      expect(config.customAgents).not.toHaveProperty('unknown-custom');
      expect(service.getCustomAgentConfigs()).not.toHaveProperty('unknown-custom');
      expect(service.hasConfiguredAgent('unknown-custom')).toBe(false);
      expect(service.getCustomAgentConfigs()).toHaveProperty('known-specialist');
    });

    it('ignores malformed JSON and rejects the entire document when fields are unsupported', () => {
      const projectRoot = path.join(tempHome, 'project');
      const configPath = new ConfigService(projectRoot).getPath();
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, JSON.stringify({
        agents: { 'forager-worker': { model: 'global/forager', variant: 'medium' } },
      }));
      fs.mkdirSync(path.dirname(projectOverridePath(projectRoot)), { recursive: true });

      for (const invalid of [
        '{invalid json',
        JSON.stringify({
          agents: {
            'forager-worker': { model: 'project/forager' },
            'hive-builder': { variant: 'high', temperature: 0.2 },
          },
        }),
      ]) {
        fs.writeFileSync(projectOverridePath(projectRoot), invalid);
        const service = new ConfigService(projectRoot);
        expect(service.getAgentConfig('forager-worker').model).toBe('global/forager');
        expect(service.getAgentConfig('hive-builder').variant).toBeUndefined();
        expect(service.getLastFallbackWarning()).toMatchObject({
          sourceType: 'project',
          sourcePath: projectOverridePath(projectRoot),
        });
      }
    });

    it('combines global and project failure details in the fallback warning', () => {
      const projectRoot = path.join(tempHome, 'project');
      const service = new ConfigService(projectRoot);
      fs.mkdirSync(path.dirname(service.getPath()), { recursive: true });
      fs.writeFileSync(service.getPath(), JSON.stringify({ agentMode: 'bogus' }));
      const overridePath = projectOverridePath(projectRoot);
      fs.mkdirSync(path.dirname(overridePath), { recursive: true });
      fs.writeFileSync(overridePath, '{invalid json');

      const config = service.get();

      expect(config).toEqual(DEFAULT_HIVE_CONFIG);
      expect(service.getLastFallbackWarning()?.message).toContain(service.getPath());
      expect(service.getLastFallbackWarning()?.message).toContain(overridePath);
      expect(service.getLastFallbackWarning()?.message).toContain('using defaults');
    });

    it('reports valid project overrides applied over defaults after a global config failure', () => {
      const projectRoot = path.join(tempHome, 'project');
      const service = new ConfigService(projectRoot);
      fs.mkdirSync(path.dirname(service.getPath()), { recursive: true });
      fs.writeFileSync(service.getPath(), JSON.stringify({ agentMode: 'bogus' }));
      writeProjectOverride(projectRoot, {
        agents: { 'hive-builder': { model: 'project/builder' } },
      });

      expect(service.getAgentConfig('hive-builder').model).toBe('project/builder');
      expect(service.getLastFallbackWarning()?.message).toContain(
        'using defaults with valid project agent overrides applied',
      );
    });

    it('keeps project values out of global writes and reapplies the startup snapshot after set()', () => {
      const projectRoot = path.join(tempHome, 'project');
      const service = new ConfigService(projectRoot);
      const overridePath = writeProjectOverride(projectRoot, {
        agents: { 'forager-worker': { model: 'project/forager', variant: 'high' } },
      });

      expect(service.init().agents?.['forager-worker']?.model).toBe('project/forager');
      writeProjectOverride(projectRoot, {
        agents: { 'forager-worker': { model: 'changed/project', variant: 'low' } },
      });
      const updated = service.set({
        agents: { 'forager-worker': { autoLoadSkills: ['extra'] } },
      });
      const stored = JSON.parse(fs.readFileSync(service.getPath(), 'utf-8'));

      expect(updated.agents?.['forager-worker']).toMatchObject({
        model: 'project/forager',
        variant: 'high',
        autoLoadSkills: ['extra'],
      });
      expect(service.getAgentConfig('forager-worker').model).toBe('project/forager');
      expect(stored.agents?.['forager-worker']).not.toHaveProperty('model');
      expect(stored.agents?.['forager-worker']).not.toHaveProperty('variant');
      expect(fs.readFileSync(overridePath, 'utf-8')).toContain('changed/project');
    });
  });
});

describe('ConfigService effective model settings', () => {
  const writeGlobal = (service: ConfigService, value: unknown): string => {
    fs.mkdirSync(path.dirname(service.getPath()), { recursive: true });
    const bytes = JSON.stringify(value);
    fs.writeFileSync(service.getPath(), bytes);
    return bytes;
  };
  const rejection = (read: () => unknown): string => {
    try {
      read();
    } catch (error) {
      return (error as Error).message;
    }
    throw new Error('expected the configuration to be rejected');
  };

  it('rejects a variant without an effective Hive model, naming file, path and remedy without values', () => {
    const service = new ConfigService();
    const bytes = writeGlobal(service, {
      agentMode: 'unified',
      agents: { 'forager-worker': { variant: 'secret-variant-value' } },
    });

    const message = rejection(() => service.get());
    expect(message).toContain(service.getPath());
    expect(message).toContain('agents.forager-worker.variant is set without a Hive model');
    expect(message).toContain('Set agents.forager-worker.model to an explicit provider/model-id, or remove the variant');
    expect(message).not.toContain('secret-variant-value');
    // The rejected candidate is not cached: every read rejects, and reads never touch the file.
    expect(() => service.get()).toThrow('agents.forager-worker.variant');
    expect(() => service.getAgentConfig('scout-researcher')).toThrow('agents.forager-worker.variant');
    expect(service.getLastFallbackWarning()).toBeNull();
    expect(fs.readFileSync(service.getPath(), 'utf-8')).toBe(bytes);

    writeGlobal(service, { agentMode: 'unified', agents: { 'forager-worker': { model: 'provider/forager', variant: 'secret-variant-value' } } });
    expect(service.getAgentConfig('forager-worker')).toMatchObject({ model: 'provider/forager', variant: 'secret-variant-value' });
    expect(service.get().agentMode).toBe('unified');
  });

  it('rejects supplied blank or malformed models and variants instead of treating them as omitted', () => {
    const cases: Array<[unknown, string]> = [
      [{ agents: { 'hive-builder': { model: '   ' } } }, 'agents.hive-builder.model must be an explicit provider/model-id'],
      [{ agents: { 'hive-builder': { model: 'no-provider' } } }, 'agents.hive-builder.model must be an explicit provider/model-id'],
      [{ agents: { 'hive-builder': { model: 'openai/gpt#high' } } }, 'agents.hive-builder.model must be an explicit provider/model-id'],
      [{ agents: { 'hive-builder': { model: 'openai/gpt 5' } } }, 'agents.hive-builder.model must be an explicit provider/model-id'],
      [{ agents: { 'hive-builder': { model: 'openai/gpt', variant: ' ' } } }, 'agents.hive-builder.variant must be a variant name'],
      [{ agents: { 'forager-worker': { model: 'provider/forager' } }, customAgents: { 'forager-ui': { baseAgent: 'forager-worker', description: 'UI', model: '  ' } } }, 'customAgents.forager-ui.model must be'],
      [{ agents: { 'forager-worker': { model: 'provider/forager', variant: 'high' } }, customAgents: { 'forager-ui': { baseAgent: 'forager-worker', description: 'UI', variant: '' } } }, 'customAgents.forager-ui.variant must be'],
      [{ customAgents: { 'forager-ui': { baseAgent: 'forager-worker', description: 'UI', model: 42 } } }, 'customAgents.forager-ui.model must be'],
      [{ taskTraceSummarizer: { model: ' ' } }, 'taskTraceSummarizer.model must be'],
      [{ taskTraceSummarizer: { model: 'provider/summary', variant: '  ' } }, 'taskTraceSummarizer.variant must be'],
    ];
    for (const [config, expected] of cases) {
      const service = new ConfigService();
      writeGlobal(service, config);
      expect(rejection(() => service.get())).toContain(expected);
    }
  });

  it('lets global and project fragments complete each other, and rejects either unresolved fragment', () => {
    const projectRoot = path.join(tempHome, 'project');
    let service = new ConfigService(projectRoot);
    writeGlobal(service, { agents: { 'forager-worker': { variant: 'high' }, 'hive-builder': { model: 'global/builder' } } });
    writeProjectOverride(projectRoot, { agents: { 'forager-worker': { model: 'project/forager' }, 'hive-builder': { variant: 'low' } } });

    expect(service.getAgentConfig('forager-worker')).toMatchObject({ model: 'project/forager', variant: 'high' });
    expect(service.getAgentConfig('hive-builder')).toMatchObject({ model: 'global/builder', variant: 'low' });

    service = new ConfigService(projectRoot);
    writeProjectOverride(projectRoot, { agents: { 'scout-researcher': { variant: 'low' } } });
    const message = rejection(() => service.get());
    expect(message).toContain(service.getPath());
    expect(message).toContain(projectOverridePath(projectRoot));
    expect(message).toContain('agents.forager-worker.variant is set without a Hive model');
    expect(message).toContain('agents.scout-researcher.variant is set without a Hive model');

    // Without the project fragment, the global variant stands alone and is rejected.
    expect(rejection(() => new ConfigService().get())).toContain('agents.forager-worker.variant');
  });

  it('rejects blank project model and variant strings for matching roles instead of ignoring the file', () => {
    const projectRoot = path.join(tempHome, 'project');
    const service = new ConfigService(projectRoot);
    const bytes = writeGlobal(service, {
      agents: { 'forager-worker': { model: 'global/forager', variant: 'medium' } },
      customAgents: { 'forager-ui': { baseAgent: 'forager-worker', description: 'UI' } },
    });
    const cases: Array<[unknown, string]> = [
      [{ agents: { 'forager-worker': { model: '   ' } } }, 'agents.forager-worker.model must be an explicit provider/model-id'],
      [{ agents: { 'forager-worker': { variant: '' } } }, 'agents.forager-worker.variant must be a variant name'],
      [{ customAgents: { 'forager-ui': { model: '' } } }, 'customAgents.forager-ui.model must be an explicit provider/model-id'],
      [{ customAgents: { 'forager-ui': { variant: '  ' } } }, 'customAgents.forager-ui.variant must be a variant name'],
    ];
    for (const [override, expected] of cases) {
      const overridePath = writeProjectOverride(projectRoot, override);
      const fresh = new ConfigService(projectRoot);

      const message = rejection(() => fresh.get());
      expect(message).toContain(overridePath);
      expect(message).toContain(expected);
      // A rejected candidate is neither served nor cached, and no fallback warning hides it.
      expect(() => fresh.getAgentConfig('forager-worker')).toThrow(expected);
      expect(fresh.getLastFallbackWarning()).toBeNull();
      expect(fs.readFileSync(service.getPath(), 'utf-8')).toBe(bytes);
    }

    // Blank values for roles the project file does not match are inert; a wrong type stays a structural file error.
    writeProjectOverride(projectRoot, { agents: { 'unknown-role': { model: ' ' } }, customAgents: { 'unknown-custom': { variant: '' } } });
    expect(new ConfigService(projectRoot).getAgentConfig('forager-worker')).toMatchObject({ model: 'global/forager', variant: 'medium' });
    writeProjectOverride(projectRoot, { agents: { 'forager-worker': { model: 42 } } });
    const structural = new ConfigService(projectRoot);
    expect(structural.getAgentConfig('forager-worker')).toMatchObject({ model: 'global/forager', variant: 'medium' });
    expect(structural.getLastFallbackWarning()).toMatchObject({ sourceType: 'project', reason: 'validation_error' });
  });

  it('lets a custom variant use its resolved Hive base model, including a project change to the base', () => {
    const projectRoot = path.join(tempHome, 'project');
    const service = new ConfigService(projectRoot);
    writeGlobal(service, {
      customAgents: {
        'forager-fast': { baseAgent: 'forager-worker', description: 'Fast forager', variant: 'low' },
        'reviewer-native': { baseAgent: 'code-reviewer', description: 'Native reviewer' },
      },
    });
    writeProjectOverride(projectRoot, { agents: { 'forager-worker': { model: 'project/forager' } } });

    expect(service.getCustomAgentConfigs()['forager-fast']).toMatchObject({ model: 'project/forager', variant: 'low' });
    expect(service.getCustomAgentConfigs()['reviewer-native']).not.toHaveProperty('model');
    expect(service.getCustomAgentConfigs()['reviewer-native']).not.toHaveProperty('variant');

    const message = rejection(() => new ConfigService().get());
    expect(message).toContain('customAgents.forager-fast.variant is set without a Hive model');
    expect(message).toContain('customAgents.forager-fast.model or agents.forager-worker.model');
    expect(message).not.toContain('reviewer-native');
  });

  it('rejects a summarizer variant without a summarizer model', () => {
    const service = new ConfigService();
    writeGlobal(service, { agents: { 'hive-builder': { model: 'provider/builder' } }, taskTraceSummarizer: { variant: 'high' } });

    expect(rejection(() => service.get())).toContain('taskTraceSummarizer.variant is set without a Hive model. Set taskTraceSummarizer.model');
  });

  it('accepts a variant-only update when the stored global declaration already has the model', () => {
    const service = new ConfigService();
    writeGlobal(service, { agents: { 'forager-worker': { model: 'provider/forager', temperature: 0.3 } } });

    const updated = service.set({ agents: { 'forager-worker': { variant: 'high' } } });

    expect(updated.agents?.['forager-worker']).toMatchObject({ model: 'provider/forager', variant: 'high' });
    expect(JSON.parse(fs.readFileSync(service.getPath(), 'utf-8'))).toEqual({
      agents: { 'forager-worker': { model: 'provider/forager', variant: 'high' } },
    });
  });

  it('omits legacy temperature from written updates and stored declarations without changing the caller input', () => {
    const service = new ConfigService();
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    writeGlobal(service, {
      customAgents: { 'forager-ui': { baseAgent: 'forager-worker', description: 'UI', temperature: 0.2 } },
    });
    const update = { agents: { 'hive-builder': { model: 'provider/builder', temperature: 0.9 } }, taskTraceSummarizer: { temperature: 0 } } as unknown as Parameters<ConfigService['set']>[0];
    const before = JSON.stringify(update);

    try {
      service.set(update);

      expect(JSON.stringify(update)).toBe(before);
      expect(JSON.parse(fs.readFileSync(service.getPath(), 'utf-8'))).toEqual({
        agents: { 'hive-builder': { model: 'provider/builder' } },
        customAgents: { 'forager-ui': { baseAgent: 'forager-worker', description: 'UI' } },
        taskTraceSummarizer: {},
      });
    } finally {
      warn.mockRestore();
    }
  });

  it('rejects a global write a project model would complete, leaving bytes and the prior cache unchanged', () => {
    const projectRoot = path.join(tempHome, 'project');
    const service = new ConfigService(projectRoot);
    const bytes = writeGlobal(service, { agentMode: 'dedicated' });
    writeProjectOverride(projectRoot, { agents: { 'forager-worker': { model: 'project/forager' } } });
    const prior = service.get();

    const message = rejection(() => service.set({ agentMode: 'unified', agents: { 'forager-worker': { variant: 'high' } } }));

    expect(message).toContain(service.getPath());
    expect(message).not.toContain(projectOverridePath(projectRoot));
    expect(message).toContain('agents.forager-worker.variant is set without a Hive model');
    expect(fs.readFileSync(service.getPath(), 'utf-8')).toBe(bytes);
    expect(service.get()).toBe(prior);
    expect(service.get().agentMode).toBe('dedicated');
  });

  it('rejects a standalone-valid write whose effective project view is invalid', () => {
    const projectRoot = path.join(tempHome, 'project');
    const service = new ConfigService(projectRoot);
    const bytes = writeGlobal(service, { agents: { 'forager-worker': { model: 'global/forager', variant: 'high' } } });
    writeProjectOverride(projectRoot, { agents: { 'forager-worker': { variant: 'low' } } });
    const prior = service.get();
    expect(prior.agents?.['forager-worker']).toMatchObject({ model: 'global/forager', variant: 'low' });

    // Clearing the global model and variant is valid on its own but leaves the project variant without a model.
    const message = rejection(() => service.set({ agents: { 'forager-worker': { model: undefined, variant: undefined } } }));

    expect(message).toContain(projectOverridePath(projectRoot));
    expect(message).toContain('agents.forager-worker.variant is set without a Hive model');
    expect(fs.readFileSync(service.getPath(), 'utf-8')).toBe(bytes);
    expect(service.get()).toBe(prior);
  });

  it('rejects legacy topology cleanup that would persist a global variant only a project model completes', () => {
    const projectRoot = path.join(tempHome, 'project');
    fs.mkdirSync(projectRoot);
    const repositories = [{ id: 'api', path: './api' }];
    const service = new ConfigService(projectRoot);
    const bytes = writeGlobal(service, {
      repositoryRoot: projectRoot,
      repositories,
      agents: { 'forager-worker': { variant: 'high' } },
    });
    writeProjectOverride(projectRoot, { agents: { 'forager-worker': { model: 'project/forager' } } });
    const prior = service.get();
    expect(prior.agents?.['forager-worker']).toMatchObject({ model: 'project/forager', variant: 'high' });

    const message = rejection(() => service.removeLegacyRepositoryManifestIfMatches(projectRoot, repositories));

    expect(message).toContain(service.getPath());
    expect(message).not.toContain(projectOverridePath(projectRoot));
    expect(message).toContain('agents.forager-worker.variant is set without a Hive model');
    expect(fs.readFileSync(service.getPath(), 'utf-8')).toBe(bytes);
    expect(service.get()).toBe(prior);
  });

  it('init() writes no provider model and rejects before writing when the project view is invalid', () => {
    const projectRoot = path.join(tempHome, 'project');
    const service = new ConfigService(projectRoot);
    const overridePath = writeProjectOverride(projectRoot, { agents: { 'forager-worker': { variant: 'high' } } });

    expect(rejection(() => service.init())).toContain('agents.forager-worker.variant');
    expect(fs.existsSync(service.getPath())).toBe(false);

    fs.writeFileSync(overridePath, JSON.stringify({ agents: { 'forager-worker': { model: 'project/forager' } } }));
    const initialized = new ConfigService(projectRoot).init();
    expect(initialized.agents?.['forager-worker']?.model).toBe('project/forager');
    expect(initialized.agents?.['scout-researcher']).not.toHaveProperty('model');
    expect(fs.readFileSync(service.getPath(), 'utf-8')).not.toContain('"model"');
  });
});
