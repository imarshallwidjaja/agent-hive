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

  it('requires exact independent skill loads for explicit operator requirements', () => {
    expect(HIVE_SYSTEM_PROMPT).toContain('explicitly names a skill');
    expect(HIVE_SYSTEM_PROMPT).toContain('spans phases, turns, or delegated assignments');
    expect(HIVE_SYSTEM_PROMPT).toContain('Each child, including advisors, reviewers, and custom overlays');
    expect(HIVE_SYSTEM_PROMPT).toContain('A parent or sibling load does not count');
    expect(HIVE_SYSTEM_PROMPT).toContain('stop-design-slop and stop-slop are distinct');
    expect(HIVE_SYSTEM_PROMPT).toContain('there is no blanket all-skills autoload');
  });

  it('defines the shared capability-based tool contract', () => {
    // Selection: the exposed definition fixes availability and syntax, and access never widens authority.
    expect(HIVE_SYSTEM_PROMPT).toContain('Select an exposed tool whose documented capability, evidence source, and permitted effects fit the assignment');
    expect(HIVE_SYSTEM_PROMPT).toContain('The exposed description and input schema determine availability and syntax');
    expect(HIVE_SYSTEM_PROMPT).toContain('Tool access does not widen the role, permission, or assignment boundaries');
    // Evidence suitability: each claim kind names the source that can establish it.
    expect(HIVE_SYSTEM_PROMPT).toContain('Ground repository claims in local source and executed checks');
    expect(HIVE_SYSTEM_PROMPT).toContain('first-party documentation for the relevant version');
    expect(HIVE_SYSTEM_PROMPT).toContain('Public code examples show usage, not API authority');
    expect(HIVE_SYSTEM_PROMPT).toContain('A text match does not prove a structural invariant');
    expect(HIVE_SYSTEM_PROMPT).toContain('interactive browsing only for rendered state, forms, downloads, or user-like interaction');
    // Missing capability stays visible and is never recreated.
    expect(HIVE_SYSTEM_PROMPT).toContain('report the missing capability and what cannot be established');
    expect(HIVE_SYSTEM_PROMPT).toContain('continue only independent authorized work');
    expect(HIVE_SYSTEM_PROMPT).toContain('Do not install, configure, or enable tools');
    expect(HIVE_SYSTEM_PROMPT).toContain('recreate a missing capability with shell commands, scripts, or ad hoc network requests');
  });
});
