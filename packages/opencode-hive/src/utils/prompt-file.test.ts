import { afterEach, describe, expect, it } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { isValidPromptFilePath, publishWorkerAssignment } from './prompt-file.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

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

describe('publishWorkerAssignment', () => {
  it('publishes one attempt-specific artifact without overwriting it', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-assignment-'));
    roots.push(root);
    const hiveDir = path.join(root, '.hive');
    fs.mkdirSync(path.join(hiveDir, 'features', 'feature', 'tasks', '01-task'), { recursive: true });

    const first = publishWorkerAssignment('feature', '01-task', 1, 'first bytes', hiveDir);

    expect(fs.readFileSync(first.path, 'utf8')).toBe('first bytes');
    expect(first.locator).toBe('.hive/features/feature/tasks/01-task/assignments/attempt-1.md');
    expect(first.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(() => publishWorkerAssignment('feature', '01-task', 1, 'replacement', hiveDir)).toThrow(/already exists/i);
    expect(fs.readFileSync(first.path, 'utf8')).toBe('first bytes');
  });

  it('does not expose a final artifact when publication is interrupted before the atomic link', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-assignment-'));
    roots.push(root);
    const hiveDir = path.join(root, '.hive');
    fs.mkdirSync(path.join(hiveDir, 'features', 'feature', 'tasks', '01-task'), { recursive: true });

    expect(() => publishWorkerAssignment('feature', '01-task', 2, 'bytes', hiveDir, {
      beforePublish: () => { throw new Error('interrupted'); },
    })).toThrow('interrupted');

    expect(fs.existsSync(path.join(hiveDir, 'features', 'feature', 'tasks', '01-task', 'assignments', 'attempt-2.md'))).toBe(false);
  });
});
