import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { resetVscodeTestState, vscodeTestDouble, vscodeTestState as ui } from '../test/vscodeTestDouble.js';
const hiveCore = await import('../../../hive-core/src/index.ts');
const { FeatureService, WorklogService, getFeaturePath, WORKLOG_FACTS_NOTICE } = hiveCore;

mock.module('hive-core', () => hiveCore);
mock.module('vscode', () => vscodeTestDouble);

const { WorklogDocuments } = await import('./worklogDocuments');
const { WorklogViewerPreferences, WorklogsProvider, pickWorklog } = await import('./worklogsProvider');
const { resolveProjectPath, resolveReference } = await import('./worklogPresentation');

const TEST_ROOT_BASE = `/tmp/vscode-hive-worklog-test-${process.pid}`;

type Owner = 'opencode-v1' | 'opencode-v2';
type Ref = { kind: 'feature'; featureName: string } | { kind: 'session'; owner: Owner; sessionId: string };

function memento() {
  const data = new Map<string, unknown>();
  return {
    data,
    get: <T>(key: string) => data.get(key) as T | undefined,
    update: async (key: string, value: unknown) => {
      data.set(key, JSON.parse(JSON.stringify(value)));
    },
  };
}

/** Every path under the project with its bytes and mtime, so a read that writes anything is caught. */
function snapshot(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const stat = fs.lstatSync(full);
      if (entry.isDirectory()) {
        result[full] = `dir ${stat.mtimeMs}`;
        walk(full);
      } else {
        result[full] = `${stat.mtimeMs} ${crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex')}`;
      }
    }
  };
  walk(root);
  return result;
}

