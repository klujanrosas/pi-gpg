# pi-gpg

> **Status:** Phase 2 shipped — masked passphrase overlay, persistent
> `/gpg-config` (signing key, confirm policy, TTL overrides, Touch ID
> gating on macOS). Phase 1 primitives still apply: `git_commit` tool,
> bash interception, session-scoped passphrase cache.

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

| Command        | Status    | What it does                                                           |
| -------------- | --------- | ---------------------------------------------------------------------- |
| `/gpg-doctor`  | ✅ Phase 0 | Inspect GPG/git-signing env, report issues.                            |
| `/gpg-status`  | ✅ Phase 1 | Cache state, TTLs, active keys, effective config.                      |
| `/gpg-unlock`  | ✅ Phase 1 | Prompt (masked) for passphrase and pre-populate the cache.             |
| `/gpg-lock`    | ✅ Phase 1 | Zero the cache immediately.                                            |
| `/gpg-config`  | ✅ Phase 2 | Pick signing key, confirm policy, cache TTL overrides, Touch ID toggle. |
| `/gpg-migrate` | ⏳ Phase 3 | Migrate to SSH signing / YubiKey.                                      |

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

- **Phase 0** — scaffold, `/gpg-doctor`, distributable via all four install
  channels (local, git, npm, ad-hoc).
- **Phase 1** — `git_commit` tool, passphrase cache, bash `git commit -S`
  interception, fd-based passphrase flow, tiny gpg-loopback shim.
- **Phase 2 (this release)** — masked passphrase overlay (`ctx.ui.custom`
  with `•` per keystroke, never the real glyph), persistent `/gpg-config`
  menu (signing key picker, confirm policy, TTL overrides, Touch ID
  gating), per-commit confirm dialog, macOS Touch ID gating via a Swift
  helper compiled on demand.
- **Phase 3** — SSH-signing migration, YubiKey flow, inter-extension events.
- **Phase 4** — hardening, fuzz tests on bash-command detection, signed
  releases (dogfood the dogfood).

## Configuration

Phase 2 adds a persistent config file at:

- `$XDG_CONFIG_HOME/pi-gpg/config.json`, or
- `~/.config/pi-gpg/config.json` when `XDG_CONFIG_HOME` is unset.

All settings are editable via `/gpg-config` — you shouldn't normally hand-
edit the file, but the shape is:

```json
{
  "schema": 1,
  "confirmPolicy": "first-in-session",
  "touchIdGating": false,
  "idleTtlSeconds": 600,
  "maxTtlSeconds": 7200
}
```

**`confirmPolicy`** — when to show a per-commit confirm dialog before
releasing the passphrase:

- `"never"` — never prompt.
- `"first-in-session"` — prompt once per key per session (default).
- `"always"` — prompt every signed commit.

**`touchIdGating`** (macOS only) — when `true`, releasing a *cached*
passphrase requires a successful Touch ID check via `LAContext`. Fresh
passphrase prompts are treated as presence and are not double-gated.
Requires the Xcode Command Line Tools (`xcode-select --install`) so pi-gpg
can compile its tiny Swift helper on first use.

**`idleTtlSeconds` / `maxTtlSeconds`** — override the cache TTLs. When
unset, pi-gpg inherits from `~/.gnupg/gpg-agent.conf` (`default-cache-ttl`,
`max-cache-ttl`) and falls back to gpg's defaults (600s / 7200s).

## Threat model

Short version:

- Passphrase lives only in an extension-process `Buffer` for the configured
  TTL.
- Never written to disk. Never in `argv`. Never in `env`.
- Flows to gpg through an inherited anonymous pipe (fd 3) that our shim hands
  off via `--passphrase-fd 3`.
- Phase 2's masked overlay renders only `•` per keystroke, never the real
  glyph. The captured string is scrubbed and transferred into a `Buffer`
  on submit so zeroing is at least best-effort for the caller.
- On `session_shutdown`, the buffer is zeroed (best-effort) and references
  dropped.
- Touch ID gating (Phase 2, macOS) adds a presence check on cache release
  without ever routing the passphrase through the helper binary — the
  helper only returns a yes/no.
- Users who want hardware-backed signing should run `/gpg-migrate ssh` (Phase 3)
  — routes signing to `ssh-agent` / Secure Enclave and removes GPG from the
  critical path entirely.

## License

MIT © Kenneth Lujan
