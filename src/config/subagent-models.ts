import type { OcxConfig } from "../types";
import { NATIVE_GPT6_ASTRA_MODEL } from "../codex/catalog/native-models";
import { slugsEquivalent, slugEquals } from "../providers/slug-codec";

export const SUBAGENT_MODELS_VERSION = 1;

/** Native featured defaults; Codex advertises at most five picker-visible rows. */
export const DEFAULT_SUBAGENT_MODELS = [
  NATIVE_GPT6_ASTRA_MODEL, "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5",
];

/** One-time upgrade; later user edits (including removing Astra) remain authoritative. */
export function migrateSubagentModels(config: OcxConfig): boolean {
  if ((config.subagentModelsVersion ?? 0) >= SUBAGENT_MODELS_VERSION) return false;
  if (config.subagentModels === undefined) {
    config.subagentModels = [...DEFAULT_SUBAGENT_MODELS];
  } else {
    const retained = [...new Set([NATIVE_GPT6_ASTRA_MODEL, ...config.subagentModels])].slice(0, 5);
    // Cap first: do not rescue a fifth old choice. Retained 5.5 belongs at the bottom.
    config.subagentModels = retained.filter(model => model !== "gpt-5.5");
    if (retained.includes("gpt-5.5")) config.subagentModels.push("gpt-5.5");
  }
  config.subagentModelsVersion = SUBAGENT_MODELS_VERSION;
  return true;
}

/**
 * Normalize, deduplicate, and limit subagent models array.
 * Trims whitespace, removes empty entries, and filters duplicates using slug equivalence.
 */
export function normalizeSubagentModels(
  models: readonly string[] | undefined | null,
  limit = 5,
): string[] {
  if (!models || !Array.isArray(models)) return [];
  const normalized: string[] = [];
  for (const item of models) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (trimmed.length === 0) continue;
    if (!normalized.some(existing => slugsEquivalent(existing, trimmed))) {
      normalized.push(trimmed);
      if (normalized.length >= limit) break;
    }
  }
  return normalized;
}

/**
 * Read effective subagent models from config.
 * Falls back to DEFAULT_SUBAGENT_MODELS when unset or empty.
 */
export function getSubagentModels(
  config: Pick<OcxConfig, "subagentModels"> | undefined | null,
): string[] {
  if (!config || config.subagentModels === undefined) {
    return [...DEFAULT_SUBAGENT_MODELS];
  }
  const normalized = normalizeSubagentModels(config.subagentModels);
  return normalized.length > 0 ? normalized : [...DEFAULT_SUBAGENT_MODELS];
}

export interface SubagentModelsValidationResult {
  valid: boolean;
  error?: string;
  normalized?: string[];
}

/**
 * Validate a candidate subagent models configuration.
 */
export function validateSubagentModels(candidate: unknown): SubagentModelsValidationResult {
  if (!Array.isArray(candidate)) {
    return { valid: false, error: "subagentModels must be an array of model strings" };
  }
  for (let i = 0; i < candidate.length; i++) {
    const item = candidate[i];
    if (typeof item !== "string" || item.trim().length === 0) {
      return { valid: false, error: `subagentModels item at index ${i} must be a non-empty string` };
    }
  }
  const normalized = normalizeSubagentModels(candidate);
  return { valid: true, normalized };
}

/**
 * Filter out models that are marked disabled in configuration.
 */
export function filterEnabledSubagentModels(
  models: readonly string[],
  disabledModels?: readonly string[],
): string[] {
  if (!disabledModels || disabledModels.length === 0) return [...models];
  return models.filter(model => {
    if (!model.includes("/")) {
      return !disabledModels.some(stored => stored === model || slugEquals(stored, "openai", model));
    }
    const slash = model.indexOf("/");
    const provider = model.slice(0, slash);
    const modelId = model.slice(slash + 1);
    return !disabledModels.some(stored => stored === model || slugEquals(stored, provider, modelId));
  });
}

