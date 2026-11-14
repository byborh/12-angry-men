import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** Builds a minimal ~/.claude in a temp folder. Each test states exactly the records it needs. */
export class Fixture {
  readonly dir: string;

  private constructor(dir: string) {
    this.dir = dir;
  }

  static async create(): Promise<Fixture> {
    return new Fixture(await mkdtemp(path.join(os.tmpdir(), "12am-test-")));
  }

  async file(relative: string, content: string): Promise<string> {
    const full = path.join(this.dir, relative);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content);
    return full;
  }

  /** A string record is written as-is, to test broken lines. */
  async transcript(project: string, sessionId: string, records: (object | string)[]): Promise<string> {
    const lines = records.map((r) => (typeof r === "string" ? r : JSON.stringify(r)));
    return this.file(path.join("projects", project, `${sessionId}.jsonl`), lines.join("\n") + "\n");
  }

  async skill(name: string, description: string, root: string = this.dir): Promise<void> {
    const full = path.join(root, "skills", name, "SKILL.md");
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\nBody.\n`);
  }

  async cleanup(): Promise<void> {
    await rm(this.dir, { recursive: true, force: true });
  }
}

const T0 = Date.parse("2026-11-02T10:00:00Z");

export function at(minutes: number): string {
  return new Date(T0 + minutes * 60_000).toISOString();
}

export function human(text: string, minutes: number, cwd = "/repo"): object {
  return { type: "user", origin: { kind: "human" }, message: { role: "user", content: text }, timestamp: at(minutes), cwd };
}

export function assistant(id: string, minutes: number, tools: { name: string; skill?: string }[], output = 10): object {
  const content = tools.map((t) => ({ type: "tool_use", name: t.name, input: t.skill ? { skill: t.skill } : {} }));
  return { type: "assistant", message: { id, model: "claude-test", content, usage: { input_tokens: 1, output_tokens: output } }, timestamp: at(minutes), cwd: "/repo" };
}
