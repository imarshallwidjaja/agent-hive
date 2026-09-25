import type { PlanUnownedTaskHeading } from '../types.js';

export interface FenceState {
  marker: '`' | '~';
  length: number;
}

export function getFenceTransition(line: string, fence: FenceState | null, nestedFences: FenceState[]): { opened?: FenceState; closedOuter: boolean } | null {
  const closingFenceMatch = fence
    ? line.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/)
    : null;
  if (closingFenceMatch) {
    const marker = closingFenceMatch[1][0] as '`' | '~';
    const length = closingFenceMatch[1].length;
    const nestedFence = nestedFences.at(-1);
    if (nestedFence && nestedFence.marker === marker && length === nestedFence.length) {
      nestedFences.pop();
      return { closedOuter: false };
    }
    if (fence.marker === marker && length >= fence.length) {
      nestedFences.length = 0;
      return { closedOuter: true };
    }
  }

  const openingFenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})/);
  if (!openingFenceMatch) return null;

  const marker = openingFenceMatch[1][0] as '`' | '~';
  const length = openingFenceMatch[1].length;
  const opened = { marker, length };
  if (fence) {
    nestedFences.push(opened);
  }

  return { opened, closedOuter: false };
}

/** A level-3 heading inside `## Tasks`, outside code fences. */
export interface PlanTaskSectionHeading {
  /** 1-based line number in plan.md. */
  line: number;
  /** Heading text after `###`. */
  title: string;
  /** Number of a `### N. Title` task heading; null for an unowned task-section heading. */
  taskNumber: number | null;
}

/** A numbered task heading and the plan.md lines its extracted spec section covers. */
export interface PlanTaskSection {
  taskNumber: number;
  /** 1-based line of the task heading. */
  startLine: number;
  /** 1-based inclusive last non-blank line before the next level-3 heading or the end of `## Tasks`. */
  endLine: number;
}

export interface PlanTaskLayout {
  /** 1-based inclusive body lines after the `## Tasks` heading; endLine < startLine when the body is empty. */
  tasksSection: { startLine: number; endLine: number } | null;
  headings: PlanTaskSectionHeading[];
  /** One entry per numbered heading, in document order. Duplicate numbers are kept. */
  tasks: PlanTaskSection[];
}

const TASKS_HEADING = /^ {0,3}##\s+tasks(?:\s+#+)?\s*$/i;
const TASKS_SECTION_BOUNDARY = /^ {0,3}#{1,2}\s+/;
const TASK_SECTION_HEADING = /^ {0,3}###\s+(.+)$/;
const NUMBERED_TASK_TITLE = /^(\d+)\.\s+(.+)$/;

/**
 * Locate the canonical `## Tasks` section and its level-3 headings, ignoring fenced code.
 * Throws when the plan contains more than one Tasks section.
 */
export function readPlanTaskLayout(content: string): PlanTaskLayout {
  const lines = content.split('\n');
  let fence: FenceState | null = null;
  const nestedFences: FenceState[] = [];
  let headingIndex = -1;
  let endIndex = lines.length;
  let sectionClosed = false;
  const headings: PlanTaskSectionHeading[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trimEnd();
    const transition = getFenceTransition(line, fence, nestedFences);
    if (transition) {
      if (!fence && transition.opened) {
        fence = transition.opened;
      } else if (transition.closedOuter) {
        fence = null;
      }
      continue;
    }
    if (fence) continue;

    if (TASKS_HEADING.test(line)) {
      if (headingIndex !== -1) {
        throw new Error('Plan contains multiple Tasks sections');
      }
      headingIndex = i;
      continue;
    }

    if (headingIndex === -1 || sectionClosed) continue;

    if (TASKS_SECTION_BOUNDARY.test(lines[i])) {
      endIndex = i;
      sectionClosed = true;
      continue;
    }

    const headingMatch = line.match(TASK_SECTION_HEADING);
    if (!headingMatch) continue;
    const title = headingMatch[1];
    const numbered = title.match(NUMBERED_TASK_TITLE);
    headings.push({ line: i + 1, title, taskNumber: numbered ? parseInt(numbered[1], 10) : null });
  }

  if (headingIndex === -1) {
    return { tasksSection: null, headings: [], tasks: [] };
  }

  const tasks: PlanTaskSection[] = [];
  headings.forEach((heading, index) => {
    if (heading.taskNumber === null) return;
    const nextHeadingLine = headings[index + 1]?.line ?? endIndex + 1;
    let endLine = nextHeadingLine - 1;
    while (endLine > heading.line && lines[endLine - 1].trim().length === 0) endLine -= 1;
    tasks.push({
      taskNumber: heading.taskNumber,
      startLine: heading.line,
      endLine,
    });
  });

  return {
    tasksSection: { startLine: headingIndex + 2, endLine: endIndex },
    headings,
    tasks,
  };
}

/** Body text of the canonical `## Tasks` section, or null when the plan has none. */
export function extractTasksSectionContent(content: string): string | null {
  const { tasksSection } = readPlanTaskLayout(content);
  if (!tasksSection) return null;
  return content.split('\n').slice(tasksSection.startLine - 1, tasksSection.endLine).join('\n');
}

export function listUnownedTaskHeadings(layout: PlanTaskLayout): PlanUnownedTaskHeading[] {
  return layout.headings
    .filter(heading => heading.taskNumber === null)
    .map(({ line, title }) => ({ line, title }));
}

/** Unowned headings between a task's section and the next numbered task heading or the end of `## Tasks`. */
export function listUnownedHeadingsAfterTask(layout: PlanTaskLayout, task: PlanTaskSection): PlanUnownedTaskHeading[] {
  const following: PlanUnownedTaskHeading[] = [];
  for (const heading of layout.headings) {
    if (heading.line <= task.startLine) continue;
    if (heading.taskNumber !== null) break;
    following.push({ line: heading.line, title: heading.title });
  }
  return following;
}
