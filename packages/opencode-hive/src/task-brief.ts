import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  getContextPath,
  getPlanPath,
  getTaskHandoffPath,
  getTaskSpecPath,
  type ContextService,
  type PlanSyncStatus,
  type SessionInfo,
  type TaskStatusEntry,
  type TaskService,
  type TaskSpecFreshness,
} from 'hive-core';
import type { AssignmentMarker, RouteSnapshot } from './runtime/hive-services.js';

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
const ASSIGNMENT_MARKER = /^Hive (task|run):(.*)$/;

/**
 * Matches a generated brief block and its separator, like the route snapshot block.
 * The start marker must open the generated heading line, so an authored prompt that quotes
 * the marker pair inline is preserved.
 */
export const TASK_BRIEF_BLOCK = /(?:\n\n)?<!-- hive-task-brief:start -->\n## Hive task brief\n(?:(?!<!-- hive-task-brief:(?:start|end) -->)[\s\S])*?<!-- hive-task-brief:end -->/g;

export type TaskBriefSources = {
  projectRoot: string;
  taskService: Pick<TaskService, 'listStatusEntries' | 'getSpecFreshness' | 'getPlanSyncStatus'>;
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

/**
 * The exact-case `Hive task: <folder>` or `Hive run: <runId>` marker that opens the prompt's first non-empty line.
 * `id` is undefined when that line opens with a marker but names no ID in that form, such as a marker followed only
 * by whitespace.
 */
function assignmentMarker(prompt: string): { kind: 'task' | 'run'; id: string | undefined } | undefined {
  const match = firstNonEmptyLine(prompt)?.match(ASSIGNMENT_MARKER);
  if (!match) return undefined;
  const rest = match[2]!;
  return { kind: match[1] as 'task' | 'run', id: rest.length > 1 && rest.startsWith(' ') ? rest.slice(1) : undefined };
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
  let planSync: PlanSyncStatus;
  try {
    planSync = taskService.getPlanSyncStatus(featureName);
  } catch {
    planSync = { state: 'unknown', hint: 'Plan sync status could not be calculated.' };
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
    ...(planSync.state !== 'current' ? [`Plan sync ${planSync.state}: ${inline(planSync.hint ?? '')}`] : []),
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
 * Matches a generated route snapshot block and its separator. The start marker must open the
 * generated heading line, so an authored prompt that quotes the marker pair inline is preserved.
 */
export const ROUTE_SNAPSHOT_BLOCK = /(?:\n\n)?<!-- hive-route-snapshot:start -->\n## Hive route snapshot\n(?:(?!<!-- hive-route-snapshot:(?:start|end) -->)[\s\S])*?<!-- hive-route-snapshot:end -->/g;

function escapeRouteSnapshotMarkers(text: string): string {
  return text
    .replaceAll('<!-- hive-route-snapshot:start -->', '&lt;!-- hive-route-snapshot:start -->')
    .replaceAll('<!-- hive-route-snapshot:end -->', '&lt;!-- hive-route-snapshot:end -->');
}

function routeFooter(snapshot: RouteSnapshot, separated: boolean): string {
  const payload = {
    projectRoot: snapshot.projectRoot,
    featureRoute: { selected: snapshot.hasFeatureRoute, feature: snapshot.featureName ?? null },
  };
  const constraints = [
    `Session constraints (revision ${snapshot.sessionConstraints.revision}):\n${escapeRouteSnapshotMarkers(snapshot.sessionConstraints.constraints || '(none)')}`,
    snapshot.featureConstraints
      ? `Feature constraints for ${JSON.stringify(snapshot.featureName)} (revision ${snapshot.featureConstraints.revision}):\n${escapeRouteSnapshotMarkers(snapshot.featureConstraints.constraints || '(none)')}`
      : 'Feature constraints: (none)',
  ].join('\n\n');
  return [
    `${separated ? '\n\n' : ''}<!-- hive-route-snapshot:start -->`,
    '## Hive route snapshot',
    `Route snapshot (JSON): ${JSON.stringify(payload)}`,
    '',
    '## Standing Constraints',
    constraints,
    'This is a dispatch-time snapshot. If directives conflict, report the conflict; runtime routing does not decide it.',
    '<!-- hive-route-snapshot:end -->',
  ].join('\n');
}

/** The parent's authored prompt without the blocks an earlier dispatch generated. */
function authoredPrompt(prompt: unknown): string {
  return typeof prompt === 'string' ? prompt.replace(ROUTE_SNAPSHOT_BLOCK, '').replace(TASK_BRIEF_BLOCK, '') : '';
}

/**
 * The prompt a native subagent call delivers: the parent's authored prompt without earlier generated blocks, the
 * route snapshot footer, then, for a Forager dispatch (built-in or custom-derived) on a selected feature route, the
 * task brief. Both hosts compose it from the parent's own prompt, before the host adds its subagent prefix.
 * `fallbackTaskFolder` is the task a continued child is already bound to; its brief is attached when the follow-up
 * prompt opens with no marker.
 */
export function composeDispatchPrompt(input: { sources: TaskBriefSources; snapshot: RouteSnapshot; prompt: unknown; foragerDispatch: boolean; fallbackTaskFolder?: string }): string {
  const { sources, snapshot, foragerDispatch, fallbackTaskFolder } = input;
  const authored = authoredPrompt(input.prompt);
  const brief = foragerDispatch && snapshot.hasFeatureRoute && typeof snapshot.featureName === 'string'
    ? `\n\n${composeTaskBrief(sources, snapshot.featureName, authored, fallbackTaskFolder)}`
    : '';
  return `${authored}${routeFooter(snapshot, authored.length > 0)}${brief}`;
}

/**
 * What the assignment's first non-empty line binds the child to: `Hive task: <folder>` names a task of the feature the
 * parent explicitly selected, and `Hive run: <runId>` an ad-hoc run of this project whose worktree Hive can read. A
 * line without a marker is `none`. A marker that names no ID, a task of a feature that was only detected, or a task or
 * run Hive cannot read is `invalid`. The association is never guessed from the route, the directory, the prose or an
 * earlier dispatch. Never throws.
 */
export async function resolveAssignment(
  services: { taskService: Pick<TaskService, 'listStatusEntries'>; adhocService: () => { get(runId: string): Promise<unknown> } },
  snapshot: RouteSnapshot,
  prompt: unknown,
): Promise<AssignmentMarker> {
  const marker = assignmentMarker(authoredPrompt(prompt));
  if (marker === undefined) return { state: 'none' };
  const { kind, id } = marker;
  if (id === undefined) return { state: 'invalid' };
  try {
    if (kind === 'task' && snapshot.hasFeatureRoute && typeof snapshot.featureName === 'string'
      && services.taskService.listStatusEntries(snapshot.featureName).some((entry) => entry.folder === id)) {
      return { state: 'resolved', binding: { taskFolder: id } };
    }
    if (kind === 'run' && (await services.adhocService().get(id)) !== null) return { state: 'resolved', binding: { adHocRunId: id } };
  } catch {
    // An unreadable task list or run resolves nothing.
  }
  return { state: 'invalid' };
}

/**
 * The session record that binds a child to the route its parent captured at dispatch. It holds only the route that
 * continuation admission compares; the task or run association is written beside it (see `childAssociation`).
 */
export function childRouteRecord(snapshot: RouteSnapshot, parentSessionId: string, agent?: string) {
  return {
    parentSessionId,
    projectRoot: snapshot.projectRoot,
    featureName: snapshot.hasFeatureRoute ? snapshot.featureName : undefined,
    agent,
    standingConstraintEntries: snapshot.sessionConstraints.entries,
    standingConstraintsRevision: snapshot.sessionConstraints.revision,
    standingConstraints: snapshot.sessionConstraints.constraints || undefined,
  };
}

export type ChildRoute = ReturnType<typeof childRouteRecord>;

/** Whether a stored child binding already carries every field of the route a new dispatch captured. */
export function sameChildRoute(stored: SessionInfo | ChildRoute, route: ChildRoute): boolean {
  return (Object.keys(route) as Array<keyof ChildRoute>).every((key) => JSON.stringify(stored[key]) === JSON.stringify(route[key]));
}

/**
 * The task or run association a dispatch writes into its child's binding. A resolved marker names the task or run, with
 * both keys so the other one clears; an invalid marker clears both. Without a marker nothing is written, so a
 * continuation that omits its marker keeps the task or run the child was bound to. It is observation for viewers and
 * the continuation check; it never comes from the route or the prose.
 */
export function childAssociation(marker: AssignmentMarker): { taskFolder?: string; adHocRunId?: string } {
  if (marker.state === 'none') return {};
  const binding = marker.state === 'resolved' ? marker.binding : undefined;
  return {
    taskFolder: binding !== undefined && 'taskFolder' in binding ? binding.taskFolder : undefined,
    adHocRunId: binding !== undefined && 'adHocRunId' in binding ? binding.adHocRunId : undefined,
  };
}

/**
 * Builds the task brief block for an eligible Forager dispatch whose route has a selected feature.
 * `authoredPrompt` must already exclude generated route-snapshot and brief blocks. A prompt that opens with no marker
 * uses `fallbackTaskFolder` when one is given. Never throws.
 */
export function composeTaskBrief(sources: TaskBriefSources, featureName: string, authoredPrompt: string, fallbackTaskFolder?: string): string {
  try {
    const marker = assignmentMarker(authoredPrompt);
    const folder = marker === undefined ? fallbackTaskFolder : marker.kind === 'task' ? marker.id : undefined;
    if (folder === undefined) {
      return cappedBlock([`No Hive task binding: the first line was not "Hive task: <folder>" for a task in feature ${inline(featureName)}; no task brief attached.`]);
    }
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
