import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'fs';
import * as path from 'path';

describe('tools template', () => {
  it('documents task vs hive mode delegation', () => {
    const toolsTemplatePath = path.resolve(
      import.meta.dir,
      '..',
      '..',
      'templates',
      'context',
      'tools.md'
    );
    const toolsTemplate = readFileSync(toolsTemplatePath, 'utf-8');

    expect(toolsTemplate).toContain('In task mode, use task()');
    expect(toolsTemplate).toContain('background-delegation');
    expect(toolsTemplate).toContain('native completion notification');
    expect(toolsTemplate).toContain('hive_background_status');
    expect(toolsTemplate).toContain('hive_background_reconcile');
    expect(toolsTemplate).toContain('hive_background_cancel');
    expect(toolsTemplate).toContain('primary-agent-only');
    expect(toolsTemplate).toContain('Cancellation is not rollback');
    expect(toolsTemplate).toContain('wait_for_native_completion_notification');
    expect(toolsTemplate).toContain('Do not edit `.hive/background-jobs.json` directly');
    expect(toolsTemplate).toContain('archives it from normal status');
    expect(toolsTemplate).not.toContain('task_status');
    expect(toolsTemplate).not.toContain('hive_background_task');
    expect(toolsTemplate).not.toContain('hive_background_output');
  });

  it('documents the upstream ast-grep MCP tools', () => {
    const toolsTemplatePath = path.resolve(
      import.meta.dir,
      '..',
      '..',
      'templates',
      'context',
      'tools.md'
    );
    const toolsTemplate = readFileSync(toolsTemplatePath, 'utf-8');

    expect(toolsTemplate).toContain('ast_grep_dump_syntax_tree');
    expect(toolsTemplate).toContain('ast_grep_test_match_code_rule');
    expect(toolsTemplate).toContain('ast_grep_find_code');
    expect(toolsTemplate).toContain('ast_grep_find_code_by_rule');
    expect(toolsTemplate).not.toContain('ast_grep_search');
    expect(toolsTemplate).not.toContain('ast_grep_replace');
  });
});
