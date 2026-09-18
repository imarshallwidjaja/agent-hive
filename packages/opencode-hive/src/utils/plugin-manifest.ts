import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { HIVE_COMMANDS } from '../commands/registry.js';
import type { HiveCommandMetadata } from '../commands/types.js';

export type PluginCommandManifestEntry = HiveCommandMetadata;

export interface PluginManifest {
  name: string;
  version: string;
  description: string;
  dataPath: string;
  commands: Array<Pick<PluginCommandManifestEntry, 'name' | 'description'>>;
  tools: string[];
}

export const HIVE_PLUGIN_NAME = 'hive';
export const HIVE_PLUGIN_DESCRIPTION = 'Context-Driven Development';
export const HIVE_PLUGIN_DATA_PATH = '../../.hive';
export { HIVE_COMMANDS };

export const HIVE_TOOL_NAMES = [
  'hive_feature_create',
  'hive_feature_select',
  'hive_feature_complete',
  'hive_repositories_status',
  'hive_repositories_discover',
  'hive_repositories_update',
  'hive_plan_write',
  'hive_plan_patch',
  'hive_plan_read',
  'hive_plan_approve',
  'hive_tasks_sync',
  'hive_task_create',
  'hive_task_update',
  'hive_worktree_create',
  'hive_worktree_inspect',
  'hive_worktree_merge',
  'hive_worktree_cleanup',
  'hive_adhoc_worktree_create',
  'hive_adhoc_worktree_inspect',
  'hive_adhoc_worktree_merge',
  'hive_adhoc_worktree_cleanup',
  'hive_background_status',
  'hive_background_reconcile',
  'hive_background_reconcile_batch',
  'hive_background_cancel',
  'hive_task_trace',
  'hive_task_trace_content',
  'hive_context_read',
  'hive_context_write',
  'hive_context_append',
  'hive_context_archive',
  'hive_constraints_read',
  'hive_constraints_add',
  'hive_constraints_edit',
  'hive_constraints_clear',
  'hive_status',
  'hive_git_snapshot',
] as const;

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export function getPluginPackageJsonPath(): string {
  return path.join(packageRoot, 'package.json');
}

export function getPluginManifestPath(): string {
  return path.join(packageRoot, 'plugin.json');
}

export function readPluginPackageVersion(packageJsonPath = getPluginPackageJsonPath()): string {
  const raw = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8')) as { version?: unknown };
  if (typeof raw.version !== 'string' || !raw.version.trim()) {
    throw new Error(`Expected a string version in ${packageJsonPath}`);
  }
  return raw.version;
}

export function buildPluginManifest(version = readPluginPackageVersion()): PluginManifest {
  return {
    name: HIVE_PLUGIN_NAME,
    version,
    description: HIVE_PLUGIN_DESCRIPTION,
    dataPath: HIVE_PLUGIN_DATA_PATH,
    commands: HIVE_COMMANDS.map(({ name, description }) => ({ name, description })),
    tools: [...HIVE_TOOL_NAMES],
  };
}

export function stringifyPluginManifest(manifest: PluginManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}
