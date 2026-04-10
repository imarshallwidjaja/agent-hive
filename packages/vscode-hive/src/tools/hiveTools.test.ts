import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

type ToolMetadata = {
  name: string;
  displayName: string;
  modelDescription: string;
  toolReferenceName?: string;
  canBeReferencedInPrompt?: boolean;
  destructive?: boolean;
  readOnly?: boolean;
  invoke: (input: Record<string, unknown>) => Promise<string>;
};

const tempDirs = new Set<string>();
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function createTempProject(): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vscode-hive-tools-'));
  tempDirs.add(tempDir);
  return tempDir;
}

async function loadToolModules(): Promise<{
  getAgentsMdTools: (workspaceRoot: string) => ToolMetadata[];
  getContextTools: (workspaceRoot: string) => ToolMetadata[];
  getExecTools: (workspaceRoot: string) => ToolMetadata[];
  getFeatureTools: (workspaceRoot: string) => ToolMetadata[];
  getMergeTools: (workspaceRoot: string) => ToolMetadata[];
  getPlanTools: (workspaceRoot: string) => ToolMetadata[];
  getSkillTools: (workspaceRoot: string) => ToolMetadata[];
  getStatusTools: (workspaceRoot: string) => ToolMetadata[];
  getTaskTools: (workspaceRoot: string) => ToolMetadata[];
  getAllToolRegistrations: (workspaceRoot: string) => ToolMetadata[];
}> {
  const toolsIndexUrl = pathToFileURL(path.join(packageRoot, 'src', 'tools', 'index.ts')).href;
  const agentsMdUrl = pathToFileURL(path.join(packageRoot, 'src', 'tools', 'agentsMd.ts')).href;
  const contextUrl = pathToFileURL(path.join(packageRoot, 'src', 'tools', 'context.ts')).href;
  const execUrl = pathToFileURL(path.join(packageRoot, 'src', 'tools', 'exec.ts')).href;
  const featureUrl = pathToFileURL(path.join(packageRoot, 'src', 'tools', 'feature.ts')).href;
  const mergeUrl = pathToFileURL(path.join(packageRoot, 'src', 'tools', 'merge.ts')).href;
  const planUrl = pathToFileURL(path.join(packageRoot, 'src', 'tools', 'plan.ts')).href;
  const skillUrl = pathToFileURL(path.join(packageRoot, 'src', 'tools', 'skill.ts')).href;
  const statusUrl = pathToFileURL(path.join(packageRoot, 'src', 'tools', 'status.ts')).href;
  const taskUrl = pathToFileURL(path.join(packageRoot, 'src', 'tools', 'task.ts')).href;

  try {
    const toolsIndexModule = await import(toolsIndexUrl) as {
      getAllToolRegistrations: (workspaceRoot: string) => ToolMetadata[];
    };
    const agentsMdModule = await import(agentsMdUrl) as {
      getAgentsMdTools: (workspaceRoot: string) => ToolMetadata[];
    };
    const contextModule = await import(contextUrl) as {
      getContextTools: (workspaceRoot: string) => ToolMetadata[];
    };
    const execModule = await import(execUrl) as {
      getExecTools: (workspaceRoot: string) => ToolMetadata[];
    };
    const featureModule = await import(featureUrl) as {
      getFeatureTools: (workspaceRoot: string) => ToolMetadata[];
    };
    const mergeModule = await import(mergeUrl) as {
      getMergeTools: (workspaceRoot: string) => ToolMetadata[];
    };
    const planModule = await import(planUrl) as {
      getPlanTools: (workspaceRoot: string) => ToolMetadata[];
    };
    const skillModule = await import(skillUrl) as {
      getSkillTools: (workspaceRoot: string) => ToolMetadata[];
    };
    const statusModule = await import(statusUrl) as {
      getStatusTools: (workspaceRoot: string) => ToolMetadata[];
    };
    const taskModule = await import(taskUrl) as {
      getTaskTools: (workspaceRoot: string) => ToolMetadata[];
    };

    return {
      getAllToolRegistrations: toolsIndexModule.getAllToolRegistrations,
      getAgentsMdTools: agentsMdModule.getAgentsMdTools,
      getContextTools: contextModule.getContextTools,
      getExecTools: execModule.getExecTools,
      getFeatureTools: featureModule.getFeatureTools,
      getMergeTools: mergeModule.getMergeTools,
      getPlanTools: planModule.getPlanTools,
      getSkillTools: skillModule.getSkillTools,
      getStatusTools: statusModule.getStatusTools,
      getTaskTools: taskModule.getTaskTools,
    };
  } catch (error) {
    assert.fail(`Expected hive tool modules to exist: ${error}`);
  }
}

afterEach(() => {
  for (const tempDir of tempDirs) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  tempDirs.clear();
});

