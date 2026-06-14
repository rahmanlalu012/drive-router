#!/usr/bin/env node
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { URL } from "node:url";
import open from "open";
import {
  hasCredentials, makeOAuthClient, authUrl, exchangeAndSave,
  loadAccounts, gatherAll, accountQuota, fmtBytes, isFolder,
  uploadFile, transferFile, pickBestAccount, freeBytes, listFromAccount, deleteFile,
} from "./core.js";
import { google } from "googleapis";

const REDIRECT_PORT = 53682;
const REDIRECT_URI = `http://127.0.0.1:${REDIRECT_PORT}/oauth2callback`;

const C = {
  reset: "\x1b[0m", dim: "\x1b[2m", bold: "\x1b[1m",
  cyan: "\x1b[36m", green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m", blue: "\x1b[34m",
};
const color = (c, s) => `${C[c]}${s}${C.reset}`;

function requireCredentials() {
  if (!hasCredentials()) {
    console.error(color("red", "GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET belum diisi."));
    console.error("Buat OAuth client (Desktop app) di Google Cloud Console, lalu isi .env. Lihat README.");
    process.exit(1);
  }
}

function waitForCode(url) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      try {
        const u = new URL(req.url, REDIRECT_URI);
        if (u.pathname !== "/oauth2callback") { res.writeHead(404); res.end(); return; }
        const code = u.searchParams.get("code");
        const err = u.searchParams.get("error");
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(`<html><body style="font-family:sans-serif;text-align:center;padding-top:60px">
          <h2>${err ? "Gagal: " + err : "Berhasil terhubung."}</h2>
          <p>Tutup tab ini dan kembali ke terminal.</p></body></html>`);
        server.close();
        if (err) reject(new Error(err)); else resolve(code);
      } catch (e) { reject(e); }
    });
    server.listen(REDIRECT_PORT, "127.0.0.1", () => {
      console.log(color("dim", "Membuka browser untuk otorisasi..."));
      open(url).catch(() => console.log("Buka URL ini manual:\n" + url));
    });
    server.on("error", reject);
  });
}

async function cmdAdd() {
  requireCredentials();
  const oauth2 = makeOAuthClient(REDIRECT_URI);
  const code = await waitForCode(authUrl(oauth2));
  const email = await exchangeAndSave(oauth2, code);
  const accounts = loadAccounts();
  console.log(color("green", `✓ Akun ditambahkan: ${email}`));
  console.log(color("dim", `Total akun: ${Object.keys(accounts).length}`));
}

async function cmdAccounts() {
  const accounts = loadAccounts();
  const emails = Object.keys(accounts);
  if (!emails.length) { console.log(color("yellow", "Belum ada akun. Jalankan: drive-router add")); return; }
  console.log(color("bold", `\n${emails.length} akun terhubung:\n`));
  for (const email of emails) {
    try {
      const q = await accountQuota(accounts[email], REDIRECT_URI);
      const limit = q.limit ? fmtBytes(q.limit) : "unlimited";
      console.log(`  ${color("cyan", email.padEnd(34))} ${fmtBytes(q.usage)} / ${limit}`);
    } catch {
      console.log(`  ${color("cyan", email.padEnd(34))} ${color("red", "token error — jalankan: drive-router add")}`);
    }
  }
  console.log("");
}

function printTable(files) {
  if (!files.length) { console.log(color("yellow", "Tidak ada file.")); return; }
  console.log("");
  for (const f of files) {
    const icon = isFolder(f) ? color("blue", "📁") : "📄";
    const size = isFolder(f) ? color("dim", "  dir") : fmtBytes(f.size).padStart(7);
    const acct = color("dim", `[${f._account.split("@")[0]}]`);
    const date = color("dim", (f.modifiedTime || "").slice(0, 10));
    console.log(`  ${icon} ${size}  ${date}  ${acct}  ${f.name}`);
  }
  console.log(color("dim", `\n  ${files.length} item dari semua akun.\n`));
}

