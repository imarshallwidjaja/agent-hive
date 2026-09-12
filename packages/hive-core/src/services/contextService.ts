import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import {
  acquireLockSync,
  ensureDir,
  fileExists,
  getContextPath,
  getProjectContextPath,
  readText,
  writeAtomic,
  writeJsonAtomic,
} from '../utils/paths.js';
import {
  assertRequiredContextMetadata,
  CONTEXT_FRONTMATTER_MAX_BYTES,
  parseContextMetadata,
} from '../utils/context-metadata.js';
import type {
  ContextFile,
  ContextIndex,
  ContextIndexEntry,
  ContextKind,
  ContextMetadata,
  ContextRole,
  ContextScope,
} from '../types.js';

export type { ContextFile, ContextIndex, ContextIndexEntry, ContextKind, ContextMetadata, ContextRole, ContextScope };

export const OVERVIEW_CONTEXT_NAME = 'overview';
export const CONTEXT_INDEX_SCHEMA_VERSION = 1;
export const FEATURE_DURABLE_FILE_WARNING_CAP = 8;
export const FEATURE_DURABLE_CHAR_WARNING_CAP = 40_000;
export const PROJECT_DURABLE_FILE_WARNING_CAP = 32;
export const PROJECT_DURABLE_CHAR_WARNING_CAP = 160_000;
export const RECOMMENDED_DURABLE_FILE_CAP = FEATURE_DURABLE_FILE_WARNING_CAP;
export const RECOMMENDED_DURABLE_CHAR_CAP = FEATURE_DURABLE_CHAR_WARNING_CAP;
export const CONTEXT_DOCUMENT_MAX_BYTES = 1024 * 1024;
export const CONTEXT_CATALOG_MAX_BYTES = 16 * 1024;
export const CONTEXT_CHUNK_DEFAULT_BYTES = 16 * 1024;
export const CONTEXT_CHUNK_MAX_BYTES = 64 * 1024;
export const CONTEXT_CANDIDATE_MAX = 10_000;
export const CONTEXT_NAMESPACE_ENTRY_MAX = 20_000;
export const CONTEXT_SCANNED_HEADER_MAX_BYTES = 64 * 1024 * 1024;
export const CONTEXT_SCAN_WARNING_CANDIDATES = 1_000;
export const CONTEXT_SCAN_WARNING_HEADER_BYTES = 8 * 1024 * 1024;

const CONTEXT_QUERY_MAX_BYTES = 1024;
const CONTEXT_CURSOR_MAX_BYTES = 4096;
const CONTEXT_ARCHIVE_NAME_MAX_BYTES = 255;
const CONTEXT_ARCHIVE_NAMES_MAX = 1000;
const PENDING_MARKER_NAME = '.managed-mutation-pending.json';
const INDEX_NAME = 'index.json';
const CREATE_CONTEXT = Symbol('create-context');

export type ContextMutationErrorReason =
  | 'context_already_exists'
  | 'context_not_found'
  | 'invalid_context_name'
  | 'invalid_context_kind'
  | 'invalid_archive_reason'
  | 'invalid_argument'
  | 'stale_revision'
  | 'stale_content'
  | 'context_precondition_required'
  | 'context_index_invalid'
  | 'context_reconciliation_required'
  | 'context_inventory_too_large'
  | 'context_input_too_large'
  | 'context_response_too_large'
  | 'invalid_context_cursor'
  | 'stale_context_cursor'
  | 'invalid_context_metadata'
  | 'context_invalid_utf8'
  | 'context_changed_during_read'
  | 'context_symlink_refused';

