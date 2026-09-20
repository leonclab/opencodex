/**
 * Subagent Roster prompt and boundary contracts (Issue #1).
 *
 * Provides standardized Roster prompt text and collaboration boundaries for
 * multi-agent delegation, clearly delineating read-only vs execution roles.
 */

export interface SubagentRosterModel {
  model: string;
  efforts: string[];
}

export type SubagentRoleKind = "readonly" | "execution" | "general";

export interface SubagentRoleBoundary {
  role: SubagentRoleKind;
  description: string;
  permissions: string[];
  prohibitions: string[];
}

export const SUBAGENT_READONLY_ROLE_BOUNDARY: SubagentRoleBoundary = {
  role: "readonly",
  description: "Read-only inspection, auditing, verification, and code review",
  permissions: [
    "Read files and directory structures",
    "Run non-mutating search and analysis queries",
    "Report findings, test results, and audit summaries",
  ],
  prohibitions: [
    "Do not modify, overwrite, or delete any workspace files",
    "Do not execute mutating shell commands or run destructive scripts",
    "Do not initiate Git commits, merges, or remote pushes",
    "Do not spawn unconstrained recursive sub-agents",
  ],
};

export const SUBAGENT_EXECUTION_ROLE_BOUNDARY: SubagentRoleBoundary = {
  role: "execution",
  description: "Scoped implementation, editing, and test verification",
  permissions: [
    "Modify files strictly within assigned task scope",
    "Run relevant test suites and verify changes",
    "Prepare clean diffs and review-ready deliverables",
  ],
  prohibitions: [
    "Do not modify files outside authorized workspace scope",
    "Do not execute destructive operations without authorization",
    "Do not perform Git push, force-reset, or history rewriting without authorization",
  ],
};

export const SUBAGENT_ROLE_BOUNDARIES_CONTRACT =
  "Subagent Role Boundaries: Read-only roles (review/audit/inspect) must not edit files or execute mutating commands. Execution roles (implement/fix) must remain strictly within assigned scope and must not perform unauthorized destructive actions or recursive delegations.";

/**
 * Format the subagent roster guidance text describing available models and ladders.
 */
export function subagentRosterText(models: Array<{ model: string; efforts: string[] }>): string {
  if (models.length === 0) return "";
  const ladders = new Set(models.map(model => model.efforts.join("/")));
  if (!ladders.has("") && ladders.size === 1) {
    return ` Available models (reasoning_effort ${[...ladders][0]}): ${models
      .map(model => `"${model.model}"`)
      .join(", ")}.`;
  }
  const entries = models.map(model => model.efforts.length > 0
    ? `"${model.model}" (${model.efforts.join("/")})`
    : `"${model.model}"`);
  return ` Available models (valid reasoning_effort): ${entries.join(", ")}.`;
}

/**
 * Returns role boundary contract text for a specific role or general multi-agent delegation.
 */
export function subagentRoleBoundaryText(role?: SubagentRoleKind): string {
  if (role === "readonly") {
    return ` Read-only boundary: ${SUBAGENT_READONLY_ROLE_BOUNDARY.permissions.join("; ")}. Prohibitions: ${SUBAGENT_READONLY_ROLE_BOUNDARY.prohibitions.join("; ")}.`;
  }
  if (role === "execution") {
    return ` Execution boundary: ${SUBAGENT_EXECUTION_ROLE_BOUNDARY.permissions.join("; ")}. Prohibitions: ${SUBAGENT_EXECUTION_ROLE_BOUNDARY.prohibitions.join("; ")}.`;
  }
  return ` ${SUBAGENT_ROLE_BOUNDARIES_CONTRACT}`;
}

export interface FormatSubagentCollaborationOptions {
  rosterModels?: Array<{ model: string; efforts: string[] }>;
  preferredModel?: string;
  preferredEffort?: string;
  fallbackGuidance?: string;
  role?: SubagentRoleKind;
  includeRoleBoundaries?: boolean;
}

/**
 * Compose subagent collaboration guidance incorporating roster, preference, and role boundaries.
 */
export function formatSubagentCollaborationPrompt(options: FormatSubagentCollaborationOptions): string {
  let text = "OpenCodex sub-agent routing metadata for this collaboration surface. "
    + "This metadata does not override Codex delegation or model-selection rules.";
  if (options.preferredModel) {
    text += ` Preferred sub-agent: model "${options.preferredModel}"`
      + (options.preferredEffort ? `, reasoning_effort "${options.preferredEffort}"` : "")
      + ".";
  }
  if (options.fallbackGuidance) {
    text += options.fallbackGuidance;
  }
  if (options.rosterModels && options.rosterModels.length > 0) {
    text += subagentRosterText(options.rosterModels);
  }
  if (options.includeRoleBoundaries) {
    text += subagentRoleBoundaryText(options.role);
  }
  return text;
}

