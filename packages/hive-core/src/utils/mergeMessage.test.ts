import { describe, expect, it } from 'bun:test';
import { normalizeCommitMessage } from './mergeMessage.js';

describe('normalizeCommitMessage', () => {
  it('accepts a one-line subject, blank separator, and non-empty body', () => {
    expect(normalizeCommitMessage('feat: preserve history\n\nExplain why the history policy changed.')).toBe(
      'feat: preserve history\n\nExplain why the history policy changed.',
    );
  });

  for (const message of [
    '',
    'feat: subject only',
    'feat: subject\nbody without separator',
    'feat: subject\n\n   ',
    '\n\nbody without subject',
  ]) {
    it(`rejects malformed message ${JSON.stringify(message)}`, () => {
      expect(() => normalizeCommitMessage(message)).toThrow(/subject.*blank line.*body/i);
    });
  }

  it('rejects an omitted aggregate message instead of deriving one', () => {
    expect(() => normalizeCommitMessage(undefined)).toThrow(/subject.*blank line.*body/i);
  });

  it('does not truncate a structurally valid long message', () => {
    const message = `feat: long aggregate\n\n${'x'.repeat(14000)}`;

    expect(normalizeCommitMessage(message)).toBe(message);
  });
});