export class ContextMutationError extends Error {
  constructor(
    readonly reason: ContextMutationErrorReason,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export interface ContextDurableMetrics {
  fileCount: number;
  bytes: number;
  chars: number | null;
  charsMeasurement: 'current' | 'unavailable';
  fileCap: number;
  charCap: number;
  overLimit: boolean;
  warnings: string[];
  consolidationHints: string[];
}

export interface ContextReadSummary {
  schemaVersion: 1;
  scope: ContextScope;
  revision: number;
  snapshot: string;
  complete: true;
  files: Array<Omit<ContextFile, 'content' | 'contentHash'>>;
  durable: ContextDurableMetrics;
  diagnostics: string[];
}

export interface ContextContentRead {
  scope: ContextScope;
  revision: number;
  snapshot: string;
  file: ContextFile;
  range: { start: number; end: number; totalBytes: number };
  complete: boolean;
  nextOffset?: number;
}

export interface ContextCatalogRead {
  schemaVersion: 1;
  scope: ContextScope;
  revision: number;
  snapshot: string;
  files: Array<Omit<ContextFile, 'content' | 'contentHash'>>;
  complete: boolean;
  nextCursor?: string;
  diagnostics: string[];
}

export interface ContextMutationResult {
  revision: number;
  file: Omit<ContextFile, 'content'> & { chars: number; bytes: number; contentHash: string };
  path: string;
}

export interface ContextArchiveResult {
  revision: number;
  archived: Array<{ name: string; archivePath: string; reason: string }>;
}

export interface ContextReadOptions {
  scanChars?: boolean;
}

export interface ContextRecoverySummary {
  scope: ContextScope;
  code: 'context_index_invalid' | 'context_reconciliation_required' | null;
  revision: number | null;
  control: {
    indexPresent: boolean;
    indexHash: string | null;
    indexErrors: string[];
    markerPresent: boolean;
    markerHash: string | null;
    markerErrors: string[];
    archiveManifestPresent: boolean;
    archiveManifestHash: string | null;
  };
  pendingMutation: {
    operation: string | null;
    startedAt: string | null;
    startingRevision: number | null;
    startingIndexDigest: string | null;
    names: string[];
    archiveDestinations: string[];
    totalNames: number;
    totalArchiveDestinations: number;
    complete: boolean;
  } | null;
  unclassified: Array<{ name: string; bytes: number; updatedAt: string }>;
  totalFiles: number;
  complete: boolean;
  recoveryInstructions: string[];
}

export interface ContextCatalogOptions {
  query?: string;
  cursor?: string;
  limit?: number;
}

export interface ContextContentOptions {
  offset?: number;
  maxBytes?: number;
  diagnosticMode?: 'primary-management';
}

interface ResolvedScope {
  scope: ContextScope;
  contextPath: string;
  archivePath: string;
  identity: string;
}

interface ControlState {
  index: ContextIndex;
  indexRaw: Buffer | null;
  indexDigest: string;
}

interface InventoryFile extends Omit<ContextFile, 'content' | 'contentHash'> {
  statFingerprint: string;
  headerFingerprint: string;
}

interface Inventory {
  files: InventoryFile[];
  snapshot: string;
  diagnostics: string[];
}

interface PendingMarker {
  schemaVersion: 1;
  operation: string;
  names: string[];
  archiveDestinations: string[];
  startedAt: string;
  startingRevision: number;
  startingIndexDigest: string;
}

const DEFAULT_CONTEXT_CLASSIFICATION = {
  role: 'durable',
  includeInExecution: true,
  includeInNetwork: true,
} satisfies Pick<ContextFile, 'role' | 'includeInExecution' | 'includeInNetwork'>;

const SPECIAL_CONTEXTS = {
  draft: { role: 'scratchpad', includeInExecution: false, includeInNetwork: false },
  'execution-decisions': { role: 'operational', includeInExecution: false, includeInNetwork: false },
  overview: { role: 'operational', includeInExecution: false, includeInNetwork: false },
} as const satisfies Record<string, Pick<ContextFile, 'role' | 'includeInExecution' | 'includeInNetwork'>>;

function sha256(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex');
}

function compareCodePoints(left: string, right: string): number {
  if (left === right) return 0;
  const leftPoints = [...left];
  const rightPoints = [...right];
  for (let index = 0; index < Math.min(leftPoints.length, rightPoints.length); index += 1) {
    const difference = leftPoints[index]!.codePointAt(0)! - rightPoints[index]!.codePointAt(0)!;
    if (difference !== 0) return difference;
  }
  return leftPoints.length - rightPoints.length;
}

function asciiFold(value: string): string {
  return value.replace(/[A-Z]/g, character => String.fromCharCode(character.charCodeAt(0) + 32));
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export class ContextService {
  constructor(
    private readonly projectRoot: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  write(featureName: string, fileName: string, content: string, expectedRevision: number, expectedContentHash: string): string {
    return this.replace(featureName, fileName, content, expectedRevision, expectedContentHash).path;
  }

  read(scope: string | ContextScope, fileName: string): string | null {
    const resolved = this.resolveScope(scope);
    const name = this.normalizeName(fileName);
    this.readControl(resolved, false);
    const filePath = this.contentPath(resolved, name);
    return readText(filePath);
  }

  list(scope: string | ContextScope): ContextFile[] {
    const resolved = this.resolveScope(scope);
    const before = this.observe(resolved);
    const files = before.inventory.files.map(file => {
      const filePath = this.contentPath(resolved, file.name);
      const content = fs.readFileSync(filePath, 'utf8');
      return { ...this.publicInventoryFile(file), content };
    });
    const after = this.observe(resolved);
    if (before.inventory.snapshot !== after.inventory.snapshot) {
      throw new ContextMutationError('context_changed_during_read', 'Context changed while it was being read. Retry the read.');
    }
    return files;
  }

  getOverview(scope: string | ContextScope): ContextFile | null {
    return this.list(scope).find(file => file.name === OVERVIEW_CONTEXT_NAME) ?? null;
  }

  delete(featureName: string, fileName: string, expectedRevision: number, expectedContentHash: string): boolean {
    return this.mutate(featureName, expectedRevision, (control, resolved) => {
      const name = this.normalizeName(fileName);
      this.assertExpectedHash(expectedContentHash);
      const filePath = this.contentPath(resolved, name);
      const prior = this.requireCurrentContent(filePath, name, expectedContentHash);
      const nextEntries = { ...control.index.entries };
      delete nextEntries[name];
      const nextIndex = { ...control.index, revision: control.index.revision + 1, entries: nextEntries };
      this.publish(control, resolved, 'delete', [name], [], () => {
        fs.unlinkSync(filePath);
        writeJsonAtomic(this.indexPath(resolved), nextIndex);
      }, () => {
        writeAtomic(filePath, prior);
        this.restoreIndex(resolved, control.indexRaw);
      });
      return true;
    });
  }

  archive(featureName: string, expectedRevision: number, expectedContentHashes: Record<string, string>): { archived: string[]; archivePath: string } {
    return this.mutate(featureName, expectedRevision, (control, resolved) => {
      if (!isPlainRecord(expectedContentHashes)) {
        throw new ContextMutationError('context_precondition_required', 'Expected content hashes are required for every archived context.');
      }
      const inventory = this.buildInventory(resolved, control);
      for (const file of inventory.files) {
        this.assertExpectedHash(expectedContentHashes[file.name]);
        this.requireCurrentContent(this.contentPath(resolved, file.name), file.name, expectedContentHashes[file.name]!);
      }
      if (inventory.files.length === 0) return { archived: [], archivePath: '' };
      const moves = this.prepareArchiveMoves(resolved, inventory.files.map(file => file.name), true);
      const nextIndex = { ...control.index, revision: control.index.revision + 1, entries: {} };
      this.publishArchive(control, resolved, 'archive', moves, nextIndex, undefined, 'Compatibility archive');
      return { archived: moves.map(item => item.name), archivePath: moves.length ? path.dirname(moves[0]!.destination) : '' };
    });
  }

  stats(scope: string | ContextScope): { count: number; totalChars: number; oldest?: string; newest?: string } {
    const contexts = this.list(scope);
    if (contexts.length === 0) return { count: 0, totalChars: 0 };
    const sorted = [...contexts].sort((left, right) => new Date(left.updatedAt).getTime() - new Date(right.updatedAt).getTime());
    return {
      count: contexts.length,
      totalChars: contexts.reduce((sum, context) => sum + context.content.length, 0),
      oldest: sorted[0]!.name,
      newest: sorted[sorted.length - 1]!.name,
    };
  }

  inspectSummary(scope: string | ContextScope): { status: 'ready'; summary: ContextReadSummary } | { status: 'busy' } {
    const resolved = this.resolveScope(scope);
    if (this.safeStat(`${this.indexPath(resolved)}.lock`) || this.safeStat(this.markerPath(resolved))) return { status: 'busy' };
    try {
      return { status: 'ready', summary: this.readSummary(scope, { scanChars: true }) };
    } catch (error) {
      if (error instanceof ContextMutationError && (error.reason === 'context_changed_during_read' || error.reason === 'context_reconciliation_required')) {
        return { status: 'busy' };
      }
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'busy' };
      throw error;
    }
  }

  readSummary(scope: string | ContextScope, options: ContextReadOptions = {}): ContextReadSummary {
    const resolved = this.resolveScope(scope);
    const observation = this.observe(resolved);
    let chars: number | null = null;
    if (options.scanChars) chars = this.scanDurableChars(resolved, observation.inventory.files);
    const summary = this.summarize(resolved, observation.control, observation.inventory, chars);
    this.assertResponseSize(summary, CONTEXT_CATALOG_MAX_BYTES);
    const after = this.observe(resolved);
    if (after.inventory.snapshot !== observation.inventory.snapshot) {
      throw new ContextMutationError('context_changed_during_read', 'Context changed while its summary was being read. Retry the read.');
    }
    return summary;
  }

  readCatalog(scope: string | ContextScope, options: ContextCatalogOptions = {}): ContextCatalogRead {
    this.assertBoundedText(options.query, CONTEXT_QUERY_MAX_BYTES, 'query');
    this.assertBoundedText(options.cursor, CONTEXT_CURSOR_MAX_BYTES, 'cursor');
    const resolved = this.resolveScope(scope);
    const observation = this.observe(resolved);
    const query = options.query ?? '';
    let position = 0;
    if (options.cursor) {
      const cursor = this.decodeCursor(options.cursor);
      if (cursor.scope !== resolved.identity || cursor.query !== query) {
        throw new ContextMutationError('invalid_context_cursor', 'Context cursor does not match this scope or query.');
      }
      if (cursor.snapshot !== observation.inventory.snapshot) {
        throw new ContextMutationError('stale_context_cursor', 'Context changed after this cursor was issued. Restart the catalog read.');
      }
      position = cursor.position;
    }
    const foldedQuery = asciiFold(query);
    const candidates = observation.inventory.files.filter(file => file.kind === 'durable' && (
      !foldedQuery || asciiFold([file.name, file.description, file.readWhen, file.owner].filter(Boolean).join('\n')).includes(foldedQuery)
    ));
    const limit = Math.max(1, Math.min(options.limit ?? 10, 50));
    const files: ContextCatalogRead['files'] = [];
    let nextPosition = position;
    while (nextPosition < candidates.length && files.length < limit) {
      const candidate = this.publicInventoryFile(candidates[nextPosition]!);
      const prospectivePosition = nextPosition + 1;
      const prospectiveComplete = prospectivePosition >= candidates.length;
      const trial = this.catalogEnvelope(resolved, observation, [...files, candidate], prospectiveComplete,
        prospectiveComplete ? undefined : this.encodeCursor({
          version: 1, scope: resolved.identity, query,
          snapshot: observation.inventory.snapshot, position: prospectivePosition,
        }));
      if (Buffer.byteLength(JSON.stringify(trial), 'utf8') > CONTEXT_CATALOG_MAX_BYTES) {
        if (files.length === 0) {
          throw new ContextMutationError('context_inventory_too_large', 'One context catalog entry exceeds the response construction limit.', { name: candidate.name });
        }
        break;
      }
      files.push(candidate);
      nextPosition += 1;
    }
    const complete = nextPosition >= candidates.length;
    const result = this.catalogEnvelope(resolved, observation, files, complete, complete ? undefined : this.encodeCursor({
      version: 1,
      scope: resolved.identity,
      query,
      snapshot: observation.inventory.snapshot,
      position: nextPosition,
    }));
    this.assertResponseSize(result, CONTEXT_CATALOG_MAX_BYTES);
    const after = this.observe(resolved);
    if (after.inventory.snapshot !== observation.inventory.snapshot) {
      throw new ContextMutationError('context_changed_during_read', 'Context changed while its catalog was being listed. Retry the read.');
    }
    return result;
  }

  readContent(scope: string | ContextScope, fileName: string, options: ContextContentOptions = {}): ContextContentRead | null {
    const resolved = this.resolveScope(scope);
    const name = this.normalizeName(fileName);
    const diagnostic = options.diagnosticMode === 'primary-management';
    const control = this.readControl(resolved, diagnostic);
    const filePath = this.contentPath(resolved, name);
    const before = this.safeStat(filePath);
    if (!before) return null;
    if (!before.isFile()) throw new ContextMutationError('context_not_found', `Context "${name}" is not a regular file.`);
    const maxBytes = options.maxBytes ?? CONTEXT_CHUNK_DEFAULT_BYTES;
    if (!Number.isInteger(maxBytes) || maxBytes < 256 || maxBytes > CONTEXT_CHUNK_MAX_BYTES) {
      throw new ContextMutationError('context_input_too_large', `maxBytes must be between 256 and ${CONTEXT_CHUNK_MAX_BYTES}.`);
    }
    const offset = options.offset ?? 0;
    if (!Number.isInteger(offset) || offset < 0 || offset > before.size) {
      throw new ContextMutationError('invalid_argument', 'Context byte offset is outside the document.');
    }
    const streamed = this.streamFile(filePath, offset, maxBytes);
    const after = this.safeStat(filePath);
    if (!after || this.statFingerprint(before) !== this.statFingerprint(after)) {
      throw new ContextMutationError('context_changed_during_read', 'Context changed during the named read. Retry from the beginning.');
    }
    const currentControl = this.readControl(resolved, diagnostic);
    if (currentControl.indexDigest !== control.indexDigest || currentControl.index.revision !== control.index.revision) {
      throw new ContextMutationError('context_changed_during_read', 'Context control data changed during the named read. Retry from the beginning.');
    }
    const indexed = control.index.entries[name];
    const kind = diagnostic && control.indexRaw !== null && !indexed ? undefined : this.effectiveKind(name, indexed?.kind);
    const classification = diagnostic && kind === undefined && !this.isSpecialName(name)
      ? { role: 'operational' as const, includeInExecution: false, includeInNetwork: false }
      : this.classifyContextName(name, kind);
    const metadata = parseContextMetadata(streamed.header);
    const metadataFields = this.metadataFields(metadata, resolved.scope.type);
    if (indexed?.lastManagedContentHash && indexed.lastManagedContentHash !== streamed.hash) {
      metadataFields.warnings = [...(metadataFields.warnings ?? []), 'Content bytes differ from the last managed write.'];
    }
    const baseFile: ContextFile = {
      name,
      content: streamed.content,
      contentHash: streamed.hash,
      bytes: before.size,
      createdAt: indexed?.createdAt ?? before.birthtime.toISOString(),
      updatedAt: indexed?.updatedAt ?? before.mtime.toISOString(),
      kind,
      task: indexed?.task,
      ...classification,
      ...metadataFields,
    };
    let end = streamed.end;
    let result = this.contentEnvelope(resolved, control, baseFile, offset, end, before.size);
    while (Buffer.byteLength(JSON.stringify(result), 'utf8') > maxBytes && end > offset) {
      end = offset + Math.floor((end - offset) * 0.8);
      while (end > offset && streamed.raw[end - offset] !== undefined && (streamed.raw[end - offset]! & 0xc0) === 0x80) end -= 1;
      const raw = streamed.raw.subarray(0, end - offset);
      let content: string;
      try { content = new TextDecoder('utf-8', { fatal: true }).decode(raw); }
      catch { continue; }
      result = this.contentEnvelope(resolved, control, { ...baseFile, content }, offset, end, before.size);
    }
    if (end === offset && offset < before.size) {
      throw new ContextMutationError('context_response_too_large', 'The named-read response envelope leaves no room for content at maxBytes.');
    }
    if (Buffer.byteLength(JSON.stringify(result), 'utf8') > maxBytes) {
      throw new ContextMutationError('context_response_too_large', 'The named-read response envelope exceeds maxBytes.');
    }
    return result;
  }

  readRecoverySummary(scope: string | ContextScope, options: { diagnosticMode: 'primary-management' }): ContextRecoverySummary {
    if (options.diagnosticMode !== 'primary-management') {
      throw new ContextMutationError('invalid_argument', 'Primary-management diagnostic mode is required.');
    }
    const resolved = this.resolveScope(scope);
    this.assertNamespaceSafe(resolved.contextPath);
    const marker = this.readFileBuffer(this.markerPath(resolved));
    const index = this.readFileBuffer(this.indexPath(resolved));
    const manifestPath = path.join(resolved.archivePath, '..', 'context-index.json');
    this.assertNamespaceSafe(path.dirname(manifestPath));
    const manifest = this.readFileBuffer(manifestPath);
    const indexErrors: string[] = [];
    const markerErrors: string[] = [];
    const boundedText = (value: unknown): string | null => typeof value === 'string' ? value.slice(0, 128) : null;
    const validRevision = (value: unknown): number | null => Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : null;
    const parseControl = (raw: Buffer | null, errors: string[]): unknown => {
      if (raw === null) return null;
      try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)); }
      catch (error) {
        errors.push(`Invalid JSON: ${String(error).slice(0, 256)}`);
        return null;
      }
    };
    const parsedIndex = parseControl(index, indexErrors);
    const revision = isPlainRecord(parsedIndex) ? validRevision(parsedIndex.revision) : null;
    if (index !== null && indexErrors.length === 0) {
      try { this.validateIndex(parsedIndex); }
      catch (error) { indexErrors.push(String(error).slice(0, 256)); }
    }
    const parsedMarker = parseControl(marker, markerErrors);
    let pendingMutation: ContextRecoverySummary['pendingMutation'] = null;
    if (isPlainRecord(parsedMarker)) {
      const names = Array.isArray(parsedMarker.names) ? parsedMarker.names : [];
      const destinations = Array.isArray(parsedMarker.archiveDestinations) ? parsedMarker.archiveDestinations : [];
      if (parsedMarker.schemaVersion !== 1 || typeof parsedMarker.operation !== 'string'
        || !Array.isArray(parsedMarker.names) || !names.every(name => typeof name === 'string')
        || !Array.isArray(parsedMarker.archiveDestinations) || !destinations.every(name => typeof name === 'string')
        || typeof parsedMarker.startedAt !== 'string' || validRevision(parsedMarker.startingRevision) === null
        || typeof parsedMarker.startingIndexDigest !== 'string') {
        markerErrors.push('Pending marker schema is invalid or incomplete; inspect its raw bytes out of band.');
      }
      pendingMutation = {
        operation: boundedText(parsedMarker.operation), startedAt: boundedText(parsedMarker.startedAt),
        startingRevision: validRevision(parsedMarker.startingRevision), startingIndexDigest: boundedText(parsedMarker.startingIndexDigest),
        names: names.slice(0, 4).filter((name): name is string => typeof name === 'string').map(name => name.slice(0, 256)),
        archiveDestinations: destinations.slice(0, 4).filter((name): name is string => typeof name === 'string').map(name => name.slice(0, 256)),
        totalNames: names.length, totalArchiveDestinations: destinations.length,
        complete: markerErrors.length === 0 && names.length <= 4 && destinations.length <= 4
          && [...names, ...destinations].every(value => typeof value === 'string' && value.length <= 256)
          && [parsedMarker.operation, parsedMarker.startedAt, parsedMarker.startingIndexDigest]
            .every(value => typeof value === 'string' && value.length <= 128),
      };
      while (Buffer.byteLength(JSON.stringify(pendingMutation), 'utf8') > 4096) {
        if (pendingMutation.archiveDestinations.length) pendingMutation.archiveDestinations.pop();
        else pendingMutation.names.pop();
        pendingMutation.complete = false;
      }
    } else if (marker !== null && markerErrors.length === 0) {
      markerErrors.push('Pending marker must be an object.');
    }
    const entries = fs.existsSync(resolved.contextPath) ? fs.readdirSync(resolved.contextPath, { withFileTypes: true }) : [];
    if (entries.length > CONTEXT_NAMESPACE_ENTRY_MAX) throw new ContextMutationError('context_inventory_too_large', 'Diagnostic context namespace is too large.');
    const markdown = entries.filter(entry => entry.name.endsWith('.md'));
    if (markdown.length > CONTEXT_CANDIDATE_MAX) throw new ContextMutationError('context_inventory_too_large', 'Diagnostic Markdown inventory is too large.');
    for (const entry of markdown) if (entry.isSymbolicLink()) throw new ContextMutationError('context_symlink_refused', `Context symlink "${entry.name}" is not allowed.`);
    const names = markdown.filter(entry => entry.isFile()).map(entry => this.normalizeName(entry.name.slice(0, -3))).sort(compareCodePoints);
    const result: ContextRecoverySummary = {
      scope: resolved.scope,
      code: marker !== null ? 'context_reconciliation_required' : indexErrors.length ? 'context_index_invalid' : null,
      revision,
      control: {
        indexPresent: index !== null,
        indexHash: index && sha256(index),
        markerPresent: marker !== null,
        markerHash: marker && sha256(marker),
        indexErrors,
        markerErrors,
        archiveManifestPresent: manifest !== null,
        archiveManifestHash: manifest && sha256(manifest),
      },
      pendingMutation,
      unclassified: [],
      totalFiles: names.length,
      complete: names.length === 0,
      recoveryInstructions: [
        'Quiesce all writers and preserve copies of the Markdown, index, pending marker, and archive manifest before editing.',
        'Inspect raw control files and archive destinations out of band. Compare surviving bytes with known records; do not infer durable classification.',
        'Restore or correct the index and archive manifest consistently with the preserved content. Never delete an invalid index to recover legacy defaults.',
        'Explicitly reconcile and remove the pending marker only after verifying publication or complete rollback. Retry normal reads before resuming managed writes.',
        'This is a bounded inventory sample. Inspect omitted names and truncated pending details locally; exact named diagnostic reads remain available.',
      ],
    };
    for (const name of names) {
      const stat = fs.statSync(this.contentPath(resolved, name));
      result.unclassified.push({ name, bytes: stat.size, updatedAt: stat.mtime.toISOString() });
      result.complete = result.unclassified.length === names.length;
      if (Buffer.byteLength(JSON.stringify(result), 'utf8') > CONTEXT_CATALOG_MAX_BYTES) {
        result.unclassified.pop();
        result.complete = false;
        break;
      }
    }
    this.assertResponseSize(result, CONTEXT_CATALOG_MAX_BYTES);
    return result;
  }

