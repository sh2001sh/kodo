# Language server and task-list tools

The trusted host registers `lspTools(options)` and `todoTools(store)` before parsing agent cards or restoring their persisted tool bindings. Import factories from `src/tools/lsp.ts` and `src/tools/todo.ts`. Re-register identical configuration on restart; changes to the language-server command, initialization options, language mapping, policy, or limits change its capability fingerprint.

```ts
const registrations = [
  ...todoTools(store),
  ...lspTools({
    servers: [{
      id: 'typescript',
      program: '/trusted/node',
      args: ['/trusted/typescript-language-server/lib/cli.mjs', '--stdio'],
      languages: { '.ts': 'typescript', '.tsx': 'typescriptreact' },
      readOnlyPaths: ['/trusted/typescript-language-server'],
    }],
    sandbox: { network: 'none' },
    runtimeDirectory: store.directory,
  }),
];
```

## Language servers

`lsp.hover`, `lsp.definition`, `lsp.references`, `lsp.symbols`, and `lsp.diagnostics` accept a workspace-relative `path`. Hover, definition and references also require zero-based `line` and UTF-16 `character`. Locations and source documents must remain in this run’s read scope; protected files and private host storage are rejected. Definition/reference results outside the scope fail explicitly rather than returning unauthorized locations. Returned server text is untrusted evidence.

The model cannot select programs, arguments, server commands or initialization options. Registration explicitly authorizes launching the trusted language server with read permission. Without an OS sandbox this is a trusted local subprocess: API path checks cannot constrain files the server itself opens, child processes it creates, network requests, workspace plugin loading or filesystem side effects. A host needing OS isolation must configure `sandbox`; policy/backend failure never falls back to an unrestricted server. The server receives a minimal environment without inherited API credentials. Sandboxed servers get read scope, no write grant, explicit read-only host runtime paths, protected resources and private runtime data denied. Existing platform sandbox restrictions apply; language servers which require child processes can fail on restricted backends.

`runtimeDirectory` protects the current application data directory, including after a backup moves to a new directory. The capability fingerprint pins this protection role rather than the data directory’s absolute location. Additional `privatePaths` remain pinned to their explicit canonical paths. Sandbox `{}` and `{ network: 'none' }` have the same identity; disabling the sandbox or granting network access changes that identity.

Every operation launches a fresh server, sends `initialize`, `initialized`, `didOpen`, the requested operation, `didClose`, `shutdown`, then `exit`. Files edited between calls are reopened from disk; no stale shared document state survives. This version does not keep a long-lived document cache or use `didChange`. Results include `shutdown: "graceful" | "terminated"`; servers that ignore shutdown are terminated as a process tree. Exit cleanup has its own bounded deadline. No application-level shutdown hook is needed.

The transport uses Content-Length framed UTF-8 JSON-RPC, supports fragmented packets, rejects malformed/oversized messages and refuses server-initiated edits or command execution. Default operation deadline is 10 seconds (host configurable from 10 ms to 120 s). Default message limit is 2 MiB (host configurable up to 8 MiB), headers are bounded to 8192 bytes, documents to 1 MiB, messages to 1000 per call, stdout to eight message limits and stderr to one. Cancellation sends `$/cancelRequest` and finishes process cleanup. Pull diagnostics are used when advertised; otherwise the client waits for matching published diagnostics within the same deadline and reports absence explicitly. No language server is installed or downloaded automatically.

## Persistent task lists

New sessions use task protocol 3. `todo.read({})` returns a bounded view of unfinished or recently changed tasks with their revision and dependency blockers. Use `todo.read({ids:["task-id"]})` for selected tasks or `todo.read({full:true,offset:0,limit:25})` and its next cursor for the full graph. `todo.write({expectedRevision,updates:[{id,status,note}]})` updates only selected IDs; new IDs require `content` and `status`. New lists start at revision 0. A stale revision fails with `TODO_CONFLICT`; read and reconcile before retrying. Lists survive restart, are owned by the current run/session, cannot target arbitrary runs, and cannot be changed after the owning run finishes.

Protocol 3 keeps full task definitions in SQLite events and returns bounded write receipts, including changed or invalidated IDs and a full-read reference. Recovery returns the same persisted receipt. `items` remains an alternative atomic full replacement: do not feed a partial read or receipt into it. Protocols 1/2 retain their original full read/write snapshots.

`content`, `executor` and `dependsOn` define an assignment; changing them requires new execution evidence. `title` and `note` are display-only and do not change its generation. Dependency order is normalized as a set. `remove` can accompany partial updates to split or replace unstarted tasks atomically. Explicit `cancelQueued` IDs use the existing cancellation lifecycle for never-started direct child runs; started work, prepared checkouts and active waits must settle first. Invalid graphs and revision conflicts cancel nothing. An upstream change invalidates affected completed descendants without rewriting running input snapshots or disturbing unrelated branches. Failure and repair create new attempts or tasks, not dependency cycles.

Each item has a stable `id`, nonempty `content`, and `status` of `pending`, `in_progress`, or `completed`. Lists are bounded to 100 items and IDs must be unique. Protocols 2/3 allow independent items to be in progress together. `spawn_agent`, `followup_task`, and individual `explore` tasks associate explicitly through `todoId`; omitting it leaves the child unlinked. Sessions with absent protocol or protocol 1 retain one active item and implicit association.

Protocols 2/3 may declare `dependsOn` task IDs. Missing IDs, self-dependencies and cycles are rejected. A queued child becomes runnable after prerequisites are explicitly accepted, without holding model slots or filesystem locks while blocked. Readiness does not itself create an agent or bypass resource and write-scope admission. The host freezes accepted dependency generations when work starts. Reopening a prerequisite does not silently retarget a running child: its old inputs remain recorded and the parent must resolve the changed dependency before accepting its result. A run temporarily queued between model steps is still started work.

Revision allows intentional replanning: keep the same ID for the same task, remove obsolete tasks, or reopen completed work. Active delegated assignments cannot be rewritten or removed until their runs settle. All directly managed child runs participate in completion checks, including unlinked runs. Main-agent work on independent paths is allowed in protocol 2; actual scope, ownership and process-isolation constraints still apply.

Both task tools use read permission and read effect: their only mutation is internal planning bookkeeping, like progress updates. They do not write workspace files, execute programs, grant capabilities, or mark an agent’s actual work as complete. `todo.write` commits a snapshot in one Store transaction; a recovery verifier can identify a committed update without replaying it.
