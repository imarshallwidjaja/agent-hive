# Vulnerability class checklists

Use these checklists while tracing forward from an entry point and during sibling sweeps. Each item is a question to answer from the source with a `file:line`. A checklist item is a place to look, not a finding: every candidate still passes the three gates in `SKILL.md`. This reference adds method, not authority.

## Injection

- SQL and NoSQL: is any query built by string concatenation or template interpolation of request data? Are ORM raw-query escape hatches, dynamic column or sort names, and `$where`-style operators fed by user input?
- Command execution: does user input reach a shell, a process spawn with a shell, or an argument list where a value can start with `-`?
- Template and expression engines: can user input become template source, an expression, or a format string, rather than a value bound into one?
- Header and log injection: can CR/LF in input split a response header, a redirect target, or a log record?
- LDAP, XPath, and GraphQL: are filters or queries assembled from input, and does the GraphQL layer bound depth, aliases, and introspection where that matters?

## Authentication

- Which routes skip the authentication middleware, and is each exemption intended?
- Are session tokens and JWTs verified with a fixed algorithm, a checked signature, and checked expiry, audience, and issuer?
- Do password reset, email change, invitation, and magic-link flows bind the token to one user, expire it, and invalidate it after use?
- Is multi-factor enforcement applied on every path to the protected action, including API and mobile routes?

## Authorization, BOLA, BFLA, and tenant scoping

- Object level (BOLA): does each handler that takes an object ID confirm the caller may access that object, or does it trust the ID?
- Function level (BFLA): are admin and privileged operations checked server-side by role or permission, not only hidden in the UI?
- Tenant scoping: does every query, cache key, storage path, search index call, and outbound request carry the caller's tenant? Check bulk, export, and background-job paths, which often bypass request middleware.
- Mass assignment: can a request body set fields such as `role`, `ownerId`, `tenantId`, or `isAdmin` that the caller must not control?
- Indirect references: do list, search, and aggregate endpoints leak objects that the single-object endpoint would refuse?

## Server-side request forgery

- Can a user-supplied URL, hostname, or redirect target make the server issue a request (webhooks, URL previews, imports, image fetchers, PDF renderers)?
- Is the destination checked after DNS resolution and after each redirect, against loopback, link-local, private ranges, and cloud metadata addresses?
- Do alternate schemes (`file:`, `gopher:`, `dict:`) or URL-parser differences bypass the allowlist?

## Browser-facing: XSS, CSRF, and CORS

- XSS: where is user data written into HTML, attributes, URLs, inline scripts, or `innerHTML`-style sinks without context-appropriate encoding? Check markdown renderers, rich-text sanitizers, and framework escape hatches.
- CSRF: do state-changing requests that use cookie authentication require a CSRF token or a strict SameSite policy, including on non-POST methods?
- CORS: is the allowed origin reflected from the request or matched with a loose pattern while credentials are allowed?
- Open redirects: can a `next`, `returnTo`, or similar parameter send the user to an attacker origin?

## Files, uploads, deserialization, and prototype pollution

- Path traversal: can input reach a filesystem path, archive extraction, or static-file route without normalization and containment in a fixed root?
- Uploads: are type, size, and name validated server-side, and are uploaded files kept out of executable or same-origin served paths?
- Deserialization: does untrusted data reach native object deserializers, YAML loaders with object construction, or class-name-driven decoders?
- Prototype pollution: can user-controlled keys such as `__proto__` or `constructor.prototype` reach a deep merge, path setter, or query-string parser?
- XML: are external entities and DTD processing disabled for XML from untrusted sources?

## Cryptography and secrets

- Are secrets, keys, or tokens committed in source or configuration, or written to logs and error responses?
- Are passwords hashed with a slow, salted algorithm, and are tokens generated from a cryptographically secure source?
- Are comparisons of secrets constant-time, and are TLS certificate and hostname checks enabled on outbound connections?
- Are encryption modes authenticated, and are IVs and nonces unique per message?

## Races, TOCTOU, and business logic

- Check-then-act: is a balance, quota, inventory count, or one-time token checked in one step and consumed in another without a transaction, lock, or atomic update?
- Idempotency: can replaying a request double-apply a payment, credit, or state transition?
- State machines: can a request skip a required step, move an object backwards, or act on an object in the wrong state?
- Numeric edges: can negative, zero, very large, or non-integer amounts change the outcome?

## Infrastructure and proxy configuration

- Trusted proxy headers: does the application trust `X-Forwarded-For`, `X-Forwarded-Host`, or `X-Forwarded-Proto` from any client, letting a caller spoof its IP, host, or scheme?
- Route exposure: does the proxy or ingress expose admin, debug, metrics, or internal service routes that the application assumes are private?
- Host header: are password-reset links, absolute URLs, or cache keys built from an unvalidated `Host` header?
- Defaults: are debug modes, permissive CORS, or disabled authentication left enabled in the production configuration?
