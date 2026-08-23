import type { HiveCommandMetadata } from './types.js';
import {
  DASH_REVIEW_PRIMARY_AGENT,
  VULNERABILITY_REVIEW_PRIMARY_AGENT,
} from '../review-runtime-kernel.js';

export const HIVE_COMMANDS = [
  {
    key: 'interview',
    name: '/interview',
    description: 'Clarify an idea toward a reliable implementation-brief handoff',
  },
  {
    key: 'grill',
    name: '/grill',
    description: 'Reach explicit alignment on any supplied context',
  },
  {
    key: 'implementation-brief',
    name: '/implementation-brief',
    description: 'Create a copy-paste-ready implementation planning brief',
  },
  {
    key: 'hive-plan',
    name: '/hive-plan',
    description: 'Create a Hive implementation plan from a spec or brief',
  },
  {
    key: 'approve-sync-plan',
    name: '/approve-sync-plan',
    description: 'Approve the active Hive plan and sync executable tasks',
  },
  {
    key: 'start-execution',
    name: '/start-execution',
    description: 'Start executing an approved Hive plan',
  },
  {
    key: 'council-directive',
    name: '/council-directive',
    description: 'Turn a rough request into a reusable council directive',
  },
  {
    key: 'council',
    name: '/council',
    description: 'Run a read-only council and synthesize a recommendation',
  },
  {
    key: 'dash-review',
    name: '/dash-review',
    description: 'Review an implementation snapshot without changing files',
    agent: DASH_REVIEW_PRIMARY_AGENT,
  },
  {
    key: 'vuln-review',
    name: '/vuln-review',
    description: 'Assess a frozen scope for evidenced vulnerabilities without changing files',
    agent: VULNERABILITY_REVIEW_PRIMARY_AGENT,
  },
  {
    key: 'compact-summary',
    name: '/compact-summary',
    description: 'Produce a recovery summary for the current OpenCode session',
  },
] as const satisfies readonly HiveCommandMetadata[];

export type HiveCommandKey = (typeof HIVE_COMMANDS)[number]['key'];
