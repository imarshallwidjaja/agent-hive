import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import matter from 'gray-matter';

const DEFAULT_URL_FETCH_TIMEOUT_MS = 1500;

export interface ParsedNativeSkill {
  name: string;
  description: string;
  content: string;
}

export interface PreparedHiveSkill {
  name: string;
  description: string;
  content: string;
  sourceDir: string;
  materializedDir: string;
}

export interface PreparedNativeSkill {
  name: string;
  description: string;
  content: string;
  source: string;
}

export interface PreparedNativeHiveSkills {
  materializedPath?: string;
  skillsByName: Map<string, PreparedHiveSkill>;
  nativeSkillsByName: Map<string, PreparedNativeSkill>;
  skillPaths: string[];
  skipped: Array<{ name: string; reason: 'disabled' | 'conflict' | 'url-scan-incomplete'; source?: string }>;
  urlScanComplete: boolean;
}

export interface PrepareNativeHiveSkillsInput {
  directory: string;
  worktree: string;
  packagedSkillsDir?: string;
  moduleUrl?: string | URL;
  disableSkills?: string[];
  opencodeConfig?: {
    skills?: {
      paths?: string[];
      urls?: string[];
    };
  };
  env?: Record<string, string | undefined>;
  homeDir?: string;
  fetchImpl?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  urlFetchTimeoutMs?: number;
  logger?: {
    warn: (message: string) => void;
  };
}

type Logger = {
  warn: (message: string) => void;
};

function hasNativeSkillMetadata(parsed: matter.GrayMatterFile<string>): boolean {
  return typeof parsed.data?.name === 'string' && typeof parsed.data?.description === 'string';
}

type BundledSkillSource = {
  directoryName: string;
  sourceDir: string;
  skillPath: string;
  parsed: ParsedNativeSkill;
};

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function fallbackSanitization(content: string): string {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) {
    return content;
  }

  const frontmatter = match[1];
  const lines = frontmatter.split(/\r?\n/);
  const result: string[] = [];

  for (const line of lines) {
    if (line.trim().startsWith('#') || line.trim() === '') {
      result.push(line);
      continue;
    }

    if (/^\s+/.test(line)) {
      result.push(line);
      continue;
    }

    const kvMatch = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/);
    if (!kvMatch) {
      result.push(line);
      continue;
    }

    const key = kvMatch[1];
    const value = kvMatch[2].trim();

    if (
      value === '' ||
      value === '>' ||
      value === '|' ||
      value.startsWith('"') ||
      value.startsWith("'")
    ) {
      result.push(line);
      continue;
    }

    if (value.includes(':')) {
      result.push(`${key}: |-`);
      result.push(`  ${value}`);
      continue;
    }

    result.push(line);
  }

  const processed = result.join('\n');
  return content.replace(frontmatter, () => processed);
}

export function parseNativeSkillMarkdown(
  filePath: string,
  content: string,
  logger: Logger = console,
): ParsedNativeSkill | undefined {
  let parsed: matter.GrayMatterFile<string>;

  try {
    parsed = matter(content);
  } catch {
    try {
      parsed = matter(fallbackSanitization(content));
    } catch (error) {
      logger.warn(
        `[hive] Skipping native skill ${filePath}: failed to parse YAML frontmatter: ${error instanceof Error ? error.message : String(error)}`,
      );
      return undefined;
    }
  }

  if (!hasNativeSkillMetadata(parsed)) {
    try {
      parsed = matter(fallbackSanitization(content));
    } catch (error) {
      logger.warn(
        `[hive] Skipping native skill ${filePath}: failed to parse YAML frontmatter: ${error instanceof Error ? error.message : String(error)}`,
      );
      return undefined;
    }
  }

  if (!hasNativeSkillMetadata(parsed)) {
    logger.warn(`[hive] Skipping native skill ${filePath}: missing string name/description frontmatter.`);
    return undefined;
  }

  return {
    name: parsed.data.name,
    description: parsed.data.description,
    content: parsed.content,
  };
}

