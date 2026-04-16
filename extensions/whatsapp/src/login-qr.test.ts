import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  startWebLoginWithQr,
  startWebLoginWithQrAfterPreflight,
  waitForWebLogin,
} from "./login-qr.js";
import {
  createWaSocket,
  logoutWeb,
  readWebAuthExistsForDecision,
  WHATSAPP_AUTH_UNSTABLE_CODE,
  waitForCredsSaveQueueWithTimeout,
  waitForWaConnection,
} from "./session.js";

vi.mock("./session.js", async () => {
  const actual = await vi.importActual<typeof import("./session.js")>("./session.js");
  const createWaSocket = vi.fn(
    async (_printQr: boolean, _verbose: boolean, opts?: { onQr?: (qr: string) => void }) => {
      const sock = { ws: { close: vi.fn() } };
      if (opts?.onQr) {
        setImmediate(() => opts.onQr?.("qr-data"));
      }
      return sock;
    },
  );
  const waitForWaConnection = vi.fn();
  const formatError = vi.fn((err: unknown) => `formatted:${String(err)}`);
  const getStatusCode = vi.fn(
    (err: unknown) =>
      (err as { output?: { statusCode?: number } })?.output?.statusCode ??
      (err as { status?: number })?.status ??
      (err as { error?: { output?: { statusCode?: number } } })?.error?.output?.statusCode,
  );
  const readWebAuthExistsForDecision = vi.fn(async () => ({
    outcome: "stable" as const,
    exists: false,
  }));
  const readWebSelfId = vi.fn(() => ({ e164: null, jid: null }));
  const logoutWeb = vi.fn(async () => true);
  const waitForCredsSaveQueueWithTimeout = vi.fn(async () => "drained" as const);
  return {
    ...actual,
    createWaSocket,
    waitForWaConnection,
    formatError,
    getStatusCode,
    readWebAuthExistsForDecision,
    readWebSelfId,
    logoutWeb,
    waitForCredsSaveQueueWithTimeout,
  };
});

vi.mock("./qr-image.js", () => ({
  renderQrPngBase64: vi.fn(async () => "base64"),
}));

const createWaSocketMock = vi.mocked(createWaSocket);
const readWebAuthExistsForDecisionMock = vi.mocked(readWebAuthExistsForDecision);
const waitForWaConnectionMock = vi.mocked(waitForWaConnection);
const waitForCredsSaveQueueWithTimeoutMock = vi.mocked(waitForCredsSaveQueueWithTimeout);
const logoutWebMock = vi.mocked(logoutWeb);

async function flushTasks() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("login-qr", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("restarts login once on status 515 and completes", async () => {
    let releaseCredsFlush: ((value: "drained") => void) | undefined;
    const credsFlushGate = new Promise<"drained">((resolve) => {
      releaseCredsFlush = resolve;
    });
    waitForWaConnectionMock
      // Baileys v7 wraps the error: { error: BoomError(515) }
      .mockRejectedValueOnce({ error: { output: { statusCode: 515 } } })
      .mockResolvedValueOnce(undefined);
    waitForCredsSaveQueueWithTimeoutMock.mockReturnValueOnce(credsFlushGate);

    const start = await startWebLoginWithQr({ timeoutMs: 5000 });
    expect(start.qrDataUrl).toBe("data:image/png;base64,base64");

    const resultPromise = waitForWebLogin({ timeoutMs: 5000 });
    await flushTasks();
    await flushTasks();

    expect(createWaSocketMock).toHaveBeenCalledTimes(1);
    expect(waitForCredsSaveQueueWithTimeoutMock).toHaveBeenCalledOnce();
    expect(waitForCredsSaveQueueWithTimeoutMock).toHaveBeenCalledWith(expect.any(String));

    releaseCredsFlush?.("drained");
    const result = await resultPromise;

    expect(result.connected).toBe(true);
    expect(createWaSocketMock).toHaveBeenCalledTimes(2);
    expect(logoutWebMock).not.toHaveBeenCalled();
  });

  it("clears auth and reports a relink message when WhatsApp is logged out", async () => {
    waitForWaConnectionMock.mockRejectedValueOnce({
      output: { statusCode: 401 },
    });

    const start = await startWebLoginWithQr({ timeoutMs: 5000 });
    expect(start.qrDataUrl).toBe("data:image/png;base64,base64");

    const result = await waitForWebLogin({ timeoutMs: 5000 });

    expect(result).toEqual({
      connected: false,
      message:
        "WhatsApp reported the session is logged out. Cleared cached web session; please scan a new QR.",
    });
    expect(logoutWebMock).toHaveBeenCalledOnce();
  });

  it("turns unexpected login cleanup failures into a normal login error", async () => {
    waitForWaConnectionMock.mockRejectedValueOnce({
      output: { statusCode: 401 },
    });
    logoutWebMock.mockRejectedValueOnce(new Error("cleanup failed"));

    const start = await startWebLoginWithQr({ timeoutMs: 5000 });
    expect(start.qrDataUrl).toBe("data:image/png;base64,base64");

    const result = await waitForWebLogin({ timeoutMs: 5000 });

    expect(result).toEqual({
      connected: false,
      message: "WhatsApp login failed: cleanup failed",
    });
  });

  it("returns an unstable-auth result when creds flush does not settle", async () => {
    readWebAuthExistsForDecisionMock.mockResolvedValueOnce({ outcome: "unstable" });

    const result = await startWebLoginWithQr({ timeoutMs: 5000 });

    expect(result).toEqual({
      code: WHATSAPP_AUTH_UNSTABLE_CODE,
      message: "WhatsApp auth state is still stabilizing. Retry login in a moment.",
    });
    expect(createWaSocketMock).not.toHaveBeenCalled();
  });

  it("reuses an active QR before checking auth stability again", async () => {
    const first = await startWebLoginWithQr({ accountId: "reuse", timeoutMs: 5000 });
    expect(first.qrDataUrl).toBe("data:image/png;base64,base64");

    readWebAuthExistsForDecisionMock.mockResolvedValueOnce({ outcome: "unstable" });

    const second = await startWebLoginWithQr({ accountId: "reuse", timeoutMs: 5000 });

    expect(second).toEqual({
      qrDataUrl: "data:image/png;base64,base64",
      message: "QR already active. Scan it in WhatsApp → Linked Devices.",
    });
    expect(createWaSocketMock).toHaveBeenCalledTimes(1);
  });

  it("starts QR login after preflight without re-checking auth state", async () => {
    readWebAuthExistsForDecisionMock.mockResolvedValueOnce({ outcome: "unstable" });

    const result = await startWebLoginWithQrAfterPreflight({
      accountId: "after-preflight",
      timeoutMs: 5000,
    });

    expect(result).toEqual({
      qrDataUrl: "data:image/png;base64,base64",
      message: "Scan this QR in WhatsApp → Linked Devices.",
    });
    expect(createWaSocketMock).toHaveBeenCalledOnce();
  });
});
