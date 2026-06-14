import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, URL } from "node:url";
import {
  hasCredentials, makeOAuthClient, authUrl, exchangeAndSave,
  loadAccounts, gatherAll, accountQuota, fmtBytes,
  uploadFile, transferFile, deleteFile, downloadFile, pickBestAccount,
  TMP_DIR, ensureConfigDir,
} from "./core.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3020);
const REDIRECT_URI = `http://localhost:${PORT}/oauth2callback`;

function json(res, code, data) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

function sendFile(res, file, type) {
  fs.readFile(path.join(__dirname, "public", file), (err, buf) => {
    if (err) { res.writeHead(404); res.end("Not found"); return; }
    res.writeHead(200, { "Content-Type": type });
    res.end(buf);
  });
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => { data += c; if (data.length > 5e6) reject(new Error("body too large")); });
    req.on("end", () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
    req.on("error", reject);
  });
}

function streamToTmp(req) {
  ensureConfigDir();
  const tmp = path.join(TMP_DIR, `up_${Date.now()}_${Math.random().toString(36).slice(2)}`);
  return new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(tmp);
    req.pipe(ws);
    ws.on("finish", () => resolve(tmp));
    ws.on("error", reject);
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, REDIRECT_URI);
    const p = u.pathname;
    const m = req.method;

    if (p === "/" || p === "/index.html") return sendFile(res, "index.html", "text/html; charset=utf-8");

    if (p === "/api/config") return json(res, 200, { hasCredentials: hasCredentials() });

    if (p === "/api/accounts") {
      const accounts = loadAccounts();
      const out = await Promise.all(Object.keys(accounts).map(async (email) => {
        try {
          const q = await accountQuota(accounts[email], REDIRECT_URI);
          return { email, usage: Number(q.usage || 0), limit: q.limit ? Number(q.limit) : null, ok: true };
        } catch (e) { return { email, ok: false, error: e?.message }; }
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
      res.writeHead(302, { Location: authUrl(makeOAuthClient(REDIRECT_URI)) });
      return res.end();
    }

    if (p === "/oauth2callback") {
      const code = u.searchParams.get("code");
      const err = u.searchParams.get("error");
      if (err || !code) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        return res.end(`<script>window.location="/"</script>Gagal: ${err || "no code"}`);
      }
      await exchangeAndSave(makeOAuthClient(REDIRECT_URI), code);
      res.writeHead(302, { Location: "/" });
      return res.end();
    }

    // ---- Write endpoints ----

    if (p === "/api/upload" && m === "POST") {
      const name = u.searchParams.get("name") || "upload.bin";
      let account = u.searchParams.get("account") || null;
      const tmp = await streamToTmp(req);
      try {
        if (!account) {
          const size = fs.statSync(tmp).size;
          account = await pickBestAccount(REDIRECT_URI, size);
        }
        if (!account) return json(res, 400, { error: "Belum ada akun" });
        const out = await uploadFile(account, { localPath: tmp, name }, REDIRECT_URI);
        return json(res, 200, { ok: true, ...out });
      } finally { try { fs.unlinkSync(tmp); } catch {} }
    }

    if (p === "/api/transfer" && m === "POST") {
      const body = await readJsonBody(req);
      const { fileId, from, to, move } = body;
      if (!fileId || !from || !to) return json(res, 400, { error: "fileId, from, to wajib" });
      const out = await transferFile({ fileId, from, to, move: Boolean(move) }, REDIRECT_URI);
      return json(res, 200, { ok: true, ...out });
    }

    if (p === "/api/file" && m === "DELETE") {
      const id = u.searchParams.get("id");
      const account = u.searchParams.get("account");
      if (!id || !account) return json(res, 400, { error: "id & account wajib" });
      await deleteFile(account, id, REDIRECT_URI);
      return json(res, 200, { ok: true });
    }

    if (p === "/api/download" && m === "GET") {
      const id = u.searchParams.get("id");
      const account = u.searchParams.get("account");
      if (!id || !account) return json(res, 400, { error: "id & account wajib" });
      ensureConfigDir();
      const tmp = path.join(TMP_DIR, `dl_${Date.now()}`);
      const info = await downloadFile(account, id, tmp, REDIRECT_URI);
      res.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="${encodeURIComponent(info.name)}"`,
      });
      const rs = fs.createReadStream(tmp);
      rs.pipe(res);
      rs.on("close", () => { try { fs.unlinkSync(tmp); } catch {} });
      return;
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
