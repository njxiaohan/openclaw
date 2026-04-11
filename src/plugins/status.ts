import { resolveDefaultAgentWorkspaceDir } from "../agents/workspace.js";
import { loadConfig } from "../config/config.js";
import { normalizeOpenClawVersionBase } from "../config/version.js";
import { listImportedBundledPluginFacadeIds } from "../plugin-sdk/facade-runtime.js";
import { resolveCompatibilityHostVersion } from "../version.js";
import { inspectBundleLspRuntimeSupport } from "./bundle-lsp.js";
import { inspectBundleMcpRuntimeSupport } from "./bundle-mcp.js";
import {
  withBundledPluginAllowlistCompat,
  withBundledPluginEnablementCompat,
} from "./bundled-compat.js";
import { normalizePluginsConfig } from "./config-state.js";
import { loadOpenClawPlugins } from "./loader.js";
import { resolveBundledProviderCompatPluginIds } from "./providers.js";
import type { PluginRegistry } from "./registry.js";
import { listImportedRuntimePluginIds } from "./runtime.js";
import {
  buildPluginRuntimeLoadOptions,
  resolvePluginRuntimeLoadContext,
} from "./runtime/load-context.js";
import { loadPluginMetadataRegistrySnapshot } from "./runtime/metadata-registry-loader.js";
import type { PluginDiagnostic, PluginHookName } from "./types.js";

export type PluginStatusReport = PluginRegistry & {
  workspaceDir?: string;
};

export type PluginCapabilityKind =
  | "cli-backend"
  | "text-inference"
  | "speech"
  | "realtime-transcription"
  | "realtime-voice"
  | "media-understanding"
  | "image-generation"
  | "web-search"
  | "channel";

export type PluginInspectShape =
  | "hook-only"
  | "plain-capability"
  | "hybrid-capability"
  | "non-capability";

export type PluginCompatibilityNotice = {
  pluginId: string;
  code: "legacy-before-agent-start" | "hook-only";
  severity: "warn" | "info";
  message: string;
};

export type PluginCompatibilitySummary = {
  noticeCount: number;
  pluginCount: number;
};

export type PluginSmokeScenarioId = "bundled-channels";

export type PluginSmokeClassification =
  | "ok"
  | "packaged_entry_missing"
  | "plugin_validation_error"
  | "load_error";

export type PluginSmokeEntry = {
  pluginId: string;
  pluginName?: string;
  status: PluginRegistry["plugins"][number]["status"];
  failurePhase?: PluginRegistry["plugins"][number]["failurePhase"];
  failedAt?: Date;
  classification: PluginSmokeClassification;
  summary: string;
  diagnostics: PluginDiagnostic[];
};

export type PluginSmokeReport = {
  scenarioId: PluginSmokeScenarioId;
  workspaceDir?: string;
  classification: PluginSmokeClassification;
  summary: {
    pluginCount: number;
    loadedCount: number;
    errorCount: number;
    disabledCount: number;
  };
  entries: PluginSmokeEntry[];
  diagnostics: PluginDiagnostic[];
};

const GLOBAL_PLUGIN_SMOKE_ENTRY_ID = "__global__";

export type PluginInspectReport = {
  workspaceDir?: string;
  plugin: PluginRegistry["plugins"][number];
  shape: PluginInspectShape;
  capabilityMode: "none" | "plain" | "hybrid";
  capabilityCount: number;
  capabilities: Array<{
    kind: PluginCapabilityKind;
    ids: string[];
  }>;
  typedHooks: Array<{
    name: PluginHookName;
    priority?: number;
  }>;
  customHooks: Array<{
    name: string;
    events: string[];
  }>;
  tools: Array<{
    names: string[];
    optional: boolean;
  }>;
  commands: string[];
  cliCommands: string[];
  services: string[];
  gatewayMethods: string[];
  mcpServers: Array<{
    name: string;
    hasStdioTransport: boolean;
  }>;
  lspServers: Array<{
    name: string;
    hasStdioTransport: boolean;
  }>;
  httpRouteCount: number;
  bundleCapabilities: string[];
  diagnostics: PluginDiagnostic[];
  policy: {
    allowPromptInjection?: boolean;
    allowModelOverride?: boolean;
    allowedModels: string[];
    hasAllowedModelsConfig: boolean;
  };
  usesLegacyBeforeAgentStart: boolean;
  compatibility: PluginCompatibilityNotice[];
};

