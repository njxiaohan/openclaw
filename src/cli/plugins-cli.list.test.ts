import { beforeEach, describe, expect, it } from "vitest";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import {
  buildPluginDiagnosticsReport,
  buildPluginSmokeReport,
  buildPluginSnapshotReport,
  resetPluginsCliTestState,
  runPluginsCommand,
  runtimeLogs,
} from "./plugins-cli-test-helpers.js";

describe("plugins cli list", () => {
  beforeEach(() => {
    resetPluginsCliTestState();
  });

  it("includes imported state in JSON output", async () => {
    buildPluginSnapshotReport.mockReturnValue({
      workspaceDir: "/workspace",
      plugins: [
        createPluginRecord({
          id: "demo",
          imported: true,
          activated: true,
          explicitlyEnabled: true,
        }),
      ],
      diagnostics: [],
    });

    await runPluginsCommand(["plugins", "list", "--json"]);

    expect(buildPluginSnapshotReport).toHaveBeenCalledWith();

    expect(JSON.parse(runtimeLogs[0] ?? "null")).toEqual({
      workspaceDir: "/workspace",
      plugins: [
        expect.objectContaining({
          id: "demo",
          imported: true,
          activated: true,
          explicitlyEnabled: true,
        }),
      ],
      diagnostics: [],
    });
  });

  it("shows imported state in verbose output", async () => {
    buildPluginSnapshotReport.mockReturnValue({
      plugins: [
        createPluginRecord({
          id: "demo",
          name: "Demo Plugin",
          imported: false,
          activated: true,
          explicitlyEnabled: false,
        }),
      ],
      diagnostics: [],
    });

    await runPluginsCommand(["plugins", "list", "--verbose"]);

    expect(buildPluginSnapshotReport).toHaveBeenCalledWith();

    const output = runtimeLogs.join("\n");
    expect(output).toContain("activated: yes");
    expect(output).toContain("imported: no");
    expect(output).toContain("explicitly enabled: no");
  });

  it("sanitizes activation reasons in verbose output", async () => {
    buildPluginSnapshotReport.mockReturnValue({
      plugins: [
        createPluginRecord({
          id: "demo",
          name: "Demo Plugin",
          activated: true,
          activationSource: "auto",
          activationReason: "\u001B[31mconfigured\nnext\tstep",
        }),
      ],
      diagnostics: [],
    });

    await runPluginsCommand(["plugins", "list", "--verbose"]);

    const output = runtimeLogs.join("\n");
    expect(output).toContain("activation reason: configured\\nnext\\tstep");
    expect(output).not.toContain("\u001B[31m");
    expect(output.match(/activation reason:/g)).toHaveLength(1);
  });

  it("keeps doctor on a module-loading snapshot", async () => {
    buildPluginDiagnosticsReport.mockReturnValue({
      plugins: [],
      diagnostics: [],
    });

    await runPluginsCommand(["plugins", "doctor"]);

    expect(buildPluginDiagnosticsReport).toHaveBeenCalledWith();
    expect(runtimeLogs).toContain("No plugin issues detected.");
  });

  it("prints structured smoke JSON", async () => {
    buildPluginSmokeReport.mockReturnValue({
      scenarioId: "bundled-channels",
      classification: "packaged_entry_missing",
      summary: {
        pluginCount: 3,
        loadedCount: 0,
        errorCount: 1,
        disabledCount: 2,
      },
      entries: [
        {
          pluginId: "telegram",
          pluginName: "Telegram",
          status: "error",
          failurePhase: "load",
          classification: "packaged_entry_missing",
          summary: "missing packaged entry: dist/extensions/telegram/src/channel.setup.js",
          diagnostics: [
            {
              level: "error",
              pluginId: "telegram",
              message:
                'bundled plugin entry "./src/channel.setup.js" failed to open dist/extensions/telegram/src/channel.setup.js',
            },
          ],
        },
      ],
      diagnostics: [],
    });

    await expect(runPluginsCommand(["plugins", "smoke", "--json"])).rejects.toThrow("__exit__:1");

    expect(buildPluginSmokeReport).toHaveBeenCalledWith();
    expect(JSON.parse(runtimeLogs[0] ?? "null")).toEqual(
      expect.objectContaining({
        classification: "packaged_entry_missing",
        entries: [
          expect.objectContaining({
            pluginId: "telegram",
            classification: "packaged_entry_missing",
          }),
        ],
      }),
    );
  });

  it("exits non-zero for non-json smoke failures", async () => {
    buildPluginSmokeReport.mockReturnValue({
      scenarioId: "bundled-channels",
      classification: "load_error",
      summary: {
        pluginCount: 1,
        loadedCount: 1,
        errorCount: 1,
        disabledCount: 0,
      },
      entries: [
        {
          pluginId: "__global__",
          pluginName: "Global diagnostics",
          status: "error",
          classification: "load_error",
          summary: "plugin failed to load",
          diagnostics: [
            {
              level: "error",
              message: "plugin path not found: /tmp/missing-plugin",
            },
          ],
        },
      ],
      diagnostics: [
        {
          level: "error",
          message: "plugin path not found: /tmp/missing-plugin",
        },
      ],
    });

    await expect(runPluginsCommand(["plugins", "smoke"])).rejects.toThrow("__exit__:1");

    expect(runtimeLogs.join("\n")).toContain("1 loaded, 1 errored, 0 disabled");
    expect(runtimeLogs.join("\n")).toContain("global diagnostics");
  });
});
