/**
 * Tests for OpenCode skill file loader.
 *
 * Tests loading skills from project and user directories.
 */

import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { loadOpencodeSkill } from './opencode.js';

// Create a temp directory for test files
let tempDir: string;
let projectRoot: string;
let userConfigDir: string;
let originalHome: string | undefined;
let originalUserProfile: string | undefined;

beforeEach(() => {
  // Create temp directory structure
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-skill-test-'));
  projectRoot = path.join(tempDir, 'project');
  userConfigDir = path.join(tempDir, 'home');
  
  // Create directories
  fs.mkdirSync(path.join(projectRoot, '.opencode', 'skill'), { recursive: true });
  fs.mkdirSync(path.join(userConfigDir, '.config', 'opencode', 'skill'), { recursive: true });
  
  // Save original env vars
  originalHome = process.env.HOME;
  originalUserProfile = process.env.USERPROFILE;
  
  // Set HOME to our test directory
  process.env.HOME = userConfigDir;
  delete process.env.USERPROFILE;
});

afterEach(() => {
  // Restore env vars
  if (originalHome !== undefined) {
    process.env.HOME = originalHome;
  } else {
    delete process.env.HOME;
  }
  if (originalUserProfile !== undefined) {
    process.env.USERPROFILE = originalUserProfile;
  } else {
    delete process.env.USERPROFILE;
  }
  
  // Clean up temp directory
  fs.rmSync(tempDir, { recursive: true, force: true });
});

// ============================================================================
// Helper to write skill files
// ============================================================================

function writeSkillFile(dir: string, skillId: string, content: string): void {
  const skillDir = path.join(dir, skillId);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), content);
}

function writeProjectSkill(skillId: string, content: string): void {
  writeSkillFile(path.join(projectRoot, '.opencode', 'skill'), skillId, content);
}

function writeUserSkill(skillId: string, content: string): void {
  writeSkillFile(path.join(userConfigDir, '.config', 'opencode', 'skill'), skillId, content);
}

// ============================================================================
// Basic loading tests
// ============================================================================

