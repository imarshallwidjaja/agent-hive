import { describe, expect, it } from 'bun:test';
import Ajv2020 from 'ajv/dist/2020.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ConfigService } from 'hive-core';

const schemaPath = path.resolve(import.meta.dir, '..', '..', 'schema', 'agent_hive.schema.json');
const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf-8')) as Record<string, any>;
const projectOverrideSchemaPath = path.resolve(import.meta.dir, '..', '..', 'schema', 'agent_hive.override.schema.json');
const projectOverrideSchema = JSON.parse(fs.readFileSync(projectOverrideSchemaPath, 'utf-8')) as Record<string, any>;
const packageJsonPath = path.resolve(import.meta.dir, '..', '..', 'package.json');
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8')) as { peerDependencies?: Record<string, string> };

const validateConfigShape = new Ajv2020({ strict: false }).compile(schema);
const validateProjectOverrideShape = new Ajv2020({ strict: false }).compile(projectOverrideSchema);

function acceptsRuntimeProjectOverride(value: unknown): boolean {
  const originalHome = process.env.HOME;
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-project-override-schema-'));
  const projectRoot = path.join(tempHome, 'project');
  const overridePath = path.join(projectRoot, '.hive', 'agent-hive.override.json');

  try {
    process.env.HOME = tempHome;
    fs.mkdirSync(path.dirname(overridePath), { recursive: true });
    fs.writeFileSync(overridePath, JSON.stringify(value));
    const configService = new ConfigService(projectRoot);
    configService.get();
    return configService.getLastFallbackWarning() === null;
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
}

const expectReservedNameToFail = (name: string): void => {
  const reservedNames = schema.properties?.customAgents?.propertyNames?.not?.enum;
  expect(Array.isArray(reservedNames)).toBe(true);
  expect(reservedNames).toContain(name);
};

describe('agent_hive schema customAgents contract', () => {
  it('requires the verified OpenCode task-definition hook runtime', () => {
    expect(packageJson.peerDependencies?.['@opencode-ai/plugin']).toBe('>=1.18.30');
  });

  it('defines customAgents map and custom agent schema', () => {
    expect(schema.properties.customAgents).toBeDefined();
    expect(schema.properties.customAgents.additionalProperties).toEqual({
      $ref: '#/$defs/customAgentConfig',
    });
    expect(schema.$defs.customAgentConfig.required).toEqual(['baseAgent', 'description']);
    expect(schema.$defs.customAgentConfig.properties).not.toHaveProperty('skills');
  });

  it('restricts custom baseAgent to supported base agents', () => {
    expect(schema.$defs.customAgentConfig.properties.baseAgent.enum).toEqual([
      'scout-researcher',
      'forager-worker',
      'plan-reviewer',
      'code-reviewer',
      'simplicity-reviewer',
      'approach-advisor',
      'vulnerability-reviewer',
    ]);
  });

  it('allows hive-builder as a built-in agent config key', () => {
    expect(schema.properties.agents.properties).toHaveProperty('hive-builder');
    expect(schema.properties.agents.properties['hive-builder']).toEqual({
      $ref: '#/$defs/agentConfig',
      description: 'Hive Builder (ad-hoc orchestrator)',
    });
  });

  it('exposes routing descriptions only for the seven customizable built-in agents', () => {
    const customizable = [
      'scout-researcher',
      'forager-worker',
      'plan-reviewer',
      'code-reviewer',
      'simplicity-reviewer',
      'approach-advisor',
      'vulnerability-reviewer',
    ];
    const nonCustomizable = [
      'hive-master',
      'architect-planner',
      'swarm-orchestrator',
      'hive-helper',
      'hive-builder',
    ];

    for (const name of customizable) {
      expect(schema.properties.agents.properties[name].$ref).toBe('#/$defs/routingAgentConfig');
    }
    for (const name of nonCustomizable) {
      expect(schema.properties.agents.properties[name].$ref).toBe('#/$defs/agentConfig');
    }

    expect(validateConfigShape({
      agents: {
        'forager-worker': { description: '  Default for backend implementation.  ' },
      },
    })).toBe(true);
    expect(validateConfigShape({
      agents: {
        'forager-worker': { description: '   ' },
      },
    })).toBe(true);
    expect(validateConfigShape({
      agents: {
        'hive-builder': { description: 'Not configurable' },
      },
    })).toBe(false);
  });

  it('rejects whitespace-only custom agent descriptions', () => {
    expect(validateConfigShape({
      customAgents: {
        'forager-ui': {
          baseAgent: 'forager-worker',
          description: '   ',
        },
      },
    })).toBe(false);
  });

  it('rejects native permission wildcard characters in custom agent IDs', () => {
    expect(schema.properties.customAgents.propertyNames.pattern).toBe('^[^*?]*$');

    const validCustomAgents = {
      'scout-docs': {
        baseAgent: 'scout-researcher',
        description: 'Named Scout specialist.',
      },
      'plan-risk-reviewer': {
        baseAgent: 'plan-reviewer',
        description: 'Named plan reviewer specialist.',
      },
      'approach-specialist': {
        baseAgent: 'approach-advisor',
        description: 'Named advisor specialist.',
      },
    };
    expect(validateConfigShape({ customAgents: validCustomAgents })).toBe(true);

    for (const name of ['architect-*', 'forager-*', 'hive-*', '*', '?']) {
      expect(validateConfigShape({
        customAgents: {
          [name]: {
            baseAgent: 'scout-researcher',
            description: 'Wildcard custom agent.',
          },
        },
      })).toBe(false);
    }
  });

  it('reserves built-in and plugin-managed agent names', () => {
    expectReservedNameToFail('hive-master');
    expectReservedNameToFail('architect-planner');
    expectReservedNameToFail('swarm-orchestrator');
    expectReservedNameToFail('scout-researcher');
    expectReservedNameToFail('forager-worker');
    expectReservedNameToFail('hive-helper');
    expectReservedNameToFail('plan-reviewer');
    expectReservedNameToFail('code-reviewer');
    expectReservedNameToFail('simplicity-reviewer');
    expectReservedNameToFail('approach-advisor');
    expectReservedNameToFail('vulnerability-reviewer');
    expectReservedNameToFail('__hive_dash_review_primary');
    expectReservedNameToFail('__hive_vulnerability_review_primary');
    expectReservedNameToFail('__hive_task_trace_summarizer');
    expectReservedNameToFail('hive');
    expectReservedNameToFail('architect');
    expectReservedNameToFail('swarm');
    expectReservedNameToFail('scout');
    expectReservedNameToFail('forager');
    expectReservedNameToFail('hygienic');
    expectReservedNameToFail('hygienic-reviewer');
    expectReservedNameToFail('receiver');
    expectReservedNameToFail('build');
    expectReservedNameToFail('plan');
    expectReservedNameToFail('code');
    expectReservedNameToFail('hive-builder');
    expectReservedNameToFail('builder');
  });

  it('reserves review primaries and ordinary native subagents against custom replacement', () => {
    for (const name of ['dash-reviewer', 'vulnerability-review-primary', 'general', 'explore']) {
      expectReservedNameToFail(name);
      expect(validateConfigShape({ customAgents: { [name]: { baseAgent: 'forager-worker', description: 'Cannot replace a managed identity.' } } })).toBe(false);
    }
    expect(schema.properties.agents.properties).not.toHaveProperty('dash-reviewer');
  });

  it('accepts vulnerability reviewer model overrides and derived specialists', () => {
    expect(validateConfigShape({
      agents: {
        'vulnerability-reviewer': { model: 'provider/security', variant: 'xhigh' },
      },
      customAgents: {
        'security-supply-chain': {
          baseAgent: 'vulnerability-reviewer',
          description: 'Dependency and build-chain attack paths',
          model: 'provider/supply-chain',
          variant: 'high',
        },
      },
    })).toBe(true);
  });
});

describe('agent_hive schema council contract', () => {
  it('defines the strict task trace summarizer configuration', () => {
    expect(schema.properties.taskTraceSummarizer).toEqual({
      $ref: '#/$defs/taskTraceSummarizerConfig',
      description: 'Optional model settings for the hidden, tool-less recovery interpreter used by hive_task_trace({ recovery: true }). Does not affect forensic (non-recovery) traces.',
    });
    expect(schema.$defs.taskTraceSummarizerConfig.description).toContain('temperature defaults to 0');
    expect(schema.properties.omoSlimEnabled).toBeUndefined();
    expect(schema.properties.agentMode.description).toContain('hive-master');
    expect(schema.properties.agentMode.description).toContain('architect-planner');
    expect(validateConfigShape({
      taskTraceSummarizer: { model: 'provider/model', variant: 'high', temperature: 0 },
    })).toBe(true);
    for (const invalid of [
      { taskTraceSummarizer: { model: '' } },
      { taskTraceSummarizer: { variant: ' ' } },
      { taskTraceSummarizer: { temperature: -1 } },
      { taskTraceSummarizer: { temperature: 3 } },
      { taskTraceSummarizer: { extra: true } },
    ]) {
      expect(validateConfigShape(invalid)).toBe(false);
    }
  });

  it('defines council as a documented global-only config section', () => {
    expect(schema.properties.council).toEqual({
      $ref: '#/$defs/councilConfig',
      description: 'Global council command group configuration.',
    });
    expect(schema.$defs.councilConfig).toBeDefined();
    expect(schema.$defs.councilGroupConfig).toBeDefined();
  });

  it('retains legacy global repository topology for one migration window', () => {
    expect(schema.properties.repositoryRoot.pattern).toBeDefined();
    expect(schema.properties.repositories.minItems).toBe(1);
    expect(schema.properties.repositoryRoot.description).toContain('Deprecated migration-only');
    expect(schema.properties.repositories.description).toContain('Deprecated migration-only');
    expect(schema.$defs.repositoryConfig.properties.path.description).toBe('Project-relative path to a git repository.');
    expect(schema.$defs.councilConfig.description).toBe('Global council command settings.');
  });

  it('validates the relevant global config contract through the published schema', () => {
    expect(validateConfigShape({
      agentMode: 'dedicated',
      hook_cadence: { 'chat.message': 1 },
      repositoryRoot: '/tmp/project',
      repositories: [{ id: 'api', path: './api' }],
    })).toBe(true);
    expect(validateConfigShape({
      omoSlimEnabled: true,
    })).toBe(false);

    for (const invalid of [
      { unknown: true },
      { hook_cadence: { 'chat.message': 0 } },
      { repositoryRoot: '/tmp/project', repositories: [] },
      { repositoryRoot: 'relative/project', repositories: [{ id: 'api', path: './api' }] },
      { repositoryRoot: '/tmp/project', repositories: [{ id: 'api', path: '/tmp/api' }] },
      { repositoryRoot: '/tmp/project', repositories: [{ id: 'api', path: '../api' }] },
      { repositoryRoot: '/tmp/project', repositories: [{ id: 'api', path: 'packages/../api' }] },
    ]) {
      expect(validateConfigShape(invalid)).toBe(false);
    }
  });

  it('accepts a valid default-like council shape', () => {
    expect(validateConfigShape({
      council: {
        defaultGroup: 'decision',
        maxMembers: 4,
        excludedAgents: ['hive-master', 'swarm-orchestrator', 'forager-worker', 'hive-builder', 'hive-helper'],
        groups: {
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
        },
      },
    })).toBe(true);
  });

  it('accepts partial global council overrides only when declared groups include members', () => {
    expect(validateConfigShape({
      council: {
        defaultGroup: 'documents',
        groups: {
          documents: {
            members: ['code-reviewer'],
          },
        },
      },
    })).toBe(true);

    expect(validateConfigShape({
      council: {
        groups: {
          documents: {
            description: 'missing members',
          },
        },
      },
    })).toBe(false);
  });

  it.each([
    { name: 'bad members', config: { council: { groups: { review: { members: [] } } } } },
    { name: 'bad maxMembers', config: { council: { maxMembers: 0 } } },
    { name: 'unknown top-level schema property', config: { unknown: true } },
  ])('rejects $name', ({ config }) => {
    expect(validateConfigShape(config)).toBe(false);
  });
});

describe('agent_hive.override schema contract', () => {
  it('only describes the narrow project model and variant overlay', () => {
    expect(projectOverrideSchema.properties).toHaveProperty('$schema');
    expect(Object.keys(projectOverrideSchema.properties).sort()).toEqual([
      '$schema',
      'agents',
      'customAgents',
    ]);
    expect(projectOverrideSchema.properties.agents.additionalProperties).toEqual({
      $ref: '#/$defs/agentModelVariantOverride',
    });
    expect(projectOverrideSchema.properties.customAgents.additionalProperties).toEqual({
      $ref: '#/$defs/agentModelVariantOverride',
    });
    expect(projectOverrideSchema.$defs.agentModelVariantOverride.additionalProperties).toBe(false);
    expect(projectOverrideSchema.$defs.agentModelVariantOverride.anyOf).toEqual([
      { required: ['model'] },
      { required: ['variant'] },
    ]);
  });

  it('agrees with the runtime validator for supported and rejected shapes', () => {
    const accepted = [
      {},
      { $schema: 'https://example.test/agent-hive.override.schema.json' },
      {
        agents: { 'not-a-built-in-name': { model: 'provider/model' } },
        customAgents: { 'not-a-global-custom-agent': { variant: 'high' } },
      },
      { agents: { 'known-agent': { model: 'provider/model', variant: 'high' } } },
    ];
    const rejected = [
      null,
      [],
      { agentMode: 'unified' },
      { agents: { 'known-agent': {} } },
      { agents: { 'known-agent': { model: '   ' } } },
      { agents: { 'known-agent': { variant: '  ' } } },
      { agents: { 'known-agent': { model: 'provider/model', temperature: 0.2 } } },
      { customAgents: { 'known-agent': { skills: ['verification'] } } },
    ];

    for (const value of accepted) {
      expect(validateProjectOverrideShape(value)).toBe(true);
      expect(acceptsRuntimeProjectOverride(value)).toBe(true);
    }
    for (const value of rejected) {
      expect(validateProjectOverrideShape(value)).toBe(false);
      expect(acceptsRuntimeProjectOverride(value)).toBe(false);
    }
  });
});
