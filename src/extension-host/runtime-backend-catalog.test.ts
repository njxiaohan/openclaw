import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./embedding-runtime-registry.js", () => ({
  EXTENSION_HOST_REMOTE_EMBEDDING_PROVIDER_IDS: ["openai", "gemini", "voyage", "mistral"],
}));

vi.mock("./media-runtime-registry.js", () => ({
  buildExtensionHostMediaUnderstandingRegistry: vi.fn(
    () =>
      new Map([
        [
          "openai",
          {
            id: "openai",
            capabilities: ["image", "video"],
          },
        ],
        [
          "google",
          {
            id: "google",
            capabilities: ["image"],
          },
        ],
        [
          "deepgram",
          {
            id: "deepgram",
            capabilities: ["audio"],
          },
        ],
      ]),
  ),
  normalizeExtensionHostMediaProviderId: vi.fn((id: string) =>
    id.trim().toLowerCase() === "gemini" ? "google" : id.trim().toLowerCase(),
  ),
}));

vi.mock("./tts-runtime-registry.js", () => ({
  listExtensionHostTtsRuntimeProviders: vi.fn(() => [
    { id: "openai", supportsTelephony: true },
    { id: "elevenlabs", supportsTelephony: true },
    { id: "edge", supportsTelephony: false },
  ]),
}));

describe("runtime-backend-catalog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("publishes embedding backends as host-owned runtime-backend catalog entries", async () => {
    const catalog = await import("./runtime-backend-catalog.js");
    const entries = catalog.listExtensionHostEmbeddingRuntimeBackendCatalogEntries();

    expect(entries.map((entry) => entry.backendId)).toEqual([
      "local",
      "openai",
      "gemini",
      "voyage",
      "mistral",
      "ollama",
    ]);
    expect(
      entries.every((entry) => entry.family === catalog.EXTENSION_HOST_RUNTIME_BACKEND_FAMILY),
    ).toBe(true);
    expect(entries.every((entry) => entry.subsystemId === "embedding")).toBe(true);
    expect(entries[0]?.capabilities).toContain("embed.query");
    expect(entries[0]?.metadata).toMatchObject({ autoSelectable: true });
    expect(entries.at(-1)?.metadata).toMatchObject({ autoSelectable: false });
  });

  it("splits media providers into subsystem-specific runtime-backend catalog entries", async () => {
    const catalog = await import("./runtime-backend-catalog.js");
    const entries = catalog.listExtensionHostMediaRuntimeBackendCatalogEntries();

    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          subsystemId: "media.image",
          backendId: "openai",
          capabilities: ["image"],
        }),
        expect.objectContaining({
          subsystemId: "media.audio",
          backendId: "deepgram",
          capabilities: ["audio"],
        }),
      ]),
    );
    expect(entries.find((entry) => entry.backendId === "google")?.selectorKeys).toContain("gemini");
  });

  it("publishes TTS backends with telephony capability metadata", async () => {
    const catalog = await import("./runtime-backend-catalog.js");
    const entries = catalog.listExtensionHostTtsRuntimeBackendCatalogEntries();

    expect(entries.map((entry) => entry.backendId)).toEqual(["openai", "elevenlabs", "edge"]);
    expect(entries.find((entry) => entry.backendId === "openai")?.capabilities).toContain(
      "tts.telephony",
    );
    expect(entries.find((entry) => entry.backendId === "edge")?.capabilities).toEqual([
      "tts.synthesis",
    ]);
    expect(catalog.listExtensionHostTtsRuntimeBackendIds()).toEqual([
      "openai",
      "elevenlabs",
      "edge",
    ]);
  });

  it("aggregates runtime-backend catalog entries across subsystem families", async () => {
    const catalog = await import("./runtime-backend-catalog.js");
    const entries = catalog.listExtensionHostRuntimeBackendCatalogEntries();
    const ids = new Set(entries.map((entry) => entry.id));

    expect(ids.size).toBe(entries.length);
    expect(
      catalog.getExtensionHostRuntimeBackendCatalogEntry({ subsystemId: "tts", backendId: "edge" }),
    ).toMatchObject({
      id: `${catalog.EXTENSION_HOST_RUNTIME_BACKEND_FAMILY}:tts:edge`,
      subsystemId: "tts",
      backendId: "edge",
    });
  });
});
