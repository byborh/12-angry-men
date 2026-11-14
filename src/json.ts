/** Narrowing helpers for JSON.parse output. Transcript lines are untrusted input. */

export type Obj = Record<string, unknown>;

export function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function str(o: Obj | undefined, key: string): string | undefined {
  const v = o?.[key];
  return typeof v === "string" ? v : undefined;
}

/** Usage fields are absent when a model reports no tokens of that kind, so absent means zero. */
export function count(o: Obj | undefined, key: string): number {
  const v = o?.[key];
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

export function obj(o: Obj | undefined, key: string): Obj | undefined {
  const v = o?.[key];
  return isObj(v) ? v : undefined;
}

export function list(o: Obj | undefined, key: string): unknown[] | undefined {
  const v = o?.[key];
  return Array.isArray(v) ? v : undefined;
}
