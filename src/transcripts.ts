import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";
import { entriesIfExists, messageOf } from "./fsutil.ts";
import { type Obj, count, isObj, list, obj, str } from "./json.ts";

/** Two records further apart than this mean the user left: the gap is not active time. */
const IDLE_MS = 15 * 60 * 1000;

const COMMAND_RE = /<command-name>\/?([^<\s]+)<\/command-name>/;

/** Heuristic: a prompt that starts by rejecting the last answer. French and English. */
const CORRECTION_RE =
  /^(non\b|no\b|nope\b|pas (ça|ca|comme ça|comme ca)\b|c'?est (faux|pas ça|pas ca)\b|wrong\b|that'?s (not|wrong)\b|stop\b|arr[eê]te\b|je t'?ai dit\b|i (said|told you)\b|toujours pas\b|still (not|doesn'?t|broken)\b|(ça|ca) (marche|fonctionne) (pas|toujours pas)\b|it (still )?doesn'?t work\b)/i;

export interface Invocation {
  name: string;
  via: "slash" | "auto";
  at: number;
  project: string;
}

export interface Session {
  file: string;
  project: string;
  isSubagent: boolean;
  start: number;
  end: number;
  activeMs: number;
  humanPrompts: number;
  corrections: number;
}

export interface ModelUsage {
  messages: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface ScanResult {
  sessions: Session[];
  invocations: Invocation[];
  promptTimes: number[];
  tools: Map<string, number>;
  models: Map<string, ModelUsage>;
  skippedLines: number;
  errors: string[];
}

function emptyResult(): ScanResult {
  return { sessions: [], invocations: [], promptTimes: [], tools: new Map(), models: new Map(), skippedLines: 0, errors: [] };
}

function bump(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

/** Main sessions sit at projects/<p>/<id>.jsonl. Subagent runs sit at projects/<p>/<id>/subagents/*.jsonl. */
async function listTranscripts(projectsDir: string): Promise<{ file: string; isSubagent: boolean }[]> {
  const out: { file: string; isSubagent: boolean }[] = [];
  for (const project of await entriesIfExists(projectsDir)) {
    const projectDir = path.join(projectsDir, project);
    for (const entry of await entriesIfExists(projectDir)) {
      if (entry.endsWith(".jsonl")) {
        out.push({ file: path.join(projectDir, entry), isSubagent: false });
        continue;
      }
      const subDir = path.join(projectDir, entry, "subagents");
      for (const sub of await entriesIfExists(subDir)) {
        if (sub.endsWith(".jsonl")) out.push({ file: path.join(subDir, sub), isSubagent: true });
      }
    }
  }
  return out;
}

function promptText(message: Obj | undefined): string {
  const content = message?.["content"];
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(isObj)
    .map((block) => (str(block, "type") === "text" ? (str(block, "text") ?? "") : ""))
    .join("\n");
}

/** Only prompts the person typed. Meta records, tool results and SDK prompts from automation are excluded. */
function isHumanPrompt(rec: Obj): boolean {
  if (rec["isMeta"] === true) return false;
  return str(obj(rec, "origin"), "kind") === "human";
}

function onUser(rec: Obj, at: number, session: Session, acc: ScanResult): void {
  if (!isHumanPrompt(rec)) return;
  const text = promptText(obj(rec, "message")).trim();
  if (text === "") return;
  session.humanPrompts++;
  acc.promptTimes.push(at);
  const command = COMMAND_RE.exec(text);
  if (command?.[1]) {
    acc.invocations.push({ name: command[1], via: "slash", at, project: session.project });
    return;
  }
  if (CORRECTION_RE.test(text)) session.corrections++;
}

/** One API message is split into one record per content block, so usage is counted once per message id. */
function onAssistant(rec: Obj, at: number, session: Session, seen: Set<string>, acc: ScanResult): void {
  const message = obj(rec, "message");
  for (const block of list(message, "content") ?? []) {
    if (!isObj(block) || str(block, "type") !== "tool_use") continue;
    const name = str(block, "name");
    if (!name) continue;
    bump(acc.tools, name);
    const skill = str(obj(block, "input"), "skill");
    if (name === "Skill" && skill) acc.invocations.push({ name: skill, via: "auto", at, project: session.project });
  }
  const id = str(message, "id");
  const model = str(message, "model");
  if (!id || !model || seen.has(id) || model === "<synthetic>") return;
  seen.add(id);
  const usage = obj(message, "usage");
  const m = acc.models.get(model) ?? { messages: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  m.messages++;
  m.input += count(usage, "input_tokens");
  m.output += count(usage, "output_tokens");
  m.cacheRead += count(usage, "cache_read_input_tokens");
  m.cacheWrite += count(usage, "cache_creation_input_tokens");
  acc.models.set(model, m);
}

function parseLine(line: string): Obj | undefined {
  try {
    const value: unknown = JSON.parse(line);
    return isObj(value) ? value : undefined;
  } catch {
    // The caller counts undefined as a skipped line and shows the total in the UI.
    return undefined;
  }
}

async function scanFile(file: string, isSubagent: boolean, acc: ScanResult): Promise<void> {
  const session: Session = {
    file,
    project: path.basename(path.dirname(isSubagent ? path.dirname(path.dirname(file)) : file)),
    isSubagent,
    start: Infinity,
    end: -Infinity,
    activeMs: 0,
    humanPrompts: 0,
    corrections: 0,
  };
  const seen = new Set<string>();
  let projectFromCwd = false;
  const lines = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of lines) {
    // Cheap pre-filter: most bytes are API blobs and snapshots that carry no activity.
    if (!line.includes('"type":"user"') && !line.includes('"type":"assistant"')) continue;
    const rec = parseLine(line);
    if (!rec) {
      acc.skippedLines++;
      continue;
    }
    const type = str(rec, "type");
    const at = Date.parse(str(rec, "timestamp") ?? "");
    if ((type !== "user" && type !== "assistant") || Number.isNaN(at)) continue;
    const cwd = str(rec, "cwd");
    if (cwd && !projectFromCwd) {
      session.project = cwd;
      projectFromCwd = true;
    }
    const gap = at - session.end;
    if (gap > 0 && gap <= IDLE_MS) session.activeMs += gap;
    session.start = Math.min(session.start, at);
    session.end = Math.max(session.end, at);
    if (type === "user") onUser(rec, at, session, acc);
    else onAssistant(rec, at, session, seen, acc);
  }
  if (Number.isFinite(session.start)) acc.sessions.push(session);
}

export async function scanTranscripts(claudeDir: string): Promise<ScanResult> {
  const acc = emptyResult();
  const files = await listTranscripts(path.join(claudeDir, "projects"));
  for (const { file, isSubagent } of files) {
    try {
      await scanFile(file, isSubagent, acc);
    } catch (e) {
      // One unreadable transcript must not hide the others. The UI lists every failure.
      acc.errors.push(`${file}: ${messageOf(e)}`);
    }
  }
  return acc;
}
