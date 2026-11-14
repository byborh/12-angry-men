import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";
import { entriesIfExists, messageOf } from "./fsutil.ts";
import { type Obj, count, isObj, list, obj, parseJsonLine, str } from "./json.ts";

/** Two records further apart than this mean the user left: the gap is not active time. */
const IDLE_MS = 15 * 60 * 1000;

/** Trigger phrases sit at the start of a prompt. The rest is pasted logs and code. */
const PROMPT_TEXT_MAX = 2000;

/** Context blocks the IDE puts before the prompt. They hide how the prompt starts. */
const IDE_CONTEXT_RE = /^\s*<(ide_opened_file|ide_selection|ide_diagnostics|system-reminder)>[\s\S]*?<\/\1>/;

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

/** One prompt the person typed, and every skill that ran before the next prompt. */
export interface Turn {
  /** Empty for a slash command: its skill is already in `invoked`. */
  text: string;
  at: number;
  project: string;
  session: string;
  invoked: string[];
  /** Tool names Claude called during the turn, in order. */
  tools: string[];
}

export interface Session {
  id: string;
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
  turns: Turn[];
  tools: Map<string, number>;
  models: Map<string, ModelUsage>;
  skippedLines: number;
  errors: string[];
}

interface FileState {
  session: Session;
  seenMessages: Set<string>;
  turn: Turn | undefined;
  projectFromCwd: boolean;
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

export function stripIdeContext(text: string): string {
  let out = text;
  for (let m = IDE_CONTEXT_RE.exec(out); m; m = IDE_CONTEXT_RE.exec(out)) out = out.slice(m[0].length);
  return out.trim();
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

export function isCorrection(text: string): boolean {
  return CORRECTION_RE.test(text);
}

function onUser(rec: Obj, at: number, state: FileState, acc: ScanResult): void {
  if (!isHumanPrompt(rec)) return;
  const raw = promptText(obj(rec, "message")).trim();
  if (raw === "") return;
  const text = stripIdeContext(raw);
  const { session } = state;
  session.humanPrompts++;
  const command = COMMAND_RE.exec(raw)?.[1];
  state.turn = {
    text: command ? "" : text.slice(0, PROMPT_TEXT_MAX),
    at,
    project: session.project,
    session: session.id,
    invoked: command ? [command] : [],
    tools: [],
  };
  acc.turns.push(state.turn);
  if (command) {
    acc.invocations.push({ name: command, via: "slash", at, project: session.project });
    return;
  }
  if (isCorrection(text)) session.corrections++;
}

/** One API message is split into one record per content block, so usage is counted once per message id. */
function onAssistant(rec: Obj, at: number, state: FileState, acc: ScanResult): void {
  const message = obj(rec, "message");
  for (const block of list(message, "content") ?? []) {
    if (!isObj(block) || str(block, "type") !== "tool_use") continue;
    const name = str(block, "name");
    if (!name) continue;
    bump(acc.tools, name);
    state.turn?.tools.push(name);
    const skill = str(obj(block, "input"), "skill");
    if (name !== "Skill" || !skill) continue;
    acc.invocations.push({ name: skill, via: "auto", at, project: state.session.project });
    state.turn?.invoked.push(skill);
  }
  const id = str(message, "id");
  const model = str(message, "model");
  if (!id || !model || state.seenMessages.has(id) || model === "<synthetic>") return;
  state.seenMessages.add(id);
  const usage = obj(message, "usage");
  const m = acc.models.get(model) ?? { messages: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  m.messages++;
  m.input += count(usage, "input_tokens");
  m.output += count(usage, "output_tokens");
  m.cacheRead += count(usage, "cache_read_input_tokens");
  m.cacheWrite += count(usage, "cache_creation_input_tokens");
  acc.models.set(model, m);
}

function newState(file: string, isSubagent: boolean): FileState {
  const projectDir = isSubagent ? path.dirname(path.dirname(path.dirname(file))) : path.dirname(file);
  return {
    session: {
      id: path.basename(file, ".jsonl"),
      project: path.basename(projectDir),
      isSubagent,
      start: Infinity,
      end: -Infinity,
      activeMs: 0,
      humanPrompts: 0,
      corrections: 0,
    },
    seenMessages: new Set(),
    turn: undefined,
    projectFromCwd: false,
  };
}

function onRecord(rec: Obj, state: FileState, acc: ScanResult): void {
  const type = str(rec, "type");
  const at = Date.parse(str(rec, "timestamp") ?? "");
  if ((type !== "user" && type !== "assistant") || Number.isNaN(at)) return;
  const { session } = state;
  const cwd = str(rec, "cwd");
  if (cwd && !state.projectFromCwd) {
    session.project = cwd;
    state.projectFromCwd = true;
  }
  const gap = at - session.end;
  if (gap > 0 && gap <= IDLE_MS) session.activeMs += gap;
  session.start = Math.min(session.start, at);
  session.end = Math.max(session.end, at);
  if (type === "user") onUser(rec, at, state, acc);
  else onAssistant(rec, at, state, acc);
}

async function scanFile(file: string, isSubagent: boolean, acc: ScanResult): Promise<void> {
  const state = newState(file, isSubagent);
  const lines = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of lines) {
    // Cheap pre-filter: most bytes are API blobs and snapshots that carry no activity.
    if (!line.includes('"type":"user"') && !line.includes('"type":"assistant"')) continue;
    const rec = parseJsonLine(line);
    if (!rec) {
      acc.skippedLines++;
      continue;
    }
    onRecord(rec, state, acc);
  }
  if (Number.isFinite(state.session.start)) acc.sessions.push(state.session);
}

export async function scanTranscripts(claudeDir: string): Promise<ScanResult> {
  const acc: ScanResult = { sessions: [], invocations: [], turns: [], tools: new Map(), models: new Map(), skippedLines: 0, errors: [] };
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