function buildCompatibilityNoticesForInspect(
  inspect: Pick<PluginInspectReport, "plugin" | "shape" | "usesLegacyBeforeAgentStart">,
): PluginCompatibilityNotice[] {
  const warnings: PluginCompatibilityNotice[] = [];
  if (inspect.usesLegacyBeforeAgentStart) {
    warnings.push({
      pluginId: inspect.plugin.id,
      code: "legacy-before-agent-start",
      severity: "warn",
      message:
        "still uses legacy before_agent_start; keep regression coverage on this plugin, and prefer before_model_resolve/before_prompt_build for new work.",
    });
  }
  if (inspect.shape === "hook-only") {
    warnings.push({
      pluginId: inspect.plugin.id,
      code: "hook-only",
      severity: "info",
      message:
        "is hook-only. This remains a supported compatibility path, but it has not migrated to explicit capability registration yet.",
    });
  }
  return warnings;
}

function resolveReportedPluginVersion(
  plugin: PluginRegistry["plugins"][number],
  env: NodeJS.ProcessEnv | undefined,
): string | undefined {
  if (plugin.origin !== "bundled") {
    return plugin.version;
  }
  return (
    normalizeOpenClawVersionBase(resolveCompatibilityHostVersion(env)) ??
    normalizeOpenClawVersionBase(plugin.version) ??
    plugin.version
  );
}

type PluginReportParams = {
  config?: ReturnType<typeof loadConfig>;
  workspaceDir?: string;
  /** Use an explicit env when plugin roots should resolve independently from process.env. */
  env?: NodeJS.ProcessEnv;
};

function buildPluginReport(
  params: PluginReportParams | undefined,
  loadModules: boolean,
): PluginStatusReport {
  const baseContext = resolvePluginRuntimeLoadContext({
    config: params?.config ?? loadConfig(),
    env: params?.env,
    workspaceDir: params?.workspaceDir,
  });
  const workspaceDir = baseContext.workspaceDir ?? resolveDefaultAgentWorkspaceDir();
  const context =
    workspaceDir === baseContext.workspaceDir
      ? baseContext
      : {
          ...baseContext,
          workspaceDir,
        };
  const rawConfig = context.rawConfig;
  const config = context.config;

  // Apply bundled-provider allowlist compat so that `plugins list` and `doctor`
  // report the same loaded/disabled status the gateway uses at runtime.  Without
  // this, bundled provider plugins are incorrectly shown as "disabled" when
  // `plugins.allow` is set because the allowlist check runs before the
  // bundled-default-enable check.  Scoped to bundled providers only (not all
  // bundled plugins) to match the runtime compat surface in providers.runtime.ts.
  const bundledProviderIds = resolveBundledProviderCompatPluginIds({
    config,
    workspaceDir,
    env: params?.env,
  });
  const effectiveConfig = withBundledPluginAllowlistCompat({
    config,
    pluginIds: bundledProviderIds,
  });
  const runtimeCompatConfig = withBundledPluginEnablementCompat({
    config: effectiveConfig,
    pluginIds: bundledProviderIds,
  });

  const registry = loadModules
    ? loadOpenClawPlugins(
        buildPluginRuntimeLoadOptions(context, {
          config: runtimeCompatConfig,
          activationSourceConfig: rawConfig,
          workspaceDir,
          env: params?.env,
          loadModules,
          activate: false,
          cache: false,
        }),
      )
    : loadPluginMetadataRegistrySnapshot({
        config: runtimeCompatConfig,
        activationSourceConfig: rawConfig,
        workspaceDir,
        env: params?.env,
        loadModules: false,
      });
  const importedPluginIds = new Set([
    ...(loadModules
      ? registry.plugins
          .filter((plugin) => plugin.status === "loaded" && plugin.format !== "bundle")
          .map((plugin) => plugin.id)
      : []),
    ...listImportedRuntimePluginIds(),
    ...listImportedBundledPluginFacadeIds(),
  ]);

  return {
    workspaceDir,
    ...registry,
    plugins: registry.plugins.map((plugin) => ({
      ...plugin,
      imported: plugin.format !== "bundle" && importedPluginIds.has(plugin.id),
      version: resolveReportedPluginVersion(plugin, params?.env),
    })),
  };
}

