import type { JsonObject, JsonValue } from 'distributed-core/applications/document';
/** Runtime ownership/migration metadata is not source front matter. */
export const CANVAS_RESERVED_META = new Set(['title', 'schemaVersion', 'importSourceRevision', 'tenantId', 'documentId', 'createdBy']);
export function canvasFrontMatter(meta: Record<string, unknown>): JsonObject {
  const frontMatter: JsonObject = {};
  for (const [key, value] of Object.entries(meta)) {
    if (!CANVAS_RESERVED_META.has(key) && value !== undefined) frontMatter[key] = value as JsonValue;
  }
  return frontMatter;
}
