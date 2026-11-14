import { spawn } from "node:child_process";
import os from "node:os";
import { messageOf } from "./fsutil.ts";
import { isObj } from "./json.ts";

const TIMEOUT_MS = 5 * 60 * 1000;
const STDERR_MAX = 2000;

export interface ClaudeAnswer {
  output: unknown;
  /** As reported by Claude Code. On a subscription it is an estimate, not a bill. */
  costUsd: number | null;
}

/**
 * Runs the Claude Code CLI the user already has, in headless mode.
 * No tools, no MCP, no saved session: the call only reads the prompt and returns JSON that matches `schema`.
 */
export function askClaude(system: string, prompt: string, schema: object): Promise<ClaudeAnswer> {
  const args = [
    "-p",
    "--output-format", "json",
    "--no-session-persistence",
    "--tools", "",
    "--strict-mcp-config",
    "--system-prompt", system,
    "--json-schema", JSON.stringify(schema),
  ];
  return new Promise((resolve, reject) => {
    // A neutral folder: the call must not load the CLAUDE.md of the repo where the server started.
    const child = spawn("claude", args, { cwd: os.tmpdir(), stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`claude did not answer in ${TIMEOUT_MS / 60000} minutes`));
    }, TIMEOUT_MS);
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => (stderr = (stderr + d.toString("utf8")).slice(-STDERR_MAX)));
    child.on("error", (e) => {
      clearTimeout(timer);
      const missing = "code" in e && e.code === "ENOENT";
      reject(new Error(missing ? "The Claude Code CLI (claude) is not installed or not in PATH." : `claude: ${messageOf(e)}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      try {
        resolve(parseAnswer(code, stdout, stderr));
      } catch (e) {
        reject(e);
      }
    });
    child.stdin.end(prompt);
  });
}

function parseAnswer(code: number | null, stdout: string, stderr: string): ClaudeAnswer {
  let data: unknown;
  try {
    data = JSON.parse(stdout);
  } catch {
    throw new Error(`claude exited with code ${code} and no JSON. ${stderr.trim()}`);
  }
  if (!isObj(data)) throw new Error("claude returned JSON that is not an object");
  if (data["is_error"] === true || code !== 0) throw new Error(`claude failed: ${String(data["result"] ?? stderr.trim())}`);
  if (!("structured_output" in data)) throw new Error("claude returned no structured output");
  const cost = data["total_cost_usd"];
  return { output: data["structured_output"], costUsd: typeof cost === "number" ? cost : null };
}
