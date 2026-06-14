# drive-router

CLI **dan** web console yang menggabungkan banyak akun Google Drive (per email) jadi **satu drive virtual**. Lihat & cari semua file dari semua akun dalam satu daftar, **upload** otomatis ke akun yang paling lega, **pindahkan** file antar akun, dan **sebar** isi folder ke beberapa Drive sekaligus.

```
📄   1.2MB  2026-06-14  [budi]      laporan-q2.pdf
📁    dir   2026-06-10  [kerja]     Proyek Alpha
📄  340KB   2026-06-09  [pribadi]   foto-liburan.jpg
```

## Kenapa butuh setup OAuth sendiri?

Google nggak kasih satu token buat banyak akun sekaligus. Tiap email harus login sekali. Tool ini pakai **OAuth Desktop App** punyamu sendiri (gratis), nyimpan token tiap akun di `~/.drive-router/accounts.json`. Setelah login sekali, akun langsung kepakai terus.

## 1. Bikin OAuth credentials (sekali saja)

1. Buka <https://console.cloud.google.com/apis/credentials>
2. Buat project baru (atau pakai yang ada)
3. **Enable** "Google Drive API" di library
4. **OAuth consent screen** → pilih External → isi nama app → tambahkan emailmu sebagai **Test user** (semua email yang mau kamu gabung harus didaftar sebagai test user)
5. **Create Credentials → OAuth client ID → Application type: Desktop app**
6. Salin **Client ID** dan **Client Secret**

## 2. Konfigurasi

```bash
cd drive-router
cp .env.example .env      # lalu isi GOOGLE_CLIENT_ID & GOOGLE_CLIENT_SECRET
npm install
```

## 3. Pakai

```bash
# Tambah akun (buka browser, login Google). Ulangi untuk tiap email.
node index.js add
node index.js add          # akun kedua
node index.js add          # akun ketiga, dst

# Lihat akun terhubung + kuota
node index.js accounts

# Lihat SEMUA file dari SEMUA akun (terbaru dulu)
node index.js ls

# Lihat isi satu folder (pakai folderId dari kolom)
node index.js ls 1AbCdEfGhIjK

# Cari file lintas semua akun
node index.js search "laporan"

# Total penyimpanan gabungan
node index.js quota
```

Biar lebih singkat, bisa pasang global:

```bash
npm install -g .
drive-router add
drive-router ls
```

## 4. Web Console (UI di browser)

Kalau nggak mau ketik perintah, jalankan web console:

```bash
node server.js          # atau: npm run web
```

Lalu buka <http://localhost:3020>. Pertama kali kamu diminta **password** (default `12345678`, ganti lewat `DRIVE_ROUTER_PASSWORD` di `.env`). Setelah login, di dalamnya ada:

- Tombol **+ Tambah Akun** — login Google langsung dari halaman
- Kartu tiap akun + bar kuota penyimpanan
- Tabel semua file dari semua Drive, klik nama file untuk buka di Google Drive
- Kotak **search** yang mencari lintas semua akun secara realtime
- **⬆ Upload** (atau drag-and-drop) — file masuk ke akun paling lega otomatis
- Tiap file: **Pindah ke…** akun lain, **⬇** download, **🗑** hapus
- Tombol **Keluar** untuk logout

> **Penting:** web console pakai redirect `http://localhost:3020/oauth2callback`. Untuk OAuth client tipe **Desktop app**, redirect `localhost` sudah otomatis diizinkan Google, jadi nggak perlu setting tambahan. Kalau kamu ganti port (`PORT=4000 node server.js`), sesuaikan saja.

CLI dan web console berbagi data yang sama (`~/.drive-router/accounts.json`) — akun yang kamu tambah lewat CLI langsung muncul di web, dan sebaliknya.

### Hosting online (VPS)

Mau diakses dari mana saja, bukan cuma localhost? Lihat panduan lengkap di **[DEPLOY-VPS.md](DEPLOY-VPS.md)** — setup domain + HTTPS, OAuth tipe Web application, pm2, dan Nginx. Singkatnya: set `BASE_URL=https://domainmu.com` di `.env`, dan daftarkan redirect `https://domainmu.com/oauth2callback` di Google Console.

## Perintah

| Perintah | Fungsi |
|----------|--------|
| `add` | Tambah akun Google Drive baru (login via browser) |
| `accounts` | Daftar akun + kuota masing-masing |
| `ls [folderId]` | Gabungan semua file dari semua akun |
| `search <kata>` | Cari file di semua akun sekaligus |
| `quota` | Total penyimpanan gabungan |
| `upload <file> [--to email]` | Upload file; default ke akun paling lega |
| `transfer <id> --from <e> --to <e> [--move]` | Salin/pindah file antar akun |
| `push <folder>` | Sebar semua file di folder ke akun-akun (by ruang) |
| `web` | Jalankan web console di http://localhost:3020 |
| `help` | Bantuan |

## Catatan

- **Read-write.** Scope `drive` (penuh) — bisa baca, upload, pindah, hapus. Hati-hati: `transfer --move` dan tombol 🗑 menghapus file asli.
- **Upgrade dari versi read-only?** Scope berubah jadi penuh, jadi tiap akun harus di-`add` ulang sekali supaya dapat izin tulis. Akun lama tetap kelihatan tapi upload/pindah/hapus akan gagal sampai di-add ulang.
- Token disimpan lokal di `~/.drive-router/accounts.json` (permission 600). Jangan dibagikan.
- Kolom `[nama]` di daftar = bagian depan email akun, biar tahu file dari Drive mana.
- Refresh token otomatis; nggak perlu login ulang tiap kali.
- Kalau ada akun yang error token, jalankan `node index.js add` lagi untuk akun itu.

## Pengembangan lanjutan (kalau mau)

- Filter per tipe file (`--type pdf`)
- Export daftar ke CSV
- Mode interaktif (TUI) buat navigasi folder
- Sinkronisasi folder lokal otomatis (watch)