export function buildPluginSnapshotReport(params?: PluginReportParams): PluginStatusReport {
  return buildPluginReport(params, false);
}

export function buildPluginDiagnosticsReport(params?: PluginReportParams): PluginStatusReport {
  return buildPluginReport(params, true);
}

function classifyPluginSmokeDiagnostics(params: {
  diagnostics: PluginDiagnostic[];
  failurePhase?: PluginRegistry["plugins"][number]["failurePhase"];
}): Pick<PluginSmokeEntry, "classification" | "summary"> {
  const combinedDiagnostics = params.diagnostics.map((entry) => String(entry.message)).join("\n");
  if (
    /bundled plugin entry .* failed to open/i.test(combinedDiagnostics) ||
    (/ENOENT: no such file or directory/i.test(combinedDiagnostics) &&
      /dist\/extensions\//i.test(combinedDiagnostics))
  ) {
    const match = combinedDiagnostics.match(/dist\/extensions\/[^\s)]+/i);
    return {
      classification: "packaged_entry_missing",
      summary: match ? `missing packaged entry: ${match[0]}` : "missing packaged entry",
    };
  }

  if (
    /missing register\/activate export/i.test(combinedDiagnostics) ||
    params.failurePhase === "validation" ||
    params.failurePhase === "register"
  ) {
    return {
      classification: "plugin_validation_error",
      summary: params.failurePhase
        ? `plugin failed during ${params.failurePhase}`
        : "plugin validation or registration failed",
    };
  }

  return {
    classification: "load_error",
    summary: params.failurePhase
      ? `plugin failed during ${params.failurePhase}`
      : "plugin failed to load",
  };
}

function classifyPluginSmokeEntry(params: {
  plugin: PluginRegistry["plugins"][number];
  diagnostics: PluginDiagnostic[];
}): Pick<PluginSmokeEntry, "classification" | "summary"> {
  if (params.plugin.status !== "error") {
    return {
      classification: "ok",
      summary: params.plugin.status === "disabled" ? "plugin is disabled" : "plugin loaded",
    };
  }

  return classifyPluginSmokeDiagnostics({
    diagnostics: params.diagnostics,
    failurePhase: params.plugin.failurePhase,
  });
}

function summarizePluginSmokeClassification(
  entries: PluginSmokeEntry[],
): PluginSmokeClassification {
  if (entries.some((entry) => entry.classification === "packaged_entry_missing")) {
    return "packaged_entry_missing";
  }
  if (entries.some((entry) => entry.classification === "plugin_validation_error")) {
    return "plugin_validation_error";
  }
  if (entries.some((entry) => entry.classification === "load_error")) {
    return "load_error";
  }
  return "ok";
}

export function buildPluginSmokeReport(
  params?: PluginReportParams & {
    scenarioId?: PluginSmokeScenarioId;
    report?: PluginStatusReport;
  },
): PluginSmokeReport {
  const report = params?.report ?? buildPluginDiagnosticsReport(params);
  const entries: PluginSmokeEntry[] = report.plugins.map((plugin) => {
    const diagnostics = report.diagnostics.filter((entry) => entry.pluginId === plugin.id);
    const { classification, summary } = classifyPluginSmokeEntry({
      plugin,
      diagnostics,
    });
    return {
      pluginId: plugin.id,
      pluginName: plugin.name,
      status: plugin.status,
      failurePhase: plugin.failurePhase,
      failedAt: plugin.failedAt,
      classification,
      summary,
      diagnostics,
    } satisfies PluginSmokeEntry;
  });
  const globalDiagnostics = report.diagnostics.filter(
    (entry) => entry.level === "error" && !entry.pluginId,
  );
  if (globalDiagnostics.length > 0) {
    const { classification, summary } = classifyPluginSmokeDiagnostics({
      diagnostics: globalDiagnostics,
    });
    entries.push({
      pluginId: GLOBAL_PLUGIN_SMOKE_ENTRY_ID,
      pluginName: "Global diagnostics",
      status: "error",
      classification,
      summary,
      diagnostics: globalDiagnostics,
    });
  }

  return {
    scenarioId: params?.scenarioId ?? "bundled-channels",
    workspaceDir: report.workspaceDir,
    classification: summarizePluginSmokeClassification(entries),
    summary: {
      pluginCount: report.plugins.length,
      loadedCount: report.plugins.filter((plugin) => plugin.status === "loaded").length,
      errorCount: entries.filter((entry) => entry.status === "error").length,
      disabledCount: report.plugins.filter((plugin) => plugin.status === "disabled").length,
    },
    entries,
    diagnostics: report.diagnostics,
  };
}

