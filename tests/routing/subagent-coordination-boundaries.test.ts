import { describe, expect, test, beforeEach } from "bun:test";
import {
  DEFAULT_SUBAGENT_MODELS,
  getSubagentModels,
  normalizeSubagentModels,
  validateSubagentModels,
  filterEnabledSubagentModels,
} from "../../src/config/subagent-models";
import {
  effectiveSubagentRoster,
  resolveConfiguredSubagentRoster,
  isSubagentCandidateAvailable,
} from "../../src/codex/catalog/subagent-roster";
import {
  noteSubagentModelFailure,
  resetSubagentModelFallbackStateForTests,
  selectAvailableSubagentModel,
  isSubagentModelUnavailable,
  getSubagentModelHealthForTests,
  MAX_SUBAGENT_MODEL_FAILURE_TTL_MS,
  MAX_SUBAGENT_ROUTE_RECURSION_DEPTH,
} from "../../src/codex/subagent-model-fallback";
import {
  subagentRosterText,
  subagentRoleBoundaryText,
  formatSubagentCollaborationPrompt,
  SUBAGENT_ROLE_BOUNDARIES_CONTRACT,
  SUBAGENT_READONLY_ROLE_BOUNDARY,
  SUBAGENT_EXECUTION_ROLE_BOUNDARY,
} from "../../src/server/responses/subagent-roster-text";
import type { OcxConfig } from "../../src/types";

describe("src/config/subagent-models.ts", () => {
  test("getSubagentModels returns defaults when config has no subagentModels", () => {
    expect(getSubagentModels(undefined)).toEqual([...DEFAULT_SUBAGENT_MODELS]);
    expect(getSubagentModels({})).toEqual([...DEFAULT_SUBAGENT_MODELS]);
    expect(getSubagentModels({ subagentModels: [] })).toEqual([...DEFAULT_SUBAGENT_MODELS]);
  });

  test("getSubagentModels returns normalized configured models capped at 5", () => {
    const config: Pick<OcxConfig, "subagentModels"> = {
      subagentModels: [
        "  gpt-5.6-sol  ",
        "anthropic/claude-sonnet-4-6",
        "",
        "gpt-5.6-sol", // duplicate
        "xai/grok-4.5",
        "kimi/k3",
        "deepseek/deepseek-chat",
        "extra/overflow-model",
      ],
    };
    const result = getSubagentModels(config);
    expect(result).toEqual([
      "gpt-5.6-sol",
      "anthropic/claude-sonnet-4-6",
      "xai/grok-4.5",
      "kimi/k3",
      "deepseek/deepseek-chat",
    ]);
    expect(result.length).toBe(5);
  });

  test("normalizeSubagentModels trims, dedupes, and drops invalid items", () => {
    const input = [" m1 ", "m2", "m1", "   ", null as unknown as string, "m3"];
    expect(normalizeSubagentModels(input)).toEqual(["m1", "m2", "m3"]);
    expect(normalizeSubagentModels(undefined)).toEqual([]);
    expect(normalizeSubagentModels(null)).toEqual([]);
  });

  test("validateSubagentModels accepts valid array and normalizes", () => {
    const res = validateSubagentModels(["gpt-5.6-sol", " xai/grok-4.5 "]);
    expect(res.valid).toBe(true);
    expect(res.normalized).toEqual(["gpt-5.6-sol", "xai/grok-4.5"]);
  });

  test("validateSubagentModels rejects non-arrays or empty strings", () => {
    expect(validateSubagentModels(null).valid).toBe(false);
    expect(validateSubagentModels("not-an-array").valid).toBe(false);
    expect(validateSubagentModels(["valid", "   "]).valid).toBe(false);
    expect(validateSubagentModels(["valid", 123 as unknown as string]).valid).toBe(false);
  });

  test("filterEnabledSubagentModels filters out disabled bare and routed models", () => {
    const models = ["gpt-5.6-sol", "xai/grok-4.5", "kimi/k3", "anthropic/claude-sonnet-4-6"];
    const disabled = ["xai/grok-4.5", "gpt-5.6-sol"];
    const filtered = filterEnabledSubagentModels(models, disabled);
    expect(filtered).toEqual(["kimi/k3", "anthropic/claude-sonnet-4-6"]);
  });
});

describe("src/codex/catalog/subagent-roster.ts", () => {
  test("resolveConfiguredSubagentRoster projects roster from OcxConfig", () => {
    const config = {
      subagentModels: ["gpt-5.6-sol", "anthropic/claude-sonnet-4-6"],
    } as OcxConfig;
    const entries = [
      { slug: "gpt-5.6-sol", visibility: "list", priority: 1 },
      { slug: "anthropic/claude-sonnet-4-6", visibility: "list", priority: 2 },
    ];
    const roster = resolveConfiguredSubagentRoster(config, "v2", entries as never);
    expect(roster.advertised.map(m => m.model)).toEqual([
      "gpt-5.6-sol",
      "anthropic/claude-sonnet-4-6",
    ]);
    expect(isSubagentCandidateAvailable("gpt-5.6-sol", roster)).toBe(true);
    expect(isSubagentCandidateAvailable("xai/grok-4.5", roster)).toBe(false);
  });
});

