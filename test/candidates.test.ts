import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { after, before, test } from "node:test";
import { type Ask, draftSkill, findCandidates, installSkill, selectPrompts, verifyGroups } from "../src/candidates.ts";
import { HttpError } from "../src/httpError.ts";
import { isObj } from "../src/json.ts";
import { parseFrontmatter } from "../src/skills.ts";
import { startServer } from "../src/server.ts";
import type { Turn } from "../src/transcripts.ts";
import { Fixture, human } from "./fixture.ts";

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse("2026-11-02T10:00:00");

function turn(text: string, day: number, session: string, extra: Partial<Turn> = {}): Turn {
  return { text, at: T0 + day * DAY, project: "/repo", session, invoked: [], tools: ["Bash", "Read"], ...extra };
}

const TURNS: Turn[] = [
  turn("fais le bilan de TECH-1", 0, "a"),
  turn("non, ajoute les commits aussi", 0, "a"),
  turn("fais le bilan de TECH-2", 1, "b"),
  turn("fais le bilan de TECH-3", 2, "c"),
  turn("short", 2, "c"),
  turn("review this PR", 3, "d", { invoked: ["pr-review"] }),
  turn("rename a variable in utils", 3, "d"),
];

function fakeAsk(output: unknown, record: string[] = []): Ask {
  return async (_system, prompt) => {
    record.push(prompt);
    return { output, costUsd: 0.01 };
  };
}

test("selectPrompts leaves out covered, short and correction prompts", () => {
  const texts = selectPrompts(TURNS).map((s) => s.turn.text);
  assert.deepEqual(texts.sort(), ["fais le bilan de TECH-1", "fais le bilan de TECH-2", "fais le bilan de TECH-3", "rename a variable in utils"]);
});

test("verifyGroups keeps proven groups only and ignores invented ids", () => {
  const selected = selectPrompts(TURNS);
  const idOf = (text: string) => selected.find((s) => s.turn.text === text)?.id;
  const bilan = ["fais le bilan de TECH-1", "fais le bilan de TECH-2", "fais le bilan de TECH-3"].map(idOf);
  const output = {
    groups: [
      { name: "bilan", title: "Ticket summary", why: "Summarize a ticket.", ids: [...bilan, 9999], overlaps: "ghost-skill" },
      { name: "rename", title: "Rename", why: "Rename things.", ids: [idOf("rename a variable in utils"), 9998, 9997], overlaps: "" },
    ],
  };
  const { candidates, rejected } = verifyGroups(output, selected, TURNS, [{ id: "bilan", description: "" }]);
  assert.equal(rejected, 1, "one real prompt plus invented ids is not proof");
  assert.equal(candidates.length, 1);
  const c = candidates[0];
  assert.ok(c);
  assert.equal(c.name, "bilan-2", "an existing skill name is never reused");
  assert.equal(c.occurrences.length, 3);
  assert.equal(c.sessions, 3);
  assert.deepEqual(c.occurrences[0]?.followUps, ["non, ajoute les commits aussi"]);
  assert.equal(c.overlaps, null, "an overlap with a skill that does not exist is dropped");
});

test("verifyGroups keeps an overlap with a real installed skill", () => {
  const selected = selectPrompts(TURNS);
  const ids = selected.filter((s) => s.turn.text.startsWith("fais le bilan")).map((s) => s.id);
  const known = [{ id: "plugin:bilan", description: "Ticket summary." }];
  const { candidates } = verifyGroups({ groups: [{ name: "ticket-bilan", title: "Bilan", why: "Bilan.", ids, overlaps: "plugin:bilan" }] }, selected, TURNS, known);
  assert.equal(candidates[0]?.overlaps, "plugin:bilan");
});

test("verifyGroups rejects a group seen in one session only", () => {
  const sameSession = [turn("deploy staging now", 0, "x"), turn("deploy staging again", 1, "x"), turn("deploy staging once more", 2, "x")];
  const selected = selectPrompts(sameSession);
  const { candidates, rejected } = verifyGroups({ groups: [{ name: "deploy", title: "Deploy", why: "Deploy.", ids: selected.map((s) => s.id), overlaps: "" }] }, selected, sameSession, []);
  assert.equal(candidates.length, 0);
  assert.equal(rejected, 1);
});

test("verifyGroups fails loudly on a malformed answer", () => {
  assert.throws(() => verifyGroups({ nope: [] }, [], [], []), /groups/);
});

