import { createHash } from "node:crypto";
import path from "node:path";
import { resolveStateDir } from "../../config/paths.js";
import { resolveUserPath } from "../../utils.js";
import { resolveOpenClawAgentDir } from "../agent-paths.js";
import {
  AUTH_PROFILE_FILENAME,
  AUTH_STATE_FILENAME,
  LEGACY_AUTH_FILENAME,
} from "./path-constants.js";

export function resolveAuthStorePath(agentDir?: string): string {
  const resolved = resolveUserPath(agentDir ?? resolveOpenClawAgentDir());
  return path.join(resolved, AUTH_PROFILE_FILENAME);
}

export function resolveLegacyAuthStorePath(agentDir?: string): string {
  const resolved = resolveUserPath(agentDir ?? resolveOpenClawAgentDir());
  return path.join(resolved, LEGACY_AUTH_FILENAME);
}

export function resolveAuthStatePath(agentDir?: string): string {
  const resolved = resolveUserPath(agentDir ?? resolveOpenClawAgentDir());
  return path.join(resolved, AUTH_STATE_FILENAME);
}

export function resolveAuthStorePathForDisplay(agentDir?: string): string {
  const pathname = resolveAuthStorePath(agentDir);
  return pathname.startsWith("~") ? pathname : resolveUserPath(pathname);
}

export function resolveAuthStatePathForDisplay(agentDir?: string): string {
  const pathname = resolveAuthStatePath(agentDir);
  return pathname.startsWith("~") ? pathname : resolveUserPath(pathname);
}

/**
 * Resolve the path of the cross-agent, per-profile OAuth refresh coordination
 * lock. The filename hashes the full profileId so it is filesystem-safe for
 * arbitrary unicode/control-character inputs and always bounded in length.
 *
 * This lock is the serialization point that prevents the `refresh_token_reused`
 * storm when N agents share one OAuth profile (see issue #26322): every agent
 * that attempts a refresh acquires this same file lock, so only one HTTP
 * refresh is in-flight at a time and peers can adopt the resulting fresh
 * credentials instead of racing against a single-use refresh token.
 */
export function resolveOAuthRefreshLockPath(profileId: string): string {
  const safeId = `sha256-${createHash("sha256").update(profileId, "utf8").digest("hex")}`;
  return path.join(resolveStateDir(), "locks", "oauth-refresh", safeId);
}