  create(
    scope: string | ContextScope,
    fileName: string,
    content: string,
    options: { kind?: ContextKind; task?: string } = {},
  ): ContextMutationResult {
    return this.mutate(scope, CREATE_CONTEXT, (control, resolved) => {
      const name = this.normalizeName(fileName);
      this.assertContentInput(content);
      const filePath = this.contentPath(resolved, name);
      if (fileExists(filePath)) {
        throw new ContextMutationError('context_already_exists', `Context "${name}" already exists. Read it, then replace with its current revision and content hash.`, { name, revision: control.index.revision });
      }
      const kind = this.resolveMutableKind(name, options.kind);
      const metadata = parseContextMetadata(Buffer.from(content));
      if (kind === 'durable') this.assertMetadata(metadata, resolved.scope.type);
      const timestamp = this.now().toISOString();
      const hash = sha256(content);
      const nextIndex = this.withEntry(control.index, name, kind, timestamp, options.task, undefined, hash);
      this.publishContent(control, resolved, 'create', name, filePath, null, content, nextIndex);
      return this.mutationResult(resolved, name, content, timestamp, kind, options.task, nextIndex.revision, filePath, hash, metadata);
    });
  }

  replace(
    scope: string | ContextScope,
    fileName: string,
    content: string,
    expectedRevision: number,
    expectedContentHash: string,
    options: { kind?: ContextKind; task?: string } = {},
  ): ContextMutationResult {
    return this.mutate(scope, expectedRevision, (control, resolved) => {
      const name = this.normalizeName(fileName);
      this.assertExpectedHash(expectedContentHash);
      this.assertContentInput(content);
      const filePath = this.contentPath(resolved, name);
      const prior = this.requireCurrentContent(filePath, name, expectedContentHash);
      const existing = control.index.entries[name];
      const kind = this.resolveMutableKind(name, options.kind ?? existing?.kind);
      const metadata = parseContextMetadata(Buffer.from(content));
      if (kind === 'durable' && resolved.scope.type === 'project') this.assertMetadata(metadata, 'project');
      const timestamp = this.now().toISOString();
      const hash = sha256(content);
      const nextIndex = this.withEntry(control.index, name, kind, timestamp, options.task ?? existing?.task, existing, hash);
      this.publishContent(control, resolved, 'replace', name, filePath, prior, content, nextIndex);
      return this.mutationResult(resolved, name, content, timestamp, kind, options.task ?? existing?.task, nextIndex.revision, filePath, hash, metadata);
    });
  }

