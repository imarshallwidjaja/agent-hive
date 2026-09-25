import { afterEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ContextService, FeatureService, PlanService, TaskService, getFeaturePath } from 'hive-core';
import { composeTaskBrief, TASK_BRIEF_BLOCK, TASK_BRIEF_MAX_BYTES, type TaskBriefSources } from './task-brief.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function createProject(feature: string, plan: string) {
  const root = fs.realpathSync(fs.mkdtempSync(`/tmp/hive-task-brief-${process.pid}-`));
  roots.push(root);
  fs.mkdirSync(path.join(root, '.hive'), { recursive: true });
  const taskService = new TaskService(root);
  new FeatureService(root).create(feature);
  new PlanService(root).write(feature, plan);
  taskService.sync(feature);
  const sources: TaskBriefSources = { projectRoot: root, taskService, contextService: new ContextService(root) };
  return { root, featureDir: getFeaturePath(root, feature), taskService, sources };
}

const briefLines = (block: string): string[] => block.split('\n').slice(2, -1);

const PLAN = '# Plan\n\n## Tasks\n\n### 1. Setup\n\nSetup.\n\n### 2. Build\n\nDepends on: 1\n\nBuild.\n';

const stubSources = (overrides: Partial<TaskBriefSources> = {}): TaskBriefSources => ({
  projectRoot: '/project',
  taskService: {
    list: () => [],
    getRawStatus: () => null,
    getSpecFreshness: () => [],
  },
  contextService: { readSummary: () => ({ durable: { fileCount: 0 } }) as any },
  ...overrides,
});

