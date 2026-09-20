import { describe, expect, test } from "bun:test";
import { buildOpenAIChatPassthroughRequest, createOpenAIChatAdapter } from "../../src/adapters/openai-chat";
import { createResponsesPassthroughAdapter as createResponsesPassthroughAdapterProduction } from "../../src/adapters/openai-responses";
import { withTestTranslatorBudget } from "../helpers/translator-budget";
import { applyAutoReviewModelOverride, applyConfiguredAutoReviewModelOverride, isViableAutoReviewEntry } from "../../src/codex/catalog/auto-review";
import { CATALOG_INACTIVE_REASON_FIELD } from "../../src/codex/catalog/subagent-roster";
import type { OcxParsedRequest, OcxProviderConfig } from "../../src/types";

const createResponsesPassthroughAdapter = (...args: Parameters<typeof createResponsesPassthroughAdapterProduction>) =>
  withTestTranslatorBudget(createResponsesPassthroughAdapterProduction(...args));

describe("review request degradation for non-native structured output models", () => {
  const schemaFormat = {
    type: "json_schema",
    json_schema: { name: "review_decision", schema: { type: "object" }, strict: true },
  };

  const provider = (overrides: Partial<OcxProviderConfig> = {}): OcxProviderConfig => ({
    adapter: "openai-chat",
    baseUrl: "https://api.example.com/v1",
    authKind: "key",
    apiKey: "test-key",
    ...overrides,
  });

  test("openai-chat passthrough downgrades json_schema to json_object for noJsonSchemaModels", () => {
    const req = buildOpenAIChatPassthroughRequest(
      provider({ noJsonSchemaModels: ["deepseek-v4.1-flash", "deepseek-v4-flash"] }),
      { messages: [{ role: "user", content: "review" }], response_format: schemaFormat },
      "deepseek-flash",
      false,
    );
    const body = JSON.parse(req.body as string);
    expect(body.response_format).toEqual({ type: "json_object" });
  });

  test("openai-chat passthrough handles provider-prefixed modelId", () => {
    const req = buildOpenAIChatPassthroughRequest(
      provider({ noJsonSchemaModels: ["deepseek-v4.1-flash", "deepseek-v4-flash"] }),
      { messages: [{ role: "user", content: "review" }], response_format: schemaFormat },
      "OG/deepseek-flash",
      false,
    );
    const body = JSON.parse(req.body as string);
    expect(body.response_format).toEqual({ type: "json_object" });
  });

  test("openai-chat translated request downgrades textFormat json_schema to json_object", () => {
    const adapter = createOpenAIChatAdapter(provider({ noJsonSchemaModels: ["deepseek-v4.1-flash", "deepseek-v4-flash"] }));
    const req = adapter.buildRequest({
      modelId: "OG/deepseek-flash",
      context: { messages: [{ role: "user", content: "review", timestamp: 0 }] },
      options: { textFormat: { type: "json_schema", name: "review_decision", schema: { type: "object" }, strict: true } },
      stream: false,
    });
    const body = JSON.parse(req.body as string);
    expect(body.response_format).toEqual({ type: "json_object" });
  });

  test("openai-responses passthrough downgrades text.format to json_object on noJsonSchemaModels", () => {
    const responsesProvider: OcxProviderConfig = {
      adapter: "openai-responses",
      baseUrl: "https://api.deepseek.com",
      authKind: "key",
      apiKey: "test-key",
      noJsonSchemaModels: ["deepseek-flash", "deepseek-v4-flash"],
    };
    const rawBody = {
      model: "deepseek-flash",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "review this" }] }],
      text: {
        format: {
          type: "json_schema",
          name: "review_decision",
          schema: { type: "object" },
          strict: true,
        },
      },
    };
    const parsedReq: OcxParsedRequest = {
      modelId: "deepseek-flash",
      context: { messages: [{ role: "user", content: "review this", timestamp: 0 }] },
      stream: false,
      options: {},
      _rawBody: rawBody,
    };
    const adapter = createResponsesPassthroughAdapter(responsesProvider);
    const req = adapter.buildRequest(parsedReq, { headers: new Headers() });
    const body = JSON.parse(req.body as string);
    expect(body.text.format).toEqual({ type: "json_object" });
  });

  test("openai-responses passthrough drops text.format when model is in noStructuredOutputModels", () => {
    const responsesProvider: OcxProviderConfig = {
      adapter: "openai-responses",
      baseUrl: "https://api.example.com",
      authKind: "key",
      apiKey: "test-key",
      noStructuredOutputModels: ["plain-model"],
    };
    const rawBody = {
      model: "plain-model",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "test" }] }],
      text: {
        format: {
          type: "json_schema",
          name: "review_decision",
          schema: { type: "object" },
        },
      },
    };
    const parsedReq: OcxParsedRequest = {
      modelId: "plain-model",
      context: { messages: [{ role: "user", content: "test", timestamp: 0 }] },
      stream: false,
      options: {},
      _rawBody: rawBody,
    };
    const adapter = createResponsesPassthroughAdapter(responsesProvider);
    const req = adapter.buildRequest(parsedReq, { headers: new Headers() });
    const body = JSON.parse(req.body as string);
    expect(body.text).toBeUndefined();
  });
});

describe("auto-review fault tolerance protection", () => {
  test("isViableAutoReviewEntry rejects entries with inactive reason", () => {
    expect(isViableAutoReviewEntry(undefined)).toBe(false);
    expect(isViableAutoReviewEntry({ slug: "gpt-5.6-luna" })).toBe(true);
    expect(isViableAutoReviewEntry({
      slug: "broken/model",
      [CATALOG_INACTIVE_REASON_FIELD]: "quota_exhausted",
    })).toBe(false);
    expect(isViableAutoReviewEntry({
      slug: "broken/model",
      [CATALOG_INACTIVE_REASON_FIELD]: "   ",
    })).toBe(true);
  });

  test("applyAutoReviewModelOverride does not stamp inactive models and preserves upstream behavior", () => {
    const entries = [
      { slug: "gpt-5.5", auto_review_model_override: null },
      { slug: "bad/reviewer", auto_review_model_override: null, [CATALOG_INACTIVE_REASON_FIELD]: "quota_exhausted" },
    ];

    const res = applyAutoReviewModelOverride(entries, "bad/reviewer");
    expect(res).toBe("unresolved");
    expect(entries[0].auto_review_model_override).toBeNull();
    expect(entries[1].auto_review_model_override).toBeNull();
  });

  test("applyConfiguredAutoReviewModelOverride skips inactive provider reviewers", () => {
    const entries = [
      { slug: "gpt-5.6-terra", auto_review_model_override: null },
      { slug: "myprov/main-model", auto_review_model_override: null },
      { slug: "myprov/reviewer", auto_review_model_override: null, [CATALOG_INACTIVE_REASON_FIELD]: "billing_disabled" },
    ];
    const config = {
      providers: {
        myprov: {
          autoReviewModel: "reviewer",
        },
      },
    };

    const res = applyConfiguredAutoReviewModelOverride(entries, null, config);
    expect(res).toBe("unresolved");
    expect(entries.find(e => e.slug === "myprov/main-model")?.auto_review_model_override).toBeNull();
  });
});
