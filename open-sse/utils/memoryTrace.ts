type JsonRecord = Record<string, unknown>;

const MB = 1024 * 1024;
const DATA_IMAGE_PREFIX = "data:image/";

export function isMemoryTraceEnabled(): boolean {
  const value = String(process.env.OMNIROUTE_MEMTRACE ?? "").trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

function scan(value: unknown, seen: Set<object>, depth = 0): {
  images: number;
  imageChars: number;
  strings: number;
} {
  if (depth > 64 || value == null) return { images: 0, imageChars: 0, strings: 0 };

  if (typeof value === "string") {
    const isImage = value.startsWith(DATA_IMAGE_PREFIX) && value.includes(";base64,");
    return {
      images: isImage ? 1 : 0,
      imageChars: isImage ? value.length : 0,
      strings: value.length,
    };
  }

  if (typeof value !== "object") return { images: 0, imageChars: 0, strings: 0 };
  if (seen.has(value as object)) return { images: 0, imageChars: 0, strings: 0 };
  seen.add(value as object);

  let images = 0;
  let imageChars = 0;
  let strings = 0;

  const values = Array.isArray(value)
    ? value
    : Object.values(value as JsonRecord);

  for (const child of values) {
    const result = scan(child, seen, depth + 1);
    images += result.images;
    imageChars += result.imageChars;
    strings += result.strings;
  }

  return { images, imageChars, strings };
}

export function memoryTrace(
  stage: string,
  payload?: unknown,
  extra: Record<string, unknown> = {}
): void {
  if (!isMemoryTraceEnabled()) return;

  const m = process.memoryUsage();
  const media = payload === undefined
    ? { images: 0, imageChars: 0, strings: 0 }
    : scan(payload, new Set<object>());

  console.error("[MEMTRACE]", JSON.stringify({
    ts: new Date().toISOString(),
    stage,
    rssMB: Math.round(m.rss / MB),
    heapUsedMB: Math.round(m.heapUsed / MB),
    heapTotalMB: Math.round(m.heapTotal / MB),
    externalMB: Math.round(m.external / MB),
    arrayBuffersMB: Math.round(m.arrayBuffers / MB),
    images: media.images,
    imageDataUriChars: media.imageChars,
    imageApproxMB: Math.round((media.imageChars * 3 / 4) / MB * 100) / 100,
    stringChars: media.strings,
    ...extra,
  }));
}
