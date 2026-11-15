#!/usr/bin/env bun
/**
 * Vendors the GoogleChrome/modern-web-guidance guide corpus into
 * skills/modern-web-guidance/ from two pinned inputs:
 *
 * - the Git release checkout (the guide Markdown under skills/modern-web-guidance/guides/), and
 * - the npm release tarball, read for gen/guides.json (guide metadata the Git
 *   repository does not publish) and for legacy-scan.mjs, whose legacy-pattern rules are
 *   extracted by parsing the bundle as a syntax tree. Nothing from the package is executed.
 *
 * Output is deterministic: rerunning against the same inputs rewrites nothing, and
 * --check compares the committed tree with a fresh render without writing.
 *
 * Usage:
 *   bun scripts/sync-modern-web-guidance.ts --git-dir <checkout> --npm-tarball <file.tgz> [--check]
 *     [--commit <ref>] [--allow-unpinned] [--out <skill-dir>]
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import ts from 'typescript';

const PINNED = {
  commit: '4dd968349e54ca45a05dd5c818fb035c9054b022',
  packageName: 'modern-web-guidance',
  version: '1.0.0',
  sha1: 'e8d27ab97ab9fe7ba0885c9db72d53e9d8d28b9b',
  sha256: 'bd7aa623ad10710a9ad6678fdbcc0b890c903c54fd6abfc126ff42de01f0e577',
  integrity: 'sha512-vafIZwC8AS6QjM2yyoflZbnc7n3/TVOMLbEMRdPTwcFy0f9/Tq8s5rJQ8UIqRt2KPl9ixravyaMR4nTGuUrcmg==',
  guideCount: 208,
  categoryCount: 17,
  originTrialGuides: 8,
  volatileGuides: 10,
  legacyRules: 35,
};

const UPSTREAM_GUIDES_DIR = 'skills/modern-web-guidance/guides';
const TARBALL_PACKAGE_JSON = 'package/package.json';
const TARBALL_GUIDES_JSON = 'package/skills/modern-web-guidance/gen/guides.json';
const TARBALL_LEGACY_SCAN = 'package/skills/modern-web-guidance/legacy-scan.mjs';
const LEGACY_PATTERNS = 'references/legacy-patterns.md';
const MIN_LEGACY_RULES = 35;
// Upstream ships prompt-api.md as a byte-identical copy of language-model.md that
// guides.json does not list and no guide links to. Only the canonical copy is vendored.
const DUPLICATE_GUIDE = { omitted: 'built-in-ai/prompt-api.md', canonical: 'built-in-ai/language-model.md' };
const HAND_AUTHORED = ['SKILL.md', 'UPSTREAM.md', 'LICENSE.apache-2.0', 'LICENSE.cc-by-4.0'];
const GENERATED_DIRS = ['guides', 'references/index'];
const GENERATED_FILES = [LEGACY_PATTERNS];
const LARGE_GUIDE_LINES = 350;
const MAX_KEYWORDS = 16;

const RETRIEVE_REFERENCE = /`([^`]+)` \(via `npx -y modern-web-guidance@latest retrieve "([^"]+)"`\)/g;

// Tokens that downstream consumers or the repository's skill invariants reject in every
// shipped Markdown file except UPSTREAM.md (attribution keeps its source wording).
const FORBIDDEN: Array<[RegExp, string]> = [
  [/modern-web-guidance@/, 'CLI package specifier'],
  [/\bnpx /, 'npx invocation'],
  [/\bpnpx /, 'pnpx invocation'],
  [/\\`/, 'backslash-escaped backtick'],
  [/\{\{|@@|%HOST%/, 'template placeholder'],
  [/hive-host/, 'host section marker'],
  [/skill\(\s*\{/, 'skill call'],
  [/\btask\(|\bsubagent\(|\bquestion\(|\btodowrite\(/, 'host tool call'],
  [/subagent_type|sessionID|task_id|`subagent`|`task\.prompt`/, 'host dispatch syntax'],
  [/\bhive_[A-Za-z0-9_]+/, 'host tool name'],
  [/\bHive\b|\bOpenCode\b|\boc-arkive\b|\bnative skill\b/, 'host runtime name'],
  [/CLAUDE\.md|writing-policy/, 'host instruction file'],
];

type OriginTrial = { id: string; chromestatus_url: string };
type VolatileFeature = { id: string; reason: string };
export type GuideMeta = {
  id: string;
  category: string;
  description: string;
  featuresUsed: string[];
  originTrials: OriginTrial[];
  volatileFeatures: VolatileFeature[];
};
type Options = {
  gitDir: string;
  npmTarball: string;
  commit: string;
  check: boolean;
  allowUnpinned: boolean;
  out: string;
};

export class SyncError extends Error {}

function fail(message: string): never {
  throw new SyncError(message);
}

function parseArgs(argv: string[]): Options {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const options: Partial<Options> = {
    commit: 'HEAD',
    check: false,
    allowUnpinned: false,
    out: path.resolve(scriptDir, '../skills/modern-web-guidance'),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) fail(`${flag} needs a value`);
      index += 1;
      return next;
    };
    switch (flag) {
      case '--git-dir': options.gitDir = path.resolve(value()); break;
      case '--npm-tarball': options.npmTarball = path.resolve(value()); break;
      case '--commit': options.commit = value(); break;
      case '--out': options.out = path.resolve(value()); break;
      case '--check': options.check = true; break;
      case '--allow-unpinned': options.allowUnpinned = true; break;
      default: fail(`unknown argument ${flag}`);
    }
  }
  if (!options.gitDir) fail('--git-dir <modern-web-guidance checkout> is required');
  if (!options.npmTarball) fail('--npm-tarball <modern-web-guidance-X.Y.Z.tgz> is required');
  return options as Options;
}

// ---------------------------------------------------------------------------
// Pinned inputs

function git(gitDir: string, args: string[], input?: string): Buffer {
  const result = spawnSync('git', ['-C', gitDir, ...args], {
    input,
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, GIT_NO_LAZY_FETCH: '1', GIT_OPTIONAL_LOCKS: '0' },
  });
  if (result.error) fail(`git ${args[0]} failed: ${result.error.message}`);
  if (result.status !== 0) fail(`git ${args.join(' ')} failed: ${result.stderr.toString('utf8').trim()}`);
  return result.stdout;
}

function resolveCommit(options: Options): string {
  const commit = git(options.gitDir, ['rev-parse', '--verify', `${options.commit}^{commit}`]).toString('utf8').trim();
  if (!/^[0-9a-f]{40}$/.test(commit)) fail(`git returned a non-commit ID ${JSON.stringify(commit)}`);
  if (commit !== PINNED.commit && !options.allowUnpinned) {
    fail(`${options.gitDir} ${options.commit} is ${commit}, not the pinned ${PINNED.commit}; pass --allow-unpinned to vendor a new release`);
  }
  return commit;
}

/** Reads every blob under the upstream guides directory at the commit, ignoring the working tree. */
function readUpstreamGuides(gitDir: string, commit: string): Map<string, Buffer> {
  const listing = git(gitDir, ['ls-tree', '-r', '-z', commit, '--', UPSTREAM_GUIDES_DIR]).toString('utf8');
  const entries: Array<{ object: string; relative: string }> = [];
  for (const record of listing.split('\0')) {
    if (!record) continue;
    const [meta, filePath] = record.split('\t');
    const [mode, kind, object] = meta.split(' ');
    const relative = filePath.slice(UPSTREAM_GUIDES_DIR.length + 1);
    if (kind !== 'blob' || mode !== '100644') fail(`${filePath} is not a regular file (mode ${mode}, type ${kind})`);
    if (!/^[a-z0-9-]+\/[a-z0-9-]+\.md$/.test(relative)) fail(`unexpected guide path ${filePath}`);
    entries.push({ object, relative });
  }
  if (entries.length === 0) fail(`${UPSTREAM_GUIDES_DIR} has no files at ${commit}`);

  const batch = git(gitDir, ['cat-file', '--batch'], entries.map((entry) => entry.object).join('\n') + '\n');
  const blobs = new Map<string, Buffer>();
  let offset = 0;
  for (const entry of entries) {
    const headerEnd = batch.indexOf(0x0a, offset);
    const [object, kind, size] = batch.subarray(offset, headerEnd).toString('utf8').split(' ');
    if (object !== entry.object || kind !== 'blob') fail(`git cat-file returned ${object} ${kind} for ${entry.relative}`);
    const start = headerEnd + 1;
    blobs.set(entry.relative, batch.subarray(start, start + Number(size)));
    offset = start + Number(size) + 1;
  }
  return blobs;
}

