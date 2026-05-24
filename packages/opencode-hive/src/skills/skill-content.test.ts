import { describe, it, expect } from 'bun:test';
import { BUILTIN_SKILLS } from './registry.generated.js';

describe('skill content', () => {
  it('bundles the ast-grep skill with the upstream tool surface', () => {
    const skill = BUILTIN_SKILLS.find((entry) => entry.name === 'ast-grep');

    expect(skill).toBeDefined();
    expect(skill!.template).toContain('ast_grep_dump_syntax_tree');
    expect(skill!.template).toContain('ast_grep_test_match_code_rule');
    expect(skill!.template).toContain('ast_grep_find_code');
    expect(skill!.template).toContain('ast_grep_find_code_by_rule');
    expect(skill!.template).not.toContain('ast_grep_search');
    expect(skill!.template).not.toContain('ast_grep_replace');
  });

  it('documents overview-first execution truth in writing-plans', () => {
    const skill = BUILTIN_SKILLS.find((entry) => entry.name === 'writing-plans');

    expect(skill).toBeDefined();
    expect(skill!.template).toContain('context/overview.md');
    expect(skill!.template).toContain('human-facing review surface');
    expect(skill!.template).toContain('plan.md` remains execution truth');
    expect(skill!.template).toContain('Design Summary');
    expect(skill!.template).not.toContain('Treat `plan.md` as the human-facing review surface and execution truth');
  });

  it('documents task() fan-out paths for parallel-exploration', () => {
    const skill = BUILTIN_SKILLS.find((entry) => entry.name === 'parallel-exploration');

    expect(skill).toBeDefined();
    expect(skill!.template).toContain('task({');
    expect(skill!.template).toContain(
      'Parallelize by issuing multiple task() calls in the same assistant message.'
    );
    expect(skill!.template).toContain('fit in one context window');
    expect(skill!.template).toContain('return to Hive');
    expect(skill!.template).toContain('one more fan-out would broaden scope too far');
  });

  it('includes task() parallel guidance for dispatching-parallel-agents', () => {
    const skill = BUILTIN_SKILLS.find((entry) => entry.name === 'dispatching-parallel-agents');

    expect(skill).toBeDefined();
    expect(skill!.template).toContain('task({');
    expect(skill!.template).toContain(
      'Parallelize by issuing multiple task() calls in the same assistant message.'
    );
  });

  it('bundles background-delegation with env-gated task_status guidance', () => {
    const skill = BUILTIN_SKILLS.find((entry) => entry.name === 'background-delegation');

    expect(skill).toBeDefined();
    expect(skill!.description).toContain('Agent Hive');
    expect(skill!.template).toContain('OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS');
    expect(skill!.template).toContain('OPENCODE_EXPERIMENTAL');
    expect(skill!.template).toContain('task({ background: true');
    expect(skill!.template).toContain('task_status({ task_id');
    expect(skill!.template).toContain('wait: false');
    expect(skill!.template).toContain('wait: true');
    expect(skill!.template).toContain('timeout_ms');
    expect(skill!.template).toContain('normal blocking `task()` remains the default');
    expect(skill!.template).toContain('Do not call `task()` from subagents');
    expect(skill!.template).not.toContain('@explorer');
    expect(skill!.template).not.toContain('subtask');
    expect(skill!.template).not.toContain('tmux');
    expect(skill!.template).not.toContain('zellij');
    expect(skill!.template).not.toContain('hive_background_task');
    expect(skill!.template).not.toContain('hive_background_output');
  });

  it('bundled skill content does not contain removed Hive skill tool references', () => {
    const removedHiveSkillTool = ['hive', 'skill'].join('_');

    for (const entry of BUILTIN_SKILLS) {
      expect(entry.template).not.toContain(removedHiveSkillTool);
    }
  });

  it('scopes only Hive-tool workflow skill descriptions to Agent Hive', () => {
    const hiveToolPattern = /\bhive_[a-zA-Z0-9_]+\b/;

    for (const entry of BUILTIN_SKILLS) {
      if (hiveToolPattern.test(entry.template)) {
        expect(entry.description).toContain('Agent Hive');
        continue;
      }

      expect(entry.description).not.toContain('Agent Hive workflow skill');
    }
  });
});