test("findCandidates sends excerpts, not covered prompts", async () => {
  const sent: string[] = [];
  const run = await findCandidates(TURNS, [{ id: "pr-review", description: "Review a PR." }], fakeAsk({ groups: [] }, sent));
  assert.equal(run.promptsSent, 4);
  assert.ok(sent[0]?.includes("- pr-review: Review a PR."), "installed skills reach the grouping prompt");
  assert.ok(sent[0]?.includes("fais le bilan de TECH-1"));
  assert.ok(!sent[0]?.includes("review this PR"));
});

test("draftSkill builds a SKILL.md that the skill parser reads back", async () => {
  const selected = selectPrompts(TURNS);
  const ids = selected.filter((s) => s.turn.text.startsWith("fais le bilan")).map((s) => s.id);
  const { candidates } = verifyGroups({ groups: [{ name: "ticket-bilan", title: "Bilan", why: "Bilan.", ids, overlaps: "" }] }, selected, TURNS, []);
  const c = candidates[0];
  assert.ok(c);
  const sent: string[] = [];
  const draft = await draftSkill(c, [], fakeAsk({ description: 'Summarize a ticket. Use when the user says "fais le bilan de TECH-XXXX".', body: "1. Read the ticket." }, sent));
  assert.deepEqual(parseFrontmatter(draft.markdown), { name: "ticket-bilan", description: 'Summarize a ticket. Use when the user says "fais le bilan de TECH-XXXX".' });
  assert.ok(sent[0]?.includes("non, ajoute les commits aussi"), "follow-up corrections reach the draft prompt");
});

let fx: Fixture;
before(async () => {
  fx = await Fixture.create();
});
after(async () => {
  await fx.cleanup();
});

test("installSkill writes once, then refuses to overwrite", async () => {
  const content = "---\nname: my-skill\ndescription: d\n---\nBody\n";
  const file = await installSkill(fx.dir, "my-skill", content);
  assert.equal(await readFile(file, "utf8"), content);
  await assert.rejects(installSkill(fx.dir, "my-skill", content), (e) => e instanceof HttpError && e.status === 409);
  await assert.rejects(installSkill(fx.dir, "../evil", content), (e) => e instanceof HttpError && e.status === 400);
  await assert.rejects(installSkill(fx.dir, "other", content), (e) => e instanceof HttpError && e.status === 400, "frontmatter name must match");
});

test("server: writes need the custom header, and the flow runs end to end", async () => {
  const dir = await Fixture.create();
  try {
    const days = [0, 1, 2];
    for (const d of days) await dir.transcript("-repo", `s${d}`, [human(`fais le bilan de TECH-${d}`, d * 24 * 60)]);
    let call = 0;
    const ask: Ask = async (_s, prompt) => {
      call++;
      if (call === 1) {
        const ids = [...prompt.matchAll(/^(\d+) \|/gm)].map((m) => Number(m[1]));
        return { output: { groups: [{ name: "bilan", title: "Bilan", why: "Bilan.", ids, overlaps: "" }] }, costUsd: null };
      }
      return { output: { description: "Bilan.", body: "1. Do it." }, costUsd: null };
    };
    const server = await startServer(0, dir.dir, "test", ask);
    // A TCP server bound to an IP always returns AddressInfo, never a string.
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const headers = { "content-type": "application/json", "x-12am": "1" };
    const postJson = async (route: string, body: object, h: Record<string, string> = headers) => fetch(`${base}${route}`, { method: "POST", headers: h, body: JSON.stringify(body) });
    try {
      assert.equal((await postJson("/api/candidates", {}, { "content-type": "application/json" })).status, 403);
      const run: unknown = await (await postJson("/api/candidates", {})).json();
      assert.ok(isObj(run) && Array.isArray(run["candidates"]) && run["candidates"].length === 1);
      const draft: unknown = await (await postJson("/api/draft", { name: "bilan" })).json();
      assert.ok(isObj(draft) && typeof draft["markdown"] === "string");
      assert.equal((await postJson("/api/install", { name: "bilan", content: draft["markdown"] })).status, 200);
      assert.match(await readFile(path.join(dir.dir, "skills", "bilan", "SKILL.md"), "utf8"), /^---\nname: bilan\n/);
      assert.equal((await postJson("/api/install", { name: "bilan", content: draft["markdown"] })).status, 409);
    } finally {
      server.close();
    }
  } finally {
    await dir.cleanup();
  }
});

