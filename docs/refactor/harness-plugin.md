---
summary: "Plan for making the embedded agent harness pluggable"
read_when:
  - Changing agent harness selection, model switching, or Codex app-server routing
  - Adding a new agent execution backend
  - Moving Codex app-server or PI execution behind a plugin boundary
title: "Harness Plugin Refactor"
---

# Harness Plugin Refactor

Status: plugin-owned Codex harness implemented on `app-server`.

Implemented:

- Added an internal agent harness registry under `src/agents/harness`.
- Kept PI as the built-in fallback harness.
- Replaced the hand-written backend switch with harness selection.
- Routed manual compaction through harness selection before PI compaction.
- Added `api.registerAgentHarness` for trusted native plugins.
- Added plugin loader cache/snapshot restore handling for harness registrations.
- Added neutral `runEmbeddedAgent` and related compatibility aliases while
  keeping all existing `runEmbeddedPiAgent` exports.
- Exposed generic harness registration/types/helpers through
  `openclaw/plugin-sdk/agent-harness`.
- Moved Codex app-server client, runner, bindings, provider, and harness
  registration into bundled `extensions/codex`.
- Added `codex` as an additive provider id for Codex-managed GPT models.
- Added Codex app-server `model/list` discovery with a static GPT fallback.
- Kept `OPENCLAW_AGENT_RUNTIME=codex-app-server` and `app-server` as aliases
  for the `codex` harness id.
- Preserved arbitrary `OPENCLAW_AGENT_RUNTIME=<harness-id>` strings so a
  registered plugin harness can be forced without a core enum change.
- Kept user-visible Codex model refs as `codex/gpt-*` while sending
  `modelProvider=openai` and the bare model id to Codex app-server.
- Replaced the core Codex session-sidecar cleanup with the generic harness
  `reset` callback; the Codex plugin owns deleting its thread binding.
- Made gateway startup model warmup skip the PI-only resolver when a non-PI
  harness is forced or selected.

Live-verified:

- Gateway-run turn on `codex/gpt-5.4`: exact reply `CODEX-EXT-GPT54-OK`.
- Gateway-run turn after switching primary to `codex/gpt-5.2`: exact reply
  `CODEX-EXT-GATEWAY-GPT52-OK`.
- Direct/local fallback turn on `codex/gpt-5.2`: exact reply
  `CODEX-EXT-GPT52-OK`.
- Provider/model metadata in agent results reported provider `codex` and bare
  Codex model ids (`gpt-5.4`, `gpt-5.2`).

Not done yet:

- Session binding generalization into `SessionEntry.harnessBindings`.
- Moving PI into an extension. It stays built in and is the fallback.
- Default routing of plain `openai/gpt-*` models through Codex app-server. Use
  `codex/gpt-*` to opt into Codex-owned auth/model discovery.

## Goal

Make the core agent harness pluggable without giving up the behavior that lives
above the harness today:

- model and provider resolution
- auth profile order, cooldown, and rotation
- model fallback and retry policy
- live model switching
- context engine setup, maintenance, and compaction recovery
- lanes, queueing, abort, steer, and active-run state
- channel delivery and reply payload shaping
- OpenClaw tool construction and side-effect metadata

The harness should answer one narrower question:

> Given a fully prepared OpenClaw attempt, how should this model turn execute?

That keeps Codex app-server useful for GPT/Codex-style models while PI remains
the compatibility backend for everything else.

## Current State

The current cut point is already in place:

- `src/agents/pi-embedded-runner/run.ts` owns the high-level run loop.
- `src/agents/pi-embedded-runner/run/backend.ts` chooses the attempt backend.
- `src/agents/pi-embedded-runner/run/attempt.ts` is the PI attempt backend.
- `extensions/codex/app-server/run-attempt.ts` is the Codex app-server
  attempt backend.
- `extensions/codex/app-server/compact.ts` handles Codex app-server
  compaction when a Codex thread binding exists.
- `extensions/codex/app-server/session-binding.ts` stores Codex thread
  ids in a sidecar file next to the OpenClaw session transcript.
- `extensions/codex/app-server/transcript-mirror.ts` mirrors minimal
  app-server transcript data back into the OpenClaw JSONL transcript.

The existing selector is intentionally simple:

- `OPENCLAW_AGENT_RUNTIME=pi` forces PI.
- `OPENCLAW_AGENT_RUNTIME=codex` forces the registered Codex harness.
- `OPENCLAW_AGENT_RUNTIME=codex-app-server` and `app-server` are compatibility
  aliases for `codex`.
