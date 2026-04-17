import {
  getOAuthApiKey,
  getOAuthProviders,
  type OAuthCredentials,
  type OAuthProvider,
} from "@mariozechner/pi-ai/oauth";
import { loadConfig } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { coerceSecretRef } from "../../config/types.secrets.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { withFileLock } from "../../infra/file-lock.js";
import {
  formatProviderAuthProfileApiKeyWithPlugin,
  refreshProviderOAuthCredentialWithPlugin,
} from "../../plugins/provider-runtime.runtime.js";
import { resolveSecretRefString, type SecretRefResolveCache } from "../../secrets/resolve.js";
import { normalizeLowercaseStringOrEmpty } from "../../shared/string-coerce.js";
import { refreshChutesTokens } from "../chutes-oauth.js";
import { writeCodexCliCredentials } from "../cli-credentials.js";
import { OAUTH_REFRESH_LOCK_OPTIONS, log } from "./constants.js";
import { resolveTokenExpiryState } from "./credential-state.js";
import { formatAuthDoctorHint } from "./doctor.js";
import {
  areOAuthCredentialsEquivalent,
  readManagedExternalCliCredential,
} from "./external-cli-sync.js";
import { ensureAuthStoreFile, resolveAuthStorePath, resolveOAuthRefreshLockPath } from "./paths.js";
import { assertNoOAuthSecretRefPolicyViolations } from "./policy.js";
import { suggestOAuthProfileIdForLegacyDefault } from "./repair.js";
import {
  ensureAuthProfileStore,
  loadAuthProfileStoreForSecretsRuntime,
  saveAuthProfileStore,
} from "./store.js";
import type { AuthProfileStore, OAuthCredential } from "./types.js";

function listOAuthProviderIds(): string[] {
  if (typeof getOAuthProviders !== "function") {
    return [];
  }
  const providers = getOAuthProviders();
  if (!Array.isArray(providers)) {
    return [];
  }
  return providers
    .map((provider) =>
      provider &&
      typeof provider === "object" &&
      "id" in provider &&
      typeof provider.id === "string"
        ? provider.id
        : undefined,
    )
    .filter((providerId): providerId is string => typeof providerId === "string");
}

const OAUTH_PROVIDER_IDS = new Set<string>(listOAuthProviderIds());

const isOAuthProvider = (provider: string): provider is OAuthProvider =>
  OAUTH_PROVIDER_IDS.has(provider);

const resolveOAuthProvider = (provider: string): OAuthProvider | null =>
  isOAuthProvider(provider) ? provider : null;

/** Bearer-token auth modes that are interchangeable (oauth tokens and raw tokens). */
const BEARER_AUTH_MODES = new Set(["oauth", "token"]);

const isCompatibleModeType = (mode: string | undefined, type: string | undefined): boolean => {
  if (!mode || !type) {
    return false;
  }
  if (mode === type) {
    return true;
  }
  // Both token and oauth represent bearer-token auth paths — allow bidirectional compat.
  return BEARER_AUTH_MODES.has(mode) && BEARER_AUTH_MODES.has(type);
};

function isProfileConfigCompatible(params: {
  cfg?: OpenClawConfig;
  profileId: string;
  provider: string;
  mode: "api_key" | "token" | "oauth";
  allowOAuthTokenCompatibility?: boolean;
}): boolean {
  const profileConfig = params.cfg?.auth?.profiles?.[params.profileId];
  if (profileConfig && profileConfig.provider !== params.provider) {
    return false;
  }
  if (profileConfig && !isCompatibleModeType(profileConfig.mode, params.mode)) {
    return false;
  }
  return true;
}

async function buildOAuthApiKey(provider: string, credentials: OAuthCredential): Promise<string> {
  const formatted = await formatProviderAuthProfileApiKeyWithPlugin({
    provider,
    context: credentials,
  });
  return typeof formatted === "string" && formatted.length > 0 ? formatted : credentials.access;
}

function buildApiKeyProfileResult(params: { apiKey: string; provider: string; email?: string }) {
  return {
    apiKey: params.apiKey,
    provider: params.provider,
    email: params.email,
  };
}

async function buildOAuthProfileResult(params: {
  provider: string;
  credentials: OAuthCredential;
  email?: string;
}) {
  return buildApiKeyProfileResult({
    apiKey: await buildOAuthApiKey(params.provider, params.credentials),
    provider: params.provider,
    email: params.email,
  });
}

