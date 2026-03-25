import { describe, expect, it } from 'bun:test';
import { minifyWorkerPromptDeterministic } from './index.js';

describe('minifyWorkerPromptDeterministic', () => {
  it('strips markdown emphasis outside protected spans', () => {
    expect(minifyWorkerPromptDeterministic('**CRITICAL** keep text')).toBe('CRITICAL keep text');
  });

  it('collapses excessive whitespace', () => {
    expect(minifyWorkerPromptDeterministic('a\n\n\n\tb  ')).toBe('a\n\n b');
  });

  it('rewrites only the Assignment Details table into a compact line block', () => {
    const before = [
      '## Assignment Details',
      '',
      '| Field | Value |',
      '|-------|-------|',
      '| Feature | demo |',
      '| Task | 01-test |',
    ].join('\n');
    const after = minifyWorkerPromptDeterministic(before);
    expect(after).toContain('feature:demo');
    expect(after).not.toContain('| Field | Value |');
  });

  it('does not rewrite user-authored tables outside Assignment Details', () => {
    const before = [
      '## Your Mission',
      '',
      '| Field | Value |',
      '|-------|-------|',
      '| Preserve | this table |',
    ].join('\n');
    expect(minifyWorkerPromptDeterministic(before)).toContain('| Field | Value |');
  });

  it('preserves user-authored Assignment Details section inside mission content', () => {
    const before = [
      '# Hive Worker Assignment',
      '',
      '## Assignment Details',
      '',
      '| Field | Value |',
      '|-------|-------|',
      '| Feature | template-owned |',
      '',
      '## Your Mission',
      '',
      '## Assignment Details',
      '',
      '| Field | Value |',
      '|-------|-------|',
      '| Preserve | this mission section |',
    ].join('\n');

    const after = minifyWorkerPromptDeterministic(before);
    expect(after).toContain('feature:template-owned');
    expect(after).toContain('## Your Mission\n\n## Assignment Details');
    expect(after).toContain('| Preserve | this mission section |');
  });

  it('does not restore protected placeholders from user-authored lookalike tokens', () => {
    const before = [
      'Literal token: __HIVE_PROMPT_MINIFY_PROTECTED_0__',
      '```ts',
      'const keep = "**value**";',
      '```',
    ].join('\n');

    const after = minifyWorkerPromptDeterministic(before);
    expect(after).toContain('Literal token: __HIVE_PROMPT_MINIFY_PROTECTED_0__');
    expect(after).toContain('```ts\nconst keep = "**value**";\n```');
  });

  it('preserves fenced code blocks byte-for-byte', () => {
    const before = '```ts\nconst x = "**keep**";\n```';
    expect(minifyWorkerPromptDeterministic(before)).toContain(before);
  });

  it('preserves inline literals and file references', () => {
    const before = '`hive_worktree_commit` `packages/opencode-hive/src/index.ts:379-432`';
    expect(minifyWorkerPromptDeterministic(before)).toBe(before);
  });

  it('handles prompts that include the blocked continuation section', () => {
    const before = '## Continuation from Blocked State\n\n**Previous Progress**: done';
    expect(minifyWorkerPromptDeterministic(before)).toContain('Continuation from Blocked State');
  });
});
