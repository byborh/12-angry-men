import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ClaudeAnswer } from "./claude.ts";
import { HttpError } from "./httpError.ts";
import { isObj } from "./json.ts";
import { parseFrontmatter } from "./skills.ts";
import { localDay } from "./time.ts";
import { type Turn, isCorrection } from "./transcripts.ts";

export type Ask = (system: string, prompt: string, schema: object) => Promise<ClaudeAnswer>;

/** The proof threshold. A group under it is not a habit, so no skill is proposed. */
export const MIN_OCCURRENCES = 3;
export const MIN_SESSIONS = 2;
export const MIN_DAYS = 2;

const MAX_PROMPTS = 1200;
const MIN_TEXT = 12;
const EXCERPT = 200;
const SKILL_EXCERPT = 160;
const FOLLOW_UPS = 3;
const SKILL_MAX_BYTES = 100_000;
const NAME_RE = /^[a-z0-9][a-z0-9-]{1,39}$/;

export interface Occurrence {
  at: number;
  project: string;
  session: string;
  text: string;
  tools: string[];
  /** The next prompts of the same session: they show what the user had to correct. */
  followUps: string[];
}

export interface Candidate {
  name: string;
  title: string;
  why: string;
  occurrences: Occurrence[];
  sessions: number;
  projects: number;
  days: number;
  avgTools: number;
  /** An installed skill that already covers this task. Its description likely misses the user's words. */
  overlaps: string | null;
}

/** What the grouping step needs to know about an installed skill. */
export interface KnownSkill {
  id: string;
  description: string;
}

export interface CandidateRun {
  candidates: Candidate[];
  promptsSent: number;
  /** Groups Claude proposed that failed the proof threshold. */
  rejected: number;
  costUsd: number | null;
}

interface Selected {
  id: number;
  index: number;
  turn: Turn;
}

const GROUP_SCHEMA = {
  type: "object",
  properties: {
    groups: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          title: { type: "string" },
          why: { type: "string" },
          ids: { type: "array", items: { type: "integer" } },
          overlaps: { type: "string" },
        },
        required: ["name", "title", "why", "ids", "overlaps"],
      },
    },
  },
  required: ["groups"],
};

const GROUP_SYSTEM = `You find repeated work in the prompts a developer sent to an AI coding assistant.
Group prompts that ask for the same reusable workflow: the same kind of task, applied to different inputs (another ticket, branch, file or pull request).
Do not group prompts that only share a topic or a project. Ignore one-off requests.
Return only groups with at least ${MIN_OCCURRENCES} prompts. Use only ids from the list. Never invent an id.
name: a kebab-case skill name, at most 40 characters. title: 3 to 6 words. why: one sentence that says what the repeated task is.
overlaps: the id of an installed skill that already does this task, or "" when none does. Still return the group when it overlaps.`;

const DRAFT_SCHEMA = {
  type: "object",
  properties: { description: { type: "string" }, body: { type: "string" } },
  required: ["description", "body"],
};

const DRAFT_SYSTEM = `You write a Claude Code skill (the content of a SKILL.md file) from real sessions of one user.
Only describe steps that the sessions show. Never add a step, a tool or a rule that the sessions do not show.
description: one or two sentences. Say what the skill does, then "Use when the user says" and 2 to 5 short phrases in double quotes, taken from the user's real prompts. Keep the user's language.
body: Markdown without frontmatter. One goal line, numbered steps, then a "Rules" list built from the user's follow-up corrections. Write in the imperative.`;

function oneLine(text: string, max: number): string {
  return text.replace(/\s+/g, " ").trim().slice(0, max);
}

/** Prompts no skill covers: no slash command, no skill run, not a correction, not too short. Most recent first. */
export function selectPrompts(turns: Turn[]): Selected[] {
  return turns
    .map((turn, index) => ({ turn, index }))
    .filter(({ turn }) => turn.text.length >= MIN_TEXT && turn.invoked.length === 0 && !isCorrection(turn.text))
    .sort((a, b) => b.turn.at - a.turn.at)
    .slice(0, MAX_PROMPTS)
    .map((s, id) => ({ ...s, id }));
}

function followUps(turns: Turn[], index: number): string[] {
  const session = turns[index]?.session;
  const out: string[] = [];
  for (let i = index + 1; i < turns.length && out.length < FOLLOW_UPS; i++) {
    const next = turns[i];
    if (!next || next.session !== session) break;
    if (next.text) out.push(next.text);
  }
  return out;
}

