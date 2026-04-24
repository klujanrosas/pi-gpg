# Changelog

All notable changes to `pi-gpg` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
