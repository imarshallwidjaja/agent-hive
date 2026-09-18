import { describe, expect, it } from 'bun:test';
import { HIVE_SYSTEM_PROMPT } from './system-hook.js';

describe('HIVE_SYSTEM_PROMPT', () => {
  it('keeps execution lifecycle instructions scoped to current tools', () => {
    expect(HIVE_SYSTEM_PROMPT).not.toMatch(/use hive_status to check feature state before starting work/i);
    expect(HIVE_SYSTEM_PROMPT).not.toMatch(/use hive_plan_read to see plan comments/i);
    expect(HIVE_SYSTEM_PROMPT).not.toMatch(/hive_execution_finish|hive_merge|hive_worktree_commit/);
  });

  it('states the native task delegation boundary', () => {
    expect(HIVE_SYSTEM_PROMPT).toContain('`hive-master`, `swarm-orchestrator`, and `hive-builder` are primary-only');
    expect(HIVE_SYSTEM_PROMPT).toContain('`architect-planner` is the planning-only exception');
    expect(HIVE_SYSTEM_PROMPT).toContain('one layer of permitted read-only planning helpers');
    expect(HIVE_SYSTEM_PROMPT).toContain('every other subagent are terminal');
  });
});
