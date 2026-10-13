import { z } from '../runtime/schema.js';
import type { ReadTransport } from '../runtime/host-profile.js';
import type { ReadServerOptions } from './client.js';

/**
 * Options an operator passes to the v2 adapter in the plugin entry:
 * `plugins: [{ "package": "oc-arkive", "options": { ... } }]`. The JSON Schema in
 * `schema/opencode-v2.options.schema.json` documents the same shape.
 *
 * `server` locates the running server for the reads the in-process plugin API does not offer. It holds the URL and
 * the name of an environment variable with the server password, never the password itself, so the secret stays out
 * of project and user configuration. Without `server` those reads report that they are not configured.
 */
export type V2Options = {
  readTransport: ReadTransport;
  server?: ReadServerOptions;
};

const serverUrl = z.string().refine((value) => {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password && !url.search && !url.hash;
}, 'server.url must be an http(s) URL without credentials, query or fragment');

const optionsSchema = z.strictObject({
  readTransport: z.enum(['codemode', 'direct']).optional(),
  server: z.strictObject({
    url: serverUrl,
    username: z.string().min(1).optional(),
    passwordEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'server.passwordEnv must name an environment variable').optional(),
  }).optional(),
});

export class V2OptionsError extends Error {
  override name = 'V2OptionsError';
}

/** Parses the operator's plugin options. Unknown keys fail, so a misspelt option or an inline secret is reported, not ignored. */
export function parseV2Options(raw: unknown): V2Options {
  const parsed = optionsSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join('.') || 'options'}: ${issue.message}`).join('; ');
    throw new V2OptionsError(`Invalid oc-arkive options: ${issues}`);
  }
  const { readTransport = 'codemode', server } = parsed.data;
  return {
    readTransport,
    ...(server ? { server: { url: server.url, username: server.username ?? 'opencode', ...(server.passwordEnv ? { passwordEnv: server.passwordEnv } : {}) } } : {}),
  };
}
