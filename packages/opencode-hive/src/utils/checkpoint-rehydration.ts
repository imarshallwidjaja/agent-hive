import * as path from 'path';
import { getTaskReportPath, getTaskSpecPath, getTaskStatusPath, normalizePath, readJson, readText } from 'hive-core';
import type { TaskStatus } from 'hive-core';
import { readTaskCheckpoint } from './task-checkpoint.js';

export const MAX_REHYDRATION_CHARS = 1200;
const MAX_SUMMARY_CHARS = 280;
const MAX_FILE_SNIPPET_CHARS = 220;

export interface CheckpointRehydrationInput {
  projectRoot: string;
  featureName: string;
  taskFolder: string;
  workerPromptPath: string;
}

function clampText(value: string | undefined, maxChars: number): string | null {
  if (!value) {
    return null;
  }

  const compact = value.replace(/\s+/g, ' ').trim();
  if (!compact) {
    return null;
  }

  if (compact.length <= maxChars) {
    return compact;
  }

  return `${compact.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function sanitizeSupportFile(content: string | null, maxChars: number): string | null {
  if (!content) {
    return null;
  }

  const cleaned = content
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => !/^#+\s/.test(line))
    .filter((line) => !/^messages?\s*:/i.test(line))
    .filter((line) => !/^parts?\s*:/i.test(line))
    .filter((line) => !/^transcript\s*:/i.test(line))
    .filter((line) => !/^prompt\s*:/i.test(line))
    .filter((line) => !/^raw_/i.test(line))
    .filter((line) => !/whole_history_copy_should_not_survive/i.test(line))
    .filter((line) => !/raw_prompt_should_not_survive/i.test(line))
    .filter((line) => !/whole[-_\s]?history/i.test(line))
    .filter((line) => !/transcript/i.test(line))
    .join(' ');

  return clampText(cleaned, maxChars);
}

function appendLine(lines: string[], line: string | null) {
  if (!line) {
    return;
  }

  lines.push(line);
}

function appendList(lines: string[], heading: string, values: string[] | undefined, maxItems = 3, maxChars = MAX_FILE_SNIPPET_CHARS) {
  if (!Array.isArray(values) || values.length === 0) {
    return;
  }

  const sanitized = values
    .map((value) => clampText(value, maxChars))
    .filter((value): value is string => !!value)
    .slice(0, maxItems);

  if (sanitized.length === 0) {
    return;
  }

  lines.push(heading);
  for (const value of sanitized) {
    lines.push(`- ${value}`);
  }
}

export function buildCheckpointRehydration(input: CheckpointRehydrationInput): string | null {
  const statusPath = getTaskStatusPath(input.projectRoot, input.featureName, input.taskFolder);
  const specPath = getTaskSpecPath(input.projectRoot, input.featureName, input.taskFolder);
  const reportPath = getTaskReportPath(input.projectRoot, input.featureName, input.taskFolder);
  const checkpoint = readTaskCheckpoint(input.projectRoot, input.featureName, input.taskFolder);
  const status = readJson<TaskStatus>(statusPath);
  const specSnippet = sanitizeSupportFile(readText(specPath), MAX_FILE_SNIPPET_CHARS);
  const reportSnippet = sanitizeSupportFile(readText(reportPath), MAX_FILE_SNIPPET_CHARS);

  if (!checkpoint && !status && !specSnippet && !reportSnippet) {
    return null;
  }

  const taskBasePath = normalizePath(path.posix.join('.hive', 'features', input.featureName, 'tasks', input.taskFolder));
  const lines: string[] = [
    'Task checkpoint rehydration — prior chat may have been compacted or a child session just returned idle.',
    `Task: ${input.taskFolder}`,
  ];

  if (checkpoint) {
    appendLine(lines, clampText(checkpoint.currentObjective, MAX_SUMMARY_CHARS) ? `Objective: ${clampText(checkpoint.currentObjective, MAX_SUMMARY_CHARS)}` : null);
    appendLine(lines, checkpoint.status ? `Checkpoint status: ${checkpoint.status}` : null);
    appendLine(lines, clampText(checkpoint.stateSummary, MAX_SUMMARY_CHARS) ? `Checkpoint summary: ${clampText(checkpoint.stateSummary, MAX_SUMMARY_CHARS)}` : null);
    appendList(lines, 'Important decisions:', checkpoint.importantDecisions, 3, MAX_FILE_SNIPPET_CHARS);
    appendList(lines, 'Files already in play:', checkpoint.filesInPlay, 4, MAX_FILE_SNIPPET_CHARS);
    appendLine(lines, clampText(checkpoint.verificationState, MAX_FILE_SNIPPET_CHARS) ? `Verification state: ${clampText(checkpoint.verificationState, MAX_FILE_SNIPPET_CHARS)}` : null);
    appendLine(lines, clampText(checkpoint.nextAction, MAX_FILE_SNIPPET_CHARS) ? `Next action: ${clampText(checkpoint.nextAction, MAX_FILE_SNIPPET_CHARS)}` : null);
    appendLine(lines, clampText(checkpoint.blocker, MAX_FILE_SNIPPET_CHARS) ? `Blocker: ${clampText(checkpoint.blocker, MAX_FILE_SNIPPET_CHARS)}` : null);
  } else {
    appendLine(lines, status?.planTitle ? `Title: ${status.planTitle}` : null);
    appendLine(lines, status?.status ? `Durable status: ${status.status}` : null);
    appendLine(lines, clampText(status?.summary, MAX_SUMMARY_CHARS) ? `Checkpoint summary: ${clampText(status?.summary, MAX_SUMMARY_CHARS)}` : null);
    appendLine(lines, status?.workerSession?.attempt ? `Worker attempt: ${status.workerSession.attempt}` : null);
    appendLine(lines, status?.workerSession?.mode ? `Execution mode: ${status.workerSession.mode}` : null);
  }

  lines.push('Use durable files, not the vanished chat window:');
  lines.push(`- @${input.workerPromptPath}`);
  if (checkpoint) {
    lines.push(`- @${taskBasePath}/checkpoint.json`);
  }
  lines.push(`- @${taskBasePath}/status.json`);
  lines.push(`- @${taskBasePath}/spec.md`);
  if (reportSnippet || readText(reportPath)) {
    lines.push(`- @${taskBasePath}/report.md`);
  }

  appendLine(lines, specSnippet ? `Spec hint: ${specSnippet}` : null);
  appendLine(lines, reportSnippet ? `Prior report hint: ${reportSnippet}` : null);
  lines.push('Resume from these durable artifacts only. Do not reconstruct transcript history or whole prior prompts.');

  return clampText(lines.join('\n'), MAX_REHYDRATION_CHARS);
}
