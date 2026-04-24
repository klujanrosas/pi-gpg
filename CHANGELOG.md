# Changelog

All notable changes to `pi-gpg` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Phase 2 — polish and policy

**Added**
- Masked passphrase overlay via `ctx.ui.custom({ overlay: true })`. Renders
  a bordered dialog with a single-line field showing `•` per entered
  code unit — the real glyph never reaches the terminal. Backspace,
  forward-delete, Home/End/Ctrl+A/Ctrl+E, Ctrl+U, arrow navigation, and
  bracketed paste are all supported. No kill-ring / undo-stack by design
  (those would retain passphrase bytes past the dialog lifetime).
- Fallback to the Phase 1 `ctx.ui.input()` path when `ctx.ui.custom` isn't
  available (RPC / print transports, thin test stubs).
- `/gpg-config` command — interactive menu to pick the signing key, change
  the confirm policy, toggle Touch ID gating (macOS), and override the
  cache TTLs. Settings persist to `$XDG_CONFIG_HOME/pi-gpg/config.json`
  (or `~/.config/pi-gpg/config.json`) with a versioned schema, atomic
  writes, and 0600 mode.
- Per-commit confirm policy with three modes: `always`, `never`,
  `first-in-session` (default). Applied to both the `git_commit` tool path
  and the bash interception path through a shared `runSignGate` helper.
- macOS Touch ID gating. When enabled, releasing a cached passphrase
  requires a successful biometric check via `LAContext`. Ships
  `shim/touchid.swift` which pi-gpg compiles on first use with `swiftc`
  into `~/.cache/pi-gpg/touchid/pi-gpg-touchid` (0700 dir, 0700 bin).
  Source hash keys the build so package upgrades refresh it automatically.
  Fresh passphrase prompts are treated as presence and are not re-gated.
- `/gpg-status` now also shows the effective pi-gpg config block.
- Signing key picker in `/gpg-config` writes to `git config --global
  user.signingkey` after an explicit confirm.
- Fail-closed behavior when a policy (Touch ID, confirm) can't run in the
  current context — we never silently bypass a check the user opted into.

**Security**
- Masked overlay never emits the real passphrase to the terminal. The
  captured string is transferred into a `Buffer` on submit and the string
  reference is overwritten (best-effort, subject to V8 interning).
- Touch ID helper is process-isolated and returns only an exit code — the
  passphrase never crosses the helper boundary.
- Config file writes go through a 0600 tempfile + rename, and the parent
  directory is created at 0700 so a widened umask can't expose it.

### Phase 1 — signing works

**Added**
- `git_commit` tool: first-class Pi tool for signed commits using the fd-3
  passphrase flow (no disk exposure, no TTY involvement, no pinentry).
- Bash interception: `tool_call` hook detects signing-capable git commands
  (`commit`, `tag`, `merge`, `rebase`, `cherry-pick`, `revert`, `am`),
  transparently rewrites them to route GPG through `shim/gpg-loopback.sh`
  with a mode-0600 temp passphrase file, and notifies via `ctx.ui.notify`
  (per project convention (c): rewrite silently but surface).
- Detects **implicit** signing via `commit.gpgsign=true` / `tag.gpgsign=true`,
  not just explicit `-S` flags.
- Passphrase cache with gpg-agent-matching defaults (idle 600s, hard-cap 7200s).
  Honors `default-cache-ttl` / `max-cache-ttl` from `~/.gnupg/gpg-agent.conf`
  when present. Buffers are zeroized on eviction and on `session_shutdown`.
- `/gpg-status`: cache state, TTLs, per-key remaining lifetime.
- `/gpg-unlock`: prompt-to-cache.
- `/gpg-lock`: immediate zero-and-clear.
- Status widget in the Pi footer showing lock state and key count.
- Integration test suite: spawns real gpg + real git, generates a throwaway
  signing key in an ephemeral `GNUPGHOME`, signs a commit through the fd-3
  path, and verifies `git cat-file -p HEAD` contains a valid `gpgsig` header
  and `git verify-commit` reports `Good signature`.

**Security**
- fd-3 path (`git_commit` tool): passphrase flows through an inherited anonymous
  pipe — never on disk, never in argv, never in env.
- bash-interception path: passphrase lives in a mode-0600 file inside a
  mode-0700 temp directory for the duration of the bash tool call; cleanup
  runs on `tool_result` and (defensively) on `session_shutdown`.
- SSH signing backend (`gpg.format = ssh`) is detected and left alone — pi-gpg
  is not in the critical path for users on that setup.

## [0.1.0] — Phase 0

- Initial scaffold.
- `/gpg-doctor` command: inspects GPG version, installed pinentries,
  `gpg-agent.conf`, git signing configuration (global + repo), and available
  secret keys.
- Distributable as: local path, `pi install`, git, npm, ad-hoc `pi -e`.