function buildCapabilityEntries(plugin: PluginRegistry["plugins"][number]) {
  return [
    { kind: "cli-backend" as const, ids: plugin.cliBackendIds ?? [] },
    { kind: "text-inference" as const, ids: plugin.providerIds },
    { kind: "speech" as const, ids: plugin.speechProviderIds },
    { kind: "realtime-transcription" as const, ids: plugin.realtimeTranscriptionProviderIds },
    { kind: "realtime-voice" as const, ids: plugin.realtimeVoiceProviderIds },
    { kind: "media-understanding" as const, ids: plugin.mediaUnderstandingProviderIds },
    { kind: "image-generation" as const, ids: plugin.imageGenerationProviderIds },
    { kind: "web-search" as const, ids: plugin.webSearchProviderIds },
    { kind: "channel" as const, ids: plugin.channelIds },
  ].filter((entry) => entry.ids.length > 0);
}

function deriveInspectShape(params: {
  capabilityCount: number;
  typedHookCount: number;
  customHookCount: number;
  toolCount: number;
  commandCount: number;
  cliCount: number;
  serviceCount: number;
  gatewayMethodCount: number;
  httpRouteCount: number;
}): PluginInspectShape {
  if (params.capabilityCount > 1) {
    return "hybrid-capability";
  }
  if (params.capabilityCount === 1) {
    return "plain-capability";
  }
  const hasOnlyHooks =
    params.typedHookCount + params.customHookCount > 0 &&
    params.toolCount === 0 &&
    params.commandCount === 0 &&
    params.cliCount === 0 &&
    params.serviceCount === 0 &&
    params.gatewayMethodCount === 0 &&
    params.httpRouteCount === 0;
  if (hasOnlyHooks) {
    return "hook-only";
  }
  return "non-capability";
}

