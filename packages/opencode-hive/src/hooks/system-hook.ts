export const HIVE_SYSTEM_PROMPT = `
## Hive — Active Session

\`hive-master\`, \`swarm-orchestrator\`, and \`hive-builder\` are primary-only and are never valid native \`task()\` targets. \`architect-planner\` is the planning-only exception: a primary may delegate plan work to it, and it may call one layer of permitted read-only planning helpers. Those helpers and every other subagent are terminal.
`;

export const SUBAGENT_CLARIFICATION_PROMPT = `
## Clarification Handoff

The \`question\` tool is unavailable in subagent sessions. If clarification is required, stop and return the exact clarification question in your terminal response so the parent orchestrator can ask the operator.
`;
