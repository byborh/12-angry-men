# 12 Angry Men

See which of your Claude Code skills you really use.

12 Angry Men reads your local Claude Code transcripts (`~/.claude/projects`). It shows a page with two tabs:

- **Skills**: every skill and command you have installed, how often you typed it, how often Claude called it, and when you last used it. Unused skills still cost context tokens in every session.
- **Activity**: prompts per day, when you work, your projects, the tools Claude calls, and token usage per model.

Everything runs on your machine. The server listens on `127.0.0.1` only. No data leaves your computer. No LLM is called.

## Run

Requires Node.js 22.18 or later. There are no dependencies.

```sh
git clone <this repo>
cd 12-angry-men
npm start
```

Options:

```
--port <number>   Local port. Default: 4512.
--dir <path>      Claude Code folder. Default: ~/.claude.
--no-open         Do not open the browser.
```

## How it counts

- **Typed**: a prompt that starts a skill with `/name`.
- **Auto**: Claude called the skill on its own (the `Skill` tool).
- **Status**: `active` if used in the last 30 days, `dormant` if used before that, `unused` if never used in the window.
- **Listing tokens**: Claude Code puts each skill name and description in the context of every session. The page estimates it at 4 characters per token.
- **Your prompts**: only messages you typed. Tool results, system messages and automated SDK prompts do not count.
- **Corrections**: prompts that start with "no", "wrong", "I said", "still doesn't work" and similar, in English and French. This is a heuristic.
- **Active time**: the sum of gaps between messages. A gap over 15 minutes counts as a break.

## Limits

- Claude Code deletes old transcripts (setting `cleanupPeriodDays`). The page only sees what is still on disk, so "unused" means unused in that window.
- Skills shared from claude.ai and plugin skills are read from the local cache. A skill that lives only in the cloud shows under "Invoked, but not found on disk".
- The transcript format is not a public API. A Claude Code update can break the parser. Problems show at the bottom of the page.

## Roadmap

- Find what you do again and again, and propose a skill built from your real sessions, with the sessions as proof.
- Detect missed triggers: you did a task by hand while a skill for it was installed.

## License

MIT