  append(
    scope: string | ContextScope,
    fileName: string,
    content: string,
    expectedRevision: number,
    expectedContentHash: string,
    options: { section?: string; task?: string } = {},
  ): ContextMutationResult {
    return this.mutate(scope, expectedRevision, (control, resolved) => {
      const name = this.normalizeName(fileName);
      this.assertExpectedHash(expectedContentHash);
      this.assertContentInput(content);
      const filePath = this.contentPath(resolved, name);
      const priorBuffer = this.requireCurrentContent(filePath, name, expectedContentHash);
      let prior: string;
      try { prior = new TextDecoder('utf-8', { fatal: true }).decode(priorBuffer); }
      catch { throw new ContextMutationError('context_invalid_utf8', `Context "${name}" is not valid UTF-8.`); }
      const existing = control.index.entries[name];
      const kind = this.resolveMutableKind(name, existing?.kind);
      const timestamp = this.now().toISOString();
      const heading = options.section ? `### ${options.section}\n\n` : '';
      const separator = prior.endsWith('\n') ? '\n' : '\n\n';
      const nextContent = `${prior}${separator}<!-- appended ${timestamp} -->\n${heading}${content}\n`;
      this.assertContentInput(nextContent);
      const hash = sha256(nextContent);
      const nextIndex = this.withEntry(control.index, name, kind, timestamp, options.task ?? existing?.task, existing, hash);
      this.publishContent(control, resolved, 'append', name, filePath, priorBuffer, nextContent, nextIndex);
      return this.mutationResult(resolved, name, nextContent, timestamp, kind, options.task ?? existing?.task, nextIndex.revision, filePath, hash, parseContextMetadata(Buffer.from(nextContent)));
    });
  }

