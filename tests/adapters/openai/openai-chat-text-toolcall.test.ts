import { describe, expect, test } from "bun:test";
import { drainTextToolCalls, parseAllTextToolCalls, parseTextToolCallBlock } from "../../../src/adapters/openai-chat/text-toolcall";
import { createOpenAIChatAdapter as createOpenAIChatAdapterProduction } from "../../../src/adapters/openai-chat";
import { withTestTranslatorBudget } from "../../helpers/translator-budget";
import type { OcxParsedRequest, OcxProviderConfig } from "../../../src/types";

const createOpenAIChatAdapter = (...args: Parameters<typeof createOpenAIChatAdapterProduction>) =>
  withTestTranslatorBudget(createOpenAIChatAdapterProduction(...args));

describe("openai-chat text tool call extractor", () => {
  test("parses standard MiMo xml tool call block with parameter tags", () => {
    const block = `<function=exec><parameter=cmd>ls -la</parameter><parameter=workdir>/tmp</parameter></function>`;
    const parsed = parseTextToolCallBlock(block);
    expect(parsed).not.toBeNull();
    expect(parsed!.name).toBe("exec");
    expect(JSON.parse(parsed!.args)).toEqual({ cmd: "ls -la", workdir: "/tmp" });
  });

  test("parses bare closing parameter tag without parameter name attribute (observed in Issue #5)", () => {
    const block = `<function=exec>const results = await Promise.allSettled([\n  tools.exec_command({cmd:"pwd"})\n]);\n</parameter></function>`;
    const parsed = parseTextToolCallBlock(block);
    expect(parsed).not.toBeNull();
    expect(parsed!.name).toBe("exec");
    expect(JSON.parse(parsed!.args)).toEqual({
      input: "const results = await Promise.allSettled([\n  tools.exec_command({cmd:\"pwd\"})\n]);\n",
    });
  });

  test("parses json payload inside function tag without parameter tag", () => {
    const block = `<function=exec>{"cmd":"whoami"}</function>`;
    const parsed = parseTextToolCallBlock(block);
    expect(parsed).not.toBeNull();
    expect(parsed!.name).toBe("exec");
    expect(JSON.parse(parsed!.args)).toEqual({ cmd: "whoami" });
  });

  test("drains complete tool call block and strips it from prose", () => {
    const text = 'I will execute the command now:<tool_call><function=exec><parameter=cmd>ls</parameter></function></tool_call> Done!';
    const drained = drainTextToolCalls("", text);
    expect(drained.text).toBe("I will execute the command now: Done!");
    expect(drained.pending).toBe("");
    expect(drained.calls.length).toBe(1);
    expect(drained.calls[0]?.name).toBe("exec");
    expect(JSON.parse(drained.calls[0]?.args ?? "{}")).toEqual({ cmd: "ls" });
  });

  test("holds incomplete opener across streaming chunks then promotes when closed", () => {
    const chunk1 = "Starting analysis: <tool_";
    const d1 = drainTextToolCalls("", chunk1);
    expect(d1.text).toBe("Starting analysis: ");
    expect(d1.pending).toBe("<tool_");
    expect(d1.calls).toEqual([]);

    const chunk2 = "call><function=exec><parameter=cmd>uname</parameter></function></tool_call>";
    const d2 = drainTextToolCalls(d1.pending, chunk2);
    expect(d2.text).toBe("");
    expect(d2.pending).toBe("");
    expect(d2.calls.length).toBe(1);
    expect(d2.calls[0]?.name).toBe("exec");
    expect(JSON.parse(d2.calls[0]?.args ?? "{}")).toEqual({ cmd: "uname" });
  });

  test("holds incomplete body across chunks then emits when closing tag arrives", () => {
    const chunk1 = "<tool_call><function=exec><parameter=cmd>echo hello";
    const d1 = drainTextToolCalls("", chunk1);
    expect(d1.text).toBe("");
    expect(d1.pending).toBe(chunk1);
    expect(d1.calls).toEqual([]);

    const chunk2 = "</parameter></function></tool_call> and after text";
    const d2 = drainTextToolCalls(d1.pending, chunk2);
    expect(d2.text).toBe(" and after text");
    expect(d2.pending).toBe("");
    expect(d2.calls.length).toBe(1);
    expect(d2.calls[0]?.name).toBe("exec");
    expect(JSON.parse(d2.calls[0]?.args ?? "{}")).toEqual({ cmd: "echo hello" });
  });

  test("parseAllTextToolCalls cleans full content string and extracts calls", () => {
    const content = 'Some preamble\n<tool_call><function=exec><parameter=input>console.log(1);</parameter></function></tool_call>\nPostamble.';
    const result = parseAllTextToolCalls(content);
    expect(result.text).toBe("Some preamble\n\nPostamble.");
    expect(result.calls.length).toBe(1);
    expect(result.calls[0]?.name).toBe("exec");
    expect(JSON.parse(result.calls[0]?.args ?? "{}")).toEqual({ input: "console.log(1);" });
  });

  test("openai-chat adapter streaming transforms textual tool call into tool_call_start/delta/end events", async () => {
    const provider: OcxProviderConfig = {
      id: "test-opencode",
      baseUrl: "https://opencode.ai/zen/go/v1",
      adapter: "openai-chat",
      apiKey: "test-key",
    };
    const adapter = createOpenAIChatAdapter(provider);
    const streamPayload = [
      'data: {"id":"chatcmpl-1","choices":[{"delta":{"content":"Hello <tool_call><function=exec>"},"index":0}]}\n\n',
      'data: {"id":"chatcmpl-1","choices":[{"delta":{"content":"<parameter=cmd>date</parameter></function></tool_call>"},"index":0}]}\n\n',
      'data: {"id":"chatcmpl-1","choices":[{"delta":{},"finish_reason":"stop","index":0}]}\n\n',
      'data: [DONE]\n\n',
    ].join("");

    const response = new Response(streamPayload, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });

    const parsed: OcxParsedRequest = {
      provider: "test-opencode",
      modelId: "mimo-v2.6-flash",
      stream: true,
      context: { messages: [{ role: "user", content: "run date" }] },
      options: {},
    };

    const events = [];
    for await (const event of adapter.parseStream(response)) {
      events.push(event);
    }

    const textEvents = events.filter(e => e.type === "text_delta");
    const startEvents = events.filter(e => e.type === "tool_call_start");
    const deltaEvents = events.filter(e => e.type === "tool_call_delta");
    const endEvents = events.filter(e => e.type === "tool_call_end");

    expect(textEvents.map(e => (e as { text: string }).text).join("")).toBe("Hello ");
    expect(startEvents.length).toBe(1);
    expect((startEvents[0] as { name: string }).name).toBe("exec");
    expect(deltaEvents.length).toBe(1);
    expect(JSON.parse((deltaEvents[0] as { arguments: string }).arguments)).toEqual({ cmd: "date" });
    expect(endEvents.length).toBe(1);
  });

  test("openai-chat adapter non-streaming parseResponse transforms textual tool call into tool_call_start/delta/end events", async () => {
    const provider: OcxProviderConfig = {
      id: "test-opencode",
      baseUrl: "https://opencode.ai/zen/go/v1",
      adapter: "openai-chat",
      apiKey: "test-key",
    };
    const adapter = createOpenAIChatAdapter(provider);
    const rawPayload = {
      choices: [
        {
          message: {
            role: "assistant",
            content: 'Running command now: <tool_call><function=exec><parameter=cmd>hostname</parameter></function></tool_call> finished.',
          },
          finish_reason: "stop",
        },
      ],
    };

    const response = new Response(JSON.stringify(rawPayload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

    const events = await adapter.parseResponse!(response);

    const textEvents = events.filter(e => e.type === "text_delta");
    const startEvents = events.filter(e => e.type === "tool_call_start");
    const deltaEvents = events.filter(e => e.type === "tool_call_delta");
    const endEvents = events.filter(e => e.type === "tool_call_end");

    expect(textEvents.map(e => (e as { text: string }).text).join("")).toBe("Running command now:  finished.");
    expect(startEvents.length).toBe(1);
    expect((startEvents[0] as { name: string }).name).toBe("exec");
    expect(deltaEvents.length).toBe(1);
    expect(JSON.parse((deltaEvents[0] as { arguments: string }).arguments)).toEqual({ cmd: "hostname" });
    expect(endEvents.length).toBe(1);
  });
});