function extractErrorMessage(error: unknown): string {
  return formatErrorMessage(error);
}

function isRefreshTokenReusedError(error: unknown): boolean {
  const message = normalizeLowercaseStringOrEmpty(extractErrorMessage(error));
  return (
    message.includes("refresh_token_reused") ||
    message.includes("refresh token has already been used") ||
    message.includes("already been used to generate a new access token")
  );
}

function hasOAuthCredentialChanged(
  previous: Pick<OAuthCredential, "access" | "refresh" | "expires">,
  current: Pick<OAuthCredential, "access" | "refresh" | "expires">,
): boolean {
  return (
    previous.access !== current.access ||
    previous.refresh !== current.refresh ||
    previous.expires !== current.expires
  );
}

async function loadFreshStoredOAuthCredential(params: {
  profileId: string;
  agentDir?: string;
  provider: string;
  previous?: Pick<OAuthCredential, "access" | "refresh" | "expires">;
  requireChange?: boolean;
}): Promise<OAuthCredential | null> {
  const reloadedStore = loadAuthProfileStoreForSecretsRuntime(params.agentDir);
  const reloaded = reloadedStore.profiles[params.profileId];
  if (reloaded?.type !== "oauth" || reloaded.provider !== params.provider) {
    return null;
  }
  if (!Number.isFinite(reloaded.expires) || Date.now() >= reloaded.expires) {
    return null;
  }
  if (
    params.requireChange &&
    params.previous &&
    !hasOAuthCredentialChanged(params.previous, reloaded)
  ) {
    return null;
  }
  return reloaded;
}

type ResolveApiKeyForProfileParams = {
  cfg?: OpenClawConfig;
  store: AuthProfileStore;
  profileId: string;
  agentDir?: string;
};

type SecretDefaults = NonNullable<OpenClawConfig["secrets"]>["defaults"];

function adoptNewerMainOAuthCredential(params: {
  store: AuthProfileStore;
  profileId: string;
  agentDir?: string;
  cred: OAuthCredentials & { type: "oauth"; provider: string; email?: string };
}): (OAuthCredentials & { type: "oauth"; provider: string; email?: string }) | null {
  if (!params.agentDir) {
    return null;
  }
  try {
    const mainStore = ensureAuthProfileStore(undefined);
    const mainCred = mainStore.profiles[params.profileId];
    if (
      mainCred?.type === "oauth" &&
      mainCred.provider === params.cred.provider &&
      Number.isFinite(mainCred.expires) &&
      (!Number.isFinite(params.cred.expires) || mainCred.expires > params.cred.expires)
    ) {
      params.store.profiles[params.profileId] = { ...mainCred };
      saveAuthProfileStore(params.store, params.agentDir);
      log.info("adopted newer OAuth credentials from main agent", {
        profileId: params.profileId,
        agentDir: params.agentDir,
        expires: new Date(mainCred.expires).toISOString(),
      });
      return mainCred;
    }
  } catch (err) {
    // Best-effort: don't crash if main agent store is missing or unreadable.
    log.debug("adoptNewerMainOAuthCredential failed", {
      profileId: params.profileId,
      error: formatErrorMessage(err),
    });
  }
  return null;
}

// In-process serialization: callers for the same profileId are chained so only
// one enters doRefreshOAuthTokenWithLock at a time. Necessary because
// withFileLock is re-entrant within the same PID (HELD_LOCKS short-circuits),
// which would otherwise let two concurrent same-PID callers both pass the file
// lock gate and race to refresh. Keyed by profileId (not agentDir) so agents
// sharing a profile serialize correctly in-process as well as cross-process.
const refreshQueues = new Map<string, Promise<unknown>>();

/**
 * Drop any in-flight entries in the module-level refresh queue. Intended
 * exclusively for tests that exercise the concurrent-refresh surface; a
 * timed-out test can leave pending gates in the map and confuse subsequent
 * tests that share the same Vitest worker.
 */
export function resetOAuthRefreshQueuesForTest(): void {
  refreshQueues.clear();
}

async function refreshOAuthTokenWithLock(params: {
  profileId: string;
  agentDir?: string;
}): Promise<{ apiKey: string; newCredentials: OAuthCredentials } | null> {
  const key = params.profileId;
  const prev = refreshQueues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  refreshQueues.set(key, gate);
  try {
    await prev;
    return await doRefreshOAuthTokenWithLock(params);
  } finally {
    release();
    if (refreshQueues.get(key) === gate) {
      refreshQueues.delete(key);
    }
  }
}

