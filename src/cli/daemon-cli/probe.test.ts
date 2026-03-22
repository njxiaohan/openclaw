import { describe, expect, it, vi } from "vitest";

const probeGatewayMock = vi.hoisted(() => vi.fn());

vi.mock("../../gateway/probe.js", () => ({
  probeGateway: (...args: unknown[]) => probeGatewayMock(...args),
}));

vi.mock("../progress.js", () => ({
  withProgress: async (_opts: unknown, fn: () => Promise<unknown>) => await fn(),
}));

const { probeGatewayStatus } = await import("./probe.js");

describe("probeGatewayStatus", () => {
  it("uses lightweight token-only probing for daemon status", async () => {
    probeGatewayMock.mockResolvedValueOnce({ ok: true });

    const result = await probeGatewayStatus({
      url: "ws://127.0.0.1:19191",
      token: "temp-token",
      tlsFingerprint: "abc123",
      timeoutMs: 5_000,
      json: true,
    });

    expect(result).toEqual({ ok: true });
    expect(probeGatewayMock).toHaveBeenCalledWith({
      url: "ws://127.0.0.1:19191",
      auth: {
        token: "temp-token",
        password: undefined,
      },
      tlsFingerprint: "abc123",
      timeoutMs: 5_000,
      includeDetails: false,
    });
  });

  it("surfaces probe close details when the handshake fails", async () => {
    probeGatewayMock.mockResolvedValueOnce({
      ok: false,
      error: null,
      close: { code: 1008, reason: "pairing required" },
    });

    const result = await probeGatewayStatus({
      url: "ws://127.0.0.1:19191",
      timeoutMs: 5_000,
    });

    expect(result).toEqual({
      ok: false,
      error: "gateway closed (1008): pairing required",
    });
  });
});
