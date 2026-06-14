# Deploy drive-router ke VPS

Panduan menjalankan web console di server online (VPS) dengan domain + HTTPS, biar bisa diakses dari mana saja. Estimasi 20-30 menit.

Yang kamu butuhkan:
- VPS (DigitalOcean, Contabo, Vultr, Hetzner, dll) — Ubuntu 22.04/24.04
- Domain / subdomain yang diarahkan ke IP VPS (mis. `drive.domainmu.com`)
- Akun Google Cloud (buat OAuth)

---

## 1. Arahkan domain ke VPS

Di pengaturan DNS domainmu, bikin **A record**:

```
drive.domainmu.com   ->   <IP_VPS_kamu>
```

Tunggu beberapa menit sampai DNS-nya nyebar (cek dengan `ping drive.domainmu.com`).

---

## 2. Bikin OAuth client tipe "Web application"

Beda dari versi lokal — hosting WAJIB pakai tipe Web application.

1. Buka <https://console.cloud.google.com/apis/credentials>
2. **Enable** "Google Drive API" (kalau belum)
3. **OAuth consent screen** → External → daftarkan email-emailmu sebagai **Test user**
4. **Create Credentials → OAuth client ID → Application type: Web application**
5. Di **Authorized redirect URIs**, tambahkan:
   ```
   https://drive.domainmu.com/oauth2callback
   ```
6. Salin **Client ID** & **Client Secret**

---

## 3. Setup di VPS

SSH ke VPS, lalu:

```bash
# Install Node.js 20 (lewat NodeSource)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs git

# Clone repo
git clone https://github.com/rahmanlalu012/drive-router.git
cd drive-router
npm install

# Konfigurasi
cp .env.example .env
nano .env
```

Isi `.env`:

```
GOOGLE_CLIENT_ID=xxxx.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=xxxx
DRIVE_ROUTER_PASSWORD=ganti-password-kuat-disini
PORT=3020
BASE_URL=https://drive.domainmu.com
```

> ⚠️ **WAJIB ganti `DRIVE_ROUTER_PASSWORD`** jadi password kuat. Server ini online, jangan pakai default `12345678`.

---

## 4. Jalankan terus pakai pm2

Biar server hidup terus walau SSH ditutup, dan auto-restart kalau crash atau VPS reboot:

```bash
sudo npm install -g pm2
pm2 start server.js --name drive-router
pm2 save
pm2 startup        # ikuti perintah yang muncul (copy-paste baris sudo-nya)
```

Cek jalan: `pm2 logs drive-router` — harusnya muncul "berjalan di http://localhost:3020".

---

## 5. Nginx reverse proxy + HTTPS

Server jalan di port 3020 (HTTP). Kita pasang Nginx di depannya untuk domain + SSL.

```bash
sudo apt-get install -y nginx
sudo nano /etc/nginx/sites-available/drive-router
```

Isi:

```nginx
server {
    server_name drive.domainmu.com;

    client_max_body_size 0;   # izinkan upload file besar

    location / {
        proxy_pass http://127.0.0.1:3020;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_request_buffering off;   # streaming upload
        proxy_read_timeout 600s;
    }
}
```

Aktifkan + pasang SSL gratis (Let's Encrypt):

```bash
sudo ln -s /etc/nginx/sites-available/drive-router /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

# SSL otomatis
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d drive.domainmu.com
```

Certbot otomatis ngedit config jadi HTTPS dan perpanjang sertifikat sendiri.

---

## 6. Firewall (opsional tapi disarankan)

```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw enable
```

Port 3020 nggak perlu dibuka ke publik — cuma Nginx (80/443) yang diakses dari luar.

---

## 7. Selesai

Buka **https://drive.domainmu.com** → masukkan password → klik **+ Tambah Akun** untuk login tiap Google Drive.

### Update kalau ada versi baru

```bash
cd drive-router
git pull
npm install
pm2 restart drive-router
```

---

## Catatan keamanan

- Token Drive semua akun disimpan di VPS (`~/.drive-router/accounts.json`). Pastikan cuma kamu yang punya akses SSH.
- Jangan share URL + password ke orang lain — siapa pun yang masuk bisa lihat & ubah semua Drive-mu.
- `.env` tidak ikut ke GitHub (sudah di-gitignore).
- Pertimbangkan ganti port SSH default & pakai SSH key (bukan password) untuk hardening VPS.

## Troubleshooting

| Masalah | Solusi |
|---------|--------|
| `redirect_uri_mismatch` saat login Google | Pastikan redirect URI di Google Console **persis** `https://drive.domainmu.com/oauth2callback` (https, tanpa slash di akhir) dan `BASE_URL` di `.env` cocok |
| Upload file besar gagal | Pastikan `client_max_body_size 0;` ada di Nginx |
| 502 Bad Gateway | Cek `pm2 logs drive-router` — server mungkin crash atau `.env` salah |
| Akun lama "token error" | Scope berubah dari versi sebelumnya; tambah ulang akun lewat tombol + Tambah Akun |
