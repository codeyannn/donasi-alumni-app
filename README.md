# DonasiAlumniApp — Sistem Manajemen Donasi Beasiswa Hybrid Ikatan Alumni UPI

> Aplikasi web donasi beasiswa terpadu dengan verifikasi identitas alumni UPI 5-tingkat (`A000xxx`), donasi Guest tanpa akun (`G000xxx` + `access_token` 256-bit), integrasi pembayaran **Hybrid** (**Midtrans Snap** + **Transfer Bank Manual 3-Tier**), penerbitan kuitansi resmi (`KWT-YYYY-000001`), notifikasi email otomatis, serta kepatuhan **UU No. 27/2022 (Pelindungan Data Pribadi)**.

---

## 1. Alur & Fitur Utama

1. **Alumni UPI (`app.html`):**
   - Login menggunakan **Google Sign-In** (validasi `aud` & `email_verified` *fail-closed* di `Auth.gs`; manipulasi `role: "ADMIN"` diblokir penuh oleh backend).
   - Verifikasi kelulusan 5-status: `NOT_SUBMITTED` → `PENDING` → `APPROVED` / `NEEDS_REVISION` / `REJECTED` (`OPEN-01`: `REJECTED` bersifat final; revisi hanya lewat `NEEDS_REVISION`).
   - Formulir donasi alumni terkunci di UI dan backend sampai status `APPROVED` dan diterbitkan kode unik alumni `A000xxx`.
   - Berkas bukti kelulusan disimpan di folder Google Drive privat (diakses admin via `admin_verif_proof`) dan otomatis dihapus (*auto-purge*) setelah `APPROVED` atau `REJECTED`.

2. **Guest / Non-Alumni Tanpa Akun (`index.html` & `guest.js`):**
   - Donasi langsung di beranda tanpa login Google dan **tanpa membuat record di sheet `users`**.
   - Sistem menerbitkan kode referensi `G000xxx` + `access_token` acak 256-bit (disimpan ter-hash SHA-256 + `TOKEN_PEPPER`).
   - Pemulihan akses menggunakan `sessionStorage` tab aktif, `idempotency_proof` saat retry koneksi putus, tautan URL `#fragment` email, serta rotasi token aman (`OPEN-04`).

3. **Pembayaran Hybrid (`MIDTRANS_SNAP` & `MANUAL_TRANSFER`):**
   - **Midtrans Snap (`Payments.gs` & `Webhook.gs`):** Dukungan Dual-Mode (**Webhook SHA-512** + **Active Status Inquiry** polling 5 detik dengan HTTP 404 hold) serta **Self-Healing Write-Ahead** + reversal in-place (`REFUNDED`, `PARTIAL_REFUNDED`, `CHARGEBACK`). Pada Mode Sandbox (`OPEN-03`), `gateway_fee = 0` dan `gross_amount = net_amount`.
   - **Transfer Bank Manual 3-Tier (`Logic.gs` & `Webhook.gs`):** Mendukung VA 12-digit dan narasi mutasi 5 bank (BCA, Mandiri, BRI, BNI, BSI) lewat webhook HMAC-SHA256 + anti-replay timestamp/nonce di body JSON (`WEBHOOK_MANUAL_SECRET`), lengkap dengan anti-false-matching agar transfer dengan nominal berbeda tidak menutup intent `PENDING`.

4. **Kuitansi Resmi (`receipt.html`, `Receipts.gs`) & Konsol Admin (`admin.html`, `Admin.gs`):**
   - Nomor kuitansi `KWT-YYYY-000001` diterbitkan eksklusif untuk transaksi terkonfirmasi (`MATCHED` / `MANUAL_MATCHED`); transaksi `UNMATCHED` maupun `REFUNDED` dilarang memiliki kuitansi aktif.
   - Status pengiriman email (`SENT` / `FAILED` / `PENDING` / `NOT_APPLICABLE`) dipisah dari status pembayaran, dilengkapi tombol idempoten `retry_tx_email`.
   - Konsol Admin mendukung: Review Verifikasi Alumni + Pratinjau Bukti Drive, Antrean `UNMATCHED`, Monitoring Transaksi & Sinkronisasi Midtrans, CRUD Master Program (`Programs.gs`), Laporan Keuangan (`gross`/`fee`/`net`) + Ekspor CSV aman, serta Audit Log Admin terpaginasi dan teredaksi (`AuditLog.gs`).

