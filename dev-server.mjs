import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";

const root = "C:\\Codex\\test";
const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};

http
  .createServer(async (req, res) => {
    const file = join(root, req.url === "/" ? "index.html" : req.url || "index.html");
    try {
      const body = await readFile(file);
      res.writeHead(200, { "content-type": types[extname(file)] || "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end("not found");
    }
  })
  .listen(4173, "127.0.0.1");
