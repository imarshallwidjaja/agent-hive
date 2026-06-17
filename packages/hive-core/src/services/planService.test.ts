import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { PlanService } from './planService';

const TEST_DIR = `/tmp/hive-core-planservice-test-${process.pid}`;

function cleanup(): void {
  if (fs.existsSync(TEST_DIR)) {
    fs.rmSync(TEST_DIR, { recursive: true });
  }
}

function setupFeature(featureName: string): string {
  const featurePath = path.join(TEST_DIR, '.hive', 'features', featureName);
  fs.mkdirSync(featurePath, { recursive: true });
  fs.writeFileSync(
    path.join(featurePath, 'feature.json'),
    JSON.stringify({ name: featureName, status: 'planning', createdAt: new Date().toISOString() })
  );
  fs.writeFileSync(path.join(featurePath, 'plan.md'), '# Plan\n');
  return featurePath;
}

function writePatchablePlan(service: PlanService, featureName: string): void {
  service.write(featureName, `# Plan

## Discovery

Original request and research notes are intentionally long enough to pass the planning discovery gate when this plan is patched through the tool layer.

## Design Summary

Keep the initial design.

## Tasks

### 1. First Task

Do the first task.

### 2. Second Task

Do the second task.

## Final Verification

Run tests.
`);
}

