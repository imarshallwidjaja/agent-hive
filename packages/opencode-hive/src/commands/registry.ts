import type { HiveCommandMetadata } from './types.js';
export const HIVE_COMMANDS = [
  {
    key: 'interview',
    name: '/interview',
    description: 'Clarify an idea toward shared understanding, with no fixed next step',
  },
  {
    key: 'grill',
    name: '/grill',
    description: 'Pressure-test supplied context until scope and acceptance criteria are agreed, then recommend the next step',
  },
  {
    key: 'investigate',
    name: '/investigate',
    description: 'Diagnose a problem from evidence and propose a fix with success criteria, without changing code',
  },
  {
    key: 'walkthrough',
    name: '/walkthrough',
    description: 'Walk through how a subsystem works now, or what a finished change did',
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
    key: 'implement',
    name: '/implement',
    description: 'Implement the work this conversation scoped as ad-hoc work, with any extra steering you add',
  },
  {
    key: 'merge-to-main',
    name: '/merge-to-main',
    description: 'Merge the intended work into its main branch, reviewed and verified on the result',
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
    description: 'Review one Git, inline, or local-artifact evidence bundle without changing files',
    agent: 'dash-reviewer',
  },
  {
    key: 'test-audit',
    name: '/test-audit',
    description: 'Audit test outcomes and duplicate coverage without changing files',
    agent: 'dash-reviewer',
  },
  {
    key: 'vuln-review',
    name: '/vuln-review',
    description: 'Assess a requested scope for evidenced vulnerabilities without changing files',
    agent: 'vulnerability-review-primary',
  },
  {
    key: 'worklog',
    name: '/worklog',
    description: 'Read back where the current work stands from its Worklog',
  },
  {
    key: 'handoff',
    name: '/handoff',
    description: 'Write a self-contained handoff another agent can pick up for the next job',
  },
  {
    key: 'compact-summary',
    name: '/compact-summary',
    description: 'Produce a recovery summary for the current OpenCode session',
  },
] as const satisfies readonly HiveCommandMetadata[];

export type HiveCommandKey = (typeof HIVE_COMMANDS)[number]['key'];