async function cmdLs(args) {
  const folderId = args.find((a) => !a.startsWith("-"));
  const { files, errors } = await gatherAll({ folderId, pageSize: 100 }, REDIRECT_URI);
  errors.forEach((e) => console.error(color("red", `  ! ${e.email}: ${e.error}`)));
  printTable(files);
}

async function cmdSearch(args) {
  const query = args.filter((a) => !a.startsWith("-")).join(" ");
  if (!query) { console.log(color("yellow", "Pakai: drive-router search <kata kunci>")); return; }
  console.log(color("dim", `Mencari "${query}" di semua akun...`));
  const { files, errors } = await gatherAll({ query, pageSize: 50 }, REDIRECT_URI);
  errors.forEach((e) => console.error(color("red", `  ! ${e.email}: ${e.error}`)));
  printTable(files);
}

async function cmdQuota() {
  const accounts = loadAccounts();
  const emails = Object.keys(accounts);
  if (!emails.length) { console.log(color("yellow", "Belum ada akun. Jalankan: drive-router add")); return; }
  let totalUsed = 0, totalLimit = 0, unlimited = false;
  console.log(color("bold", "\nPenyimpanan gabungan:\n"));
  for (const email of emails) {
    try {
      const q = await accountQuota(accounts[email], REDIRECT_URI);
      totalUsed += Number(q.usage || 0);
      if (q.limit) totalLimit += Number(q.limit); else unlimited = true;
      console.log(`  ${color("cyan", email.padEnd(34))} ${fmtBytes(q.usage)} / ${q.limit ? fmtBytes(q.limit) : "∞"}`);
    } catch {
      console.log(`  ${color("cyan", email.padEnd(34))} ${color("red", "error")}`);
    }
  }
  console.log(color("dim", "  " + "─".repeat(48)));
  console.log(`  ${color("bold", "TOTAL".padEnd(34))} ${color("green", fmtBytes(totalUsed))} / ${unlimited ? "∞" : fmtBytes(totalLimit)}\n`);
}

function parseFlags(args) {
  const flags = {}, pos = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith("--")) { flags[key] = next; i++; } else flags[key] = true;
    } else pos.push(a);
  }
  return { flags, pos };
}

async function cmdUpload(args) {
  requireCredentials();
  const { flags, pos } = parseFlags(args);
  const localPath = pos[0];
  if (!localPath) { console.log(color("yellow", "Pakai: drive-router upload <file> [--to email]")); return; }
  if (!fs.existsSync(localPath)) { console.log(color("red", "File tidak ada: " + localPath)); return; }
  const size = fs.statSync(localPath).size;
  const target = flags.to || await pickBestAccount(REDIRECT_URI, size);
  if (!target) { console.log(color("yellow", "Belum ada akun. Jalankan: drive-router add")); return; }
  console.log(color("dim", `Upload ${path.basename(localPath)} (${fmtBytes(size)}) -> ${target}...`));
  const res = await uploadFile(target, { localPath, name: path.basename(localPath) }, REDIRECT_URI);
  console.log(color("green", `✓ Terupload ke ${target}`));
  if (res.webViewLink) console.log(color("dim", "  " + res.webViewLink));
}

async function cmdTransfer(args) {
  requireCredentials();
  const { flags, pos } = parseFlags(args);
  const fileId = pos[0];
  if (!fileId || !flags.from || !flags.to) {
    console.log(color("yellow", "Pakai: drive-router transfer <fileId> --from <email> --to <email> [--move]"));
    return;
  }
  console.log(color("dim", `${flags.move ? "Pindah" : "Salin"} ${fileId}: ${flags.from} -> ${flags.to}...`));
  const res = await transferFile({ fileId, from: flags.from, to: flags.to, move: Boolean(flags.move) }, REDIRECT_URI);
  console.log(color("green", `✓ ${res.moved ? "Dipindah" : "Disalin"} ke ${flags.to}${res.exported ? " (di-export dari Google Docs)" : ""}`));
  if (res.webViewLink) console.log(color("dim", "  " + res.webViewLink));
}