describe('PlanService', () => {
  let service: PlanService;

  beforeEach(() => {
    cleanup();
    fs.mkdirSync(TEST_DIR, { recursive: true });
    service = new PlanService(TEST_DIR);
  });

  afterEach(() => {
    cleanup();
  });

  it('blocks approval when unresolved canonical plan comments remain', () => {
    const featureName = 'canonical-plan-comments';
    const featurePath = setupFeature(featureName);

    fs.mkdirSync(path.join(featurePath, 'comments'), { recursive: true });
    fs.writeFileSync(
      path.join(featurePath, 'comments', 'plan.json'),
      JSON.stringify({
        threads: [
          {
            id: 'plan-thread',
            line: 1,
            body: 'Plan still needs edits',
            replies: [],
          },
        ],
      })
    );

    expect(() => service.approve(featureName)).toThrow(/unresolved review comments/i);
    expect(service.isApproved(featureName)).toBe(false);
  });

  it('approves when only legacy overview comments remain unresolved', () => {
    const featureName = 'test-feature';
    const featurePath = setupFeature(featureName);

    fs.mkdirSync(path.join(featurePath, 'comments'), { recursive: true });
    fs.writeFileSync(path.join(featurePath, 'comments', 'plan.json'), JSON.stringify({ threads: [] }));
    fs.writeFileSync(
      path.join(featurePath, 'comments', 'overview.json'),
      JSON.stringify({
        threads: [
          {
            id: 'overview-thread',
            line: 1,
            body: 'Overview still needs edits',
            replies: [],
          },
        ],
      })
    );

    expect(() => service.approve(featureName)).not.toThrow();
    expect(service.isApproved(featureName)).toBe(true);
  });

  it('read returns a deterministic revision and content hash', () => {
    const featureName = 'read-revision';
    setupFeature(featureName);
    writePatchablePlan(service, featureName);

    const firstRead = service.read(featureName);
    const secondRead = service.read(featureName);

    expect(firstRead?.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(firstRead?.revision).toMatch(/^[a-f0-9]{64}$/);
    expect(secondRead?.revision).toBe(firstRead?.revision);

    service.addComment(featureName, { line: 7, body: 'Needs update', replies: [] });
    expect(service.read(featureName)?.contentHash).toBe(firstRead?.contentHash);
    expect(service.read(featureName)?.revision).not.toBe(firstRead?.revision);
  });

  it('read outline returns headings and task list without full content', () => {
    const featureName = 'read-outline';
    setupFeature(featureName);
    writePatchablePlan(service, featureName);

    const outline = service.read(featureName, { mode: 'outline' });

    expect('content' in outline!).toBe(false);
    expect(outline?.revision).toMatch(/^[a-f0-9]{64}$/);
    expect(outline?.headings.map(heading => heading.title)).toContain('Design Summary');
    expect(outline?.taskList).toEqual([
      { taskNumber: 1, title: 'First Task' },
      { taskNumber: 2, title: 'Second Task' },
    ]);
  });

  it('read outline rejects duplicate canonical Tasks sections', () => {
    const featureName = 'outline-duplicate-tasks';
    setupFeature(featureName);
    service.write(featureName, `# Plan

## Discovery

Original request and research notes are intentionally long enough to pass the planning discovery gate when this plan is patched through the tool layer.

## Design Summary

Keep the initial design.

## Tasks

### 1. First Task

Do the first task.

## tasks

### 2. Second Task

Do the second task.
`);

    expect(() => service.read(featureName, { mode: 'outline' })).toThrow(/multiple Tasks sections/i);
  });

  it('stale patch revision rejects without changing content, comments, or approval', () => {
    const featureName = 'stale-patch';
    const featurePath = setupFeature(featureName);
    writePatchablePlan(service, featureName);
    service.approve(featureName);
    service.addComment(featureName, { line: 5, body: 'Needs update', replies: [] });

    const before = fs.readFileSync(path.join(featurePath, 'plan.md'), 'utf-8');

    expect(() => service.patch(featureName, 'stale-revision', [
      {
        type: 'replace_section',
        headingPath: ['Design Summary'],
        content: '## Design Summary\n\nChanged design.\n',
      },
    ])).toThrow(/stale/i);

    expect(fs.readFileSync(path.join(featurePath, 'plan.md'), 'utf-8')).toBe(before);
    expect(service.getComments(featureName)).toHaveLength(1);
    expect(service.isApproved(featureName)).toBe(true);
  });

  it('comment changes after read reject patch without clearing unseen comments', () => {
    const featureName = 'comment-revision';
    const featurePath = setupFeature(featureName);
    writePatchablePlan(service, featureName);
    const revision = service.read(featureName)!.revision;
    const before = fs.readFileSync(path.join(featurePath, 'plan.md'), 'utf-8');

    service.addComment(featureName, { line: 7, body: 'New review comment', replies: [] });

    expect(() => service.patch(featureName, revision, [
      {
        type: 'replace_section',
        headingPath: ['Design Summary'],
        content: '## Design Summary\n\nUse the revised design.\n',
      },
    ])).toThrow(/stale/i);

    expect(fs.readFileSync(path.join(featurePath, 'plan.md'), 'utf-8')).toBe(before);
    expect(service.getComments(featureName)).toHaveLength(1);
    expect(service.isApproved(featureName)).toBe(false);
  });

  it('approval changes after read reject patch without revoking unseen approval', () => {
    const featureName = 'approval-revision';
    const featurePath = setupFeature(featureName);
    writePatchablePlan(service, featureName);
    const revision = service.read(featureName)!.revision;
    const before = fs.readFileSync(path.join(featurePath, 'plan.md'), 'utf-8');

    service.approve(featureName);

    expect(() => service.patch(featureName, revision, [
      {
        type: 'replace_section',
        headingPath: ['Design Summary'],
        content: '## Design Summary\n\nUse the revised design.\n',
      },
    ])).toThrow(/stale/i);

    expect(fs.readFileSync(path.join(featurePath, 'plan.md'), 'utf-8')).toBe(before);
    expect(service.getComments(featureName)).toEqual([]);
    expect(service.isApproved(featureName)).toBe(true);
  });

  it('concurrent patches with the same revision cannot both succeed after state changes', async () => {
    const featureName = 'concurrent-revision';
    setupFeature(featureName);
    writePatchablePlan(service, featureName);
    service.approve(featureName);
    service.addComment(featureName, { line: 7, body: 'Clear this', replies: [] });
    const revision = service.read(featureName)!.revision;
    const operation = {
      type: 'replace_section' as const,
      headingPath: ['Design Summary'],
      content: '## Design Summary\n\nKeep the initial design.\n',
    };

    const results = await Promise.allSettled([
      Promise.resolve().then(() => service.patch(featureName, revision, [operation])),
      Promise.resolve().then(() => service.patch(featureName, revision, [operation])),
    ]);

    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    const rejection = results.find(result => result.status === 'rejected');
    expect(rejection?.reason).toBeInstanceOf(Error);
    expect((rejection as PromiseRejectedResult).reason.message).toMatch(/stale/i);
    expect(service.getComments(featureName)).toEqual([]);
    expect(service.isApproved(featureName)).toBe(false);
  });

  it('plan patch rejects while the feature patch lock is held without mutating plan state', () => {
    const featureName = 'patch-lock-held';
    const featurePath = setupFeature(featureName);
    writePatchablePlan(service, featureName);
    service.approve(featureName);
    service.addComment(featureName, { line: 7, body: 'Do not clear this', replies: [] });
    const revision = service.read(featureName)!.revision;
    const before = fs.readFileSync(path.join(featurePath, 'plan.md'), 'utf-8');
    const lockPath = path.join(featurePath, '.plan-patch.lock');
    fs.mkdirSync(lockPath);

    try {
      expect(() => service.patch(featureName, revision, [
        {
          type: 'replace_section',
          headingPath: ['Design Summary'],
          content: '## Design Summary\n\nUse the revised design.\n',
        },
      ])).toThrow(/lock/i);
    } finally {
      fs.rmSync(lockPath, { recursive: true, force: true });
    }

    expect(fs.readFileSync(path.join(featurePath, 'plan.md'), 'utf-8')).toBe(before);
    expect(service.getComments(featureName)).toHaveLength(1);
    expect(service.isApproved(featureName)).toBe(true);
  });

  it('missing or ambiguous section patch rejects without changing content', () => {
    const featureName = 'section-errors';
    const featurePath = setupFeature(featureName);
    service.write(featureName, `# Plan

## Discovery

Original request and research notes are intentionally long enough to pass the planning discovery gate when this plan is patched through the tool layer.

## Design Summary

First copy.

## Design Summary

Second copy.
`);
    const revision = service.read(featureName)!.revision;
    const before = fs.readFileSync(path.join(featurePath, 'plan.md'), 'utf-8');

    expect(() => service.patch(featureName, revision, [
      {
        type: 'replace_section',
        headingPath: ['Missing Section'],
        content: '## Missing Section\n\nNew text.\n',
      },
    ])).toThrow(/not found/i);

    expect(() => service.patch(featureName, revision, [
      {
        type: 'replace_section',
        headingPath: ['Design Summary'],
        content: '## Design Summary\n\nNew text.\n',
      },
    ])).toThrow(/ambiguous/i);

    expect(fs.readFileSync(path.join(featurePath, 'plan.md'), 'utf-8')).toBe(before);
  });

  it('replace_section clears comments and revokes approval', () => {
    const featureName = 'replace-section';
    setupFeature(featureName);
    writePatchablePlan(service, featureName);
    service.approve(featureName);
    service.addComment(featureName, { line: 7, body: 'Tighten this', replies: [] });
    const revision = service.read(featureName)!.revision;

    const result = service.patch(featureName, revision, [
      {
        type: 'replace_section',
        headingPath: ['Design Summary'],
        content: '## Design Summary\n\nUse the revised design.\n',
      },
    ]);

    const read = service.read(featureName)!;
    expect(read.content).toContain('Use the revised design.');
    expect(read.content).not.toContain('Keep the initial design.');
    expect(result.changedSections).toEqual(['Design Summary']);
    expect(result.revision).toBe(read.revision);
    expect(service.getComments(featureName)).toEqual([]);
    expect(service.isApproved(featureName)).toBe(false);
  });

  it('replace_section preserves markdown boundary before the next heading when replacement lacks trailing newline', () => {
    const featureName = 'replace-section-no-trailing-newline';
    setupFeature(featureName);
    writePatchablePlan(service, featureName);
    const revision = service.read(featureName)!.revision;

    service.patch(featureName, revision, [
      {
        type: 'replace_section',
        headingPath: ['Design Summary'],
        content: '## Design Summary\n\nUse the revised design.',
      },
    ]);

    expect(service.read(featureName)!.content).toContain('Use the revised design.\n\n## Tasks');
  });

  it('replace_task updates only the requested task', () => {
    const featureName = 'replace-task';
    setupFeature(featureName);
    writePatchablePlan(service, featureName);
    const revision = service.read(featureName)!.revision;

    service.patch(featureName, revision, [
      {
        type: 'replace_task',
        taskNumber: 2,
        content: '### 2. Revised Task\n\nDo the revised task.\n',
      },
    ]);

    const content = service.read(featureName)!.content;
    expect(content).toContain('### 1. First Task\n\nDo the first task.');
    expect(content).toContain('### 2. Revised Task\n\nDo the revised task.');
    expect(content).not.toContain('Do the second task.');
    expect(content).toContain('## Final Verification\n\nRun tests.');
  });

  it('replace_task can target tasks under a lowercase Tasks section heading', () => {
    const featureName = 'replace-task-lowercase-tasks';
    setupFeature(featureName);
    service.write(featureName, `# Plan

## Discovery

Original request and research notes are intentionally long enough to pass the planning discovery gate when this plan is patched through the tool layer.

## Design Summary

Keep the initial design.

## tasks

### 1. First Task

Do the first task.
`);
    const revision = service.read(featureName)!.revision;

    service.patch(featureName, revision, [
      {
        type: 'replace_task',
        taskNumber: 1,
        content: '### 1. Revised Task\n\nDo the revised task.\n',
      },
    ]);

    expect(service.read(featureName)!.content).toContain('### 1. Revised Task\n\nDo the revised task.');
  });

  it('replace_task preserves markdown boundary before the next heading when replacement lacks trailing newline', () => {
    const featureName = 'replace-task-no-trailing-newline';
    setupFeature(featureName);
    writePatchablePlan(service, featureName);
    const revision = service.read(featureName)!.revision;

    service.patch(featureName, revision, [
      {
        type: 'replace_task',
        taskNumber: 2,
        content: '### 2. Revised Task\n\nDo the revised task.',
      },
    ]);

    expect(service.read(featureName)!.content).toContain('Do the revised task.\n\n## Final Verification');
  });

  it('replace_task stops before the next task-level heading even when it is not numbered', () => {
    const featureName = 'replace-task-before-unnumbered-heading';
    setupFeature(featureName);
    service.write(featureName, `# Plan

## Discovery

Original request and research notes are intentionally long enough to pass the planning discovery gate when this plan is patched through the tool layer.

## Design Summary

Keep the initial design.

## Tasks

### 1. First Task

Do the first task.

### Shared Notes

Notes that belong after task one.

### 2. Second Task

Do the second task.
`);
    const revision = service.read(featureName)!.revision;

    service.patch(featureName, revision, [
      {
        type: 'replace_task',
        taskNumber: 1,
        content: '### 1. Revised Task\n\nDo the revised task.\n',
      },
    ]);

    const content = service.read(featureName)!.content;
    expect(content).toContain('### 1. Revised Task\n\nDo the revised task.');
    expect(content).toContain('### Shared Notes\n\nNotes that belong after task one.');
    expect(content).toContain('### 2. Second Task\n\nDo the second task.');
    expect(content).not.toContain('Do the first task.');
  });

  it('replace_section rejects replacement content with prose before the expected heading', () => {
    const featureName = 'replace-section-leading-prose';
    const featurePath = setupFeature(featureName);
    writePatchablePlan(service, featureName);
    const revision = service.read(featureName)!.revision;
    const before = fs.readFileSync(path.join(featurePath, 'plan.md'), 'utf-8');

    expect(() => service.patch(featureName, revision, [
      {
        type: 'replace_section',
        headingPath: ['Design Summary'],
        content: 'This must not be accepted.\n\n## Design Summary\n\nUse the revised design.\n',
      },
    ])).toThrow(/must start with heading/i);

    expect(fs.readFileSync(path.join(featurePath, 'plan.md'), 'utf-8')).toBe(before);
  });

  it('replace_section rejects replacement content with the wrong heading level', () => {
    const featureName = 'replace-section-wrong-level';
    const featurePath = setupFeature(featureName);
    writePatchablePlan(service, featureName);
    const revision = service.read(featureName)!.revision;
    const before = fs.readFileSync(path.join(featurePath, 'plan.md'), 'utf-8');

    expect(() => service.patch(featureName, revision, [
      {
        type: 'replace_section',
        headingPath: ['Design Summary'],
        content: '### Design Summary\n\nUse the revised design.\n',
      },
    ])).toThrow(/must start with heading/i);

    expect(fs.readFileSync(path.join(featurePath, 'plan.md'), 'utf-8')).toBe(before);
  });

  it('replace_section rejects replacement content that introduces a sibling or parent heading', () => {
    const featureName = 'replace-section-heading-injection';
    const featurePath = setupFeature(featureName);
    writePatchablePlan(service, featureName);
    const revision = service.read(featureName)!.revision;
    const before = fs.readFileSync(path.join(featurePath, 'plan.md'), 'utf-8');

    expect(() => service.patch(featureName, revision, [
      {
        type: 'replace_section',
        headingPath: ['Design Summary'],
        content: '## Design Summary\n\nUse the revised design.\n\n## Tasks\n\nInjected sibling.\n',
      },
    ])).toThrow(/additional heading/i);

    expect(fs.readFileSync(path.join(featurePath, 'plan.md'), 'utf-8')).toBe(before);
  });

  it('replace_section rejects replacement content that creates duplicate task numbers', () => {
    const featureName = 'replace-section-duplicate-tasks';
    const featurePath = setupFeature(featureName);
    writePatchablePlan(service, featureName);
    const revision = service.read(featureName)!.revision;
    const before = fs.readFileSync(path.join(featurePath, 'plan.md'), 'utf-8');

    expect(() => service.patch(featureName, revision, [
      {
        type: 'replace_section',
        headingPath: ['Tasks'],
        content: '## Tasks\n\n### 1. First Task\n\nDo the first task.\n\n### 1. Duplicate First Task\n\nDo duplicate work.\n',
      },
    ])).toThrow(/duplicate task number/i);

    expect(fs.readFileSync(path.join(featurePath, 'plan.md'), 'utf-8')).toBe(before);
  });

  it('replace_section rejects replacement content that creates duplicate nested section paths', () => {
    const featureName = 'replace-section-duplicate-nested-paths';
    const featurePath = setupFeature(featureName);
    writePatchablePlan(service, featureName);
    const revision = service.read(featureName)!.revision;
    const before = fs.readFileSync(path.join(featurePath, 'plan.md'), 'utf-8');

    expect(() => service.patch(featureName, revision, [
      {
        type: 'replace_section',
        headingPath: ['Design Summary'],
        content: '## Design Summary\n\n### Duplicate\n\nA\n\n### Duplicate\n\nB\n',
      },
    ])).toThrow(/duplicate section path/i);

    expect(fs.readFileSync(path.join(featurePath, 'plan.md'), 'utf-8')).toBe(before);
  });

  it('replace_section rejects replacement content with an unclosed fenced block', () => {
    const featureName = 'replace-section-unclosed-fence';
    const featurePath = setupFeature(featureName);
    writePatchablePlan(service, featureName);
    const revision = service.read(featureName)!.revision;
    const before = fs.readFileSync(path.join(featurePath, 'plan.md'), 'utf-8');

    expect(() => service.patch(featureName, revision, [
      {
        type: 'replace_section',
        headingPath: ['Design Summary'],
        content: '## Design Summary\n\n```markdown\nUnclosed example.\n',
      },
    ])).toThrow(/unclosed fenced code block/i);

    expect(fs.readFileSync(path.join(featurePath, 'plan.md'), 'utf-8')).toBe(before);
  });

  it('replace_task rejects replacement content with prose before the target task heading', () => {
    const featureName = 'replace-task-leading-prose';
    const featurePath = setupFeature(featureName);
    writePatchablePlan(service, featureName);
    const revision = service.read(featureName)!.revision;
    const before = fs.readFileSync(path.join(featurePath, 'plan.md'), 'utf-8');

    expect(() => service.patch(featureName, revision, [
      {
        type: 'replace_task',
        taskNumber: 2,
        content: 'This must not be accepted.\n\n### 2. Revised Task\n\nDo the revised task.\n',
      },
    ])).toThrow(/must start with '### 2\. \.\.\.'/i);

    expect(fs.readFileSync(path.join(featurePath, 'plan.md'), 'utf-8')).toBe(before);
  });

  it('replace_task rejects duplicate target task numbers in the existing plan without changing content', () => {
    const featureName = 'replace-task-duplicate-target';
    const featurePath = setupFeature(featureName);
    service.write(featureName, `# Plan

## Discovery

Original request and research notes are intentionally long enough to pass the planning discovery gate when this plan is patched through the tool layer.

## Design Summary

Keep the initial design.

## Tasks

### 2. First Second Task

Do the first second task.

### 3. Third Task

Do the third task.

### 2. Duplicate Second Task

Do the duplicate second task.

## Final Verification

Run tests.
`);
    const revision = service.read(featureName)!.revision;
    const before = fs.readFileSync(path.join(featurePath, 'plan.md'), 'utf-8');

    expect(() => service.patch(featureName, revision, [
      {
        type: 'replace_task',
        taskNumber: 2,
        content: '### 2. Revised Task\n\nDo the revised task.\n',
      },
    ])).toThrow(/duplicate/i);

    expect(fs.readFileSync(path.join(featurePath, 'plan.md'), 'utf-8')).toBe(before);
  });

  it('replace_task rejects replacement content that introduces another task heading', () => {
    const featureName = 'replace-task-task-heading-injection';
    const featurePath = setupFeature(featureName);
    writePatchablePlan(service, featureName);
    const revision = service.read(featureName)!.revision;
    const before = fs.readFileSync(path.join(featurePath, 'plan.md'), 'utf-8');

    expect(() => service.patch(featureName, revision, [
      {
        type: 'replace_task',
        taskNumber: 2,
        content: '### 2. Revised Task\n\nDo the revised task.\n\n### 3. Injected Task\n\nDo injected work.\n',
      },
    ])).toThrow(/additional heading/i);

    expect(fs.readFileSync(path.join(featurePath, 'plan.md'), 'utf-8')).toBe(before);
  });

  it('replace_task rejects replacement content that introduces a parent heading', () => {
    const featureName = 'replace-task-parent-heading-injection';
    const featurePath = setupFeature(featureName);
    writePatchablePlan(service, featureName);
    const revision = service.read(featureName)!.revision;
    const before = fs.readFileSync(path.join(featurePath, 'plan.md'), 'utf-8');

    expect(() => service.patch(featureName, revision, [
      {
        type: 'replace_task',
        taskNumber: 2,
        content: '### 2. Revised Task\n\nDo the revised task.\n\n## Final Verification\n\nInjected verification.\n',
      },
    ])).toThrow(/additional heading/i);

    expect(fs.readFileSync(path.join(featurePath, 'plan.md'), 'utf-8')).toBe(before);
  });

  it('replace_task rejects replacement content with an unclosed fenced block', () => {
    const featureName = 'replace-task-unclosed-fence';
    const featurePath = setupFeature(featureName);
    writePatchablePlan(service, featureName);
    const revision = service.read(featureName)!.revision;
    const before = fs.readFileSync(path.join(featurePath, 'plan.md'), 'utf-8');

    expect(() => service.patch(featureName, revision, [
      {
        type: 'replace_task',
        taskNumber: 2,
        content: '### 2. Revised Task\n\n```markdown\nUnclosed example.\n',
      },
    ])).toThrow(/unclosed fenced code block/i);

    expect(fs.readFileSync(path.join(featurePath, 'plan.md'), 'utf-8')).toBe(before);
  });

  it('outline ignores headings and tasks inside fenced code blocks', () => {
    const featureName = 'fenced-outline';
    setupFeature(featureName);
    service.write(featureName, `# Plan

## Discovery

\`\`\`markdown
## Fake Heading
### 99. Fake Task
\`\`\`

~~~markdown
## Another Fake Heading
### 100. Another Fake Task
~~~

## Design Summary

Keep the initial design.

## Tasks

### 1. First Task

Do the first task.

### 2. Second Task

Do the second task.
`);

    const outline = service.read(featureName, { mode: 'outline' })!;

    expect(outline.headings.map(heading => heading.title)).toEqual([
      'Plan',
      'Discovery',
      'Design Summary',
      'Tasks',
      '1. First Task',
      '2. Second Task',
    ]);
    expect(outline.taskList).toEqual([
      { taskNumber: 1, title: 'First Task' },
      { taskNumber: 2, title: 'Second Task' },
    ]);
  });

  it('outline does not close an active fence on an inner fence line with an info string', () => {
    const featureName = 'fenced-inner-info-string';
    setupFeature(featureName);
    service.write(featureName, `# Plan

## Discovery

\`\`\`markdown
\`\`\`ts
## Fake Heading
### 99. Fake Task
\`\`\`
\`\`\`

## Design Summary

Keep the initial design.

## Tasks

### 1. First Task

Do the first task.
`);

    const outline = service.read(featureName, { mode: 'outline' })!;

    expect(outline.headings.map(heading => heading.title)).toEqual([
      'Plan',
      'Discovery',
      'Design Summary',
      'Tasks',
      '1. First Task',
    ]);
    expect(outline.taskList).toEqual([{ taskNumber: 1, title: 'First Task' }]);
  });

  it('outline clears inner fence state when the outer fence closes', () => {
    const featureName = 'fenced-mixed-marker-state';
    setupFeature(featureName);
    service.write(featureName, `# Plan

## Discovery

\`\`\`markdown
~~~ts
## Fake Heading
\`\`\`

## Design Summary

Keep the initial design.

~~~markdown
## Another Fake Heading
~~~

## Tasks

### 1. First Task

Do the first task.
`);

    const outline = service.read(featureName, { mode: 'outline' })!;

    expect(outline.headings.map(heading => heading.title)).toEqual([
      'Plan',
      'Discovery',
      'Design Summary',
      'Tasks',
      '1. First Task',
    ]);
  });

  it('outline closes a longer outer fence around a shorter inner fence example', () => {
    const featureName = 'fenced-longer-outer-fence';
    setupFeature(featureName);
    service.write(featureName, `# Plan

## Discovery

\`\`\`\`markdown
\`\`\`ts
## Fake Heading
\`\`\`\`

## Design Summary

Keep the initial design.

## Tasks

### 1. First Task

Do the first task.
`);

    const outline = service.read(featureName, { mode: 'outline' })!;

    expect(outline.headings.map(heading => heading.title)).toEqual([
      'Plan',
      'Discovery',
      'Design Summary',
      'Tasks',
      '1. First Task',
    ]);
  });

  it('outline closes an outer fence before considering longer inner-looking markers', () => {
    const featureName = 'fenced-outer-before-longer-marker';
    setupFeature(featureName);
    service.write(featureName, `# Plan

## Discovery

\`\`\`markdown
\`\`\`\`ts
## Fake Heading
\`\`\`

## Design Summary

Keep the initial design.

## Tasks

### 1. First Task

Do the first task.
`);

    const outline = service.read(featureName, { mode: 'outline' })!;

    expect(outline.headings.map(heading => heading.title)).toEqual([
      'Plan',
      'Discovery',
      'Design Summary',
      'Tasks',
      '1. First Task',
    ]);
  });

  it('replace_task ignores fake task headings inside fenced code blocks', () => {
    const featureName = 'fenced-task-target';
    setupFeature(featureName);
    service.write(featureName, `# Plan

## Discovery

Original request and research notes are intentionally long enough to pass the planning discovery gate when this plan is patched through the tool layer.

## Design Summary

Keep the initial design.

## Tasks

### 1. First Task

Do the first task.

\`\`\`markdown
### 2. Fake Second Task

This fenced heading must not be patched.
\`\`\`

### 2. Second Task

Do the second task.

## Final Verification

Run tests.
`);
    const revision = service.read(featureName)!.revision;

    service.patch(featureName, revision, [
      {
        type: 'replace_task',
        taskNumber: 2,
        content: '### 2. Revised Task\n\nDo the revised task.\n',
      },
    ]);

    const content = service.read(featureName)!.content;
    expect(content).toContain('### 2. Fake Second Task\n\nThis fenced heading must not be patched.');
    expect(content).toContain('### 2. Revised Task\n\nDo the revised task.');
    expect(content).not.toContain('### 2. Second Task\n\nDo the second task.');
  });

  it('insert_after_section preserves unrelated sections', () => {
    const featureName = 'insert-after-section';
    setupFeature(featureName);
    writePatchablePlan(service, featureName);
    const revision = service.read(featureName)!.revision;

    service.patch(featureName, revision, [
      {
        type: 'insert_after_section',
        headingPath: ['Design Summary'],
        content: '\n## Review Notes\n\nBounded amendment.\n',
      },
    ]);

    const content = service.read(featureName)!.content;
    expect(content).toMatch(/## Design Summary[\s\S]*Keep the initial design\.[\s\S]*## Review Notes[\s\S]*Bounded amendment\.[\s\S]*## Tasks/);
    expect(content).toContain('### 1. First Task\n\nDo the first task.');
    expect(content).toContain('## Final Verification\n\nRun tests.');
  });

  it('insert_after_section preserves markdown boundaries when target lacks a trailing newline', () => {
    const featureName = 'insert-after-no-trailing-newline';
    setupFeature(featureName);
    service.write(featureName, `# Plan

## Discovery

Original request and research notes are intentionally long enough to pass the planning discovery gate when this plan is patched through the tool layer.

## Design Summary

No trailing newline.`);
    const revision = service.read(featureName)!.revision;

    service.patch(featureName, revision, [
      {
        type: 'insert_after_section',
        headingPath: ['Design Summary'],
        content: '## Review Notes\n\nBounded amendment.\n',
      },
    ]);

    expect(service.read(featureName)!.content).toContain('No trailing newline.\n\n## Review Notes');
  });

  it('insert_after_section preserves markdown boundary before the next heading when insertion lacks trailing newline', () => {
    const featureName = 'insert-after-no-trailing-newline-before-next';
    setupFeature(featureName);
    writePatchablePlan(service, featureName);
    const revision = service.read(featureName)!.revision;

    service.patch(featureName, revision, [
      {
        type: 'insert_after_section',
        headingPath: ['Design Summary'],
        content: '\n## Review Notes\n\nBounded amendment.',
      },
    ]);

    expect(service.read(featureName)!.content).toContain('Bounded amendment.\n\n## Tasks');
  });

  it('insert_after_section rejects insertion content with an unclosed fenced block', () => {
    const featureName = 'insert-after-unclosed-fence';
    const featurePath = setupFeature(featureName);
    writePatchablePlan(service, featureName);
    const revision = service.read(featureName)!.revision;
    const before = fs.readFileSync(path.join(featurePath, 'plan.md'), 'utf-8');

    expect(() => service.patch(featureName, revision, [
      {
        type: 'insert_after_section',
        headingPath: ['Design Summary'],
        content: '\n## Review Notes\n\n```markdown\nUnclosed example.\n',
      },
    ])).toThrow(/unclosed fenced code block/i);

    expect(fs.readFileSync(path.join(featurePath, 'plan.md'), 'utf-8')).toBe(before);
  });

  it('insert_after_section rejects insertion content that starts with a parent heading', () => {
    const featureName = 'insert-after-parent-heading';
    const featurePath = setupFeature(featureName);
    writePatchablePlan(service, featureName);
    const revision = service.read(featureName)!.revision;
    const before = fs.readFileSync(path.join(featurePath, 'plan.md'), 'utf-8');

    expect(() => service.patch(featureName, revision, [
      {
        type: 'insert_after_section',
        headingPath: ['Design Summary'],
        content: '\n# Injected Root\n\nThis must not reparent later sections.\n',
      },
    ])).toThrow(/must start with sibling heading/i);

    expect(fs.readFileSync(path.join(featurePath, 'plan.md'), 'utf-8')).toBe(before);
  });

  it('insert_after_section rejects insertion content that duplicates an existing sibling section path', () => {
    const featureName = 'insert-after-duplicate-section-path';
    const featurePath = setupFeature(featureName);
    writePatchablePlan(service, featureName);
    const revision = service.read(featureName)!.revision;
    const before = fs.readFileSync(path.join(featurePath, 'plan.md'), 'utf-8');

    expect(() => service.patch(featureName, revision, [
      {
        type: 'insert_after_section',
        headingPath: ['Design Summary'],
        content: '\n## Design Summary\n\nDuplicate section.\n',
      },
    ])).toThrow(/duplicate section path/i);

    expect(fs.readFileSync(path.join(featurePath, 'plan.md'), 'utf-8')).toBe(before);
  });

  it('insert_after_section rejects insertion content that creates a second Tasks section', () => {
    const featureName = 'insert-after-duplicate-tasks-section';
    const featurePath = setupFeature(featureName);
    writePatchablePlan(service, featureName);
    const revision = service.read(featureName)!.revision;
    const before = fs.readFileSync(path.join(featurePath, 'plan.md'), 'utf-8');

    expect(() => service.patch(featureName, revision, [
      {
        type: 'insert_after_section',
        headingPath: ['Design Summary'],
        content: '\n## Tasks\n\n### 1. Injected Duplicate Task\n\nDo injected work.\n',
      },
    ])).toThrow(/duplicate section path/i);

    expect(fs.readFileSync(path.join(featurePath, 'plan.md'), 'utf-8')).toBe(before);
  });

  it('insert_after_section rejects insertion content that creates a lowercase duplicate Tasks section', () => {
    const featureName = 'insert-after-lowercase-duplicate-tasks-section';
    const featurePath = setupFeature(featureName);
    writePatchablePlan(service, featureName);
    const revision = service.read(featureName)!.revision;
    const before = fs.readFileSync(path.join(featurePath, 'plan.md'), 'utf-8');

    expect(() => service.patch(featureName, revision, [
      {
        type: 'insert_after_section',
        headingPath: ['Design Summary'],
        content: '\n## tasks\n\n### 1. Injected Duplicate Task\n\nDo injected work.\n',
      },
    ])).toThrow(/multiple tasks sections/i);

    expect(fs.readFileSync(path.join(featurePath, 'plan.md'), 'utf-8')).toBe(before);
  });

  it('rejects patch when plan comments change during validation', () => {
    const featureName = 'patch-comment-change-during-validation';
    const featurePath = setupFeature(featureName);
    writePatchablePlan(service, featureName);
    const revision = service.read(featureName)!.revision;
    const before = fs.readFileSync(path.join(featurePath, 'plan.md'), 'utf-8');

    expect(() => service.patch(featureName, revision, [
      {
        type: 'replace_section',
        headingPath: ['Design Summary'],
        content: '## Design Summary\n\nUse the revised design.\n',
      },
    ], () => {
      service.addComment(featureName, { line: 7, body: 'Late comment', replies: [] });
      return null;
    })).toThrow(/lock/i);

    expect(fs.readFileSync(path.join(featurePath, 'plan.md'), 'utf-8')).toBe(before);
    expect(service.getComments(featureName)).toHaveLength(0);
  });

  it('rejects patch when approval changes during validation', () => {
    const featureName = 'patch-approval-change-during-validation';
    const featurePath = setupFeature(featureName);
    writePatchablePlan(service, featureName);
    const revision = service.read(featureName)!.revision;
    const before = fs.readFileSync(path.join(featurePath, 'plan.md'), 'utf-8');

    expect(() => service.patch(featureName, revision, [
      {
        type: 'replace_section',
        headingPath: ['Design Summary'],
        content: '## Design Summary\n\nUse the revised design.\n',
      },
    ], () => {
      service.approve(featureName);
      return null;
    })).toThrow(/lock/i);

    expect(fs.readFileSync(path.join(featurePath, 'plan.md'), 'utf-8')).toBe(before);
    expect(service.isApproved(featureName)).toBe(false);
  });
});
