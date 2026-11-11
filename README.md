# 🎓 DonasiAlumniApp — Sistem Donasi Beasiswa Khusus Alumni UPI

> Aplikasi web donasi beasiswa terintegrasi dengan verifikasi identitas alumni UPI, penerbitan kode unik alumni (`A000471`) & tamu (`G000012`), integrasi webhook mutasi multi-bank (BSI, Mandiri, BCA, BNI, BRI) secara real-time, notifikasi email otomatis ke donatur & admin, serta kepatuhan penuh terhadap **UU No. 27/2022 (Pelindungan Data Pribadi)**.

---

## 1. Alur & Fitur Utama

1. **Pilihan Peran Saat Masuk:**
   - **Saya Alumni UPI:** Mengisi formulir NIM, Tahun Lulus, Fakultas, dan mengunggah dokumen kelulusan (Ijazah / SKL / Kartu Alumni). Menunggu verifikasi admin.
   - **Bukan Alumni / Tamu Umum:** Langsung mendapatkan kode donatur tamu (contoh: `G000012`) dan dapat langsung menyalurkan donasi.
2. **Persetujuan Privasi Eksplisit (UU PDP No. 27/2022):**
   - Pengguna menyetujui pemrosesan data pribadi sebelum mendaftar.
   - Nama donatur di dasbor publik disensor secara otomatis (contoh: `Ahmad Rizki` ➔ `A***d R.` atau `Seseorang`).
   - Nomor rekening donatur dipotong (`71****56`) dan narasi mentah perbankan disimpan hanya di database privat pengelola.
   - **Minimisasi Data:** File bukti ijazah otomatis dihapus dari Google Drive setelah disetujui atau ditolak admin.
3. **Penerbitan ID Unik Alumni:**
   - Saat disetujui admin, alumni diterbitkan ID unik berurutan menggunakan `LockService` (contoh: `A000471`).
   - ID ini dikirimkan via email resmi kelulusan verifikasi alumni.
4. **Niat Donasi & Instruksi Transfer:**
   - Donatur memilih nominal dan bank tujuan (BSI, Mandiri, BCA, BNI, BRI).
   - Sistem menerbitkan instruksi transfer dan meminta donatur menuliskan ID referensi di berita m-banking.
5. **Mesin Pencocokan Mutasi 3-Tier (`Logic.gs`):**
   - **Tier 1 (Akurasi 100%):** Berita transfer memuat kode referensi (`A000471` / `G000012`). Otomatis diverifikasi dan niat donasi ditutup.
   - **Tier 2 (Fallback Unik):** Jika tidak ada kode, sistem mencari niat donasi yang memiliki Bank + Nominal sama persis dalam jendela 24 jam. Jika hanya ada 1 intent yang cocok, otomatis diverifikasi.
   - **Tier 3 (Review Queue):** Jika ambigu (terjadi collision nominal yang sama oleh 2 orang berbeda) atau tidak ada niat yang cocok, transaksi dicatat sebagai `UNMATCHED` dan masuk ke antrean review admin.
6. **Notifikasi Real-Time Tanpa Akun E-Banking Bendahara:**
   - **Email ke Donatur:** Bukti penerimaan sah donasi langsung masuk ke email donatur.
   - **Email ke Admin:** Notifikasi real-time dana masuk dan status matching ke `maulanaa1408@upi.edu`.
7. **Portal Admin:**
   - Tab Verifikasi Alumni (Approve / Reject).
   - Tab Review Queue (menautkan mutasi yang belum teridentifikasi ke donatur secara manual).
   - Tab Insight (total penghimpunan, rasio akurasi Tier 1-3, dan distribusi per bank).

---

## 2. Struktur Direktori

```
Tugas/DonasiAlumniApp/
├── apps-script/                 # Backend Google Apps Script
│   ├── appsscript.json          # Manifest Web App
│   ├── Setup.gs                 # Inisialisasi 9 tab Google Sheets & config
│   ├── Logic.gs                 # Pure logic: ref code, masking, parsers, 3-tier matcher
│   ├── Auth.gs                  # Google OAuth tokeninfo + CacheService + RBAC
│   ├── Users.gs                 # Registrasi, pengajuan bukti, & review admin
│   ├── Donations.gs             # Intent donasi, riwayat user, expiry trigger
│   ├── Webhook.gs               # Listener mutasi bank, dedupe, matcher execution
│   ├── Notifier.gs              # Dispatcher email donatur & admin
│   ├── Admin.gs                 # Endpoint operasional admin & insight
│   ├── PublicApi.gs             # Endpoint statistik publik (UU PDP compliant)
│   ├── AuditLog.gs              # Jejak audit aktivitas penting
│   └── Tests.gs                 # Self-test internal Apps Script
├── frontend/                    # Web App Frontend (Deploy Netlify)
│   ├── index.html               # Halaman pilih peran & dasbor publik
│   ├── app.html                 # Dasbor personal donatur & instruksi transfer
│   ├── admin.html               # Portal kontrol admin (verifikasi & review queue)
│   ├── css/style.css            # Styling modern responsif
│   └── js/
│       ├── config.js            # Konfigurasi URL API & Client ID
│       ├── api.js               # HTTP client + Mock demo engine
│       ├── auth.js              # Manajemen sesi Google Sign-In
│       ├── app.js               # Logika halaman pengguna
│       └── admin.js             # Logika halaman admin
├── simulator/                   # Simulator Webhook Multi-Bank
│   ├── payloads.py              # Generator narasi realistis 5 bank + ref_code
│   └── send_webhook.py          # CLI pengirim payload (--ref, --duplicate, dll.)
├── tests/
│   └── logic.test.js            # 14 unit test Node.js (100% PASS)
├── netlify.toml                 # Konfigurasi deploy Netlify
├── requirements.txt             # Dependensi Python
└── README.md
```

