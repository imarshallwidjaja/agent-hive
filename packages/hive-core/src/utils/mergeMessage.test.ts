import { describe, expect, it } from 'bun:test';
import { selectMergeCommitMessage } from './mergeMessage.js';

const fallback = 'feat: integrate task work';

describe('selectMergeCommitMessage', () => {
  it('uses explicit message when provided and trims/sanitizes', () => {
    const result = selectMergeCommitMessage({
      explicitMessage: '  feat: explicit subject\n\nExplicit body.\r\n',
      commits: [{ hash: 'abc1234', message: 'ignored' }],
      fallbackMessage: fallback,
      strategy: 'squash',
    });

    expect(result.source).toBe('explicit');
    expect(result.message).toBe('feat: explicit subject\n\nExplicit body.');
  });

  it('omits whitespace-only explicit message and derives instead', () => {
    const result = selectMergeCommitMessage({
      explicitMessage: '   \n\t  ',
      commits: [{ hash: 'abc1234', message: 'feat: derived subject' }],
      fallbackMessage: fallback,
      strategy: 'merge',
    });

    expect(result.source).toBe('derived');
    expect(result.message).toBe('feat: derived subject');
  });

  it('derives subject only for a single commit with body', () => {
    const result = selectMergeCommitMessage({
      commits: [
        {
          hash: 'deadbeef',
          message: 'feat: one commit subject',
          body: 'Body that must not leak into merge message.',
        },
      ],
      fallbackMessage: fallback,
      strategy: 'squash',
    });

    expect(result.source).toBe('derived');
    expect(result.message).toBe('feat: one commit subject');
  });

  it('derives multi-commit squash message with squashed heading and short hashes', () => {
    const result = selectMergeCommitMessage({
      commits: [
        { hash: '1111111', message: 'feat: first change' },
        { hash: '2222222', message: 'fix: second change' },
      ],
      fallbackMessage: fallback,
      strategy: 'squash',
    });

    expect(result.source).toBe('derived');
    expect(result.message).toBe(
      'feat: first change\n\nSquashed commits:\n- 1111111 feat: first change\n- 2222222 fix: second change',
    );
  });

  it('derives multi-commit merge message with merged heading and short hashes', () => {
    const result = selectMergeCommitMessage({
      commits: [
        { hash: 'aaaaaaaaaaaa', message: 'feat: alpha' },
        { hash: 'bbbbbbbbbbbb', message: 'fix: beta' },
      ],
      fallbackMessage: fallback,
      strategy: 'merge',
    });

    expect(result.source).toBe('derived');
    expect(result.message).toBe(
      'feat: alpha\n\nMerged commits:\n- aaaaaaa feat: alpha\n- bbbbbbb fix: beta',
    );
  });

  it('uses fallback when no commit has a usable subject', () => {
    const result = selectMergeCommitMessage({
      commits: [{ hash: 'abc1234', message: '   ' }],
      fallbackMessage: '  fallback subject  ',
      strategy: 'merge',
    });

    expect(result.source).toBe('fallback');
    expect(result.message).toBe('fallback subject');
  });

  it('caps overly long messages', () => {
    const longSubject = `feat: ${'x'.repeat(20000)}`;
    const result = selectMergeCommitMessage({
      explicitMessage: longSubject,
      commits: [],
      fallbackMessage: fallback,
      strategy: 'squash',
    });

    expect(result.source).toBe('explicit');
    expect(result.message.length).toBeLessThanOrEqual(12000);
    expect(result.message).toBe(longSubject.slice(0, 12000).trimEnd());
  });
});