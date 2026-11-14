import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** Fake data for screenshots and first runs. Seeded, so every run gives the same page. */

const DAY_MS = 24 * 60 * 60 * 1000;
const MODEL = "claude-sonnet-5-5";

interface DemoSkill {
  name: string;
  description: string;
}

const SKILLS: DemoSkill[] = [
  { name: "review-pr", description: 'Review the current pull request for bugs and security issues. Use when the user says "review this PR" or "is this safe to merge".' },
  { name: "write-changelog", description: 'Write the changelog entry for the current branch. Use when the user says "changelog" or "what changed since the last release".' },
  { name: "fix-ci", description: 'Read the failing CI job and fix it. Use when the user says "the CI is red" or "fix the build".' },
  { name: "standup", description: 'Summarize yesterday\'s commits for the daily standup. Use when the user says "standup" or "what did I do yesterday".' },
  { name: "sql-explain", description: 'Explain a slow SQL query and propose an index. Use when the user says "explain this query" or "why is this query slow".' },
  { name: "release-notes", description: 'Turn merged PRs into public release notes. Use when the user says "release notes".' },
  { name: "migrate-tests", description: "Move a test file from Jest to Vitest." },
  { name: "brand-voice", description: 'Rewrite marketing copy in the company voice. Use when the user says "make it sound like us".' },
];

const PROJECTS = ["/home/alex/code/webshop", "/home/alex/code/payments-api", "/home/alex/code/blog", "/home/alex/dotfiles"];

/** One-off work: each prompt is used once, so none of them is a habit. */
const ONE_OFFS = [
  "add a quantity selector to the cart page",
  "why does the checkout test fail on CI only",
  "rename userId to customerId in the orders module",
  "add retry with backoff to the webhook sender",
  "move the date helpers to a shared package",
  "split the ProductCard component, it is 600 lines",
  "the search API returns duplicates when I filter by brand",
  "add a dark mode toggle to the settings page",
  "upgrade eslint to v10 and fix the new warnings",
  "write a script that exports last month's invoices to CSV",
  "why is the bundle 2 MB bigger since yesterday",
  "add an OpenGraph image to the blog posts",
  "replace moment with date-fns in the blog",
  "the login form does not show server errors",
  "add pagination to the admin orders table",
  "make the price formatter handle JPY without decimals",
  "add a health check endpoint to the payments API",
  "the signup email has a broken link in Outlook",
  "set up a GitHub Action that runs the e2e tests nightly",
  "add rate limiting to the public API",
  "my zsh prompt is slow, profile it",
  "add a keyboard shortcut to open the search",
  "the invoice PDF cuts long addresses",
  "convert the blog config from YAML to TypeScript",
  "find why the webhook test leaks a timer",
  "add an empty state to the order history page",
  "the cart total is wrong when a coupon and free shipping stack",
  "add Sentry to the payments API",
  "write a README section about local HTTPS",
  "the RSS feed misses the last post",
  "make the admin table sortable by date",
  "add a retry button when the payment fails",
  "clean up the unused feature flags",
  "add types to the old analytics helper",
  "my tmux config breaks copy mode, fix it",
  "move the refund logic out of the controller",
  "the search page flickers on first load",
  "add a cookie banner that respects Do Not Track",
  "why does Docker rebuild everything on each change",
  "add structured logs to the order service",
];
const TABLES = ["orders.created_at", "users.email", "invoices.status", "carts.updated_at", "payments.provider_id"];
const FILES = ["checkout.json", "account.json", "emails.json", "errors.json", "pricing.json"];

/** Two habits with changing inputs: the Candidates tab must find them. */
function habit(rand: () => number): string {
  if (rand() < 0.5) return `write the migration for an index on ${pick(rand, TABLES)}, with the rollback`;
  return `translate the new strings in ${pick(rand, FILES)} to French and German`;
}

const CORRECTIONS = ["no, keep the old API and add a new one", "that's not what I asked, only the cart page", "still doesn't work, same error"];
const TOOLS = ["Bash", "Read", "Edit", "Grep", "Read", "Bash", "Edit", "Write", "Glob"];

/** mulberry32: a tiny seeded PRNG. */
function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rand: () => number, items: readonly T[]): T {
  const item = items[Math.floor(rand() * items.length)];
  if (item === undefined) throw new Error("pick() on an empty list");
  return item;
}

interface Ctx {
  rand: () => number;
  lines: string[];
  sessionId: string;
  cwd: string;
  at: number;
  msg: number;
  /** Shared by all sessions: each one-off prompt is used once. */
  oneOffs: string[];
}

function userLine(ctx: Ctx, content: string): void {
  ctx.lines.push(JSON.stringify({ type: "user", origin: { kind: "human" }, message: { role: "user", content }, timestamp: new Date(ctx.at).toISOString(), cwd: ctx.cwd, sessionId: ctx.sessionId }));
}