  archiveSelected(
    scope: string | ContextScope,
    names: string[],
    reason: string,
    expectedRevision: number,
    expectedContentHashes: Record<string, string>,
  ): ContextArchiveResult {
    if (!reason.trim()) throw new ContextMutationError('invalid_archive_reason', 'Archive reason must not be blank.');
    this.assertBoundedText(reason, CONTEXT_DOCUMENT_MAX_BYTES, 'archive reason');
    return this.mutate(scope, expectedRevision, (control, resolved) => {
      if (!isPlainRecord(expectedContentHashes)) {
        throw new ContextMutationError('context_precondition_required', 'Expected content hashes are required for every archived context.');
      }
      const normalized = this.normalizeArchiveNames(names);
      for (const name of normalized) {
        this.assertExpectedHash(expectedContentHashes[name]);
        this.requireCurrentContent(this.contentPath(resolved, name), name, expectedContentHashes[name]!);
      }
      const moves = this.prepareArchiveMoves(resolved, normalized, false);
      const nextEntries = { ...control.index.entries };
      for (const name of normalized) delete nextEntries[name];
      const nextIndex = { ...control.index, revision: control.index.revision + 1, entries: nextEntries };
      const timestamp = this.now().toISOString();
      this.publishArchive(control, resolved, 'archive-selected', moves, nextIndex, timestamp, reason.trim());
      return { revision: nextIndex.revision, archived: moves.map(item => ({ name: item.name, archivePath: item.destination, reason: reason.trim() })) };
    });
  }

  private resolveScope(input: string | ContextScope): ResolvedScope {
    const scope: ContextScope = typeof input === 'string' ? { type: 'feature', featureName: input } : input;
    if (!scope || (scope.type !== 'project' && scope.type !== 'feature')) {
      throw new ContextMutationError('invalid_argument', 'Context scope must be project or feature.');
    }
    if (scope.type === 'feature' && (!scope.featureName || typeof scope.featureName !== 'string')) {
      throw new ContextMutationError('invalid_argument', 'Feature context scope requires featureName.');
    }
    if (scope.type === 'feature' && (scope.featureName === '.' || scope.featureName === '..' || /[\\/\0]/.test(scope.featureName))) {
      throw new ContextMutationError('invalid_argument', 'Feature context scope requires a simple logical name without path segments.');
    }
    const contextPath = scope.type === 'project' ? getProjectContextPath(this.projectRoot) : getContextPath(this.projectRoot, scope.featureName);
    const archivePath = scope.type === 'project'
      ? path.join(this.projectRoot, '.hive', 'archive', 'context')
      : path.join(contextPath, '..', 'archive', 'context');
    return { scope, contextPath, archivePath, identity: scope.type === 'project' ? 'project' : `feature:${scope.featureName}` };
  }

  private observe(resolved: ResolvedScope): { control: ControlState; inventory: Inventory } {
    const control = this.readControl(resolved, false);
    const inventory = this.buildInventory(resolved, control);
    const secondControl = this.readControl(resolved, false);
    if (secondControl.indexDigest !== control.indexDigest || secondControl.index.revision !== control.index.revision) {
      throw new ContextMutationError('context_changed_during_read', 'Context control data changed during listing. Retry the read.');
    }
    return { control, inventory };
  }

