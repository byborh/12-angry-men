import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { type Ask, type CandidateRun, draftSkill, findCandidates, installSkill } from "./candidates.ts";
import { messageOf } from "./fsutil.ts";
import { HttpError } from "./httpError.ts";
import { type Obj, isObj, str } from "./json.ts";
import { buildReport, projectDirsOf, tildify } from "./report.ts";
import { scanSkills } from "./skills.ts";
import { scanTranscripts } from "./transcripts.ts";

const PUBLIC_DIR = fileURLToPath(new URL("../public/", import.meta.url));
const BODY_MAX = 200_000;
const SHOWN_TEXT = 400;
const SHOWN_FOLLOW_UP = 200;

/** Fixed list: no path from the request reaches the file system. */
const STATIC: Record<string, { file: string; type: string }> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/style.css": { file: "style.css", type: "text/css; charset=utf-8" },
};

interface Ctx {
  port: number;
  claudeDir: string;
  /** Names the data source on the page: a path, or "demo data". */
  label: string;
  ask: Ask;
  run: CandidateRun | null;
  busy: boolean;
}

function send(res: ServerResponse, status: number, type: string, body: string | Buffer): void {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(body);
}

function sendJson(res: ServerResponse, value: unknown): void {
  send(res, 200, "application/json", JSON.stringify(value));
}

/** A web page on another site can reach 127.0.0.1 through DNS rebinding. The Host header exposes it. */
function hostAllowed(req: IncomingMessage, port: number): boolean {
  const host = req.headers.host;
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

/**
 * Writes need a custom header. A cross-site form cannot send one, and a cross-site fetch
 * needs a CORS preflight, which this server never accepts.
 */
async function readBody(req: IncomingMessage): Promise<Obj> {
  if (req.headers["x-12am"] !== "1") throw new HttpError(403, "Missing x-12am header");
  if (!req.headers["content-type"]?.startsWith("application/json")) throw new HttpError(415, "Expected application/json");
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buf.length;
    if (size > BODY_MAX) throw new HttpError(413, "Body too large");
    chunks.push(buf);
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Invalid JSON body");
  }
  if (!isObj(value)) throw new HttpError(400, "Expected a JSON object");
  return value;
}

function requiredString(body: Obj, key: string): string {
  const v = str(body, key);
  if (v === undefined || v === "") throw new HttpError(400, `Missing '${key}'`);
  return v;
}

/** The page needs excerpts, not full prompts. Full texts stay in the server for the draft step. */
function shownRun(run: CandidateRun): unknown {
  return {
    ...run,
    candidates: run.candidates.map((c) => ({
      ...c,
      occurrences: c.occurrences.map((o) => ({
        at: o.at,
        project: tildify(o.project),
        text: o.text.slice(0, SHOWN_TEXT),
        tools: o.tools.length,
        followUps: o.followUps.map((f) => f.slice(0, SHOWN_FOLLOW_UP)),
      })),
    })),
  };
}

async function loadSkillsAndTurns(claudeDir: string) {
  const scan = await scanTranscripts(claudeDir);
  const inventory = await scanSkills(claudeDir, projectDirsOf(scan.sessions));
  return { turns: scan.turns, skills: inventory.skills.map((s) => ({ id: s.id, description: s.description })) };
}

async function postCandidates(ctx: Ctx): Promise<unknown> {
  if (ctx.busy) throw new HttpError(409, "A search is already running.");
  ctx.busy = true;
  try {
    const { turns, skills } = await loadSkillsAndTurns(ctx.claudeDir);
    ctx.run = await findCandidates(turns, skills, ctx.ask);
    return shownRun(ctx.run);
  } finally {
    ctx.busy = false;
  }
}

async function postDraft(ctx: Ctx, body: Obj): Promise<unknown> {
  const name = requiredString(body, "name");
  const candidate = ctx.run?.candidates.find((c) => c.name === name);
  if (!candidate) throw new HttpError(404, `No candidate named ${name}. Run the search again.`);
  const { skills } = await loadSkillsAndTurns(ctx.claudeDir);
  return draftSkill(
    candidate,
    skills.map((s) => s.id),
    ctx.ask,
  );
}

async function postInstall(ctx: Ctx, body: Obj): Promise<unknown> {
  const file = await installSkill(ctx.claudeDir, requiredString(body, "name"), requiredString(body, "content"));
  return { path: tildify(file) };
}

async function handlePost(req: IncomingMessage, res: ServerResponse, ctx: Ctx, pathname: string): Promise<void> {
  const body = await readBody(req);
  if (pathname === "/api/candidates") return sendJson(res, await postCandidates(ctx));
  if (pathname === "/api/draft") return sendJson(res, await postDraft(ctx, body));
  if (pathname === "/api/install") return sendJson(res, await postInstall(ctx, body));
  throw new HttpError(404, "Not found");
}

async function handle(req: IncomingMessage, res: ServerResponse, ctx: Ctx): Promise<void> {
  if (!hostAllowed(req, ctx.port)) throw new HttpError(403, "Forbidden host");
  const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
  if (req.method === "POST") return handlePost(req, res, ctx, pathname);
  if (req.method !== "GET") throw new HttpError(405, "Method not allowed");
  if (pathname === "/api/report") return sendJson(res, { ...(await buildReport(ctx.claudeDir)), claudeDir: ctx.label });
  if (pathname === "/api/candidates") return sendJson(res, ctx.run ? shownRun(ctx.run) : null);
  const asset = STATIC[pathname];
  if (!asset) throw new HttpError(404, "Not found");
  send(res, 200, asset.type, await readFile(PUBLIC_DIR + asset.file));
}

export function startServer(port: number, claudeDir: string, label: string, ask: Ask): Promise<Server> {
  const ctx: Ctx = { port, claudeDir, label, ask, run: null, busy: false };
  const server = createServer((req, res) => {
    handle(req, res, ctx).catch((e: unknown) => {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) console.error(`[12-angry-men] ${req.method} ${req.url}: ${messageOf(e)}`);
      if (!res.headersSent) send(res, status, "text/plain; charset=utf-8", messageOf(e));
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    // Bound to loopback only: the report describes private conversations.
    server.listen(port, "127.0.0.1", () => {
      // With port 0 the OS picks a port. The Host check needs the real one.
      // A TCP server bound to an IP always returns AddressInfo, never a string.
      ctx.port = (server.address() as AddressInfo).port;
      resolve(server);
    });
  });
}
