import "dotenv/config";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { google } from "googleapis";

export const CONFIG_DIR = path.join(os.homedir(), ".drive-router");
export const CONFIG_FILE = path.join(CONFIG_DIR, "accounts.json");
export const TMP_DIR = path.join(CONFIG_DIR, "tmp");

// Full drive scope: baca + tulis (upload, transfer, hapus).
export const SCOPES = [
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/userinfo.email",
];

export const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
export const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;

// Native Google file types perlu di-export saat transfer antar akun.
const GOOGLE_EXPORT = {
  "application/vnd.google-apps.document": { mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ext: ".docx" },
  "application/vnd.google-apps.spreadsheet": { mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ext: ".xlsx" },
  "application/vnd.google-apps.presentation": { mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation", ext: ".pptx" },
  "application/vnd.google-apps.drawing": { mime: "image/png", ext: ".png" },
};

export function ensureConfigDir() {
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true, mode: 0o700 });
}

export function loadAccounts() {
  ensureConfigDir();
  if (!fs.existsSync(CONFIG_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")); } catch { return {}; }
}

export function saveAccounts(accounts) {
  ensureConfigDir();
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(accounts, null, 2), { mode: 0o600 });
}

export function hasCredentials() { return Boolean(CLIENT_ID && CLIENT_SECRET); }

export function makeOAuthClient(redirectUri) {
  return new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, redirectUri);
}

export function clientForAccount(account, redirectUri) {
  const oauth2 = makeOAuthClient(redirectUri);
  oauth2.setCredentials(account.tokens);
  return oauth2;
}

export function driveFor(account, redirectUri) {
  return google.drive({ version: "v3", auth: clientForAccount(account, redirectUri) });
}

export function authUrl(oauth2) {
  return oauth2.generateAuthUrl({ access_type: "offline", prompt: "consent", scope: SCOPES });
}

export async function exchangeAndSave(oauth2, code) {
  const { tokens } = await oauth2.getToken(code);
  oauth2.setCredentials(tokens);
  const oauth2api = google.oauth2({ version: "v2", auth: oauth2 });
  const { data: me } = await oauth2api.userinfo.get();
  const email = me.email;
  const accounts = loadAccounts();
  const existing = accounts[email];
  accounts[email] = {
    email,
    tokens: { ...(existing?.tokens || {}), ...tokens },
    scope: tokens.scope || existing?.scope,
    addedAt: existing?.addedAt || new Date().toISOString(),
  };
  saveAccounts(accounts);
  return email;
}

export function hasWriteScope(account) {
  return (account?.scope || "").includes("auth/drive") && !(account?.scope || "").includes("drive.metadata.readonly");
}

export async function accountQuota(account, redirectUri) {
  const drive = driveFor(account, redirectUri);
  const { data } = await drive.about.get({ fields: "storageQuota,user" });
  return data.storageQuota || {};
}

export async function freeBytes(account, redirectUri) {
  const q = await accountQuota(account, redirectUri);
  if (!q.limit) return Infinity; // unlimited
  return Number(q.limit) - Number(q.usage || 0);
}

// Pilih akun dengan ruang kosong terbanyak (cukup untuk needBytes).
export async function pickBestAccount(redirectUri, needBytes = 0) {
  const accounts = loadAccounts();
  const emails = Object.keys(accounts);
  const scored = [];
  for (const email of emails) {
    try {
      const free = await freeBytes(accounts[email], redirectUri);
      scored.push({ email, free });
    } catch { /* skip */ }
  }
  scored.sort((a, b) => b.free - a.free);
  const fit = scored.find((s) => s.free >= needBytes);
  return (fit || scored[0])?.email || null;
}

