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
    expect(HIVE_SYSTEM_PROMPT).toContain('Inspect the descriptions and input schemas of tools exposed to this agent');
    expect(HIVE_SYSTEM_PROMPT).toContain('Choose the narrowest existing tool');
    expect(HIVE_SYSTEM_PROMPT).toContain('Local text or content search');
    expect(HIVE_SYSTEM_PROMPT).toContain('Syntax-aware structural search or AST/pattern inspection');
    expect(HIVE_SYSTEM_PROMPT).toContain('Official current or version-relevant library/API documentation');
    expect(HIVE_SYSTEM_PROMPT).toContain('Public source-code examples from other repositories');
    expect(HIVE_SYSTEM_PROMPT).toContain('General web discovery or current information');
    expect(HIVE_SYSTEM_PROMPT).toContain('Direct retrieval of a known URL');
    expect(HIVE_SYSTEM_PROMPT).toContain('Interactive rendered or stateful browser work');
    expect(HIVE_SYSTEM_PROMPT).toContain('Establish repository behavior from local source and executed checks');
    expect(HIVE_SYSTEM_PROMPT).toContain('public code examples as usage evidence, not API authority');
    expect(HIVE_SYSTEM_PROMPT).toContain('A broader capability is not an automatic substitute');
    expect(HIVE_SYSTEM_PROMPT).toContain('report the missing capability and what cannot be established or completed');
    expect(HIVE_SYSTEM_PROMPT).toContain('Use only capabilities already exposed to this agent');
    expect(HIVE_SYSTEM_PROMPT).toContain('Do not install, configure, or enable tools');
  });
});
