import {
  getPlanPath,
  getFeaturePath,
  getFeatureJsonPath,
  getApprovedPath,
  readJson,
  writeJson,
  readText,
  writeText,
  fileExists,
} from '../utils/paths.js';
import type {
  FeatureJson,
  PlanComment,
  PlanHeadingOutline,
  PlanPatchOperation,
  PlanPatchResult,
  PlanReadOptions,
  PlanReadOutlineResult,
  PlanReadResult,
  PlanTaskOutline,
  PlanUnownedTaskHeading,
  PlanWriteResult,
} from '../types.js';
import {
  getFenceTransition,
  readPlanTaskLayout,
  listUnownedTaskHeadings,
  type FenceState,
} from '../utils/planTaskSections.js';
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { ReviewService } from './reviewService.js';

interface ParsedHeading extends PlanHeadingOutline {
  start: number;
}

function getContentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function getRevision(contentHash: string, comments: PlanComment[], isApproved: boolean): string {
  return createHash('sha256')
    .update(JSON.stringify({ contentHash, comments, isApproved }))
    .digest('hex');
}

function normalizeHeadingTitle(rawTitle: string): string {
  return rawTitle.replace(/\s+#+\s*$/, '').trim();
}

function hasUnclosedFence(content: string): boolean {
  let fence: FenceState | null = null;
  const nestedFences: FenceState[] = [];

  for (const lineWithEnding of content.matchAll(/.*(?:\r?\n|$)/g)) {
    const rawLine = lineWithEnding[0];
    if (rawLine.length === 0) break;

    const line = rawLine.replace(/\r?\n$/, '');
    const transition = getFenceTransition(line, fence, nestedFences);
    if (!transition) continue;

    if (!fence && transition.opened) {
      fence = transition.opened;
    } else if (transition.closedOuter) {
      fence = null;
    }
  }

  return fence !== null;
}

function parseHeadings(content: string): ParsedHeading[] {
  const headings: ParsedHeading[] = [];
  const stack: string[] = [];
  let offset = 0;
  let fence: FenceState | null = null;
  const nestedFences: FenceState[] = [];

  for (const lineWithEnding of content.matchAll(/.*(?:\r?\n|$)/g)) {
    const rawLine = lineWithEnding[0];
    if (rawLine.length === 0) break;

    const line = rawLine.replace(/\r?\n$/, '');
    const transition = getFenceTransition(line, fence, nestedFences);
    if (transition) {
      if (!fence && transition.opened) {
        fence = transition.opened;
      } else if (transition.closedOuter) {
        fence = null;
      }
      offset += rawLine.length;
      continue;
    }

    if (fence) {
      offset += rawLine.length;
      continue;
    }

    const headingMatch = line.match(/^ {0,3}(#{1,6})\s+(.+?)\s*$/);
    if (!headingMatch) {
      offset += rawLine.length;
      continue;
    }

    const level = headingMatch[1].length;
    const title = normalizeHeadingTitle(headingMatch[2]);
    stack[level - 1] = title;
    stack.length = level;

    headings.push({
      level,
      title,
      path: [...stack],
      start: offset,
    });

    offset += rawLine.length;
  }

  return headings;
}

function findSectionEnd(content: string, headings: ParsedHeading[], headingIndex: number): number {
  const heading = headings[headingIndex];
  const next = headings.slice(headingIndex + 1).find(candidate => candidate.level <= heading.level);
  return next?.start ?? content.length;
}

function pathMatches(actualPath: string[], expectedPath: string[]): boolean {
  if (expectedPath.length === 0 || expectedPath.length > actualPath.length) return false;
  const actualTail = actualPath.slice(actualPath.length - expectedPath.length);
  return actualTail.every((part, index) => part === expectedPath[index]);
}

function findSection(content: string, headingPath: string[]): { heading: ParsedHeading; end: number } {
  const headings = parseHeadings(content);
  const matches = headings
    .map((heading, index) => ({ heading, end: findSectionEnd(content, headings, index) }))
    .filter(candidate => pathMatches(candidate.heading.path, headingPath));

  if (matches.length === 0) {
    throw new Error(`Plan section not found: ${headingPath.join(' > ')}`);
  }

  if (matches.length > 1) {
    throw new Error(`Plan section path is ambiguous: ${headingPath.join(' > ')}`);
  }

  return matches[0];
}

function findTasksSection(content: string): { heading: ParsedHeading; end: number } {
  const headings = parseHeadings(content);
  const matches = headings
    .map((heading, index) => ({ heading, end: findSectionEnd(content, headings, index) }))
    .filter(candidate => candidate.heading.level === 2 && candidate.heading.title.toLowerCase() === 'tasks');

  if (matches.length === 0) {
    throw new Error('Plan section not found: Tasks');
  }

  if (matches.length > 1) {
    throw new Error('Plan contains multiple Tasks sections');
  }

  return matches[0];
}

function getFirstNonBlankLine(content: string): string | null {
  return content.split(/\r?\n/).find(line => line.trim().length > 0) ?? null;
}

function getReplacementHeading(content: string): { level: number; title: string } | null {
  const firstLine = getFirstNonBlankLine(content);
  const match = firstLine?.match(/^ {0,3}(#{1,6})\s+(.+?)\s*$/);
  if (!match) return null;
  return { level: match[1].length, title: normalizeHeadingTitle(match[2]) };
}

function replacementStartsWithTask(content: string, taskNumber: number): boolean {
  const firstLine = getFirstNonBlankLine(content);
  return new RegExp(`^ {0,3}###\\s+${taskNumber}\\.\\s+`).test(firstLine ?? '');
}

function assertNoAdditionalBoundaryHeadings(content: string, maxLevel: number): void {
  const additionalHeading = parseHeadings(content)
    .slice(1)
    .find(heading => heading.level <= maxLevel);

  if (additionalHeading) {
    throw new Error(`Replacement content must not include additional heading '${additionalHeading.title}'`);
  }
}

function assertClosedFences(content: string): void {
  if (hasUnclosedFence(content)) {
    throw new Error('Patch content must not contain an unclosed fenced code block');
  }
}

function assertNoDuplicateTaskNumbers(content: string): void {
  const seen = new Set<number>();
  for (const task of extractTaskList(content)) {
    if (seen.has(task.taskNumber)) {
      throw new Error(`Plan contains duplicate task number: ${task.taskNumber}`);
    }
    seen.add(task.taskNumber);
  }
}

function assertNoDuplicateSectionPaths(content: string): void {
  const seen = new Set<string>();
  for (const heading of parseHeadings(content)) {
    const key = heading.path.join('\0');
    if (seen.has(key)) {
      throw new Error(`Plan contains duplicate section path: ${heading.path.join(' > ')}`);
    }
    seen.add(key);
  }
}

function assertInsertedSectionPathIsNew(content: string, target: ParsedHeading, insertedTitle: string): void {
  const insertedPath = [
    ...target.path.slice(0, target.level - 1),
    insertedTitle,
  ];
  const duplicate = parseHeadings(content).some(heading =>
    heading.level === target.level &&
    heading.path.length === insertedPath.length &&
    heading.path.every((part, index) => part === insertedPath[index])
  );

  if (duplicate) {
    throw new Error(`Insertion would create duplicate section path: ${insertedPath.join(' > ')}`);
  }
}

function acquirePlanPatchLock(projectRoot: string, featureName: string): () => void {
  const lockPath = path.join(getFeaturePath(projectRoot, featureName), '.plan-patch.lock');
  try {
    fs.mkdirSync(lockPath);
  } catch (error) {
    const lockError = error as NodeJS.ErrnoException;
    if (lockError.code === 'EEXIST') {
      throw new Error(`Plan patch lock is already held for feature '${featureName}'`);
    }
    throw error;
  }

  return () => {
    fs.rmSync(lockPath, { recursive: true, force: true });
  };
}

function replaceRange(content: string, start: number, end: number, replacement: string): string {
  return `${content.slice(0, start)}${replacement}${content.slice(end)}`;
}

function normalizePatchBlock(content: string, start: number, end: number, block: string): string {
  let normalized = block;

  if (start > 0 && !content.slice(0, start).endsWith('\n')) {
    normalized = `\n\n${normalized.replace(/^\r?\n+/, '')}`;
  }

  if (end < content.length && !normalized.endsWith('\n') && !content.slice(end).startsWith('\n')) {
    normalized = `${normalized}\n\n`;
  }

  return normalized;
}

function extractTaskList(content: string): PlanTaskOutline[] {
  let tasksSection: ReturnType<typeof findTasksSection>;
  try {
    tasksSection = findTasksSection(content);
  } catch (error) {
    if (error instanceof Error && /not found/i.test(error.message)) {
      return [];
    }

    throw error;
  }

  const taskList: PlanTaskOutline[] = [];
  const taskPattern = /^(\d+)\.\s+(.+?)\s*$/;
  const taskHeadings = parseHeadings(content)
    .filter(heading => heading.level === 3 && heading.start >= tasksSection.heading.start && heading.start < tasksSection.end);

  for (const heading of taskHeadings) {
    const match = heading.title.match(taskPattern);
    if (!match) continue;
    taskList.push({
      taskNumber: Number(match[1]),
      title: normalizeHeadingTitle(match[2]),
    });
  }

  return taskList;
}

function buildOutline(content: string): { headings: PlanHeadingOutline[]; taskList: PlanTaskOutline[] } {
  return {
    headings: parseHeadings(content).map(({ level, title, path }) => ({ level, title, path })),
    taskList: extractTaskList(content),
  };
}

const PATCH_TASK_SECTION_HEADING_GUIDANCE =
  'Inside ## Tasks every ### heading must be a numbered task (### N. Title). '
  + 'Put task amendments inside the owning task as a level-4 (####) subsection by rewriting the task with replace_task, '
  + 'and move shared notes outside ## Tasks.';

// A replace_task cannot rewrite an existing orphan heading: it stops at the next level-3 heading,
// and a replace_section on the orphan must keep its own heading. Repairing the section is the working fix.
const APPROVAL_TASK_SECTION_HEADING_GUIDANCE =
  'To repair an existing unnumbered heading, rewrite ## Tasks with one replace_section (headingPath ["Tasks"]) '
  + 'that folds each amendment into its owning task as a level-4 (####) subsection or moves shared notes outside ## Tasks.';

function formatUnownedTaskHeadings(headings: PlanUnownedTaskHeading[]): string {
  return headings.map(heading => `line ${heading.line}: ### ${heading.title}`).join('; ');
}

function findUnownedTaskHeadings(content: string): PlanUnownedTaskHeading[] {
  try {
    return listUnownedTaskHeadings(readPlanTaskLayout(content));
  } catch {
    // A plan with multiple Tasks sections has no single task layout; sync and approve report that error.
    return [];
  }
}

function withUnownedTaskHeadings<T extends object>(result: T, content: string): T & { unownedTaskHeadings?: PlanUnownedTaskHeading[] } {
  const unownedTaskHeadings = findUnownedTaskHeadings(content);
  return unownedTaskHeadings.length > 0 ? { ...result, unownedTaskHeadings } : result;
}

/** Reject unowned task-section headings the patch adds; ones already present may stay. */
function assertNoNewUnownedTaskHeadings(before: string, after: string): void {
  const remaining = new Map<string, number>();
  for (const heading of findUnownedTaskHeadings(before)) {
    remaining.set(heading.title, (remaining.get(heading.title) ?? 0) + 1);
  }
  const added = findUnownedTaskHeadings(after).filter(heading => {
    const count = remaining.get(heading.title) ?? 0;
    if (count === 0) return true;
    remaining.set(heading.title, count - 1);
    return false;
  });

  if (added.length > 0) {
    throw new Error(
      `Plan patch would add task-section heading(s) that are not numbered tasks: ${formatUnownedTaskHeadings(added)}. `
      + PATCH_TASK_SECTION_HEADING_GUIDANCE,
    );
  }
}

export class PlanService {
  private reviewService: ReviewService;

  constructor(private projectRoot: string) {}

  private getReviewService(): ReviewService {
    if (!this.reviewService) {
      this.reviewService = new ReviewService(this.projectRoot);
    }

    return this.reviewService;
  }

  private withPlanStateLock<T>(featureName: string, fn: () => T): T {
    const releaseLock = acquirePlanPatchLock(this.projectRoot, featureName);
    try {
      this.assertFeatureMutable(featureName);
      return fn();
    } finally {
      releaseLock();
    }
  }

  private assertFeatureMutable(featureName: string): void {
    const feature = readJson<FeatureJson>(getFeatureJsonPath(this.projectRoot, featureName));
    if (feature?.status === 'completed') {
      throw new Error(`Feature '${featureName}' is completed and cannot be modified`);
    }
  }

  write(featureName: string, content: string): PlanWriteResult {
    return this.withPlanStateLock(featureName, () => {
      const planPath = getPlanPath(this.projectRoot, featureName);
      writeText(planPath, content);

      this.clearCommentsUnlocked(featureName);
      this.revokeApprovalUnlocked(featureName);

      return withUnownedTaskHeadings({ path: planPath }, content);
    });
  }

  read(featureName: string): PlanReadResult | null;
  read(featureName: string, options: { mode: 'full' }): PlanReadResult | null;
  read(featureName: string, options: { mode: 'outline' }): PlanReadOutlineResult | null;
  read(featureName: string, options: PlanReadOptions = {}): PlanReadResult | PlanReadOutlineResult | null {
    const planPath = getPlanPath(this.projectRoot, featureName);
    const content = readText(planPath);

    if (content === null) return null;

    const comments = this.getComments(featureName);
    const isApproved = this.isApproved(featureName);
    const contentHash = getContentHash(content);
    const revision = getRevision(contentHash, comments, isApproved);
    const base = {
      status: isApproved ? 'approved' as const : 'planning' as const,
      comments,
      revision,
      contentHash,
    };

    if (options.mode === 'outline') {
      return {
        ...base,
        ...buildOutline(content),
      };
    }

    return withUnownedTaskHeadings({
      ...base,
      content,
    }, content);
  }

  patch(
    featureName: string,
    expectedRevision: string,
    operations: PlanPatchOperation[],
    validateContent?: (content: string) => string | null,
  ): PlanPatchResult {
    const releaseLock = acquirePlanPatchLock(this.projectRoot, featureName);
    try {
      this.assertFeatureMutable(featureName);
      const planPath = getPlanPath(this.projectRoot, featureName);
      const content = readText(planPath);

      if (content === null) {
        throw new Error(`No plan.md found for feature '${featureName}'`);
      }

      const currentContentHash = getContentHash(content);
      const currentRevision = getRevision(currentContentHash, this.getComments(featureName), this.isApproved(featureName));
      if (expectedRevision !== currentRevision) {
        throw new Error(`Stale plan revision: expected ${expectedRevision}, current ${currentRevision}`);
      }

      if (operations.length === 0) {
        throw new Error('At least one plan patch operation is required');
      }

      let nextContent = content;
      const changedSections: string[] = [];

      for (const operation of operations) {
        switch (operation.type) {
          case 'replace_section': {
            assertClosedFences(operation.content);
            const target = findSection(nextContent, operation.headingPath);
            const expectedHeading = operation.headingPath.at(-1);
            const replacementHeading = getReplacementHeading(operation.content);
            if (replacementHeading?.title !== expectedHeading || replacementHeading.level !== target.heading.level) {
              throw new Error(`Replacement content must start with heading '${expectedHeading}'`);
            }
            assertNoAdditionalBoundaryHeadings(operation.content, target.heading.level);

            const replacement = normalizePatchBlock(nextContent, target.heading.start, target.end, operation.content);
            nextContent = replaceRange(nextContent, target.heading.start, target.end, replacement);
            changedSections.push(operation.headingPath.join(' > '));
            break;
          }
          case 'insert_after_section': {
            assertClosedFences(operation.content);
            const target = findSection(nextContent, operation.headingPath);
            const insertionHeading = getReplacementHeading(operation.content);
            if (!insertionHeading || insertionHeading.level !== target.heading.level) {
              throw new Error(`Insertion content must start with sibling heading at level ${target.heading.level}`);
            }
            assertNoAdditionalBoundaryHeadings(operation.content, target.heading.level);
            assertInsertedSectionPathIsNew(nextContent, target.heading, insertionHeading.title);
            const insertion = normalizePatchBlock(nextContent, target.end, target.end, operation.content);
            nextContent = replaceRange(nextContent, target.end, target.end, insertion);
            changedSections.push(operation.headingPath.join(' > '));
            break;
          }
          case 'replace_task': {
            assertClosedFences(operation.content);
            if (!Number.isInteger(operation.taskNumber) || operation.taskNumber < 1) {
              throw new Error('Task number must be a positive integer');
            }

            const tasksSection = findTasksSection(nextContent);
            const taskHeadings = parseHeadings(nextContent)
              .filter(heading => heading.level === 3 && heading.start >= tasksSection.heading.start && heading.start < tasksSection.end);
            const numberedTaskHeadings = taskHeadings
              .map(heading => ({ heading, match: heading.title.match(/^(\d+)\.\s+/) }))
              .filter((candidate): candidate is { heading: ParsedHeading; match: RegExpMatchArray } => candidate.match !== null);
            const targetTaskHeadings = numberedTaskHeadings
              .filter(candidate => Number(candidate.match[1]) === operation.taskNumber);

            if (targetTaskHeadings.length === 0) {
              throw new Error(`Plan task not found: ${operation.taskNumber}`);
            }
            if (targetTaskHeadings.length > 1) {
              throw new Error(`Plan task number is duplicated: ${operation.taskNumber}`);
            }

            const taskStart = targetTaskHeadings[0].heading.start;
            const taskEnd = taskHeadings.find(heading => heading.start > taskStart)?.start ?? tasksSection.end;
            if (taskEnd <= taskStart) {
              throw new Error(`Invalid plan task range for task ${operation.taskNumber}`);
            }
            if (!replacementStartsWithTask(operation.content, operation.taskNumber)) {
              throw new Error(`Replacement task content must start with '### ${operation.taskNumber}. ...'`);
            }
            assertNoAdditionalBoundaryHeadings(operation.content, 3);

            const replacement = normalizePatchBlock(nextContent, taskStart, taskEnd, operation.content);
            nextContent = replaceRange(nextContent, taskStart, taskEnd, replacement);
            changedSections.push(`Task ${operation.taskNumber}`);
            break;
          }
          default: {
            const unknown = operation as { type?: string };
            throw new Error(`Unsupported plan patch operation: ${unknown.type ?? 'unknown'}`);
          }
        }
      }

      assertNoDuplicateSectionPaths(nextContent);
      assertNoDuplicateTaskNumbers(nextContent);
      assertNoNewUnownedTaskHeadings(content, nextContent);

      const validationError = validateContent?.(nextContent);
      if (validationError) {
        throw new Error(validationError);
      }

      const preWriteContent = readText(planPath);
      if (preWriteContent === null) {
        throw new Error(`No plan.md found for feature '${featureName}'`);
      }
      const preWriteRevision = getRevision(getContentHash(preWriteContent), this.getComments(featureName), this.isApproved(featureName));
      if (expectedRevision !== preWriteRevision) {
        throw new Error(`Stale plan revision: expected ${expectedRevision}, current ${preWriteRevision}`);
      }

      writeText(planPath, nextContent);
      this.clearCommentsUnlocked(featureName);
      this.revokeApprovalUnlocked(featureName);

      const nextContentHash = getContentHash(nextContent);
      const nextRevision = getRevision(nextContentHash, [], false);
      return {
        revision: nextRevision,
        contentHash: nextContentHash,
        changedSections,
      };
    } finally {
      releaseLock();
    }
  }

  approve(featureName: string): void {
    this.withPlanStateLock(featureName, () => {
      if (!fileExists(getPlanPath(this.projectRoot, featureName))) {
        throw new Error(`No plan.md found for feature '${featureName}'`);
      }

      if (this.getReviewService().hasUnresolvedThreads(featureName, 'plan')) {
        throw new Error(`Cannot approve feature '${featureName}' with unresolved review comments`);
      }

      let unownedTaskHeadings: PlanUnownedTaskHeading[];
      try {
        unownedTaskHeadings = listUnownedTaskHeadings(readPlanTaskLayout(readText(getPlanPath(this.projectRoot, featureName)) ?? ''));
      } catch (error) {
        // An unreadable task layout (for example two Tasks sections) makes the plan unexecutable.
        throw new Error(`Cannot approve feature '${featureName}': ${error instanceof Error ? error.message : String(error)}`);
      }

      if (unownedTaskHeadings.length > 0) {
        throw new Error(
          `Cannot approve feature '${featureName}': ## Tasks contains heading(s) that are not numbered tasks: `
          + `${formatUnownedTaskHeadings(unownedTaskHeadings)}. ${APPROVAL_TASK_SECTION_HEADING_GUIDANCE}`,
        );
      }

      const approvedPath = getApprovedPath(this.projectRoot, featureName);
      const timestamp = new Date().toISOString();
      fs.writeFileSync(approvedPath, `Approved at ${timestamp}\n`);

      // Also update feature.json for backwards compatibility
      const featurePath = getFeatureJsonPath(this.projectRoot, featureName);
      const feature = readJson<FeatureJson>(featurePath);
      if (feature) {
        feature.status = 'approved';
        feature.approvedAt = timestamp;
        writeJson(featurePath, feature);
      }
    });
  }

  isApproved(featureName: string): boolean {
    return fileExists(getApprovedPath(this.projectRoot, featureName));
  }

  revokeApproval(featureName: string): void {
    this.withPlanStateLock(featureName, () => this.revokeApprovalUnlocked(featureName));
  }

  private revokeApprovalUnlocked(featureName: string): void {
    const approvedPath = getApprovedPath(this.projectRoot, featureName);
    if (fileExists(approvedPath)) {
      fs.unlinkSync(approvedPath);
    }

    // Also update feature.json for backwards compatibility
    const featurePath = getFeatureJsonPath(this.projectRoot, featureName);
    const feature = readJson<FeatureJson>(featurePath);
    if (feature && feature.status === 'approved') {
      feature.status = 'planning';
      delete feature.approvedAt;
      writeJson(featurePath, feature);
    }
  }

  getComments(featureName: string): PlanComment[] {
    return this.getReviewService().getThreads(featureName, 'plan');
  }

  addComment(featureName: string, comment: Omit<PlanComment, 'id'>): PlanComment {
    return this.withPlanStateLock(featureName, () => {
      const newComment: PlanComment = {
        ...comment,
        id: `comment-${Date.now()}`,
      };

      this.getReviewService().saveThreads(featureName, 'plan', [
        ...this.getComments(featureName),
        newComment,
      ]);

      return newComment;
    });
  }

  clearComments(featureName: string): void {
    this.withPlanStateLock(featureName, () => this.clearCommentsUnlocked(featureName));
  }

  private clearCommentsUnlocked(featureName: string): void {
    this.getReviewService().clear(featureName, 'plan');
  }
}
