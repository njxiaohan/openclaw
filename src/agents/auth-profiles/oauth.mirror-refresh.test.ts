import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetFileLockStateForTest } from "../../infra/file-lock.js";
import { captureEnv } from "../../test-utils/env.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  ensureAuthProfileStore,
  saveAuthProfileStore,
} from "./store.js";
import type { AuthProfileStore, OAuthCredential } from "./types.js";

let resolveApiKeyForProfile: typeof import("./oauth.js").resolveApiKeyForProfile;
let resetOAuthRefreshQueuesForTest: typeof import("./oauth.js").resetOAuthRefreshQueuesForTest;

async function loadOAuthModuleForTest() {
  ({ resolveApiKeyForProfile, resetOAuthRefreshQueuesForTest } = await import("./oauth.js"));
}

const {
  refreshProviderOAuthCredentialWithPluginMock,
  formatProviderAuthProfileApiKeyWithPluginMock,
} = vi.hoisted(() => ({
  refreshProviderOAuthCredentialWithPluginMock: vi.fn(
    async (_params?: { context?: unknown }) => undefined,
  ),
  formatProviderAuthProfileApiKeyWithPluginMock: vi.fn(() => undefined),
}));

vi.mock("../cli-credentials.js", () => ({
  readCodexCliCredentialsCached: () => null,
  readMiniMaxCliCredentialsCached: () => null,
  resetCliCredentialCachesForTest: () => undefined,
  writeCodexCliCredentials: () => true,
}));

vi.mock("../../plugins/provider-runtime.runtime.js", () => ({
  formatProviderAuthProfileApiKeyWithPlugin: (params: { context?: { access?: string } }) =>
    formatProviderAuthProfileApiKeyWithPluginMock() ?? params?.context?.access,
  refreshProviderOAuthCredentialWithPlugin: refreshProviderOAuthCredentialWithPluginMock,
}));

vi.mock("./doctor.js", () => ({
  formatAuthDoctorHint: async () => undefined,
}));

vi.mock("./external-cli-sync.js", () => ({
  syncExternalCliCredentials: () => false,
  readManagedExternalCliCredential: () => null,
  areOAuthCredentialsEquivalent: (a: unknown, b: unknown) => a === b,
}));

function createExpiredOauthStore(params: {
  profileId: string;
  provider: string;
  access?: string;
  refresh?: string;
  accountId?: string;
  email?: string;
}): AuthProfileStore {
  return {
    version: 1,
    profiles: {
      [params.profileId]: {
        type: "oauth",
        provider: params.provider,
        access: params.access ?? "cached-access-token",
        refresh: params.refresh ?? "refresh-token",
        expires: Date.now() - 60_000,
        accountId: params.accountId,
        email: params.email,
      } satisfies OAuthCredential,
    },
  };
}