function slug(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

function uniqueName(raw: string, title: string, taken: Set<string>): string {
  const base = NAME_RE.test(raw) ? raw : slug(raw) || slug(title) || "repeated-task";
  let name = base;
  for (let n = 2; taken.has(name); n++) name = `${base.slice(0, 36)}-${n}`;
  taken.add(name);
  return name;
}

interface RawGroup {
  name: string;
  title: string;
  why: string;
  ids: number[];
  overlaps: string;
}

function parseGroups(output: unknown): RawGroup[] {
  const groups = isObj(output) ? output["groups"] : undefined;
  if (!Array.isArray(groups)) throw new Error("Claude returned no 'groups' list");
  return groups.filter(isObj).map((g) => ({
    name: String(g["name"] ?? ""),
    title: String(g["title"] ?? ""),
    why: String(g["why"] ?? ""),
    ids: Array.isArray(g["ids"]) ? g["ids"].filter((id): id is number => Number.isInteger(id)) : [],
    overlaps: String(g["overlaps"] ?? ""),
  }));
}

/** Claude proposes groups. This function checks each one against the real data and drops what it cannot prove. */
export function verifyGroups(
  output: unknown,
  selected: Selected[],
  turns: Turn[],
  known: KnownSkill[],
): { candidates: Candidate[]; rejected: number } {
  const byId = new Map(selected.map((s) => [s.id, s]));
  const knownIds = new Set(known.map((k) => k.id));
  // A new skill must not take the folder name of an installed one.
  const takenNames = new Set(known.map((k) => k.id.split(":").pop() ?? k.id));
  const candidates: Candidate[] = [];
  let rejected = 0;
  for (const group of parseGroups(output)) {
    const picked = [...new Set(group.ids)].map((id) => byId.get(id)).filter((s): s is Selected => s !== undefined);
    const occurrences = picked
      .map(({ turn, index }): Occurrence => ({ at: turn.at, project: turn.project, session: turn.session, text: turn.text, tools: turn.tools, followUps: followUps(turns, index) }))
      .sort((a, b) => a.at - b.at);
    const sessions = new Set(occurrences.map((o) => o.session)).size;
    const days = new Set(occurrences.map((o) => localDay(o.at))).size;
    if (occurrences.length < MIN_OCCURRENCES || sessions < MIN_SESSIONS || days < MIN_DAYS) {
      rejected++;
      continue;
    }
    candidates.push({
      name: uniqueName(group.name, group.title, takenNames),
      title: oneLine(group.title, 80),
      why: oneLine(group.why, 300),
      occurrences,
      sessions,
      projects: new Set(occurrences.map((o) => o.project)).size,
      days,
      avgTools: Math.round(occurrences.reduce((n, o) => n + o.tools.length, 0) / occurrences.length),
      // Only a real installed skill counts: Claude can name one that does not exist.
      overlaps: knownIds.has(group.overlaps) ? group.overlaps : null,
    });
  }
  candidates.sort((a, b) => b.occurrences.length - a.occurrences.length);
  return { candidates, rejected };
}

export async function findCandidates(turns: Turn[], known: KnownSkill[], ask: Ask): Promise<CandidateRun> {
  const selected = selectPrompts(turns);
  if (selected.length === 0) return { candidates: [], promptsSent: 0, rejected: 0, costUsd: null };
  const lines = selected.map((s) => `${s.id} | ${new Date(s.turn.at).toISOString().slice(0, 10)} | ${oneLine(s.turn.text, EXCERPT)}`);
  const skills = known.map((k) => `- ${k.id}: ${oneLine(k.description, SKILL_EXCERPT)}`);
  const prompt = `Installed skills:\n${skills.join("\n") || "none"}\n\nPrompts (id | date | text):\n${lines.join("\n")}`;
  const answer = await ask(GROUP_SYSTEM, prompt, GROUP_SCHEMA);
  const { candidates, rejected } = verifyGroups(answer.output, selected, turns, known);
  return { candidates, promptsSent: selected.length, rejected, costUsd: answer.costUsd };
}

function toolSummary(tools: string[]): string {
  const counts = new Map<string, number>();
  for (const t of tools) counts.set(t, (counts.get(t) ?? 0) + 1);
  return [...counts.entries()].map(([t, n]) => (n > 1 ? `${t} ×${n}` : t)).join(", ") || "none";
}

export async function draftSkill(candidate: Candidate, existingSkills: string[], ask: Ask): Promise<{ markdown: string; costUsd: number | null }> {
  const sessions = candidate.occurrences.map((o, i) =>
    [
      `## Session ${i + 1} — ${new Date(o.at).toISOString().slice(0, 10)} — ${o.project}`,
      `Prompt:\n${o.text}`,
      `Tools Claude used: ${toolSummary(o.tools)}`,
      o.followUps.length > 0 ? `Next prompts of the user:\n${o.followUps.map((f) => `- ${oneLine(f, 400)}`).join("\n")}` : "",
    ]
      .filter(Boolean)
      .join("\n\n"),
  );
  const prompt = [
    `Skill name: ${candidate.name}`,
    `Repeated task: ${candidate.why}`,
    `Skills the user already has (do not overlap): ${existingSkills.join(", ") || "none"}`,
    ...sessions,
  ].join("\n\n");
  const answer = await ask(DRAFT_SYSTEM, prompt, DRAFT_SCHEMA);
  const out = answer.output;
  if (!isObj(out) || typeof out["description"] !== "string" || typeof out["body"] !== "string") throw new Error("Claude returned no description or body");
  // JSON string syntax is valid YAML double-quoted syntax, so the description needs no other escaping.
  const markdown = `---\nname: ${candidate.name}\ndescription: ${JSON.stringify(oneLine(out["description"], 1000))}\n---\n\n${out["body"].trim()}\n`;
  return { markdown, costUsd: answer.costUsd };
}

/** Writes skills/<name>/SKILL.md. Never overwrites: an existing skill folder is a conflict. */
export async function installSkill(claudeDir: string, name: string, content: string): Promise<string> {
  if (!NAME_RE.test(name)) throw new HttpError(400, "Invalid skill name: use 2 to 40 lowercase letters, digits and dashes.");
  if (Buffer.byteLength(content, "utf8") > SKILL_MAX_BYTES) throw new HttpError(400, "SKILL.md is too large.");
  if (parseFrontmatter(content).name !== name) throw new HttpError(400, `The frontmatter must start with ---, and its name must be "${name}".`);
  const skillsDir = path.join(claudeDir, "skills");
  const dir = path.join(skillsDir, name);
  await mkdir(skillsDir, { recursive: true });
  try {
    await mkdir(dir);
  } catch (e) {
    if (e instanceof Error && "code" in e && e.code === "EEXIST") throw new HttpError(409, `${dir} already exists. Nothing was written.`);
    throw e;
  }
  const file = path.join(dir, "SKILL.md");
  await writeFile(file, content, { flag: "wx" });
  return file;
}
