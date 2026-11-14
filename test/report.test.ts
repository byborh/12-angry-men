import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import { createDemo } from "../src/demo.ts";
import { scanHistory } from "../src/history.ts";
import { type Report, buildReport } from "../src/report.ts";
import { scanTranscripts } from "../src/transcripts.ts";
import { Fixture, assistant, at, human } from "./fixture.ts";

let fx: Fixture;

before(async () => {
  fx = await Fixture.create();
  await fx.transcript("-repo", "s1", [
    human("<command-name>/review</command-name>", 0),
    assistant("m1", 1, [{ name: "Bash" }], 100),
    assistant("m1", 1, [{ name: "Read" }], 100),
    human("<ide_opened_file>a.ts</ide_opened_file> no, wrong file", 5),
    assistant("m2", 6, [{ name: "Edit" }]),
    human("ship it please", 10),
    assistant("m3", 11, [{ name: "Skill", skill: "ship" }]),
    human("ship it now", 20),
    assistant("m4", 21, [{ name: "Edit" }]),
    { type: "user", isMeta: true, origin: { kind: "human" }, message: { content: "meta" }, timestamp: at(30) },
    { type: "user", message: { content: [{ type: "tool_result", content: "x" }] }, timestamp: at(31) },
    '{"type":"user", broken',
  ]);
  // An automated run: SDK prompts carry no human origin.
  await fx.transcript("-repo", "s2", [{ type: "user", message: { content: "automated" }, timestamp: at(100) }, assistant("m5", 101, [{ name: "Read" }])]);
  await fx.file("projects/-repo/s1/subagents/agent-1.jsonl", JSON.stringify(assistant("m6", 3, [{ name: "Grep" }])) + "\n");
  await fx.skill("review", "Review code.");
  await fx.skill("ship", 'Ship the branch. Use when the user says "ship it".');
  await fx.skill("unused", 'Never used. Use when the user says "do the thing".');
  await fx.file(
    "history.jsonl",
    [
      { display: "/review old", timestamp: Date.parse(at(-100_000)), sessionId: "gone", project: "/repo" },
      { display: "/review again", timestamp: Date.parse(at(0)), sessionId: "s1", project: "/repo" },
    ]
      .map((r) => JSON.stringify(r))
      .join("\n") + "\n",
  );
});

after(async () => {
  await fx.cleanup();
});

test("transcripts: human prompts, usage once per message id, invocations, turns", async () => {
  const scan = await scanTranscripts(fx.dir);
  const s1 = scan.sessions.find((s) => s.id === "s1");
  assert.ok(s1);
  assert.equal(s1.humanPrompts, 4, "meta, tool results and the bad line are not prompts");
  assert.equal(s1.corrections, 1, "the IDE block does not hide the correction");
  assert.equal(scan.skippedLines, 1);
  assert.equal(scan.models.get("claude-test")?.output, 100 + 10 + 10 + 10 + 10 + 10, "m1 counts once; subagent counts");
  assert.equal(scan.tools.get("Read"), 2);
  assert.deepEqual(
    scan.invocations.map((i) => `${i.via}:${i.name}`),
    ["slash:review", "auto:ship"],
  );
  assert.deepEqual(
    scan.turns.map((t) => t.invoked),
    [["review"], [], ["ship"], []],
  );
  assert.equal(scan.sessions.filter((s) => s.isSubagent).length, 1);
});

test("history: sessions with a transcript are skipped", async () => {
  const h = await scanHistory(fx.dir, new Set(["s1"]));
  assert.deepEqual(
    h.invocations.map((i) => i.name),
    ["review"],
  );
  assert.equal(h.from, Date.parse(at(-100_000)));
});

test("report: statuses, missed triggers, project scope", async () => {
  const report: Report = await buildReport(fx.dir);
  const row = (id: string) => {
    const r = report.skills.find((s) => s.id === id);
    assert.ok(r, `skill ${id} is listed`);
    return r;
  };
  assert.equal(row("review").slash, 2, "transcript + history from a deleted session");
  assert.equal(row("review").lastUsed, Date.parse(at(0)));
  assert.equal(row("unused").status, "unused");
  assert.deepEqual(
    { matched: row("ship").triggers?.matched, missed: row("ship").triggers?.missed },
    { matched: 2, missed: 1 },
  );
  assert.equal(row("ship").triggers?.examples[0]?.excerpt, "ship it now");
  assert.equal(row("unused").triggers?.matched, 0);
  assert.equal(report.totals.sessions, 1);
  assert.equal(report.totals.automatedSessions, 1);
  assert.equal(report.totals.subagentRuns, 1);
  assert.equal(report.warnings.length, 1, "the skipped line is reported");
});

test("project skills only count prompts inside their repo", async () => {
  const local = await Fixture.create();
  try {
    await local.transcript("-elsewhere", "x", [human("ship it", 0, "/elsewhere")]);
    await local.skill("local", 'Use when the user says "ship it".', path.join(local.dir, "repo", ".claude"));
    await local.transcript("-repo", "y", [human("ship it", 0, path.join(local.dir, "repo"))]);
    const report = await buildReport(local.dir);
    const row = report.skills.find((s) => s.id === "local");
    assert.equal(row?.source, "project");
    assert.equal(row?.triggers?.matched, 1);
  } finally {
    await local.cleanup();
  }
});

test("demo data builds a clean report", async () => {
  const dir = await createDemo(Date.parse("2026-11-14T18:00:00Z"));
  after(() => rm(dir, { recursive: true, force: true }));
  const report = await buildReport(dir);
  assert.deepEqual(report.warnings, []);
  assert.ok(report.totals.humanPrompts > 100);
  assert.ok(report.skills.some((s) => s.status === "unused"));
  assert.ok(report.skills.some((s) => (s.triggers?.missed ?? 0) > 0), "the demo shows a missed trigger");
});
