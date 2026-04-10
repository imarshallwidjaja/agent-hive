import type { ToolRegistration } from './base';
import { toLanguageModelToolContribution } from './base';
import { getAgentsMdTools } from './agentsMd';
import { getContextTools } from './context';
import { getExecTools } from './exec';
import { getFeatureTools } from './feature';
import { getMergeTools } from './merge';
import { getPlanTools } from './plan';
import { getSkillTools } from './skill';
import { getStatusTools } from './status';
import { getTaskTools } from './task';

export { createToolResult, defineTool, toLanguageModelToolContribution } from './base';
export type { LanguageModelToolContribution, ToolConfirmation, ToolInput, ToolRegistration } from './base';
export { getFeatureTools } from './feature';
export { getPlanTools } from './plan';
export { getTaskTools } from './task';
export { getExecTools } from './exec';
export { getMergeTools } from './merge';
export { getContextTools } from './context';
export { getStatusTools } from './status';
export { getAgentsMdTools } from './agentsMd';
export { getSkillTools } from './skill';

export function getAllToolRegistrations(workspaceRoot: string): ToolRegistration[] {
  return [
    ...getFeatureTools(workspaceRoot),
    ...getPlanTools(workspaceRoot),
    ...getTaskTools(workspaceRoot),
    ...getExecTools(workspaceRoot),
    ...getMergeTools(workspaceRoot),
    ...getContextTools(workspaceRoot),
    ...getStatusTools(workspaceRoot),
    ...getAgentsMdTools(workspaceRoot),
    ...getSkillTools(workspaceRoot),
  ];
}

export function getContributedLanguageModelTools(workspaceRoot: string) {
  return getAllToolRegistrations(workspaceRoot)
    .map((registration) => toLanguageModelToolContribution(registration))
    .filter((registration) => registration !== null);
}
