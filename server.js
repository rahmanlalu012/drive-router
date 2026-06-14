import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, URL } from "node:url";
import {
  hasCredentials, makeOAuthClient, authUrl, exchangeAndSave,
  loadAccounts, gatherAll, accountQuota, fmtBytes,
} from "./core.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const REDIRECT_URI = `http://localhost:${PORT}/oauth2callback`;

function json(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(body);
}

function sendFile(res, file, type) {
  fs.readFile(path.join(__dirname, "public", file), (err, buf) => {
    if (err) { res.writeHead(404); res.end("Not found"); return; }
    res.writeHead(200, { "Content-Type": type });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, REDIRECT_URI);
    const p = u.pathname;

    if (p === "/" || p === "/index.html") return sendFile(res, "index.html", "text/html; charset=utf-8");

    if (p === "/api/config") {
      return json(res, 200, { hasCredentials: hasCredentials() });
    }

    if (p === "/api/accounts") {
      const accounts = loadAccounts();
      const emails = Object.keys(accounts);
      const out = await Promise.all(emails.map(async (email) => {
        try {
          const q = await accountQuota(accounts[email], REDIRECT_URI);
          return { email, usage: Number(q.usage || 0), limit: q.limit ? Number(q.limit) : null, ok: true };
        } catch (e) {
          return { email, ok: false, error: e?.message };
        }
      }));
      return json(res, 200, { accounts: out });
    }

    if (p === "/api/files") {
      const query = u.searchParams.get("q") || undefined;
      const folderId = u.searchParams.get("folderId") || undefined;
      const { files, errors } = await gatherAll({ query, folderId, pageSize: 100 }, REDIRECT_URI);
      return json(res, 200, {
        files: files.map((f) => ({
          id: f.id, name: f.name, mimeType: f.mimeType, size: f.size ? Number(f.size) : null,
          modifiedTime: f.modifiedTime, webViewLink: f.webViewLink, account: f._account,
        })),
        errors,
      });
    }

    if (p === "/api/auth/start") {
      if (!hasCredentials()) return json(res, 400, { error: "Credentials belum diisi di .env" });
      const oauth2 = makeOAuthClient(REDIRECT_URI);
      res.writeHead(302, { Location: authUrl(oauth2) });
      return res.end();
    }

    if (p === "/oauth2callback") {
      const code = u.searchParams.get("code");
      const err = u.searchParams.get("error");
      if (err || !code) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        return res.end(`<script>window.location="/"</script>Gagal: ${err || "no code"}`);
      }
      const oauth2 = makeOAuthClient(REDIRECT_URI);
      await exchangeAndSave(oauth2, code);
      res.writeHead(302, { Location: "/" });
      return res.end();
    }

    res.writeHead(404);
    res.end("Not found");
  } catch (e) {
    json(res, 500, { error: e?.message || String(e) });
  }
});

server.listen(PORT, () => {
  console.log(`\n  drive-router web console berjalan di:  http://localhost:${PORT}\n`);
  if (!hasCredentials()) {
    console.log("  ⚠️  GOOGLE_CLIENT_ID / SECRET belum diisi di .env — isi dulu sebelum tambah akun.\n");
  }
  console.log("  Tekan Ctrl+C untuk berhenti.\n");
});

export {};
