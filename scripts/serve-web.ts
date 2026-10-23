import http from "http";
import fs from "fs";
import path from "path";

/**
 * Serves web/ on :5173, deliberately on a different origin from the verifier
 * on :8787. That is not an accident — it means the CORS allowlist and the
 * SIWE domain binding are actually exercised in development instead of being
 * discovered in production.
 */
const ROOT = path.resolve(__dirname, "..", "web");
const PORT = Number(process.env.WEB_PORT ?? 5173);

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

http
  .createServer((req, res) => {
    const url = (req.url ?? "/").split("?")[0];
    const rel = url === "/" ? "index.html" : decodeURIComponent(url).replace(/^\/+/, "");
    const file = path.join(ROOT, rel);

    if (!file.startsWith(ROOT)) {
      res.writeHead(403).end("forbidden");
      return;
    }
    fs.readFile(file, (err, buf) => {
      if (err) {
        res.writeHead(404).end("not found");
        return;
      }
      res.writeHead(200, {
        "content-type": TYPES[path.extname(file)] ?? "application/octet-stream",
        "cache-control": "no-store",
      });
      res.end(buf);
    });
  })
  .listen(PORT, () => console.log(`web on http://localhost:${PORT}`));
