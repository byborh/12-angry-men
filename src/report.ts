import os from "node:os";
import { scanHistory } from "./history.ts";
import { type SkillDef, type SkillSource, scanSkills } from "./skills.ts";
import { type Invocation, type Session, type Turn, scanTranscripts } from "./transcripts.ts";
import { type TriggerStats, triggerStats } from "./triggers.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const DORMANT_MS = 30 * DAY_MS;
const TOP = 15;

export type SkillStatus = "active" | "dormant" | "unused";

export interface SkillRow {
  id: string;
  kind: SkillDef["kind"];
  source: SkillSource;
  description: string;
  /** Claude Code puts name + description in every session context. ~4 characters per token. */
  listingTokens: number;
  slash: number;
  auto: number;
  lastUsed: number | null;
  projects: number;
  status: SkillStatus;
  triggers: TriggerStats | null;
}

export interface Report {
  generatedAt: number;
  window: { from: number; to: number; days: number } | null;
  /** history.jsonl reaches further back than transcripts, for typed commands only. */
  historyFrom: number | null;
  totals: {
    sessions: number;
    automatedSessions: number;
    subagentRuns: number;
    humanPrompts: number;
    corrections: number;
    activeHours: number;
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  daily: { day: string; prompts: number }[];
  /** heatmap[weekday 0=Monday][hour], human prompts in local time. */
  heatmap: number[][];
  projects: { name: string; sessions: number; prompts: number; activeHours: number }[];
  tools: { name: string; count: number }[];
  models: { name: string; messages: number; input: number; output: number; cacheRead: number; cacheWrite: number }[];
  skills: SkillRow[];
  /** Invoked names with no matching definition on disk: built-in commands, removed skills, cloud skills. */
  otherInvocations: { name: string; slash: number; auto: number }[];
  warnings: string[];
}

export function tildify(p: string): string {
  const home = os.homedir();
  return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

function localDay(t: number): string {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function hours(ms: number): number {
  return Math.round((ms / 3_600_000) * 10) / 10;
}

function buildDaily(times: number[], from: number, to: number): Report["daily"] {
  const counts = new Map<string, number>();
  for (const t of times) counts.set(localDay(t), (counts.get(localDay(t)) ?? 0) + 1);
  const out: Report["daily"] = [];
  const cursor = new Date(from);
  cursor.setHours(12, 0, 0, 0);
  while (cursor.getTime() <= to + DAY_MS / 2) {
    const day = localDay(cursor.getTime());
    out.push({ day, prompts: counts.get(day) ?? 0 });
    cursor.setDate(cursor.getDate() + 1);
  }
  return out;
}

function buildHeatmap(times: number[]): number[][] {
  const grid = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
  for (const t of times) {
    const d = new Date(t);
    const row = grid[(d.getDay() + 6) % 7];
    if (row) row[d.getHours()] = (row[d.getHours()] ?? 0) + 1;
  }
  return grid;
}

function buildProjects(sessions: Session[]): Report["projects"] {
  const byName = new Map<string, { sessions: number; prompts: number; activeMs: number }>();
  for (const s of sessions) {
    if (s.isSubagent || s.humanPrompts === 0) continue;
    const p = byName.get(s.project) ?? { sessions: 0, prompts: 0, activeMs: 0 };
    p.sessions++;
    p.prompts += s.humanPrompts;
    p.activeMs += s.activeMs;
    byName.set(s.project, p);
  }
  return [...byName.entries()]
    .map(([name, p]) => ({ name: tildify(name), sessions: p.sessions, prompts: p.prompts, activeHours: hours(p.activeMs) }))
    .sort((a, b) => b.prompts - a.prompts)
    .slice(0, TOP);
}

function statusOf(lastUsed: number | null, now: number): SkillStatus {
  if (lastUsed === null) return "unused";
  return now - lastUsed > DORMANT_MS ? "dormant" : "active";
}

function countVia(uses: Invocation[], via: Invocation["via"]): number {
  return uses.filter((u) => u.via === via).length;
}

function buildSkills(defs: SkillDef[], invocations: Invocation[], turns: Turn[], now: number): { rows: SkillRow[]; other: Report["otherInvocations"] } {
  const byId = new Map<string, Invocation[]>();
  for (const inv of invocations) byId.set(inv.name, [...(byId.get(inv.name) ?? []), inv]);
  const rows = defs.map((def): SkillRow => {
    const uses = byId.get(def.id) ?? [];
    byId.delete(def.id);
    const lastUsed = uses.length === 0 ? null : Math.max(...uses.map((u) => u.at));
    const triggers = triggerStats(def, turns);
    return {
      id: def.id,
      kind: def.kind,
      source: def.source,
      description: def.description,
      listingTokens: Math.ceil((def.id.length + def.description.length) / 4),
      slash: countVia(uses, "slash"),
      auto: countVia(uses, "auto"),
      lastUsed,
      projects: new Set(uses.map((u) => u.project)).size,
      status: statusOf(lastUsed, now),
      triggers: triggers ? { ...triggers, examples: triggers.examples.map((m) => ({ ...m, project: tildify(m.project) })) } : null,
    };
  });
  rows.sort((a, b) => b.slash + b.auto - (a.slash + a.auto) || a.id.localeCompare(b.id));
  const other = [...byId.entries()]
    .map(([name, uses]) => ({ name, slash: countVia(uses, "slash"), auto: countVia(uses, "auto") }))
    .sort((a, b) => b.slash + b.auto - (a.slash + a.auto));
  return { rows, other };
}

function sum<T>(items: T[], pick: (item: T) => number): number {
  return items.reduce((n, item) => n + pick(item), 0);
}

export async function buildReport(claudeDir: string): Promise<Report> {
  const now = Date.now();
  const scan = await scanTranscripts(claudeDir);
  const main = scan.sessions.filter((s) => !s.isSubagent);
  const history = await scanHistory(claudeDir, new Set(main.map((s) => s.id)));
  const projectDirs = [...new Set(scan.sessions.map((s) => s.project).filter((p) => p.startsWith("/") || /^[A-Za-z]:\\/.test(p)))];
  const inventory = await scanSkills(claudeDir, projectDirs);
  const promptTimes = scan.turns.map((t) => t.at);
  const hasData = scan.sessions.length > 0;
  const from = Math.min(...scan.sessions.map((s) => s.start));
  const to = Math.max(...scan.sessions.map((s) => s.end));
  const models = [...scan.models.entries()].map(([name, m]) => ({ name, ...m })).sort((a, b) => b.output - a.output);
  const { rows, other } = buildSkills(inventory.skills, [...scan.invocations, ...history.invocations], scan.turns, now);
  const warnings = [...scan.errors, ...inventory.errors];
  const skipped = scan.skippedLines + history.skippedLines;
  if (skipped > 0) warnings.push(`${skipped} lines were not valid JSON records and were skipped.`);
  return {
    generatedAt: now,
    window: hasData ? { from, to, days: Math.max(1, Math.round((to - from) / DAY_MS)) } : null,
    historyFrom: history.from !== null && (!hasData || history.from < from) ? history.from : null,
    totals: {
      sessions: main.filter((s) => s.humanPrompts > 0).length,
      automatedSessions: main.filter((s) => s.humanPrompts === 0).length,
      subagentRuns: scan.sessions.length - main.length,
      humanPrompts: scan.turns.length,
      corrections: sum(main, (s) => s.corrections),
      activeHours: hours(sum(main, (s) => s.activeMs)),
      input: sum(models, (m) => m.input),
      output: sum(models, (m) => m.output),
      cacheRead: sum(models, (m) => m.cacheRead),
      cacheWrite: sum(models, (m) => m.cacheWrite),
    },
    daily: hasData ? buildDaily(promptTimes, from, to) : [],
    heatmap: buildHeatmap(promptTimes),
    projects: buildProjects(scan.sessions),
    tools: [...scan.tools.entries()].map(([name, n]) => ({ name, count: n })).sort((a, b) => b.count - a.count).slice(0, TOP),
    models,
    skills: rows,
    otherInvocations: other,
    warnings,
  };
}
