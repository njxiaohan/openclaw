import type { OpenClawConfig } from "../../config/config.js";
import {
  findLatestFlowForOwner,
  getFlowByIdForOwner,
  listFlowsForOwner,
  resolveFlowForLookupTokenForOwner,
} from "../../tasks/flow-owner-access.js";
import {
  createManagedFlow,
  failFlow,
  finishFlow,
  requestFlowCancel,
  resumeFlow,
  setFlowWaiting,
} from "../../tasks/flow-runtime-internal.js";
import type { FlowUpdateResult } from "../../tasks/flow-registry.js";
import type { FlowRecord, JsonValue } from "../../tasks/flow-registry.types.js";
import {
  cancelFlowByIdForOwner,
  getFlowTaskSummary,
  runTaskInFlowForOwner,
} from "../../tasks/task-executor.js";
import type {
  TaskDeliveryStatus,
  TaskDeliveryState,
  TaskNotifyPolicy,
  TaskRecord,
  TaskRegistrySummary,
  TaskRuntime,
} from "../../tasks/task-registry.types.js";
import { normalizeDeliveryContext } from "../../utils/delivery-context.js";
import type { OpenClawPluginToolContext } from "../types.js";

export type ManagedFlowRecord = FlowRecord & {
  syncMode: "managed";
  controllerId: string;
};

export type ManagedFlowMutationErrorCode = "not_found" | "not_managed" | "revision_conflict";

export type ManagedFlowMutationResult =
  | {
      applied: true;
      flow: ManagedFlowRecord;
    }
  | {
      applied: false;
      code: ManagedFlowMutationErrorCode;
      current?: FlowRecord;
    };

export type BoundFlowTaskRunResult =
  | {
      created: true;
      flow: ManagedFlowRecord;
      task: TaskRecord;
    }
  | {
      created: false;
      reason: string;
      found: boolean;
      flow?: FlowRecord;
    };

export type BoundFlowCancelResult = Awaited<ReturnType<typeof cancelFlowByIdForOwner>>;

export type BoundFlowRuntime = {
  readonly sessionKey: string;
  readonly requesterOrigin?: TaskDeliveryState["requesterOrigin"];
  createManaged: (params: {
    controllerId: string;
    goal: string;
    status?: ManagedFlowRecord["status"];
    notifyPolicy?: TaskNotifyPolicy;
    currentStep?: string | null;
    stateJson?: JsonValue | null;
    waitJson?: JsonValue | null;
    cancelRequestedAt?: number | null;
    createdAt?: number;
    updatedAt?: number;
    endedAt?: number | null;
  }) => ManagedFlowRecord;
  get: (flowId: string) => FlowRecord | undefined;
  list: () => FlowRecord[];
  findLatest: () => FlowRecord | undefined;
  resolve: (token: string) => FlowRecord | undefined;
  getTaskSummary: (flowId: string) => TaskRegistrySummary | undefined;
  setWaiting: (params: {
    flowId: string;
    expectedRevision: number;
    currentStep?: string | null;
    stateJson?: JsonValue | null;
    waitJson?: JsonValue | null;
    blockedTaskId?: string | null;
    blockedSummary?: string | null;
    updatedAt?: number;
  }) => ManagedFlowMutationResult;
  resume: (params: {
    flowId: string;
    expectedRevision: number;
    status?: Extract<ManagedFlowRecord["status"], "queued" | "running">;
    currentStep?: string | null;
    stateJson?: JsonValue | null;
    updatedAt?: number;
  }) => ManagedFlowMutationResult;
  finish: (params: {
    flowId: string;
    expectedRevision: number;
    stateJson?: JsonValue | null;
    updatedAt?: number;
    endedAt?: number;
  }) => ManagedFlowMutationResult;
  fail: (params: {
    flowId: string;
    expectedRevision: number;
    stateJson?: JsonValue | null;
    blockedTaskId?: string | null;
    blockedSummary?: string | null;
    updatedAt?: number;
    endedAt?: number;
  }) => ManagedFlowMutationResult;
  requestCancel: (params: {
    flowId: string;
    expectedRevision: number;
    cancelRequestedAt?: number;
  }) => ManagedFlowMutationResult;
  cancel: (params: { flowId: string; cfg: OpenClawConfig }) => Promise<BoundFlowCancelResult>;
  runTask: (params: {
    flowId: string;
    runtime: TaskRuntime;
    sourceId?: string;
    childSessionKey?: string;
    parentTaskId?: string;
    agentId?: string;
    runId?: string;
    label?: string;
    task: string;
    preferMetadata?: boolean;
    notifyPolicy?: TaskNotifyPolicy;
    deliveryStatus?: TaskDeliveryStatus;
    status?: "queued" | "running";
    startedAt?: number;
    lastEventAt?: number;
    progressSummary?: string | null;
  }) => BoundFlowTaskRunResult;
};