async function cmdPush(args) {
  requireCredentials();
  const { pos } = parseFlags(args);
  const folder = pos[0];
  if (!folder || !fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) {
    console.log(color("yellow", "Pakai: drive-router push <folder>")); return;
  }
  const entries = fs.readdirSync(folder)
    .map((n) => path.join(folder, n))
    .filter((p) => fs.statSync(p).isFile())
    .map((p) => ({ p, size: fs.statSync(p).size }))
    .sort((a, b) => b.size - a.size);
  if (!entries.length) { console.log(color("yellow", "Folder kosong.")); return; }
  console.log(color("bold", `\nMenyebar ${entries.length} file ke akun paling lega...\n`));
  let ok = 0;
  for (const { p, size } of entries) {
    const target = await pickBestAccount(REDIRECT_URI, size);
    if (!target) { console.log(color("red", `  ! ${path.basename(p)}: tak ada akun muat`)); continue; }
    try {
      await uploadFile(target, { localPath: p, name: path.basename(p) }, REDIRECT_URI);
      console.log(`  ${color("green", "✓")} ${path.basename(p).padEnd(36)} ${fmtBytes(size).padStart(8)}  -> ${target}`);
      ok++;
    } catch (e) {
      console.log(`  ${color("red", "✗")} ${path.basename(p)}: ${e.message}`);
    }
  }
  console.log(color("dim", `\n  ${ok}/${entries.length} file terupload.\n`));
}

function cmdHelp() {
  console.log(`
${color("bold", "drive-router")} — gabungkan banyak Google Drive (per email) jadi satu.

${color("bold", "Perintah:")}
  ${color("cyan", "add")}                 Tambah akun Google Drive baru (buka browser, login)
  ${color("cyan", "accounts")}            Daftar akun yang terhubung + kuota
  ${color("cyan", "ls")} [folderId]       Lihat semua file dari semua akun (terbaru dulu)
  ${color("cyan", "search")} <kata>       Cari file lintas semua akun
  ${color("cyan", "quota")}               Total penyimpanan gabungan
  ${color("cyan", "web")}                 Jalankan web console (buka http://localhost:3020)
  ${color("cyan", "upload")} <file> [--to email]   Upload file (default: akun paling lega)
  ${color("cyan", "transfer")} <id> --from <e> --to <e> [--move]   Pindah/salin antar akun
  ${color("cyan", "push")} <folder>          Sebar semua file di folder ke akun-akun (by ruang)
  ${color("cyan", "help")}                Tampilkan bantuan ini

${color("dim", "Web console: node server.js  (atau npm run web)")}
${color("dim", "Token disimpan di ~/.drive-router/accounts.json")}
`);
}

async function main() {
  const [, , cmd, ...args] = process.argv;
  try {
    switch (cmd) {
      case "add": await cmdAdd(); break;
      case "accounts": case "list-accounts": await cmdAccounts(); break;
      case "ls": case "list": await cmdLs(args); break;
      case "search": case "find": await cmdSearch(args); break;
      case "quota": case "storage": await cmdQuota(); break;
      case "upload": case "up": await cmdUpload(args); break;
      case "transfer": case "mv": case "move": await cmdTransfer(args); break;
      case "push": case "distribute": await cmdPush(args); break;
      case "web": case "serve":
        await import("./server.js");
        break;
      case undefined: case "help": case "-h": case "--help": cmdHelp(); break;
      default:
        console.log(color("red", `Perintah tidak dikenal: ${cmd}`));
        cmdHelp();
    }
  } catch (e) {
    console.error(color("red", "Error: " + (e?.message || e)));
    process.exit(1);
  }
}

main();
