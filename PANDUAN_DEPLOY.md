# 🚀 Panduan Lengkap Deploy DonasiAlumniApp (Google Sheets + Apps Script + Google OAuth + Netlify)

Panduan langkah demi langkah untuk men-deploy sistem secara penuh agar bisa diakses online dengan Google Sign-In aktif.

---

## Ringkasan Alur Deploy

```
[1. Buat Google Sheets] ──> [2. Pasang Apps Script & Run setupSheets] ──> [3. Deploy Web App (Dapat API URL)]
                                                                                  │
[4. Setup Google Cloud Console (OAuth Client ID)] <───────────────────────────────┘
  • Masukkan URI Netlify & localhost
  • Dapatkan Client ID
                                                                                  │
[5. Update config.js Frontend] <──────────────────────────────────────────────────┘
  • API_URL: URL Apps Script
  • GOOGLE_CLIENT_ID: Client ID dari Google Cloud
                                                                                  │
[6. Deploy ke Netlify (Drop Folder / CLI / Git)] ──> [7. Aplikasi Live & Berfungsi Penuh!]
```

---

## Langkah 1: Buat Google Spreadsheet Baru

1. Buka browser dan kunjungi [sheets.new](https://sheets.new).
2. Beri nama spreadsheet di pojok kiri atas, misalnya: `DB_Beasiswa_IKA_UPI`.
3. Biarkan tab pertama kosong (nanti akan dibuat otomatis oleh script).

---

## Langkah 2: Pasang Kode Backend di Google Apps Script

1. Di Google Sheets tersebut, klik menu **Ekstensi (Extensions)** ➔ **Apps Script**.
2. Beri nama proyek Apps Script, misalnya: `Backend_Donasi_Alumni`.
3. Di panel sebelah kiri terdapat daftar file. Ganti isi `Code.gs` dan tambahkan file-file script lainnya. Kamu bisa membuat file baru dengan klik tombol **`+`** (di sebelah Files) ➔ pilih **Script**.
4. Salin kode dari folder lokal `Tugas/DonasiAlumniApp/apps-script/`:

   | Nama File di Apps Script | Sumber File Lokal                                                                                                                           |
   | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
   | `Code.gs`                | [`apps-script/Code.gs`](file:///c:/Maulana/College/CODING/Semester%205/DATA_MANAGEMENT/Tugas/DonasiAlumniApp/apps-script/Code.gs)           |
   | `Setup.gs`               | [`apps-script/Setup.gs`](file:///c:/Maulana/College/CODING/Semester%205/DATA_MANAGEMENT/Tugas/DonasiAlumniApp/apps-script/Setup.gs)         |
   | `Logic.gs`               | [`apps-script/Logic.gs`](file:///c:/Maulana/College/CODING/Semester%205/DATA_MANAGEMENT/Tugas/DonasiAlumniApp/apps-script/Logic.gs)         |
   | `Auth.gs`                | [`apps-script/Auth.gs`](file:///c:/Maulana/College/CODING/Semester%205/DATA_MANAGEMENT/Tugas/DonasiAlumniApp/apps-script/Auth.gs)           |
   | `Users.gs`               | [`apps-script/Users.gs`](file:///c:/Maulana/College/CODING/Semester%205/DATA_MANAGEMENT/Tugas/DonasiAlumniApp/apps-script/Users.gs)         |
   | `Donations.gs`           | [`apps-script/Donations.gs`](file:///c:/Maulana/College/CODING/Semester%205/DATA_MANAGEMENT/Tugas/DonasiAlumniApp/apps-script/Donations.gs) |
   | `Webhook.gs`             | [`apps-script/Webhook.gs`](file:///c:/Maulana/College/CODING/Semester%205/DATA_MANAGEMENT/Tugas/DonasiAlumniApp/apps-script/Webhook.gs)     |
   | `Notifier.gs`            | [`apps-script/Notifier.gs`](file:///c:/Maulana/College/CODING/Semester%205/DATA_MANAGEMENT/Tugas/DonasiAlumniApp/apps-script/Notifier.gs)   |
   | `Admin.gs`               | [`apps-script/Admin.gs`](file:///c:/Maulana/College/CODING/Semester%205/DATA_MANAGEMENT/Tugas/DonasiAlumniApp/apps-script/Admin.gs)         |
   | `PublicApi.gs`           | [`apps-script/PublicApi.gs`](file:///c:/Maulana/College/CODING/Semester%205/DATA_MANAGEMENT/Tugas/DonasiAlumniApp/apps-script/PublicApi.gs) |
   | `AuditLog.gs`            | [`apps-script/AuditLog.gs`](file:///c:/Maulana/College/CODING/Semester%205/DATA_MANAGEMENT/Tugas/DonasiAlumniApp/apps-script/AuditLog.gs)   |
   | `Tests.gs`               | [`apps-script/Tests.gs`](file:///c:/Maulana/College/CODING/Semester%205/DATA_MANAGEMENT/Tugas/DonasiAlumniApp/apps-script/Tests.gs)         |

5. Tekan **Ctrl + S** (Simpan Semua).
6. Di toolbar atas, pilih fungsi **`setupSheets`**, lalu klik tombol **Run (Jalankan)**:
   - Klik **Review permissions** ➔ Pilih akun Google kamu ➔ Klik **Advanced** ➔ Klik **Go to Backend_Donasi_Alumni (unsafe)** ➔ Klik **Allow**.
   - Tunggu sampai muncul log `Setup completed successfully`.
7. Kembali ke tab browser Google Sheets kamu. Sekarang sudah otomatis terbentuk **9 tab sheet**: `users`, `alumni_verifications`, `donation_intents`, `transactions`, `review_queue`, `counters`, `audit_log`, `config`, dan `program_keywords`.

---

## Langkah 3: Deploy Apps Script sebagai Web App

1. Di editor Apps Script, klik tombol biru **Deploy (Terapkan)** di pojok kanan atas ➔ **New deployment (Penerapan baru)**.
2. Klik ikon gear di sebelah _"Select type"_ ➔ pilih **Web app (Aplikasi web)**.
3. Konfigurasikan:
   - **Description:** `v1 Production Live`
   - **Execute as:** **Me (email Anda)**
   - **Who has access:** **Anyone (Siapa saja)** _(Wajib "Anyone" agar frontend di Netlify dan webhook bank bisa memanggil API)_
4. Klik **Deploy**.
5. Salin **Web app URL** yang muncul (berakhiran `/exec`), contohnya:
   ```
   https://script.google.com/macros/s/AKfycbx.../exec
   ```
   _Simpan URL ini untuk Langkah 5._

---

## Langkah 4: Setup Google Cloud Console (Dapatkan Google Client ID)

Untuk mengaktifkan tombol login resmi "Sign in with Google":

1. Buka [Google Cloud Console](https://console.cloud.google.com/).
2. Buat project baru (atau gunakan project yang sudah ada dari tugas SuratKu):
   - Klik dropdown project di atas ➔ **New Project** ➔ Beri nama: `Donasi Alumni UPI` ➔ Klik **Create**.
3. **Konfigurasi OAuth Consent Screen:**
   - Masuk ke menu sidebar ➔ **APIs & Services** ➔ **OAuth consent screen**.
   - Pilih User Type: **External** ➔ Klik **Create**.
   - Isi formulir:
     - **App name:** `Beasiswa IKA UPI`
     - **User support email:** email kamu (`maulanaa1408@upi.edu`)
     - **Developer contact information:** email kamu
   - Klik **Save and Continue** sampai selesai (tidak perlu tambah scope khusus).
   - Di tab **Test users**, tambahkan email kamu dan email uji coba lainnya.
4. **Buat OAuth Client ID:**
   - Masuk ke menu **APIs & Services** ➔ **Credentials**.
   - Klik **+ Create Credentials** di bagian atas ➔ Pilih **OAuth client ID**.
   - **Application type:** Pilih **Web application**.
   - **Name:** `Donasi Alumni Web`
   - Di bagian **Authorized JavaScript origins**, tambahkan:
     - `http://localhost:8000` (untuk tes lokal)
     - `http://localhost:8501`
     - _(Nanti setelah deploy Netlify, tambahkan URL Netlify-mu di sini, misal: `https://donasi-alumni-upi.netlify.app`)_
   - Klik **Create**.
5. Salin string **Client ID** yang berakhiran `.apps.googleusercontent.com`.

---

## Langkah 5: Masukkan Konfigurasi ke Frontend

Buka file [`frontend/js/config.js`](file:///c:/Maulana/College/CODING/Semester%205/DATA_MANAGEMENT/Tugas/DonasiAlumniApp/frontend/js/config.js) di VS Code / editor kamu:

```javascript
const CONFIG = {
  // Masukkan URL Web App hasil Langkah 3
  API_URL:
    window.localStorage.getItem("DONASI_API_URL") ||
    "https://script.google.com/macros/s/AKfycbx.../exec",

  // Masukkan Google Client ID hasil Langkah 4
  GOOGLE_CLIENT_ID:
    window.localStorage.getItem("DONASI_GOOGLE_CLIENT_ID") ||
    "YOUR_CLIENT_ID.apps.googleusercontent.com",

  // Otomatis false jika API_URL sudah diisi
  DEMO_MODE: false,
};
```

Simpan file (`Ctrl + S`).

---

## Langkah 6: Deploy ke Netlify (Gratis & Cepat)

Ada 2 cara mudah deploy ke Netlify:

### Cara A: Drag & Drop Folder (Paling Cepat / Tanpa Git)

1. Buka [app.netlify.com](https://app.netlify.com/) dan login/daftar.
2. Masuk ke tab **Sites** ➔ scroll ke bawah ke bagian _"Want to deploy a new site without connecting to Git?"_.
3. Buka File Explorer di laptopmu, buka folder:
   `c:\Maulana\College\CODING\Semester 5\DATA_MANAGEMENT\Tugas\DonasiAlumniApp\`
4. Tarik (_drag & drop_) folder **`frontend`** langsung ke kotak drop di browser Netlify.
5. Netlify akan langsung memproses deploy dalam 5 detik dan memberikan domain gratis, misalnya:
   `https://beasiswa-alumni-upi.netlify.app`.

### Cara B: Via Netlify CLI (Terminal)

Jika kamu punya `netlify-cli`:

```powershell
cd "c:\Maulana\College\CODING\Semester 5\DATA_MANAGEMENT\Tugas\DonasiAlumniApp"
netlify deploy --prod --dir=frontend
```

---

## Langkah 7: Finalisasi Otorisasi Google

1. Salin domain Netlify yang baru kamu dapatkan (misal: `https://beasiswa-alumni-upi.netlify.app`).
2. Buka kembali [Google Cloud Console Credentials](https://console.cloud.google.com/apis/credentials).
3. Klik nama OAuth Client yang dibuat di Langkah 4 (`Donasi Alumni Web`).
4. Di bagian **Authorized JavaScript origins**, klik **+ Add URI**, lalu tempelkan domain Netlify-mu:
   ```
   https://beasiswa-alumni-upi.netlify.app
   ```
   _(Penting: jangan sertakan tanda garis miring `/` di paling akhir)._
5. Klik **Save**.

---

## Selesai! Cara Mengetes Sistem yang Sudah Online:

1. Buka link Netlify kamu di browser.
2. Klik tombol **Saya Alumni UPI** ➔ Tombol **Sign in with Google** akan muncul dan berfungsi resmi!
3. Login dengan akun Google-mu.
4. Masuk ke halaman pengajuan verifikasi alumni, isi data dan upload ijazah contoh.
5. Login ke tab Admin di `https://your-site.netlify.app/admin.html` (otomatis terbuka untuk email `maulanaa1408@upi.edu`).
6. Setujui verifikasi ➔ Kode resmi **`A000001`** langsung terbit dan email notifikasi resmi masuk ke Gmail!
7. Uji pengiriman webhook mutasi bank live menggunakan simulator:
   ```powershell
   python simulator/send_webhook.py --url "URL_WEB_APP_APPS_SCRIPT" --ref A000001 --bank BCA --amount 500000
   ```
   Mutasi akan langsung terverifikasi otomatis (Tier 1 Match) dan dana tercatat di Google Sheets secara real-time!
