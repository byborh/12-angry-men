import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import path from "node:path";
import { isMissing } from "./fsutil.ts";
import { parseJsonLine, str } from "./json.ts";
import type { Invocation } from "./transcripts.ts";

const SLASH_RE = /^\/([^\s/][^\s]*)/;

export interface HistoryResult {
  invocations: Invocation[];
  /** Oldest entry in the file, or null when the file is missing or empty. */
  from: number | null;
  skippedLines: number;
}

/**
 * history.jsonl keeps the prompts typed in the CLI longer than transcripts live.
 * Entries of a session whose transcript still exists are skipped: the transcript already counts them.
 */
export async function scanHistory(claudeDir: string, knownSessions: Set<string>): Promise<HistoryResult> {
  const file = path.join(claudeDir, "history.jsonl");
  const out: HistoryResult = { invocations: [], from: null, skippedLines: 0 };
  try {
    await stat(file);
  } catch (e) {
    if (isMissing(e)) return out;
    throw e;
  }
  const lines = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of lines) {
    if (line.trim() === "") continue;
    const rec = parseJsonLine(line);
    const at = rec?.["timestamp"];
    if (!rec || typeof at !== "number") {
      out.skippedLines++;
      continue;
    }
    out.from = out.from === null ? at : Math.min(out.from, at);
    const sessionId = str(rec, "sessionId");
    if (sessionId && knownSessions.has(sessionId)) continue;
    const name = SLASH_RE.exec(str(rec, "display") ?? "")?.[1];
    if (name) out.invocations.push({ name, via: "slash", at, project: str(rec, "project") ?? "unknown" });
  }
  return out;
}
