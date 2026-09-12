import { isAlias, parseDocument, visit } from 'yaml';
import type { ContextMetadata } from '../types.js';

export const CONTEXT_FRONTMATTER_MAX_BYTES = 8 * 1024;

const RECOGNIZED_KEYS = new Set(['description', 'read_when', 'owner', 'review_after']);

function invalid(message: string): ContextMetadata {
  return { warnings: [message] };
}

export function parseContextMetadata(source: Buffer): ContextMetadata {
  const bounded = source.subarray(0, Math.min(source.length, CONTEXT_FRONTMATTER_MAX_BYTES));
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let prefix: string;
  const openingBytes = bounded.subarray(0, 5).toString('ascii');
  const openingLength = openingBytes.startsWith('---\r\n') ? 5 : openingBytes.startsWith('---\n') ? 4 : 0;
  if (openingLength === 0) {
    return invalid('Missing YAML frontmatter.');
  }
  let headerEnd = -1;
  let delimiterStart = bounded.indexOf('\n---', openingLength - 1);
  while (delimiterStart >= 0) {
    const suffixStart = delimiterStart + 4;
    if (suffixStart === bounded.length) {
      headerEnd = suffixStart;
      break;
    }
    if (bounded[suffixStart] === 0x0a) {
      headerEnd = suffixStart + 1;
      break;
    }
    if (bounded[suffixStart] === 0x0d && bounded[suffixStart + 1] === 0x0a) {
      headerEnd = suffixStart + 2;
      break;
    }
    delimiterStart = bounded.indexOf('\n---', delimiterStart + 1);
  }
  if (headerEnd < 0) {
    return invalid(source.length > CONTEXT_FRONTMATTER_MAX_BYTES
      ? `YAML frontmatter exceeds ${CONTEXT_FRONTMATTER_MAX_BYTES} bytes.`
      : 'YAML frontmatter is not terminated.');
  }
  try {
    prefix = decoder.decode(bounded.subarray(0, headerEnd));
  } catch {
    return invalid('Context is not valid UTF-8.');
  }
  const match = prefix.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) {
    return invalid('YAML frontmatter is not terminated.');
  }
  const headerText = match[1] ?? '';
  try {
    const document = parseDocument(headerText, {
      uniqueKeys: true,
      strict: true,
      prettyErrors: false,
      customTags: [],
    });
    if (document.errors.length > 0 || document.warnings.length > 0) {
      return invalid(`Invalid YAML frontmatter: ${(document.errors[0] ?? document.warnings[0]).message}`);
    }
    let containsAlias = false;
    visit(document, (_key, node) => {
      if (isAlias(node)) containsAlias = true;
    });
    if (containsAlias) {
      return invalid('YAML aliases are not allowed in context metadata.');
    }
    const value = document.toJS({ maxAliasCount: 0 });
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return invalid('Context frontmatter must be a YAML mapping.');
    }
    const record = value as Record<string, unknown>;
    const warnings: string[] = [];
    for (const key of RECOGNIZED_KEYS) {
      if (record[key] !== undefined && (typeof record[key] !== 'string' || !record[key].trim())) {
        warnings.push(`Metadata field ${key} must be a nonblank string.`);
      }
    }
    const stringValue = (key: string): string | undefined => typeof record[key] === 'string' && record[key].trim()
      ? record[key].trim()
      : undefined;
    const reviewAfter = stringValue('review_after');
    if (reviewAfter && (!/^\d{4}-\d{2}-\d{2}$/.test(reviewAfter)
      || new Date(`${reviewAfter}T00:00:00.000Z`).toISOString().slice(0, 10) !== reviewAfter)) {
      warnings.push('Metadata field review_after must use YYYY-MM-DD.');
    }
    return {
      description: stringValue('description'),
      readWhen: stringValue('read_when'),
      owner: stringValue('owner'),
      reviewAfter,
      warnings,
    };
  } catch (error) {
    return invalid(`Invalid YAML frontmatter: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function assertRequiredContextMetadata(
  metadata: ContextMetadata,
  scopeType: 'feature' | 'project',
): void {
  const missing = [
    !metadata.description && 'description',
    !metadata.readWhen && 'read_when',
    scopeType === 'project' && !metadata.owner && 'owner',
    scopeType === 'project' && !metadata.reviewAfter && 'review_after',
  ].filter(Boolean) as string[];
  if (metadata.warnings.length > 0 || missing.length > 0) {
    const reasons = [...metadata.warnings, ...(missing.length ? [`Missing required metadata: ${missing.join(', ')}.`] : [])];
    throw new Error(reasons.join(' '));
  }
}
