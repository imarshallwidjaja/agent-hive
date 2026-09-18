import { describe, expect, it } from 'bun:test';
import { createBuiltinMcps } from './index.js';

describe('built-in MCP config', () => {
  it('registers the current built-in MCP inventory', () => {
    expect(Object.keys(createBuiltinMcps()).sort()).toEqual(['ast_grep', 'context7', 'grep_app']);
  });

  it('filters a disabled built-in MCP', () => {
    expect(Object.keys(createBuiltinMcps(['context7'])).sort()).toEqual(['ast_grep', 'grep_app']);
  });
});
