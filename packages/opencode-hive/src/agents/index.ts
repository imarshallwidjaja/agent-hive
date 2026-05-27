/**
 * Hive Agents
 * 
 * The Hive Colony Model:
 * - Hive (Hybrid): Plans AND orchestrates based on phase
 * - Architect (Planner): Plans features, interviews, writes plans
 * - Swarm (Orchestrator): Delegates, spawns workers, verifies, merges
 * - Scout (Research/Collector): Explores codebase and external docs
 * - Forager (Worker/Coder): Executes tasks in isolation
 * - Plan Reviewer: Reviews plan readiness
 * - Code Reviewer: Reviews implementation changes
 * - Simplicity Reviewer: Reviews implementation changes for deletion-biased cleanup
 * - Approach Advisor: Reviews technical direction
 * - Hive Builder: Ad-hoc executor for direct work
 */

// Bee agents (lean, focused)
export { hiveBeeAgent, QUEEN_BEE_PROMPT } from './hive';
export { architectBeeAgent, ARCHITECT_BEE_PROMPT } from './architect';
export { swarmBeeAgent, SWARM_BEE_PROMPT } from './swarm';
export { scoutBeeAgent, SCOUT_BEE_PROMPT } from './scout';
export { foragerBeeAgent, FORAGER_BEE_PROMPT } from './forager';
export { hiveHelperAgent, HIVE_HELPER_PROMPT } from './hive-helper';
export { hiveBuilderAgent, HIVE_BUILDER_PROMPT } from './hive-builder';
export { planReviewerAgent, PLAN_REVIEWER_PROMPT } from './plan-reviewer';
export { codeReviewerAgent, CODE_REVIEWER_PROMPT } from './code-reviewer';
export { simplicityReviewerAgent, SIMPLICITY_REVIEWER_PROMPT } from './simplicity-reviewer';
export { approachAdvisorAgent, APPROACH_ADVISOR_PROMPT } from './approach-advisor';


/**
 * Agent registry for OpenCode plugin
 * 
 * Bee Agents (recommended):
 * - hive: Hybrid planner + orchestrator (detects phase, loads skills)
 * - architect: Discovery/planning (requirements, plan writing)
 * - swarm: Orchestration (delegates, verifies, merges)
 * - scout: Research/collection (codebase + external docs/data)
 * - forager: Worker/coder (executes tasks in worktrees)
 * - plan-reviewer: Reviews plan readiness
 * - code-reviewer: Reviews implementation changes
 * - simplicity-reviewer: Reviews implementation changes for deletion-biased cleanup
 * - approach-advisor: Reviews technical direction
 * - hive-builder: Primary general-purpose Hive-aware executor for ad-hoc work
 */
export const hiveAgents = {
  // Bee Agents (lean, focused - recommended)
  hive: {
    name: 'Hive (Hybrid)',
    description: 'Hybrid planner + orchestrator. Detects phase, loads skills on-demand.',
    mode: 'primary' as const,
  },
  architect: {
    name: 'Architect (Planner)',
    description: 'Plans features, interviews, writes plans. NEVER executes.',
    mode: 'primary' as const,
  },
  swarm: {
    name: 'Swarm (Orchestrator)',
    description: 'Orchestrates execution. Delegates, spawns workers, verifies, merges.',
    mode: 'primary' as const,
  },
  scout: {
    name: 'Scout (Explorer/Researcher/Retrieval)',
    description: 'Explores codebase, external docs, and retrieves external data.',
    mode: 'subagent' as const,
  },
  forager: {
    name: 'Forager (Worker/Coder)',
    description: 'Executes tasks directly in isolated worktrees. Never delegates.',
    mode: 'subagent' as const,
  },
  'hive-helper': {
    name: 'Hive Helper',
    description: 'Runtime-only bounded hard-task operational assistant for merge recovery, state clarification, and safe manual follow-up assistance.',
    mode: 'subagent' as const,
  },
  'plan-reviewer': {
    name: 'Plan Reviewer',
    description: 'Reviews plan readiness. OKAY/REJECT verdict.',
    mode: 'subagent' as const,
  },
  'code-reviewer': {
    name: 'Code Reviewer',
    description: 'Reviews implementation diffs against task or plan requirements.',
    mode: 'subagent' as const,
  },
  'simplicity-reviewer': {
    name: 'Simplicity Reviewer',
    description: 'Reviews implementation diffs for YAGNI, dead code, duplication, unnecessary abstractions, and safe deletion-biased cleanup.',
    mode: 'subagent' as const,
  },
  'approach-advisor': {
    name: 'Approach Advisor',
    description: 'Read-only technical advisor for approach, architecture, and tradeoffs.',
    mode: 'subagent' as const,
  },
  'hive-builder': {
    name: 'Hive Builder',
    description: 'Primary general-purpose Hive-aware executor for ad-hoc work. Executes directly without plan/task DAG overhead.',
    mode: 'primary' as const,
  },
};
