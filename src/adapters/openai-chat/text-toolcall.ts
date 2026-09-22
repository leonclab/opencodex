/**
 * Extract textual pseudo tool-call markers emitted inside text_delta / content
 * by models such as MiMo 2.6 (on OpenCode / Zen gateways) and convert them
 * into structured tool call events.
 *
 * Wire format observed:
 * `<tool_call><function=NAME><parameter=KEY>VALUE</parameter></function></tool_call>`
 * (or variants where parameter tag is omitted or VALUE is JSON).
 */

export const MAX_PENDING_TEXT_TOOLCALL_BYTES = 64 * 1024;

export interface DrainedTextToolCall {
  readonly name: string;
  readonly args: string;
}

export interface DrainTextToolCallsResult {
  readonly text: string;
  readonly pending: string;
  readonly calls: readonly DrainedTextToolCall[];
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

/**
 * Parse the inner contents of a `<tool_call>...</tool_call>` block into function name and JSON arguments.
 */
export function parseTextToolCallBlock(block: string): DrainedTextToolCall | null {
  const fnMatch = block.match(/^\s*<function=([^>\s]+)>/);
  if (!fnMatch) return null;
  const name = fnMatch[1];
  if (!name) return null;

  const afterFn = block.slice(fnMatch[0].length);
  const endFnIdx = afterFn.lastIndexOf("</function>");
  const inner = endFnIdx !== -1 ? afterFn.slice(0, endFnIdx) : afterFn;

  const paramRegex = /<parameter=([^>\s]+)>([\s\S]*?)(?:<\/parameter>|$)/g;
  let pMatch: RegExpExecArray | null;
  const params: Record<string, unknown> = {};
  let foundParams = false;

  while ((pMatch = paramRegex.exec(inner)) !== null) {
    foundParams = true;
    const pName = pMatch[1] ?? "";
    const pVal = pMatch[2] ?? "";
    try {
      params[pName] = JSON.parse(pVal);
    } catch {
      params[pName] = pVal;
    }
  }

  if (foundParams) {
    return { name, args: JSON.stringify(params) };
  }

  // Check for bare closing parameter tag without parameter name attribute: <function=exec>...code...</parameter></function>
  const bareParam = inner.match(/^([\s\S]*?)<\/parameter>/);
  if (bareParam) {
    const val = bareParam[1] ?? "";
    return { name, args: JSON.stringify({ input: val }) };
  }

  const trimmed = inner.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    try {
      JSON.parse(trimmed);
      return { name, args: trimmed };
    } catch {
      return { name, args: JSON.stringify({ input: trimmed }) };
    }
  }

  return { name, args: JSON.stringify({ input: trimmed }) };
}

/**
 * Fold `pending + chunk`, emit surrounding prose in `text`, and extract every complete
 * `<tool_call>...</tool_call>` block.
 *
 * Incomplete openers or split blocks across chunks are held in `pending` until closed,
 * capped at `MAX_PENDING_TEXT_TOOLCALL_BYTES`.
 */
export function drainTextToolCalls(
  pending: string,
  chunk: string,
): DrainTextToolCallsResult {
  const combined = pending + chunk;
  let cursor = 0;
  let text = "";
  const calls: DrainedTextToolCall[] = [];

  while (cursor < combined.length) {
    const openIdx = combined.indexOf("<tool_call>", cursor);
    if (openIdx === -1) {
      // Check if trailing slice could be a partial prefix of "<tool_call>"
      let partialMatchLen = 0;
      const maxPrefix = Math.min(10, combined.length - cursor);
      for (let len = maxPrefix; len >= 1; len--) {
        const candidate = combined.slice(combined.length - len);
        if ("<tool_call>".startsWith(candidate)) {
          partialMatchLen = len;
          break;
        }
      }
      if (partialMatchLen > 0) {
        text += combined.slice(cursor, combined.length - partialMatchLen);
        return { text, pending: combined.slice(combined.length - partialMatchLen), calls };
      }
      text += combined.slice(cursor);
      return { text, pending: "", calls };
    }

    // Emit prose preceding <tool_call>
    text += combined.slice(cursor, openIdx);

    const closeIdx = combined.indexOf("</tool_call>", openIdx + 11);
    if (closeIdx === -1) {
      const hold = combined.slice(openIdx);
      if (byteLength(hold) > MAX_PENDING_TEXT_TOOLCALL_BYTES) {
        // Exceeded cap: flush as text to prevent unbounded buffering
        text += hold;
        return { text, pending: "", calls };
      }
      return { text, pending: hold, calls };
    }

   const block = combined.slice(openIdx + 11, closeIdx);
   cursor = closeIdx + 12;

   const parsed = parseTextToolCallBlock(block);
   if (parsed) {
     calls.push(parsed);
   }
 }

 return { text, pending: "", calls };
}

export function parseAllTextToolCalls(content: string): { text: string; calls: readonly DrainedTextToolCall[] } {
  const drained = drainTextToolCalls("", content);
  const text = drained.text + drained.pending;
  return { text, calls: drained.calls };
}