export function buildPluginInspectReport(params: {
  id: string;
  config?: ReturnType<typeof loadConfig>;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  report?: PluginStatusReport;
}): PluginInspectReport | null {
  const rawConfig = params.config ?? loadConfig();
  const config = resolvePluginRuntimeLoadContext({
    config: rawConfig,
    env: params.env,
    workspaceDir: params.workspaceDir,
  }).config;
  const report =
    params.report ??
    buildPluginDiagnosticsReport({
      config: rawConfig,
      workspaceDir: params.workspaceDir,
      env: params.env,
    });
  const plugin = report.plugins.find((entry) => entry.id === params.id || entry.name === params.id);
  if (!plugin) {
    return null;
  }

  const capabilities = buildCapabilityEntries(plugin);
  const typedHooks = report.typedHooks
    .filter((entry) => entry.pluginId === plugin.id)
    .map((entry) => ({
      name: entry.hookName,
      priority: entry.priority,
    }))
    .toSorted((a, b) => a.name.localeCompare(b.name));
  const customHooks = report.hooks
    .filter((entry) => entry.pluginId === plugin.id)
    .map((entry) => ({
      name: entry.entry.hook.name,
      events: [...entry.events].toSorted(),
    }))
    .toSorted((a, b) => a.name.localeCompare(b.name));
  const tools = report.tools
    .filter((entry) => entry.pluginId === plugin.id)
    .map((entry) => ({
      names: [...entry.names],
      optional: entry.optional,
    }));
  const diagnostics = report.diagnostics.filter((entry) => entry.pluginId === plugin.id);
  const policyEntry = normalizePluginsConfig(config.plugins).entries[plugin.id];
  const capabilityCount = capabilities.length;
  const shape = deriveInspectShape({
    capabilityCount,
    typedHookCount: typedHooks.length,
    customHookCount: customHooks.length,
    toolCount: tools.length,
    commandCount: plugin.commands.length,
    cliCount: plugin.cliCommands.length,
    serviceCount: plugin.services.length,
    gatewayMethodCount: plugin.gatewayMethods.length,
    httpRouteCount: plugin.httpRoutes,
  });

  // Populate MCP server info for bundle-format plugins with a known rootDir.
  let mcpServers: PluginInspectReport["mcpServers"] = [];
  if (plugin.format === "bundle" && plugin.bundleFormat && plugin.rootDir) {
    const mcpSupport = inspectBundleMcpRuntimeSupport({
      pluginId: plugin.id,
      rootDir: plugin.rootDir,
      bundleFormat: plugin.bundleFormat,
    });
    mcpServers = [
      ...mcpSupport.supportedServerNames.map((name) => ({
        name,
        hasStdioTransport: true,
      })),
      ...mcpSupport.unsupportedServerNames.map((name) => ({
        name,
        hasStdioTransport: false,
      })),
    ];
  }

  // Populate LSP server info for bundle-format plugins with a known rootDir.
  let lspServers: PluginInspectReport["lspServers"] = [];
  if (plugin.format === "bundle" && plugin.bundleFormat && plugin.rootDir) {
    const lspSupport = inspectBundleLspRuntimeSupport({
      pluginId: plugin.id,
      rootDir: plugin.rootDir,
      bundleFormat: plugin.bundleFormat,
    });
    lspServers = [
      ...lspSupport.supportedServerNames.map((name) => ({
        name,
        hasStdioTransport: true,
      })),
      ...lspSupport.unsupportedServerNames.map((name) => ({
        name,
        hasStdioTransport: false,
      })),
    ];
  }

  const usesLegacyBeforeAgentStart = typedHooks.some(
    (entry) => entry.name === "before_agent_start",
  );
  const compatibility = buildCompatibilityNoticesForInspect({
    plugin,
    shape,
    usesLegacyBeforeAgentStart,
  });
  return {
    workspaceDir: report.workspaceDir,
    plugin,
    shape,
    capabilityMode: capabilityCount === 0 ? "none" : capabilityCount === 1 ? "plain" : "hybrid",
    capabilityCount,
    capabilities,
    typedHooks,
    customHooks,
    tools,
    commands: [...plugin.commands],
    cliCommands: [...plugin.cliCommands],
    services: [...plugin.services],
    gatewayMethods: [...plugin.gatewayMethods],
    mcpServers,
    lspServers,
    httpRouteCount: plugin.httpRoutes,
    bundleCapabilities: plugin.bundleCapabilities ?? [],
    diagnostics,
    policy: {
      allowPromptInjection: policyEntry?.hooks?.allowPromptInjection,
      allowModelOverride: policyEntry?.subagent?.allowModelOverride,
      allowedModels: [...(policyEntry?.subagent?.allowedModels ?? [])],
      hasAllowedModelsConfig: policyEntry?.subagent?.hasAllowedModelsConfig === true,
    },
    usesLegacyBeforeAgentStart,
    compatibility,
  };
}

export function buildAllPluginInspectReports(params?: {
  config?: ReturnType<typeof loadConfig>;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  report?: PluginStatusReport;
}): PluginInspectReport[] {
  const rawConfig = params?.config ?? loadConfig();
  const report =
    params?.report ??
    buildPluginDiagnosticsReport({
      config: rawConfig,
      workspaceDir: params?.workspaceDir,
      env: params?.env,
    });

  return report.plugins
    .map((plugin) =>
      buildPluginInspectReport({
        id: plugin.id,
        config: rawConfig,
        report,
      }),
    )
    .filter((entry): entry is PluginInspectReport => entry !== null);
}

export function buildPluginCompatibilityWarnings(params?: {
  config?: ReturnType<typeof loadConfig>;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  report?: PluginStatusReport;
}): string[] {
  return buildPluginCompatibilityNotices(params).map(formatPluginCompatibilityNotice);
}

export function buildPluginCompatibilityNotices(params?: {
  config?: ReturnType<typeof loadConfig>;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  report?: PluginStatusReport;
}): PluginCompatibilityNotice[] {
  return buildAllPluginInspectReports(params).flatMap((inspect) => inspect.compatibility);
}

export function formatPluginCompatibilityNotice(notice: PluginCompatibilityNotice): string {
  return `${notice.pluginId} ${notice.message}`;
}

export function summarizePluginCompatibility(
  notices: PluginCompatibilityNotice[],
): PluginCompatibilitySummary {
  return {
    noticeCount: notices.length,
    pluginCount: new Set(notices.map((notice) => notice.pluginId)).size,
  };
}
