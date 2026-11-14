import assert from "node:assert/strict";
import { test } from "node:test";
import { parseFrontmatter } from "../src/skills.ts";
import { stripIdeContext } from "../src/transcripts.ts";
import { extractPhrases, phraseToRegExp } from "../src/triggers.ts";

test("frontmatter: one-line, quoted with escapes, and block scalar", () => {
  assert.deepEqual(parseFrontmatter("---\nname: a\ndescription: plain text\n---\n"), { name: "a", description: "plain text" });
  assert.deepEqual(parseFrontmatter('---\nname: b\ndescription: "say \\"hi\\" now"\n---\n'), { name: "b", description: 'say "hi" now' });
  assert.deepEqual(parseFrontmatter("---\nname: c\ndescription: >\n  first line\n  second line\n---\n"), { name: "c", description: "first line second line" });
  assert.deepEqual(parseFrontmatter("no frontmatter"), {});
});

test("phrases: quoted text, slash commands excluded", () => {
  assert.deepEqual(extractPhrases('Use when the user says "j\'ai fini TECH-XXXX", “bilan” or "/bilan".'), ["j'ai fini TECH-XXXX", "bilan"]);
});

test("phrase regexp: placeholders, curly apostrophe, word boundaries", () => {
  const done = phraseToRegExp("j'ai fini TECH-XXXX");
  assert.ok(done.test("J’ai fini TECH-2832, fais le point"));
  assert.ok(!done.test("j'ai finir TECH-1"));
  const word = phraseToRegExp("bilan");
  assert.ok(word.test("bilan du ticket"));
  assert.ok(!word.test("fais un bilan"), "a one-word phrase matches only at the start");
  assert.ok(!word.test("bilans"));
});

test("IDE context blocks are removed from the start of a prompt", () => {
  assert.equal(stripIdeContext("<ide_opened_file>x</ide_opened_file>\n<ide_selection>y</ide_selection> no, wrong file"), "no, wrong file");
  assert.equal(stripIdeContext("keep <ide_selection>y</ide_selection>"), "keep <ide_selection>y</ide_selection>");
});
