import { describe, expect, it } from 'bun:test';
import * as path from 'path';
import { isValidPromptFilePath } from './prompt-file.js';

describe('isValidPromptFilePath', () => {
  it('allows paths within workspace regardless of casing on windows', () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', {
      value: 'win32',
      configurable: true,
    });
    try {
      const workspaceRoot = path.join('C:', 'Repo', 'Project');
      const filePath = path.join('c:', 'repo', 'project', '.hive', 'prompt.md');
      expect(isValidPromptFilePath(filePath, workspaceRoot)).toBe(true);
    } finally {
      Object.defineProperty(process, 'platform', {
        value: originalPlatform,
        configurable: true,
      });
    }
  });

  it('rejects paths outside the workspace on windows', () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', {
      value: 'win32',
      configurable: true,
    });
    try {
      const workspaceRoot = path.join('C:', 'Repo', 'Project');
      const filePath = path.join('c:', 'other', 'project', '.hive', 'prompt.md');
      expect(isValidPromptFilePath(filePath, workspaceRoot)).toBe(false);
    } finally {
      Object.defineProperty(process, 'platform', {
        value: originalPlatform,
        configurable: true,
      });
    }
  });

  it('honors case-sensitive comparisons on non-windows platforms', () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', {
      value: 'linux',
      configurable: true,
    });
    try {
      const workspaceRoot = path.join('/Repo', 'Project');
      const filePath = path.join('/repo', 'project', '.hive', 'prompt.md');
      expect(isValidPromptFilePath(filePath, workspaceRoot)).toBe(false);
    } finally {
      Object.defineProperty(process, 'platform', {
        value: originalPlatform,
        configurable: true,
      });
    }
  });
});
