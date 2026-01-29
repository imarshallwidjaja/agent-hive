/**
 * OpenCode Skill File Loader
 *
 * Loads skill definitions from project and user directories.
 * Supports OpenCode's skill format with YAML frontmatter.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { SkillLoadResult } from './types.js';

/**
 * Options for loading OpenCode skills.
 */
export interface LoadOpencodeSkillOptions {
  /** Project root directory (ctx.directory from plugin) */
  projectRoot: string;
}

/**
 * Strip surrounding quotes from a string value (handles YAML quoted strings).
 */
function stripQuotes(value: string): string {
  const trimmed = value.trim();
  // Handle both single and double quotes
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * Parse SKILL.md frontmatter format.
 * Returns null if parsing fails.
 */
function parseFrontmatter(content: string): { name: string; description: string; body: string } | null {
  // Must start with --- at beginning of file (no leading whitespace/BOM)
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) return null;

  const frontmatter = match[1];
  const body = match[2].trim();

  const nameMatch = frontmatter.match(/^name:\s*(.+)$/m);
  const descMatch = frontmatter.match(/^description:\s*(.+)$/m);

  if (!nameMatch || !descMatch) return null;

  return {
    name: stripQuotes(nameMatch[1]),
    description: stripQuotes(descMatch[1]),
    body,
  };
}

/**
 * Check if a skill ID contains path traversal characters.
 * Returns true if the ID is invalid/unsafe.
 */
function hasPathTraversal(skillId: string): boolean {
  // Reject empty strings
  if (!skillId) return true;
  
  // Reject forward slash, backslash, or any occurrence of '..'
  if (skillId.includes('/') || skillId.includes('\\') || skillId.includes('..')) {
    return true;
  }
  
  // Reject single dot (current directory)
  if (skillId === '.') return true;
  
  return false;
}

/**
 * Get the user home directory from environment variables.
 * Returns undefined if neither HOME nor USERPROFILE is set.
 */
function getHomeDir(): string | undefined {
  return process.env.HOME || process.env.USERPROFILE;
}

/**
 * Try to load and parse a skill file from a specific path.
 * Returns the parsed skill or null if loading fails.
 */
function tryLoadSkillFile(
  filePath: string,
  skillId: string
): { skill: { name: string; description: string; template: string }; source: string } | null {
  // Check if file exists
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }
  } catch {
    // existsSync threw - treat as not found
    return null;
  }

  // Try to read the file
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    console.warn(`[opencode-skill] Failed to read skill file: ${filePath}`, err);
    return null;
  }

  // Parse frontmatter
  const parsed = parseFrontmatter(content);
  if (!parsed) {
    console.warn(`[opencode-skill] Invalid frontmatter in skill file: ${filePath}`);
    return null;
  }

  // Validate name matches skillId (case-sensitive)
  if (parsed.name !== skillId) {
    console.warn(
      `[opencode-skill] Skill name mismatch: expected '${skillId}', found '${parsed.name}' in ${filePath}`
    );
    return null;
  }

  return {
    skill: {
      name: parsed.name,
      description: parsed.description,
      template: parsed.body,
    },
    source: filePath,
  };
}

/**
 * Load an OpenCode skill by ID from project or user directories.
 *
 * Search order:
 * 1. ${projectRoot}/.opencode/skill/<skillId>/SKILL.md
 * 2. ${HOME}/.config/opencode/skill/<skillId>/SKILL.md
 *
 * This function NEVER throws. Returns { found: false } for any error condition.
 *
 * @param skillId - The skill identifier to load
 * @param opts - Options including projectRoot
 * @returns SkillLoadResult with found status and skill data if found
 */
export function loadOpencodeSkill(
  skillId: string,
  opts: LoadOpencodeSkillOptions
): SkillLoadResult {
  // Path traversal check - must be done first
  if (hasPathTraversal(skillId)) {
    console.warn(`[opencode-skill] Invalid skill id (path traversal): '${skillId}'`);
    return { found: false };
  }

  // Try project directory first
  const projectSkillPath = path.join(
    opts.projectRoot,
    '.opencode',
    'skill',
    skillId,
    'SKILL.md'
  );

  const projectResult = tryLoadSkillFile(projectSkillPath, skillId);
  if (projectResult) {
    return {
      found: true,
      skill: projectResult.skill,
      source: projectResult.source,
    };
  }

  // Try user directory
  const homeDir = getHomeDir();
  if (homeDir) {
    const userSkillPath = path.join(
      homeDir,
      '.config',
      'opencode',
      'skill',
      skillId,
      'SKILL.md'
    );

    const userResult = tryLoadSkillFile(userSkillPath, skillId);
    if (userResult) {
      return {
        found: true,
        skill: userResult.skill,
        source: userResult.source,
      };
    }
  }

  // Not found in any location
  return { found: false };
}
