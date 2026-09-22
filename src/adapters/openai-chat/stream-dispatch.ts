import type { AdapterEvent } from "../../types";
import { drainTextToolCalls, parseAllTextToolCalls, type DrainTextToolCallsResult } from "./text-toolcall";
import type { OpenAIChatToolNameRegistry } from "./tool-name-registry";

export { drainTextToolCalls, parseAllTextToolCalls };

export function* emitDrainedTextToolEvents(
  drained: DrainTextToolCallsResult,
  toolNames: { restore(name: string): string },
  nextSeq: () => number,
): Generator<AdapterEvent, void> {
  if (drained.text.length > 0) {
    yield { type: "text_delta", text: drained.text };
  }
  for (const call of drained.calls) {
    const id = `call_${nextSeq()}`;
    yield { type: "tool_call_start", id, name: toolNames.restore(call.name) };
    if (call.args.length > 0) yield { type: "tool_call_delta", arguments: call.args };
    yield { type: "tool_call_end" };
  }
}

export function* flushPendingTextToolEvents(
  pendingText: string,
  toolNames: { restore(name: string): string },
  nextSeq: () => number,
): Generator<AdapterEvent, void> {
  if (pendingText.length === 0) return;
  if (pendingText.includes("<tool_call>")) {
    const closeIdx = pendingText.indexOf("</tool_call>");
    if (closeIdx === -1) {
      // Incomplete marker at end of stream: don't leak it as text
      return;
    }
  }
  yield { type: "text_delta", text: pendingText };
}

export function appendDrainedTextToolEvents(
  events: AdapterEvent[],
  text: string,
  calls: readonly { name: string; args: string }[],
  toolNames: { restore(name: string): string },
  nextSeq: () => number,
): void {
  if (text.length > 0) {
    events.push({ type: "text_delta", text });
  }
  for (const call of calls) {
    const id = `call_${nextSeq()}`;
    events.push({ type: "tool_call_start", id, name: toolNames.restore(call.name) });
    if (call.args.length > 0) events.push({ type: "tool_call_delta", arguments: call.args });
    events.push({ type: "tool_call_end" });
  }
}