- `OPENCLAW_AGENT_RUNTIME=<other-harness-id>` is preserved and can force any
  registered harness with that id; if it is missing, OpenClaw falls back to PI.
- `OPENCLAW_AGENT_RUNTIME=auto` asks registered harnesses if they support the
  resolved provider/model and falls back to PI when none match.

The bundled `codex` plugin currently registers:

- provider id `codex`
- harness id `codex`
- app-server-backed catalog discovery via `model/list`
- synthetic provider auth marker, because Codex CLI/app-server owns login

The OpenAI plugin still owns `openai` and legacy `openai-codex`; the Codex
plugin does not hijack those model refs. Prefer `codex/gpt-5.4` when the desired
runtime is Codex app-server.

## Design Decision

Add an agent harness registry under the embedded run loop. Do not make model
selection itself a harness concern.

Core should still resolve:

- selected provider and model
- effective model metadata and context window
- auth profile and runtime auth state
- tools, workspace, sandbox, skills, and channel context
- retry and fallback policy

Harnesses should execute:

- a prepared prompt attempt
- native thread/session resume
- native streaming/event projection
- native compaction, when available
- native abort/steer integration

This keeps the API small enough to be real.

## Proposed Contract

Internal first:

```ts
export type AgentHarnessSupport =
  | {
      supported: true;
      priority?: number;
      reason?: string;
    }
  | {
      supported: false;
      reason?: string;
    };

export type AgentHarness = {
  id: string;
  label: string;
  pluginId?: string;
  supports(ctx: AgentHarnessSupportContext): AgentHarnessSupport;
  runAttempt(params: AgentHarnessAttemptParams): Promise<AgentHarnessAttemptResult>;
  compact?(params: AgentHarnessCompactParams): Promise<EmbeddedPiCompactResult | undefined>;
  dispose?(): Promise<void> | void;
};
```

The first implementation can type-alias:

- `AgentHarnessAttemptParams` to `EmbeddedRunAttemptParams`
- `AgentHarnessAttemptResult` to `EmbeddedRunAttemptResult`
- `AgentHarnessCompactParams` to `CompactEmbeddedPiSessionParams`

That keeps the refactor small. Before exposing the contract publicly to third
party plugins, rename the PI-shaped types and remove PI-only details from the
public surface where possible.

## Selection Policy

Selection order:

1. Forced request from env/config, for example `pi` or `codex`.
2. Automatic harness support match for the resolved provider/model.
3. PI fallback.

Forced behavior:

- If `pi` is forced, always use PI.
- If `codex` is forced, use the registered Codex harness when present.
- If a future harness id is forced, use that harness or fail hard.

Automatic behavior:

- If Codex is registered and supports `codex`, use it.
- The Codex harness also accepts legacy `openai-codex` attempts as a
  compatibility path, but that provider id is not the preferred user-facing
  route.
- If Codex is missing, disabled, or fails before side effects, use PI.
- Keep plain `openai/gpt-*` on PI until Codex app-server routing for that
  provider has live smoke coverage.
- Add an opt-in later for plain OpenAI GPT models, for example
  `agents.defaults.harnesses.codexAppServer.providers`.

Recommended default:

```json5
{
  agents: {
    defaults: {
      harness: "auto",
    },
  },
}
```

The env variable should remain as the emergency override:

```sh
OPENCLAW_AGENT_RUNTIME=pi
OPENCLAW_AGENT_RUNTIME=codex
OPENCLAW_AGENT_RUNTIME=codex-app-server
OPENCLAW_AGENT_RUNTIME=auto
```

## Plugin API Shape

Add this only after the internal registry lands:

```ts
api.registerAgentHarness({
  id: "codex",
  label: "Codex agent harness",
  supports(ctx) {
    if (ctx.provider === "codex" || ctx.provider === "openai-codex") {
      return { supported: true, priority: 100 };
    }
    return { supported: false };
  },
  runAttempt(params) {
    return runCodexAppServerAttempt(params);
  },
  compact(params) {
    return maybeCompactCodexAppServerSession(params);
  },
});
```

Keep it experimental at first:

- bundled plugins only, or
- trusted native plugins only, or
- opt-in through a manifest capability flag.

Do not expose Codex app-server protocol details to channel, provider, or memory
plugins.

## PI And Codex Placement

Preferred sequence:

1. PI remains the built-in default harness.
2. Codex app-server is a registered harness from bundled plugin `codex`.
3. Codex model discovery is provider-owned by bundled plugin `codex`.
4. PI can move to an internal extension later if the public type names and docs
   have been de-PI-ed.

Moving PI out first is riskier because the public and internal surfaces still
use PI-shaped names:

- `runEmbeddedPiAgent`
- `compactEmbeddedPiSession`
- `queueEmbeddedPiMessage`
- `EmbeddedPiRunResult`
- `api.runtime.agent.runEmbeddedPiAgent`

Keep those as compatibility exports while adding neutral aliases:

- `runEmbeddedAgent`
- `compactEmbeddedAgentSession`
- `queueEmbeddedAgentMessage`
- `EmbeddedAgentRunResult`

## Model Switching

Model switching is feasible if it stays a core decision.

Rules:

- A harness must not decide to switch models by itself.
- Core may restart a turn with a new provider/model only before side effects.
- Reuse the existing `canRestartForLiveSwitch` style guard:
  - no messaging tool send
  - no deterministic approval prompt
  - no tool metadata
  - no assistant text
  - no tool error
- If the current attempt already produced user-visible output or side effects,
  finish the current attempt and switch on the next turn.

Harness switching across turns should be allowed:

- PI to Codex app-server: start or resume the Codex thread and seed context from
  the OpenClaw transcript.
- Codex app-server to PI: use the mirrored OpenClaw transcript written after
  the Codex turn.
- Codex app-server to Codex app-server: resume the native Codex thread binding.
- PI to PI: use the existing PI transcript/session path.

Do not switch harnesses mid-turn after native tool calls or approvals have
started.

## Session Bindings

Short term, keep the Codex app-server sidecar:

```txt
<sessionFile>.codex-app-server.json
```

Long term, move harness bindings into `SessionEntry`:

```ts
type SessionHarnessBinding = {
  harnessId: string;
  provider?: string;
  model?: string;
  cwd?: string;
  nativeSessionId?: string;
  nativeThreadId?: string;
  createdAt: number;
  updatedAt: number;
  data?: Record<string, unknown>;
};

type SessionEntry = {
  harnessBindings?: Record<string, SessionHarnessBinding>;
};
```

Keep transcript mirroring even after bindings move into the session store. It is
the compatibility bridge for session views, transcript indexing, fallback, and
switching back to PI.

## Registry Layout

Proposed files:

- `src/agents/harness/types.ts`
- `src/agents/harness/registry.ts`
- `src/agents/harness/selection.ts`
- `src/agents/harness/builtin-pi.ts`
- `src/agents/harness/compact.ts`
- `src/plugin-sdk/agent-harness.ts`
- `extensions/codex/index.ts`
- `extensions/codex/provider.ts`
- `extensions/codex/harness.ts`
- `extensions/codex/app-server/*.ts`

Then reduce `src/agents/pi-embedded-runner/run/backend.ts` to:

```ts
export async function runEmbeddedAttemptWithBackend(params: EmbeddedRunAttemptParams) {
  const harness = await selectAgentHarness(params);
  return harness.runAttempt(params);
}
```

Compaction should follow the same registry:

```ts
export async function compactEmbeddedAgentSession(params: CompactEmbeddedPiSessionParams) {
  const harness = await selectAgentHarnessForSession(params);
  const result = await harness.compact?.(params);
  if (result) {
    return result;
  }
  return compactEmbeddedPiSessionDirect(params);
}
```

## Risks

### Public API Freeze Too Early

If the plugin API exposes `EmbeddedRunAttemptParams` directly, third-party
plugins will inherit PI naming and PI-specific fields.

Mitigation: keep the first registry internal. Publish only after neutral
`AgentHarness*` names exist.

Current contract: plugins use `openclaw/plugin-sdk/agent-harness`, a generic
harness SDK subpath. Codex protocol/client/session details are plugin-private
under `extensions/codex/app-server`.

### Split Brain History

Codex app-server owns a native thread. OpenClaw owns a JSONL transcript and
session store metadata.

Mitigation: keep explicit harness bindings and continue transcript mirroring.
Test PI to Codex and Codex to PI switching.

### Tool Semantics Drift

Codex native tools and OpenClaw tools are not the same thing.

Mitigation: core owns OpenClaw tool construction. Harnesses receive normalized
tool specs or a shared tool bridge, not ad hoc plugin access to channel internals.

### Auth Drift

Codex app-server auth and OpenClaw provider auth are not identical.

