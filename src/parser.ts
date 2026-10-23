import { gunzipSync } from "fflate";
import {
  ParsedRnoteDocument,
  StrokeComponent,
  DocumentBackground,
  DocumentFormat,
} from "./types";

/**
 * Checks whether the buffer starts with GZIP magic bytes (0x1f, 0x8b).
 */
export function isGzipBuffer(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

/**
 * Decompresses a GZIP buffer using fflate with fallback to native DecompressionStream.
 */
export async function decompressGzip(data: ArrayBuffer | Uint8Array): Promise<Uint8Array> {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);

  // If not GZIP compressed (e.g. raw JSON file), return bytes directly
  if (!isGzipBuffer(bytes)) {
    return bytes;
  }

  // Fast path: synchronous decompress with fflate
  try {
    return gunzipSync(bytes);
  } catch (fflateErr) {
    // Fallback: browser / Web native DecompressionStream if available
    if (typeof DecompressionStream !== "undefined") {
      try {
        const stream = new Response(bytes as unknown as BodyInit).body?.pipeThrough(
          new DecompressionStream("gzip")
        );
        if (stream) {
          const decompressedBuffer = await new Response(stream).arrayBuffer();
          return new Uint8Array(decompressedBuffer);
        }
      } catch (streamErr) {
        throw new Error(
          `Failed to decompress .rnote file: ${
            fflateErr instanceof Error ? fflateErr.message : String(fflateErr)
          }`
        );
      }
    }
    throw new Error(
      `Failed to decompress .rnote file: ${
        fflateErr instanceof Error ? fflateErr.message : String(fflateErr)
      }`
    );
  }
}

/**
 * Extracts and normalizes stroke components from any format variation.
 */
function normalizeStrokeComponent(item: unknown): StrokeComponent | null {
  if (!item || typeof item !== "object") return null;

  // Handle SlotMap tuple: [key, stroke]
  if (Array.isArray(item)) {
    if (item.length === 2 && item[1] && typeof item[1] === "object") {
      return normalizeStrokeComponent(item[1]);
    }
    return null;
  }

  const obj = item as Record<string, unknown>;

  // If component is wrapped in "value": { ... }
  if ("value" in obj) {
    if (obj.value === null || obj.value === undefined) {
      return null;
    }
    if (typeof obj.value === "object") {
      return obj as StrokeComponent;
    }
  }

  // If component directly contains stroke fields: brushstroke, shapestroke, etc.
  if (
    obj.brushstroke ||
    obj.shapestroke ||
    obj.textstroke ||
    obj.bitmapimage ||
    obj.vectorimage
  ) {
    return {
      value: obj as StrokeComponent["value"],
      ...obj,
    };
  }

  return null;
}

/**
 * Parses a .rnote file binary buffer into a normalized ParsedRnoteDocument.
 */
export async function parseRnoteFile(
  data: ArrayBuffer | Uint8Array
): Promise<ParsedRnoteDocument> {
  if (!data || (data instanceof Uint8Array ? data.length === 0 : data.byteLength === 0)) {
    throw new Error("Empty .rnote file");
  }

  const decompressed = await decompressGzip(data);
  let jsonString: string;
  try {
    jsonString = new TextDecoder("utf-8").decode(decompressed);
  } catch (err) {
    throw new Error(`Failed to decode .rnote content as UTF-8: ${err}`);
  }

  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(jsonString);
  } catch (err) {
    throw new Error(`Invalid .rnote file: Malformed JSON structure (${err})`);
  }

  if (!raw || typeof raw !== "object") {
    throw new Error("Invalid .rnote file: Root JSON must be an object");
  }

  // Version extraction
  const version = typeof raw.version === "string" ? raw.version : "unknown";

  // Engine snapshot extraction (resilient across all Rnote versions)
  const engineSnapshot =
    (raw.engine_snapshot as Record<string, unknown>) ??
    ((raw.data as Record<string, unknown>)?.engine_snapshot as Record<string, unknown>) ??
    (raw.store_snapshot as Record<string, unknown>) ??
    ((raw.data as Record<string, unknown>)?.store_snapshot as Record<string, unknown>) ??
    (((raw.data as Record<string, unknown>)?.snapshot as Record<string, unknown> | undefined)?.engine_snapshot as Record<string, unknown>) ??
    raw;

  let rawComponents: unknown = null;
  if (engineSnapshot && typeof engineSnapshot === "object") {
    rawComponents =
      engineSnapshot.stroke_components ??
      engineSnapshot.strokes ??
      (engineSnapshot.store_snapshot as Record<string, unknown>)?.stroke_components;
  }

  // Fallback: search root and data
  if (!rawComponents) {
    const rawData = raw.data as Record<string, unknown> | undefined;
    rawComponents =
      raw.stroke_components ??
      raw.strokes ??
      rawData?.stroke_components ??
      rawData?.strokes ??
      null;
  }

  const components: StrokeComponent[] = [];
  if (Array.isArray(rawComponents)) {
    for (const item of rawComponents) {
      const comp = normalizeStrokeComponent(item);
      if (comp) components.push(comp);
    }
  } else if (rawComponents && typeof rawComponents === "object") {
    // If components are stored as a dictionary { [id]: StrokeComponent }
    for (const val of Object.values(rawComponents)) {
      const comp = normalizeStrokeComponent(val);
      if (comp) components.push(comp);
    }
  }

  // Extract document snapshot / background / layout
  const docObj =
    (engineSnapshot.document as Record<string, unknown>) ??
    (raw.document as Record<string, unknown>) ??
    ((raw.data as Record<string, unknown>)?.document_snapshot as Record<string, unknown>) ??
    ((raw.data as Record<string, unknown>)?.document as Record<string, unknown>) ??
    null;

  let background: DocumentBackground | undefined;
  let format: DocumentFormat | undefined;
  let documentBounds: { x: number; y: number; width: number; height: number } | undefined;

  if (docObj && typeof docObj === "object") {
    // Check if bounds x, y, width, height exist
    const w = typeof docObj.width === "number" ? docObj.width : undefined;
    const h = typeof docObj.height === "number" ? docObj.height : undefined;
    const x = typeof docObj.x === "number" ? docObj.x : 0;
    const y = typeof docObj.y === "number" ? docObj.y : 0;
    if (w && h && w > 0 && h > 0) {
      documentBounds = { x, y, width: w, height: h };
    }

    const config = (docObj.config as Record<string, unknown>) ?? docObj;
    if (config.background && typeof config.background === "object") {
      background = config.background as DocumentBackground;
    }
    if (config.format && typeof config.format === "object") {
      format = config.format as DocumentFormat;
    }
  }

  return {
    version,
    components,
    background,
    format,
    documentBounds,
  };
}