function cString(buffer: Buffer, start: number, length: number): string {
  const field = buffer.subarray(start, start + length);
  const end = field.indexOf(0);
  return field.subarray(0, end === -1 ? field.length : end).toString('utf8');
}

/** Minimal ustar/pax reader: returns the regular files whose paths are wanted. */
export function readTarFiles(tar: Buffer, wanted: Set<string>): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  let offset = 0;
  let overridePath: string | undefined;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const sizeField = cString(header, 124, 12).trim();
    if (!/^[0-7]*$/.test(sizeField)) fail(`tar entry at offset ${offset} has an unsupported size field`);
    const size = sizeField ? parseInt(sizeField, 8) : 0;
    const type = String.fromCharCode(header[156]);
    const prefix = cString(header, 257, 6).startsWith('ustar') ? cString(header, 345, 155) : '';
    const name = cString(header, 0, 100);
    if (offset + 512 + size > tar.length) fail(`tar entry at offset ${offset} is truncated`);
    const body = tar.subarray(offset + 512, offset + 512 + size);
    if (type === 'x') {
      for (const record of body.toString('utf8').split('\n')) {
        const match = /^\d+ path=(.*)$/.exec(record);
        if (match) overridePath = match[1];
      }
    } else if (type === 'L') {
      overridePath = cString(body, 0, body.length);
    } else {
      const entryPath = overridePath ?? (prefix ? `${prefix}/${name}` : name);
      overridePath = undefined;
      if ((type === '0' || type === '\0') && wanted.has(entryPath)) {
        if (files.has(entryPath)) fail(`tarball contains ${entryPath} twice`);
        files.set(entryPath, Buffer.from(body));
      }
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

type PackageInput = { version: string; guidesJson: Buffer; legacyScan: string; sha256: string; integrity: string };

function readNpmPackage(options: Options): PackageInput {
  if (!existsSync(options.npmTarball) || !statSync(options.npmTarball).isFile()) {
    fail(`--npm-tarball ${options.npmTarball} is not a file`);
  }
  const tarball = readFileSync(options.npmTarball);
  const sha1 = createHash('sha1').update(tarball).digest('hex');
  const sha256 = createHash('sha256').update(tarball).digest('hex');
  const integrity = `sha512-${createHash('sha512').update(tarball).digest('base64')}`;
  if (!options.allowUnpinned) {
    for (const [label, actual, expected] of [
      ['SHA-1', sha1, PINNED.sha1],
      ['SHA-256', sha256, PINNED.sha256],
      ['SHA-512 integrity', integrity, PINNED.integrity],
    ]) {
      if (actual !== expected) fail(`${options.npmTarball} ${label} is ${actual}, not the pinned ${expected}; pass --allow-unpinned to vendor a new release`);
    }
  }
  const files = readTarFiles(gunzipSync(tarball), new Set([TARBALL_PACKAGE_JSON, TARBALL_GUIDES_JSON, TARBALL_LEGACY_SCAN]));
  const packageJson = files.get(TARBALL_PACKAGE_JSON) ?? fail(`tarball has no ${TARBALL_PACKAGE_JSON}`);
  const guidesJson = files.get(TARBALL_GUIDES_JSON) ?? fail(`tarball has no ${TARBALL_GUIDES_JSON}`);
  const legacyScanBytes = files.get(TARBALL_LEGACY_SCAN) ?? fail(`tarball has no ${TARBALL_LEGACY_SCAN}`);
  let legacyScan: string;
  try {
    legacyScan = new TextDecoder('utf-8', { fatal: true }).decode(legacyScanBytes);
  } catch {
    fail(`${TARBALL_LEGACY_SCAN} is not valid UTF-8`);
  }
  const manifest = JSON.parse(packageJson.toString('utf8')) as { name?: unknown; version?: unknown };
  if (manifest.name !== PINNED.packageName) fail(`tarball package name is ${JSON.stringify(manifest.name)}`);
  if (typeof manifest.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(manifest.version)) {
    fail(`tarball package version ${JSON.stringify(manifest.version)} is not a release version`);
  }
  if (manifest.version !== PINNED.version && !options.allowUnpinned) {
    fail(`tarball version ${manifest.version} is not the pinned ${PINNED.version}`);
  }
  return { version: manifest.version, guidesJson, legacyScan, sha256, integrity };
}

export type LegacyRule = {
  id: string;
  guideId: string;
  summary: string;
  keepWhen: string[];
  dropWhen: string[];
};

/**
 * Rubric text is shipped in skill Markdown, where `{{` reads as a template placeholder. Spacing the braces
 * keeps JSX meaning: `dangerouslySetInnerHTML={{ __html }}` becomes `dangerouslySetInnerHTML={ { __html } }`.
 */
function normalizeRubricText(text: string): string {
  return text.replaceAll('{{', '{ {').replaceAll('}}', '} }');
}

/**
 * Extracts the legacy-pattern rules from upstream's bundled legacy-scan.mjs by walking its syntax tree; the
 * bundle is never executed. A rule is an object literal whose `verifierRubric` is an object literal; it must
 * carry string `id`, `guideId`, and `summary` and string-array `keepWhen` and `dropWhen`. Other objects that
 * merely forward a `verifierRubric` value are not rules. Returns the rules in source order.
 */
export function extractLegacyRules(code: string): LegacyRule[] {
  const source = ts.createSourceFile('legacy-scan.mjs', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const property = (object: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined => {
    for (const entry of object.properties) {
      if (ts.isPropertyAssignment(entry) && (ts.isIdentifier(entry.name) || ts.isStringLiteral(entry.name)) && entry.name.text === name) {
        return entry.initializer;
      }
    }
    return undefined;
  };
  const where = (node: ts.Node) => `legacy-scan.mjs:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`;
  const text = (object: ts.ObjectLiteralExpression, name: string): string => {
    const value = property(object, name);
    if (!value || !(ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) || !value.text.trim()) {
      fail(`${where(object)}: legacy rule ${name} is not a nonempty string literal`);
    }
    if (/[\r\n]/.test(value.text)) fail(`${where(object)}: legacy rule ${name} spans lines`);
    return normalizeRubricText(value.text);
  };
  const list = (rubric: ts.ObjectLiteralExpression, name: string, ruleId: string): string[] => {
    const value = property(rubric, name);
    if (!value || !ts.isArrayLiteralExpression(value)) fail(`${where(rubric)}: rule ${ruleId} verifierRubric.${name} is not an array literal`);
    return value.elements.map((element) => {
      if (!(ts.isStringLiteral(element) || ts.isNoSubstitutionTemplateLiteral(element)) || !element.text.trim()) {
        fail(`${where(element)}: rule ${ruleId} verifierRubric.${name} has an entry that is not a nonempty string literal`);
      }
      if (/[\r\n]/.test(element.text)) fail(`${where(element)}: rule ${ruleId} verifierRubric.${name} has an entry that spans lines`);
      return normalizeRubricText(element.text);
    });
  };

  const rules: LegacyRule[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isObjectLiteralExpression(node)) {
      const rubric = property(node, 'verifierRubric');
      if (rubric && ts.isObjectLiteralExpression(rubric)) {
        const id = text(node, 'id');
        const keepWhen = list(rubric, 'keepWhen', id);
        if (keepWhen.length === 0) fail(`${where(rubric)}: rule ${id} has no keepWhen entries`);
        rules.push({ id, guideId: text(node, 'guideId'), summary: text(node, 'summary'), keepWhen, dropWhen: list(rubric, 'dropWhen', id) });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return rules;
}

/** Validates extracted rules against the guide inventory and orders them by category, guide, then rule ID. */
function orderLegacyRules(rules: LegacyRule[], byId: Map<string, GuideMeta>, pinned: boolean): LegacyRule[] {
  if (rules.length < MIN_LEGACY_RULES) fail(`legacy-scan.mjs yielded ${rules.length} rules, fewer than ${MIN_LEGACY_RULES}`);
  if (pinned && rules.length !== PINNED.legacyRules) fail(`pinned release has ${rules.length} legacy rules, expected ${PINNED.legacyRules}`);
  const seen = new Set<string>();
  for (const rule of rules) {
    if (seen.has(rule.id)) fail(`legacy rule id ${rule.id} is not unique`);
    seen.add(rule.id);
    if (!/^[a-z0-9-]+(?:\/[a-z0-9-]+)?$/.test(rule.id)) fail(`legacy rule id ${JSON.stringify(rule.id)} is not a safe identifier`);
    if (!byId.has(rule.guideId)) fail(`legacy rule ${rule.id} names guide ${rule.guideId}, which gen/guides.json does not list`);
  }
  const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  return [...rules].sort((a, b) => compare(byId.get(a.guideId)!.category, byId.get(b.guideId)!.category) || compare(a.guideId, b.guideId) || compare(a.id, b.id));
}

export function renderLegacyPatterns(rules: LegacyRule[], byId: Map<string, GuideMeta>, version: string): string {
  const categories = [...new Set(rules.map((rule) => byId.get(rule.guideId)!.category))];
  const guideCount = new Set(rules.map((rule) => rule.guideId)).size;
  const out = [
    '# Legacy Web Patterns and Verification Rubrics',
    '',
    `<!-- Adapted from GoogleChrome/modern-web-guidance v${version} legacy-scan.mjs (Apache-2.0): extracted as static audit rubrics with relative guide links; see ../UPSTREAM.md and ../LICENSE.apache-2.0 -->`,
    '',
    `${rules.length} detection rules for legacy web idioms that a modern platform feature replaces, covering ${guideCount} guides (about 20% of the catalog). Each rule names the legacy pattern to search for, the guide that holds its replacement, and two lists:`,
    '',
    '- **Flag and modernize when (`keepWhen`):** conditions that make a candidate a real finding. A candidate counts only when it matches at least one of them.',
    '- **Skip / keep as-is when (`dropWhen`):** conditions that dismiss **that specific rule match** because the pattern is an intentional fallback, out of scope, or already satisfied. Dismissing one rule match does not suppress an independent defect on the same element (for example, an input that already has `autocomplete="cc-number"` skips the missing-autofill check, while `type="number"` on that card field still violates `autofill-payment-form`).',
    '',
    'Search the stylesheets, templates and JSX, client scripts, and `package.json` for each rule\'s pattern, then check every candidate against both lists before reporting or editing it. Read the linked guide before changing the code; its fallback strategy decides whether the old code stays as a fallback. Code whose rule match was dismissed, and fallbacks a guide requires, still match a text search after modernization; leave those matched constructs in place unless an independent rule flags another defect on them.',
    '',
    `Categories: ${categories.map((category) => `[${category}](#${category})`).join(', ')}.`,
  ];
  for (const category of categories) {
    out.push('', `## ${category}`);
    for (const rule of rules.filter((entry) => byId.get(entry.guideId)!.category === category)) {
      out.push(
        '',
        `### \`${rule.id}\``,
        '',
        `Guide: [\`${rule.guideId}\`](../guides/${category}/${rule.guideId}.md)`,
        '',
        rule.summary,
        '',
        '**Flag and modernize when (`keepWhen`):**',
        '',
        ...rule.keepWhen.map((entry) => `- ${entry}`),
        '',
        '**Skip / keep as-is when (`dropWhen`):**',
        '',
        ...(rule.dropWhen.length > 0 ? rule.dropWhen.map((entry) => `- ${entry}`) : ['- No skip conditions are listed for this rule.']),
      );
    }
  }
  return out.join('\n') + '\n';
}

function parseGuidesJson(raw: Buffer): GuideMeta[] {
  const data: unknown = JSON.parse(raw.toString('utf8'));
  if (!Array.isArray(data)) fail('gen/guides.json is not an array');
  const isString = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
  return data.map((entry, index) => {
    const where = `gen/guides.json[${index}]`;
    if (typeof entry !== 'object' || entry === null) fail(`${where} is not an object`);
    const record = entry as Record<string, unknown>;
    for (const key of ['id', 'category', 'description']) {
      if (!isString(record[key])) fail(`${where}.${key} is not a nonempty string`);
    }
    if (!/^[a-z0-9-]+$/.test(record.id as string) || !/^[a-z0-9-]+$/.test(record.category as string)) {
      fail(`${where} has an unsafe id or category`);
    }
    if (/[\r\n]/.test(record.description as string)) fail(`${where}.description spans lines`);
    const featuresUsed = record.featuresUsed;
    if (!Array.isArray(featuresUsed) || !featuresUsed.every(isString)) fail(`${where}.featuresUsed is not a string array`);
    const list = <T>(key: string, fields: string[]): T[] => {
      const value = record[key];
      if (value === undefined) return [];
      if (!Array.isArray(value) || value.length === 0) fail(`${where}.${key} is not a nonempty array`);
      for (const item of value) {
        if (typeof item !== 'object' || item === null || !fields.every((field) => isString((item as Record<string, unknown>)[field]))) {
          fail(`${where}.${key} entry lacks ${fields.join(' or ')}`);
        }
      }
      return value as T[];
    };
    const originTrials = list<OriginTrial>('originTrials', ['id', 'chromestatus_url']);
    for (const trial of originTrials) {
      if (!/^https:\/\/chromestatus\.com\/feature\/\d+$/.test(trial.chromestatus_url)) fail(`${where} has an unexpected chromestatus_url`);
    }
    return {
      id: record.id as string,
      category: record.category as string,
      description: record.description as string,
      featuresUsed: featuresUsed as string[],
      originTrials,
      volatileFeatures: list<VolatileFeature>('volatileFeatures', ['id', 'reason']),
    };
  });
}

// ---------------------------------------------------------------------------
// Markdown helpers

const BLOCKQUOTE_MARKER = /^[ \t]*>[ \t]?/;
const LIST_ITEM_MARKER = /^([-+*]|\d{1,9}[.)])([ \t]+|$)/;
const OPENING_FENCE = /^(`{3,}|~{3,})(.*)$/;
const CLOSING_FENCE = /^(`{3,}|~{3,})[ \t]*$/;

/** Strips up to `max` leading blockquote markers; `depth` counts every marker on the line. */
function stripBlockquotes(line: string, max: number): { depth: number; rest: string } {
  let depth = 0;
  let rest = line;
  let stripped = line;
  for (let match = BLOCKQUOTE_MARKER.exec(stripped); match; match = BLOCKQUOTE_MARKER.exec(stripped)) {
    stripped = stripped.slice(match[0].length);
    depth += 1;
    if (depth <= max) rest = stripped;
  }
  return { depth, rest };
}

/**
 * Column width of leading whitespace or a list-marker prefix that starts at `startColumn`, with tabs at
 * 4-column stops, so a tab right after `- ` advances to column 4 instead of adding four columns.
 */
function columnWidth(prefix: string, startColumn = 0): number {
  let column = startColumn;
  for (const char of prefix) column = char === '\t' ? column + 4 - (column % 4) : column + 1;
  return column - startColumn;
}

/** Removes up to `columns` columns of leading spaces and tabs. */
function removeIndent(text: string, columns: number): string {
  let column = 0;
  let index = 0;
  while (index < text.length && column < columns && (text[index] === ' ' || text[index] === '\t')) {
    column = text[index] === '\t' ? column + 4 - (column % 4) : column + 1;
    index += 1;
  }
  return text.slice(index);
}

function leadingColumns(text: string): number {
  return columnWidth(/^[ \t]*/.exec(text)![0]);
}

/**
 * Marks each line of `text` inside a fenced code block (fence lines included), following CommonMark containers.
 * Open list items are tracked per blockquote depth with their content indent, so a fence in a later block of an
 * item (`1. Step` then a blank line and an indented fence) is code, while the same fence indented four or more
 * columns past the enclosing content is an indented code block. A fence opened in a blockquote ends where the
 * blockquote does (a line with fewer `>` markers), and one opened in a list item ends at the first nonblank line
 * indented less than the item's content. A closing fence carries no list marker or info string, so a literal
 * `- ``` ` line inside a top-level block stays code. Lazy paragraph continuation lines are not modelled: an
 * unindented line ends the list items it is indented less than. A fence still open at the end of the file is an
 * error; every vendored guide closes its fences.
 */
export function fencedLines(text: string, label: string): boolean[] {
  const fenced: boolean[] = [];
  const listStack: Array<{ blockquoteDepth: number; contentIndent: number }> = [];
  let open: { char: string; len: number; line: number; blockquoteDepth: number; listContentIndent?: number } | undefined;
  text.split('\n').forEach((line, index) => {
    const quoted = stripBlockquotes(line, Infinity);
    while (listStack.length > 0 && listStack.at(-1)!.blockquoteDepth > quoted.depth) listStack.pop();

    if (open) {
      const { depth, rest } = stripBlockquotes(line, open.blockquoteDepth);
      if (depth < open.blockquoteDepth) {
        open = undefined;
      } else if (open.listContentIndent !== undefined && rest.trim() !== '' && leadingColumns(rest) < open.listContentIndent) {
        open = undefined;
      } else {
        fenced.push(true);
        const relative = leadingColumns(rest) - (open.listContentIndent ?? 0);
        const fence = CLOSING_FENCE.exec(rest.trimStart());
        if (relative >= 0 && relative <= 3 && fence && fence[1][0] === open.char && fence[1].length >= open.len) open = undefined;
        return;
      }
    }

    if (quoted.rest.trim() === '') {
      fenced.push(false);
      return;
    }
    const indentAt = (depth: number) => {
      const top = listStack.at(-1);
      return top && top.blockquoteDepth === depth ? top.contentIndent : 0;
    };
    const lineIndent = leadingColumns(quoted.rest);
    while (listStack.length > 0 && listStack.at(-1)!.blockquoteDepth === quoted.depth && lineIndent < listStack.at(-1)!.contentIndent) listStack.pop();

    // Consume list markers that open items on this line, such as `1. ` or `- 1. `. `offset` counts the
    // columns already consumed before `rest`.
    let rest = quoted.rest;
    let offset = 0;
    for (;;) {
      const indent = leadingColumns(rest);
      const markerStart = offset + indent;
      const relative = markerStart - indentAt(quoted.depth);
      const marker = relative >= 0 && relative <= 3 ? LIST_ITEM_MARKER.exec(rest.trimStart()) : null;
      if (!marker) break;
      const markerEnd = markerStart + marker[1].length;
      const spacesAfter = columnWidth(marker[2], markerEnd);
      const contentIndent = markerEnd + (spacesAfter === 0 || spacesAfter > 4 ? 1 : spacesAfter);
      listStack.push({ blockquoteDepth: quoted.depth, contentIndent });
      rest = removeIndent(rest.trimStart().slice(marker[1].length), contentIndent - markerEnd);
      offset = contentIndent;
    }

    const activeIndent = indentAt(quoted.depth);
    const relative = offset + leadingColumns(rest) - activeIndent;
    const fence = relative >= 0 && relative <= 3 ? OPENING_FENCE.exec(rest.trimStart()) : null;
    if (fence && !(fence[1][0] === '`' && fence[2].includes('`'))) {
      open = {
        char: fence[1][0],
        len: fence[1].length,
        line: index + 1,
        blockquoteDepth: quoted.depth,
        listContentIndent: activeIndent > 0 ? activeIndent : undefined,
      };
      fenced.push(true);
    } else {
      fenced.push(false);
    }
  });
  if (open) fail(`${label}:${open.line} opens a code fence that never closes`);
  return fenced;
}

type MarkdownCallback = (children: string, meta?: { href?: string; src?: string }) => string;
type MarkdownRenderer = { render(text: string, callbacks: Record<string, MarkdownCallback>): string };

// Appended on the line directly after the text's final newline: a construct still open at the end of the file
// swallows it, and would equally hide every real link after its opening line. That covers a code fence, an HTML
// block such as `<textarea>`, and a `<div>`-style HTML block that no blank line closes. Blank lines the text
// already ends with are kept, so a `<div>` block closed by one does not swallow the sentinel.
const END_SENTINEL = '#modern-web-guidance-link-scan-end';
// Markdown link syntax written inside raw HTML, which the HTML block passes through unparsed.
const HTML_MARKDOWN_LINK = /\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
// Candidate reference-definition labels, excluding footnote definitions such as `[^1]:`; the Markdown parser
// decides which are real definitions.
const REFERENCE_LABEL_CANDIDATE = /\[(?!\^)([^[\]\r\n]+)\]:/g;

/**
 * Decodes HTML character references such as `&#46;`, `&#x2f;` and `&amp;` in a raw HTML attribute value, which
 * HTMLRewriter returns undecoded. Bun's Markdown renderer decodes references in plain text and returns that text
 * unescaped; every other ASCII punctuation character is backslash-escaped so no Markdown syntax applies.
 */
function decodeHtmlEntities(markdown: MarkdownRenderer, raw: string): string {
  if (!raw.includes('&')) return raw;
  const flat = raw.replace(/[\r\n]+/g, ' ');
  const escaped = flat.replace(/[!-/:-@[-`{-~]/g, (char: string, offset: number) =>
    char === '&' || char === ';' || (char === '#' && flat[offset - 1] === '&') ? char : `\\${char}`);
  return markdown.render(escaped, {});
}

/**
 * Returns the destination of every link and image in `text`: what a CommonMark parser resolves (inline links and
 * reference links, none inside code), plus targets the rendered output would never show. Those are `href` and
 * `src` attributes and Markdown-style links inside raw HTML, and every reference definition whether or not a link
 * uses it. Bun's Markdown parser decides what is a definition: each candidate label is probed with an appended
 * shortcut reference, so a definition in a list item or split across lines counts, while one in a code block or a
 * lazy paragraph continuation does not.
 */
export function linkTargets(text: string, label: string): string[] {
  const markdown = (Bun as unknown as { markdown?: MarkdownRenderer }).markdown;
  if (typeof markdown?.render !== 'function') fail('this Bun has no Bun.markdown.render; upgrade Bun to validate links');
  const targets: string[] = [];
  const htmlSnippets: string[] = [];
  const collectLink: MarkdownCallback = (children, meta) => {
    if (meta?.href) targets.push(meta.href);
    return children;
  };
  const withNewline = text.endsWith('\n') ? text : `${text}\n`;
  markdown.render(`${withNewline}[${END_SENTINEL}](${END_SENTINEL})\n`, {
    link: collectLink,
    image: (children, meta) => {
      if (meta?.src) targets.push(meta.src);
      return children;
    },
    html: (raw) => {
      htmlSnippets.push(raw);
      return '';
    },
  });
  if (targets.at(-1) !== END_SENTINEL) fail(`${label} ends inside an open code fence or HTML block, which hides the links after its opening line from validation`);
  targets.pop();

  const html = htmlSnippets.join('\n').replace(/<!--[\s\S]*?-->/g, '');
  if (html.trim() !== '') {
    new HTMLRewriter().on('*', {
      element(element) {
        for (const attribute of ['href', 'src']) {
          const value = element.getAttribute(attribute)?.trim();
          if (value) targets.push(decodeHtmlEntities(markdown, value));
        }
      },
    }).transform(html);
    for (const match of html.matchAll(HTML_MARKDOWN_LINK)) if (match[1] !== END_SENTINEL) targets.push(match[1]);
  }

  // Each candidate occurrence gets a unique label in a scratch copy, so a shadowed duplicate definition and a
  // label containing `^` are each probed; a rewritten occurrence that is not a definition never resolves.
  let probes = 0;
  const rewritten = withNewline.replace(REFERENCE_LABEL_CANDIDATE, () => `[__mwg_def_${probes++}__]:`);
  if (probes > 0) {
    const shortcuts = Array.from({ length: probes }, (_, index) => `[__mwg_def_${index}__]`).join('\n\n');
    markdown.render(`${rewritten}\n${shortcuts}\n`, { link: collectLink });
  }
  return [...new Set(targets)];
}

// ---------------------------------------------------------------------------
// Guide adaptation

export type Rendered = {
  relative: string;
  source: string;
  text: string;
  meta: GuideMeta;
  rewrites: number;
  references: number;
  gated: boolean;
};

function guideRelativeLink(from: GuideMeta, to: GuideMeta): string {
  return from.category === to.category ? `./${to.id}.md` : `../${to.category}/${to.id}.md`;
}

function volatileReason(reason: string): string {
  if (reason === 'built-in-ai') return 'a browser built-in AI API whose availability depends on the browser, the device, and an on-device model';
  if (reason === 'recent-single-engine') return 'recently shipped in only a single browser engine';
  fail(`unknown volatileFeatures reason ${JSON.stringify(reason)}`);
}

export function gateBanner(meta: GuideMeta): string[] {
  const lines: string[] = [];
  if (meta.originTrials.length > 0) {
    const features = meta.originTrials.map((trial) => `\`${trial.id}\` (${trial.chromestatus_url})`).join(', ');
    lines.push(
      '> [!CAUTION]',
      `> **Origin Trial:** this guide uses ${meta.originTrials.length === 1 ? 'the Origin Trial feature' : 'the Origin Trial features'} ${features}. The API is experimental and subject to change or removal.`,
      '> When the project\'s `.mwgrc` sets `"allowOriginTrials": false`, do not adopt this API. Otherwise adopt it only when `.mwgrc` sets `"allowOriginTrials": true` or the user explicitly requested this API by name; when neither holds, implement a standard cross-browser solution.',
    );
  }
  if (meta.volatileFeatures.length > 0) {
    if (lines.length > 0) lines.push('');
    const features = meta.volatileFeatures.map((feature) => `\`${feature.id}\` (\`${feature.reason}\`: ${volatileReason(feature.reason)})`).join(', ');
    lines.push(
      '> [!CAUTION]',
      `> **Volatile feature:** this guide uses ${meta.volatileFeatures.length === 1 ? 'the volatile feature' : 'the volatile features'} ${features}. Support is limited to a single engine or still stabilizing, so the API shape and availability may change.`,
      '> When the project\'s `.mwgrc` sets `"allowVolatileFeatures": false`, do not adopt this API. Otherwise adopt it only when `.mwgrc` sets `"allowVolatileFeatures": true` or the user explicitly requested this API by name; when neither holds, implement a standard cross-browser solution.',
    );
  }
  return lines;
}

export function adaptGuide(relative: string, source: string, meta: GuideMeta, byId: Map<string, GuideMeta>, version: string): Rendered {
  const lines = source.split('\n');
  const fenced = fencedLines(source, relative);
  let rewrites = 0;
  let references = 0;
  const rewritten = lines.map((line, index) => {
    if (fenced[index]) return line;
    return line.replace(RETRIEVE_REFERENCE, (_match, label: string, idList: string) => {
      references += 1;
      const ids = idList.split(',').map((id) => id.trim());
      const labels = label.split(',').map((id) => id.trim());
      if (ids.join(',') !== labels.join(',')) fail(`${relative}:${index + 1} labels ${label} but retrieves ${idList}`);
      return ids.map((id) => {
        const target = byId.get(id) ?? fail(`${relative}:${index + 1} retrieves unknown guide ${id}`);
        rewrites += 1;
        return `[\`${id}\`](${guideRelativeLink(meta, target)})`;
      }).join(', ');
    });
  });

  const banner = gateBanner(meta);
  const changes: string[] = [];
  if (rewrites > 0) changes.push('CLI retrieve references converted to relative links');
  if (banner.length > 0) changes.push('feature-gate notice inlined');
  if (changes.length === 0) return { relative, source, text: source, meta, rewrites, references, gated: false };

  if (!rewritten[0].startsWith('# ')) fail(`${relative} does not start with a # heading`);
  const rest = rewritten.slice(1);
  while (rest.length > 0 && rest[0].trim() === '') rest.shift();
  const notice = `<!-- Adapted from GoogleChrome/modern-web-guidance v${version} (CC-BY 4.0): ${changes.join(' and ')}; see ../../UPSTREAM.md -->`;
  const head = [rewritten[0], '', notice, ''];
  if (banner.length > 0) head.push(...banner, '');
  return { relative, source, text: [...head, ...rest].join('\n'), meta, rewrites, references, gated: banner.length > 0 };
}

// ---------------------------------------------------------------------------
// Category indexes

const STOP_WORDS = new Set([
  'auto', 'none', 'block', 'inline', 'flex', 'grid', 'hidden', 'visible', 'contain', 'cover', 'true', 'false',
  'null', 'undefined', 'start', 'end', 'center', 'normal', 'inherit', 'initial', 'unset', 'revert', 'absolute',
  'relative', 'fixed', 'sticky', 'static', 'smooth', 'instant', 'manual', 'open', 'closed', 'any', 'all', 'both',
  'left', 'right', 'top', 'bottom', 'solid', 'transparent', 'currentcolor', 'important', 'this', 'var', 'let',
  'const', 'function', 'return', 'async', 'await', 'class', 'new', 'string', 'number', 'object', 'boolean', 'yes',
  'off', 'on', 'div', 'span', 'text', 'value', 'name', 'type', 'error', 'success', 'default', 'disabled', 'enabled',
  'width', 'height', 'color', 'black', 'white', 'red', 'blue', 'green', 'max', 'min', 'and', 'not', 'or', 'the',
  'for', 'via', 'see', 'use', 'avoid', 'bad', 'good', 'html', 'css', 'javascript', 'json', 'data', 'url', 'foo',
  'bar', 'baz', 'item', 'items', 'button', 'content', 'element', 'elements', 'container', 'example', 'label',
  'event', 'events', 'state', 'body', 'main', 'ready', 'loaded', 'loading', 'available', 'unavailable', 'downloadable',
  'downloading', 'enter', 'escape', 'tab', 'space', 'click', 'self', 'window', 'document',
]);
const KEY_NAMES = /^(Arrow(Up|Down|Left|Right)|Enter|Escape|Esc|Tab|Home|End|PageUp|PageDown|Space|Backspace|Delete|Shift|Control|Alt|Meta)$/;
const CSS_AT_RULES = new Set([
  'container', 'counter-style', 'custom-media', 'font-face', 'font-feature-values', 'font-palette-values', 'function',
  'import', 'keyframes', 'layer', 'media', 'namespace', 'page', 'position-try', 'property', 'scope', 'starting-style',
  'supports', 'view-transition',
]);
// Elements every page uses; they rank below distinctive elements such as <dialog> or <search>.
const COMMON_ELEMENTS = new Set([
  'a', 'article', 'aside', 'body', 'br', 'button', 'code', 'div', 'em', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5',
  'h6', 'head', 'header', 'html', 'iframe', 'img', 'input', 'label', 'li', 'link', 'main', 'meta', 'nav', 'ol', 'option',
  'p', 'picture', 'pre', 'script', 'section', 'select', 'source', 'span', 'strong', 'style', 'svg', 'ul', 'video',
]);
// Attributes whose values are platform keywords rather than author IDs or text.
const KEYWORD_VALUE_ATTRIBUTES = /^(type|role|autocomplete|inputmode|enterkeyhint|popover|command|closedby|rel|loading|fetchpriority|decoding|hidden|dir|method|http-equiv|blocking|popovertargetaction|crossorigin|referrerpolicy|sandbox|allow|autocapitalize|spellcheck|translate|contenteditable|draggable|writingsuggestions|as|shadowrootmode|aria-(?!label|labelledby|describedby|controls|owns|details|errormessage|activedescendant|roledescription)[a-z]+)$/;
const AUTHOR_ATTRIBUTES = /^(id|class|style|name|for|href|src|srcset|value|alt|title|content|data-[a-z0-9-]+|width|height)$/;
const KNOWN_GLOBALS = new Set([
  'caches', 'crypto', 'customElements', 'document', 'globalThis', 'history', 'indexedDB', 'localStorage',
  'location', 'navigator', 'performance', 'scheduler', 'screen', 'self', 'sessionStorage', 'visualViewport', 'window',
]);
const FILE_EXTENSION = /\.(html?|css|m?js|json|md|ts|tsx|jsx|png|jpe?g|svg|webp|avif|gif|txt|xml|wasm|woff2?|ico|webmanifest|map)$/i;

function attributeToken(name: string, value: string | undefined): Array<[string, number]> {
  if (AUTHOR_ATTRIBUTES.test(name)) return [];
  if (value !== undefined && /^[^"\s]{1,30}$/.test(value) && KEYWORD_VALUE_ATTRIBUTES.test(name)) return [[`${name}="${value}"`, 3]];
  return [[name, 2]];
}

/** Normalizes one inline code span or feature name into a searchable platform token, with a base weight. */
function classifyToken(raw: string): Array<[string, number]> {
  const token = raw.trim().replace(/;$/, '');
  if (!token || token.length > 48 || /[`|{}\n]/.test(token) || /^--/.test(token) || KEY_NAMES.test(token)) return [];
  let match: RegExpExecArray | null;
  if ((match = /^@([a-z][a-z-]*)(\s.*)?$/.exec(token))) return CSS_AT_RULES.has(match[1]) ? [[`@${match[1]}`, 3]] : [];
  if ((match = /^(::?[a-z][a-z-]*)(\(.*\))?$/.exec(token))) return [[match[2] ? `${match[1]}()` : match[1], 3]];
  if ((match = /^<([a-z][a-z0-9-]*)(\s[^>]*)?\/?>$/.exec(token))) {
    const out: Array<[string, number]> = [[`<${match[1]}>`, COMMON_ELEMENTS.has(match[1]) ? 1.5 : 3]];
    for (const attribute of (match[2] ?? '').matchAll(/([a-z][a-z0-9-]*)(?:="([^"]*)")?/g)) out.push(...attributeToken(attribute[1], attribute[2]));
    return out;
  }
  if ((match = /^([a-z][a-z0-9-]*)="([^"]*)"$/.exec(token))) return attributeToken(match[1], match[2]);
  if ((match = /^([A-Z][A-Za-z0-9]*(?:-[A-Z][A-Za-z0-9]*)+)(?::.*)?$/.exec(token))) return [[match[1], 3]];
  if ((match = /^(-?[a-z][a-z0-9]*(?:-[a-z0-9]+)+)\s*:\s*\S.*$/.exec(token))) return [[match[1], 2.5]];
  if (FILE_EXTENSION.test(token)) return [];
  if ((match = /^([A-Za-z_$][\w$]*)((?:\.[A-Za-z_$#][\w$]*)+)(\(.*\))?$/.exec(token))) {
    const call = match[3] ? '()' : '';
    if (/^[A-Z]/.test(match[1]) || KNOWN_GLOBALS.has(match[1])) return [[`${match[1]}${match[2]}${call}`, 3]];
    // An author variable such as `dialog.showModal()` contributes only its platform member.
    const member = match[2].split('.').pop()!;
    return call && /^[a-z]+[A-Z]/.test(member) ? [[`${member}()`, 3]] : [];
  }
  if ((match = /^([a-z][a-z0-9]*(?:-[a-z0-9]+)+|[a-z]+[A-Z][A-Za-z0-9]*|[A-Z][A-Za-z0-9]*)\(.*\)$/.exec(token))) return [[`${match[1]}()`, 3]];
  if ((match = /^([a-z]+)\(.*\)$/.exec(token))) return [[`${match[1]}()`, 1.5]];
  if (/^[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]*)+$/.test(token)) return [[token, 2.5]];
  if (/^[a-z]+[A-Z][A-Za-z0-9]*$/.test(token)) return [[token, 2]];
  if (/^-?[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/.test(token)) return STOP_WORDS.has(token) ? [] : [[token, 2]];
  if (/^[A-Z][a-z]{3,}$/.test(token)) return STOP_WORDS.has(token.toLowerCase()) ? [] : [[token, 1]];
  if (/^[a-z]{3,}$/.test(token)) return STOP_WORDS.has(token) ? [] : [[token, 1]];
  return [];
}

export function extractKeywords(guide: Rendered): string[] {
  const scores = new Map<string, { weight: number; count: number; heading: boolean; first: number }>();
  let order = 0;
  const add = (token: string, weight: number, heading: boolean) => {
    const entry = scores.get(token) ?? { weight, count: 0, heading: false, first: order++ };
    entry.weight = Math.max(entry.weight, weight);
    entry.heading ||= heading;
    entry.count += 1;
    scores.set(token, entry);
  };
  // Read the upstream text: inlined notices and cross-guide references are not the guide's own symbols.
  const text = guide.source.replace(RETRIEVE_REFERENCE, '');
  const lines = text.split('\n');
  const fenced = fencedLines(text, guide.relative);
  lines.forEach((line, index) => {
    if (fenced[index]) return;
    const heading = /^#{2,3} /.test(line);
    for (const span of line.matchAll(/`([^`]+)`/g)) {
      for (const [token, weight] of classifyToken(span[1])) add(token, weight, heading);
    }
  });

  const features: string[] = [];
  for (const feature of guide.meta.featuresUsed) {
    const parts = feature.split(/\s+and\s+/);
    const tokens = parts.length > 1 && parts.every((part) => classifyToken(part).length > 0)
      ? parts.flatMap((part) => classifyToken(part).map(([token]) => token))
      : [feature.trim()];
    for (const token of tokens) if (!/[`|{}]/.test(token) && !features.includes(token)) features.push(token);
  }
  const description = guide.meta.description.toLowerCase();
  const ranked = [...scores.entries()]
    .filter(([token]) => !features.includes(token) && !description.includes(token.toLowerCase()))
    .map(([token, entry]) => ({ token, rank: entry.weight + (entry.heading ? 2 : 0) + Math.min(entry.count, 4) * 0.5, first: entry.first }))
    .sort((a, b) => b.rank - a.rank || a.first - b.first)
    .map((entry) => entry.token);
  // A bare word such as `details` adds nothing beside `<details>` or a `Details` feature name.
  const stem = (token: string) => token.toLowerCase().replace(/=.*$/, '').replace(/^[<:@]+|[>()]+$/g, '');
  const candidates = [...features, ...ranked];
  const selected = candidates.filter((token) => {
    if (features.includes(token)) return true;
    // `scheduler.yield` adds nothing beside `scheduler.yield()`.
    if (candidates.includes(`${token}()`)) return false;
    const bare = /^[A-Za-z][a-z]*$/.test(token);
    return !(bare && candidates.some((other) => other !== token && stem(other) === stem(token)));
  });
  return selected.slice(0, Math.max(MAX_KEYWORDS, features.length));
}

function lineCount(text: string): number {
  return text.endsWith('\n') ? text.split('\n').length - 1 : text.split('\n').length;
}

function renderIndex(category: string, guides: Rendered[], version: string): string {
  const out = [
    `# ${category} guides`,
    '',
    `<!-- Generated from GoogleChrome/modern-web-guidance v${version} guide metadata (CC-BY 4.0); see ../../UPSTREAM.md -->`,
    '',
    `${guides.length} ${guides.length === 1 ? 'guide' : 'guides'}. Each entry gives the guide link, its line count, a gate tag when the guide carries an Origin Trial or volatile-feature caution, the upstream description, and the platform symbols the guide covers.`,
    '',
  ];
  for (const guide of guides) {
    const lines = lineCount(guide.text);
    const size = lines > LARGE_GUIDE_LINES ? `${lines}L; large guide, grep its \`^## \` headings and read the matching sections with offset and limit` : `${lines}L`;
    const tags = [
      guide.meta.originTrials.length > 0 ? ' [origin-trial]' : '',
      guide.meta.volatileFeatures.length > 0 ? ' [volatile]' : '',
    ].join('');
    const keywords = extractKeywords(guide).map((token) => `\`${token}\``).join(', ');
    out.push(`- [\`${guide.meta.id}\`](../../guides/${guide.relative}) (${size})${tags}: ${guide.meta.description} Keywords/APIs: ${keywords || 'none'}.`);
  }
  return out.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Build, validate, write

type Build = {
  files: Map<string, string>;
  commit: string;
  pkg: PackageInput;
  stats: Record<string, number>;
};

function build(options: Options): Build {
  const commit = resolveCommit(options);
  const pkg = readNpmPackage(options);
  const metas = parseGuidesJson(pkg.guidesJson);
  const blobs = readUpstreamGuides(options.gitDir, commit);
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const sources = new Map<string, string>();
  for (const [relative, blob] of blobs) {
    const text = decoder.decode(blob);
    if (text.includes('\r')) fail(`${relative} has CR line endings`);
    sources.set(relative, text);
  }

  // Duplicate reconciliation.
  const duplicate = blobs.get(DUPLICATE_GUIDE.omitted);
  if (duplicate) {
    const canonical = blobs.get(DUPLICATE_GUIDE.canonical) ?? fail(`${DUPLICATE_GUIDE.canonical} is missing`);
    if (!duplicate.equals(canonical)) fail(`${DUPLICATE_GUIDE.omitted} is no longer byte-identical to ${DUPLICATE_GUIDE.canonical}; review it before vendoring`);
    const omittedId = path.basename(DUPLICATE_GUIDE.omitted, '.md');
    if (metas.some((meta) => meta.id === omittedId)) fail(`gen/guides.json now lists ${omittedId}; review the duplicate rule`);
    for (const [relative, text] of sources) {
      if (new RegExp(`retrieve "[^"]*\\b${omittedId}\\b[^"]*"|${omittedId}\\.md`).test(text)) fail(`${relative} references ${omittedId}`);
    }
    sources.delete(DUPLICATE_GUIDE.omitted);
  }

  // Every upstream mention of the CLI package must be a retrieve reference that adaptation converts.
  const occurrencesBefore = [...sources.values()].reduce((sum, text) => sum + (text.match(/modern-web-guidance/g) ?? []).length, 0);

  // 1:1 inventory.
  const byId = new Map<string, GuideMeta>();
  for (const meta of metas) {
    if (byId.has(meta.id)) fail(`guide id ${meta.id} is not unique across categories`);
    byId.set(meta.id, meta);
  }
  const expected = new Set(metas.map((meta) => `${meta.category}/${meta.id}.md`));
  const missing = [...expected].filter((relative) => !sources.has(relative));
  const extra = [...sources.keys()].filter((relative) => !expected.has(relative));
  if (missing.length > 0 || extra.length > 0) {
    fail(`guide files and gen/guides.json differ. Missing files: ${missing.join(', ') || 'none'}. Unlisted files: ${extra.join(', ') || 'none'}.`);
  }
  const categories = [...new Set(metas.map((meta) => meta.category))].sort();
  const originTrialGuides = metas.filter((meta) => meta.originTrials.length > 0).length;
  const volatileGuides = metas.filter((meta) => meta.volatileFeatures.length > 0).length;
  if (commit === PINNED.commit) {
    for (const [label, actual, wanted] of [
      ['guides', metas.length, PINNED.guideCount],
      ['categories', categories.length, PINNED.categoryCount],
      ['Origin Trial guides', originTrialGuides, PINNED.originTrialGuides],
      ['volatile-feature guides', volatileGuides, PINNED.volatileGuides],
    ] as const) {
      if (actual !== wanted) fail(`pinned release has ${actual} ${label}, expected ${wanted}`);
    }
  }

  // Adapt guides.
  const rendered = [...expected].sort().map((relative) => adaptGuide(relative, sources.get(relative)!, byId.get(path.basename(relative, '.md'))!, byId, pkg.version));
  let rewrites = 0;
  let references = 0;
  for (const guide of rendered) {
    rewrites += guide.rewrites;
    references += guide.references;
    guide.text.split('\n').forEach((line, index) => {
      if (/modern-web-guidance@|\bnpx\b|\bpnpx\b|retrieve "/.test(line)) fail(`${guide.relative}:${index + 1} keeps an unconverted CLI reference: ${line.trim().slice(0, 160)}`);
    });
  }
  if (references !== occurrencesBefore) fail(`converted ${references} retrieve references but upstream mentions modern-web-guidance ${occurrencesBefore} times`);

  const files = new Map<string, string>();
  for (const guide of rendered) files.set(`guides/${guide.relative}`, guide.text);
  for (const category of categories) {
    files.set(`references/index/${category}.md`, renderIndex(category, rendered.filter((guide) => guide.meta.category === category).sort((a, b) => (a.meta.id < b.meta.id ? -1 : a.meta.id > b.meta.id ? 1 : 0)), pkg.version));
  }
  const legacyRules = orderLegacyRules(extractLegacyRules(pkg.legacyScan), byId, commit === PINNED.commit);
  files.set(LEGACY_PATTERNS, renderLegacyPatterns(legacyRules, byId, pkg.version));

  return {
    files,
    commit,
    pkg,
    stats: {
      guides: rendered.length,
      categories: categories.length,
      guidesWithRewrites: rendered.filter((guide) => guide.rewrites > 0).length,
      retrieveReferences: references,
      rewrittenLinks: rewrites,
      gatedGuides: rendered.filter((guide) => guide.gated).length,
      modifiedGuides: rendered.filter((guide) => guide.text !== sources.get(guide.relative)).length,
      originTrialGuides,
      volatileGuides,
      legacyRules: legacyRules.length,
      legacyRuleGuides: new Set(legacyRules.map((rule) => rule.guideId)).size,
    },
  };
}

function listMarkdown(root: string, directory: string): string[] {
  const absolute = path.join(root, directory);
  if (!existsSync(absolute)) return [];
  return readdirSync(absolute, { recursive: true, encoding: 'utf8' })
    .filter((relative) => relative.endsWith('.md'))
    .map((relative) => path.posix.join(directory, relative.split(path.sep).join('/')))
    .sort();
}

/**
 * Validates the complete shipped tree as it will stand after the sync: links resolve inside the skill to a
 * file that survives the sync (not one of the stale generated files it removes), and forbidden tokens are absent.
 */
export function validateTree(files: Map<string, string>, root: string, stale: Set<string>): string[] {
  const problems: string[] = [];
  const shipped = new Map(files);
  for (const name of HAND_AUTHORED) {
    const file = path.join(root, name);
    if (existsSync(file)) shipped.set(name, readFileSync(file, 'utf8'));
  }
  for (const [relative, text] of shipped) {
    if (relative.endsWith('.md')) {
      for (const target of linkTargets(text, relative)) {
        if (/^(https?:|mailto:|#)/.test(target)) continue;
        const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(relative), target.split('#')[0]));
        if (resolved.startsWith('..') || path.posix.isAbsolute(resolved)) problems.push(`${relative}: link ${target} escapes the skill`);
        else if (!shipped.has(resolved) && (stale.has(resolved) || !existsSync(path.join(root, resolved)))) {
          problems.push(`${relative}: link ${target} does not resolve${stale.has(resolved) ? ' after the sync removes its stale target' : ''}`);
        }
      }
    }
    if (relative === 'UPSTREAM.md' || !relative.endsWith('.md')) continue;
    text.split('\n').forEach((line, index) => {
      for (const [pattern, label] of FORBIDDEN) {
        if (pattern.test(line)) problems.push(`${relative}:${index + 1}: ${label}: ${line.trim().slice(0, 120)}`);
      }
    });
  }
  return problems;
}

export type SyncPlan = { changed: string[]; stale: string[]; problems: string[] };

/** Compares a fresh render with the skill directory without writing anything. */
export function planSync(files: Map<string, string>, out: string): SyncPlan {
  // Stale files are known before validation so a link to one fails before anything is written or removed.
  const onDisk = new Set([
    ...GENERATED_DIRS.flatMap((directory) => listMarkdown(out, directory)),
    ...GENERATED_FILES.filter((relative) => existsSync(path.join(out, relative))),
  ]);
  const stale = [...onDisk].filter((relative) => !files.has(relative));
  const problems = validateTree(files, out, new Set(stale));
  for (const name of HAND_AUTHORED) {
    if (!existsSync(path.join(out, name))) problems.push(`hand-authored ${name} is missing from ${out}`);
  }
  const changed = [...files].filter(([relative, text]) => {
    const file = path.join(out, relative);
    return !existsSync(file) || readFileSync(file, 'utf8') !== text;
  }).map(([relative]) => relative);
  return { changed, stale, problems };
}

/** Writes changed generated files and removes stale ones; any validation problem throws before the first write. */
export function writeSync(files: Map<string, string>, out: string): SyncPlan {
  const plan = planSync(files, out);
  if (plan.problems.length > 0) fail(`${plan.problems.map((problem) => `invalid: ${problem}`).join('\n')}\nNo files were written.`);
  for (const relative of plan.changed) {
    const file = path.join(out, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, files.get(relative)!);
  }
  for (const relative of plan.stale) rmSync(path.join(out, relative));
  for (const directory of GENERATED_DIRS) {
    const absolute = path.join(out, directory);
    if (!existsSync(absolute)) continue;
    for (const relative of readdirSync(absolute, { recursive: true, encoding: 'utf8' }).sort().reverse()) {
      const entry = path.join(absolute, relative);
      if (statSync(entry).isDirectory() && readdirSync(entry).length === 0) rmdirSync(entry);
    }
  }
  return plan;
}

function main(): number {
  const options = parseArgs(process.argv.slice(2));
  const result = build(options);
  const plan = options.check ? planSync(result.files, options.out) : writeSync(result.files, options.out);
  const summary = {
    mode: options.check ? 'check' : 'write',
    commit: result.commit,
    package: `${PINNED.packageName}@${result.pkg.version}`,
    tarballSha256: result.pkg.sha256,
    tarballIntegrity: result.pkg.integrity,
    ...result.stats,
    generatedFiles: result.files.size,
    generatedBytes: [...result.files.values()].reduce((sum, text) => sum + Buffer.byteLength(text), 0),
    changed: plan.changed.length,
    stale: plan.stale.length,
  };
  console.log(JSON.stringify(summary, null, 2));
  if (!options.check) return 0;
  for (const relative of plan.changed) console.error(`drift: ${relative} differs from a fresh render`);
  for (const relative of plan.stale) console.error(`drift: ${relative} is not generated`);
  for (const problem of plan.problems) console.error(`invalid: ${problem}`);
  return plan.changed.length > 0 || plan.stale.length > 0 || plan.problems.length > 0 ? 1 : 0;
}

if (import.meta.main) {
  try {
    process.exitCode = main();
  } catch (error) {
    if (error instanceof SyncError) {
      console.error(`sync-modern-web-guidance: ${error.message}`);
      process.exitCode = 1;
    } else {
      throw error;
    }
  }
}
