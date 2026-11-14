#!/usr/bin/env node
import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { messageOf } from "./fsutil.ts";
import { startServer } from "./server.ts";

const USAGE = `Usage: 12-angry-men [--port <number>] [--dir <claude dir>] [--no-open]

  --port     Local port. Default: 4512.
  --dir      Claude Code folder. Default: ~/.claude.
  --no-open  Do not open the browser.`;

interface Options {
  port: number;
  claudeDir: string;
  open: boolean;
}

function fail(message: string): never {
  console.error(`12-angry-men: ${message}\n\n${USAGE}`);
  process.exit(1);
}

function parseArgs(argv: string[]): Options {
  const opts: Options = { port: 4512, claudeDir: path.join(os.homedir(), ".claude"), open: true };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--no-open") {
      opts.open = false;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      console.log(USAGE);
      process.exit(0);
    }
    const value = argv[++i];
    if (value === undefined) fail(`missing value for ${arg}`);
    if (arg === "--port") {
      const port = Number(value);
      if (!Number.isInteger(port) || port < 1 || port > 65535) fail(`invalid port: ${value}`);
      opts.port = port;
      continue;
    }
    if (arg === "--dir") {
      opts.claudeDir = path.resolve(value);
      continue;
    }
    fail(`unknown option: ${arg}`);
  }
  return opts;
}

async function assertTranscripts(claudeDir: string): Promise<void> {
  const projects = path.join(claudeDir, "projects");
  try {
    if ((await stat(projects)).isDirectory()) return;
  } catch (e) {
    fail(`cannot read ${projects}: ${messageOf(e)}`);
  }
  fail(`${projects} is not a folder`);
}

function openBrowser(url: string): void {
  const [cmd, args]: [string, string[]] =
    process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
  child.on("error", (e) => console.error(`Could not open the browser (${messageOf(e)}). Open ${url} yourself.`));
  child.unref();
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  await assertTranscripts(opts.claudeDir);
  await startServer(opts.port, opts.claudeDir);
  const url = `http://127.0.0.1:${opts.port}/`;
  console.log(`12 Angry Men reads ${opts.claudeDir}\nOpen ${url}  (Ctrl+C to stop)`);
  if (opts.open) openBrowser(url);
}

main().catch((e: unknown) => fail(messageOf(e)));
