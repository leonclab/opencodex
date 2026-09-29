import { describe, expect, test } from "bun:test";
import { createResponsesPassthroughAdapter as createResponsesPassthroughAdapterProduction } from "../../src/adapters/openai-responses";
import {
  clampResponsesMinOutputTokens,
  clampResponsesMaxOutputTokens,
  MIN_RESPONSES_MAX_OUTPUT_TOKENS,
} from "../../src/adapters/openai-responses/request-strips";
import type { OcxProviderConfig } from "../../src/types";
import { withTestTranslatorBudget } from "../helpers/translator-budget";

const createResponsesPassthroughAdapter = (
  ...args: Parameters<typeof createResponsesPassthroughAdapterProduction>
) => withTestTranslatorBudget(createResponsesPassthroughAdapterProduction(...args));

const META_MUSE_KEY_PROVIDER: OcxProviderConfig = {
  adapter: "openai-responses",
  baseUrl: "https://api.meta.ai/v1",
  authMode: "key",
  apiKey: "test-meta-key",
};

const GENERIC_RESPONSES_KEY_PROVIDER: OcxProviderConfig = {
  adapter: "openai-responses",
  baseUrl: "https://example.com/v1",
  authMode: "key",
  apiKey: "test-key",
};

function sentBody(provider: OcxProviderConfig, rawBody: Record<string, unknown>, options: Record<string, unknown> = {}) {
  const request = createResponsesPassthroughAdapter(provider).buildRequest({
    modelId: String(rawBody.model ?? "muse-spark-1.3-contributor"),
    context: { messages: [] },
    stream: false,
    options,
    _rawBody: rawBody,
  }, { headers: new Headers({ authorization: "Bearer token" }) });
  return JSON.parse(request.body) as Record<string, unknown>;
}

describe("clampResponsesMinOutputTokens unit tests", () => {
  test("clamps max_output_tokens in range [1, 16) upward to 16", () => {
    expect(clampResponsesMinOutputTokens({ max_output_tokens: 1 })).toEqual({ max_output_tokens: 16 });
    expect(clampResponsesMinOutputTokens({ max_output_tokens: 10 })).toEqual({ max_output_tokens: 16 });
    expect(clampResponsesMinOutputTokens({ max_output_tokens: 15 })).toEqual({ max_output_tokens: 16 });
    expect(clampResponsesMinOutputTokens({ max_output_tokens: 15.5 })).toEqual({ max_output_tokens: 16 });
  });

  test("leaves max_output_tokens >= 16 untouched", () => {
    const body16 = { max_output_tokens: 16 };
    expect(clampResponsesMinOutputTokens(body16)).toBe(body16);

    const body100 = { max_output_tokens: 100 };
    expect(clampResponsesMinOutputTokens(body100)).toBe(body100);
  });

  test("leaves omitted, zero, negative or non-numeric max_output_tokens untouched", () => {
    const empty = { model: "m" };
    expect(clampResponsesMinOutputTokens(empty)).toBe(empty);

    const zero = { max_output_tokens: 0 };
    expect(clampResponsesMinOutputTokens(zero)).toBe(zero);

    const neg = { max_output_tokens: -1 };
    expect(clampResponsesMinOutputTokens(neg)).toBe(neg);

    const str = { max_output_tokens: "1" };
    expect(clampResponsesMinOutputTokens(str)).toBe(str);

    const nanVal = { max_output_tokens: NaN };
    expect(clampResponsesMinOutputTokens(nanVal)).toBe(nanVal);
  });

  test("does not mutate original caller-owned body when clamped", () => {
    const original = { model: "m", max_output_tokens: 1 };
    const clamped = clampResponsesMinOutputTokens(original) as Record<string, unknown>;
    expect(original.max_output_tokens).toBe(1);
    expect(clamped.max_output_tokens).toBe(16);
    expect(clamped).not.toBe(original);
  });

  test("supports alias clampResponsesMaxOutputTokens and custom minTokens", () => {
    expect(clampResponsesMaxOutputTokens({ max_output_tokens: 1 })).toEqual({ max_output_tokens: 16 });
    expect(clampResponsesMinOutputTokens({ max_output_tokens: 5 }, 32)).toEqual({ max_output_tokens: 32 });
    expect(MIN_RESPONSES_MAX_OUTPUT_TOKENS).toBe(16);
  });
});

describe("openai-responses passthrough adapter defensive clamping", () => {
  test("defensively clamps max_output_tokens: 1 to 16 for Meta Muse Responses provider", () => {
    const rawBody = {
      model: "muse-spark-1.3-contributor",
      input: "ping",
      max_output_tokens: 1,
      stream: false,
    };
    const sent = sentBody(META_MUSE_KEY_PROVIDER, rawBody);
    expect(sent.max_output_tokens).toBe(16);
    // Caller-owned raw body is untouched
    expect(rawBody.max_output_tokens).toBe(1);
  });

  test("defensively clamps max_output_tokens between 1 and 15 to 16", () => {
    for (const tokens of [1, 2, 8, 15]) {
      const sent = sentBody(GENERIC_RESPONSES_KEY_PROVIDER, {
        model: "gpt-5.6-luna",
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
        max_output_tokens: tokens,
      });
      expect(sent.max_output_tokens).toBe(16);
    }
  });

  test("preserves valid max_output_tokens >= 16 without modification", () => {
    const sent16 = sentBody(GENERIC_RESPONSES_KEY_PROVIDER, {
      model: "gpt-5.6-luna",
      input: "ping",
      max_output_tokens: 16,
    });
    expect(sent16.max_output_tokens).toBe(16);

    const sent1000 = sentBody(GENERIC_RESPONSES_KEY_PROVIDER, {
      model: "gpt-5.6-luna",
      input: "ping",
      max_output_tokens: 1000,
    });
    expect(sent1000.max_output_tokens).toBe(1000);
  });

  test("preserves omitted max_output_tokens", () => {
    const sent = sentBody(GENERIC_RESPONSES_KEY_PROVIDER, {
      model: "gpt-5.6-luna",
      input: "ping",
    });
    expect(sent).not.toHaveProperty("max_output_tokens");
  });

  test("clamps parsed.options.maxOutputTokens when in range [1, 16)", () => {
    const options: Record<string, unknown> = { maxOutputTokens: 1 };
    sentBody(GENERIC_RESPONSES_KEY_PROVIDER, {
      model: "gpt-5.6-luna",
      input: "ping",
      max_output_tokens: 1,
    }, options);
    expect(options.maxOutputTokens).toBe(16);
  });
});
