import * as path from 'path';
import * as fs from 'fs';

const HIVE_DIR = '.hive';
const FEATURES_DIR = 'features';
const TASKS_DIR = 'tasks';
const CONTEXT_DIR = 'context';
const PLAN_FILE = 'plan.md';
const COMMENTS_FILE = 'comments.json';
const FEATURE_FILE = 'feature.json';
const STATUS_FILE = 'status.json';
const REPORT_FILE = 'report.md';

export function getHivePath(projectRoot: string): string {
  return path.join(projectRoot, HIVE_DIR);
}

export function getFeaturesPath(projectRoot: string): string {
  return path.join(getHivePath(projectRoot), FEATURES_DIR);
}

export function getFeaturePath(projectRoot: string, featureName: string): string {
  return path.join(getFeaturesPath(projectRoot), featureName);
}

export function getPlanPath(projectRoot: string, featureName: string): string {
  return path.join(getFeaturePath(projectRoot, featureName), PLAN_FILE);
}

export function getCommentsPath(projectRoot: string, featureName: string): string {
  return path.join(getFeaturePath(projectRoot, featureName), COMMENTS_FILE);
}

export function getFeatureJsonPath(projectRoot: string, featureName: string): string {
  return path.join(getFeaturePath(projectRoot, featureName), FEATURE_FILE);
}

export function getContextPath(projectRoot: string, featureName: string): string {
  return path.join(getFeaturePath(projectRoot, featureName), CONTEXT_DIR);
}

export function getTasksPath(projectRoot: string, featureName: string): string {
  return path.join(getFeaturePath(projectRoot, featureName), TASKS_DIR);
}

export function getTaskPath(projectRoot: string, featureName: string, taskFolder: string): string {
  return path.join(getTasksPath(projectRoot, featureName), taskFolder);
}

export function getTaskStatusPath(projectRoot: string, featureName: string, taskFolder: string): string {
  return path.join(getTaskPath(projectRoot, featureName, taskFolder), STATUS_FILE);
}

export function getTaskReportPath(projectRoot: string, featureName: string, taskFolder: string): string {
  return path.join(getTaskPath(projectRoot, featureName, taskFolder), REPORT_FILE);
}

export function getTaskSpecPath(projectRoot: string, featureName: string, taskFolder: string): string {
  return path.join(getTaskPath(projectRoot, featureName, taskFolder), 'spec.md');
}

export function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

export function fileExists(filePath: string): boolean {
  return fs.existsSync(filePath);
}

export function readJson<T>(filePath: string): T | null {
  if (!fs.existsSync(filePath)) return null;
  const content = fs.readFileSync(filePath, 'utf-8');
  return JSON.parse(content) as T;
}

export function writeJson<T>(filePath: string, data: T): void {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

export function readText(filePath: string): string | null {
  if (!fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath, 'utf-8');
}

export function writeText(filePath: string, content: string): void {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, content);
}
