# Panduan Deploy & QA Live — DonasiAlumniApp (Google Sheets V2 + Apps Script + Netlify + Midtrans Sandbox)

Panduan ini mencakup pemasangan backend Google Apps Script terbaru (`P0–P7`), pengaturan `ScriptProperties`, migrasi V1 → V2 non-destruktif, deploy Web App GAS & Netlify, serta checklist QA Live.

---

## 1. Pilihan Inisialisasi Database (Baru vs Sudah Berisi Data)

- **Database Baru (Masih Kosong):** Jalankan `setupSheets()` satu kali untuk membuat struktur dasar, lalu jalankan `migrateDatabaseNonDestructive({ dryRun: false, autoBackup: false })` atau alur staging guard agar lengkap menjadi **10 tab V2** (`programs`, 21 kolom `donation_intents`, 35 kolom `transactions`).
- **Database Lama V1 yang Sudah Berisi Data (Staging / Production):**
  - **DILARANG keras menjalankan `setupSheets()`** pada database yang sudah berisi data.
  - Gunakan alur aman: `verifyStagingPropsPresence()` → `runStagingP2DryRun()` → `runStagingP2Migration()` → `inspectStagingPostMigrationDetails()`.

---

## 2. Pasang Seluruh Kode Backend Google Apps Script (15 File `.gs` + Manifest)

Buka Google Spreadsheet target → **Extensions > Apps Script**, lalu salin seluruh berkas dari folder lokal `apps-script/`:

| File di Apps Script | Fungsi Utama |
| :--- | :--- |
| `appsscript.json` | Manifest Web App V8 (`Asia/Jakarta`, `ANYONE_ANONYMOUS`) |
| `Setup.gs` | Skema V1/V2 10 sheet, backup/restore, staging guard, & validator pascamigrasi |
| `Logic.gs` | Pure logic VA, parser 5 bank, matcher 3-Tier, masking `OPEN-02`, mapper Midtrans |
| `Auth.gs` | Verifikasi Google ID Token, RBAC `ADMIN_EMAILS`, HMAC webhook, token Guest 256-bit |
| `AuditLog.gs` | Audit log append-only dengan redaksi rahasia & paginasi |
| `Notifier.gs` | Pengirim email donatur/admin/revisi dengan status `{ sent, error }` |
| `Programs.gs` | CRUD master program donasi & guard penghapusan |
| `Payments.gs` | Client Midtrans Snap REST API (`/snap/v1/transactions`, `/v2/{order_id}/status`), SHA-512, alokator `KWT-` |
| `Receipts.gs` | API `get_receipt` anti-IDOR, blokir `UNMATCHED` & `REFUNDED`, notice Sandbox |
| `Users.gs` | Registrasi Alumni, upload bukti ke Drive privat, preview & review admin |
| `Donations.gs` | Checkout Alumni `APPROVED` & Guest non-akun, idempotency proof, polling Active Inquiry |
| `Webhook.gs` | Webhook Bank Manual HMAC & Webhook Midtrans SHA-512 (Self-Healing Write-Ahead) |
| `Admin.gs` | Manajemen antrean, `admin_transactions`, `admin_check_midtrans`, `retry_tx_email`, & insights |
| `PublicApi.gs` | Endpoint `public_summary` agregat murni ter-cache 60 detik |
| `Tests.gs` | Unit self-test internal runtime Apps Script (`runSelfTests`) |
| `Code.gs` | HTTP Router `doGet` (hanya publik) & `doPost` (`text/plain` JSON + webhook) |

Tekan **`Ctrl + S`** setelah menyalin semua file.

---

## 3. Atur `ScriptProperties` (Wajib Fail-Closed)

Di editor Apps Script, buka **⚙️ Project Settings > Script Properties** dan isi properti berikut (rahasia **tidak pernah** disimpan di sel sheet `config`):

| Key | Wajib | Keterangan Nilai |
| :--- | :--- | :--- |
| `GOOGLE_CLIENT_ID` | Ya | OAuth Web Client ID dari Google Cloud Console (`...apps.googleusercontent.com`) |
| `ADMIN_EMAILS` | Ya | Daftar email admin dipisah koma (mis. `maulanaa1408@upi.edu`) |
| `WEBHOOK_MANUAL_SECRET` | Ya | Secret acak panjang (>= 32 karakter) untuk HMAC webhook simulator manual |
| `TOKEN_PEPPER` | Ya | Pepper acak panjang (>= 32 karakter) untuk hashing `access_token` Guest |
| `ALLOW_MOCK_AUTH` | Ya | Isi **`false`** di environment live / staging |
| `EXPECTED_STAGING_SPREADSHEET_ID` | Staging | Wajib sama persis dengan Spreadsheet ID salinan `STAGING_...` saat migrasi |
| `MIDTRANS_SERVER_KEY` | Saat aktifkan Midtrans | Server Key Sandbox (`SB-Mid-server-...`) dari Midtrans Dashboard (`OPEN-05`) |
| `MIDTRANS_IS_PRODUCTION` | Opsional | **`false`** untuk Sandbox *(default)* |

