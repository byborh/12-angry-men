import { readdir } from "node:fs/promises";

export function isMissing(e: unknown): boolean {
  return e instanceof Error && "code" in e && (e.code === "ENOENT" || e.code === "ENOTDIR");
}

/** A missing folder is a normal case (no plugins, no project skills). Any other error propagates. */
export async function entriesIfExists(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch (e) {
    if (isMissing(e)) return [];
    throw e;
  }
}

export function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