export async function listFromAccount(account, { folderId, pageSize = 100, query } = {}, redirectUri) {
  const drive = driveFor(account, redirectUri);
  const qParts = ["trashed = false"];
  if (folderId) qParts.push(`'${folderId}' in parents`);
  if (query) qParts.push(`name contains '${query.replace(/'/g, "\\'")}'`);
  const { data } = await drive.files.list({
    q: qParts.join(" and "),
    pageSize,
    orderBy: "modifiedTime desc",
    fields: "files(id,name,mimeType,size,modifiedTime,webViewLink)",
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  return (data.files || []).map((f) => ({ ...f, _account: account.email }));
}

export async function gatherAll(opts = {}, redirectUri) {
  const accounts = loadAccounts();
  const emails = Object.keys(accounts);
  const results = await Promise.allSettled(emails.map((e) => listFromAccount(accounts[e], opts, redirectUri)));
  const files = [], errors = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") files.push(...r.value);
    else errors.push({ email: emails[i], error: r.reason?.message || String(r.reason) });
  });
  files.sort((a, b) => new Date(b.modifiedTime) - new Date(a.modifiedTime));
  return { files, errors };
}

// ---- Operasi tulis ----

export async function uploadFile(email, { localPath, name, mimeType, parentId }, redirectUri) {
  const accounts = loadAccounts();
  const account = accounts[email];
  if (!account) throw new Error(`Akun tidak ditemukan: ${email}`);
  const drive = driveFor(account, redirectUri);
  const res = await drive.files.create({
    requestBody: { name: name || path.basename(localPath), parents: parentId ? [parentId] : undefined },
    media: { mimeType: mimeType || undefined, body: fs.createReadStream(localPath) },
    fields: "id,name,size,webViewLink",
    supportsAllDrives: true,
  });
  return { ...res.data, account: email };
}

export async function downloadFile(email, fileId, destPath, redirectUri) {
  const accounts = loadAccounts();
  const account = accounts[email];
  if (!account) throw new Error(`Akun tidak ditemukan: ${email}`);
  const drive = driveFor(account, redirectUri);
  const meta = (await drive.files.get({ fileId, fields: "name,mimeType", supportsAllDrives: true })).data;

  const exportSpec = GOOGLE_EXPORT[meta.mimeType];
  ensureConfigDir();
  const out = fs.createWriteStream(destPath);
  if (exportSpec) {
    const res = await drive.files.export({ fileId, mimeType: exportSpec.mime }, { responseType: "stream" });
    await new Promise((resolve, reject) => res.data.on("end", resolve).on("error", reject).pipe(out));
    return { name: meta.name + exportSpec.ext, mimeType: exportSpec.mime, exported: true };
  }
  const res = await drive.files.get({ fileId, alt: "media", supportsAllDrives: true }, { responseType: "stream" });
  await new Promise((resolve, reject) => res.data.on("end", resolve).on("error", reject).pipe(out));
  return { name: meta.name, mimeType: meta.mimeType, exported: false };
}

export async function deleteFile(email, fileId, redirectUri) {
  const accounts = loadAccounts();
  const account = accounts[email];
  if (!account) throw new Error(`Akun tidak ditemukan: ${email}`);
  const drive = driveFor(account, redirectUri);
  await drive.files.delete({ fileId, supportsAllDrives: true });
  return true;
}

// Pindah/salin file dari satu akun ke akun lain (download lalu upload).
export async function transferFile({ fileId, from, to, move = false }, redirectUri) {
  ensureConfigDir();
  const tmp = path.join(TMP_DIR, `dr_${Date.now()}_${Math.random().toString(36).slice(2)}`);
  const info = await downloadFile(from, fileId, tmp, redirectUri);
  try {
    const uploaded = await uploadFile(to, { localPath: tmp, name: info.name, mimeType: info.mimeType }, redirectUri);
    if (move) await deleteFile(from, fileId, redirectUri);
    return { ...uploaded, exported: info.exported, moved: move };
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

export function fmtBytes(n) {
  if (n == null || n === Infinity) return n === Infinity ? "∞" : "—";
  n = Number(n);
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? 1 : 0)}${u[i]}`;
}

export function isFolder(f) { return f.mimeType === "application/vnd.google-apps.folder"; }
