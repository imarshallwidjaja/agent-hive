import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  getContextPath,
  getPlanPath,
  getTaskHandoffPath,
  getTaskSpecPath,
  type ContextService,
  type TaskStatusEntry,
  type TaskService,
  type TaskSpecFreshness,
} from 'hive-core';

export const TASK_BRIEF_MAX_BYTES = 2048;

const BRIEF_START = '<!-- hive-task-brief:start -->';
const BRIEF_END = '<!-- hive-task-brief:end -->';
const BRIEF_HEADING = '## Hive task brief';
const UNAVAILABLE_LINE = `Hive task brief unavailable: locators exceed ${TASK_BRIEF_MAX_BYTES} bytes.`;
const HIVE_BLOCK_MARKERS = [
  BRIEF_START,
  BRIEF_END,
  '<!-- hive-route-snapshot:start -->',
  '<!-- hive-route-snapshot:end -->',
];
const TASK_BINDING = /^Hive task: (.+)$/;

/**
 * Matches a generated brief block and its separator, like the route snapshot block.
 * The start marker must open the generated heading line, so an authored prompt that quotes
 * the marker pair inline is preserved.
 */
export const TASK_BRIEF_BLOCK = /(?:\n\n)?<!-- hive-task-brief:start -->\n## Hive task brief\n(?:(?!<!-- hive-task-brief:(?:start|end) -->)[\s\S])*?<!-- hive-task-brief:end -->/g;

export type TaskBriefSources = {
  projectRoot: string;
  taskService: Pick<TaskService, 'listStatusEntries' | 'getSpecFreshness'>;
  contextService: Pick<ContextService, 'readSummary'>;
};

/** Keeps variable content on one line and unable to open or close a Hive block. */
function inline(text: string): string {
  let escaped = text.replace(/\s*[\r\n]+\s*/g, ' ');
  for (const marker of HIVE_BLOCK_MARKERS) escaped = escaped.replaceAll(marker, `&lt;${marker.slice(1)}`);
  return escaped;
}

const byteLength = (text: string): number => Buffer.byteLength(text, 'utf8');

function renderBlock(lines: string[]): string {
  return [BRIEF_START, BRIEF_HEADING, ...lines, BRIEF_END].join('\n');
}

/** Structural cap: any block over budget collapses to the fixed unavailable line. */
function cappedBlock(lines: string[]): string {
  const block = renderBlock(lines);
  return byteLength(block) > TASK_BRIEF_MAX_BYTES ? renderBlock([UNAVAILABLE_LINE]) : block;
}

const fits = (lines: string[]): boolean => byteLength(renderBlock(lines)) <= TASK_BRIEF_MAX_BYTES;

/** Truncates only the variable part of a single-line message so the block stays within budget. */
function fitMessage(prefix: string, variable: string, suffix: string): string {
  const available = TASK_BRIEF_MAX_BYTES - byteLength(renderBlock([`${prefix}${suffix}`]));
  if (byteLength(variable) <= available) return `${prefix}${variable}${suffix}`;
  let kept = '';
  let used = byteLength('...');
  for (const char of variable) {
    used += byteLength(char);
    if (used > available) break;
    kept += char;
  }
  return `${prefix}${kept}...${suffix}`;
}

/** Shortens a variable value so the block it renders into fits; undefined when even "..." cannot. */
function fitVariable(render: (variable: string) => string[], variable: string): string | undefined {
  const available = TASK_BRIEF_MAX_BYTES - byteLength(renderBlock(render('')));
  if (available <= byteLength('...')) return undefined;
  let kept = '';
  let used = byteLength('...');
  for (const char of variable) {
    used += byteLength(char);
    if (used > available) break;
    kept += char;
  }
  return `${kept}...`;
}

function firstNonEmptyLine(prompt: string): string | undefined {
  return prompt.split(/\r?\n/).map((line) => line.trim()).find((line) => line.length > 0);
}

