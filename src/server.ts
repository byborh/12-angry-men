import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { messageOf } from "./fsutil.ts";
import { buildReport } from "./report.ts";

const PUBLIC_DIR = fileURLToPath(new URL("../public/", import.meta.url));

/** Fixed list: no path from the request reaches the file system. */
const STATIC: Record<string, { file: string; type: string }> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/style.css": { file: "style.css", type: "text/css; charset=utf-8" },
};

function send(res: ServerResponse, status: number, type: string, body: string | Buffer): void {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(body);
}

/** A web page on another site can reach 127.0.0.1 through DNS rebinding. The Host header exposes it. */
function hostAllowed(req: IncomingMessage, port: number): boolean {
  const host = req.headers.host;
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

async function handle(req: IncomingMessage, res: ServerResponse, port: number, claudeDir: string): Promise<void> {
  if (!hostAllowed(req, port)) return send(res, 403, "text/plain", "Forbidden host");
  if (req.method !== "GET") return send(res, 405, "text/plain", "Method not allowed");
  const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
  if (pathname === "/api/report") {
    const report = await buildReport(claudeDir);
    return send(res, 200, "application/json", JSON.stringify(report));
  }
  const asset = STATIC[pathname];
  if (!asset) return send(res, 404, "text/plain", "Not found");
  send(res, 200, asset.type, await readFile(PUBLIC_DIR + asset.file));
}

export function startServer(port: number, claudeDir: string): Promise<Server> {
  const server = createServer((req, res) => {
    handle(req, res, port, claudeDir).catch((e: unknown) => {
      console.error(`[12-angry-men] ${req.url}: ${messageOf(e)}`);
      if (!res.headersSent) send(res, 500, "text/plain", `Error: ${messageOf(e)}`);
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    // Bound to loopback only: the report describes private conversations.
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}