describe("src/codex/subagent-model-fallback.ts: health decay and cycle protection", () => {
  beforeEach(() => {
    resetSubagentModelFallbackStateForTests();
  });

  test("noteSubagentModelFailure applies health decay with exponential backoff on repeated failures", () => {
    const config: OcxConfig = {
      subagentModelFallbackPollMs: 10_000,
      providers: {},
    };
    const now = 1_000_000;

    // First failure: base interval = 10_000
    noteSubagentModelFailure("xai/grok-4.5", "429", config, null, now);
    const health1 = getSubagentModelHealthForTests("xai/grok-4.5", config, null);
    expect(health1).toBeDefined();
    expect(health1!.consecutiveFailures).toBe(1);
    expect(health1!.unavailableUntil).toBe(now + 10_000);

    // Second failure shortly after (within window): interval = 10_000 * 1.5 = 15_000
    noteSubagentModelFailure("xai/grok-4.5", "429", config, null, now + 1_000);
    const health2 = getSubagentModelHealthForTests("xai/grok-4.5", config, null);
    expect(health2!.consecutiveFailures).toBe(2);
    expect(health2!.unavailableUntil).toBe(now + 1_000 + 15_000);

    // Third failure: interval = 10_000 * 1.5^2 = 22_500
    noteSubagentModelFailure("xai/grok-4.5", "429", config, null, now + 2_000);
    const health3 = getSubagentModelHealthForTests("xai/grok-4.5", config, null);
    expect(health3!.consecutiveFailures).toBe(3);
    expect(health3!.unavailableUntil).toBe(now + 2_000 + 22_500);
  });

  test("health decay resets after long recovery window passes", () => {
    const config: OcxConfig = {
      subagentModelFallbackPollMs: 10_000,
      providers: {},
    };
    const now = 1_000_000;
    noteSubagentModelFailure("xai/grok-4.5", "429", config, null, now);
    // After long delay (> 2x previous TTL): resets back to 1 consecutive failure
    const later = now + 100_000;
    noteSubagentModelFailure("xai/grok-4.5", "429", config, null, later);
    const health = getSubagentModelHealthForTests("xai/grok-4.5", config, null);
    expect(health!.consecutiveFailures).toBe(1);
    expect(health!.unavailableUntil).toBe(later + 10_000);
  });

  test("boundary exit: returns cleanly without infinite loop when all models are exhausted", () => {
    const config: OcxConfig = {
      subagentModelFallback: ["model-b", "model-c"],
      disabledModels: ["model-a", "model-b", "model-c"],
    };
    const selection = selectAvailableSubagentModel("model-a", config);
    expect(selection.model).toBe("model-a");
    expect(selection.rewritten).toBe(false);
    expect(selection.skipped).toEqual(["model-a", "model-b", "model-c"]);
  });
});

describe("src/server/responses/subagent-roster-text.ts: role boundaries and contracts", () => {
  test("subagentRosterText formats homogeneous ladder correctly", () => {
    const models = [
      { model: "gpt-5.6-sol", efforts: ["high", "max"] },
      { model: "gpt-5.6-terra", efforts: ["high", "max"] },
    ];
    const text = subagentRosterText(models);
    expect(text).toBe(' Available models (reasoning_effort high/max): "gpt-5.6-sol", "gpt-5.6-terra".');
  });

  test("subagentRosterText formats heterogeneous ladders correctly", () => {
    const models = [
      { model: "gpt-5.6-sol", efforts: ["high", "max"] },
      { model: "kimi/k3", efforts: ["low", "medium", "high"] },
    ];
    const text = subagentRosterText(models);
    expect(text).toBe(' Available models (valid reasoning_effort): "gpt-5.6-sol" (high/max), "kimi/k3" (low/medium/high).');
  });

  test("subagentRoleBoundaryText outputs distinct read-only and execution contracts", () => {
    const readonlyText = subagentRoleBoundaryText("readonly");
    expect(readonlyText).toContain("Read-only boundary");
    expect(readonlyText).toContain("Do not modify, overwrite, or delete");

    const execText = subagentRoleBoundaryText("execution");
    expect(execText).toContain("Execution boundary");
    expect(execText).toContain("Modify files strictly within assigned task scope");

    const generalText = subagentRoleBoundaryText("general");
    expect(generalText).toContain(SUBAGENT_ROLE_BOUNDARIES_CONTRACT);
  });

  test("formatSubagentCollaborationPrompt composes roster with role boundaries", () => {
    const prompt = formatSubagentCollaborationPrompt({
      preferredModel: "gpt-5.6-sol",
      preferredEffort: "high",
      rosterModels: [{ model: "gpt-5.6-sol", efforts: ["high", "max"] }],
      role: "readonly",
      includeRoleBoundaries: true,
    });
    expect(prompt).toContain('Preferred sub-agent: model "gpt-5.6-sol", reasoning_effort "high".');
    expect(prompt).toContain('Available models');
    expect(prompt).toContain('Read-only boundary');
  });
});

