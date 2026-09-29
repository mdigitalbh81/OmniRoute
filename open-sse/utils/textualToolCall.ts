import { stripObfuscationZeroWidth } from "./zeroWidth.ts";

export function stripZeroWidth(value: unknown): unknown {
  if (typeof value === "string") {
    return stripObfuscationZeroWidth(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => stripZeroWidth(item));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        stripZeroWidth(item),
      ])
    );
  }
  return value;
}


const XML_TOOL_CALL_OPEN = "<tool_call>";
const XML_TOOL_CALL_CLOSE = "</tool_call>";

function parseXmlToolCallPayload(raw: string):
  | { kind: "complete"; name: string; args: unknown }
  | { kind: "partial" }
  | null {
  const normalized = stripObfuscationZeroWidth(raw);
  const lower = normalized.toLowerCase();
  const openIndex = lower.indexOf(XML_TOOL_CALL_OPEN);
  if (openIndex < 0) {
    const lastLt = lower.lastIndexOf("<");
    if (lastLt >= 0 && XML_TOOL_CALL_OPEN.startsWith(lower.slice(lastLt))) {
      return { kind: "partial" };
    }
    return null;
  }

  const bodyStart = openIndex + XML_TOOL_CALL_OPEN.length;
  const closeIndex = lower.indexOf(XML_TOOL_CALL_CLOSE, bodyStart);
  if (closeIndex < 0) return { kind: "partial" };

  const payload = normalized.slice(bodyStart, closeIndex).trim();
  if (!payload) return null;

  try {
    const parsed = JSON.parse(payload) as Record<string, unknown>;
    const name = typeof parsed?.name === "string" ? parsed.name.trim() : "";
    if (!name) return null;

    let args: unknown = parsed.arguments ?? parsed.args ?? {};
    if (typeof args === "string") {
      const trimmed = args.trim();
      if (trimmed) {
        try {
          args = JSON.parse(trimmed);
        } catch {
          args = { input: args };
        }
      } else {
        args = {};
      }
    }

    return { kind: "complete", name, args: stripZeroWidth(args) };
  } catch {
    // A fully closed but invalid XML-style payload is prose, not an incomplete
    // streaming fragment. Let the caller surface it instead of buffering forever.
    return null;
  }
}

export function findTextualToolCallStart(text: unknown): number {
  if (typeof text !== "string") return -1;
  const normalized = stripObfuscationZeroWidth(text);
  const lower = normalized.toLowerCase();
  const candidates = [
    normalized.indexOf("(empty)[Tool call:"),
    normalized.indexOf("[Tool call:"),
    lower.indexOf(XML_TOOL_CALL_OPEN),
  ].filter((index) => index >= 0);
  return candidates.length > 0 ? Math.min(...candidates) : -1;
}

export function isValidToolCallHeaderPrefix(candidate: string): boolean {
  if (!candidate.startsWith("[Tool call:")) return false;

  const bracketIndex = candidate.indexOf("]");
  if (bracketIndex === -1) {
    const namePart = candidate.slice("[Tool call:".length);
    if (namePart.includes("\n") || namePart.includes("[")) return false;
    return true;
  }

  const namePart = candidate.slice("[Tool call:".length, bracketIndex);
  if (namePart.includes("\n") || namePart.trim().length === 0) return false;

  const afterBracket = candidate.slice(bracketIndex + 1);
  const leadingWhitespaceMatch = afterBracket.match(/^[\s\r\n]*/);
  const leadingWhitespace = leadingWhitespaceMatch ? leadingWhitespaceMatch[0] : "";
  const textAfterWhitespace = afterBracket.slice(leadingWhitespace.length);

  if (textAfterWhitespace.length === 0) {
    return true;
  }

  if (!leadingWhitespace.includes("\n")) {
    return false;
  }

  const expectedText = "Arguments:";
  if (expectedText.startsWith(textAfterWhitespace)) {
    return true;
  }

  if (textAfterWhitespace.startsWith(expectedText)) {
    return true;
  }

  return false;
}

export function parseTextualToolCallCandidate(
  text: unknown
): { kind: "complete"; name: string; args: unknown } | { kind: "partial" } | null {
  if (typeof text !== "string") return null;
  const normalized = stripObfuscationZeroWidth(text);
  const xmlCandidate = parseXmlToolCallPayload(normalized);
  if (xmlCandidate) return xmlCandidate;
  const toolCallIndex = normalized.lastIndexOf("[Tool call:");
  if (toolCallIndex < 0) {
    const lastParen = normalized.lastIndexOf("(");
    if (lastParen !== -1 && "(empty)[Tool call:".startsWith(normalized.slice(lastParen))) {
      return { kind: "partial" };
    }
    const lastBracket = normalized.lastIndexOf("[");
    if (lastBracket !== -1 && "[Tool call:".startsWith(normalized.slice(lastBracket))) {
      return { kind: "partial" };
    }
    return null;
  }
  const candidate = normalized.slice(toolCallIndex);
  if (!isValidToolCallHeaderPrefix(candidate)) {
    return null;
  }
  const headerMatch = candidate.match(/^\[Tool call:\s*([^\]\n]+)\]\s*\nArguments:\s*/);
  if (!headerMatch) return { kind: "partial" };
  const name = headerMatch[1]?.trim();
  const rawArgs = candidate.slice(headerMatch[0].length).trim();
  if (!name || !rawArgs) return { kind: "partial" };
  const decoders = [
    (value: string) => value,
    (value: string) => {
      if (value.startsWith('"') && value.endsWith('"')) {
        const decoded = JSON.parse(value);
        return typeof decoded === "string" ? decoded : value;
      }
      return value;
    },
  ];
  for (const decode of decoders) {
    try {
      const decoded = decode(rawArgs);
      const parsed = JSON.parse(decoded);
      return { kind: "complete", name, args: stripZeroWidth(parsed) };
    } catch {}
  }
  return { kind: "partial" };
}

export function containsTextualToolCallMarker(text: unknown): boolean {
  if (typeof text !== "string") return false;
  const normalized = stripObfuscationZeroWidth(text);
  const lower = normalized.toLowerCase();

  if (lower.includes(XML_TOOL_CALL_OPEN) || lower.includes(XML_TOOL_CALL_CLOSE)) return true;

  if (!normalized.includes("[Tool call:")) {
    const trimmedLower = lower.trim();
    return XML_TOOL_CALL_OPEN.startsWith(trimmedLower);
  }
  if (normalized.includes("Arguments:")) return true;

  const trimmed = normalized.trim();
  return trimmed.startsWith("[Tool call:") || trimmed.startsWith("(empty)[Tool call:");
}