export function resolvePackagedSkillsDir(moduleUrl: string | URL = import.meta.url): string {
  const resolvedUrl = typeof moduleUrl === 'string' ? moduleUrl : moduleUrl.href;
  const modulePath = resolvedUrl.startsWith('file:') ? fileURLToPath(resolvedUrl) : path.resolve(resolvedUrl);
  const baseDir = path.dirname(modulePath);
  const candidates = [
    path.resolve(baseDir, '..', '..', 'skills'),
    path.resolve(baseDir, '..', 'skills'),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      return candidate;
    }
  }

  throw new Error(`Unable to resolve packaged Hive skills directory from ${resolvedUrl}`);
}

function getLogger(logger?: Logger): Logger {
  return logger ?? console;
}

function getHomeDir(input: PrepareNativeHiveSkillsInput): string {
  return input.homeDir ?? input.env?.HOME ?? process.env.HOME ?? os.homedir();
}

function isTruthyEnv(value: string | undefined): boolean {
  if (value === undefined) {
    return false;
  }

  const normalized = value.trim().toLowerCase();
  return normalized !== '' && normalized !== '0' && normalized !== 'false' && normalized !== 'no';
}

function isHiveManagedSkillsPath(
  candidatePath: string,
  generatedRoot: string,
  legacyGeneratedRoot: string,
): boolean {
  const resolved = path.resolve(candidatePath);
  return [generatedRoot, legacyGeneratedRoot].some(
    (root) => resolved === root || resolved.startsWith(`${root}${path.sep}`),
  );
}

function resolveConfiguredSkillPath(rawPath: string, directory: string, homeDir: string): string {
  const expanded = rawPath.startsWith('~/') ? path.join(homeDir, rawPath.slice(2)) : rawPath;
  return path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(directory, expanded);
}

function walkUpDirectories(start: string, stop: string): string[] {
  const directories: string[] = [];
  let current = path.resolve(start);
  const stopDir = path.resolve(stop);

  while (true) {
    directories.push(current);
    if (current === stopDir) {
      break;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  return directories;
}

async function isDirectory(dirPath: string): Promise<boolean> {
  try {
    return (await fsp.stat(dirPath)).isDirectory();
  } catch {
    return false;
  }
}

async function scanSkillMarkdownFiles(rootDir: string): Promise<string[]> {
  if (!(await isDirectory(rootDir))) {
    return [];
  }

  const matches: string[] = [];
  const queue = [rootDir];

  while (queue.length > 0) {
    const currentDir = queue.pop()!;
    const entries = await fsp.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        queue.push(fullPath);
        continue;
      }
      if (entry.isFile() && entry.name === 'SKILL.md') {
        matches.push(fullPath);
      }
    }
  }

  return matches.sort(compareCodeUnits);
}

async function scanOpenCodeSkillDirs(opencodeDir: string): Promise<string[]> {
  const matches = await Promise.all([
    scanSkillMarkdownFiles(path.join(opencodeDir, 'skills')),
    scanSkillMarkdownFiles(path.join(opencodeDir, 'skill')),
  ]);
  return matches.flat();
}

