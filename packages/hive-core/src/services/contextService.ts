import * as fs from 'fs';
import * as path from 'path';
import {
  acquireLockSync,
  ensureDir,
  fileExists,
  getContextPath,
  readJson,
  readText,
  writeAtomic,
  writeJsonAtomic,
} from '../utils/paths.js';
import type {
  ContextFile,
  ContextIndex,
  ContextIndexEntry,
  ContextKind,
  ContextRole,
} from '../types.js';
export type { ContextFile, ContextIndex, ContextIndexEntry, ContextKind, ContextRole };

export const OVERVIEW_CONTEXT_NAME = 'overview';
export const CONTEXT_INDEX_SCHEMA_VERSION = 1;
export const RECOMMENDED_DURABLE_FILE_CAP = 8;
export const RECOMMENDED_DURABLE_CHAR_CAP = 40_000;

export type ContextMutationErrorReason =
  | 'context_already_exists'
  | 'context_not_found'
  | 'invalid_context_name'
  | 'invalid_context_kind'
  | 'invalid_archive_reason'
  | 'invalid_argument'
  | 'stale_revision'
  | 'durable_context_limit';

export class ContextMutationError extends Error {
  constructor(
    readonly reason: ContextMutationErrorReason,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export interface ContextReadSummary {
  schemaVersion: 1;
  revision: number;
  files: Array<Omit<ContextFile, 'content'>>;
  durable: {
    fileCount: number;
    chars: number;
    fileCap: number;
    charCap: number;
    overLimit: boolean;
    consolidationHints: string[];
  };
}

export interface ContextContentRead {
  revision: number;
  file: ContextFile;
}

export interface ContextMutationResult {
  revision: number;
  file: Omit<ContextFile, 'content'> & { chars: number };
  path: string;
}

export interface ContextArchiveResult {
  revision: number;
  archived: Array<{ name: string; archivePath: string; reason: string }>;
}

const DEFAULT_CONTEXT_CLASSIFICATION = {
  role: 'durable',
  includeInExecution: true,
  includeInNetwork: true,
} satisfies {
  role: ContextRole;
  includeInExecution: boolean;
  includeInNetwork: boolean;
};

const SPECIAL_CONTEXTS = {
  draft: { role: 'scratchpad', includeInExecution: false, includeInNetwork: false },
  'execution-decisions': { role: 'operational', includeInExecution: false, includeInNetwork: false },
  overview: { role: 'operational', includeInExecution: false, includeInNetwork: false },
} as const satisfies Record<string, {
  role: ContextRole;
  includeInExecution: boolean;
  includeInNetwork: boolean;
}>;

export class ContextService {
  constructor(
    private projectRoot: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  write(featureName: string, fileName: string, content: string): string {
    return this.mutate(featureName, undefined, (index, contextPath) => {
      const name = this.normalizeName(fileName);
      const filePath = path.join(contextPath, `${name}.md`);
      const prior = readText(filePath);
      const existing = index.entries[name];
      const priorKind = this.effectiveKind(name, existing?.kind);
      const kind = this.resolveMutableKind(name, existing?.kind);
      this.assertDurableGrowthAllowed(contextPath, index, name, prior ?? '', content, priorKind, kind);
      const timestamp = this.now().toISOString();
      const nextIndex = this.withEntry(index, name, kind, timestamp, existing?.task, existing);
      this.writeContentAndIndex(filePath, prior, content, this.indexPath(contextPath), nextIndex);
      return filePath;
    });
  }

  read(featureName: string, fileName: string): string | null {
    const contextPath = getContextPath(this.projectRoot, featureName);
    const filePath = path.join(contextPath, this.normalizeFileName(fileName));
    return readText(filePath);
  }

  list(featureName: string): ContextFile[] {
    return this.readSnapshot(featureName, (_index, files) => files);
  }

  private listWithIndex(contextPath: string, index: ContextIndex): ContextFile[] {
    const files = fs.readdirSync(contextPath, { withFileTypes: true })
      .filter(f => f.isFile() && f.name.endsWith('.md'))
      .map(f => f.name)
      .sort((a, b) => a.localeCompare(b));

    return files.map(name => {
      const filePath = path.join(contextPath, name);
      const stat = fs.statSync(filePath);
      const content = readText(filePath) || '';
      const normalizedName = name.replace(/\.md$/, '');
      const metadata = index.entries[normalizedName];
      const classification = this.classifyContextName(normalizedName, metadata?.kind);

      return {
        name: normalizedName,
        content,
        createdAt: metadata?.createdAt ?? stat.birthtime.toISOString(),
        updatedAt: metadata?.updatedAt ?? stat.mtime.toISOString(),
        kind: this.isSpecialName(normalizedName) ? undefined : metadata?.kind ?? 'durable',
        task: metadata?.task,
        ...classification,
      };
    });
  }

  getOverview(featureName: string): ContextFile | null {
    return this.list(featureName).find(file => file.name === OVERVIEW_CONTEXT_NAME) ?? null;
  }

  listExecutionContext(featureName: string): ContextFile[] {
    return this.list(featureName)
      .filter(file => file.includeInExecution)
      .sort(this.compareRecentContext);
  }

  listNetworkContext(featureName: string): ContextFile[] {
    return this.list(featureName)
      .filter(file => file.includeInNetwork)
      .sort(this.compareRecentContext);
  }

  delete(featureName: string, fileName: string): boolean {
    return this.mutate(featureName, undefined, (index, contextPath) => {
      const name = this.normalizeName(fileName);
      const filePath = path.join(contextPath, `${name}.md`);
      const prior = readText(filePath);
      if (prior === null) return false;

      fs.unlinkSync(filePath);
      const nextEntries = { ...index.entries };
      delete nextEntries[name];
      try {
        writeJsonAtomic(this.indexPath(contextPath), {
          ...index,
          revision: index.revision + 1,
          entries: nextEntries,
        });
      } catch (error) {
        writeAtomic(filePath, prior);
        throw error;
      }
      return true;
    });
  }

  compile(featureName: string): string {
    const files = this.list(featureName);
    if (files.length === 0) return '';

    const sections = files.map(f => `## ${f.name}\n\n${f.content}`);
    return sections.join('\n\n---\n\n');
  }

  archive(featureName: string): { archived: string[]; archivePath: string } {
    return this.mutate(featureName, undefined, (index, contextPath) => {
      const contexts = this.listWithIndex(contextPath, index);
      if (contexts.length === 0) return { archived: [], archivePath: '' };

      const archiveDir = path.join(contextPath, '..', 'archive');
      ensureDir(archiveDir);
      const timestamp = this.now().toISOString().replace(/[:.]/g, '-');
      const reservedDestinations = new Set<string>();
      const moves = contexts.map(context => {
        const source = path.join(contextPath, `${context.name}.md`);
        const archiveStem = `${timestamp}_${context.name}`;
        let suffix = 1;
        let destination = path.join(archiveDir, `${archiveStem}.md`);
        while (fileExists(destination) || reservedDestinations.has(destination)) {
          suffix += 1;
          destination = path.join(archiveDir, `${archiveStem}-${suffix}.md`);
        }
        reservedDestinations.add(destination);
        return { name: context.name, source, destination };
      });
      for (const item of moves) {
        if (!fileExists(item.source)) {
          throw new ContextMutationError('context_not_found', `Context "${item.name}" does not exist.`, {
            name: item.name,
          });
        }
        if (fileExists(item.destination)) {
          throw new ContextMutationError('invalid_argument', 'Archive destination changed during preflight.', {
            name: item.name,
            archivePath: item.destination,
          });
        }
      }

      const moved: typeof moves = [];
      try {
        for (const item of moves) {
          fs.copyFileSync(item.source, item.destination, fs.constants.COPYFILE_EXCL);
          moved.push(item);
          fs.unlinkSync(item.source);
        }
        writeJsonAtomic(this.indexPath(contextPath), {
          ...index,
          revision: index.revision + 1,
          entries: {},
        });
        return { archived: moved.map(item => item.name), archivePath: archiveDir };
      } catch (error) {
        for (const item of [...moved].reverse()) {
          if (!fileExists(item.destination)) continue;
          if (!fileExists(item.source)) fs.renameSync(item.destination, item.source);
          else fs.unlinkSync(item.destination);
        }
        throw error;
      }
    });
  }

  stats(featureName: string): { count: number; totalChars: number; oldest?: string; newest?: string } {
    const contexts = this.list(featureName);
    if (contexts.length === 0) return { count: 0, totalChars: 0 };
    
    const sorted = [...contexts].sort((a, b) => 
      new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime()
    );
    
    return {
      count: contexts.length,
      totalChars: contexts.reduce((sum, c) => sum + c.content.length, 0),
      oldest: sorted[0].name,
      newest: sorted[sorted.length - 1].name,
    };
  }

  private normalizeFileName(name: string): string {
    const normalized = this.normalizeName(name);
    return `${normalized}.md`;
  }

  readSummary(featureName: string): ContextReadSummary {
    return this.readSnapshot(featureName, (index, files) => {
      const durable = this.durableFootprint(files);
      return {
        schemaVersion: CONTEXT_INDEX_SCHEMA_VERSION,
        revision: index.revision,
        files: files.map(({ content: _content, ...file }) => file),
        durable: {
          fileCount: durable.fileCount,
          chars: durable.chars,
          fileCap: RECOMMENDED_DURABLE_FILE_CAP,
          charCap: RECOMMENDED_DURABLE_CHAR_CAP,
          overLimit: durable.fileCount > RECOMMENDED_DURABLE_FILE_CAP
            || durable.chars > RECOMMENDED_DURABLE_CHAR_CAP,
          consolidationHints: this.consolidationHints(files),
        },
      };
    });
  }

  readContent(featureName: string, fileName: string): ContextContentRead | null {
    const name = this.normalizeName(fileName);
    return this.readSnapshot(featureName, (index, files) => {
      const file = files.find(candidate => candidate.name === name);
      return file ? { revision: index.revision, file } : null;
    });
  }

  create(
    featureName: string,
    fileName: string,
    content: string,
    options: { kind?: ContextKind; task?: string } = {},
  ): ContextMutationResult {
    return this.mutate(featureName, undefined, (index, contextPath) => {
      const name = this.normalizeName(fileName);
      const filePath = path.join(contextPath, `${name}.md`);
      if (fileExists(filePath)) {
        throw new ContextMutationError(
          'context_already_exists',
          `Context "${name}" already exists. Read it, then replace with its current revision.`,
          { name, revision: index.revision },
        );
      }
      const kind = this.resolveMutableKind(name, options.kind);
      this.assertDurableGrowthAllowed(contextPath, index, name, '', content, undefined, kind);
      const timestamp = this.now().toISOString();
      const nextIndex = this.withEntry(index, name, kind, timestamp, options.task);
      this.writeContentAndIndex(filePath, null, content, this.indexPath(contextPath), nextIndex);
      return this.mutationResult(name, content, timestamp, kind, options.task, nextIndex.revision, filePath);
    });
  }

  replace(
    featureName: string,
    fileName: string,
    content: string,
    expectedRevision: number,
    options: { kind?: ContextKind; task?: string } = {},
  ): ContextMutationResult {
    return this.mutate(featureName, expectedRevision, (index, contextPath) => {
      const name = this.normalizeName(fileName);
      const filePath = path.join(contextPath, `${name}.md`);
      const prior = readText(filePath);
      if (prior === null) {
        throw new ContextMutationError('context_not_found', `Context "${name}" does not exist.`, { name });
      }
      const existing = index.entries[name];
      const kind = this.resolveMutableKind(name, options.kind ?? existing?.kind);
      this.assertDurableGrowthAllowed(
        contextPath,
        index,
        name,
        prior,
        content,
        this.effectiveKind(name, existing?.kind),
        kind,
      );
      const timestamp = this.now().toISOString();
      const nextIndex = this.withEntry(index, name, kind, timestamp, options.task ?? existing?.task, existing);
      this.writeContentAndIndex(filePath, prior, content, this.indexPath(contextPath), nextIndex);
      return this.mutationResult(name, content, timestamp, kind, options.task ?? existing?.task, nextIndex.revision, filePath);
    });
  }

  append(
    featureName: string,
    fileName: string,
    content: string,
    expectedRevision: number,
    options: { section?: string; task?: string } = {},
  ): ContextMutationResult {
    return this.mutate(featureName, expectedRevision, (index, contextPath) => {
      const name = this.normalizeName(fileName);
      const filePath = path.join(contextPath, `${name}.md`);
      const prior = readText(filePath);
      if (prior === null) {
        throw new ContextMutationError('context_not_found', `Context "${name}" does not exist. Create it explicitly first.`, { name });
      }
      const existing = index.entries[name];
      const kind = this.resolveMutableKind(name, existing?.kind);
      const timestamp = this.now().toISOString();
      const heading = options.section ? `### ${options.section}\n\n` : '';
      const separator = prior.endsWith('\n') ? '\n' : '\n\n';
      const nextContent = `${prior}${separator}<!-- appended ${timestamp} -->\n${heading}${content}\n`;
      this.assertDurableGrowthAllowed(contextPath, index, name, prior, nextContent, kind, kind);
      const nextIndex = this.withEntry(index, name, kind, timestamp, options.task ?? existing?.task, existing);
      this.writeContentAndIndex(filePath, prior, nextContent, this.indexPath(contextPath), nextIndex);
      return this.mutationResult(name, nextContent, timestamp, kind, options.task ?? existing?.task, nextIndex.revision, filePath);
    });
  }

  archiveSelected(
    featureName: string,
    names: string[],
    reason: string,
    expectedRevision: number,
  ): ContextArchiveResult {
    if (!reason.trim()) {
      throw new ContextMutationError('invalid_archive_reason', 'Archive reason must not be blank.');
    }
    return this.mutate(featureName, expectedRevision, (index, contextPath) => {
      const normalized = [...new Set(names.map(name => this.normalizeName(name)))];
      if (normalized.length === 0) {
        throw new ContextMutationError('invalid_argument', 'At least one context name is required.');
      }
      const missing = normalized.filter(name => !fileExists(path.join(contextPath, `${name}.md`)));
      if (missing.length > 0) {
        throw new ContextMutationError('context_not_found', 'One or more context files do not exist.', { names: missing });
      }

      const timestamp = this.now().toISOString();
      const archiveDir = path.join(contextPath, '..', 'archive', 'context');
      ensureDir(archiveDir);
      const reservedDestinations = new Set<string>();
      const moves = normalized.map(name => {
        const source = path.join(contextPath, `${name}.md`);
        const archiveStem = `${timestamp.replace(/[:.]/g, '-')}_${name}`;
        let suffix = 1;
        let destination = path.join(archiveDir, `${archiveStem}.md`);
        while (fileExists(destination) || reservedDestinations.has(destination)) {
          suffix += 1;
          destination = path.join(archiveDir, `${archiveStem}-${suffix}.md`);
        }
        reservedDestinations.add(destination);
        return { name, source, destination };
      });
      for (const item of moves) {
        if (!fileExists(item.source)) {
          throw new ContextMutationError('context_not_found', `Context "${item.name}" does not exist.`, { name: item.name });
        }
        if (fileExists(item.destination)) {
          throw new ContextMutationError('invalid_argument', 'Archive destination changed during preflight.', {
            name: item.name,
            archivePath: item.destination,
          });
        }
      }
      const moved: Array<{ name: string; source: string; destination: string }> = [];
      try {
        for (const item of moves) {
          fs.copyFileSync(item.source, item.destination, fs.constants.COPYFILE_EXCL);
          moved.push(item);
          fs.unlinkSync(item.source);
        }
        const nextEntries = { ...index.entries };
        for (const name of normalized) delete nextEntries[name];
        const nextIndex = { ...index, revision: index.revision + 1, entries: nextEntries };
        writeJsonAtomic(this.indexPath(contextPath), nextIndex);
        try {
          this.appendArchiveRecord(contextPath, timestamp, reason, moved);
        } catch (error) {
          writeJsonAtomic(this.indexPath(contextPath), index);
          throw error;
        }
        return {
          revision: nextIndex.revision,
          archived: moved.map(item => ({ name: item.name, archivePath: item.destination, reason })),
        };
      } catch (error) {
        for (const item of [...moved].reverse()) {
          if (!fileExists(item.destination)) continue;
          if (!fileExists(item.source)) fs.renameSync(item.destination, item.source);
          else fs.unlinkSync(item.destination);
        }
        throw error;
      }
    });
  }

  private classifyContextName(name: string, kind: ContextKind = 'durable'): Pick<ContextFile, 'role' | 'includeInExecution' | 'includeInNetwork'> {
    if (SPECIAL_CONTEXTS[name as keyof typeof SPECIAL_CONTEXTS]) {
      return SPECIAL_CONTEXTS[name as keyof typeof SPECIAL_CONTEXTS];
    }
    if (kind === 'evidence') {
      return { role: 'evidence', includeInExecution: false, includeInNetwork: false };
    }
    return SPECIAL_CONTEXTS[name as keyof typeof SPECIAL_CONTEXTS] ?? DEFAULT_CONTEXT_CLASSIFICATION;
  }

  private normalizeName(name: string): string {
    const normalized = name.trim().replace(/\.md$/, '');
    if (!normalized || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(normalized) || normalized === 'index') {
      throw new ContextMutationError('invalid_context_name', `Invalid context name "${name}". Use a simple file name without paths.`, { name });
    }
    return normalized;
  }

  private isSpecialName(name: string): boolean {
    return Object.hasOwn(SPECIAL_CONTEXTS, name);
  }

  private resolveMutableKind(name: string, requested?: ContextKind): ContextKind | undefined {
    if (this.isSpecialName(name)) {
      if (requested !== undefined) {
        throw new ContextMutationError(
          'invalid_context_kind',
          `Context "${name}" is reserved and does not accept a caller-provided kind.`,
          { name, kind: requested },
        );
      }
      return undefined;
    }
    if (requested !== undefined && requested !== 'durable' && requested !== 'evidence') {
      throw new ContextMutationError('invalid_context_kind', `Invalid context kind "${requested}".`);
    }
    return requested ?? 'durable';
  }

  private effectiveKind(name: string, indexedKind?: ContextKind): ContextKind | undefined {
    return this.isSpecialName(name) ? undefined : indexedKind ?? 'durable';
  }

  private indexPath(contextPath: string): string {
    return path.join(contextPath, 'index.json');
  }

  private readIndex(featureName: string): ContextIndex {
    const contextPath = getContextPath(this.projectRoot, featureName);
    const index = readJson<ContextIndex>(this.indexPath(contextPath));
    return index?.schemaVersion === CONTEXT_INDEX_SCHEMA_VERSION
      ? index
      : { schemaVersion: CONTEXT_INDEX_SCHEMA_VERSION, revision: 0, entries: {} };
  }

  private mutate<T>(
    featureName: string,
    expectedRevision: number | undefined,
    mutation: (index: ContextIndex, contextPath: string) => T,
  ): T {
    const contextPath = getContextPath(this.projectRoot, featureName);
    ensureDir(contextPath);
    const indexPath = this.indexPath(contextPath);
    const release = acquireLockSync(indexPath);
    try {
      const index = this.readIndex(featureName);
      if (expectedRevision !== undefined && index.revision !== expectedRevision) {
        throw new ContextMutationError(
          'stale_revision',
          `Context changed since revision ${expectedRevision}; current revision is ${index.revision}.`,
          { expectedRevision, revision: index.revision },
        );
      }
      return mutation(index, contextPath);
    } finally {
      release();
    }
  }

  private readSnapshot<T>(
    featureName: string,
    reader: (index: ContextIndex, files: ContextFile[]) => T,
  ): T {
    const contextPath = getContextPath(this.projectRoot, featureName);
    ensureDir(contextPath);
    const release = acquireLockSync(this.indexPath(contextPath));
    try {
      const index = this.readIndex(featureName);
      return reader(index, this.listWithIndex(contextPath, index));
    } finally {
      release();
    }
  }

  private withEntry(
    index: ContextIndex,
    name: string,
    kind: ContextKind | undefined,
    timestamp: string,
    task?: string,
    existing?: ContextIndexEntry,
  ): ContextIndex {
    if (!kind) {
      return { ...index, revision: index.revision + 1 };
    }
    return {
      ...index,
      revision: index.revision + 1,
      entries: {
        ...index.entries,
        [name]: {
          kind,
          createdAt: existing?.createdAt ?? timestamp,
          updatedAt: timestamp,
          ...(task ? { task } : {}),
        },
      },
    };
  }

  private writeContentAndIndex(
    filePath: string,
    prior: string | null,
    content: string,
    indexPath: string,
    index: ContextIndex,
  ): void {
    writeAtomic(filePath, content);
    try {
      writeJsonAtomic(indexPath, index);
    } catch (error) {
      if (prior === null) fs.unlinkSync(filePath);
      else writeAtomic(filePath, prior);
      throw error;
    }
  }

  private mutationResult(
    name: string,
    content: string,
    updatedAt: string,
    kind: ContextKind | undefined,
    task: string | undefined,
    revision: number,
    filePath: string,
  ): ContextMutationResult {
    const classification = this.classifyContextName(name, kind);
    return {
      revision,
      path: filePath,
      file: {
        name,
        chars: content.length,
        updatedAt,
        kind,
        task,
        ...classification,
      },
    };
  }

  private durableFootprint(files: ContextFile[]): { fileCount: number; chars: number } {
    const durable = files.filter(file => file.kind === 'durable');
    return {
      fileCount: durable.length,
      chars: durable.reduce((sum, file) => sum + file.content.length, 0),
    };
  }

  private assertDurableGrowthAllowed(
    contextPath: string,
    index: ContextIndex,
    name: string,
    prior: string,
    next: string,
    priorKind: ContextKind | undefined,
    nextKind: ContextKind | undefined,
  ): void {
    const files = this.listWithIndex(contextPath, index);
    const current = this.durableFootprint(files);
    const priorDurable = priorKind === 'durable';
    const nextDurable = nextKind === 'durable';
    const projected = {
      fileCount: current.fileCount - (priorDurable ? 1 : 0) + (nextDurable ? 1 : 0),
      chars: current.chars - (priorDurable ? prior.length : 0) + (nextDurable ? next.length : 0),
    };
    const currentOverLimit = current.fileCount > RECOMMENDED_DURABLE_FILE_CAP
      || current.chars > RECOMMENDED_DURABLE_CHAR_CAP;
    const increasesFileCount = projected.fileCount > current.fileCount;
    const increasesChars = projected.chars > current.chars;
    const projectedOverLimit = projected.fileCount > RECOMMENDED_DURABLE_FILE_CAP
      || projected.chars > RECOMMENDED_DURABLE_CHAR_CAP;
    if (
      (currentOverLimit && (increasesFileCount || increasesChars))
      || (!currentOverLimit && projectedOverLimit)
    ) {
      throw new ContextMutationError(
        'durable_context_limit',
        'Durable context growth rejected. Consolidate or archive existing durable files before adding more.',
        {
          name,
          current,
          projected,
          caps: { files: RECOMMENDED_DURABLE_FILE_CAP, chars: RECOMMENDED_DURABLE_CHAR_CAP },
          consolidationHints: this.consolidationHints(files),
        },
      );
    }
  }

  private consolidationHints(files: ContextFile[]): string[] {
    const names = files.filter(file => file.kind === 'durable').map(file => file.name);
    const families = ['learnings', 'review', 'verification', 'evidence'];
    return families.flatMap(token => {
      const matches = names.filter(name => name.toLowerCase().includes(token));
      return matches.length > 1
        ? [`Consolidate ${matches.join(', ')} into one current ${token} context.`]
        : [];
    });
  }

  private appendArchiveRecord(
    contextPath: string,
    archivedAt: string,
    reason: string,
    moved: Array<{ name: string; destination: string }>,
  ): void {
    const manifestPath = path.join(contextPath, '..', 'archive', 'context-index.json');
    const manifest = readJson<{
      schemaVersion: 1;
      records: Array<{ name: string; archivedAt: string; reason: string; path: string }>;
    }>(manifestPath) ?? { schemaVersion: 1, records: [] };
    manifest.records.push(...moved.map(item => ({
      name: item.name,
      archivedAt,
      reason,
      path: item.destination,
    })));
    writeJsonAtomic(manifestPath, manifest);
  }

  private compareRecentContext(left: ContextFile, right: ContextFile): number {
    const timeDifference = new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime();
    return timeDifference || left.name.localeCompare(right.name);
  }
}