5. **Transparansi Publik Agregat Murni (`PublicApi.gs`):**
   - Endpoint publik `GET ?action=public_summary` hanya mengembalikan total dana terhimpun, jumlah transaksi, nominal hari ini, dan agregat per program/bank (di-cache 60 detik), bebas dari daftar transaksi individu ataupun PII.

---

## 2. Struktur Direktori

```text
Tugas/DonasiAlumniApp/
├── apps-script/                    # Backend Google Apps Script V8 (15 file .gs + manifest)
│   ├── appsscript.json             # Manifest Web App (Asia/Jakarta, V8)
│   ├── Setup.gs                    # Skema V1/V2 (10 sheet), backup/restore, staging guard, & migrasi
│   ├── Logic.gs                    # Pure domain logic: VA, 5-bank parser, 3-Tier, Midtrans mappers, masking
│   ├── Auth.gs                     # Verifikasi Google OAuth, RBAC ADMIN_EMAILS, HMAC webhook, & token 256-bit
│   ├── AuditLog.gs                 # Append-only audit log dengan redaksi rahasia & paginasi admin
│   ├── Notifier.gs                 # Email konfirmasi donatur, kuitansi, revisi, & alert admin
│   ├── Programs.gs                 # Master program CRUD + guard penghapusan histori
│   ├── Payments.gs                 # Wrapper Midtrans Snap API, SHA-512, & alokator KWT-YYYY-XXXXXX
│   ├── Receipts.gs                 # Akses kuitansi terverifikasi & proteksi anti-IDOR / reversal
│   ├── Users.gs                    # Login alumni, unggah bukti privat, & approval atomik
│   ├── Donations.gs                # Checkout Alumni/Guest, idempotency recovery, polling Active Inquiry
│   ├── Webhook.gs                  # Webhook Bank Manual HMAC & Webhook Midtrans SHA-512 Self-Healing
│   ├── Admin.gs                    # Portal admin, monitoring transaksi, sync Midtrans, & retry email
│   ├── PublicApi.gs                # Agregat publik murni ter-cache 60 detik
│   ├── Tests.gs                    # Self-test internal di runtime Apps Script V8
│   └── Code.gs                     # Router HTTP doGet (publik) & doPost (text/plain JSON + webhooks)
├── frontend/                       # Web App Frontend Statis (Deploy Netlify)
│   ├── index.html                  # Beranda publik agregat, checkout Guest, & pelacak status
│   ├── app.html                    # Dasbor Alumni terverifikasi & form upload verifikasi
│   ├── admin.html                  # Portal Admin 6-tab (Verif, Queue, Transaksi/Midtrans, Program, Insight, Audit)
│   ├── receipt.html                # Halaman cetak bukti kuitansi resmi (@media print)
│   ├── css/style.css               # Styling institusional UPI + print media rules
│   └── js/
│       ├── config.js               # API_URL, GOOGLE_CLIENT_ID, MIDTRANS_CLIENT_KEY, DEMO_MODE
│       ├── api.js                  # HTTP client POST text/plain (bebas CORS preflight & query token)
│       ├── auth.js                 # Manajemen sesi Google Sign-In Alumni/Admin
│       ├── guest.js                # Checkout & pelacakan Guest berbasis sessionStorage + #fragment
│       ├── app.js                  # Controller Alumni, dynamic programs, Snap popup, & polling
│       ├── admin.js                # Controller 6-tab Portal Admin & ekspor CSV aman
│       └── receipt.js              # Controller receipt.html berbasis #fragment / sessionStorage
├── simulator/                      # Simulator Webhook Multi-Bank
│   ├── payloads.py                 # Generator narasi mutasi realistis 5 bank
│   └── send_webhook.py             # CLI webhook pengirim payload HMAC-SHA256 JSON body
├── tests/                          # Suite Uji Otomatis Node.js (67 Passed, 0 Failed)
│   ├── logic.test.js               # 17 unit test logika murni
│   ├── p0_security.test.js         # 9 test remediasi keamanan P0
│   ├── p1_stabilization.test.js    # 5 test stabilisasi & anti-false-match P1
│   ├── p2_migration.test.js        # 9 test backup, preflight, dry-run, staging guard, & inspeksi V2
│   ├── p3_auth_verification.test.js# 5 test state machine verifikasi & Drive privat P3
│   ├── p4_donation_management.test.js # 6 test Program CRUD, Guest checkout, & token recovery P4
│   ├── p5_midtrans_hybrid.test.js  # 5 test Midtrans SHA-512, Active Inquiry, Self-Healing, & Refund P5
│   ├── p6_receipt_notification.test.js # 4 test KWT receipt, anti-IDOR, & retry_tx_email P6
│   ├── p7_admin_dashboard.test.js  # 3 test PublicApi agregat, Admin transaksi, & Audit Log P7
│   └── p8_acceptance_20_scenarios.test.js # 4 grup terpadu mencakup TEST-01 s/d TEST-20
├── netlify.toml
├── requirements.txt
├── PANDUAN_DEPLOY.md
├── LAPORAN.md
└── README.md
```

