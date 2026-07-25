import * as path from 'node:path';
import {
  fingerprintReviewWorkspaceSourceScope,
  fingerprintReviewWorkspaceVulnerabilityScope,
} from 'hive-core';
import type {
  ReviewWorkspaceCaller,
  ReviewWorkspaceLeaseInput,
  ReviewWorkspaceSourceScope,
  ReviewWorkspaceVulnerabilityScopeDescriptor,
  ReviewWorkspaceWorkflow,
} from 'hive-core';
import {
  compactMaterializationDescriptors,
  type GitSnapshotInput,
  type ReviewMaterialization,
} from './utils/git-snapshot.js';

export type ReviewWorkspaceWorkflowAliases = {
  workflow: ReviewWorkspaceWorkflow;
  primaryAgent: string;
  creatorAgents: readonly string[];
};

type ReviewWorkspaceToolContext = {
  agent?: unknown;
  sessionID?: unknown;
};

function normalizedStrings(values: readonly string[] | undefined): string[] {
  return [...new Set(values ?? [])].sort((left, right) => {
    const leftPoints = Array.from(left, (character) => character.codePointAt(0)!);
    const rightPoints = Array.from(right, (character) => character.codePointAt(0)!);
    const sharedLength = Math.min(leftPoints.length, rightPoints.length);
    for (let index = 0; index < sharedLength; index += 1) {
      if (leftPoints[index] !== rightPoints[index]) return leftPoints[index]! - rightPoints[index]!;
    }
    return leftPoints.length - rightPoints.length;
  });
}

function normalizedScopePaths(values: readonly string[] | undefined): string[] {
  return normalizedStrings(values?.map((entry) => {
    if (
      !entry
      || entry.startsWith('-')
      || entry.startsWith(':')
      || entry.includes('\0')
      || entry.includes('\\')
      || path.posix.isAbsolute(entry)
    ) {
      throw new Error(`Path must be repository-relative: ${entry}`);
    }
    const normalized = path.posix.normalize(entry);
    if (normalized === '..' || normalized.startsWith('../')) {
      throw new Error(`Path must be repository-relative: ${entry}`);
    }
    return normalized;
  }));
}

export function inferReviewWorkspaceCaller(
  context: ReviewWorkspaceToolContext | undefined,
  role: ReviewWorkspaceCaller['role'],
  workflows: readonly ReviewWorkspaceWorkflowAliases[],
): ReviewWorkspaceCaller {
  const agent = typeof context?.agent === 'string' ? context.agent : '';
  const sessionId = typeof context?.sessionID === 'string' ? context.sessionID : '';
  if (!agent || !sessionId) throw new Error('Review workspace caller identity is unavailable.');
  const definition = workflows.find((candidate) => role === 'primary'
    ? candidate.primaryAgent === agent
    : candidate.creatorAgents.includes(agent));
  if (!definition) throw new Error('Caller is not authorized to manage review workspaces.');
  return { workflow: definition.workflow, role, agent, sessionId, pid: process.pid };
}

export function normalizeReviewWorkspaceSourceScope(
  repositoryIds: readonly string[] | undefined,
  snapshot: GitSnapshotInput,
): ReviewWorkspaceSourceScope {
  return {
    repositoryIds: normalizedStrings(repositoryIds),
    snapshot: {
      ...(snapshot.baseRef === undefined ? {} : { baseRef: snapshot.baseRef }),
      ...(snapshot.targetRef === undefined ? {} : { targetRef: snapshot.targetRef }),
      ...(snapshot.range === undefined ? {} : { range: snapshot.range }),
      paths: normalizedScopePaths(snapshot.paths),
      ...(snapshot.maxFiles === undefined ? {} : { maxFiles: snapshot.maxFiles }),
      ...(snapshot.maxPatchBytes === undefined ? {} : { maxPatchBytes: snapshot.maxPatchBytes }),
    },
  };
}

export function fingerprintReviewWorkspaceScope(sourceScope: ReviewWorkspaceSourceScope): string {
  return fingerprintReviewWorkspaceSourceScope(sourceScope);
}

export function createReviewWorkspaceLeaseInput(input: {
  caller: ReviewWorkspaceCaller;
  repositoryIds: readonly string[] | undefined;
  snapshot: GitSnapshotInput;
  selectedRepositoryIds: readonly string[];
  vulnerabilityScope?: Omit<ReviewWorkspaceVulnerabilityScopeDescriptor, 'schema'>;
  sourceFingerprint: string;
  materializedFingerprint: string;
  materializations: Array<{ repositoryId: string; materialization: ReviewMaterialization }>;
}): ReviewWorkspaceLeaseInput {
  if (input.caller.role !== 'creator') throw new Error('Review workspace creation requires creator capability.');
  const sourceScope = normalizeReviewWorkspaceSourceScope(input.repositoryIds, input.snapshot);
  const selectedRepositoryIds = normalizedStrings(input.selectedRepositoryIds);
  if ((input.caller.workflow === 'vulnerability-review') !== (input.vulnerabilityScope !== undefined)) {
    throw new Error('Vulnerability review workspace creation requires its canonical scope descriptor.');
  }
  const scopeDescriptor: ReviewWorkspaceVulnerabilityScopeDescriptor | null = input.vulnerabilityScope
    ? {
        schema: 'hive-vuln-review-scope/v1',
        mode: input.vulnerabilityScope.mode,
        repositories: normalizedStrings(input.vulnerabilityScope.repositories),
        paths: normalizedScopePaths(input.vulnerabilityScope.paths),
        comparisonBase: input.vulnerabilityScope.comparisonBase,
        hiveScope: input.vulnerabilityScope.hiveScope,
      }
    : null;
  if (scopeDescriptor && JSON.stringify(scopeDescriptor.repositories) !== JSON.stringify(selectedRepositoryIds)) {
    throw new Error('Vulnerability review scope repositories must match materialized repositories.');
  }
  if (scopeDescriptor && JSON.stringify(scopeDescriptor.paths) !== JSON.stringify(sourceScope.snapshot.paths)) {
    throw new Error('Vulnerability review scope paths must match the source scope.');
  }
  return {
    workflow: input.caller.workflow,
    creatorAgent: input.caller.agent,
    creatorSessionId: input.caller.sessionId,
    sourceScope,
    scopeDescriptor,
    selectedRepositoryIds,
    scopeFingerprint: scopeDescriptor
      ? fingerprintReviewWorkspaceVulnerabilityScope(scopeDescriptor)
      : fingerprintReviewWorkspaceScope(sourceScope),
    sourceFingerprint: input.sourceFingerprint,
    materializedFingerprint: input.materializedFingerprint,
    materializedEntries: Object.fromEntries(input.materializations.map(({ repositoryId, materialization }) => [
      repositoryId,
      compactMaterializationDescriptors(materialization.entries),
    ])),
  };
}