function composeBoundLines(sources: TaskBriefSources, featureName: string, tasks: Map<string, TaskStatusEntry>, folder: string): string[] {
  const { projectRoot, taskService, contextService } = sources;
  const task = tasks.get(folder)!;
  if ('integrity' in task) {
    return [fitMessage('Task status integrity: "', inline(folder), `" has missing/unreadable status (${task.integrity.reason}); do not execute; the primary must inspect and repair the task status.`)];
  }
  let freshness: TaskSpecFreshness | undefined;
  try {
    freshness = taskService.getSpecFreshness(featureName).find((entry) => entry.folder === folder);
  } catch {
    // Matches hive_status: an uncomparable plan is reported, not fatal.
  }
  const planPath = getPlanPath(projectRoot, featureName);
  const handoffPath = getTaskHandoffPath(projectRoot, featureName, folder);
  const decisionsPath = path.join(getContextPath(projectRoot, featureName), 'execution-decisions.md');

  const coreWithTitle = (title: string): string[] => [
    'Dispatch-time pointers from Hive state. Read what applies before editing; the assignment governs; report conflicts.',
    `Task: ${inline(folder)} - ${title} (${inline(task.status)})`,
    `Spec: ${inline(getTaskSpecPath(projectRoot, featureName, folder))} - specStale: ${freshness?.specStale ?? null} (${inline(freshness?.specStaleReason ?? 'freshness_unavailable')})`,
    ...(fs.existsSync(planPath)
      ? [`Plan: ${inline(planPath)}${freshness?.planSection ? ` lines ${freshness.planSection.startLine}-${freshness.planSection.endLine}` : ''}`]
      : []),
  ];
  const fullTitle = inline(task.planTitle || folder);
  let core = coreWithTitle(fullTitle);
  if (!fits(core)) {
    // The title is prose, not a locator: shorten it so the paths still travel.
    const shortened = fitVariable(coreWithTitle, fullTitle);
    if (shortened === undefined) return [UNAVAILABLE_LINE];
    core = coreWithTitle(shortened);
    if (!fits(core)) return [UNAVAILABLE_LINE];
  }

  const before = [
    ...(freshness?.unownedHeadingLines?.length
      ? [`Unowned plan headings after this task's section at lines ${freshness.unownedHeadingLines.join(', ')}: read them; they may be binding amendments.`]
      : []),
    ...(fs.existsSync(handoffPath) ? [`Handoff: ${inline(handoffPath)}`] : []),
  ];
  const dependencies = task.dependsOn.map((dependency) => {
    const known = tasks.get(dependency);
    const dependencyHandoff = known ? getTaskHandoffPath(projectRoot, featureName, dependency) : undefined;
    const status = known && 'integrity' in known ? known.integrity.reason : known?.status ?? 'unknown';
    return `- ${inline(dependency)} (${inline(status)})${dependencyHandoff && fs.existsSync(dependencyHandoff) ? ` handoff: ${inline(dependencyHandoff)}` : ''}`;
  });
  let durableCount = 'unknown';
  try {
    durableCount = String(contextService.readSummary({ type: 'feature', featureName }).durable.fileCount);
  } catch {
    // The count is advisory; the catalog read remains the source of truth.
  }
  const after = [
    `Feature context: ${durableCount} durable catalog entries; read with hive_context_read({ feature: "${inline(featureName)}", view: "catalog" }).`,
    ...(fs.existsSync(decisionsPath) ? [`Execution decisions: ${inline(decisionsPath)}`] : []),
  ];

  const withDependencies = (kept: number): string[] => dependencies.length === 0
    ? ['Dependencies: none']
    : ['Dependencies:', ...dependencies.slice(0, kept), ...(kept < dependencies.length ? [`- (+${dependencies.length - kept} more; see hive_status)`] : [])];
  const assembled = (kept: number): string[] => [...core, ...before, ...withDependencies(kept), ...after];
  for (let kept = dependencies.length; kept >= 0; kept -= 1) {
    if (fits(assembled(kept))) return assembled(kept);
  }
  // No dependency header may render without entries or the more-line, so fall back to the
  // unowned-heading and own-handoff lines, then to the core locators alone.
  if (fits([...core, ...before])) return [...core, ...before];
  return core;
}

/**
 * Builds the task brief block for an eligible Forager dispatch whose route has a selected feature.
 * `authoredPrompt` must already exclude generated route-snapshot and brief blocks. Never throws.
 */
export function composeTaskBrief(sources: TaskBriefSources, featureName: string, authoredPrompt: string): string {
  try {
    const binding = firstNonEmptyLine(authoredPrompt)?.match(TASK_BINDING);
    if (!binding) {
      return cappedBlock([`No Hive task binding: the first line was not "Hive task: <folder>" for a task in feature ${inline(featureName)}; no task brief attached.`]);
    }
    const folder = binding[1]!;
    const tasks = new Map(sources.taskService.listStatusEntries(featureName).map((task) => [task.folder, task]));
    if (!tasks.has(folder)) {
      return cappedBlock([fitMessage('No Hive task binding: "', inline(folder), `" is not a task in feature ${inline(featureName)}; no task brief attached.`)]);
    }
    return cappedBlock(composeBoundLines(sources, featureName, tasks, folder));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return cappedBlock([fitMessage('Hive task brief unavailable: ', inline(message).trim(), '')]);
  }
}
