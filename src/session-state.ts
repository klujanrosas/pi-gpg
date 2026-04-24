/**
 * Per-session runtime state held in the extension closure.
 *
 * Lives for one Pi session. Rebuilt on `session_start`, torn down in
 * `session_shutdown`.
 */

import type { PassphraseCache } from "./cache.js";
import type { ConfigStore, PiGpgConfig } from "./config.js";
import type { ConfirmedKeySet } from "./confirm.js";
import type { PassfileRegistry } from "./passfile.js";

export interface SessionState {
	shimPath: string;
	shimReady: boolean;
	cache: PassphraseCache;
	passfiles: PassfileRegistry;
	realGpgPath?: string;
	/**
	 * Map of toolCallId -> cleanup fn for bash interceptions that allocated a
	 * passfile. Drained on `tool_result` and `session_shutdown`.
	 */
	pendingCleanups: Map<string, () => Promise<void>>;
	/**
	 * Whether the doctor's check at session_start reported a signing-capable
	 * environment (i.e. gpg present, at least one secret key). Used to short
	 * circuit bash interception when pi-gpg can't possibly help.
	 */
	canSign: boolean;
	/**
	 * Tears down the `cache.onChange` subscription that drives the toolbar
	 * status. Set by `session_start` once the subscription is wired up and
	 * invoked in `session_shutdown` before disposing the cache.
	 */
	unsubscribeCacheStatus?: () => void;
	/**
	 * Live pi-gpg config (confirm policy, Touch ID toggle, TTL overrides).
	 * Mutated in place when the user changes settings via `/gpg-config`.
	 */
	config: PiGpgConfig;
	/** Backing store for `config` — persists edits to disk. */
	configStore: ConfigStore;
	/**
	 * Keys for which the user has already OK'd signing this session under the
	 * `first-in-session` confirm policy. Cleared on session_shutdown.
	 */
	confirmedKeys: ConfirmedKeySet;
}

export function makeSessionState(args: {
	shimPath: string;
	shimReady: boolean;
	cache: PassphraseCache;
	passfiles: PassfileRegistry;
	realGpgPath?: string;
	canSign: boolean;
	config: PiGpgConfig;
	configStore: ConfigStore;
}): SessionState {
	const state: SessionState = {
		shimPath: args.shimPath,
		shimReady: args.shimReady,
		cache: args.cache,
		passfiles: args.passfiles,
		pendingCleanups: new Map(),
		canSign: args.canSign,
		config: args.config,
		configStore: args.configStore,
		confirmedKeys: new Set(),
	};
	if (args.realGpgPath) state.realGpgPath = args.realGpgPath;
	return state;
}