describe('loadOpencodeSkill', () => {
  describe('basic loading', () => {
    it('loads a valid skill from project directory', () => {
      const skillContent = `---
name: my-skill
description: A test skill
---
This is the skill template content.

It can have multiple lines.`;

      writeProjectSkill('my-skill', skillContent);

      const result = loadOpencodeSkill('my-skill', { projectRoot });

      expect(result.found).toBe(true);
      expect(result.skill?.name).toBe('my-skill');
      expect(result.skill?.description).toBe('A test skill');
      expect(result.skill?.template).toBe('This is the skill template content.\n\nIt can have multiple lines.');
    });

    it('loads a valid skill from user directory', () => {
      const skillContent = `---
name: user-skill
description: User-level skill
---
User skill template.`;

      writeUserSkill('user-skill', skillContent);

      const result = loadOpencodeSkill('user-skill', { projectRoot });

      expect(result.found).toBe(true);
      expect(result.skill?.name).toBe('user-skill');
      expect(result.skill?.description).toBe('User-level skill');
      expect(result.skill?.template).toBe('User skill template.');
    });

    it('prefers project skill over user skill', () => {
      writeProjectSkill('shared-skill', `---
name: shared-skill
description: Project version
---
Project template.`);

      writeUserSkill('shared-skill', `---
name: shared-skill
description: User version
---
User template.`);

      const result = loadOpencodeSkill('shared-skill', { projectRoot });

      expect(result.found).toBe(true);
      expect(result.skill?.description).toBe('Project version');
      expect(result.skill?.template).toBe('Project template.');
    });

    it('returns found: false for missing skill', () => {
      const result = loadOpencodeSkill('nonexistent-skill', { projectRoot });

      expect(result.found).toBe(false);
      expect(result.skill).toBeUndefined();
    });
  });

  // ============================================================================
  // Frontmatter parsing tests
  // ============================================================================

  describe('frontmatter parsing', () => {
    it('handles quoted name and description', () => {
      writeProjectSkill('quoted-skill', `---
name: "quoted-skill"
description: 'A skill with quotes'
---
Template.`);

      const result = loadOpencodeSkill('quoted-skill', { projectRoot });

      expect(result.found).toBe(true);
      expect(result.skill?.name).toBe('quoted-skill');
      expect(result.skill?.description).toBe('A skill with quotes');
    });

    it('ignores extra frontmatter keys', () => {
      writeProjectSkill('extra-keys', `---
name: extra-keys
description: Has extra keys
allowed-tools: some-tool
argument-hint: some hint
custom-field: value
---
Template.`);

      const result = loadOpencodeSkill('extra-keys', { projectRoot });

      expect(result.found).toBe(true);
      expect(result.skill?.name).toBe('extra-keys');
      expect(result.skill?.description).toBe('Has extra keys');
    });

    it('trims whitespace from name and description', () => {
      writeProjectSkill('whitespace-skill', `---
name:   whitespace-skill  
description:   Lots of spaces   
---
Template.`);

      const result = loadOpencodeSkill('whitespace-skill', { projectRoot });

      expect(result.found).toBe(true);
      expect(result.skill?.name).toBe('whitespace-skill');
      expect(result.skill?.description).toBe('Lots of spaces');
    });

    it('trims template body', () => {
      writeProjectSkill('trim-body', `---
name: trim-body
description: Test
---

  Trimmed content.

`);

      const result = loadOpencodeSkill('trim-body', { projectRoot });

      expect(result.found).toBe(true);
      expect(result.skill?.template).toBe('Trimmed content.');
    });
  });

  // ============================================================================
  // Invalid frontmatter tests
  // ============================================================================

  describe('invalid frontmatter', () => {
    let warnSpy: ReturnType<typeof spyOn>;
    
    beforeEach(() => {
      warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    });
    
    afterEach(() => {
      warnSpy.mockRestore();
    });

    it('returns found: false and warns when frontmatter is missing', () => {
      writeProjectSkill('no-frontmatter', `No frontmatter here.
Just plain text.`);

      const result = loadOpencodeSkill('no-frontmatter', { projectRoot });

      expect(result.found).toBe(false);
      expect(warnSpy).toHaveBeenCalled();
    });

    it('returns found: false and warns when name is missing', () => {
      writeProjectSkill('no-name', `---
description: Missing name
---
Template.`);

      const result = loadOpencodeSkill('no-name', { projectRoot });

      expect(result.found).toBe(false);
      expect(warnSpy).toHaveBeenCalled();
    });

    it('returns found: false and warns when description is missing', () => {
      writeProjectSkill('no-desc', `---
name: no-desc
---
Template.`);

      const result = loadOpencodeSkill('no-desc', { projectRoot });

      expect(result.found).toBe(false);
      expect(warnSpy).toHaveBeenCalled();
    });

    it('returns found: false and warns when name does not match skillId', () => {
      writeProjectSkill('wrong-name', `---
name: different-name
description: Name mismatch
---
Template.`);

      const result = loadOpencodeSkill('wrong-name', { projectRoot });

      expect(result.found).toBe(false);
      expect(warnSpy).toHaveBeenCalled();
    });

    it('falls back to user skill when project skill is invalid', () => {
      // Invalid project skill
      writeProjectSkill('fallback-skill', `No frontmatter`);
      
      // Valid user skill
      writeUserSkill('fallback-skill', `---
name: fallback-skill
description: Valid user skill
---
User template.`);

      const result = loadOpencodeSkill('fallback-skill', { projectRoot });

      expect(result.found).toBe(true);
      expect(result.skill?.description).toBe('Valid user skill');
    });
  });

  // ============================================================================
  // Path traversal security tests
  // ============================================================================

  describe('path traversal protection', () => {
    let warnSpy: ReturnType<typeof spyOn>;
    
    beforeEach(() => {
      warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    });
    
    afterEach(() => {
      warnSpy.mockRestore();
    });

    it('rejects skill id containing forward slash', () => {
      const result = loadOpencodeSkill('foo/bar', { projectRoot });

      expect(result.found).toBe(false);
      expect(warnSpy).toHaveBeenCalled();
    });

    it('rejects skill id containing backslash', () => {
      const result = loadOpencodeSkill('foo\\bar', { projectRoot });

      expect(result.found).toBe(false);
      expect(warnSpy).toHaveBeenCalled();
    });

    it('rejects skill id containing double dot', () => {
      const result = loadOpencodeSkill('..', { projectRoot });

      expect(result.found).toBe(false);
      expect(warnSpy).toHaveBeenCalled();
    });

    it('rejects skill id containing single dot', () => {
      const result = loadOpencodeSkill('.', { projectRoot });

      expect(result.found).toBe(false);
      expect(warnSpy).toHaveBeenCalled();
    });

    it('rejects skill id with embedded path traversal', () => {
      const result = loadOpencodeSkill('skill..name', { projectRoot });

      expect(result.found).toBe(false);
      expect(warnSpy).toHaveBeenCalled();
    });
  });

  // ============================================================================
  // Environment variable handling
  // ============================================================================

  describe('environment variable handling', () => {
    it('uses USERPROFILE when HOME is not set', () => {
      delete process.env.HOME;
      process.env.USERPROFILE = userConfigDir;

      writeUserSkill('userprofile-skill', `---
name: userprofile-skill
description: From USERPROFILE
---
Template.`);

      const result = loadOpencodeSkill('userprofile-skill', { projectRoot });

      expect(result.found).toBe(true);
      expect(result.skill?.description).toBe('From USERPROFILE');
    });

    it('skips user directory lookup when neither HOME nor USERPROFILE is set', () => {
      delete process.env.HOME;
      delete process.env.USERPROFILE;

      // Only user skill exists
      writeUserSkill('orphan-skill', `---
name: orphan-skill
description: Orphan
---
Template.`);

      const result = loadOpencodeSkill('orphan-skill', { projectRoot });

      // Should not find it because user dir lookup is skipped
      expect(result.found).toBe(false);
    });
  });

  // ============================================================================
  // Non-throwing behavior
  // ============================================================================

  describe('non-throwing behavior', () => {
    it('does not throw for any invalid skill id', () => {
      expect(() => loadOpencodeSkill('', { projectRoot })).not.toThrow();
      expect(() => loadOpencodeSkill('../../../etc/passwd', { projectRoot })).not.toThrow();
      expect(() => loadOpencodeSkill('foo/bar/baz', { projectRoot })).not.toThrow();
    });

    it('does not throw for unreadable files', () => {
      // Create a skill directory but make the file unreadable
      const skillDir = path.join(projectRoot, '.opencode', 'skill', 'unreadable');
      fs.mkdirSync(skillDir, { recursive: true });
      const skillPath = path.join(skillDir, 'SKILL.md');
      fs.writeFileSync(skillPath, 'content');
      
      // Make unreadable (may not work on all platforms)
      try {
        fs.chmodSync(skillPath, 0o000);
        expect(() => loadOpencodeSkill('unreadable', { projectRoot })).not.toThrow();
      } finally {
        // Restore permissions for cleanup
        fs.chmodSync(skillPath, 0o644);
      }
    });
  });

  // ============================================================================
  // Edge cases
  // ============================================================================

  describe('edge cases', () => {
    it('handles empty template body', () => {
      writeProjectSkill('empty-body', `---
name: empty-body
description: Empty body
---
`);

      const result = loadOpencodeSkill('empty-body', { projectRoot });

      expect(result.found).toBe(true);
      expect(result.skill?.template).toBe('');
    });

    it('handles Windows line endings (CRLF)', () => {
      const skillContent = '---\r\nname: crlf-skill\r\ndescription: CRLF test\r\n---\r\nTemplate with CRLF.';
      writeProjectSkill('crlf-skill', skillContent);

      const result = loadOpencodeSkill('crlf-skill', { projectRoot });

      expect(result.found).toBe(true);
      expect(result.skill?.name).toBe('crlf-skill');
      expect(result.skill?.description).toBe('CRLF test');
      expect(result.skill?.template).toBe('Template with CRLF.');
    });

    it('case-sensitive name matching', () => {
      writeProjectSkill('CaseSensitive', `---
name: CaseSensitive
description: Case test
---
Template.`);

      // Exact match works
      expect(loadOpencodeSkill('CaseSensitive', { projectRoot }).found).toBe(true);
      
      // Different case doesn't match (file won't be found since dir name is case-sensitive)
      expect(loadOpencodeSkill('casesensitive', { projectRoot }).found).toBe(false);
    });
  });
});