async function readBundledSkills(packagedSkillsDir: string, logger: Logger): Promise<BundledSkillSource[]> {
  const entries = await fsp.readdir(packagedSkillsDir, { withFileTypes: true });
  const skills: BundledSkillSource[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const sourceDir = path.join(packagedSkillsDir, entry.name);
    const skillPath = path.join(sourceDir, 'SKILL.md');

    try {
      const content = await fsp.readFile(skillPath, 'utf8');
      const parsed = parseNativeSkillMarkdown(skillPath, content, logger);
      if (!parsed) {
        continue;
      }
      skills.push({
        directoryName: entry.name,
        sourceDir,
        skillPath,
        parsed,
      });
    } catch (error) {
      logger.warn(
        `[hive] Skipping native skill ${skillPath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return skills.sort((left, right) => compareCodeUnits(left.directoryName, right.directoryName));
}

function setNativeSkill(
  nativeSkillsByName: Map<string, PreparedNativeSkill>,
  source: string,
  parsed: ParsedNativeSkill,
): void {
  nativeSkillsByName.set(parsed.name, {
    name: parsed.name,
    description: parsed.description,
    content: parsed.content,
    source,
  });
}

async function addNativeSkill(
  skillPath: string,
  nativeSkillsByName: Map<string, PreparedNativeSkill>,
  logger: Logger,
): Promise<void> {
  try {
    const content = await fsp.readFile(skillPath, 'utf8');
    const parsed = parseNativeSkillMarkdown(skillPath, content, logger);
    if (!parsed) {
      return;
    }
    setNativeSkill(nativeSkillsByName, skillPath, parsed);
  } catch (error) {
    logger.warn(`[hive] Skipping native skill ${skillPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function scanSkillFilesIntoNativeSkills(
  skillFiles: string[],
  nativeSkillsByName: Map<string, PreparedNativeSkill>,
  logger: Logger,
): Promise<void> {
  for (const skillFile of skillFiles) {
    await addNativeSkill(skillFile, nativeSkillsByName, logger);
  }
}

function getExternalDirNames(env: Record<string, string | undefined>): string[] {
  if (isTruthyEnv(env.OPENCODE_DISABLE_EXTERNAL_SKILLS)) {
    return [];
  }

  const disableClaude =
    isTruthyEnv(env.OPENCODE_DISABLE_CLAUDE_CODE_SKILLS) || isTruthyEnv(env.OPENCODE_DISABLE_CLAUDE_CODE);

  return disableClaude ? ['.agents'] : ['.claude', '.agents'];
}

function getGlobalOpenCodeConfigDir(env: Record<string, string | undefined>, homeDir: string): string {
  if (env.OPENCODE_CONFIG_DIR) {
    return path.resolve(env.OPENCODE_CONFIG_DIR);
  }

  if (env.XDG_CONFIG_HOME) {
    return path.resolve(env.XDG_CONFIG_HOME, 'opencode');
  }

  return path.resolve(homeDir, '.config', 'opencode');
}

async function scanLocalNativeSkills(
  input: PrepareNativeHiveSkillsInput,
  skillPaths: string[],
  logger: Logger,
): Promise<Map<string, PreparedNativeSkill>> {
  const env = { ...process.env, ...input.env };
  const homeDir = getHomeDir(input);
  const nativeSkillsByName = new Map<string, PreparedNativeSkill>();
  const externalDirNames = getExternalDirNames(env);

  for (const externalDirName of externalDirNames) {
    await scanSkillFilesIntoNativeSkills(
      await scanSkillMarkdownFiles(path.join(homeDir, externalDirName, 'skills')),
      nativeSkillsByName,
      logger,
    );
  }

  for (const currentDir of walkUpDirectories(input.directory, input.worktree)) {
    for (const externalDirName of externalDirNames) {
      await scanSkillFilesIntoNativeSkills(
        await scanSkillMarkdownFiles(path.join(currentDir, externalDirName, 'skills')),
        nativeSkillsByName,
        logger,
      );
    }
  }

  await scanSkillFilesIntoNativeSkills(
    await scanOpenCodeSkillDirs(getGlobalOpenCodeConfigDir(env, homeDir)),
    nativeSkillsByName,
    logger,
  );

  for (const currentDir of walkUpDirectories(input.directory, input.worktree)) {
    await scanSkillFilesIntoNativeSkills(
      await scanOpenCodeSkillDirs(path.join(currentDir, '.opencode')),
      nativeSkillsByName,
      logger,
    );
  }

  for (const configuredPath of skillPaths) {
    if (await isDirectory(configuredPath)) {
      await scanSkillFilesIntoNativeSkills(await scanSkillMarkdownFiles(configuredPath), nativeSkillsByName, logger);
    }
  }

  return nativeSkillsByName;
}

type UrlScanResult = {
  urlScanComplete: boolean;
  nativeSkillsByName: Map<string, PreparedNativeSkill>;
};

async function fetchWithTimeout(
  fetchImpl: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
  input: string | URL | Request,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(() => {
      controller.abort();
      reject(new Error(`Timed out after ${timeoutMs}ms fetching ${String(input)}`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([fetchImpl(input, { signal: controller.signal }), timeoutPromise]);
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }
}

async function scanUrlNativeSkills(
  input: PrepareNativeHiveSkillsInput,
  logger: Logger,
): Promise<UrlScanResult> {
  const urls = input.opencodeConfig?.skills?.urls ?? [];
  const fetchImpl = input.fetchImpl ?? fetch;
  const urlFetchTimeoutMs = input.urlFetchTimeoutMs ?? DEFAULT_URL_FETCH_TIMEOUT_MS;
  const nativeSkillsByName = new Map<string, PreparedNativeSkill>();

  for (const configuredUrl of urls) {
    const base = configuredUrl.endsWith('/') ? configuredUrl : `${configuredUrl}/`;
    const indexUrl = new URL('index.json', base).href;
    const host = base.slice(0, -1);

    try {
      const indexResponse = await fetchWithTimeout(fetchImpl, indexUrl, urlFetchTimeoutMs);
      if (!indexResponse.ok) {
        throw new Error(`HTTP ${indexResponse.status} for ${indexUrl}`);
      }

      const indexData = (await indexResponse.json()) as {
        skills?: Array<{ name?: string; files?: string[] }>;
      };

      const skills = Array.isArray(indexData.skills) ? indexData.skills : [];
      for (const skill of skills) {
        if (!Array.isArray(skill.files) || !skill.files.includes('SKILL.md')) {
          logger.warn(`[hive] Skipping native skills URL entry missing SKILL.md: ${indexUrl}`);
          continue;
        }
        if (typeof skill.name !== 'string') {
          logger.warn(`[hive] Skipping native skills URL entry missing string name: ${indexUrl}`);
          continue;
        }

        const skillUrl = new URL('SKILL.md', `${host}/${skill.name}/`).href;
        const skillResponse = await fetchWithTimeout(fetchImpl, skillUrl, urlFetchTimeoutMs);
        if (!skillResponse.ok) {
          throw new Error(`HTTP ${skillResponse.status} for ${skillUrl}`);
        }

        const content = await skillResponse.text();
        const parsed = parseNativeSkillMarkdown(skillUrl, content, logger);
        if (parsed) {
          setNativeSkill(nativeSkillsByName, skillUrl, parsed);
        }
      }
    } catch (error) {
      logger.warn(
        `[hive] Skipping Hive bundled native skill materialization because configured skills URL could not be scanned for conflicts: ${error instanceof Error ? error.message : String(error)}`,
      );
      return {
        urlScanComplete: false,
        nativeSkillsByName: new Map<string, PreparedNativeSkill>(),
      };
    }
  }

  return {
    urlScanComplete: true,
    nativeSkillsByName,
  };
}

function skillSourcesByName(nativeSkillsByName: Map<string, PreparedNativeSkill>): Map<string, string> {
  return new Map([...nativeSkillsByName].map(([name, skill]) => [name, skill.source]));
}

function mergeNativeSkills(
  localNativeSkills: Map<string, PreparedNativeSkill>,
  urlNativeSkills: Map<string, PreparedNativeSkill>,
): Map<string, PreparedNativeSkill> {
  const merged = new Map(localNativeSkills);
  for (const [name, skill] of urlNativeSkills) {
    merged.set(name, skill);
  }
  return merged;
}

async function buildGeneratedHash(stagedRoot: string): Promise<string> {
  const hash = createHash('sha256');
  const entriesToHash: Array<{
    outputPath: string;
    sourcePath: string;
    type: 'directory' | 'file' | 'symlink';
    mode?: number;
  }> = [];

  const queue = (await fsp.readdir(stagedRoot)).map((childName) => ({
    sourcePath: path.join(stagedRoot, childName),
    outputPath: childName,
  }));

  while (queue.length > 0) {
    const current = queue.pop()!;
    const stats = await fsp.lstat(current.sourcePath);

    if (stats.isDirectory()) {
      entriesToHash.push({ ...current, type: 'directory', mode: stats.mode & 0o7777 });
      for (const childName of await fsp.readdir(current.sourcePath)) {
        queue.push({
          sourcePath: path.join(current.sourcePath, childName),
          outputPath: path.posix.join(current.outputPath, childName),
        });
      }
      continue;
    }

    if (stats.isFile()) {
      entriesToHash.push({ ...current, type: 'file', mode: stats.mode & 0o7777 });
      continue;
    }

    if (stats.isSymbolicLink()) {
      entriesToHash.push({ ...current, type: 'symlink' });
      continue;
    }

    throw new Error(`Unsupported bundled skill filesystem entry: ${current.outputPath}`);
  }

  entriesToHash.sort((left, right) => compareCodeUnits(left.outputPath, right.outputPath));
  const updateField = (value: string | Buffer): void => {
    const bytes = typeof value === 'string' ? Buffer.from(value) : value;
    hash.update(`${bytes.byteLength}:`);
    hash.update(bytes);
  };

  for (const entry of entriesToHash) {
    updateField(entry.outputPath);
    updateField(entry.type);
    if (entry.mode !== undefined) {
      updateField(entry.mode.toString(8));
    }
    if (entry.type === 'file') {
      updateField(await fsp.readFile(entry.sourcePath));
    } else if (entry.type === 'symlink') {
      updateField(await fsp.readlink(entry.sourcePath));
    }
  }

  return hash.digest('hex').slice(0, 16);
}

async function materializeSkills(
  generatedRoot: string,
  bundledSkills: BundledSkillSource[],
  logger: Logger,
): Promise<{ materializedPath: string; skillsByName: Map<string, PreparedHiveSkill> }> {
  await fsp.mkdir(generatedRoot, { recursive: true });
  const tempPath = path.join(generatedRoot, `.tmp-${randomUUID()}`);
  await fsp.mkdir(tempPath);

  try {
    for (const skill of bundledSkills) {
      const destinationDir = path.join(tempPath, skill.directoryName);
      await fsp.cp(skill.sourceDir, destinationDir, { recursive: true, verbatimSymlinks: true });
    }

    const stagedSkills: Array<{ source: BundledSkillSource; parsed: ParsedNativeSkill }> = [];
    for (const skill of bundledSkills) {
      const stagedSkillPath = path.join(tempPath, skill.directoryName, 'SKILL.md');
      const parsed = parseNativeSkillMarkdown(stagedSkillPath, await fsp.readFile(stagedSkillPath, 'utf8'), logger);
      if (!parsed) {
        throw new Error(
          `Bundled skill source changed during materialization: staged SKILL.md for expected name "${skill.parsed.name}" in folder "${skill.directoryName}" is invalid.`,
        );
      }
      if (parsed.name !== skill.parsed.name) {
        throw new Error(
          `Bundled skill source changed during materialization: expected name "${skill.parsed.name}" in folder "${skill.directoryName}", staged name was "${parsed.name}".`,
        );
      }
      stagedSkills.push({ source: skill, parsed });
    }

    const hash = await buildGeneratedHash(tempPath);
    const materializedPath = path.join(generatedRoot, hash);
    if (!(await isDirectory(materializedPath))) {
      try {
        await fsp.rename(tempPath, materializedPath);
      } catch (error) {
        if (!(await isDirectory(materializedPath))) {
          throw error;
        }
      }
    }

    const skillsByName = new Map<string, PreparedHiveSkill>();
    for (const skill of stagedSkills) {
      skillsByName.set(skill.parsed.name, {
        name: skill.parsed.name,
        description: skill.parsed.description,
        content: skill.parsed.content,
        sourceDir: skill.source.sourceDir,
        materializedDir: path.join(materializedPath, skill.source.directoryName),
      });
    }

    return {
      materializedPath,
      skillsByName,
    };
  } finally {
    await fsp.rm(tempPath, { recursive: true, force: true });
  }
}

export async function prepareNativeHiveSkills(
  input: PrepareNativeHiveSkillsInput,
): Promise<PreparedNativeHiveSkills> {
  const logger = getLogger(input.logger);
  const homeDir = getHomeDir(input);
  const env = { ...process.env, ...input.env };
  const generatedRoot = path.join(
    getGlobalOpenCodeConfigDir(env, homeDir),
    'agent-hive',
    'generated',
    'opencode-skills',
  );
  const legacyGeneratedRoot = path.resolve(input.worktree, '.hive', 'generated', 'opencode-skills');
  const packagedSkillsDir = input.packagedSkillsDir ?? resolvePackagedSkillsDir(input.moduleUrl);
  const bundledSkills = await readBundledSkills(packagedSkillsDir, logger);
  const disabledSkills = new Set(input.disableSkills ?? []);
  const resolvedUserPaths = (input.opencodeConfig?.skills?.paths ?? [])
    .map((skillPath) => resolveConfiguredSkillPath(skillPath, input.directory, homeDir))
    .filter((skillPath) => !isHiveManagedSkillsPath(skillPath, generatedRoot, legacyGeneratedRoot));
  const localNativeSkills = await scanLocalNativeSkills(input, resolvedUserPaths, logger);
  const urlScan = await scanUrlNativeSkills(input, logger);

  if (!urlScan.urlScanComplete) {
    return {
      materializedPath: undefined,
      skillsByName: new Map<string, PreparedHiveSkill>(),
      nativeSkillsByName: localNativeSkills,
      skillPaths: resolvedUserPaths,
      skipped: bundledSkills.map((skill) => ({
        name: skill.parsed.name,
        reason: 'url-scan-incomplete' as const,
      })),
      urlScanComplete: false,
    };
  }

  const nativeSkillsByName = mergeNativeSkills(localNativeSkills, urlScan.nativeSkillsByName);
  const allConflicts = skillSourcesByName(nativeSkillsByName);

  const eligibleSkills: BundledSkillSource[] = [];
  const skipped: PreparedNativeHiveSkills['skipped'] = [];

  for (const skill of bundledSkills) {
    if (disabledSkills.has(skill.parsed.name)) {
      skipped.push({ name: skill.parsed.name, reason: 'disabled' });
      continue;
    }

    const conflictSource = allConflicts.get(skill.parsed.name);
    if (conflictSource) {
      skipped.push({ name: skill.parsed.name, reason: 'conflict', source: conflictSource });
      continue;
    }

    eligibleSkills.push(skill);
  }

  if (eligibleSkills.length === 0) {
    return {
      materializedPath: undefined,
      skillsByName: new Map<string, PreparedHiveSkill>(),
      nativeSkillsByName,
      skillPaths: resolvedUserPaths,
      skipped,
      urlScanComplete: true,
    };
  }

  const { materializedPath, skillsByName } = await materializeSkills(generatedRoot, eligibleSkills, logger);

  return {
    materializedPath,
    skillsByName,
    nativeSkillsByName,
    skillPaths: [materializedPath, ...resolvedUserPaths],
    skipped,
    urlScanComplete: true,
  };
}