---

## 4. Deploy Apps Script sebagai Web App

1. Klik **Deploy > New deployment** (atau **Manage deployments > Edit > New version** pada deployment yang sudah ada agar URL `/exec` tetap sama).
2. Pilih type **Web app**:
   - **Execute as:** `Me`
   - **Who has access:** `Anyone`
3. Klik **Deploy** dan salin URL Web App berakhiran `/exec`.
4. Jalankan fungsi `runSelfTests` satu kali di editor untuk memastikan self-test runtime Google V8 lulus.

---

## 5. Konfigurasi Frontend (`frontend/js/config.js`) & Google Cloud Console

1. Di Google Cloud Console (**APIs & Services > Credentials > OAuth Client ID Web Application**):
   - Tambahkan origin domain live Netlify dan origin dev lokal di **Authorized JavaScript origins** (tanpa trailing slash `/`), misalnya:
     - `https://<domain-netlify-anda>.netlify.app`
     - `http://localhost:8000`
2. Perbarui `frontend/js/config.js`:

```javascript
const CONFIG = {
  API_URL: window.localStorage.getItem("DONASI_API_URL") || "https://script.google.com/macros/s/<DEPLOYMENT_ID>/exec",
  GOOGLE_CLIENT_ID: window.localStorage.getItem("DONASI_GOOGLE_CLIENT_ID") || "<CLIENT_ID>.apps.googleusercontent.com",
  MIDTRANS_CLIENT_KEY: window.localStorage.getItem("DONASI_MIDTRANS_CLIENT_KEY") || "",
  MIDTRANS_SNAP_URL: "https://app.sandbox.midtrans.com/snap/snap.js",
  ENVIRONMENT: "staging",
  DEMO_MODE: false,
};
```

*(Selama `MIDTRANS_CLIENT_KEY` & `MIDTRANS_SERVER_KEY` Sandbox belum diisi, jalur Transfer Bank Manual 3-Tier berjalan penuh sedangkan kanal `MIDTRANS_SNAP` berada pada mode prepared aman).*

3. Deploy folder `frontend/` ke Netlify:
   ```powershell
   netlify deploy --prod --dir=frontend
   ```

---

## 6. Checklist QA Live (Staging / Netlify → GAS `/exec`)

1. **Verifikasi CORS & Transport (`TEST-20`):** Buka tab **Network** DevTools → muat beranda, lakukan checkout Guest, dan login Admin. Pastikan tidak ada request `OPTIONS` yang gagal, semua request `POST` memakai `Content-Type: text/plain;charset=utf-8`, dan tidak ada token di URL query string.
2. **Alur Alumni & Drive Privat (`TEST-07`, `TEST-17`):** Daftar dengan akun Google non-admin → unggah ijazah → buka Portal Admin tab *Verifikasi Alumni* → klik *Lihat Bukti* (pastikan gambar/PDF tampil lewat `admin_verif_proof`) → *Setujui* → pastikan kode `A000001` terbit & dokumen Drive terhapus otomatis.
3. **Alur Guest Tanpa Akun & Kuitansi (`TEST-05`, `TEST-04`):** Di `index.html`, kirim donasi Guest jalur `MANUAL_TRANSFER` → pastikan sheet `users` tidak bertambah → jalankan simulator webhook HMAC ke URL `/exec`:
   ```powershell
   python simulator/send_webhook.py --url "<WEB_APP_EXEC_URL>" --ref G000001 --bank BCA --amount 150000
   ```
   Lalu buka tautan `receipt.html#ref=G000001&token=<ACCESS_TOKEN>` dan uji **Cetak / Simpan PDF**.
4. **Midtrans Sandbox Live (`TEST-06`, `TEST-08`..`TEST-13` — setelah `OPEN-05` diisi):**
   - Atur Payment Notification URL di Midtrans Sandbox Dashboard ke `<WEB_APP_EXEC_URL>`.
   - Lakukan checkout `MIDTRANS_SNAP`, bayar di *Midtrans Sandbox Payment Simulator*, dan verifikasi Active Status Inquiry / Webhook mencatat `MATCHED`, `gateway_fee = 0` (`Mode Sandbox`), serta menerbitkan kuitansi `KWT-...`.