/**
 * Mirror a refreshed OAuth credential back into the main-agent store so peer
 * agents adopt it on their next `adoptNewerMainOAuthCredential` pass instead
 * of racing to refresh the (now-single-used) refresh token.
 *
 * Intentionally best-effort: a failure here must not fail the caller's
 * refresh, since the credential has already been persisted to the agent's own
 * store and returned to the requester.
 */
function mirrorRefreshedCredentialIntoMainStore(params: {
  profileId: string;
  refreshed: OAuthCredential;
}): void {
  try {
    const mainPath = resolveAuthStorePath(undefined);
    ensureAuthStoreFile(mainPath);
    const mainStore = loadAuthProfileStoreForSecretsRuntime(undefined);
    const existing = mainStore.profiles[params.profileId];
    if (existing && existing.type !== "oauth") {
      return;
    }
    if (existing && existing.provider !== params.refreshed.provider) {
      return;
    }
    // Only overwrite when the incoming credential is strictly fresher
    // (or main has no usable expiry). This avoids clobbering a concurrent
    // successful refresh performed by the main agent itself.
    if (
      existing &&
      Number.isFinite(existing.expires) &&
      Number.isFinite(params.refreshed.expires) &&
      existing.expires >= params.refreshed.expires
    ) {
      return;
    }
    mainStore.profiles[params.profileId] = { ...params.refreshed };
    saveAuthProfileStore(mainStore, undefined);
    log.debug("mirrored refreshed OAuth credential to main agent store", {
      profileId: params.profileId,
      expires: Number.isFinite(params.refreshed.expires)
        ? new Date(params.refreshed.expires).toISOString()
        : undefined,
    });
  } catch (err) {
    log.debug("mirrorRefreshedCredentialIntoMainStore failed", {
      profileId: params.profileId,
      error: formatErrorMessage(err),
    });
  }
}

