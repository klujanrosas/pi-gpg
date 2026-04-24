# pi-gpg

> **Status:** Phase 1 shipped — signed commits via `git_commit` tool, bash
> interception for `git commit|tag|merge|rebase|cherry-pick|revert|am`,
> session-scoped passphrase cache matching gpg-agent defaults.

A [Pi](https://github.com/badlogic/pi-mono) extension that makes GPG commit
signing safe for AI agents.

## The problem

Pi (and every other AI CLI agent) has no good answer for `git commit -S`. When
git invokes gpg, gpg-agent spawns a pinentry that opens `/dev/tty` **directly**
to ask for the passphrase — bypassing the agent's stdout/stderr pipes. The
agent can't see the prompt, can't answer it, and the pinentry's curses frames
corrupt whatever the agent *is* trying to read. The commit hangs silently or
garbage ends up on the screen.

## The fix

pi-gpg routes GPG's passphrase prompt through **Pi's own UI surface** instead
of the TTY. GPG never spawns pinentry (we use `--pinentry-mode loopback`). The
passphrase flows from `ctx.ui.input()` → an inherited file descriptor → gpg,
never touching `/dev/tty`, never landing on disk, never appearing in argv or
environment.

Benefits:

- Works in every mode Pi supports: interactive TUI, RPC, and `-p` print mode.
- Works over SSH, inside tmux, inside containers — no GUI assumed.
- Session-scoped passphrase cache that mirrors gpg-agent's defaults
  (`default-cache-ttl 600s`, `max-cache-ttl 7200s`) and is zeroed on
  `session_shutdown`.
- Covers `git commit`, `git tag -s`, `git merge -S`, and `git rebase -S` —
  **including** the case where the user has set `commit.gpgsign=true` globally
  and never types `-S` at all.
- Blocks-and-redirects raw `git commit -S` bash calls to the first-class
  `git_commit` tool so the LLM is nudged onto the safe path, with a
  `ctx.ui.notify` so you see it happen.

## Install

### Try it once (ad-hoc)

```sh
pi -e /absolute/path/to/pi-gpg/src/index.ts
```

### Install locally (project)

```sh
pi install -l /absolute/path/to/pi-gpg
```

### Install locally (global, all projects)

```sh
pi install /absolute/path/to/pi-gpg
```

### Install from git (once pushed)

```sh
pi install git:github.com/klujanrosas/pi-gpg
```

### Install from npm (once published)

```sh
pi install npm:pi-gpg
```

### Dogfood while developing

The repo ships `.pi/extensions/pi-gpg.ts` which re-exports `src/index.ts`.
Running `pi` inside this folder auto-loads the extension against the current
source — no build step, no stale copies.

```sh
cd pi-gpg
pi
```

## Commands

| Command        | Status    | What it does                                            |
| -------------- | --------- | ------------------------------------------------------- |
| `/gpg-doctor`  | ✅ Phase 0 | Inspect GPG/git-signing env, report issues.             |
| `/gpg-status`  | ✅ Phase 1 | Cache state, TTLs, active keys.                         |
| `/gpg-unlock`  | ✅ Phase 1 | Prompt for passphrase and pre-populate the cache.       |
| `/gpg-lock`    | ✅ Phase 1 | Zero the cache immediately.                             |
| `/gpg-config`  | ⏳ Phase 2 | Pick signing key, change cache policy.                  |
| `/gpg-migrate` | ⏳ Phase 3 | Migrate to SSH signing / YubiKey.                       |

## Tools

| Tool         | What it does                                                    |
| ------------ | --------------------------------------------------------------- |
| `git_commit` | Make a signed commit without pinentry. Uses fd-3 passphrase — no disk exposure. |

## Bash interception

When the LLM (or a hook script) runs `git commit` / `git tag -s` / `git merge` /
`git rebase` / `git cherry-pick` / `git revert` / `git am` through the `bash`
tool, pi-gpg detects the signing intent, transparently rewrites the command
to route GPG through our loopback shim with a mode-0600 temp passphrase file,
and emits a `ctx.ui.notify` so you see it happen. Covers:

- `-S` / `--gpg-sign[=KEYID]` / `-s` (tag) / `-u KEYID`
- `--no-gpg-sign` / `--no-sign` (tag) — respected, not routed
- Implicit signing via `commit.gpgsign=true` / `tag.gpgsign=true`
- Global git flags: `git -c foo=bar -C /repo commit -S …`
- Chained commands: `git add . && git commit -S -m fix && git push`
- SSH signing backend (`gpg.format = ssh`) is detected and left alone.

## Development

```sh
npm install
npm run typecheck   # tsc --noEmit
npm test            # vitest run
npm run lint        # biome check .
npm run fix         # biome check --write .
npm run check       # typecheck + lint + test (used in CI)
```

Extensions load via [jiti](https://github.com/unjs/jiti) — **there is no build
step**. Edit `src/*.ts`, reload Pi, it's live.

### Repo layout

```
pi-gpg/
├── package.json              # pi.extensions manifest + peerDeps
├── tsconfig.json             # strict ESM, Node 20+
├── biome.json                # tabs width 3, matches pi-mono
├── vitest.config.ts
├── src/
│   ├── index.ts              # extension entry (default export)
│   ├── doctor.ts             # env inspection + diagnosis (pure)
│   └── exec.ts               # ExecFn abstraction for testability
├── test/
│   ├── doctor.test.ts        # doctor unit tests (pure, no gpg needed)
│   └── load.test.ts          # verifies the module loads + registers hooks
└── .pi/
    ├── extensions/pi-gpg.ts  # project-local dogfood re-export
    └── settings.json
```

## Roadmap

- **Phase 0 (this release)** — scaffold, `/gpg-doctor`, distributable via all
  four install channels (local, git, npm, ad-hoc).
- **Phase 1** — `git_commit` tool, passphrase cache, bash `git commit -S`
  interception, fd-based passphrase flow, tiny gpg-loopback shim.
- **Phase 2** — status widget, `/gpg-config` key picker, per-commit confirm
  policy, Touch ID gating on macOS.
- **Phase 3** — `git tag/merge/rebase` coverage, SSH-signing migration,
  YubiKey flow, inter-extension events.
- **Phase 4** — hardening, fuzz tests on bash-command detection, signed
  releases (dogfood the dogfood).

## Threat model

Phase 1+ will document this in full. Short version:

- Passphrase lives only in an extension-process `Buffer` for the configured
  TTL.
- Never written to disk. Never in `argv`. Never in `env`.
- Flows to gpg through an inherited anonymous pipe (fd 3) that our shim hands
  off via `--passphrase-fd 3`.
- On `session_shutdown`, the buffer is zeroed (best-effort) and references
  dropped.
- Users who want hardware-backed signing should run `/gpg-migrate ssh` (Phase 3)
  — routes signing to `ssh-agent` / Secure Enclave and removes GPG from the
  critical path entirely.

## License

MIT © Kenneth Lujan
