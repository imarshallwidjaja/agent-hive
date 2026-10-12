/**
 * Bundles the plugin for both OpenCode hosts.
 *
 * `src/index.ts` is the module both hosts load. The v2 adapter (`src/v2/plugin.ts`) is a second entry so it
 * stays a lazily imported chunk that a v1 host never evaluates. The v2 host provides `effect` and
 * `@opencode/plugin` at runtime and requires a single Effect instance, so those stay external; everything
 * else is bundled as before.
 */
const result = await Bun.build({
  entrypoints: ['src/index.ts', 'src/v2/plugin.ts'],
  outdir: 'dist',
  target: 'node',
  format: 'esm',
  packages: 'bundle',
  splitting: true,
  external: ['effect', 'effect/*', '@opencode/plugin', '@opencode/plugin/*'],
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

for (const output of result.outputs) {
  console.log(`${output.path.replace(`${process.cwd()}/`, '')}  ${(output.size / 1024).toFixed(0)} KB`);
}
