/**
 * GPT-6 Sol and Luna native rows and provider registry verification.
 *
 * Held in its own file because tests/codex-integration/codex-catalog.test.ts sits at its
 * file-size ratchet cap (see AGENTS.md, "The file-size ratchet has almost no headroom").
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  buildCatalogEntries,
  NATIVE_OPENAI_MODELS,
  nativeDefaultReasoningEffort,
  nativeInputModalities,
  nativeOpenAiCapabilitySourceSlug,
  nativeOpenAiContextTier,
  nativeOpenAiContextWindow,
  nativeReasoningEfforts,
  upstreamNativeEntry,
} from "../../src/codex/catalog";
import {
  ACCOUNT_GATED_NATIVE_OPENAI_MODELS,
  NATIVE_GPT6_LUNA_MODEL,
  NATIVE_GPT6_SOL_MODEL,
  NATIVE_MAIN_DRAIN_SENTINEL_MODELS,
  SELF_DESCRIBED_NATIVE_OPENAI_MODELS,
  hasNativeOpenAiCapabilityMetadata,
  isNativeOpenAiCapabilityAliasModel,
} from "../../src/codex/catalog/native-models";
import { isGpt56NativeSlug, nativeLadderIncludesUltra } from "../../src/codex/catalog/effort";
import { DOCUMENTED_NATIVE_OPENAI_ADDITIONS, nativeOpenAiCapabilityDisplayName } from "../../src/codex/catalog/metadata";
import { resetCodexModelEntitlementCacheForTests } from "../../src/codex/model-entitlements";
import { PROVIDER_REGISTRY_CORE } from "../../src/providers/registry/entries-core";
import { OPENAI_GPT6_MODELS } from "../../src/providers/registry/model-seeds";

afterEach(() => resetCodexModelEntitlementCacheForTests());

function efforts(entry: { supported_reasoning_levels?: unknown } | null | undefined): string[] {
  const levels = Array.isArray(entry?.supported_reasoning_levels)
    ? entry!.supported_reasoning_levels as Array<{ effort?: string }>
    : [];
  return levels.flatMap(level => typeof level.effort === "string" ? [level.effort] : []);
}

function nativeTemplate(): Record<string, unknown> {
  return {
    slug: "gpt-5.5",
    display_name: "gpt-5.5",
    description: "Native GPT model",
    priority: 1,
    visibility: "list",
    base_instructions: "You are Codex, a coding agent based on GPT-5.",
    model_messages: { instructions_template: "You are Codex, a coding agent based on GPT-5." },
    supported_reasoning_levels: [
      { effort: "low", description: "native low" },
      { effort: "medium", description: "native medium" },
      { effort: "high", description: "native high" },
      { effort: "xhigh", description: "native xhigh" },
    ],
  };
}

const SOL_LADDER = ["low", "medium", "high", "xhigh", "max", "ultra"];
const LUNA_LADDER = ["low", "medium", "high", "xhigh", "max"];

describe("GPT-6 Sol and Luna are self-described flagship natives", () => {
  test("each projects its own row with its own label, windows and exact ladder", () => {
    const cases = [
      { slug: NATIVE_GPT6_SOL_MODEL, wire: "gpt-6-sol", displayName: "GPT-6-Sol", ladder: SOL_LADDER },
      { slug: NATIVE_GPT6_LUNA_MODEL, wire: "gpt-6-luna", displayName: "GPT-6-Luna", ladder: LUNA_LADDER },
    ];
    for (const { slug, wire, displayName, ladder } of cases) {
      expect(slug).toBe(wire);
      expect(SELF_DESCRIBED_NATIVE_OPENAI_MODELS.has(slug)).toBe(true);
      expect(isNativeOpenAiCapabilityAliasModel(slug)).toBe(false);
      expect(hasNativeOpenAiCapabilityMetadata(slug)).toBe(true);
      expect(nativeOpenAiCapabilitySourceSlug(slug)).toBe(slug);
      expect(nativeOpenAiCapabilityDisplayName(slug)).toBe(displayName);

      expect(upstreamNativeEntry(slug)).toMatchObject({
        slug,
        display_name: displayName,
        context_window: 272_000,
        max_context_window: 872_000,
      });
      expect(nativeOpenAiContextWindow(slug)).toBe(272_000);
      expect(nativeOpenAiContextTier(slug)).toEqual({ defaultWindow: 272_000, longWindow: 872_000 });
      expect(nativeReasoningEfforts(slug)).toEqual(ladder);
      expect(nativeDefaultReasoningEffort(slug)).toBe("medium");
      expect(nativeInputModalities(slug)).toEqual(["text", "image"]);
      expect(isGpt56NativeSlug(slug)).toBe(true);
    }
    expect(nativeLadderIncludesUltra(NATIVE_GPT6_SOL_MODEL)).toBe(true);
    expect(nativeLadderIncludesUltra(NATIVE_GPT6_LUNA_MODEL)).toBe(false);
  });

  test("the built catalog keeps Sol at ultra and Luna at max", () => {
    const entries = buildCatalogEntries(nativeTemplate(), [NATIVE_GPT6_SOL_MODEL, NATIVE_GPT6_LUNA_MODEL], []);
    const sol = entries.find(entry => entry.slug === NATIVE_GPT6_SOL_MODEL);
    const luna = entries.find(entry => entry.slug === NATIVE_GPT6_LUNA_MODEL);
    expect(sol?.display_name).toBe("GPT-6-Sol");
    expect(luna?.display_name).toBe("GPT-6-Luna");
    expect(efforts(sol)).toEqual(SOL_LADDER);
    expect(efforts(luna)).toEqual(LUNA_LADDER);
    expect(efforts(luna)).not.toContain("ultra");
  });

  test("both are listed natives and neither is account-gated", () => {
    for (const slug of [NATIVE_GPT6_SOL_MODEL, NATIVE_GPT6_LUNA_MODEL]) {
      expect(NATIVE_OPENAI_MODELS).toContain(slug);
      expect(ACCOUNT_GATED_NATIVE_OPENAI_MODELS.has(slug)).toBe(false);
      expect(DOCUMENTED_NATIVE_OPENAI_ADDITIONS).toContain(slug);
      expect(NATIVE_MAIN_DRAIN_SENTINEL_MODELS.has(slug)).toBe(true);
    }
  });

  test("openai-apikey registry entry declares gpt-6-sol and gpt-6-luna", () => {
    const openAiEntry = PROVIDER_REGISTRY_CORE.find(entry => entry.id === "openai-apikey");
    expect(openAiEntry).toBeDefined();
    for (const model of OPENAI_GPT6_MODELS) {
      expect(openAiEntry?.models).toContain(model);
      expect(openAiEntry?.modelContextWindows?.[model]).toBe(1_050_000);
      expect(openAiEntry?.modelMaxInputTokens?.[model]).toBe(922_000);
      expect(openAiEntry?.modelMaxOutputTokens?.[model]).toBe(128_000);
      expect(openAiEntry?.modelInputModalities?.[model]).toEqual(["text", "image"]);
      expect(openAiEntry?.modelReasoningEfforts?.[model]).toEqual(["low", "medium", "high", "xhigh", "max"]);
    }
  });
});