describe('Hive LM tool registrations', () => {
  it('exposes a coherent prompt-reference catalog for contributed Hive tools', async () => {
    const { getAllToolRegistrations } = await loadToolModules();
    const registrations = getAllToolRegistrations(createTempProject());

    const contributedToolNames = [
      'hive_feature_create',
      'hive_feature_complete',
      'hive_plan_write',
      'hive_plan_read',
      'hive_plan_approve',
      'hive_tasks_sync',
      'hive_task_create',
      'hive_task_update',
      'hive_worktree_start',
      'hive_worktree_create',
      'hive_worktree_commit',
      'hive_worktree_discard',
      'hive_merge',
      'hive_context_write',
      'hive_status',
      'hive_agents_md',
      'hive_skill',
    ];

    const byName = new Map(registrations.map((registration) => [registration.name, registration]));

    for (const toolName of contributedToolNames) {
      const registration = byName.get(toolName);
      assert.ok(registration, `expected registration for ${toolName}`);
      assert.equal(registration?.canBeReferencedInPrompt, true, `${toolName} should be prompt-visible`);
      assert.ok(registration?.toolReferenceName, `${toolName} should expose a prompt reference name`);
    }

    assert.equal(byName.get('hive_status')?.toolReferenceName, 'hiveStatus');
    assert.equal(byName.get('hive_plan_read')?.toolReferenceName, 'hivePlanRead');
    assert.equal(byName.get('hive_context_write')?.toolReferenceName, 'hiveContextWrite');
    assert.equal(byName.get('hive_worktree_commit')?.toolReferenceName, 'hiveWorktreeCommit');
    assert.equal(byName.get('hive_feature_complete')?.destructive, true);
    assert.equal(byName.get('hive_worktree_discard')?.destructive, true);
    assert.equal(byName.get('hive_skill')?.readOnly, true);
  });

  it('initializes, syncs, and applies AGENTS.md content', async () => {
    const projectRoot = createTempProject();
    fs.writeFileSync(path.join(projectRoot, 'package.json'), JSON.stringify({
      scripts: {
        build: 'tsc -b',
        test: 'bun test',
        dev: 'vite',
      },
      workspaces: ['packages/*'],
      devDependencies: {
        vitest: '^1.0.0',
      },
    }));
    fs.mkdirSync(path.join(projectRoot, '.hive', 'features', 'demo', 'context'), { recursive: true });
    fs.writeFileSync(
      path.join(projectRoot, '.hive', 'features', 'demo', 'context', 'learnings.md'),
      '# Learnings\nwe use bun workspaces\nprefer bun over npm\n'
    );

    const { getAgentsMdTools } = await loadToolModules();
    const tool = getAgentsMdTools(projectRoot).find((registration) => registration.name === 'hive_agents_md');

    assert.ok(tool, 'expected hive_agents_md registration');

    const initResult = JSON.parse(await tool.invoke({ action: 'init' })) as { existed: boolean; content: string };
    assert.equal(initResult.existed, false);
    assert.match(initResult.content, /# Agent Guidelines/);
    assert.equal(fs.existsSync(path.join(projectRoot, 'AGENTS.md')), false);

    const missingSyncResult = JSON.parse(await tool.invoke({ action: 'sync' })) as { error: string };
    assert.equal(missingSyncResult.error, 'Feature name required for sync');

    fs.writeFileSync(path.join(projectRoot, 'AGENTS.md'), '# Agent Guidelines\n\n## Existing\n');
    const syncResult = JSON.parse(await tool.invoke({ action: 'sync', feature: 'demo' })) as { proposals: string[]; diff: string };
    assert.deepEqual(syncResult.proposals, ['we use bun workspaces', 'prefer bun over npm']);
    assert.match(syncResult.diff, /^\+ we use bun workspaces/m);

    const missingApplyResult = JSON.parse(await tool.invoke({ action: 'apply' })) as { error: string };
    assert.equal(missingApplyResult.error, 'Content required for apply');

    const applyResult = JSON.parse(await tool.invoke({ action: 'apply', content: '# Applied' })) as { chars: number; isNew: boolean; path: string };
    assert.equal(applyResult.isNew, false);
    assert.equal(applyResult.chars, '# Applied'.length);
    assert.equal(fs.readFileSync(path.join(projectRoot, 'AGENTS.md'), 'utf8'), '# Applied');
    assert.equal(applyResult.path, path.join(projectRoot, 'AGENTS.md'));
  });

  it('loads a skill from supported folders and reports missing skills', async () => {
    const projectRoot = createTempProject();
    const skillPath = path.join(projectRoot, '.github', 'skills', 'writing-plans');
    fs.mkdirSync(skillPath, { recursive: true });
    fs.writeFileSync(path.join(skillPath, 'SKILL.md'), '# Writing Plans');

    const { getSkillTools } = await loadToolModules();
    const tool = getSkillTools(projectRoot).find((registration) => registration.name === 'hive_skill');

    assert.ok(tool, 'expected hive_skill registration');
    assert.equal(await tool.invoke({ name: 'writing-plans' }), '# Writing Plans');

    const missingResult = JSON.parse(await tool.invoke({ name: 'missing-skill' })) as {
      error: string;
      searchedPaths: string[];
    };
    assert.equal(missingResult.error, 'Skill not found: missing-skill');
    assert.deepEqual(missingResult.searchedPaths, [
      path.join(projectRoot, '.github', 'skills', 'missing-skill', 'SKILL.md'),
      path.join(projectRoot, '.claude', 'skills', 'missing-skill', 'SKILL.md'),
      path.join(projectRoot, '.opencode', 'skill', 'missing-skill', 'SKILL.md'),
    ]);
  });
});
