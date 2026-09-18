import type { McpConfig } from './types.js';
import { astGrepMcp } from './ast-grep.js';

const allBuiltinMcps: Record<string, McpConfig> = {
  websearch: {
    type: 'remote',
    url: 'https://mcp.exa.ai/mcp?tools=web_search_exa',
    headers: process.env.EXA_API_KEY
      ? { 'x-api-key': process.env.EXA_API_KEY }
      : undefined,
    oauth: false,
  },
  context7: {
    type: 'remote',
    url: 'https://mcp.context7.com/mcp',
    oauth: false,
  },
  grep_app: {
    type: 'remote',
    url: 'https://mcp.grep.app',
    oauth: false,
  },
  ast_grep: astGrepMcp,
};

export const createBuiltinMcps = (disabledMcps: string[] = []): Record<string, McpConfig> => {
  const disabled = new Set(disabledMcps);
  return Object.fromEntries(
    Object.entries(allBuiltinMcps).filter(([name]) => !disabled.has(name)),
  );
};
