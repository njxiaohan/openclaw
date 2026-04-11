import { describe, expect, it } from "vitest";
import {
  classifyReleaseCompareCommandOutput,
  compareReleaseCompareResults,
  redactPersistedCommandText,
  resolveQaReleaseOutputDir,
  summarizeInstallClassification,
} from "./release-compare.js";

describe("qa release compare", () => {
  it("keeps packaged-entry to validation transitions as changed", () => {
    expect(
      compareReleaseCompareResults(
        {
          id: "plugins-smoke-json",
          argv: [],
          exitCode: 1,
          timedOut: false,
          stdout: "",
          stderr: "",
          classification: "packaged_entry_missing",
          summary: "missing packaged entry",
        },
        {
          id: "plugins-smoke-json",
          argv: [],
          exitCode: 1,
          timedOut: false,
          stdout: "",
          stderr: "",
          classification: "plugin_validation_error",
          summary: "plugin validation or register/activate failure",
        },
      ),
    ).toBe("changed");
  });

  it("uses parsed plugins-smoke JSON classifications even on non-zero exit", () => {
    expect(
      classifyReleaseCompareCommandOutput(
        "plugins-smoke-json",
        JSON.stringify({ classification: "load_error" }),
        "",
        1,
        false,
      ),
    ).toBe("load_error");
  });

  it("preserves plugin validation failures even when smoke is unsupported", () => {
    expect(
      classifyReleaseCompareCommandOutput(
        "plugins-smoke-json",
        "",
        [
          "[plugins] matrix missing register/activate export",
          "[plugins] 1 plugin(s) failed to initialize (validation: matrix).",
          "error: unknown command 'smoke'",
        ].join("\n"),
        1,
        false,
      ),
    ).toBe("plugin_validation_error");
  });

  it("ignores unsupported helper commands when summarizing overall smoke health", () => {
    expect(
      summarizeInstallClassification({
        commandResults: [
          {
            id: "plugins-smoke-json",
            argv: [],
            exitCode: 1,
            timedOut: false,
            stdout: "",
            stderr: "error: unknown command 'smoke'",
            classification: "command_missing",
            summary: "command missing in this release",
          },
          {
            id: "doctor",
            argv: [],
            exitCode: 0,
            timedOut: false,
            stdout: "",
            stderr: "",
            classification: "ok",
            summary: "command succeeded",
          },
        ],
      }),
    ).toBe("ok");
  });

  it("fails the smoke gate when a command reports load errors", () => {
    expect(
      summarizeInstallClassification({
        commandResults: [
          {
            id: "plugins-smoke-json",
            argv: [],
            exitCode: 1,
            timedOut: false,
            stdout: "",
            stderr: "",
            classification: "load_error",
            summary: "plugin failed to load",
          },
        ],
      }),
    ).toBe("load_error");
  });

  it("accepts repo-contained absolute output dirs after CLI normalization", () => {
    expect(
      resolveQaReleaseOutputDir({
        repoRoot: "/tmp/openclaw-repo",
        outputDir: "/tmp/openclaw-repo/.artifacts/qa/release-smoke/2026.4.10",
        fallbackParts: [".artifacts", "qa", "release-smoke", "2026.4.10"],
      }),
    ).toBe("/tmp/openclaw-repo/.artifacts/qa/release-smoke/2026.4.10");
  });

  it("redacts sensitive command output before persistence", () => {
    expect(
      redactPersistedCommandText(
        [
          "Authorization: Bearer topsecret",
          "OPENAI_API_KEY=sk-secret-token",
          "SLACK_BOT_TOKEN=xoxb-secret-token",
        ].join("\n"),
      ),
    ).toBe(
      [
        "Authorization: Bearer <REDACTED>",
        "OPENAI_API_KEY=<REDACTED>",
        "SLACK_BOT_TOKEN=<REDACTED>",
      ].join("\n"),
    );
  });
});
