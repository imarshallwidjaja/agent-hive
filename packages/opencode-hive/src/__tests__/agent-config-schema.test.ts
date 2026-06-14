import { describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

const schemaPath = path.resolve(import.meta.dir, '..', '..', 'schema', 'agent_hive.schema.json');
const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf-8')) as Record<string, any>;

const validateConfigShape = (config: Record<string, any>): boolean => {
  if (Object.keys(config).some((key) => !Object.hasOwn(schema.properties, key))) {
    return false;
  }

  const council = config.council;
  if (council === undefined) {
    return true;
  }
  if (council === null || typeof council !== 'object' || Array.isArray(council)) {
    return false;
  }
  if (council.defaultGroup !== undefined && typeof council.defaultGroup !== 'string') {
    return false;
  }
  if (council.maxMembers !== undefined && (!Number.isInteger(council.maxMembers) || council.maxMembers < 1)) {
    return false;
  }
  if (council.excludedAgents !== undefined && (!Array.isArray(council.excludedAgents) || council.excludedAgents.some((agent: unknown) => typeof agent !== 'string'))) {
    return false;
  }
  if (council.groups === undefined) {
    return true;
  }
  if (council.groups === null || typeof council.groups !== 'object' || Array.isArray(council.groups)) {
    return false;
  }

  return Object.values(council.groups).every((group) => {
    if (group === null || typeof group !== 'object' || Array.isArray(group)) {
      return false;
    }

    const declaration = group as Record<string, unknown>;
    return Array.isArray(declaration.members)
      && declaration.members.length > 0
      && declaration.members.every((member) => typeof member === 'string')
      && (declaration.description === undefined || typeof declaration.description === 'string')
      && (declaration.maxMembers === undefined || (typeof declaration.maxMembers === 'number' && Number.isInteger(declaration.maxMembers) && declaration.maxMembers >= 1));
  });
};

const expectReservedNameToFail = (name: string): void => {
  const reservedNames = schema.properties?.customAgents?.propertyNames?.not?.enum;
  expect(Array.isArray(reservedNames)).toBe(true);
  expect(reservedNames).toContain(name);
};

describe('agent_hive schema customAgents contract', () => {
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
    ]);
  });

  it('allows hive-builder as a built-in agent config key', () => {
    expect(schema.properties.agents.properties).toHaveProperty('hive-builder');
    expect(schema.properties.agents.properties['hive-builder']).toEqual({
      $ref: '#/$defs/agentConfig',
      description: 'Hive Builder (ad-hoc executor)',
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
});

describe('agent_hive schema council contract', () => {
  it('defines council as a documented global-only config section', () => {
    expect(schema.properties.council).toEqual({
      $ref: '#/$defs/councilConfig',
      description: 'Global council command group configuration. Read from the global user config; structurally valid project-local values are ignored by runtime config resolution, while malformed project-local values make the project config invalid before they can be ignored.',
    });
    expect(schema.$defs.councilConfig).toBeDefined();
    expect(schema.$defs.councilGroupConfig).toBeDefined();
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