Mitigation: publish a separate `codex` provider whose synthetic auth marker is
valid only because the `codex` harness owns the real Codex CLI/app-server
authentication. Keep plain `openai/gpt-*` on the OpenAI provider.

### Fallback After Side Effects

Fallback from Codex app-server to PI after a command or message tool side effect
can replay work.

Mitigation: fallback only before side effects or when the harness startup fails
before a turn starts. Forced harness failures should surface instead of replaying.

## Implementation Plan

### Phase 1: Internal Registry

- [x] Add neutral harness types and registry.
- [x] Add built-in PI harness.
- [x] Move Codex app-server harness registration into `extensions/codex`.
- [x] Replace `runEmbeddedAttemptWithBackend` with registry selection.
- [x] Preserve existing env behavior.
- [x] Keep `runEmbeddedPiAgent` and result types stable.
- [x] Add targeted tests for:
  - forced PI
  - auto selects a registered Codex harness for `codex`
  - auto picks a higher-priority plugin harness
  - Codex app-server handshake and model listing
  - Codex provider catalog fallback and app-server mapping
  - bundled Codex plugin provider/harness registration

Remaining targeted tests:

- forced Codex execution path through plugin-loaded gateway
- auto falls back to PI when Codex app-server startup fails
- explicit Codex app-server failure does not fall back

### Phase 2: Neutral Names

- [x] Add neutral aliases for run, compact, queue, and result types.
- [x] Keep PI names as compatibility exports.
- [x] Add `api.runtime.agent.runEmbeddedAgent`.
- [x] Keep `api.runtime.agent.runEmbeddedPiAgent`.
- [ ] Update plugin runtime docs to prefer neutral names.

### Phase 3: Session Binding Generalization

- [ ] Add `SessionEntry.harnessBindings`.
- [ ] Migrate Codex app-server sidecar reads into session-store writes.
- [ ] Keep sidecar read compatibility for existing sessions.
- [x] Add reset cleanup for all harness bindings, not just Codex app-server.

### Phase 4: Plugin Registration

- [x] Add `api.registerAgentHarness`.
- [x] Add loader snapshot and restore handling, following the compaction provider
      pattern.
- [x] Add bundled `codex` plugin.
- [x] Register the `codex` harness from that plugin.
- [x] Register the `codex` provider from that plugin.
- [x] Add `codex/gpt-*` model refs from app-server `model/list`.
- [ ] Gate third-party use behind an experimental capability.

### Phase 5: Broader Codex Routing

- Prefer `codex/gpt-*` when the user wants Codex CLI/app-server auth and model
  discovery.
- Keep `openai/gpt-*` additive and independent.
- Keep legacy `openai-codex` accepted by the Codex harness for compatibility,
  but do not make it the preferred user-facing ref.
- Defer any default hijack of plain `openai/gpt-*`.
- Smoke:
  - [x] live text turn through gateway and Codex app-server
  - [x] same Codex thread switching `gpt-5.4` to `gpt-5.2`
  - [x] live `codex/gpt-5.4` provider ref through plugin-loaded gateway after
        the bundled plugin move
  - tool turn
  - image input
  - TTS/image/video/music tool media output
  - manual compaction
  - model switch PI to Codex
  - model switch Codex to PI

## Targeted Test Commands

Use targeted tests only while this refactor is in flight:

```sh
pnpm test src/agents/pi-embedded-runner/run/backend.test.ts
pnpm test src/agents/harness/registry.test.ts
pnpm test extensions/codex/app-server
pnpm test extensions/codex/index.test.ts extensions/codex/provider.test.ts
pnpm test extensions/codex/app-server/session-binding.test.ts
pnpm test extensions/codex/app-server/transcript-mirror.test.ts
pnpm codex-app-server:protocol:check
pnpm tsgo
pnpm plugin-sdk:api:check
```

Run `pnpm build` only when the change touches lazy-loading, generated exports,
plugin SDK subpaths, or published runtime surfaces.

## Open Questions

- Should plain `openai/gpt-*` route through Codex app-server by default, or
  remain opt-in until live smoke is boring?
- Should third-party harnesses be public SDK in the first pass, or should only
  bundled and trusted native plugins register harnesses?
- Should harness switching across an existing session be fully automatic, or
  should some provider-family changes require an explicit new session?

Recommendation:

- keep `openai/gpt-*` opt-in initially
- make the first plugin API bundled/trusted only
- allow automatic harness switching across turns, never mid-turn after side
  effects