export type PluginRuntimeFlow = {
  bindSession: (params: {
    sessionKey: string;
    requesterOrigin?: TaskDeliveryState["requesterOrigin"];
  }) => BoundFlowRuntime;
  fromToolContext: (ctx: Pick<OpenClawPluginToolContext, "sessionKey" | "deliveryContext">) => BoundFlowRuntime;
};

function assertSessionKey(sessionKey: string | undefined, errorMessage: string): string {
  const normalized = sessionKey?.trim();
  if (!normalized) {
    throw new Error(errorMessage);
  }
  return normalized;
}

function asManagedFlowRecord(flow: FlowRecord | undefined): ManagedFlowRecord | undefined {
  if (!flow || flow.syncMode !== "managed" || !flow.controllerId) {
    return undefined;
  }
  return flow as ManagedFlowRecord;
}

function resolveManagedFlowForOwner(params: {
  flowId: string;
  ownerKey: string;
}):
  | { ok: true; flow: ManagedFlowRecord }
  | { ok: false; code: "not_found" | "not_managed"; current?: FlowRecord } {
  const flow = getFlowByIdForOwner({
    flowId: params.flowId,
    callerOwnerKey: params.ownerKey,
  });
  if (!flow) {
    return { ok: false, code: "not_found" };
  }
  const managed = asManagedFlowRecord(flow);
  if (!managed) {
    return { ok: false, code: "not_managed", current: flow };
  }
  return { ok: true, flow: managed };
}

function mapFlowUpdateResult(result: FlowUpdateResult): ManagedFlowMutationResult {
  if (result.applied) {
    const managed = asManagedFlowRecord(result.flow);
    if (!managed) {
      return {
        applied: false,
        code: "not_managed",
        current: result.flow,
      };
    }
    return {
      applied: true,
      flow: managed,
    };
  }
  return {
    applied: false,
    code: result.reason,
    ...(result.current ? { current: result.current } : {}),
  };
}