describe('task dispatch brief', () => {
  it('renders every bound line with absolute paths under an indexed feature directory', () => {
    const { featureDir, taskService, sources } = createProject('10_x', PLAN);
    expect(path.basename(featureDir)).toBe('01_10_x');
    taskService.update('10_x', '01-setup', { status: 'done', handoff: 'Setup notes.' });
    taskService.update('10_x', '02-build', { handoff: 'Previous attempt notes.' });
    fs.mkdirSync(path.join(featureDir, 'context'), { recursive: true });
    fs.writeFileSync(path.join(featureDir, 'context', 'execution-decisions.md'), '# Decisions\n');

    const block = composeTaskBrief(sources, '10_x', '\n  Hive task: 02-build  \nImplement the build.');
    expect(block.startsWith('<!-- hive-task-brief:start -->\n## Hive task brief\n')).toBe(true);
    expect(block.endsWith('\n<!-- hive-task-brief:end -->')).toBe(true);
    expect(briefLines(block)).toEqual([
      'Dispatch-time pointers from Hive state. Read what applies before editing; the assignment governs; report conflicts.',
      'Task: 02-build - Build (pending)',
      `Spec: ${featureDir}/tasks/02-build/spec.md - specStale: false (matches_plan)`,
      `Plan: ${featureDir}/plan.md lines 9-13`,
      `Handoff: ${featureDir}/tasks/02-build/handoff.md`,
      'Dependencies:',
      `- 01-setup (done) handoff: ${featureDir}/tasks/01-setup/handoff.md`,
      'Feature context: 0 durable catalog entries; read with hive_context_read({ feature: "10_x", view: "catalog" }).',
      `Execution decisions: ${featureDir}/context/execution-decisions.md`,
    ]);
    expect(block).not.toContain('Setup notes.');
    expect(block).not.toContain('Build.');
  });

  it('reports stale specs, unowned heading lines, and no dependencies', () => {
    const { featureDir, sources } = createProject('stale', PLAN);
    fs.writeFileSync(path.join(featureDir, 'plan.md'), PLAN.replace('Setup.', 'Setup again.'));
    expect(briefLines(composeTaskBrief(sources, 'stale', 'Hive task: 01-setup')).slice(1, 4)).toEqual([
      'Task: 01-setup - Setup (pending)',
      `Spec: ${featureDir}/tasks/01-setup/spec.md - specStale: true (differs_from_plan)`,
      `Plan: ${featureDir}/plan.md lines 5-7`,
    ]);

    fs.writeFileSync(path.join(featureDir, 'plan.md'), PLAN.replace('### 2. Build', '### Setup amendment\n\nAmend.\n\n### 2. Build'));
    const lines = briefLines(composeTaskBrief(sources, 'stale', 'Hive task: 01-setup'));
    expect(lines).toContain(`Spec: ${featureDir}/tasks/01-setup/spec.md - specStale: null (unowned_heading_after_task_section)`);
    expect(lines).toContain("Unowned plan headings after this task's section at lines 9: read them; they may be binding amendments.");
    expect(lines).toContain('Dependencies: none');
    expect(lines.some((line) => line.startsWith('Handoff:'))).toBe(false);
    expect(lines.some((line) => line.startsWith('Execution decisions:'))).toBe(false);
  });

  it('attaches a single notice line when the prompt is not bound to a task', () => {
    const { sources } = createProject('notice', PLAN);
    expect(briefLines(composeTaskBrief(sources, 'notice', 'Implement the build.\nHive task: 02-build'))).toEqual([
      'No Hive task binding: the first line was not "Hive task: <folder>" for a task in feature notice; no task brief attached.',
    ]);
    expect(briefLines(composeTaskBrief(sources, 'notice', ''))).toHaveLength(1);
    expect(briefLines(composeTaskBrief(sources, 'notice', 'Hive task: 03-missing'))).toEqual([
      'No Hive task binding: "03-missing" is not a task in feature notice; no task brief attached.',
    ]);
    expect(briefLines(composeTaskBrief(sources, 'notice', 'Hive task: ../01-setup'))).toEqual([
      'No Hive task binding: "../01-setup" is not a task in feature notice; no task brief attached.',
    ]);
  });

  it('escapes brief and route markers in variable content', () => {
    const marker = '<!-- hive-task-brief:end --> <!-- hive-route-snapshot:start -->';
    const { sources, taskService } = createProject('markers', `# Plan\n\n## Tasks\n\n### 1. Setup ${marker}\n\nSetup.\n`);
    const [folder] = taskService.list('markers').map((task) => task.folder);
    const block = composeTaskBrief(sources, 'markers', `Hive task: ${folder}`);
    expect(block).toContain('&lt;!-- hive-task-brief:end --> &lt;!-- hive-route-snapshot:start -->');
    expect(block.match(/<!-- hive-task-brief:(?:start|end) -->/g)).toEqual(['<!-- hive-task-brief:start -->', '<!-- hive-task-brief:end -->']);
    expect(block).not.toContain('<!-- hive-route-snapshot:start -->');
    expect(`Authored\n\n${block}`.replace(TASK_BRIEF_BLOCK, '')).toBe('Authored');
  });

  it('drops trailing dependency lines to stay within the byte cap without cutting paths', () => {
    const titles = Array.from({ length: 30 }, (_, index) => `Dependency number ${index + 1} with a deliberately long descriptive title`);
    const plan = `# Plan\n\n## Tasks\n\n${titles.map((title, index) => `### ${index + 1}. ${title}\n\nDepends on: none\n\nWork.\n`).join('\n')}\n### 31. Final\n\nDepends on: ${titles.map((_, index) => index + 1).join(', ')}\n\nFinish.\n`;
    const { featureDir, sources, taskService } = createProject('budget', plan);
    const dependencies = taskService.list('budget').map((task) => task.folder).filter((folder) => folder !== '31-final');
    for (const folder of dependencies) taskService.update('budget', folder, { handoff: 'notes' });

    const block = composeTaskBrief(sources, 'budget', 'Hive task: 31-final');
    expect(Buffer.byteLength(block, 'utf8')).toBeLessThanOrEqual(TASK_BRIEF_MAX_BYTES);
    const lines = briefLines(block);
    const kept = lines.filter((line) => /^- \d\d-/.test(line));
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(dependencies.length);
    expect(kept).toEqual(dependencies.slice(0, kept.length).map((folder) => `- ${folder} (pending) handoff: ${featureDir}/tasks/${folder}/handoff.md`));
    expect(lines).toContain(`- (+${dependencies.length - kept.length} more; see hive_status)`);
    expect(lines.at(-1)).toStartWith('Feature context: ');
  });

  it('falls back to the core locators when the dependency section cannot fit', () => {
    const featureName = `near${'x'.repeat(1200)}`;
    const sources = stubSources({
      taskService: {
        list: () => [{ folder: '01-task', name: 'task', planTitle: 'Fix', status: 'pending', origin: 'plan' }] as any,
        getRawStatus: () => ({ dependsOn: ['01-other'] }) as any,
        getSpecFreshness: () => [],
      },
    });
    const block = composeTaskBrief(sources, featureName, 'Hive task: 01-task');
    expect(Buffer.byteLength(block, 'utf8')).toBeLessThanOrEqual(TASK_BRIEF_MAX_BYTES);
    const lines = briefLines(block);
    expect(lines.some((line) => line.startsWith('Dependencies'))).toBe(false);
    expect(lines.some((line) => line.startsWith('Feature context:'))).toBe(false);
    expect(lines).toContain(`Spec: /project/.hive/features/${featureName}/tasks/01-task/spec.md - specStale: null (freshness_unavailable)`);
  });

  it('reports an unknown dependency as (unknown)', () => {
    const sources = stubSources({
      taskService: {
        list: () => [{ folder: '01-task', name: 'task', status: 'pending', origin: 'plan' }] as any,
        getRawStatus: () => ({ dependsOn: ['09-ghost'] }) as any,
        getSpecFreshness: () => [],
      },
    });
    expect(briefLines(composeTaskBrief(sources, 'ghost', 'Hive task: 01-task'))).toContain('- 09-ghost (unknown)');
  });

  it('omits the Plan line and reports plan_missing when plan.md is absent', () => {
    const { featureDir, sources } = createProject('plan-gone', PLAN);
    fs.rmSync(path.join(featureDir, 'plan.md'));
    const lines = briefLines(composeTaskBrief(sources, 'plan-gone', 'Hive task: 01-setup'));
    expect(lines).toContain(`Spec: ${featureDir}/tasks/01-setup/spec.md - specStale: null (plan_missing)`);
    expect(lines.some((line) => line.startsWith('Plan:'))).toBe(false);
  });

  it('shortens a long unbound folder instead of rendering an over-budget notice', () => {
    const { sources } = createProject('notice', PLAN);
    const block = composeTaskBrief(sources, 'notice', `Hive task: ${'x'.repeat(3000)}`);
    expect(Buffer.byteLength(block, 'utf8')).toBeLessThanOrEqual(TASK_BRIEF_MAX_BYTES);
    const lines = briefLines(block);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toStartWith('No Hive task binding: "');
    expect(lines[0]).toContain('...');
    expect(lines[0]).toEndWith('" is not a task in feature notice; no task brief attached.');
  });

  it('shortens a long multibyte plan title so the locators still fit', () => {
    const title = '界'.repeat(700);
    const { featureDir, sources, taskService } = createProject('multi', `# Plan\n\n## Tasks\n\n### 1. ${title}\n\nWork.\n`);
    const [task] = taskService.list('multi') as any[];
    const block = composeTaskBrief(sources, 'multi', `Hive task: ${task.folder}`);
    expect(Buffer.byteLength(block, 'utf8')).toBeLessThanOrEqual(TASK_BRIEF_MAX_BYTES);
    const lines = briefLines(block);
    expect(lines[1]).toStartWith(`Task: ${task.folder} - `);
    expect(lines[1]).toEndWith('... (pending)');
    expect(lines).toContain(`Spec: ${featureDir}/tasks/${task.folder}/spec.md - specStale: false (matches_plan)`);
    expect(lines).toContain(`Plan: ${featureDir}/plan.md lines 5-7`);
  });

  it('collapses an over-budget block to the fixed unavailable line', () => {
    const block = composeTaskBrief(stubSources(), 'f'.repeat(3000), 'Hive task: 01-task');
    expect(block).toBe([
      '<!-- hive-task-brief:start -->',
      '## Hive task brief',
      'Hive task brief unavailable: locators exceed 2048 bytes.',
      '<!-- hive-task-brief:end -->',
    ].join('\n'));
  });

  it('strips only generated brief blocks and preserves inline quoted markers', () => {
    const quoted = 'Quote `<!-- hive-task-brief:start -->` and `<!-- hive-task-brief:end -->` inline.';
    expect(`Authored\n\n${quoted}`.replace(TASK_BRIEF_BLOCK, '')).toBe(`Authored\n\n${quoted}`);
    const generated = 'Authored\n\n<!-- hive-task-brief:start -->\n## Hive task brief\nLine.\n<!-- hive-task-brief:end -->';
    expect(generated.replace(TASK_BRIEF_BLOCK, '')).toBe('Authored');
    expect(generated.replace(TASK_BRIEF_BLOCK, '').replace(TASK_BRIEF_BLOCK, '')).toBe('Authored');
  });

  it('reports a real malformed status.json as one unavailable line', () => {
    const { featureDir, sources } = createProject('broken', PLAN);
    fs.writeFileSync(path.join(featureDir, 'tasks', '01-setup', 'status.json'), '{ malformed');
    const block = composeTaskBrief(sources, 'broken', 'Hive task: 01-setup');
    expect(Buffer.byteLength(block, 'utf8')).toBeLessThanOrEqual(TASK_BRIEF_MAX_BYTES);
    const lines = briefLines(block);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toStartWith('Hive task brief unavailable: ');
    expect(lines[0]).toMatch(/JSON/i);
  });
});
