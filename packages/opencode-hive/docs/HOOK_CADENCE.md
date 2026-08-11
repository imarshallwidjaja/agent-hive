# Hook Cadence Configuration

## Overview

`hook_cadence` is a global operator setting. Production currently invokes the cadence gate only for `tool.execute.before`. Other registered plugin hooks are not cadence-controlled by this setting.

## Configuration

Add `hook_cadence` to `~/.config/opencode/agent_hive.json`, the only Agent Hive runtime configuration source:

```json
{
  "hook_cadence": {
    "tool.execute.before": 1
  }
}
```

### Configuration Semantics

- Keys are hook-name strings. A configured cadence must be an integer greater than or equal to `1`.
- An absent or `null` value returns cadence `1`.
- A non-positive or non-integer value logs a warning and returns cadence `1`.
- A missing or malformed global config falls back to defaults, including cadence `1`.

## Implemented Behavior

The production `tool.execute.before` hook calls the cadence gate before Docker sandbox wrapping. The gate maintains an independent invocation counter and fires on the first invocation, then every `cadence` invocations. The production call marks this hook as safety-critical.

## Safety-Critical Behavior

`tool.execute.before` wraps eligible shell commands for Docker sandbox isolation. **It must run on every invocation.**

The implementation enforces cadence `1` for this hook when the safety-critical flag is set, regardless of user configuration. Setting a value greater than `1` logs:

```text
[hive:cadence] Ignoring cadence > 1 for safety-critical hook: tool.execute.before
```

## Backward Compatibility

- **Zero behavior change** when `hook_cadence` is absent from config.
- **Zero behavior change** when `tool.execute.before` is set to `1`.
- Existing configs without `hook_cadence` continue to work as before.

## Testing

Cadence validation and safety-critical enforcement are covered by the hook cadence tests:

```bash
cd packages/opencode-hive
bun test src/__tests__/hook-cadence.test.ts
```
