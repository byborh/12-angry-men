import { readFile } from "node:fs/promises";
import path from "node:path";
import { entriesIfExists, isMissing, messageOf } from "./fsutil.ts";
import { isObj, obj, str } from "./json.ts";

export type SkillSource = "user" | "project" | "plugin" | "synced";

export interface SkillDef {
  /** The name Claude Code uses to invoke it: "name", or "plugin:name". */
  id: string;
  kind: "skill" | "command";
  source: SkillSource;
  description: string;
  path: string;
  /** Set for project skills only: they load only inside this folder. */
  projectRoot?: string;
}

export interface Inventory {
  skills: SkillDef[];
  errors: string[];
}

interface Frontmatter {
  name?: string;
  description?: string;
}

function unquote(v: string): string {
  const t = v.trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) return t.slice(1, -1).replace(/\\(["\\])/g, "$1");
  if (t.length >= 2 && t.startsWith("'") && t.endsWith("'")) return t.slice(1, -1).replace(/''/g, "'");
  return t;
}

/** Reads only the two keys we need. Supports one-line values and YAML block scalars (> and |). */
export function parseFrontmatter(text: string): Frontmatter {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match?.[1]) return {};
  const lines = match[1].split(/\r?\n/);
  const out: Frontmatter = {};
  for (let i = 0; i < lines.length; i++) {
    const kv = /^(name|description):\s*(.*)$/.exec(lines[i] ?? "");
    if (!kv?.[1]) continue;
    let value = kv[2] ?? "";
    if (/^[>|][+-]?$/.test(value.trim())) {
      const block: string[] = [];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1] ?? "")) block.push((lines[++i] ?? "").trim());
      value = block.join(" ");
    }
    out[kv[1] === "name" ? "name" : "description"] = unquote(value);
  }
  return out;
}

async function readDef(file: string, fallbackName: string, kind: SkillDef["kind"], source: SkillSource, prefix: string | undefined): Promise<SkillDef | undefined> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (e) {
    if (isMissing(e)) return undefined;
    throw e;
  }
  const fm = parseFrontmatter(text);
  const name = fm.name ?? fallbackName;
  return { id: prefix ? `${prefix}:${name}` : name, kind, source, description: fm.description ?? "", path: file };
}

/** A skill root holds skills/<name>/SKILL.md and commands/<name>.md. */
async function scanRoot(root: string, source: SkillSource, prefix: string | undefined): Promise<SkillDef[]> {
  const out: SkillDef[] = [];
  const skillsDir = path.join(root, "skills");
  for (const dir of await entriesIfExists(skillsDir)) {
    const def = await readDef(path.join(skillsDir, dir, "SKILL.md"), dir, "skill", source, prefix);
    if (def) out.push(def);
  }
  const commandsDir = path.join(root, "commands");
  for (const file of await entriesIfExists(commandsDir)) {
    if (!file.endsWith(".md")) continue;
    const def = await readDef(path.join(commandsDir, file), file.slice(0, -3), "command", source, prefix);
    if (def) out.push(def);
  }
  // A project root is <repo>/.claude, so the repo is its parent.
  return source === "project" ? out.map((def) => ({ ...def, projectRoot: path.dirname(root) })) : out;
}

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (e) {
    if (isMissing(e)) return undefined;
    throw new Error(`${file}: ${messageOf(e)}`);
  }
}

/** installed_plugins.json maps "plugin@marketplace" to install entries. One plugin can have several installs. */
async function installedPluginRoots(claudeDir: string): Promise<{ root: string; name: string }[]> {
  const data = await readJson(path.join(claudeDir, "plugins", "installed_plugins.json"));
  if (data === undefined) return [];
  const plugins = isObj(data) ? obj(data, "plugins") : undefined;
  if (!plugins) throw new Error("installed_plugins.json: no 'plugins' object");
  const out: { root: string; name: string }[] = [];
  for (const [key, entries] of Object.entries(plugins)) {
    const name = key.split("@")[0] ?? key;
    for (const entry of Array.isArray(entries) ? entries : []) {
      const root = isObj(entry) ? str(entry, "installPath") : undefined;
      if (root) out.push({ root, name });
    }
  }
  return out;
}

/** Organization plugins live in plugins/synced/<org>/<id>/. Their real name is in .claude-plugin/plugin.json. */
async function syncedPluginRoots(claudeDir: string): Promise<{ root: string; name: string }[]> {
  const base = path.join(claudeDir, "plugins", "synced");
  const out: { root: string; name: string }[] = [];
  for (const org of await entriesIfExists(base)) {
    for (const id of await entriesIfExists(path.join(base, org))) {
      const root = path.join(base, org, id);
      const manifest = await readJson(path.join(root, ".claude-plugin", "plugin.json"));
      const name = isObj(manifest) ? str(manifest, "name") : undefined;
      if (name) out.push({ root, name });
    }
  }
  return out;
}

/** Account skills synced from claude.ai. Transcripts invoke them as "anthropic-skills:<name>". */
async function syncedSkills(claudeDir: string): Promise<SkillDef[]> {
  const base = path.join(claudeDir, "skills", "synced");
  const out: SkillDef[] = [];
  for (const org of await entriesIfExists(base)) {
    if (org.startsWith(".")) continue;
    for (const dir of await entriesIfExists(path.join(base, org))) {
      const def = await readDef(path.join(base, org, dir, "SKILL.md"), dir, "skill", "synced", "anthropic-skills");
      if (def) out.push(def);
    }
  }
  return out;
}

async function collect(label: string, errors: string[], task: () => Promise<SkillDef[]>): Promise<SkillDef[]> {
  try {
    return await task();
  } catch (e) {
    // One broken source must not hide the others. The UI lists every failure.
    errors.push(`${label}: ${messageOf(e)}`);
    return [];
  }
}

export async function scanSkills(claudeDir: string, projectDirs: string[]): Promise<Inventory> {
  const errors: string[] = [];
  const found: SkillDef[] = [];
  // skills/synced has no SKILL.md at its top level, so the user scan skips it on its own.
  found.push(...(await collect("user skills", errors, () => scanRoot(claudeDir, "user", undefined))));
  found.push(...(await collect("synced skills", errors, () => syncedSkills(claudeDir))));
  for (const source of [installedPluginRoots, syncedPluginRoots]) {
    let roots: { root: string; name: string }[];
    try {
      roots = await source(claudeDir);
    } catch (e) {
      errors.push(`plugins: ${messageOf(e)}`);
      continue;
    }
    for (const { root, name } of roots) found.push(...(await collect(`plugin ${name}`, errors, () => scanRoot(root, "plugin", name))));
  }
  for (const dir of projectDirs) {
    found.push(...(await collect(`project ${dir}`, errors, () => scanRoot(path.join(dir, ".claude"), "project", undefined))));
  }
  // The same plugin installed at several versions, or one repo seen in many worktrees, gives duplicates.
  const byId = new Map<string, SkillDef>();
  for (const def of found) if (!byId.has(def.id)) byId.set(def.id, def);
  return { skills: [...byId.values()], errors };
}

