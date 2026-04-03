import { beforeEach, describe, expect, it, vi } from "vitest";
import { runMatrixSemanticLoopJudge } from "./semantic-loop-judge.js";

const dispatchReplyFromConfigWithSettledDispatcherMock = vi.hoisted(() =>
  vi.fn(async () => ({ queuedFinal: true, counts: { final: 0, block: 0, tool: 0 } })),
);

vi.mock("../../runtime-api.js", () => ({
  dispatchReplyFromConfigWithSettledDispatcher: dispatchReplyFromConfigWithSettledDispatcherMock,
}));

function createCore() {
  return {
    channel: {
      reply: {
        createReplyDispatcherWithTyping: vi.fn(() => ({
          dispatcher: {},
          replyOptions: {},
          markDispatchIdle: vi.fn(),
        })),
        resolveHumanDelayConfig: vi.fn(() => undefined),
        resolveEnvelopeFormatOptions: vi.fn(() => ({})),
        formatAgentEnvelope: vi.fn(({ body }: { body: string }) => body),
        finalizeInboundContext: vi.fn((ctx: unknown) => ctx),
      },
    },
  };
}

describe("runMatrixSemanticLoopJudge", () => {
  beforeEach(() => {
    dispatchReplyFromConfigWithSettledDispatcherMock.mockClear();
  });

  it("skips judge dispatch until at least two turns exist", async () => {
    const core = createCore();

    const result = await runMatrixSemanticLoopJudge({
      core: core as never,
      cfg: {} as never,
      agentId: "ops",
      accountId: "ops",
      routeSessionKey: "agent:ops:main",
      roomId: "!room:example.org",
      turns: [{ senderId: "@ops:example.org", text: "first turn" }],
    });

    expect(dispatchReplyFromConfigWithSettledDispatcherMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      decision: "continue",
      reasonCode: "insufficient_history",
    });
  });

  it("uses a unique ephemeral SessionKey for each invocation", async () => {
    const core = createCore();

    const params = {
      core: core as never,
      cfg: {} as never,
      agentId: "ops",
      accountId: "ops",
      routeSessionKey: "agent:ops:main",
      roomId: "!room:example.org",
      turns: [
        { senderId: "@ops:example.org", text: "turn one" },
        { senderId: "@bot:example.org", text: "turn two" },
      ],
    };

    await runMatrixSemanticLoopJudge(params);
    await runMatrixSemanticLoopJudge(params);

    expect(dispatchReplyFromConfigWithSettledDispatcherMock).toHaveBeenCalledTimes(2);
    const calls = dispatchReplyFromConfigWithSettledDispatcherMock.mock.calls as unknown as Array<
      [
        {
          ctxPayload: {
            SessionKey: string;
          };
          configOverride: unknown;
        },
      ]
    >;
    const firstCall = calls[0]?.[0];
    const secondCall = calls[1]?.[0];

    expect(firstCall?.ctxPayload.SessionKey).toContain("agent:ops:main:semantic-loop-judge:");
    expect(secondCall?.ctxPayload.SessionKey).toContain("agent:ops:main:semantic-loop-judge:");
    expect(firstCall?.ctxPayload.SessionKey).not.toBe(secondCall?.ctxPayload.SessionKey);
    expect(firstCall?.configOverride).toEqual({ tools: { deny: ["*"] } });
    expect(secondCall?.configOverride).toEqual({ tools: { deny: ["*"] } });
  });
});