---

## 3. Skema Database Google Sheets V2 (10 Sheet)

| Sheet | Kolom | Fungsi |
| :--- | :--- | :--- |
| `users` | 9 kolom (`user_id` .. `created_at`) | Data akun Alumni & Admin (tanpa akun Guest) |
| `alumni_verifications` | 13 kolom (`verif_id` .. `reject_reason`) | Tiket verifikasi ijazah alumni 5-tingkat |
| `donation_intents` | 21 kolom (10 V1 + 11 V2 Midtrans & Guest token hash) | Niat donasi Alumni/Guest beserta `midtrans_order_id` & `last_inquiry_at` |
| `transactions` | 35 kolom (17 V1 + 18 V2 Gateway, Receipt, & Email state) | Rekam mutasi manual & transaksi Midtrans (`gross`/`fee`/`net`, `receipt_no`, `email_status`) |
| `review_queue` | 13 kolom | Antrean manual untuk mutasi Tier 3 (`UNMATCHED`) |
| `counters` | `name`, `value` | Sequence atomik `ALUMNI`, `GUEST`, `RECEIPT`, `PROGRAM` via `LockService` |
| `audit_log` | `timestamp`, `actor_email`, `action`, `target`, `detail` | Log audit append-only dengan redaksi token/secret otomatis |
| `config` | `key`, `value`, `description` | Konfigurasi non-rahasia operasional (rahasia sensitif dipindah ke `ScriptProperties`) |
| `program_keywords` | `keyword`, `program` | Kamus deteksi program fallback |
| `programs` | `program_id`, `name`, `description`, `is_active`, `created_at`, `updated_at` | Master program donasi terkelola Admin (`PRG-001`..`PRG-005`) |

---

## 4. Menjalankan Pengujian Lokal

Jalankan seluruh suite test regresi dan penerimaan P0–P8 dengan Node.js:

```powershell
cd "c:\Maulana\College\CODING\Semester 5\DATA_MANAGEMENT\Tugas\DonasiAlumniApp"
node tests/logic.test.js
node tests/p0_security.test.js
node tests/p1_stabilization.test.js
node tests/p2_migration.test.js
node tests/p3_auth_verification.test.js
node tests/p4_donation_management.test.js
node tests/p5_midtrans_hybrid.test.js
node tests/p6_receipt_notification.test.js
node tests/p7_admin_dashboard.test.js
node tests/p8_acceptance_20_scenarios.test.js
```

Untuk panduan instalasi, konfigurasi `ScriptProperties`, migrasi V2 aman, hingga pengujian live di Google Apps Script & Netlify, lihat [PANDUAN_DEPLOY.md](file:///c:/Maulana/College/CODING/Semester%205/DATA_MANAGEMENT/Tugas/DonasiAlumniApp/PANDUAN_DEPLOY.md).
