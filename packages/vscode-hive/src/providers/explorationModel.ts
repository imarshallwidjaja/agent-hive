import type { ExplorationCounts, ExplorationFullView, ExplorationStatus, FrontierItemState, ObservationStatus } from 'hive-core';
import { getNativeObservationOwnerLabel } from 'hive-core';
import { formatTimestamp } from './worklogPresentation.js';

/** One frontier target, in stored order. `changed` marks a change recorded after the revision the tab showed before. */
export interface ExplorationTargetNode {
  key: string;
  target: string;
  state: FrontierItemState;
  question: string | null;
  evidence: string | null;
  reason: string | null;
  refs: string[];
  updatedRevision: number;
  changed: boolean;
}

/** One observation, in stored order. Its recorded status is kept as is, even when another observation supersedes it. */
export interface ExplorationObservationNode {
  key: string;
  summary: string;
  status: ObservationStatus;
  refs: string[];
  supersedes: string | null;
  supersededBy: string[];
  updatedRevision: number;
  changed: boolean;
}

/**
 * Everything the exploration tab shows, built from one full read. Every string is recorded text and is rendered as
 * text only.
 */
export interface ExplorationViewModel {
  id: string;
  goal: string;
  subject: string | null;
  status: ExplorationStatus;
  closure: { label: 'Conclusion' | 'Reason'; text: string; closedAt: string } | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
  updatedBy: string;
  priorExplorationId: string | null;
  counts: ExplorationCounts;
  stagnantRevisions: number;
  /** The revision shown before the latest update; items changed after it are marked. Null marks nothing. */
  changedSince: number | null;
  targets: ExplorationTargetNode[];
  observations: ExplorationObservationNode[];
  untrustedNotice: string;
}

export function buildExplorationModel(view: ExplorationFullView, changedSince: number | null): ExplorationViewModel {
  const changed = (revision: number) => changedSince !== null && revision > changedSince;
  const supersededBy = new Map<string, string[]>();
  for (const item of view.observations) {
    if (item.supersedes !== undefined) supersededBy.set(item.supersedes, [...(supersededBy.get(item.supersedes) ?? []), item.key]);
  }
  const closureText = view.status === 'concluded' ? view.conclusion : view.reason;
  return {
    id: view.id,
    goal: view.goal,
    subject: view.subject ?? null,
    status: view.status,
    closure: view.status !== 'active' && closureText !== undefined && view.closedAt !== undefined
      ? { label: view.status === 'concluded' ? 'Conclusion' : 'Reason', text: closureText, closedAt: formatTimestamp(view.closedAt) }
      : null,
    revision: view.revision,
    createdAt: formatTimestamp(view.createdAt),
    updatedAt: formatTimestamp(view.updatedAt),
    updatedBy: `${view.updatedBy.agent} (${getNativeObservationOwnerLabel(view.updatedBy.owner)})`,
    priorExplorationId: view.priorExplorationId ?? null,
    counts: view.counts,
    stagnantRevisions: view.stagnantRevisions,
    changedSince,
    targets: view.frontier.map((item) => ({
      key: item.key,
      target: item.target,
      state: item.state,
      question: item.question ?? null,
      evidence: item.evidence ?? null,
      reason: item.reason ?? null,
      refs: item.refs ?? [],
      updatedRevision: item.updatedRevision,
      changed: changed(item.updatedRevision),
    })),
    observations: view.observations.map((item) => ({
      key: item.key,
      summary: item.summary,
      status: item.status,
      refs: item.refs ?? [],
      supersedes: item.supersedes ?? null,
      supersededBy: supersededBy.get(item.key) ?? [],
      updatedRevision: item.updatedRevision,
      changed: changed(item.updatedRevision),
    })),
    untrustedNotice: view.untrustedNotice,
  };
}
