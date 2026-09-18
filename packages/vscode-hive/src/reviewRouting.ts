import * as fs from 'fs';
import * as path from 'path';

export interface ReviewTarget {
  featureName: string;
  document: 'plan' | 'overview';
}

function reviewPathApi(workspaceRoot: string): typeof path {
  return /^(?:[a-z]:[\\/]|\\\\)/i.test(workspaceRoot) ? path.win32 : path;
}

function relativeReviewPath(workspaceRoot: string, filePath: string): string | null {
  const path = reviewPathApi(workspaceRoot);
  // Reject traversal before normalization can erase it.
  if (/(^|[\\/])\.\.([\\/]|$)/.test(filePath)) return null;
  if (!path.isAbsolute(workspaceRoot) || !path.isAbsolute(filePath)) return null;
  const relative = path.relative(workspaceRoot, filePath);
  if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) return null;
  return relative.split(path.sep).join('/');
}

export function reviewTargetForDocument(workspaceRoot: string, filePath: string): ReviewTarget | null {
  const relative = relativeReviewPath(workspaceRoot, filePath);
  const match = relative?.match(/^\.hive\/features\/([^/]+)\/(plan\.md|context\/overview\.md)$/);
  return match ? { featureName: match[1], document: match[2] === 'plan.md' ? 'plan' : 'overview' } : null;
}

export function reviewTargetForComments(workspaceRoot: string, filePath: string): ReviewTarget | null {
  const relative = relativeReviewPath(workspaceRoot, filePath);
  const match = relative?.match(/^\.hive\/features\/([^/]+)\/(?:comments\/(plan|overview)\.json|comments\.json)$/);
  return match ? { featureName: match[1], document: (match[2] ?? 'plan') as ReviewTarget['document'] } : null;
}

export function reviewDocumentPath(workspaceRoot: string, target: ReviewTarget): string {
  const path = reviewPathApi(workspaceRoot);
  return path.join(workspaceRoot, '.hive', 'features', target.featureName,
    target.document === 'plan' ? 'plan.md' : 'context/overview.md');
}

export function reviewCommentsPath(workspaceRoot: string, target: ReviewTarget): string {
  const path = reviewPathApi(workspaceRoot);
  return path.join(workspaceRoot, '.hive', 'features', target.featureName, 'comments', `${target.document}.json`);
}

export function findReviewCommentsPath(workspaceRoot: string, target: ReviewTarget): string | null {
  const canonical = reviewCommentsPath(workspaceRoot, target);
  if (fs.existsSync(canonical)) return canonical;
  const legacy = reviewPathApi(workspaceRoot).join(workspaceRoot, '.hive', 'features', target.featureName, 'comments.json');
  return target.document === 'plan' && fs.existsSync(legacy) ? legacy : null;
}
