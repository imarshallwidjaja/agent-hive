import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { ConfigService } from 'hive-core';
import { shouldExecuteHook, HIVE_SYSTEM_PROMPT } from '../hooks/system-hook.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const PRIMARY_HOOK = 'chat.message';
const SECONDARY_HOOK = 'experimental.chat.messages.transform';

describe('Hook Cadence Logic', () => {
  let configService: ConfigService;
  let configPath: string;
  let turnCounters: Record<string, number>;
  let tempDir: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    // Save original HOME
    originalHome = process.env.HOME;

    // Create a temporary config directory for testing
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-test-'));
    const configDir = path.join(tempDir, '.config', 'opencode');
    fs.mkdirSync(configDir, { recursive: true });
    configPath = path.join(configDir, 'agent_hive.json');

    // Override HOME for ConfigService
    process.env.HOME = tempDir;
    configService = new ConfigService();

    // Reset turn counters
    turnCounters = {};
  });

  afterEach(() => {
    // Restore original HOME
    if (originalHome !== undefined) {
      process.env.HOME = originalHome;
    } else {
      delete process.env.HOME;
    }

    // Clean up temp directory
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (err) {
      // Ignore cleanup errors in tests
    }
  });

  // Thin wrapper so existing tests don't need to change their call signature
  const callShouldExecute = (hookName: string, options?: { safetyCritical?: boolean }): boolean => {
    return shouldExecuteHook(hookName, configService, turnCounters, options);
  };

  describe('Default behavior (no config)', () => {
    it('fires every turn when hook_cadence is not configured', () => {
      const results: boolean[] = [];
      for (let i = 0; i < 10; i++) {
        results.push(callShouldExecute(PRIMARY_HOOK));
      }
      expect(results).toEqual([true, true, true, true, true, true, true, true, true, true]);
    });
  });

  describe('Cadence = 1 (every turn)', () => {
    beforeEach(() => {
      fs.writeFileSync(
        configPath,
        JSON.stringify({
          hook_cadence: {
            [PRIMARY_HOOK]: 1,
          },
        })
      );
    });

    it('fires every turn', () => {
      const results: boolean[] = [];
      for (let i = 0; i < 10; i++) {
        results.push(callShouldExecute(PRIMARY_HOOK));
      }
      expect(results).toEqual([true, true, true, true, true, true, true, true, true, true]);
    });
  });

  describe('Cadence = 3 (every 3rd turn)', () => {
    beforeEach(() => {
      fs.writeFileSync(
        configPath,
        JSON.stringify({
          hook_cadence: {
            [PRIMARY_HOOK]: 3,
          },
        })
      );
    });

    it('fires on turns 1, 4, 7, 10', () => {
      const results: boolean[] = [];
      for (let i = 0; i < 10; i++) {
        results.push(callShouldExecute(PRIMARY_HOOK));
      }
      expect(results).toEqual([
        true,  // turn 1
        false, // turn 2
        false, // turn 3
        true,  // turn 4
        false, // turn 5
        false, // turn 6
        true,  // turn 7
        false, // turn 8
        false, // turn 9
        true,  // turn 10
      ]);
    });
  });

  describe('Cadence = 5 (every 5th turn)', () => {
    beforeEach(() => {
      fs.writeFileSync(
        configPath,
        JSON.stringify({
          hook_cadence: {
            [PRIMARY_HOOK]: 5,
          },
        })
      );
    });

    it('fires on turns 1, 6, 11', () => {
      const results: boolean[] = [];
      for (let i = 0; i < 12; i++) {
        results.push(callShouldExecute(PRIMARY_HOOK));
      }
      expect(results).toEqual([
        true,  // turn 1
        false, // turn 2
        false, // turn 3
        false, // turn 4
        false, // turn 5
        true,  // turn 6
        false, // turn 7
        false, // turn 8
        false, // turn 9
        false, // turn 10
        true,  // turn 11
        false, // turn 12
      ]);
    });
  });

  describe('Edge cases', () => {
    it('defaults to cadence=1 for cadence=0', () => {
      fs.writeFileSync(
        configPath,
        JSON.stringify({
          hook_cadence: {
            [PRIMARY_HOOK]: 0,
          },
        })
      );

      const results: boolean[] = [];
      for (let i = 0; i < 5; i++) {
        results.push(callShouldExecute(PRIMARY_HOOK));
      }
      expect(results).toEqual([true, true, true, true, true]);
    });

    it('defaults to cadence=1 for negative cadence', () => {
      fs.writeFileSync(
        configPath,
        JSON.stringify({
          hook_cadence: {
            [PRIMARY_HOOK]: -3,
          },
        })
      );

      const results: boolean[] = [];
      for (let i = 0; i < 5; i++) {
        results.push(callShouldExecute(PRIMARY_HOOK));
      }
      expect(results).toEqual([true, true, true, true, true]);
    });

    it('defaults to cadence=1 for non-integer cadence', () => {
      fs.writeFileSync(
        configPath,
        JSON.stringify({
          hook_cadence: {
            [PRIMARY_HOOK]: 2.5,
          },
        })
      );

      const results: boolean[] = [];
      for (let i = 0; i < 5; i++) {
        results.push(callShouldExecute(PRIMARY_HOOK));
      }
      expect(results).toEqual([true, true, true, true, true]);
    });
  });

  describe('Safety-critical hooks', () => {
    beforeEach(() => {
      fs.writeFileSync(
        configPath,
        JSON.stringify({
          hook_cadence: {
            'tool.execute.before': 5,
          },
        })
      );
    });

    it('enforces cadence=1 when safetyCritical flag is set', () => {
      const results: boolean[] = [];
      for (let i = 0; i < 10; i++) {
        results.push(callShouldExecute('tool.execute.before', { safetyCritical: true }));
      }
      expect(results).toEqual([true, true, true, true, true, true, true, true, true, true]);
    });
  });

  describe('Multiple hooks with independent counters', () => {
    beforeEach(() => {
      fs.writeFileSync(
        configPath,
        JSON.stringify({
          hook_cadence: {
            [PRIMARY_HOOK]: 3,
            [SECONDARY_HOOK]: 2,
          },
        })
      );
    });

    it('maintains separate turn counters for each hook', () => {
      const primaryResults: boolean[] = [];
      const secondaryResults: boolean[] = [];

      for (let i = 0; i < 6; i++) {
        primaryResults.push(callShouldExecute(PRIMARY_HOOK));
        secondaryResults.push(callShouldExecute(SECONDARY_HOOK));
      }

      // chat.message with cadence=3: fires on turns 1, 4
      expect(primaryResults).toEqual([true, false, false, true, false, false]);

      // experimental.chat.messages.transform with cadence=2: fires on turns 1, 3, 5
      expect(secondaryResults).toEqual([true, false, true, false, true, false]);
    });
  });

  describe('ConfigService.getHookCadence', () => {
    it('returns 1 when hook_cadence is not configured', () => {
      expect(configService.getHookCadence(PRIMARY_HOOK)).toBe(1);
    });

    it('returns configured cadence value', () => {
      fs.writeFileSync(
        configPath,
        JSON.stringify({
          hook_cadence: {
            [PRIMARY_HOOK]: 5,
          },
        })
      );

      // Need to create a new ConfigService to pick up the new config
      configService = new ConfigService();
      expect(configService.getHookCadence(PRIMARY_HOOK)).toBe(5);
    });

    it('returns 1 for unconfigured hooks even when hook_cadence exists', () => {
      fs.writeFileSync(
        configPath,
        JSON.stringify({
          hook_cadence: {
            [PRIMARY_HOOK]: 3,
          },
        })
      );

      configService = new ConfigService();
      expect(configService.getHookCadence(SECONDARY_HOOK)).toBe(1);
    });
  });

  describe('Error handling', () => {
    it('handles malformed JSON config gracefully', () => {
      fs.writeFileSync(configPath, '{ invalid json }');

      // ConfigService should fall back to defaults
      configService = new ConfigService();
      expect(configService.getHookCadence(PRIMARY_HOOK)).toBe(1);
    });

    it('handles missing config file gracefully', () => {
      // Don't create config file
      configService = new ConfigService();
      expect(configService.getHookCadence(PRIMARY_HOOK)).toBe(1);
    });

    it('handles config with null hook_cadence', () => {
      fs.writeFileSync(
        configPath,
        JSON.stringify({
          hook_cadence: null,
        })
      );

      configService = new ConfigService();
      expect(configService.getHookCadence(PRIMARY_HOOK)).toBe(1);
    });

    it('defaults to cadence=1 when config service is unavailable', () => {
      const results: boolean[] = [];
      for (let i = 0; i < 5; i++) {
        results.push(shouldExecuteHook(PRIMARY_HOOK, undefined, turnCounters));
      }
      expect(results).toEqual([true, true, true, true, true]);
    });

    it('uses fallback counters when turn counters are unavailable', () => {
      const results: boolean[] = [];
      for (let i = 0; i < 5; i++) {
        results.push(shouldExecuteHook(PRIMARY_HOOK, configService, undefined));
      }
      expect(results).toEqual([true, true, true, true, true]);
    });
  });

  describe('Concurrent hook execution', () => {
    beforeEach(() => {
      fs.writeFileSync(
        configPath,
        JSON.stringify({
          hook_cadence: {
            'hook.a': 2,
            'hook.b': 3,
            'hook.c': 5,
          },
        })
      );
    });

    it('maintains independent counters when hooks are called concurrently', () => {
      // Simulate multiple hooks being called in the same turn
      const results: Array<{ turn: number; hookA: boolean; hookB: boolean; hookC: boolean }> = [];
      for (let turn = 0; turn < 10; turn++) {
        results.push({
          turn: turn + 1,
          hookA: callShouldExecute('hook.a'),
          hookB: callShouldExecute('hook.b'),
          hookC: callShouldExecute('hook.c'),
        });
      }

      // Verify each hook follows its own cadence pattern
      expect(results[0]).toEqual({ turn: 1, hookA: true, hookB: true, hookC: true });
      expect(results[1]).toEqual({ turn: 2, hookA: false, hookB: false, hookC: false });
      expect(results[2]).toEqual({ turn: 3, hookA: true, hookB: false, hookC: false });
      expect(results[3]).toEqual({ turn: 4, hookA: false, hookB: true, hookC: false });
      expect(results[4]).toEqual({ turn: 5, hookA: true, hookB: false, hookC: false });
      expect(results[5]).toEqual({ turn: 6, hookA: false, hookB: false, hookC: true });
    });
  });
});

describe('HIVE_SYSTEM_PROMPT — no broad worker-startup reinjection', () => {
  it('does not contain a broad startup mandate to call hive_status', () => {
    expect(HIVE_SYSTEM_PROMPT).not.toMatch(/use hive_status to check feature state before starting work/i);
  });

  it('does not contain a broad startup mandate to call hive_plan_read unconditionally', () => {
    expect(HIVE_SYSTEM_PROMPT).not.toMatch(/use hive_plan_read to see plan comments/i);
  });

  it('separates primary finalization from merge', () => {
    expect(HIVE_SYSTEM_PROMPT).toMatch(/hive_execution_finish/);
    expect(HIVE_SYSTEM_PROMPT).toMatch(/hive_merge/);
    expect(HIVE_SYSTEM_PROMPT).not.toMatch(/hive_worktree_commit/);
  });

  it('states which orchestrators are never native task targets', () => {
    expect(HIVE_SYSTEM_PROMPT).toContain('`hive-master`, `swarm-orchestrator`, and `hive-builder` are primary-only');
    expect(HIVE_SYSTEM_PROMPT).toContain('`architect-planner` remains callable as a child');
  });
});