async function doRefreshOAuthTokenWithLock(params: {
  profileId: string;
  agentDir?: string;
}): Promise<{ apiKey: string; newCredentials: OAuthCredentials } | null> {
  const authPath = resolveAuthStorePath(params.agentDir);
  ensureAuthStoreFile(authPath);
  // Cross-agent coordination: every agent that tries to refresh this profile
  // acquires the same global lock file (path derived from sha256(profileId)),
  // so only one performs the actual HTTP refresh at a time. Before this
  // change the file lock was on `authPath`, which is per-agent, and 18
  // Codex agents sharing one OAuth profile would all refresh in parallel
  // and nuke each other with `refresh_token_reused`. See issue #26322.
  const globalRefreshLockPath = resolveOAuthRefreshLockPath(params.profileId);

  const result = await withFileLock(globalRefreshLockPath, OAUTH_REFRESH_LOCK_OPTIONS, async () => {
    // Locked refresh must bypass runtime snapshots so we can adopt fresher
    // on-disk credentials written by another refresh attempt.
    const store = loadAuthProfileStoreForSecretsRuntime(params.agentDir);
    const cred = store.profiles[params.profileId];
    if (!cred || cred.type !== "oauth") {
      return null;
    }

    if (Date.now() < cred.expires) {
      return {
        apiKey: await buildOAuthApiKey(cred.provider, cred),
        newCredentials: cred,
      };
    }

    // Inside-the-lock recheck: a prior agent that already held this lock may
    // have completed a refresh and mirrored its fresh credential into the
    // main store. If so, adopt into the local store and return without
    // issuing another HTTP refresh. This is what turns N serialized
    // refreshes into 1 refresh + (N-1) adoptions, preventing the
    // `refresh_token_reused` storm reported in #26322.
    if (params.agentDir) {
      try {
        const mainStore = loadAuthProfileStoreForSecretsRuntime(undefined);
        const mainCred = mainStore.profiles[params.profileId];
        if (
          mainCred?.type === "oauth" &&
          mainCred.provider === cred.provider &&
          Number.isFinite(mainCred.expires) &&
          Date.now() < mainCred.expires
        ) {
          store.profiles[params.profileId] = { ...mainCred };
          saveAuthProfileStore(store, params.agentDir);
          log.info("adopted fresh OAuth credential from main store (under refresh lock)", {
            profileId: params.profileId,
            agentDir: params.agentDir,
            expires: new Date(mainCred.expires).toISOString(),
          });
          return {
            apiKey: await buildOAuthApiKey(mainCred.provider, mainCred),
            newCredentials: mainCred,
          };
        }
      } catch (err) {
        log.debug("inside-lock main-store adoption failed; proceeding to refresh", {
          profileId: params.profileId,
          error: formatErrorMessage(err),
        });
      }
    }

    const externallyManaged = readManagedExternalCliCredential({
      profileId: params.profileId,
      credential: cred,
    });
    if (externallyManaged) {
      if (!areOAuthCredentialsEquivalent(cred, externallyManaged)) {
        store.profiles[params.profileId] = externallyManaged;
        saveAuthProfileStore(store, params.agentDir);
      }
      if (Date.now() < externallyManaged.expires) {
        return {
          apiKey: await buildOAuthApiKey(externallyManaged.provider, externallyManaged),
          newCredentials: externallyManaged,
        };
      }
      if (externallyManaged.managedBy === "codex-cli") {
        const pluginRefreshed = await refreshProviderOAuthCredentialWithPlugin({
          provider: externallyManaged.provider,
          context: externallyManaged,
        });
        if (pluginRefreshed) {
          const refreshedCredentials: OAuthCredential = {
            ...externallyManaged,
            ...pluginRefreshed,
            type: "oauth",
            managedBy: "codex-cli",
          };
          if (!writeCodexCliCredentials(refreshedCredentials)) {
            log.warn("failed to persist refreshed codex credentials back to Codex storage", {
              profileId: params.profileId,
            });
          }
          store.profiles[params.profileId] = refreshedCredentials;
          saveAuthProfileStore(store, params.agentDir);
          return {
            apiKey: await buildOAuthApiKey(refreshedCredentials.provider, refreshedCredentials),
            newCredentials: refreshedCredentials,
          };
        }
      }
      throw new Error(
        `${externallyManaged.managedBy} credential is expired; refresh it in the external CLI and retry.`,
      );
    }
    if (cred.managedBy) {
      throw new Error(
        `${cred.managedBy} credential is unavailable; re-authenticate in the external CLI and retry.`,
      );
    }

    const pluginRefreshed = await refreshProviderOAuthCredentialWithPlugin({
      provider: cred.provider,
      context: cred,
    });
    if (pluginRefreshed) {
      const refreshedCredentials: OAuthCredential = {
        ...cred,
        ...pluginRefreshed,
        type: "oauth",
      };
      store.profiles[params.profileId] = refreshedCredentials;
      saveAuthProfileStore(store, params.agentDir);
      return {
        apiKey: await buildOAuthApiKey(cred.provider, refreshedCredentials),
        newCredentials: refreshedCredentials,
      };
    }

    const oauthCreds: Record<string, OAuthCredentials> = { [cred.provider]: cred };
    const result =
      cred.provider === "chutes"
        ? await (async () => {
            const newCredentials = await refreshChutesTokens({
              credential: cred,
            });
            return { apiKey: newCredentials.access, newCredentials };
          })()
        : await (async () => {
            const oauthProvider = resolveOAuthProvider(cred.provider);
            if (!oauthProvider) {
              return null;
            }
            if (typeof getOAuthApiKey !== "function") {
              return null;
            }
            return await getOAuthApiKey(oauthProvider, oauthCreds);
          })();
    if (!result) {
      return null;
    }
    store.profiles[params.profileId] = {
      ...cred,
      ...result.newCredentials,
      type: "oauth",
    };
    saveAuthProfileStore(store, params.agentDir);

    return result;
  });

  // Post-lock: mirror the refreshed credential into the main-agent store so
  // peer agents can adopt instead of racing. Only meaningful for secondary
  // agents; for the main agent this would be a self-write (we're already in
  // the main store). Done outside the refresh lock to release it ASAP.
  if (result?.newCredentials && params.agentDir) {
    const mainPath = resolveAuthStorePath(undefined);
    const localPath = resolveAuthStorePath(params.agentDir);
    if (mainPath !== localPath) {
      const localStore = loadAuthProfileStoreForSecretsRuntime(params.agentDir);
      const localProfile = localStore.profiles[params.profileId];
      // Only mirror when the local agent has a concrete OAuth profile that we
      // just refreshed; if the agent was inheriting from main (no local
      // oauth entry) the main store is already the canonical record and no
      // mirror is needed.
      if (localProfile?.type === "oauth") {
        const refreshedCred: OAuthCredential = {
          ...localProfile,
          ...result.newCredentials,
          type: "oauth",
        };
        mirrorRefreshedCredentialIntoMainStore({
          profileId: params.profileId,
          refreshed: refreshedCred,
        });
      }
    }
  }

  return result;
}

