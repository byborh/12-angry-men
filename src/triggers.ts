import type { SkillDef } from "./skills.ts";
import type { Turn } from "./transcripts.ts";

const QUOTED_RE = /"([^"\n]{2,80})"|“([^”\n]{2,80})”|«\s?([^»\n]{2,80}?)\s?»/g;
const EXAMPLES_MAX = 5;
const EXCERPT_MAX = 160;

export interface Miss {
  at: number;
  project: string;
  excerpt: string;
}

export interface TriggerStats {
  phrases: string[];
  /** Prompts that match a phrase. */
  matched: number;
  /** Matched prompts where the skill did not run before the next prompt. */
  missed: number;
  examples: Miss[];
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Descriptions write placeholders as "TECH-XXXX" or "TECH-1234". Both become "any id".
 * A one-word phrase matches only at the start of a prompt: "bilan" inside a sentence is not a request.
 */
export function phraseToRegExp(phrase: string): RegExp {
  const words = phrase.trim().split(/\s+/);
  const body = words
    .map((w) => escape(w).replace(/X{2,}/g, "[\\w-]+").replace(/\d{2,}/g, "\\d+").replace(/'/g, "['’]?"))
    .join("\\s+");
  if (words.length === 1) return new RegExp(`^${body}(?![\\p{L}\\p{N}])`, "iu");
  return new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, "iu");
}

export function extractPhrases(description: string): string[] {
  const out = new Set<string>();
  for (const m of description.matchAll(QUOTED_RE)) {
    const phrase = (m[1] ?? m[2] ?? m[3] ?? "").trim();
    // A slash phrase is a typed command: transcripts already count it as an invocation.
    if (phrase.length >= 2 && !phrase.startsWith("/")) out.add(phrase);
  }
  return [...out];
}

function inScope(def: SkillDef, turn: Turn): boolean {
  return def.projectRoot === undefined || turn.project.startsWith(def.projectRoot);
}

export function triggerStats(def: SkillDef, turns: Turn[]): TriggerStats | undefined {
  const phrases = extractPhrases(def.description);
  if (phrases.length === 0) return undefined;
  const patterns = phrases.map(phraseToRegExp);
  const stats: TriggerStats = { phrases, matched: 0, missed: 0, examples: [] };
  for (const turn of turns) {
    if (turn.text === "" || !inScope(def, turn)) continue;
    if (!patterns.some((re) => re.test(turn.text))) continue;
    stats.matched++;
    if (turn.invoked.includes(def.id)) continue;
    stats.missed++;
    stats.examples.push({ at: turn.at, project: turn.project, excerpt: turn.text.slice(0, EXCERPT_MAX) });
  }
  stats.examples = stats.examples.sort((a, b) => b.at - a.at).slice(0, EXAMPLES_MAX);
  return stats;
}