function createBoundFlowRuntime(params: {
  sessionKey: string;
  requesterOrigin?: TaskDeliveryState["requesterOrigin"];
}): BoundFlowRuntime {
  const ownerKey = assertSessionKey(params.sessionKey, "Flow runtime requires a bound sessionKey.");
  const requesterOrigin = params.requesterOrigin
    ? normalizeDeliveryContext(params.requesterOrigin)
    : undefined;

  return {
    sessionKey: ownerKey,
    ...(requesterOrigin ? { requesterOrigin } : {}),
    createManaged: (input) =>
      createManagedFlow({
        ownerKey,
        controllerId: input.controllerId,
        requesterOrigin,
        status: input.status,
        notifyPolicy: input.notifyPolicy,
        goal: input.goal,
        currentStep: input.currentStep,
        stateJson: input.stateJson,
        waitJson: input.waitJson,
        cancelRequestedAt: input.cancelRequestedAt,
        createdAt: input.createdAt,
        updatedAt: input.updatedAt,
        endedAt: input.endedAt,
      }) as ManagedFlowRecord,
    get: (flowId) =>
      getFlowByIdForOwner({
        flowId,
        callerOwnerKey: ownerKey,
      }),
    list: () =>
      listFlowsForOwner({
        callerOwnerKey: ownerKey,
      }),
    findLatest: () =>
      findLatestFlowForOwner({
        callerOwnerKey: ownerKey,
      }),
    resolve: (token) =>
      resolveFlowForLookupTokenForOwner({
        token,
        callerOwnerKey: ownerKey,
      }),
    getTaskSummary: (flowId) => {
      const flow = getFlowByIdForOwner({
        flowId,
        callerOwnerKey: ownerKey,
      });
      return flow ? getFlowTaskSummary(flow.flowId) : undefined;
    },
    setWaiting: (input) => {
      const flow = resolveManagedFlowForOwner({
        flowId: input.flowId,
        ownerKey,
      });
      if (!flow.ok) {
        return {
          applied: false,
          code: flow.code,
          ...(flow.current ? { current: flow.current } : {}),
        };
      }
      return mapFlowUpdateResult(
        setFlowWaiting({
          flowId: flow.flow.flowId,
          expectedRevision: input.expectedRevision,
          currentStep: input.currentStep,
          stateJson: input.stateJson,
          waitJson: input.waitJson,
          blockedTaskId: input.blockedTaskId,
          blockedSummary: input.blockedSummary,
          updatedAt: input.updatedAt,
        }),
      );
    },
    resume: (input) => {
      const flow = resolveManagedFlowForOwner({
        flowId: input.flowId,
        ownerKey,
      });
      if (!flow.ok) {
        return {
          applied: false,
          code: flow.code,
          ...(flow.current ? { current: flow.current } : {}),
        };
      }
      return mapFlowUpdateResult(
        resumeFlow({
          flowId: flow.flow.flowId,
          expectedRevision: input.expectedRevision,
          status: input.status,
          currentStep: input.currentStep,
          stateJson: input.stateJson,
          updatedAt: input.updatedAt,
        }),
      );
    },
    finish: (input) => {
      const flow = resolveManagedFlowForOwner({
        flowId: input.flowId,
        ownerKey,
      });
      if (!flow.ok) {
        return {
          applied: false,
          code: flow.code,
          ...(flow.current ? { current: flow.current } : {}),
        };
      }
      return mapFlowUpdateResult(
        finishFlow({
          flowId: flow.flow.flowId,
          expectedRevision: input.expectedRevision,
          stateJson: input.stateJson,
          updatedAt: input.updatedAt,
          endedAt: input.endedAt,
        }),
      );
    },
    fail: (input) => {
      const flow = resolveManagedFlowForOwner({
        flowId: input.flowId,
        ownerKey,
      });
      if (!flow.ok) {
        return {
          applied: false,
          code: flow.code,
          ...(flow.current ? { current: flow.current } : {}),
        };
      }
      return mapFlowUpdateResult(
        failFlow({
          flowId: flow.flow.flowId,
          expectedRevision: input.expectedRevision,
          stateJson: input.stateJson,
          blockedTaskId: input.blockedTaskId,
          blockedSummary: input.blockedSummary,
          updatedAt: input.updatedAt,
          endedAt: input.endedAt,
        }),
      );
    },
    requestCancel: (input) => {
      const flow = resolveManagedFlowForOwner({
        flowId: input.flowId,
        ownerKey,
      });
      if (!flow.ok) {
        return {
          applied: false,
          code: flow.code,
          ...(flow.current ? { current: flow.current } : {}),
        };
      }
      return mapFlowUpdateResult(
        requestFlowCancel({
          flowId: flow.flow.flowId,
          expectedRevision: input.expectedRevision,
          cancelRequestedAt: input.cancelRequestedAt,
        }),
      );
    },
    cancel: ({ flowId, cfg }) =>
      cancelFlowByIdForOwner({
        cfg,
        flowId,
        callerOwnerKey: ownerKey,
      }),
    runTask: (input) => {
      const created = runTaskInFlowForOwner({
        flowId: input.flowId,
        callerOwnerKey: ownerKey,
        runtime: input.runtime,
        sourceId: input.sourceId,
        childSessionKey: input.childSessionKey,
        parentTaskId: input.parentTaskId,
        agentId: input.agentId,
        runId: input.runId,
        label: input.label,
        task: input.task,
        preferMetadata: input.preferMetadata,
        notifyPolicy: input.notifyPolicy,
        deliveryStatus: input.deliveryStatus,
        status: input.status,
        startedAt: input.startedAt,
        lastEventAt: input.lastEventAt,
        progressSummary: input.progressSummary,
      });
      if (!created.created) {
        return {
          created: false,
          found: created.found,
          reason: created.reason ?? "Task was not created.",
          ...(created.flow ? { flow: created.flow } : {}),
        };
      }
      const managed = asManagedFlowRecord(created.flow);
      if (!managed) {
        return {
          created: false,
          found: true,
          reason: "Flow does not accept managed child tasks.",
          flow: created.flow,
        };
      }
      if (!created.task) {
        return {
          created: false,
          found: true,
          reason: "Task was not created.",
          flow: created.flow,
        };
      }
      return {
        created: true,
        flow: managed,
        task: created.task,
      };
    },
  };
}

export function createRuntimeFlow(): PluginRuntimeFlow {
  return {
    bindSession: (params) =>
      createBoundFlowRuntime({
        sessionKey: params.sessionKey,
        requesterOrigin: params.requesterOrigin,
      }),
    fromToolContext: (ctx) =>
      createBoundFlowRuntime({
        sessionKey: assertSessionKey(
          ctx.sessionKey,
          "Flow runtime requires tool context with a sessionKey.",
        ),
        requesterOrigin: ctx.deliveryContext,
      }),
  };
}