async function tryResolveOAuthProfile(
  params: ResolveApiKeyForProfileParams,
): Promise<{ apiKey: string; provider: string; email?: string } | null> {
  const { cfg, store, profileId } = params;
  const cred = store.profiles[profileId];
  if (!cred || cred.type !== "oauth") {
    return null;
  }
  if (
    !isProfileConfigCompatible({
      cfg,
      profileId,
      provider: cred.provider,
      mode: cred.type,
    })
  ) {
    return null;
  }

  if (Date.now() < cred.expires) {
    return await buildOAuthProfileResult({
      provider: cred.provider,
      credentials: cred,
      email: cred.email,
    });
  }

  const refreshed = await refreshOAuthTokenWithLock({
    profileId,
    agentDir: params.agentDir,
  });
  if (!refreshed) {
    return null;
  }
  return buildApiKeyProfileResult({
    apiKey: refreshed.apiKey,
    provider: cred.provider,
    email: cred.email,
  });
}

async function resolveProfileSecretString(params: {
  profileId: string;
  provider: string;
  value: string | undefined;
  valueRef: unknown;
  refDefaults: SecretDefaults | undefined;
  configForRefResolution: OpenClawConfig;
  cache: SecretRefResolveCache;
  inlineFailureMessage: string;
  refFailureMessage: string;
}): Promise<string | undefined> {
  let resolvedValue = params.value?.trim();
  if (resolvedValue) {
    const inlineRef = coerceSecretRef(resolvedValue, params.refDefaults);
    if (inlineRef) {
      try {
        resolvedValue = await resolveSecretRefString(inlineRef, {
          config: params.configForRefResolution,
          env: process.env,
          cache: params.cache,
        });
      } catch (err) {
        log.debug(params.inlineFailureMessage, {
          profileId: params.profileId,
          provider: params.provider,
          error: formatErrorMessage(err),
        });
      }
    }
  }

  const explicitRef = coerceSecretRef(params.valueRef, params.refDefaults);
  if (!resolvedValue && explicitRef) {
    try {
      resolvedValue = await resolveSecretRefString(explicitRef, {
        config: params.configForRefResolution,
        env: process.env,
        cache: params.cache,
      });
    } catch (err) {
      log.debug(params.refFailureMessage, {
        profileId: params.profileId,
        provider: params.provider,
        error: formatErrorMessage(err),
      });
    }
  }

  return resolvedValue;
}