  private readControl(resolved: ResolvedScope, diagnostic: boolean): ControlState {
    this.assertNamespaceSafe(resolved.contextPath);
    const markerPath = this.markerPath(resolved);
    const marker = this.safeStat(markerPath);
    if (marker && !diagnostic) {
      throw new ContextMutationError('context_reconciliation_required', 'A managed context mutation was interrupted. A primary manager must inspect and reconcile it before discovery or mutation.', { markerPath });
    }
    const indexPath = this.indexPath(resolved);
    const raw = this.readFileBuffer(indexPath);
    if (raw === null) return { index: { schemaVersion: 1, revision: 0, entries: {} }, indexRaw: null, indexDigest: 'missing' };
    let parsed: unknown;
    try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)); }
    catch (error) {
      if (diagnostic) return { index: { schemaVersion: 1, revision: 0, entries: {} }, indexRaw: raw, indexDigest: sha256(raw) };
      throw new ContextMutationError('context_index_invalid', 'Context index is invalid JSON and requires primary management.', { error: error instanceof Error ? error.message : String(error) });
    }
    try { this.validateIndex(parsed); }
    catch (error) {
      if (diagnostic) return { index: { schemaVersion: 1, revision: 0, entries: {} }, indexRaw: raw, indexDigest: sha256(raw) };
      throw error;
    }
    return { index: parsed, indexRaw: raw, indexDigest: sha256(raw) };
  }

  private validateIndex(value: unknown): asserts value is ContextIndex {
    const fail = (message: string): never => { throw new ContextMutationError('context_index_invalid', message); };
    if (!isPlainRecord(value)) fail('Context index has an invalid shape.');
    const record = value as Record<string, unknown>;
    if (record.schemaVersion !== CONTEXT_INDEX_SCHEMA_VERSION) fail('Context index schema version is unsupported.');
    if (!Number.isInteger(record.revision) || (record.revision as number) < 0) fail('Context index revision is invalid.');
    if (!isPlainRecord(record.entries)) fail('Context index entries have an invalid shape.');
    for (const [name, entry] of Object.entries(record.entries as Record<string, unknown>)) {
      if (!isPlainRecord(entry) || (entry.kind !== 'durable' && entry.kind !== 'evidence')
        || typeof entry.createdAt !== 'string' || typeof entry.updatedAt !== 'string'
        || (entry.task !== undefined && typeof entry.task !== 'string')
        || (entry.lastManagedContentHash !== undefined && !/^[a-f0-9]{64}$/.test(String(entry.lastManagedContentHash)))) {
        fail(`Context index entry "${name}" is invalid.`);
      }
    }
  }

  private buildInventory(resolved: ResolvedScope, control: ControlState): Inventory {
    if (!fs.existsSync(resolved.contextPath)) return { files: [], snapshot: sha256(`${control.indexDigest}\n${control.index.revision}\nempty`), diagnostics: [] };
    const entries = fs.readdirSync(resolved.contextPath, { withFileTypes: true });
    if (entries.length > CONTEXT_NAMESPACE_ENTRY_MAX) {
      throw new ContextMutationError('context_inventory_too_large', `Context namespace exceeds ${CONTEXT_NAMESPACE_ENTRY_MAX} entries.`);
    }
    const markdown = entries.filter(entry => entry.name.endsWith('.md'));
    if (markdown.length > CONTEXT_CANDIDATE_MAX) {
      throw new ContextMutationError('context_inventory_too_large', `Context namespace exceeds ${CONTEXT_CANDIDATE_MAX} Markdown candidates.`);
    }
    const diagnostics: string[] = [];
    if (markdown.length > CONTEXT_SCAN_WARNING_CANDIDATES) diagnostics.push(`Large context scan: ${markdown.length} Markdown candidates.`);
    let headerBytes = 0;
    const files: InventoryFile[] = [];
    for (const entry of markdown) {
      if (entry.isSymbolicLink()) throw new ContextMutationError('context_symlink_refused', `Context symlink "${entry.name}" is not allowed.`);
      if (!entry.isFile()) continue;
      const name = this.normalizeName(entry.name.slice(0, -3));
      const filePath = this.contentPath(resolved, name);
      const stat = fs.statSync(filePath);
      const header = this.readHeader(filePath);
      headerBytes += header.length;
      if (headerBytes > CONTEXT_SCANNED_HEADER_MAX_BYTES) {
        throw new ContextMutationError('context_inventory_too_large', `Context header scan exceeds ${CONTEXT_SCANNED_HEADER_MAX_BYTES} bytes.`);
      }
      const indexed = control.index.entries[name];
      const kind = this.effectiveKind(name, indexed?.kind);
      const metadata = parseContextMetadata(header);
      files.push({
        name,
        bytes: stat.size,
        createdAt: indexed?.createdAt ?? stat.birthtime.toISOString(),
        updatedAt: indexed?.updatedAt ?? stat.mtime.toISOString(),
        kind,
        task: indexed?.task,
        ...this.classifyContextName(name, kind),
        ...this.metadataFields(metadata, resolved.scope.type),
        statFingerprint: this.statFingerprint(stat),
        headerFingerprint: sha256(header),
      });
    }
    files.sort((left, right) => compareCodePoints(left.name, right.name));
    if (headerBytes > CONTEXT_SCAN_WARNING_HEADER_BYTES) diagnostics.push(`Large context header scan: ${headerBytes} bytes.`);
    if (control.indexRaw === null && files.length > 0) diagnostics.push('Context index is missing; unindexed non-reserved Markdown is treated as legacy durable context.');
    const snapshotMaterial = files.map(file => `${file.name}\0${file.statFingerprint}\0${file.headerFingerprint}`).join('\n');
    return { files, diagnostics, snapshot: sha256(`${control.indexDigest}\n${control.index.revision}\n${snapshotMaterial}`) };
  }

  private summarize(resolved: ResolvedScope, control: ControlState, inventory: Inventory, chars: number | null): ContextReadSummary {
    const durableFiles = inventory.files.filter(file => file.kind === 'durable');
    const fileCap = resolved.scope.type === 'project' ? PROJECT_DURABLE_FILE_WARNING_CAP : FEATURE_DURABLE_FILE_WARNING_CAP;
    const charCap = resolved.scope.type === 'project' ? PROJECT_DURABLE_CHAR_WARNING_CAP : FEATURE_DURABLE_CHAR_WARNING_CAP;
    const bytes = durableFiles.reduce((sum, file) => sum + (file.bytes ?? 0), 0);
    const warnings = [...inventory.diagnostics];
    if (durableFiles.length > fileCap) warnings.push(`Review durable context: ${durableFiles.length} files exceeds the ${fileCap}-file ${resolved.scope.type} guideline. Archive or consolidate with an explicit management call.`);
    if (chars !== null && chars > charCap) warnings.push(`Review durable context: ${chars} UTF-16 characters exceeds the ${charCap}-character ${resolved.scope.type} guideline. Archive or consolidate with an explicit management call.`);
    const today = this.now().toISOString().slice(0, 10);
    if (resolved.scope.type === 'project') {
      for (const file of durableFiles) {
        if (!file.owner || !file.reviewAfter) warnings.push(`Project context "${file.name}" is missing owner or review_after metadata.`);
        else if (file.reviewAfter < today) warnings.push(`Project context "${file.name}" review was due ${file.reviewAfter}; re-review and replace it deliberately.`);
      }
    }
    return {
      schemaVersion: 1,
      scope: resolved.scope,
      revision: control.index.revision,
      snapshot: inventory.snapshot,
      complete: true,
      files: inventory.files.map(file => this.publicInventoryFile(file)),
      durable: {
        fileCount: durableFiles.length,
        bytes,
        chars,
        charsMeasurement: chars === null ? 'unavailable' : 'current',
        fileCap,
        charCap,
        overLimit: durableFiles.length > fileCap || (chars !== null && chars > charCap),
        warnings,
        consolidationHints: this.consolidationHints(inventory.files),
      },
      diagnostics: inventory.diagnostics,
    };
  }

  private catalogEnvelope(resolved: ResolvedScope, observation: { control: ControlState; inventory: Inventory }, files: ContextCatalogRead['files'], complete: boolean, nextCursor?: string): ContextCatalogRead {
    return { schemaVersion: 1, scope: resolved.scope, revision: observation.control.index.revision, snapshot: observation.inventory.snapshot, files, complete, ...(nextCursor ? { nextCursor } : {}), diagnostics: observation.inventory.diagnostics };
  }

  private contentEnvelope(resolved: ResolvedScope, control: ControlState, file: ContextFile, start: number, end: number, totalBytes: number): ContextContentRead {
    return { scope: resolved.scope, revision: control.index.revision, snapshot: sha256(`${control.indexDigest}\n${control.index.revision}`), file, range: { start, end, totalBytes }, complete: end >= totalBytes, ...(end < totalBytes ? { nextOffset: end } : {}) };
  }

  private mutate<T>(scope: string | ContextScope, expectedRevision: number | typeof CREATE_CONTEXT, mutation: (control: ControlState, resolved: ResolvedScope) => T): T {
    if (expectedRevision !== CREATE_CONTEXT && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)) {
      throw new ContextMutationError('context_precondition_required', 'Read the current revision before mutating existing context.');
    }
    const resolved = this.resolveScope(scope);
    this.assertNamespaceSafe(resolved.contextPath);
    ensureDir(resolved.contextPath);
    this.assertNamespaceSafe(resolved.contextPath);
    const release = acquireLockSync(this.indexPath(resolved));
    try {
      const control = this.readControl(resolved, false);
      if (expectedRevision !== CREATE_CONTEXT && control.index.revision !== expectedRevision) {
        throw new ContextMutationError('stale_revision', `Context changed since revision ${expectedRevision}; current revision is ${control.index.revision}.`, { expectedRevision, revision: control.index.revision });
      }
      return mutation(control, resolved);
    } finally {
      release();
    }
  }

  private publishContent(control: ControlState, resolved: ResolvedScope, operation: string, name: string, filePath: string, prior: Buffer | null, content: string, nextIndex: ContextIndex): void {
    this.publish(control, resolved, operation, [name], [], () => {
      writeAtomic(filePath, content);
      writeJsonAtomic(this.indexPath(resolved), nextIndex);
    }, () => {
      if (prior === null) {
        if (fileExists(filePath)) fs.unlinkSync(filePath);
      } else writeAtomic(filePath, prior);
      this.restoreIndex(resolved, control.indexRaw);
    });
  }

  private publishArchive(control: ControlState, resolved: ResolvedScope, operation: string, moves: Array<{ name: string; source: string; destination: string }>, nextIndex: ContextIndex, timestamp: string | undefined, reason: string): void {
    const manifestPath = path.join(resolved.archivePath, '..', 'context-index.json');
    const priorManifest = timestamp ? this.readFileBuffer(manifestPath) : null;
    const moved: typeof moves = [];
    this.publish(control, resolved, operation, moves.map(item => item.name), moves.map(item => item.destination), () => {
      for (const item of moves) {
        fs.copyFileSync(item.source, item.destination, fs.constants.COPYFILE_EXCL);
        moved.push(item);
        fs.unlinkSync(item.source);
      }
      writeJsonAtomic(this.indexPath(resolved), nextIndex);
      if (timestamp) this.appendArchiveRecord(manifestPath, timestamp, reason, moved);
    }, () => {
      this.restoreIndex(resolved, control.indexRaw);
      if (timestamp) this.restoreIndex({ ...resolved, contextPath: path.dirname(manifestPath) }, priorManifest, path.basename(manifestPath));
      for (const item of [...moved].reverse()) {
        if (!fileExists(item.destination)) continue;
        if (!fileExists(item.source)) fs.renameSync(item.destination, item.source);
        else fs.unlinkSync(item.destination);
      }
    });
  }

  private publish(control: ControlState, resolved: ResolvedScope, operation: string, names: string[], archiveDestinations: string[], apply: () => void, rollback: () => void): void {
    const markerPath = this.markerPath(resolved);
    const marker: PendingMarker = { schemaVersion: 1, operation, names, archiveDestinations, startedAt: new Date().toISOString(), startingRevision: control.index.revision, startingIndexDigest: control.indexDigest };
    writeJsonAtomic(markerPath, marker);
    try {
      apply();
      fs.unlinkSync(markerPath);
    } catch (error) {
      try {
        rollback();
        fs.unlinkSync(markerPath);
      } catch {
        // The marker intentionally survives when complete rollback cannot be proven.
      }
      throw error;
    }
  }

  private prepareArchiveMoves(resolved: ResolvedScope, names: string[], compatibility: boolean): Array<{ name: string; source: string; destination: string }> {
    const archivePath = compatibility ? path.join(resolved.contextPath, '..', 'archive') : resolved.archivePath;
    this.assertNamespaceSafe(archivePath);
    ensureDir(archivePath);
    this.assertNamespaceSafe(archivePath);
    const timestamp = this.now().toISOString().replace(/[:.]/g, '-');
    const reserved = new Set<string>();
    return names.map(name => {
      const source = this.contentPath(resolved, name);
      if (!fileExists(source)) throw new ContextMutationError('context_not_found', `Context "${name}" does not exist.`, { name });
      const stem = `${timestamp}_${name}`;
      let suffix = 1;
      let destination = path.join(archivePath, `${stem}.md`);
      while (fileExists(destination) || reserved.has(destination)) {
        suffix += 1;
        destination = path.join(archivePath, `${stem}-${suffix}.md`);
      }
      this.assertContained(archivePath, destination);
      this.assertNoSymlink(archivePath, destination);
      reserved.add(destination);
      return { name, source, destination };
    });
  }

  private withEntry(index: ContextIndex, name: string, kind: ContextKind | undefined, timestamp: string, task: string | undefined, existing: ContextIndexEntry | undefined, hash: string): ContextIndex {
    if (!kind) return { ...index, revision: index.revision + 1 };
    return { ...index, revision: index.revision + 1, entries: { ...index.entries, [name]: { kind, createdAt: existing?.createdAt ?? timestamp, updatedAt: timestamp, ...(task ? { task } : {}), lastManagedContentHash: hash } } };
  }

  private mutationResult(resolved: ResolvedScope, name: string, content: string, updatedAt: string, kind: ContextKind | undefined, task: string | undefined, revision: number, filePath: string, hash: string, metadata: ReturnType<typeof parseContextMetadata>): ContextMutationResult {
    return { revision, path: filePath, file: { name, chars: content.length, bytes: Buffer.byteLength(content), contentHash: hash, updatedAt, kind, task, ...this.classifyContextName(name, kind), ...this.metadataFields(metadata, resolved.scope.type) } };
  }

  private metadataFields(metadata: ReturnType<typeof parseContextMetadata>, scopeType: 'feature' | 'project'): Pick<ContextFile, 'description' | 'readWhen' | 'owner' | 'reviewAfter' | 'warnings'> {
    const warnings = [...metadata.warnings];
    if (!metadata.description) warnings.push('Missing metadata field description.');
    if (!metadata.readWhen) warnings.push('Missing metadata field read_when.');
    if (scopeType === 'project' && !metadata.owner) warnings.push('Missing metadata field owner.');
    if (scopeType === 'project' && !metadata.reviewAfter) warnings.push('Missing metadata field review_after.');
    return { description: metadata.description, readWhen: metadata.readWhen, owner: metadata.owner, reviewAfter: metadata.reviewAfter, warnings };
  }

  private assertMetadata(metadata: ReturnType<typeof parseContextMetadata>, scopeType: 'feature' | 'project'): void {
    try { assertRequiredContextMetadata(metadata, scopeType); }
    catch (error) { throw new ContextMutationError('invalid_context_metadata', error instanceof Error ? error.message : String(error)); }
  }

  private streamFile(filePath: string, offset: number, allowance: number): { hash: string; content: string; raw: Buffer; end: number; header: Buffer } {
    const fd = fs.openSync(filePath, 'r');
    const hash = createHash('sha256');
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const work = Buffer.allocUnsafe(64 * 1024);
    const chunks: Buffer[] = [];
    const headerChunks: Buffer[] = [];
    let position = 0;
    try {
      while (true) {
        const count = fs.readSync(fd, work, 0, work.length, position);
        if (count === 0) break;
        const chunk = Buffer.from(work.subarray(0, count));
        hash.update(chunk);
        try { decoder.decode(chunk, { stream: true }); }
        catch { throw new ContextMutationError('context_invalid_utf8', 'Context is not valid UTF-8.'); }
        if (position < CONTEXT_FRONTMATTER_MAX_BYTES) headerChunks.push(chunk.subarray(0, Math.min(count, CONTEXT_FRONTMATTER_MAX_BYTES - position)));
        const chunkStart = position;
        const chunkEnd = position + count;
        const wantedEnd = offset + allowance;
        if (chunkEnd > offset && chunkStart < wantedEnd) chunks.push(chunk.subarray(Math.max(0, offset - chunkStart), Math.min(count, wantedEnd - chunkStart)));
        position += count;
      }
      try { decoder.decode(); }
      catch { throw new ContextMutationError('context_invalid_utf8', 'Context is not valid UTF-8.'); }
    } finally { fs.closeSync(fd); }
    const raw = Buffer.concat(chunks);
    if (offset > 0 && raw.length > 0 && (raw[0]! & 0xc0) === 0x80) throw new ContextMutationError('invalid_argument', 'Context byte offset must be on a UTF-8 character boundary.');
    let end = offset + raw.length;
    while (end > offset && end < position && raw.length > 0 && (raw[end - offset - 1]! & 0xc0) === 0xc0) end -= 1;
    let bounded = raw.subarray(0, end - offset);
    let content: string;
    while (true) {
      try { content = new TextDecoder('utf-8', { fatal: true }).decode(bounded); break; }
      catch {
        if (bounded.length === 0) throw new ContextMutationError('context_invalid_utf8', 'Context chunk could not be decoded.');
        bounded = bounded.subarray(0, bounded.length - 1);
        end -= 1;
      }
    }
    return { hash: hash.digest('hex'), content: content!, raw: bounded, end, header: Buffer.concat(headerChunks) };
  }

  private scanDurableChars(resolved: ResolvedScope, files: InventoryFile[]): number {
    let chars = 0;
    for (const file of files.filter(candidate => candidate.kind === 'durable')) {
      const buffer = fs.readFileSync(this.contentPath(resolved, file.name));
      try { chars += new TextDecoder('utf-8', { fatal: true }).decode(buffer).length; }
      catch { throw new ContextMutationError('context_invalid_utf8', `Context "${file.name}" is not valid UTF-8.`); }
    }
    return chars;
  }

  private readHeader(filePath: string): Buffer {
    const fd = fs.openSync(filePath, 'r');
    try {
      const buffer = Buffer.alloc(CONTEXT_FRONTMATTER_MAX_BYTES);
      const count = fs.readSync(fd, buffer, 0, buffer.length, 0);
      return buffer.subarray(0, count);
    } finally { fs.closeSync(fd); }
  }

  private assertContentInput(content: string): void {
    if (typeof content !== 'string') throw new ContextMutationError('invalid_argument', 'Context content must be a string.');
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > CONTEXT_DOCUMENT_MAX_BYTES) throw new ContextMutationError('context_input_too_large', `Managed context content exceeds ${CONTEXT_DOCUMENT_MAX_BYTES} bytes.`, { bytes });
  }

  private assertExpectedHash(hash: string | undefined): void {
    if (!hash || !/^[a-f0-9]{64}$/.test(hash)) throw new ContextMutationError('context_precondition_required', 'A valid expected content hash from a named context read is required.');
  }

  private requireCurrentContent(filePath: string, name: string, expectedHash: string): Buffer {
    const prior = this.readFileBuffer(filePath);
    if (prior === null) throw new ContextMutationError('context_not_found', `Context "${name}" does not exist.`, { name });
    const actual = sha256(prior);
    if (actual !== expectedHash) throw new ContextMutationError('stale_content', `Context "${name}" content changed after it was read.`, { name, expectedContentHash: expectedHash, contentHash: actual });
    return prior;
  }

  private normalizeArchiveNames(names: string[]): string[] {
    if (!Array.isArray(names) || names.length === 0) throw new ContextMutationError('invalid_argument', 'At least one context name is required.');
    if (names.length > CONTEXT_ARCHIVE_NAMES_MAX) throw new ContextMutationError('context_input_too_large', `At most ${CONTEXT_ARCHIVE_NAMES_MAX} archive names are allowed.`);
    const normalized = [...new Set(names.map(name => this.normalizeName(name)))];
    if (normalized.reduce((sum, name) => sum + Buffer.byteLength(name, 'utf8'), 0) > CONTEXT_DOCUMENT_MAX_BYTES) throw new ContextMutationError('context_input_too_large', 'Archive names exceed the aggregate input limit.');
    if (normalized.some(name => Buffer.byteLength(name) > CONTEXT_ARCHIVE_NAME_MAX_BYTES)) throw new ContextMutationError('context_input_too_large', 'An archive name exceeds the resource limit.');
    return normalized;
  }

  private normalizeName(name: string): string {
    if (typeof name !== 'string') throw new ContextMutationError('invalid_context_name', 'Context name must be a string.');
    const normalized = name.trim().replace(/\.md$/, '');
    if (!normalized || !/^[\p{L}\p{N}][\p{L}\p{N}._-]*$/u.test(normalized) || normalized === 'index' || normalized === PENDING_MARKER_NAME.replace(/\.json$/, '')) {
      throw new ContextMutationError('invalid_context_name', `Invalid context name "${name}". Use a simple file name without paths.`, { name });
    }
    return normalized;
  }

  private resolveMutableKind(name: string, requested?: ContextKind): ContextKind | undefined {
    if (this.isSpecialName(name)) {
      if (requested !== undefined) throw new ContextMutationError('invalid_context_kind', `Context "${name}" is reserved and does not accept a caller-provided kind.`, { name, kind: requested });
      return undefined;
    }
    if (requested !== undefined && requested !== 'durable' && requested !== 'evidence') throw new ContextMutationError('invalid_context_kind', `Invalid context kind "${requested}".`);
    return requested ?? 'durable';
  }

  private effectiveKind(name: string, indexedKind?: ContextKind): ContextKind | undefined {
    return this.isSpecialName(name) ? undefined : indexedKind ?? 'durable';
  }

  private classifyContextName(name: string, kind?: ContextKind): Pick<ContextFile, 'role' | 'includeInExecution' | 'includeInNetwork'> {
    if (SPECIAL_CONTEXTS[name as keyof typeof SPECIAL_CONTEXTS]) return SPECIAL_CONTEXTS[name as keyof typeof SPECIAL_CONTEXTS];
    if (kind === 'evidence') return { role: 'evidence', includeInExecution: false, includeInNetwork: false };
    return DEFAULT_CONTEXT_CLASSIFICATION;
  }

  private isSpecialName(name: string): boolean { return Object.hasOwn(SPECIAL_CONTEXTS, name); }
  private indexPath(resolved: ResolvedScope): string { return path.join(resolved.contextPath, INDEX_NAME); }
  private markerPath(resolved: ResolvedScope): string { return path.join(resolved.contextPath, PENDING_MARKER_NAME); }

  private contentPath(resolved: ResolvedScope, name: string): string {
    const target = path.join(resolved.contextPath, `${name}.md`);
    this.assertContained(resolved.contextPath, target);
    this.assertNoSymlink(resolved.contextPath, target);
    return target;
  }

  private assertNamespaceSafe(target: string): void {
    this.assertContained(this.projectRoot, target);
    this.assertNoSymlink(this.projectRoot, target);
  }

  private assertContained(root: string, target: string): void {
    const relative = path.relative(path.resolve(root), path.resolve(target));
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new ContextMutationError('context_symlink_refused', 'Context path escapes its authorized namespace.');
  }

  private assertNoSymlink(root: string, target: string): void {
    this.assertContained(root, target);
    const relative = path.relative(path.resolve(root), path.resolve(target));
    let current = path.resolve(root);
    for (const part of relative.split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      try {
        if (fs.lstatSync(current).isSymbolicLink()) throw new ContextMutationError('context_symlink_refused', `Context path contains symlink "${current}".`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') break;
        throw error;
      }
    }
  }

  private readFileBuffer(filePath: string): Buffer | null {
    try {
      const stat = fs.lstatSync(filePath);
      if (stat.isSymbolicLink()) throw new ContextMutationError('context_symlink_refused', `Context control or content path is a symlink: ${filePath}`);
      return fs.readFileSync(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  private safeStat(filePath: string): fs.Stats | null {
    try {
      const stat = fs.lstatSync(filePath);
      if (stat.isSymbolicLink()) throw new ContextMutationError('context_symlink_refused', `Context content path is a symlink: ${filePath}`);
      return stat;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  private statFingerprint(stat: fs.Stats): string { return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`; }

  private restoreIndex(resolved: ResolvedScope, prior: Buffer | null, name = INDEX_NAME): void {
    const target = path.join(resolved.contextPath, name);
    if (prior === null) {
      if (fileExists(target)) fs.unlinkSync(target);
    } else writeAtomic(target, prior);
  }

  private appendArchiveRecord(manifestPath: string, archivedAt: string, reason: string, moved: Array<{ name: string; destination: string }>): void {
    const prior = this.readFileBuffer(manifestPath);
    let manifest: { schemaVersion: 1; records: Array<{ name: string; archivedAt: string; reason: string; path: string }> } = { schemaVersion: 1, records: [] };
    if (prior) {
      const parsed = JSON.parse(prior.toString('utf8')) as typeof manifest;
      if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.records)) throw new ContextMutationError('context_index_invalid', 'Context archive manifest is invalid.');
      manifest = parsed;
    }
    manifest.records.push(...moved.map(item => ({ name: item.name, archivedAt, reason, path: item.destination })));
    writeJsonAtomic(manifestPath, manifest);
  }

  private publicInventoryFile(file: InventoryFile): Omit<ContextFile, 'content' | 'contentHash'> {
    const { statFingerprint: _stat, headerFingerprint: _header, ...result } = file;
    return result;
  }

  private consolidationHints(files: Array<Pick<ContextFile, 'name' | 'kind'>>): string[] {
    const names = files.filter(file => file.kind === 'durable').map(file => file.name);
    return ['learnings', 'review', 'verification', 'evidence'].flatMap(token => {
      const matches = names.filter(name => asciiFold(name).includes(token));
      return matches.length > 1 ? [`Consolidate ${matches.join(', ')} into one current ${token} context.`] : [];
    });
  }

  private assertBoundedText(value: string | undefined, maxBytes: number, field: string): void {
    if (value !== undefined && (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > maxBytes)) throw new ContextMutationError('context_input_too_large', `Context ${field} exceeds ${maxBytes} bytes.`);
  }

  private assertResponseSize(value: unknown, maxBytes: number): void {
    const bytes = Buffer.byteLength(JSON.stringify(value), 'utf8');
    if (bytes > maxBytes) throw new ContextMutationError('context_inventory_too_large', `Context response construction exceeds ${maxBytes} bytes.`, { bytes });
  }

  private encodeCursor(payload: { version: 1; scope: string; query: string; snapshot: string; position: number }): string {
    return Buffer.from(JSON.stringify(payload)).toString('base64url');
  }

  private decodeCursor(cursor: string): { version: 1; scope: string; query: string; snapshot: string; position: number } {
    try {
      const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Record<string, unknown>;
      if (parsed.version !== 1 || typeof parsed.scope !== 'string' || typeof parsed.query !== 'string' || typeof parsed.snapshot !== 'string' || !Number.isInteger(parsed.position) || (parsed.position as number) < 0) throw new Error('shape');
      return parsed as unknown as { version: 1; scope: string; query: string; snapshot: string; position: number };
    } catch {
      throw new ContextMutationError('invalid_context_cursor', 'Context cursor is malformed or uses an unsupported version.');
    }
  }
}
