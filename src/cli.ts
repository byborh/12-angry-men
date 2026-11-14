#!/usr/bin/env node
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { askClaude } from "./claude.ts";
import { createDemo } from "./demo.ts";
import { messageOf } from "./fsutil.ts";
import { tildify } from "./report.ts";
import { startServer } from "./server.ts";

const USAGE = `Usage: 12-angry-men [--port <number>] [--dir <claude dir> | --demo] [--no-open]

  --port     Local port. Default: 4512.
  --dir      Claude Code folder. Default: ~/.claude.
  --demo     Show generated fake data. Your files are not read.
  --no-open  Do not open the browser.`;

interface Options {
  port: number;
  claudeDir: string | undefined;
  demo: boolean;
  open: boolean;
}

function fail(message: string): never {
  console.error(`12-angry-men: ${message}\n\n${USAGE}`);
  process.exit(1);
}

function parseArgs(argv: string[]): Options {
  const opts: Options = { port: 4512, claudeDir: undefined, demo: false, open: true };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--no-open") {
      opts.open = false;
      continue;
    }
    if (arg === "--demo") {
      opts.demo = true;
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
  if (opts.demo && opts.claudeDir) fail("--demo and --dir cannot be used together");
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

/** The demo folder is temporary: remove it when the server stops. */
async function demoDir(): Promise<string> {
  const dir = await createDemo();
  const cleanup = (): void => rmSync(dir, { recursive: true, force: true });
  process.on("exit", cleanup);
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => process.exit(0));
  return dir;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const claudeDir = opts.demo ? await demoDir() : (opts.claudeDir ?? path.join(os.homedir(), ".claude"));
  await assertTranscripts(claudeDir);
  await startServer(opts.port, claudeDir, opts.demo ? "demo data" : tildify(claudeDir), askClaude);
  const url = `http://127.0.0.1:${opts.port}/`;
  console.log(`12 Angry Men reads ${opts.demo ? "generated demo data" : claudeDir}\nOpen ${url}  (Ctrl+C to stop)`);
  if (opts.open) openBrowser(url);
}

main().catch((e: unknown) => fail(messageOf(e)));