---

## 3. Skema Database Google Sheets

| Sheet                  | Kolom Utama                                                                                              | Fungsi                                                      |
| ---------------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `users`                | `user_id`, `email`, `full_name`, `role`, `ref_code`, `verification_status`, `consent_at`                 | Data pengguna terdaftar                                     |
| `alumni_verifications` | `verif_id`, `user_id`, `nim`, `grad_year`, `faculty`, `proof_file_id`, `status`, `reject_reason`         | Dokumen pengajuan alumni                                    |
| `donation_intents`     | `intent_id`, `user_id`, `ref_code`, `amount`, `bank`, `program`, `status`, `expires_at`                  | Niat transfer donasi aktif                                  |
| `transactions`         | `tx_id`, `mutation_id`, `bank`, `amount`, `donor_display_name`, `match_status`, `match_tier`, `ref_code` | Mutasi dana masuk terkonfirmasi                             |
| `review_queue`         | `queue_id`, `tx_id`, `bank`, `amount`, `description`, `reason`, `status`, `assigned_ref_code`            | Mutasi tier 3 untuk review manual admin                     |
| `counters`             | `name`, `value`                                                                                          | Urutan penomoran `ALUMNI` & `GUEST` via LockService         |
| `audit_log`            | `timestamp`, `actor_email`, `action`, `target`, `detail`                                                 | Audit trail kepatuhan data governance                       |
| `config`               | `key`, `value`                                                                                           | `WEBHOOK_TOKEN`, `ADMIN_EMAILS`, `MATCH_WINDOW_HOURS`, dll. |
| `program_keywords`     | `keyword`, `program`                                                                                     | Kamus tagging program donasi otomatis                       |

---

## 4. Panduan Menjalankan & Menguji

### A. Uji Coba Cepat Frontend (Mode Demo)

Buka terminal dan jalankan server lokal sederhana:

```powershell
cd "Tugas/DonasiAlumniApp/frontend"
python -m http.server 8000
```

Buka browser di `http://localhost:8000`:

- Pilih **Saya Alumni UPI** ➔ klik tombol **Demo Mode**.
- Anda akan diarahkan ke Dasbor, isi form verifikasi (NIM, Tahun Lulus, Fakultas, file ijazah contoh).
- Di menu atas klik **⚙️ Admin Panel** untuk menyetujui verifikasi. Diterbitkan kode ID unik seperti `A000471`.
- Kembali ke dasbor donasi dan buat instruksi donasi dengan nominal dan bank pilihan!

### B. Menjalankan Uji Logika (Node.js)

```powershell
cd "Tugas/DonasiAlumniApp"
node tests/logic.test.js
```

- Seluruh 14 test suite berjalan otomatis (parser BCA, BSI, Mandiri, BNI, BRI, masking nama, dan 3-tier matcher).

### C. Menjalankan Simulator Webhook Mutasi

```powershell
cd "Tugas/DonasiAlumniApp"

# Uji kirim mutasi BCA dengan menyertakan kode alumni A000471 (Tier 1 Match)
python simulator/send_webhook.py --ref A000471 --bank BCA --amount 500000 --dry-run
```

---

## 5. Langkah Deploy ke Google Apps Script

1. Buat Google Sheets baru di [sheets.new](https://sheets.new) (beri nama misalnya `Donasi_Alumni_UPI_App`).
2. Masuk ke **Extensions** ➔ **Apps Script**.
3. Buat file `.gs` sesuai isi berkas di folder `apps-script/`:
   - `Setup.gs`
   - `Logic.gs`
   - `Auth.gs`
   - `Users.gs`
   - `Donations.gs`
   - `Webhook.gs`
   - `Notifier.gs`
   - `Admin.gs`
   - `PublicApi.gs`
   - `AuditLog.gs`
   - `Tests.gs`
4. Pilih fungsi `setupSheets` di toolbar atas dan klik **Run (Jalankan)** untuk membuat 9 tab sheet dan konfigurasi awal.
5. Jalankan `runSelfTests` untuk memverifikasi logika internal berjalan 100% lulus.
6. Klik **Deploy** ➔ **New deployment** ➔ Jenis: **Web app** ➔ Execute as: **Me** ➔ Access: **Anyone**.
7. Salin URL Web App yang dihasilkan ke file `frontend/js/config.js` (atau simpan di localStorage `DONASI_API_URL`).