describe('Worklog viewer', () => {
  let root: string;
  let sequence = 0;

  beforeEach(() => {
    resetVscodeTestState();
    fs.rmSync(TEST_ROOT_BASE, { recursive: true, force: true });
    fs.mkdirSync(TEST_ROOT_BASE, { recursive: true });
    root = fs.mkdtempSync(path.join(TEST_ROOT_BASE, 'workspace-'));
    fs.mkdirSync(path.join(root, '.hive'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(TEST_ROOT_BASE, { recursive: true, force: true });
  });

  function record(ref: Ref, summary: string, extra: Record<string, unknown> = {}, owner: Owner = 'opencode-v1', sessionId = 'ses_writer') {
    const author = ref.kind === 'session' ? { owner: ref.owner, sessionId: ref.sessionId, agent: 'hive-master' } : { owner, sessionId, agent: 'swarm-orchestrator' };
    const { checkpoint, ...rest } = extra as { checkpoint?: Record<string, unknown> };
    return new WorklogService(root).record(ref as never, { operationId: `op-${++sequence}`, checkpoint: { summary, ...checkpoint }, ...rest } as never, author as never);
  }

  function writeTask(featureName: string, folder: string, status: string) {
    const dir = path.join(getFeaturePath(root, featureName), 'tasks', folder);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify({ status, origin: 'plan' }, null, 2));
  }

  async function documentText(documents: InstanceType<typeof WorklogDocuments>, view: 'brief' | 'history' | 'facts', key: string): Promise<string> {
    return documents.provideTextDocumentContent(documents.uriFor(view, key));
  }

  async function group(provider: InstanceType<typeof WorklogsProvider>, name: 'selected' | 'pinned' | 'recent'): Promise<any[]> {
    const roots = await provider.getChildren();
    const match = roots.find((item: any) => item.group === name);
    return match ? provider.getChildren(match) : [];
  }

  it('lists offline session logs with both hosts kept apart and persists pins in workspace state only', async () => {
    new FeatureService(root).create('checkout');
    record({ kind: 'feature', featureName: 'checkout' }, 'Schema merged', { title: 'Checkout rewrite' });
    record({ kind: 'session', owner: 'opencode-v1', sessionId: 'ses_same' }, 'v1 session started', { title: 'Docs sweep' });
    record({ kind: 'session', owner: 'opencode-v2', sessionId: 'ses_same' }, 'v2 session started', { title: 'Docs sweep' });
    expect(fs.existsSync(path.join(root, '.hive', 'sessions.json'))).toBe(false);
    const before = snapshot(root);

    const state = memento();
    const preferences = new WorklogViewerPreferences(state, root);
    const provider = new WorklogsProvider(root, preferences);
    expect((await provider.getChildren()).map((item: any) => item.label)).toEqual(['Pinned', 'Recent']);

    const recent = await group(provider, 'recent');
    expect(recent.map((item: any) => item.worklogKey).sort()).toEqual([
      'feature:checkout',
      'session:opencode-v1:ses_same',
      'session:opencode-v2:ses_same',
    ]);
    expect(new Set(recent.map((item: any) => item.id)).size).toBe(3);
    const v1 = recent.find((item: any) => item.worklogKey === 'session:opencode-v1:ses_same');
    const v2 = recent.find((item: any) => item.worklogKey === 'session:opencode-v2:ses_same');
    expect(v1.label).toBe('Docs sweep');
    expect(v1.description).toMatch(/^OpenCode v1 session · /);
    expect(v2.description).toMatch(/^OpenCode v2 session · /);
    expect(v1.description).not.toContain('running');
    expect(v1.command).toEqual({ command: 'hive.worklog.open', title: 'Open Worklog', arguments: ['session:opencode-v1:ses_same'] });

    expect(await preferences.pin('session:opencode-v1:ses_same')).toBe(true);
    expect(await preferences.pin('session:opencode-v1:ses_same')).toBe(false);
    await expect(preferences.pin('session:nobody:ses_same')).rejects.toThrow();

    const reopened = new WorklogsProvider(root, new WorklogViewerPreferences(state, root));
    const pinned = await group(reopened, 'pinned');
    expect(pinned.map((item: any) => [item.worklogKey, item.contextValue, item.label])).toEqual([
      ['session:opencode-v1:ses_same', 'worklog-log-pinned', 'Docs sweep'],
    ]);
    const recentAgain = await group(reopened, 'recent');
    expect(recentAgain.find((item: any) => item.worklogKey === 'session:opencode-v1:ses_same').contextValue).toBe('worklog-log-pinned');
    expect(recentAgain.find((item: any) => item.worklogKey === 'session:opencode-v2:ses_same').contextValue).toBe('worklog-log');
    expect([...state.data.keys()]).toEqual(['hive.worklogs.viewer']);
    expect(new WorklogViewerPreferences(state, '/another/project').pins()).toEqual([]);

    const documents = new WorklogDocuments(root);
    const text = await documentText(documents, 'brief', 'session:opencode-v2:ses_same');
    expect(text).toContain('Worklog: Docs sweep\nWorklog key: session:opencode-v2:ses_same\n');
    expect(text).toContain(`OpenCode v2 session · project ${root}`);
    expect(text).toContain('Session logs have no task ledger.');
    expect(text).toContain('v2 session started');
    expect(text).not.toContain('v1 session started');

    expect(snapshot(root)).toEqual(before);
  });

  it('keeps the explicit selection when other logs change and reports a corrupt or missing selected log in place', async () => {
    const features = new FeatureService(root);
    features.create('alpha');
    features.create('beta');
    record({ kind: 'feature', featureName: 'alpha' }, 'Alpha started', { title: 'Alpha' });
    record({ kind: 'feature', featureName: 'beta' }, 'Beta started', { title: 'Beta' });

    const state = memento();
    const preferences = new WorklogViewerPreferences(state, root);
    await preferences.select('feature:alpha');
    const provider = new WorklogsProvider(root, preferences);
    const documents = new WorklogDocuments(root);
    const alphaUri = documents.uriFor('brief', 'feature:alpha');

    record({ kind: 'feature', featureName: 'beta' }, 'Beta moved on');
    provider.refresh();
    documents.refresh();
    expect((await group(provider, 'selected')).map((item: any) => [item.id, item.label])).toEqual([['selected:feature:alpha', 'Alpha']]);
    expect((await group(provider, 'recent'))[0].worklogKey).toBe('feature:beta');
    expect(preferences.selected()).toBe('feature:alpha');

    const alphaFile = path.join(getFeaturePath(root, 'alpha'), 'worklog.json');
    fs.writeFileSync(alphaFile, '{ not json');
    const corruptBefore = snapshot(root);
    const [selected] = await group(provider, 'selected');
    expect(selected.id).toBe('selected:feature:alpha');
    expect(selected.description).toBe('Unavailable: worklog_corrupt');
    expect(selected.contextValue).toBe('worklog-problem');
    const corruptText = documents.provideTextDocumentContent(alphaUri);
    expect(corruptText).toContain('Could not read this worklog (worklog_corrupt).');
    expect(corruptText).toContain('Worklog key: feature:alpha');
    expect(corruptText).toContain('The file is left unchanged.');
    expect(corruptText).not.toContain('Beta');
    expect(documents.uriFor('brief', 'feature:alpha').toString()).toBe(alphaUri.toString());
    expect(snapshot(root)).toEqual(corruptBefore);

    fs.rmSync(alphaFile);
    const missingText = documents.provideTextDocumentContent(alphaUri);
    expect(missingText).toContain('No worklog recorded yet\nWorklog key: feature:alpha');
    expect(missingText).toContain('No checkpoints have been recorded in this worklog.');
    expect((await group(provider, 'selected'))[0].description).toBe('feature alpha · no checkpoints yet');

    fs.rmSync(getFeaturePath(root, 'alpha'), { recursive: true });
    expect((await group(provider, 'selected'))[0].description).toBe('Unavailable: feature_not_found');
    expect(documents.provideTextDocumentContent(alphaUri)).toContain('Could not read this worklog (feature_not_found).');
    expect(preferences.selected()).toBe('feature:alpha');

    await preferences.pin('feature:alpha');
    expect((await group(provider, 'pinned'))[0].contextValue).toBe('worklog-problem-pinned');
    await preferences.unpin('feature:alpha');
    expect(preferences.pins()).toEqual([]);
  });

  it('pages recent logs behind an explicit load-more row and shows unreadable logs beside readable ones', async () => {
    for (let index = 0; index < 12; index++) {
      record({ kind: 'session', owner: 'opencode-v1', sessionId: `ses_${index}` }, `Session ${index}`);
    }
    const corruptPath = path.join(root, '.hive', 'worklogs', 'sessions', 'opencode-v1', `${'a'.repeat(64)}.json`);
    fs.writeFileSync(corruptPath, 'garbage');
    const provider = new WorklogsProvider(root, new WorklogViewerPreferences(memento(), root));

    const first = await group(provider, 'recent');
    expect(first).toHaveLength(11);
    expect(first.at(-1).label).toBe('Load more worklogs');
    expect(first.at(-1).command).toEqual({ command: 'hive.worklog.loadMore', title: 'Load More Worklogs', arguments: [{ loadMore: 'recent' }] });

    provider.loadMoreRecent();
    const all = await group(provider, 'recent');
    expect(all.filter((item: any) => item.contextValue === 'worklog-log')).toHaveLength(12);
    expect(all.some((item: any) => item.label === 'Load more worklogs')).toBe(false);
    const error = all.find((item: any) => item.contextValue === 'worklog-list-error');
    expect(error.label).toBe(`.hive/worklogs/sessions/opencode-v1/${'a'.repeat(64)}.json`);
    expect(error.description).toBe('Unreadable: worklog_corrupt');
    expect(error.command.arguments[0].fsPath).toBe(corruptPath);
    expect(fs.readFileSync(corruptPath, 'utf8')).toBe('garbage');
  });

  it('discovers older logs in the picker by paging and opens any log by full key', async () => {
    for (let index = 0; index < 52; index++) {
      record({ kind: 'session', owner: 'opencode-v2', sessionId: `ses_${index}` }, `Session ${index}`);
    }
    ui.picks.push(
      (items: any[]) => {
        expect(items.filter(item => item.action === 'open')).toHaveLength(50);
        return items.find(item => item.action === 'more');
      },
      (items: any[]) => {
        expect(items.filter(item => item.action === 'open')).toHaveLength(52);
        expect(items.some(item => item.action === 'more')).toBe(false);
        return items.find(item => item.detail === 'session:opencode-v2:ses_0');
      },
    );
    expect(await pickWorklog(root)).toBe('session:opencode-v2:ses_0');

    ui.picks.push((items: any[]) => items.find(item => item.action === 'key'));
    ui.inputs.push('  session:opencode-v1:ses:with:colons ');
    expect(await pickWorklog(root)).toBe('session:opencode-v1:ses:with:colons');
  });

  it('marks a stale briefing, keeps history anchored without repeating the briefing, and pages facts', async () => {
    new FeatureService(root).create('checkout');
    for (let index = 1; index <= 11; index++) writeTask('checkout', `${String(index).padStart(2, '0')}-task`, 'pending');
    const ref = { kind: 'feature' as const, featureName: 'checkout' };
    record(ref, 'Plan approved', { title: 'Checkout rewrite', briefing: 'BRIEFING-TEXT: eleven tasks queued.', expectedRevision: 0 });
    writeTask('checkout', '01-task', 'done');
    for (let index = 2; index <= 13; index++) record(ref, `Checkpoint ${index}`, { checkpoint: { detail: `DETAIL-${index}` } });
    const before = snapshot(root);

    const documents = new WorklogDocuments(root);
    const brief = await documentText(documents, 'brief', 'feature:checkout');
    expect(brief).toContain('Worklog: Checkout rewrite\nWorklog key: feature:checkout\n');
    expect(brief).toContain('Written with checkpoint #1 at ');
    expect(brief).toContain('12 checkpoints recorded after this briefing.');
    expect(brief).toContain('Source records changed: recorded task facts differ from those stored with this briefing. The briefing is not regenerated automatically.');
    expect(brief).toContain('    BRIEFING-TEXT: eleven tasks queued.');
    expect(brief).toContain(WORKLOG_FACTS_NOTICE);
    expect(brief).toContain('Recent checkpoints (newest first, 3 of 13)');
    expect(brief).toContain('10 older checkpoints and full details: run Show Worklog History.');
    expect(brief).not.toContain('DETAIL-13');

    const historyUri = documents.uriFor('history', 'feature:checkout');
    let history = documents.provideTextDocumentContent(historyUri);
    expect(history).not.toContain('BRIEFING-TEXT');
    expect(history).toContain('#13 · ');
    expect(history).toContain('DETAIL-13');
    expect(history).toContain('#4 · ');
    expect(history).not.toContain('#3 · ');
    expect(history).toContain('3 older checkpoints not loaded.');
    expect(snapshot(root)).toEqual(before);

    record(ref, 'Checkpoint 14');
    documents.refresh();
    history = documents.provideTextDocumentContent(historyUri);
    expect(history).toContain('1 newer checkpoint has been recorded since.');
    expect(history).not.toContain('Checkpoint 14');
    await documents.loadMore(historyUri);
    history = documents.provideTextDocumentContent(historyUri);
    expect(history).toContain('#1 · ');
    expect(history).toContain('This checkpoint set a briefing');
    expect(history).not.toContain('BRIEFING-TEXT');
    expect(history).toContain('End of history.');

    const beforeFacts = snapshot(root);
    const factsUri = documents.uriFor('facts', 'feature:checkout');
    let facts = documents.provideTextDocumentContent(factsUri);
    expect(facts).toContain('Task rows (10 of 11)');
    expect(facts).toContain('  01-task · done');
    expect(facts).toContain('More task rows exist.');
    await documents.loadMore(factsUri);
    facts = documents.provideTextDocumentContent(factsUri);
    expect(facts).toContain('Task rows (11 of 11)');
    expect(facts).toContain('All task rows shown.');

    const statusPath = path.join(getFeaturePath(root, 'checkout'), 'tasks', '01-task', 'status.json');
    expect(documents.provideDocumentLinks({ uri: factsUri } as never).map((link: any) => link.target.fsPath)).toContain(statusPath);
    expect(snapshot(root)).toEqual(beforeFacts);
  });

  it('links only safe project files and http(s) URLs and leaves other references as text', async () => {
    fs.mkdirSync(path.join(root, 'docs'));
    fs.writeFileSync(path.join(root, 'docs', 'note.md'), 'note');
    fs.symlinkSync(path.join(root, 'docs'), path.join(root, 'linked'));
    const ref = { kind: 'session' as const, owner: 'opencode-v1' as Owner, sessionId: 'ses_refs' };
    record(ref, 'Evidence collected', {
      checkpoint: {
        references: [
          { kind: 'path', path: 'docs/note.md', label: 'Note' },
          { kind: 'path', path: 'linked/note.md' },
          { kind: 'path', path: 'missing.md' },
          { kind: 'url', url: 'https://example.com/run/1' },
        ],
      },
    });

    const documents = new WorklogDocuments(root);
    const uri = documents.uriFor('history', 'session:opencode-v1:ses_refs');
    const text = documents.provideTextDocumentContent(uri);
    expect(text).toContain('[1] path: docs/note.md - Note\n');
    expect(text).toContain('[2] path: linked/note.md (not linked: crosses a symbolic link)');
    expect(text).toContain('[3] path: missing.md (not linked: not found)');
    const links = documents.provideDocumentLinks({ uri } as never) as any[];
    expect(links.map(link => link.target.fsPath ?? link.target.value)).toEqual([
      path.join(root, 'docs', 'note.md'),
      'https://example.com/run/1',
    ]);
    const lines = text.split('\n');
    expect(lines[links[0].range.start.line].slice(links[0].range.start.character, links[0].range.end.character)).toBe('docs/note.md');

    for (const url of ['javascript:alert(1)', 'command:hive.refresh', 'file:///etc/passwd', 'https://user:secret@example.com/']) {
      expect(resolveReference(root, { kind: 'url', url }).kind).toBe('blocked');
    }
    for (const relative of ['../outside.md', '/etc/passwd', 'docs\\note.md', 'docs/./note.md', 'docs', 'C:/x']) {
      expect(resolveProjectPath(root, relative).kind).toBe('blocked');
    }
  });

  it('keeps line breaks in task facts indented and every link on the line that shows its path', async () => {
    new FeatureService(root).create('checkout');
    const tasks = path.join(getFeaturePath(root, 'checkout'), 'tasks');
    writeTask('checkout', '01-first', 'pending');
    writeTask('checkout', '02-second', 'pending');
    const firstStatus = path.join(tasks, '01-first', 'status.json');
    fs.writeFileSync(firstStatus, JSON.stringify({ status: 'pending', origin: 'plan', planTitle: `First\n${'X'.repeat(200)}`, dependsOn: ['02-second\nRecorded facts', '02-second\rTask rows (9 of 9)'] }));
    fs.writeFileSync(path.join(tasks, '02-second', 'report.md'), 'report');
    fs.mkdirSync(path.join(tasks, '03-bad\nRecorded facts'));
    record({ kind: 'feature', featureName: 'checkout' }, 'Facts recorded');

    const documents = new WorklogDocuments(root);
    const uri = documents.uriFor('facts', 'feature:checkout');
    const text = documents.provideTextDocumentContent(uri);
    // The editor splits lines on CRLF, CR, and LF.
    const lines = text.split(/\r\n|\r|\n/);
    expect(text).not.toContain('\r');
    expect(lines.filter(line => line === 'Recorded facts')).toHaveLength(1);
    expect(lines.filter(line => line.startsWith('Task rows'))).toEqual(['Task rows (3 of 3)']);
    expect(lines).toContain(`      ${'X'.repeat(200)}`);
    expect(lines.some(line => /^ {2}Diagnostic: Task '03-bad$/.test(line))).toBe(true);
    expect(lines.some(line => /^ {6}Recorded facts': status_missing$/.test(line))).toBe(true);

    const links = documents.provideDocumentLinks({ uri } as never) as any[];
    expect(links.map(link => path.relative(root, link.target.fsPath)).sort()).toEqual([
      path.relative(root, firstStatus),
      path.relative(root, path.join(tasks, '02-second', 'report.md')),
      path.relative(root, path.join(tasks, '02-second', 'status.json')),
    ].sort());
    for (const link of links) {
      expect(link.range.start.line).toBe(link.range.end.line);
      expect(lines[link.range.start.line].slice(link.range.start.character, link.range.end.character)).toBe(path.relative(root, link.target.fsPath));
    }
  });

  it('does not read a document whose URI names another project', async () => {
    const documents = new WorklogDocuments(root);
    const foreign = new WorklogDocuments('/some/other/project').uriFor('brief', 'feature:checkout');
    const text = documents.provideTextDocumentContent(foreign);
    expect(text).toContain('This worklog document belongs to project /some/other/project.');
    expect(documents.keyFor(foreign)).toBeNull();
    expect(documents.keyFor(documents.uriFor('facts', 'session:opencode-v2:a:b'))).toBe('session:opencode-v2:a:b');
  });
});
