# Context mutation and recovery

Read this reference when you need an exact call shape for a summary, catalog, named read, write, edit, append, or archive; when you create a durable file and need its frontmatter; when a hygiene warning or a ceiling error appears; or when a context tool returns `context_index_invalid` or `context_reconciliation_required`. The rules that protect context hold without it and stay in `SKILL.md`: finish a named read before replacing, pass the revision and hash from that read, and stop managed mutation on an index or reconciliation error. This reference adds examples and limits, not authority.

## Frontmatter

Durable creates need YAML frontmatter with nonblank `description` and `read_when`. Project durable documents also need accountability `owner` and `review_after` as strict `YYYY-MM-DD`. Owner and date are accountability labels, not authorization or correctness.

```markdown
---
description: Auth session binding decisions for worker launches.
read_when: Read before changing assignment identity, catalog delivery, or restart recovery.
owner: hive-maintainers
review_after: 2026-12-01
---

# Auth session binding
```

Unknown keys cannot change inclusion. Index kind and task and the reserved-name rules control classification. Malformed metadata warns; it does not hide a correctly classified durable file.

## Read calls

Summary (`scanChars` is a management scan for exact UTF-16 totals):

```
hive_context_read({ view: "summary" })
hive_context_read({ view: "summary", scanChars: true })
hive_context_read({ scope: "project", view: "summary" })
```

Catalog (no bodies; literal `query`; follow `cursor`):

```
hive_context_read({ view: "catalog", query: "auth binding", limit: 10 })
hive_context_read({ view: "catalog", query: "auth binding", cursor: nextCursor })
```

Named raw chunks (`maxBytes` is the serialized UTF-8 JSON budget, 16 KiB default, 64 KiB maximum):

```
hive_context_read({ name: "auth-decisions" })
hive_context_read({ name: "auth-decisions", cursor: nextCursor, maxBytes: 16384 })
```

Pass `nextCursor` unchanged until `complete: true`. Do not invent byte offsets. A named-read cursor that is oversized, malformed, expired after a plugin restart, or bound to another recipient or document fails as `stale_context_cursor`; start a new named read without a cursor.

## Write calls

Replacement, append, and archive need the current revision and the actual SHA-256 from the named read, after every chunk is read and the whole document is reconstructed. A bounded edit needs the same pair from your own named read, continued until it shows the whole passage and enough surrounding text; it does not need the unrelated chunks.

```
hive_context_edit({
  name: "auth-decisions",
  oldText: "Sessions bind at launch.",
  newText: "Sessions bind at first tool call.",
  expectedRevision: 12,
  expectedContentHash: "sha256-from-named-read"
})

hive_context_write({
  name: "auth-decisions",
  content: reconstructedMarkdown,
  expectedRevision: 12,
  expectedContentHash: "sha256-from-named-read"
})

hive_context_append({
  name: "auth-decisions",
  content: "## 2026-09-13\n\nNew fact.",
  expectedRevision: 12,
  expectedContentHash: "sha256-from-named-read"
})

hive_context_archive({
  names: ["auth-decisions"],
  reason: "Superseded by auth-session-binding; see that file.",
  expectedRevision: 12,
  expectedContentHashes: { "auth-decisions": "sha256-from-named-read" }
})
```

Omit revision and hash only when creating a missing file.

### Edit outcomes

`hive_context_edit` changes an existing named document only; a missing file fails `context_not_found` and creates nothing. Matching is literal over UTF-8 bytes: `$&` and backslashes in `newText` are inserted as written, and every byte outside the match, including BOM, CRLF, and Unicode, is kept. The revision and hash guards run before matching.

| Result | Meaning | Next step |
|---|---|---|
| `stale_revision`, `stale_content` | The document or its store changed after your read. | Read again; edit only if the passage still needs the change. |
| `context_edit_no_match` | `oldText` does not occur byte for byte; the message names CRLF line endings when the document has them. | Re-read and copy the passage exactly. |
| `context_edit_ambiguous` | `oldText` occurs more than once; overlapping occurrences count. | Copy enough surrounding text to match one passage. |
| `context_edit_no_change` | `oldText` and `newText` are identical. | Nothing to do. |
| `invalid_context_metadata` | The edited durable file would lack valid frontmatter. | Keep `description` and `read_when` (project: `owner`, `review_after`) valid. |
| `invalid_argument` | Empty `oldText`, or text with an unpaired UTF-16 surrogate. | Supply valid literal text. |

Empty `newText` deletes the passage. An evidence or reserved file may become empty; a durable file still needs its metadata. Deletion never archives. A refusal before publication, which covers every result in the table, leaves the document, index, and revision unchanged. An error while publishing restores the prior bytes or leaves the pending marker described below.

When a call errors or its result is unknown, read the document and establish whether the edit applied before retrying; do not assume an identical retry is safe. A successful edit advances the revision, so an identical retry fails `stale_revision`. If the next context call reports `context_reconciliation_required` or `context_index_invalid`, stop managed mutations and report the error. Do not re-read and replay blindly: when `newText` contains `oldText`, a replay can apply the change twice, and seeing `newText` does not prove this call put it there.

The revision lock and both guards prevent lost updates among writers that go through Hive's context tools. A process that writes the file directly while a publication is in progress is outside that guarantee. A publication failure rolls back or leaves the pending marker described below.

## Hygiene, units, ceilings

These are review signals, not aggregate admission rejection:

- Feature warnings: strictly above 8 durable files or 40,000 UTF-16 units.
- Project warnings: strictly above 32 durable files or 160,000 UTF-16 units. Nine project files do not warn.

`durable.bytes` is the stat-byte total. `durable.chars` is an exact UTF-16 count only after an explicit summary `scanChars` management scan; otherwise it is unavailable or stale. Catalog reads and status do not read all bodies for totals. When warnings appear, review counts, due or missing metadata, and metric availability, then call the explicit management tools. Do not auto-consolidate.

Renew project knowledge only after re-reviewing it against evidence: a whole-document hash-guarded replace and re-date, or an archive with a reason and a replacement reference.

Resource ceilings: 10,000 Markdown candidates, 20,000 namespace entries, 64 MiB scanned headers, 8 KiB frontmatter scan, 16 KiB catalog responses, 1 MiB managed write or append (for an edit, each of `oldText`, `newText`, and the edited document), 1,024 and 4,096 UTF-8 bytes for query and cursor inputs. Exceeding construction bounds returns `context_inventory_too_large`, never a partial `complete: true`. Exact named reads bypass inventory. Overlarge write, edit, query, or catalog-cursor input is `context_input_too_large`; an oversized named-read cursor instead returns `stale_context_cursor`, so restart the named read without a cursor.

## Invalid or pending state

`context_index_invalid` and `context_reconciliation_required` block `hive_context_read` catalogs and managed mutations. An error notice is not an empty or current catalog. `.managed-mutation-pending.json` in a context directory marks an interrupted publication.

An agent that meets either error stops managed mutations, reports the exact error with the tool name, inputs, and the context directory, and waits for the operator. Reading this section does not authorize an agent to edit, delete, or rewrite `index.json`, the pending marker, or any manifest, and the tools never repair them either: Hive does not infer classification, rewrite control files, or retry repairs automatically.

Repair is separately authorized operator recovery, done out of band through trusted local editing:

1. Quiesce writers.
2. Preserve and inspect the bytes and known records before changing anything.
3. Correct or restore the index and manifest.
4. Explicitly reconcile the pending marker.

Never delete an index to restore classification. When no operator has authorized the recovery, the honest outcome is a stopped mutation and a report.
