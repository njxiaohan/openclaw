import type { TtsProvider } from "../config/types.tts.js";
import type { MediaUnderstandingCapability } from "../media-understanding/types.js";
import { EXTENSION_HOST_REMOTE_EMBEDDING_PROVIDER_IDS } from "./embedding-runtime-registry.js";
import type { EmbeddingProviderId } from "./embedding-runtime-types.js";
import {
  buildExtensionHostMediaUnderstandingRegistry,
  normalizeExtensionHostMediaProviderId,
} from "./media-runtime-registry.js";
import { listExtensionHostTtsRuntimeProviders } from "./tts-runtime-registry.js";

export const EXTENSION_HOST_RUNTIME_BACKEND_FAMILY = "capability.runtime-backend";

export type ExtensionHostRuntimeBackendFamily = typeof EXTENSION_HOST_RUNTIME_BACKEND_FAMILY;

export type ExtensionHostRuntimeBackendSubsystemId =
  | "embedding"
  | "media.audio"
  | "media.image"
  | "media.video"
  | "tts";

export type ExtensionHostRuntimeBackendCatalogEntry = {
  id: string;
  family: ExtensionHostRuntimeBackendFamily;
  subsystemId: ExtensionHostRuntimeBackendSubsystemId;
  backendId: string;
  source: "builtin";
  defaultRank: number;
  selectorKeys: readonly string[];
  capabilities: readonly string[];
  metadata?: Record<string, unknown>;
};

const EXTENSION_HOST_EMBEDDING_BACKEND_IDS = [
  "local",
  ...EXTENSION_HOST_REMOTE_EMBEDDING_PROVIDER_IDS,
  "ollama",
] as const satisfies readonly EmbeddingProviderId[];

function buildRuntimeBackendCatalogId(
  subsystemId: ExtensionHostRuntimeBackendSubsystemId,
  backendId: string,
): string {
  return `${EXTENSION_HOST_RUNTIME_BACKEND_FAMILY}:${subsystemId}:${backendId}`;
}

function mapMediaCapabilityToSubsystem(
  capability: MediaUnderstandingCapability,
): ExtensionHostRuntimeBackendSubsystemId {
  if (capability === "audio") {
    return "media.audio";
  }
  if (capability === "video") {
    return "media.video";
  }
  return "media.image";
}

function buildMediaSelectorKeys(providerId: string): readonly string[] {
  const normalized = normalizeExtensionHostMediaProviderId(providerId);
  if (normalized === "google") {
    return [providerId, "gemini"];
  }
  return normalized === providerId ? [providerId] : [providerId, normalized];
}

export function listExtensionHostEmbeddingRuntimeBackendCatalogEntries(): readonly ExtensionHostRuntimeBackendCatalogEntry[] {
  return EXTENSION_HOST_EMBEDDING_BACKEND_IDS.map((backendId, defaultRank) => ({
    id: buildRuntimeBackendCatalogId("embedding", backendId),
    family: EXTENSION_HOST_RUNTIME_BACKEND_FAMILY,
    subsystemId: "embedding",
    backendId,
    source: "builtin",
    defaultRank,
    selectorKeys: [backendId],
    capabilities: ["embed.query", "embed.batch"],
    metadata: {
      autoSelectable:
        backendId === "local" || EXTENSION_HOST_REMOTE_EMBEDDING_PROVIDER_IDS.includes(backendId),
    },
  }));
}

export function listExtensionHostMediaRuntimeBackendCatalogEntries(): readonly ExtensionHostRuntimeBackendCatalogEntry[] {
  const registry = buildExtensionHostMediaUnderstandingRegistry();
  const entries: ExtensionHostRuntimeBackendCatalogEntry[] = [];
  let defaultRank = 0;
  for (const provider of registry.values()) {
    for (const capability of provider.capabilities ?? []) {
      const subsystemId = mapMediaCapabilityToSubsystem(capability);
      entries.push({
        id: buildRuntimeBackendCatalogId(subsystemId, provider.id),
        family: EXTENSION_HOST_RUNTIME_BACKEND_FAMILY,
        subsystemId,
        backendId: provider.id,
        source: "builtin",
        defaultRank,
        selectorKeys: buildMediaSelectorKeys(provider.id),
        capabilities: [capability],
      });
    }
    defaultRank += 1;
  }
  return entries;
}

export function listExtensionHostTtsRuntimeBackendCatalogEntries(): readonly ExtensionHostRuntimeBackendCatalogEntry[] {
  return listExtensionHostTtsRuntimeProviders().map((provider, defaultRank) => ({
    id: buildRuntimeBackendCatalogId("tts", provider.id),
    family: EXTENSION_HOST_RUNTIME_BACKEND_FAMILY,
    subsystemId: "tts",
    backendId: provider.id,
    source: "builtin",
    defaultRank,
    selectorKeys: [provider.id],
    capabilities: provider.supportsTelephony
      ? ["tts.synthesis", "tts.telephony"]
      : ["tts.synthesis"],
    metadata: {
      supportsTelephony: provider.supportsTelephony,
    },
  }));
}

export function listExtensionHostTtsRuntimeBackendIds(): readonly TtsProvider[] {
  return listExtensionHostTtsRuntimeBackendCatalogEntries().map(
    (entry) => entry.backendId as TtsProvider,
  );
}

export function listExtensionHostRuntimeBackendCatalogEntries(): readonly ExtensionHostRuntimeBackendCatalogEntry[] {
  return [
    ...listExtensionHostEmbeddingRuntimeBackendCatalogEntries(),
    ...listExtensionHostMediaRuntimeBackendCatalogEntries(),
    ...listExtensionHostTtsRuntimeBackendCatalogEntries(),
  ];
}

export function getExtensionHostRuntimeBackendCatalogEntry(params: {
  subsystemId: ExtensionHostRuntimeBackendSubsystemId;
  backendId: string;
}): ExtensionHostRuntimeBackendCatalogEntry | undefined {
  return listExtensionHostRuntimeBackendCatalogEntries().find(
    (entry) => entry.subsystemId === params.subsystemId && entry.backendId === params.backendId,
  );
}
