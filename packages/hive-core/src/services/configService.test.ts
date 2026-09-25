import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ConfigService } from "./configService";
import { CUSTOM_AGENT_BASES, DEFAULT_HIVE_CONFIG, DEFAULT_ROUTING_AGENT_DESCRIPTIONS } from "../types";

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
    expect(config.agents?.["architect-planner"]?.model).toBe(
      "github-copilot/gpt-5.2-codex",
    );
    expect(config.agents?.["hive-master"]?.model).toBe(
      "github-copilot/claude-opus-4.5",
    );
    expect(config.agents?.["swarm-orchestrator"]?.model).toBe(
      "github-copilot/claude-opus-4.5",
    );
    expect(config.agents?.['hive-helper']).toEqual({
      model: 'github-copilot/gpt-5.2-codex',
      temperature: 0.3,
      autoLoadSkills: [],
    });
    expect(config.customAgents).toEqual({
      'scout-example-template': {
        baseAgent: 'scout-researcher',
        description: 'Example template only: rename or delete this entry before use. Do not expect planners/orchestrators to select this placeholder agent as configured.',
        autoLoadSkills: [],
      },
      'forager-example-template': {
        baseAgent: 'forager-worker',
        description: 'Example template only: rename or delete this entry before use. Do not expect planners/orchestrators to select this placeholder agent as configured.',
        model: 'anthropic/claude-sonnet-4-20250514',
        temperature: 0.2,
        variant: 'high',
        autoLoadSkills: ['verification'],
      },
      'reviewer-example-template': {
        baseAgent: 'code-reviewer',
        description: 'Example template only: rename or delete this entry before use. Do not expect planners/orchestrators to select this placeholder agent as configured.',
        autoLoadSkills: [],
      },
    });
  });

  it('defaults task trace summarization to the OpenCode model with deterministic temperature', () => {
    expect(new ConfigService().get().taskTraceSummarizer).toEqual({ temperature: 0 });
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

  it('loads a strict task trace summarizer override', () => {
    const service = new ConfigService();
    fs.mkdirSync(path.dirname(service.getPath()), { recursive: true });
    fs.writeFileSync(service.getPath(), JSON.stringify({
      taskTraceSummarizer: {
        model: 'provider/model',
        variant: 'high',
        temperature: 0.25,
      },
    }));

    expect(service.get().taskTraceSummarizer).toEqual({
      model: 'provider/model',
      variant: 'high',
      temperature: 0.25,
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
      temperature: 0,
    });
  });

  it('falls back to defaults for invalid task trace summarizer declarations', () => {
    for (const taskTraceSummarizer of [
      { model: '' },
      { variant: '   ' },
      { temperature: -0.1 },
      { temperature: 2.1 },
      { temperature: Number.NaN },
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
              temperature: 0.2,
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
      temperature: 0.2,
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
    expect(config.customAgents).toEqual({
      'scout-example-template': {
        baseAgent: 'scout-researcher',
        description: 'Example template only: rename or delete this entry before use. Do not expect planners/orchestrators to select this placeholder agent as configured.',
        autoLoadSkills: [],
      },
      'forager-example-template': {
        baseAgent: 'forager-worker',
        description: 'Example template only: rename or delete this entry before use. Do not expect planners/orchestrators to select this placeholder agent as configured.',
        model: 'anthropic/claude-sonnet-4-20250514',
        temperature: 0.2,
        variant: 'high',
        autoLoadSkills: ['verification'],
      },
      'reviewer-example-template': {
        baseAgent: 'code-reviewer',
        description: 'Example template only: rename or delete this entry before use. Do not expect planners/orchestrators to select this placeholder agent as configured.',
        autoLoadSkills: [],
      },
    });
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

  it('init() writes global defaults even when a project root is supplied', () => {
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

      expect(config).toEqual(DEFAULT_HIVE_CONFIG);
      expect(service.getActiveReadSourceType()).toBe('global');
      expect(fs.existsSync(service.getPath())).toBe(true);
      const stored = JSON.parse(fs.readFileSync(service.getPath(), 'utf-8'));
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

  it("deep-merges agent overrides with defaults", () => {
    const service = new ConfigService();
    const configPath = service.getPath();

    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify(
        {
          agents: {
            "hive-master": { temperature: 0.8 },
          },
        },
        null,
        2,
      ),
    );

    const config = service.get();
    expect(config.agents?.["hive-master"]?.temperature).toBe(0.8);
    expect(config.agents?.["hive-master"]?.model).toBe(
      "github-copilot/claude-opus-4.5",
    );

    const agentConfig = service.getAgentConfig("hive-master");
    expect(agentConfig.temperature).toBe(0.8);
    expect(agentConfig.model).toBe("github-copilot/claude-opus-4.5");
  });

  it("deep-merges variant field from user config", () => {
    const service = new ConfigService();
    const configPath = service.getPath();

    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify(
        {
          agents: {
            "forager-worker": { variant: "high" },
            "scout-researcher": { variant: "low", temperature: 0.2 },
          },
        },
        null,
        2,
      ),
    );

    const config = service.get();
    // variant should be merged from user config
    expect(config.agents?.["forager-worker"]?.variant).toBe("high");
    expect(config.agents?.["scout-researcher"]?.variant).toBe("low");
    // other defaults should still be present
    expect(config.agents?.["forager-worker"]?.model).toBe(
      "github-copilot/gpt-5.2-codex",
    );
    expect(config.agents?.["scout-researcher"]?.temperature).toBe(0.2);

    // getAgentConfig should also return variant
    const foragerConfig = service.getAgentConfig("forager-worker");
    expect(foragerConfig.variant).toBe("high");
    expect(foragerConfig.model).toBe("github-copilot/gpt-5.2-codex");

    const scoutConfig = service.getAgentConfig("scout-researcher");
    expect(scoutConfig.variant).toBe("low");
    expect(scoutConfig.temperature).toBe(0.2);
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

  it('keeps hive-helper autoLoadSkills empty even when user sets them', () => {
    const service = new ConfigService();
    const configPath = service.getPath();

    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify(
        {
          agents: {
            'hive-helper': {
              autoLoadSkills: ['test-driven-development'],
            },
          },
        },
        null,
        2,
      ),
    );

    const config = service.getAgentConfig('hive-helper');
    expect(config.autoLoadSkills).toEqual([]);
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

  it("defaults have no variant set", () => {
    const service = new ConfigService();
    const config = service.get();

    // Default config should not have variant set for any agent
    for (const agentKey of Object.keys(config.agents ?? {})) {
      const agent = config.agents?.[agentKey as keyof typeof config.agents];
      expect(agent?.variant).toBeUndefined();
    }
  });

  it("getAgentConfig('hive-builder') returns default config", () => {
    const service = new ConfigService();
    const config = service.getAgentConfig("hive-builder");

    expect(config.model).toBe("github-copilot/gpt-5.2-codex");
    expect(config.temperature).toBe(0.4);
    expect(config.autoLoadSkills).toEqual(["verification", "parallel-exploration"]);
  });

  it("deep-merges hive-builder overrides with defaults", () => {
    const service = new ConfigService();
    const configPath = service.getPath();

    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify(
        {
          agents: {
            "hive-builder": { temperature: 0.6, variant: "high" },
          },
        },
        null,
        2,
      ),
    );

    const config = service.getAgentConfig("hive-builder");
    expect(config.temperature).toBe(0.6);
    expect(config.variant).toBe("high");
    expect(config.model).toBe("github-copilot/gpt-5.2-codex");
    expect(config.autoLoadSkills).toEqual(["verification", "parallel-exploration"]);
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

  it("preserves legacy custom dash-reviewer while skipping reserved custom agent names", () => {
    const service = new ConfigService();
    const configPath = service.getPath();
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify(
        {
          customAgents: {
            "dash-reviewer": {
              baseAgent: "code-reviewer",
              description: "Existing custom reviewer.",
              model: "provider/custom-reviewer",
              variant: "high",
            },
            "hive-builder": {
              baseAgent: "forager-worker",
              description: "Should be skipped as reserved.",
            },
            builder: {
              baseAgent: "forager-worker",
              description: "Should be skipped as reserved.",
            },
          },
        },
        null,
        2,
      ),
    );

    const custom = service.getCustomAgentConfigs();
    expect(custom).toHaveProperty("dash-reviewer");
    expect(service.getAgentConfig("dash-reviewer")).toMatchObject({
      model: "provider/custom-reviewer",
      variant: "high",
    });
    expect(custom).not.toHaveProperty("hive-builder");
    expect(custom).not.toHaveProperty("builder");

    const warnedLines = warnSpy.mock.calls.map((call) => call.join(" "));
    expect(
      warnedLines.some(
        (line) => line.includes("reserved") && line.includes('"dash-reviewer"'),
      ),
    ).toBe(false);
    expect(
      warnedLines.some(
        (line) => line.includes("reserved") && line.includes('"hive-builder"'),
      ),
    ).toBe(true);
    expect(
      warnedLines.some(
        (line) => line.includes("reserved") && line.includes('"builder"'),
      ),
    ).toBe(true);

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
              variant: "medium",
              autoLoadSkills: ["onboarding", "research-focus"],
            },
            "forager-worker": {
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
              temperature: 0.1,
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
      model: "zai-coding-plan/glm-4.7",
      temperature: 0.5,
      variant: "medium",
    });
    expect(custom["scout-docs"]?.autoLoadSkills).toEqual([
      "research-focus",
    ]);

    expect(custom["forager-lite"]).toMatchObject({
      baseAgent: "forager-worker",
      model: "github-copilot/gpt-5.2-codex",
      temperature: 0.3,
    });

    expect(custom["forager-ui"]?.variant).toBe("high");
    expect(custom["forager-ui"]?.autoLoadSkills).toEqual([
      "verification",
      "ui-focus",
    ]);

    expect(custom["reviewer-security"]?.temperature).toBe(0.1);
    expect(custom["reviewer-security"]?.model).toBe(
      "anthropic/claude-sonnet-4-20250514",
    );
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

  it("treats empty custom model and variant overrides as unset", () => {
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
              model: "   ",
              variant: "   ",
            },
          },
        },
        null,
        2,
      ),
    );

    const custom = service.getCustomAgentConfigs();
    expect(custom["forager-ui"]?.model).toBe("github-copilot/gpt-5.2-codex");
    expect(custom["forager-ui"]?.variant).toBeUndefined();
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
          temperature: 0.4,
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
      temperature: 0.4,
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
        'forager-worker': { variant: 'high' },
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
        'forager-worker': { variant: 'high' },
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
    expect(updated.agents?.['hive-master']?.temperature).toBe(
      DEFAULT_HIVE_CONFIG.agents?.['hive-master']?.temperature,
    );
    expect(updated.customAgents?.['forager-example-template']).toEqual(
      DEFAULT_HIVE_CONFIG.customAgents?.['forager-example-template'],
    );
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
          'forager-worker': { model: 'global/forager', variant: 'medium', temperature: 0.65 },
          'hive-builder': { model: 'global/builder', temperature: 0.7 },
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
        temperature: 0.65,
      });
      expect(service.getAgentConfig('hive-builder')).toMatchObject({
        model: 'global/builder',
        variant: 'high',
        temperature: 0.7,
      });
    });

    it('applies overrides over defaults when global config is missing', () => {
      const projectRoot = path.join(tempHome, 'project');
      const service = new ConfigService(projectRoot);
      writeProjectOverride(projectRoot, {
        agents: {
          'hive-builder': { model: 'project/builder' },
          'forager-worker': { variant: 'high' },
        },
      });

      expect(fs.existsSync(service.getPath())).toBe(false);
      expect(service.getAgentConfig('hive-builder')).toMatchObject({
        model: 'project/builder',
        temperature: DEFAULT_HIVE_CONFIG.agents?.['hive-builder']?.temperature,
      });
      expect(service.getAgentConfig('forager-worker')).toMatchObject({
        model: DEFAULT_HIVE_CONFIG.agents?.['forager-worker']?.model,
        variant: 'high',
      });
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
          'forager-worker': { model: 'global/forager', variant: 'medium', temperature: 0.6 },
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
        temperature: 0.6,
      });
      expect(service.getCustomAgentConfigs()['forager-direct']).toMatchObject({
        model: 'project/forager',
        variant: 'low',
        temperature: 0.6,
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
        agents: { 'forager-worker': { temperature: 0.8 } },
      });
      const stored = JSON.parse(fs.readFileSync(service.getPath(), 'utf-8'));

      expect(updated.agents?.['forager-worker']).toMatchObject({
        model: 'project/forager',
        variant: 'high',
        temperature: 0.8,
      });
      expect(service.getAgentConfig('forager-worker').model).toBe('project/forager');
      expect(stored.agents?.['forager-worker']?.model).toBe(
        DEFAULT_HIVE_CONFIG.agents?.['forager-worker']?.model,
      );
      expect(stored.agents?.['forager-worker']?.variant).not.toBe('high');
      expect(fs.readFileSync(overridePath, 'utf-8')).toContain('changed/project');
    });
  });
});
