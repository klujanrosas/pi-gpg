#!/bin/sh
# pi-gpg gpg loopback shim — DO NOT EDIT BY HAND.
#
# Injected via `git -c gpg.program=<this>` by the pi-gpg Pi extension so GPG
# never spawns pinentry and the TTY stays clean for the AI agent.
#
# Three modes:
#   A) fd-3 inherited pipe (git_commit tool path — no disk exposure)
#   B) PI_GPG_PASSFILE pointing at a mode-0600 temp file (bash-interception path)
#   C) passthrough (no pi-gpg context — behaves like plain gpg)
#
# In all modes we exec into gpg, so caller sees gpg's exit code unchanged.

set -eu

REAL_GPG="${PI_GPG_REAL_GPG:-gpg}"

if [ -n "${PI_GPG_USE_FD3:-}" ]; then
	exec "$REAL_GPG" --pinentry-mode loopback --passphrase-fd 3 --batch --no-tty "$@"
fi

if [ -n "${PI_GPG_PASSFILE:-}" ] && [ -r "${PI_GPG_PASSFILE:-}" ]; then
	exec "$REAL_GPG" --pinentry-mode loopback --passphrase-file "$PI_GPG_PASSFILE" --batch --no-tty "$@"
fi

exec "$REAL_GPG" "$@"
