# 12 Angry Men

See which of your Claude Code skills you really use, which ones never start when they should, and which skills you are missing.

![Skills tab](docs/skills.png)

12 Angry Men reads your local Claude Code files (`~/.claude`). It shows a page with three tabs:

- **Skills**: every skill and command you have installed. How often you typed it, how often Claude called it, when you last used it, and how many tokens its listing costs in every session. Below the table: prompts that match a trigger phrase of a skill, but the skill did not run.
- **Candidates**: the tasks you ask for again and again, with the prompts as proof. One click drafts a skill from your real sessions. One more click installs it.
- **Activity**: prompts per day, when you work, your projects, the tools Claude calls, and token usage per model.

![Candidates tab](docs/candidates.png)

## Privacy

- **Skills** and **Activity** run on your machine. They call no LLM. The server listens on `127.0.0.1` only.
- **Candidates** sends data to Claude, and only when you click:
  - "Find repeated tasks" sends up to 1,200 recent prompts (the first 200 characters of each) and the names and descriptions of your skills.
  - "Draft the skill" sends the full prompts of one candidate, the tools Claude used, and your next prompts in those sessions.
- The calls go through your own Claude Code CLI (`claude -p`): no API key, no other server. The calls run without tools and without MCP servers, and Claude Code does not save them as sessions.

## Run

Requires Node.js 22 or later. There are no runtime dependencies. The Candidates tab also needs the Claude Code CLI (`claude`) in your `PATH`.

```sh
npx 12-angry-men          # your data
npx 12-angry-men --demo   # generated fake data, your files are not read
```

From a clone:

```sh
pnpm install
pnpm start                # or: pnpm demo
```

Options:

```
--port <number>   Local port. Default: 4512.
--dir <path>      Claude Code folder. Default: ~/.claude.
--demo            Show generated fake data. Cannot be used with --dir.
--no-open         Do not open the browser.
```

## How it counts

- **Your prompts**: only messages you typed. Tool results, system messages and prompts sent by automation through the SDK do not count. Sessions without a typed prompt show as "automated".
- **Typed**: a prompt that starts a skill with `/name`.
- **Auto**: Claude called the skill on its own (the `Skill` tool).
- **Status**: `active` if used in the last 30 days, `dormant` if used before that, `unused` if never used.
- **Listing tokens**: Claude Code puts the name and description of each skill in the context of every session. The page estimates 4 characters per token. Project skills load only in their repo, so the "unused listings" total leaves them out.
- **Missed triggers**: the page reads the quoted phrases in each skill description, for example `Use when the user says "fix the build"`. A prompt that matches a phrase, without the skill running before your next prompt, is a miss. `XXXX` and digit runs in a phrase match any id. A one-word phrase matches only at the start of a prompt.
- **Corrections**: prompts that start with "no", "wrong", "I said", "still doesn't work" and similar, in English and French. This is a heuristic.
- **Active time**: the sum of gaps between messages. A gap over 15 minutes counts as a break.

## How Candidates works

1. The page selects your prompts that no skill covers: no `/command`, no skill run in the same turn, not a correction, at least 12 characters.
2. Claude groups them by task: the same kind of work with different inputs. Claude answers with prompt ids only, so it cannot invent a prompt.
3. The page checks each group against your real sessions. A group stays only if it holds at least **3 prompts, in 2 sessions, on 2 days**. Ids that do not exist are dropped.
4. If an installed skill already does the task, the card says so. The fix is then to add your real phrases to that skill's description, not to write a second skill.
5. "Draft the skill" asks Claude for a SKILL.md built only from the steps and corrections in those sessions. The description quotes your real phrases, so the Missed column measures the new skill from day one.
6. You edit the draft, then install it to `~/.claude/skills/<name>/SKILL.md`. The page never overwrites a folder that exists.

## Sources

| File | What it gives |
|---|---|
| `projects/*/*.jsonl` | Sessions, prompts, tool calls, token usage |
| `projects/*/*/subagents/*.jsonl` | Subagent runs (tokens and tools only) |
| `history.jsonl` | Commands typed in the CLI, kept longer than transcripts. Entries of a session with a transcript are skipped, so nothing counts twice. |
| `skills/`, `commands/` | Your skills and commands |
| `skills/synced/` | Skills synced from claude.ai (`anthropic-skills:name`) |
| `plugins/installed_plugins.json`, `plugins/synced/` | Plugin skills (`plugin:name`) |
| `<repo>/.claude/skills/` | Project skills, for every repo seen in your transcripts |

## Limits

- Claude Code deletes old transcripts (setting `cleanupPeriodDays`). The page only sees what is still on disk. "Unused" means unused in that window.
- `history.jsonl` holds CLI prompts only. Prompts typed in an IDE extension are not in it.
- A skill that lives only in the cloud shows under "Invoked, but not found on disk".
- The transcript format is not a public API. A Claude Code update can break the parser. Problems show at the bottom of the page.

## Development

```sh
pnpm check   # type check (src and test)
pnpm test    # node:test, no extra dependency
pnpm build   # compile to dist/ for npm
```

![Activity tab](docs/activity.png)

## License

MIT
