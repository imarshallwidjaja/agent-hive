import { describe, expect, it } from 'bun:test';
import Ajv2020 from 'ajv/dist/2020.js';
import * as fs from 'node:fs';
import * as path from 'node:path';

const schemaPath = path.resolve(import.meta.dir, '..', '..', 'schema', 'agent_hive.schema.json');
const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf-8')) as Record<string, any>;
const packageJsonPath = path.resolve(import.meta.dir, '..', '..', 'package.json');
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8')) as { peerDependencies?: Record<string, string> };

const validateConfigShape = new Ajv2020({ strict: false }).compile(schema);

const expectReservedNameToFail = (name: string): void => {
  const reservedNames = schema.properties?.customAgents?.propertyNames?.not?.enum;
  expect(Array.isArray(reservedNames)).toBe(true);
  expect(reservedNames).toContain(name);
};

describe('agent_hive schema customAgents contract', () => {
  it('requires the verified OpenCode command hook runtime', () => {
    expect(packageJson.peerDependencies?.['@opencode-ai/plugin']).toBe('>=1.14.48');
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

  it('keeps dash-reviewer exclusively available to existing custom agents', () => {
    const reservedNames = schema.properties?.customAgents?.propertyNames?.not?.enum;

    expect(reservedNames).not.toContain('dash-reviewer');
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
      omoSlimEnabled: true,
      hook_cadence: { 'chat.message': 1 },
      repositoryRoot: '/tmp/project',
      repositories: [{ id: 'api', path: './api' }],
    })).toBe(true);

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