describe("resolveApiKeyForProfile OAuth refresh mirror-to-main (#26322)", () => {
  const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
  let tempRoot = "";
  let mainAgentDir = "";

  beforeEach(async () => {
    resetFileLockStateForTest();
    refreshProviderOAuthCredentialWithPluginMock.mockReset();
    refreshProviderOAuthCredentialWithPluginMock.mockResolvedValue(undefined);
    formatProviderAuthProfileApiKeyWithPluginMock.mockReset();
    formatProviderAuthProfileApiKeyWithPluginMock.mockReturnValue(undefined);
    clearRuntimeAuthProfileStoreSnapshots();
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-oauth-mirror-"));
    process.env.OPENCLAW_STATE_DIR = tempRoot;
    mainAgentDir = path.join(tempRoot, "agents", "main", "agent");
    await fs.mkdir(mainAgentDir, { recursive: true });
    await loadOAuthModuleForTest();
    resetOAuthRefreshQueuesForTest();
  });

  afterEach(async () => {
    envSnapshot.restore();
    resetFileLockStateForTest();
    clearRuntimeAuthProfileStoreSnapshots();
    if (resetOAuthRefreshQueuesForTest) {
      resetOAuthRefreshQueuesForTest();
    }
    if (tempRoot) {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("mirrors refreshed credentials into the main store so peers skip refresh", async () => {
    const profileId = "openai-codex:default";
    const provider = "openai-codex";
    const accountId = "acct-shared";
    const freshExpiry = Date.now() + 60 * 60 * 1000;

    const subAgentDir = path.join(tempRoot, "agents", "sub-mirror", "agent");
    await fs.mkdir(subAgentDir, { recursive: true });
    saveAuthProfileStore(createExpiredOauthStore({ profileId, provider, accountId }), subAgentDir);
    saveAuthProfileStore(createExpiredOauthStore({ profileId, provider, accountId }), mainAgentDir);

    refreshProviderOAuthCredentialWithPluginMock.mockImplementationOnce(
      async () =>
        ({
          type: "oauth",
          provider,
          access: "sub-refreshed-access",
          refresh: "sub-refreshed-refresh",
          expires: freshExpiry,
          accountId,
        }) as never,
    );

    const result = await resolveApiKeyForProfile({
      store: ensureAuthProfileStore(subAgentDir),
      profileId,
      agentDir: subAgentDir,
    });

    expect(result?.apiKey).toBe("sub-refreshed-access");

    // Main store should now carry the refreshed credential, so a peer agent
    // starting fresh will adopt rather than race.
    const mainRaw = JSON.parse(
      await fs.readFile(path.join(mainAgentDir, "auth-profiles.json"), "utf8"),
    ) as AuthProfileStore;
    expect(mainRaw.profiles[profileId]).toMatchObject({
      access: "sub-refreshed-access",
      refresh: "sub-refreshed-refresh",
      expires: freshExpiry,
    });
  });

  it("does not mirror when refresh was performed from the main agent itself", async () => {
    const profileId = "openai-codex:default";
    const provider = "openai-codex";
    const freshExpiry = Date.now() + 60 * 60 * 1000;

    saveAuthProfileStore(
      createExpiredOauthStore({ profileId, provider, access: "main-stale-access" }),
      mainAgentDir,
    );

    refreshProviderOAuthCredentialWithPluginMock.mockImplementationOnce(
      async () =>
        ({
          type: "oauth",
          provider,
          access: "main-refreshed-access",
          refresh: "main-refreshed-refresh",
          expires: freshExpiry,
        }) as never,
    );

    // Main-agent refresh uses undefined agentDir; the mirror path is a no-op
    // (local == main). Just make sure the main store still reflects the refresh
    // and no double-write happens.
    const result = await resolveApiKeyForProfile({
      store: ensureAuthProfileStore(undefined),
      profileId,
      agentDir: undefined,
    });

    expect(result?.apiKey).toBe("main-refreshed-access");
    const mainRaw = JSON.parse(
      await fs.readFile(path.join(mainAgentDir, "auth-profiles.json"), "utf8"),
    ) as AuthProfileStore;
    expect(mainRaw.profiles[profileId]).toMatchObject({
      access: "main-refreshed-access",
      refresh: "main-refreshed-refresh",
      expires: freshExpiry,
    });
    expect(refreshProviderOAuthCredentialWithPluginMock).toHaveBeenCalledTimes(1);
  });

  it("refuses to mirror when main has a non-oauth entry for the same profileId", async () => {
    // Exercises the `existing.type !== "oauth"` early-return in the mirror
    // updater. If the operator has manually switched the main profile to
    // an api_key, a secondary-agent's OAuth refresh must not clobber it.
    const profileId = "openai-codex:default";
    const provider = "openai-codex";
    const freshExpiry = Date.now() + 60 * 60 * 1000;

    const subAgentDir = path.join(tempRoot, "agents", "sub-non-oauth", "agent");
    await fs.mkdir(subAgentDir, { recursive: true });
    saveAuthProfileStore(createExpiredOauthStore({ profileId, provider }), subAgentDir);
    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          [profileId]: {
            type: "api_key",
            provider,
            key: "operator-key",
          },
        },
      },
      mainAgentDir,
    );

    refreshProviderOAuthCredentialWithPluginMock.mockImplementationOnce(
      async () =>
        ({
          type: "oauth",
          provider,
          access: "sub-refreshed-access",
          refresh: "sub-refreshed-refresh",
          expires: freshExpiry,
        }) as never,
    );

    const result = await resolveApiKeyForProfile({
      store: ensureAuthProfileStore(subAgentDir),
      profileId,
      agentDir: subAgentDir,
    });
    expect(result?.apiKey).toBe("sub-refreshed-access");

    // Main must still hold the operator's api_key, untouched.
    const mainRaw = JSON.parse(
      await fs.readFile(path.join(mainAgentDir, "auth-profiles.json"), "utf8"),
    ) as AuthProfileStore;
    expect(mainRaw.profiles[profileId]).toMatchObject({
      type: "api_key",
      key: "operator-key",
    });
  });

  it("refuses to mirror when identity (accountId) mismatches", async () => {
    // Exercises the CWE-284 identity gate: main carries acct-other, sub-agent
    // refreshes as acct-mine — mirror must be refused.
    const profileId = "openai-codex:default";
    const provider = "openai-codex";
    const freshExpiry = Date.now() + 60 * 60 * 1000;

    const subAgentDir = path.join(tempRoot, "agents", "sub-bad-identity", "agent");
    await fs.mkdir(subAgentDir, { recursive: true });
    saveAuthProfileStore(
      createExpiredOauthStore({
        profileId,
        provider,
        access: "sub-stale",
        accountId: "acct-mine",
      }),
      subAgentDir,
    );
    // Main has a different account for the same profileId — this is the
    // cross-account-leak scenario that the gate must block.
    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          [profileId]: {
            type: "oauth",
            provider,
            access: "main-other-access",
            refresh: "main-other-refresh",
            expires: Date.now() - 60_000,
            accountId: "acct-other",
          },
        },
      },
      mainAgentDir,
    );

    refreshProviderOAuthCredentialWithPluginMock.mockImplementationOnce(
      async () =>
        ({
          type: "oauth",
          provider,
          access: "sub-refreshed-access",
          refresh: "sub-refreshed-refresh",
          expires: freshExpiry,
          accountId: "acct-mine",
        }) as never,
    );

    const result = await resolveApiKeyForProfile({
      store: ensureAuthProfileStore(subAgentDir),
      profileId,
      agentDir: subAgentDir,
    });
    // Sub-agent gets its fresh token as usual.
    expect(result?.apiKey).toBe("sub-refreshed-access");

    // But main store must still hold acct-other's credential unchanged.
    const mainRaw = JSON.parse(
      await fs.readFile(path.join(mainAgentDir, "auth-profiles.json"), "utf8"),
    ) as AuthProfileStore;
    expect(mainRaw.profiles[profileId]).toMatchObject({
      access: "main-other-access",
      accountId: "acct-other",
    });
  });

  it("refuses to mirror when main already has a strictly-fresher credential", async () => {
    // Exercises the `existing.expires >= refreshed.expires` early-return.
    // Scenario: main already completed a refresh (with a later expiry) while
    // the sub-agent's refresh was in-flight; our mirror must not regress it.
    const profileId = "openai-codex:default";
    const provider = "openai-codex";
    const subFreshExpiry = Date.now() + 30 * 60 * 1000;
    const mainFresherExpiry = Date.now() + 90 * 60 * 1000;

    const subAgentDir = path.join(tempRoot, "agents", "sub-older", "agent");
    await fs.mkdir(subAgentDir, { recursive: true });
    saveAuthProfileStore(
      createExpiredOauthStore({ profileId, provider, accountId: "acct-shared" }),
      subAgentDir,
    );
    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          [profileId]: {
            type: "oauth",
            provider,
            access: "main-already-fresh",
            refresh: "main-already-fresh-refresh",
            expires: mainFresherExpiry,
            accountId: "acct-shared",
          },
        },
      },
      mainAgentDir,
    );

    refreshProviderOAuthCredentialWithPluginMock.mockImplementationOnce(
      async () =>
        ({
          type: "oauth",
          provider,
          access: "sub-refreshed-older",
          refresh: "sub-refreshed-older-refresh",
          expires: subFreshExpiry,
          accountId: "acct-shared",
        }) as never,
    );

    // The sub-agent will actually adopt main's fresher creds via the inside-
    // lock recheck (that's the whole point of #26322), so refresh may not
    // even fire. We only care that the main store is not regressed.
    await resolveApiKeyForProfile({
      store: ensureAuthProfileStore(subAgentDir),
      profileId,
      agentDir: subAgentDir,
    });

    const mainRaw = JSON.parse(
      await fs.readFile(path.join(mainAgentDir, "auth-profiles.json"), "utf8"),
    ) as AuthProfileStore;
    expect(mainRaw.profiles[profileId]).toMatchObject({
      access: "main-already-fresh",
      expires: mainFresherExpiry,
    });
  });

  it("mirrors refreshed credentials produced by the plugin-refresh path", async () => {
    // The plugin-refreshed branch in doRefreshOAuthTokenWithLock has its own
    // mirror call; cover it separately so the branch is not orphaned.
    const profileId = "anthropic:plugin";
    const provider = "anthropic";
    const accountId = "acct-plugin";
    const freshExpiry = Date.now() + 60 * 60 * 1000;

    const subAgentDir = path.join(tempRoot, "agents", "sub-plugin", "agent");
    await fs.mkdir(subAgentDir, { recursive: true });
    saveAuthProfileStore(createExpiredOauthStore({ profileId, provider, accountId }), subAgentDir);
    saveAuthProfileStore(createExpiredOauthStore({ profileId, provider, accountId }), mainAgentDir);

    // Plugin returns a truthy refreshed credential — this takes the plugin
    // branch instead of falling through to getOAuthApiKey.
    refreshProviderOAuthCredentialWithPluginMock.mockImplementationOnce(
      async () =>
        ({
          access: "plugin-refreshed-access",
          refresh: "plugin-refreshed-refresh",
          expires: freshExpiry,
        }) as never,
    );

    const result = await resolveApiKeyForProfile({
      store: ensureAuthProfileStore(subAgentDir),
      profileId,
      agentDir: subAgentDir,
    });
    expect(result?.apiKey).toBe("plugin-refreshed-access");

    // Main store must have been mirrored from the plugin-refresh branch.
    const mainRaw = JSON.parse(
      await fs.readFile(path.join(mainAgentDir, "auth-profiles.json"), "utf8"),
    ) as AuthProfileStore;
    expect(mainRaw.profiles[profileId]).toMatchObject({
      access: "plugin-refreshed-access",
      refresh: "plugin-refreshed-refresh",
      expires: freshExpiry,
    });
  });
});
