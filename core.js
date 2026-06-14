import "dotenv/config";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { google } from "googleapis";

export const CONFIG_DIR = path.join(os.homedir(), ".drive-router");
export const CONFIG_FILE = path.join(CONFIG_DIR, "accounts.json");
export const SCOPES = [
  "https://www.googleapis.com/auth/drive.metadata.readonly",
  "https://www.googleapis.com/auth/userinfo.email",
];

export const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
export const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;

export function ensureConfigDir() {
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
}

export function loadAccounts() {
  ensureConfigDir();
  if (!fs.existsSync(CONFIG_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  } catch {
    return {};
  }
}

export function saveAccounts(accounts) {
  ensureConfigDir();
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(accounts, null, 2), { mode: 0o600 });
}

export function hasCredentials() {
  return Boolean(CLIENT_ID && CLIENT_SECRET);
}

export function makeOAuthClient(redirectUri) {
  return new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, redirectUri);
}

export function clientForAccount(account, redirectUri) {
  const oauth2 = makeOAuthClient(redirectUri);
  oauth2.setCredentials(account.tokens);
  return oauth2;
}

export function authUrl(oauth2) {
  return oauth2.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: SCOPES,
  });
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
    addedAt: existing?.addedAt || new Date().toISOString(),
  };
  saveAccounts(accounts);
  return email;
}

export async function accountQuota(account, redirectUri) {
  const auth = clientForAccount(account, redirectUri);
  const drive = google.drive({ version: "v3", auth });
  const { data } = await drive.about.get({ fields: "storageQuota,user" });
  return data.storageQuota || {};
}

export async function listFromAccount(account, { folderId, pageSize = 100, query } = {}, redirectUri) {
  const auth = clientForAccount(account, redirectUri);
  const drive = google.drive({ version: "v3", auth });
  const qParts = ["trashed = false"];
  if (folderId) qParts.push(`'${folderId}' in parents`);
  if (query) qParts.push(`name contains '${query.replace(/'/g, "\\'")}'`);
  const { data } = await drive.files.list({
    q: qParts.join(" and "),
    pageSize,
    orderBy: "modifiedTime desc",
    fields: "files(id,name,mimeType,size,modifiedTime,webViewLink,iconLink)",
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  return (data.files || []).map((f) => ({ ...f, _account: account.email }));
}

export async function gatherAll(opts = {}, redirectUri) {
  const accounts = loadAccounts();
  const emails = Object.keys(accounts);
  const results = await Promise.allSettled(
    emails.map((e) => listFromAccount(accounts[e], opts, redirectUri))
  );
  const files = [];
  const errors = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") files.push(...r.value);
    else errors.push({ email: emails[i], error: r.reason?.message || String(r.reason) });
  });
  files.sort((a, b) => new Date(b.modifiedTime) - new Date(a.modifiedTime));
  return { files, errors };
}

export function fmtBytes(n) {
  if (n == null) return "—";
  n = Number(n);
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? 1 : 0)}${u[i]}`;
}

export function isFolder(f) {
  return f.mimeType === "application/vnd.google-apps.folder";
}
