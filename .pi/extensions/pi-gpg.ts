/**
 * Project-local auto-discovery shim.
 *
 * Running `pi` inside this repo picks this file up from `.pi/extensions/`.
 * It just re-exports the real extension so development dogfoods against
 * `src/index.ts` directly — no build step, no stale copies.
 */

export { default } from "../../src/index.js";