export async function resolveApiKeyForProfile(
  params: ResolveApiKeyForProfileParams,
): Promise<{ apiKey: string; provider: string; email?: string } | null> {
  const { cfg, store, profileId } = params;
  const cred = store.profiles[profileId];
  if (!cred) {
    return null;
  }
  if (
    !isProfileConfigCompatible({
      cfg,
      profileId,
      provider: cred.provider,
      mode: cred.type,
      // Compatibility: treat "oauth" config as compatible with stored token profiles.
      allowOAuthTokenCompatibility: true,
    })
  ) {
    return null;
  }

  const refResolveCache: SecretRefResolveCache = {};
  const configForRefResolution = cfg ?? loadConfig();
  const refDefaults = configForRefResolution.secrets?.defaults;
  assertNoOAuthSecretRefPolicyViolations({
    store,
    cfg: configForRefResolution,
    profileIds: [profileId],
    context: `auth profile ${profileId}`,
  });

  if (cred.type === "api_key") {
    const key = await resolveProfileSecretString({
      profileId,
      provider: cred.provider,
      value: cred.key,
      valueRef: cred.keyRef,
      refDefaults,
      configForRefResolution,
      cache: refResolveCache,
      inlineFailureMessage: "failed to resolve inline auth profile api_key ref",
      refFailureMessage: "failed to resolve auth profile api_key ref",
    });
    if (!key) {
      return null;
    }
    return buildApiKeyProfileResult({ apiKey: key, provider: cred.provider, email: cred.email });
  }
  if (cred.type === "token") {
    const expiryState = resolveTokenExpiryState(cred.expires);
    if (expiryState === "expired" || expiryState === "invalid_expires") {
      return null;
    }
    const token = await resolveProfileSecretString({
      profileId,
      provider: cred.provider,
      value: cred.token,
      valueRef: cred.tokenRef,
      refDefaults,
      configForRefResolution,
      cache: refResolveCache,
      inlineFailureMessage: "failed to resolve inline auth profile token ref",
      refFailureMessage: "failed to resolve auth profile token ref",
    });
    if (!token) {
      return null;
    }
    return buildApiKeyProfileResult({ apiKey: token, provider: cred.provider, email: cred.email });
  }

  const oauthCred =
    adoptNewerMainOAuthCredential({
      store,
      profileId,
      agentDir: params.agentDir,
      cred,
    }) ?? cred;

  if (Date.now() < oauthCred.expires) {
    return await buildOAuthProfileResult({
      provider: oauthCred.provider,
      credentials: oauthCred,
      email: oauthCred.email,
    });
  }

  try {
    const result = await refreshOAuthTokenWithLock({
      profileId,
      agentDir: params.agentDir,
    });
    if (!result) {
      return null;
    }
    return buildApiKeyProfileResult({
      apiKey: result.apiKey,
      provider: cred.provider,
      email: cred.email,
    });
  } catch (error) {
    const refreshedStore = loadAuthProfileStoreForSecretsRuntime(params.agentDir);
    const refreshed = refreshedStore.profiles[profileId];
    if (refreshed?.type === "oauth" && Date.now() < refreshed.expires) {
      return await buildOAuthProfileResult({
        provider: refreshed.provider,
        credentials: refreshed,
        email: refreshed.email ?? cred.email,
      });
    }
    if (
      isRefreshTokenReusedError(error) &&
      refreshed?.type === "oauth" &&
      refreshed.provider === cred.provider &&
      hasOAuthCredentialChanged(cred, refreshed)
    ) {
      const recovered = await loadFreshStoredOAuthCredential({
        profileId,
        agentDir: params.agentDir,
        provider: cred.provider,
        previous: cred,
        requireChange: true,
      });
      if (recovered) {
        return await buildOAuthProfileResult({
          provider: recovered.provider,
          credentials: recovered,
          email: recovered.email ?? cred.email,
        });
      }
      const retried = await refreshOAuthTokenWithLock({
        profileId,
        agentDir: params.agentDir,
      });
      if (retried) {
        return buildApiKeyProfileResult({
          apiKey: retried.apiKey,
          provider: cred.provider,
          email: cred.email,
        });
      }
    }
    const fallbackProfileId = suggestOAuthProfileIdForLegacyDefault({
      cfg,
      store: refreshedStore,
      provider: cred.provider,
      legacyProfileId: profileId,
    });
    if (fallbackProfileId && fallbackProfileId !== profileId) {
      try {
        const fallbackResolved = await tryResolveOAuthProfile({
          cfg,
          store: refreshedStore,
          profileId: fallbackProfileId,
          agentDir: params.agentDir,
        });
        if (fallbackResolved) {
          return fallbackResolved;
        }
      } catch {
        // keep original error
      }
    }

    // Fallback: if this is a secondary agent, try using the main agent's credentials
    if (params.agentDir) {
      try {
        const mainStore = ensureAuthProfileStore(undefined); // main agent (no agentDir)
        const mainCred = mainStore.profiles[profileId];
        if (mainCred?.type === "oauth" && Date.now() < mainCred.expires) {
          // Main agent has fresh credentials - copy them to this agent and use them
          refreshedStore.profiles[profileId] = { ...mainCred };
          saveAuthProfileStore(refreshedStore, params.agentDir);
          log.info("inherited fresh OAuth credentials from main agent", {
            profileId,
            agentDir: params.agentDir,
            expires: new Date(mainCred.expires).toISOString(),
          });
          return await buildOAuthProfileResult({
            provider: mainCred.provider,
            credentials: mainCred,
            email: mainCred.email,
          });
        }
      } catch {
        // keep original error if main agent fallback also fails
      }
    }

    const message = extractErrorMessage(error);
    const hint = await formatAuthDoctorHint({
      cfg,
      store: refreshedStore,
      provider: cred.provider,
      profileId,
    });
    throw new Error(
      `OAuth token refresh failed for ${cred.provider}: ${message}. ` +
        "Please try again or re-authenticate." +
        (hint ? `\n\n${hint}` : ""),
      { cause: error },
    );
  }
}
