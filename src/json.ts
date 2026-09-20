/**
 * Type vocabulary and field accessors for wire payloads — client requests,
 * provider responses, SSE events — that arrive as parsed JSON and cannot be
 * fully trusted or fully typed.
 *
 * `JsonRecord` plus the accessors below replace `any`: every read is still a
 * runtime check, but a wrong field name or a missed non-object check now fails
 * the type checker instead of producing a silent undefined-at-runtime bug.
 * `undefined` is a member of `JsonValue` because optional JSON reads yield it.
 */
export type JsonValue = string | number | boolean | null | undefined | JsonValue[] | { [key: string]: JsonValue };
export type JsonRecord = { [key: string]: JsonValue };

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Object members of a JSON array, non-object entries dropped. */
export function asRecords(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

/** Narrow a parsed-JSON payload to a record; anything else reads as an empty object. */
export function jsonRecord(value: unknown): JsonRecord {
  return isRecord(value) ? value : {};
}

/** Named field reads, each undefined unless the payload carries the right type. */
export function recStr(obj: JsonRecord | undefined, key: string): string | undefined {
  const value = obj?.[key];
  return typeof value === "string" ? value : undefined;
}
export function recNum(obj: JsonRecord | undefined, key: string): number | undefined {
  const value = obj?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
/** Nested object field, undefined for arrays and non-objects. */
export function recObj(obj: JsonRecord | undefined, key: string): JsonRecord | undefined {
  const value = obj?.[key];
  return isRecord(value) ? value : undefined;
}
/** Nested array field as object members (see `asRecords`). */
export function recObjs(obj: JsonRecord | undefined, key: string): JsonRecord[] {
  return asRecords(obj?.[key]);
}
/**
 * A counter field (token usage, quota balance). Unlike `recNum` this accepts a
 * numeric string, because several providers serialize counts as `"123"` and a
 * usage row that reads 0 for a real response is worse than a coerced guess.
 */
export function recCount(obj: JsonRecord | undefined, key: string): number | undefined {
  const value = obj?.[key];
  if (value === undefined || value === null || value === "") return undefined;
  const num = typeof value === "number" ? value : Number(value);
  return Number.isFinite(num) ? num : undefined;
}

/** Best-effort JSON parse of a wire payload; malformed or absent input becomes `{}` rather than throwing. */
export function parseJson(value: unknown): JsonValue {
  try { return (typeof value === "string" ? JSON.parse(value) : value ?? {}) as JsonValue; } catch { return {}; }
}