function assistantLine(ctx: Ctx, tool: { name: string; input: Record<string, string> }): void {
  ctx.at += 20_000 + Math.floor(ctx.rand() * 90_000);
  ctx.msg++;
  const usage = { input_tokens: 4, output_tokens: 200 + Math.floor(ctx.rand() * 1500), cache_read_input_tokens: 30_000 + Math.floor(ctx.rand() * 60_000), cache_creation_input_tokens: 2_000 };
  const content = [{ type: "tool_use", id: `toolu_${ctx.msg}`, name: tool.name, input: tool.input }];
  const message = { id: `msg_${ctx.sessionId}_${ctx.msg}`, model: MODEL, role: "assistant", content, usage };
  ctx.lines.push(JSON.stringify({ type: "assistant", message, timestamp: new Date(ctx.at).toISOString(), cwd: ctx.cwd, sessionId: ctx.sessionId }));
}

function turn(ctx: Ctx, prompt: string, skill: string | undefined): void {
  ctx.at += 60_000 + Math.floor(ctx.rand() * 300_000);
  userLine(ctx, prompt);
  if (skill) assistantLine(ctx, { name: "Skill", input: { skill } });
  const steps = 2 + Math.floor(ctx.rand() * 6);
  for (let i = 0; i < steps; i++) assistantLine(ctx, { name: pick(ctx.rand, TOOLS), input: {} });
}

/** Skills that run, skills typed by hand, one skill that misses its trigger, and skills never used. */
function sessionTurns(ctx: Ctx): void {
  const r = ctx.rand();
  if (r < 0.25) turn(ctx, "<command-name>/review-pr</command-name>", undefined);
  else if (r < 0.35) turn(ctx, "review this PR please", "review-pr");
  else if (r < 0.45) turn(ctx, "the CI is red, can you check the logs", undefined);
  else if (r < 0.5) turn(ctx, "<command-name>/write-changelog</command-name>", undefined);
  else if (r < 0.53) turn(ctx, "what did I do yesterday", undefined);
  const n = 1 + Math.floor(ctx.rand() * 3);
  for (let i = 0; i < n; i++) {
    const r2 = ctx.rand();
    if (r2 < 0.08) turn(ctx, pick(ctx.rand, CORRECTIONS), undefined);
    else if (r2 < 0.3) turn(ctx, habit(ctx.rand), undefined);
    else turn(ctx, ctx.oneOffs.shift() ?? habit(ctx.rand), undefined);
  }
}

function sessionStart(rand: () => number, day: Date): number {
  const d = new Date(day);
  const hour = rand() < 0.15 ? 20 + Math.floor(rand() * 3) : 9 + Math.floor(rand() * 9);
  d.setHours(hour, Math.floor(rand() * 60), 0, 0);
  return d.getTime();
}

async function writeSessions(dir: string, now: number): Promise<void> {
  const rand = rng(12);
  const oneOffs = [...ONE_OFFS];
  for (let back = 34; back >= 0; back--) {
    const day = new Date(now - back * DAY_MS);
    const weekend = day.getDay() === 0 || day.getDay() === 6;
    const sessions = weekend ? Math.floor(rand() * 2) : 1 + Math.floor(rand() * 4);
    for (let s = 0; s < sessions; s++) {
      const cwd = pick(rand, PROJECTS);
      const sessionId = `demo-${back}-${s}`;
      const ctx: Ctx = { rand, lines: [], sessionId, cwd, at: sessionStart(rand, day), msg: 0, oneOffs };
      if (ctx.at > now) continue;
      sessionTurns(ctx);
      const projectDir = path.join(dir, "projects", cwd.replace(/\//g, "-"));
      await mkdir(projectDir, { recursive: true });
      await writeFile(path.join(projectDir, `${sessionId}.jsonl`), `${ctx.lines.join("\n")}\n`);
    }
  }
}

async function writeSkills(dir: string): Promise<void> {
  for (const skill of SKILLS) {
    const skillDir = path.join(dir, "skills", skill.name);
    await mkdir(skillDir, { recursive: true });
    await writeFile(path.join(skillDir, "SKILL.md"), `---\nname: ${skill.name}\ndescription: ${JSON.stringify(skill.description)}\n---\n\nDemo skill.\n`);
  }
}

export async function createDemo(now: number = Date.now()): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "12-angry-men-demo-"));
  await writeSkills(dir);
  await writeSessions(dir, now);
  const old = { display: "/standup", pastedContents: {}, timestamp: now - 80 * DAY_MS, project: PROJECTS[0], sessionId: "deleted-session" };
  await writeFile(path.join(dir, "history.jsonl"), `${JSON.stringify(old)}\n`);
  return dir;
}
