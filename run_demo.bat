@echo off
chcp 65001 >nul
echo =====================================================================
echo  SKENARIO SIMULASI LIVE DEMO: DONASI BEASISWA IKA UPI (VA & QRIS)
echo =====================================================================
echo Link Live Web: https://beasiswa-alumni-upi.netlify.app
echo Target: Multi-bank Webhook -^> Apps Script -^> Sheets -^> Email Notifikasi
echo.

set /p SIM_URL="Masukkan URL Web App Apps Script (atau tekan Enter untuk memakai yang ada di .env): "
if "%SIM_URL%"=="" (
    set URL_FLAG=
) else (
    set URL_FLAG=--url "%SIM_URL%"
)

echo.
echo ---------------------------------------------------------------------
echo [BABAK 1] DEMO ALUMNI BAYAR VIA VIRTUAL ACCOUNT BANK MANDIRI
echo Simulasi: Alumni A000001 bayar donasi Rp 250.000 ke VA 895081000001
echo ---------------------------------------------------------------------
pause
python simulator\send_webhook.py %URL_FLAG% --ref A000001 --bank MANDIRI --va --donor "Ahmad Rizki" --amount 250000 --tag BEASISWA
echo.
echo ^>^> Sistem mengenali nomor VA 895081000001 dan auto-match ke A000001 (Tier 1 Match)!
echo ^>^> Di browser donatur, polling 5 detik otomatis mendeteksi lunas dan berganti kartu hijau!
echo.

echo ---------------------------------------------------------------------
echo [BABAK 2] DEMO PEMBAYARAN VIA VIRTUAL ACCOUNT BCA
echo Simulasi: Alumni A000001 bayar Rp 500.000 ke VA BCA 390121000001
echo ---------------------------------------------------------------------
pause
python simulator\send_webhook.py %URL_FLAG% --ref A000001 --bank BCA --va --donor "Ahmad Rizki" --amount 500000 --tag BEASISWA
echo.
echo ^>^> Cek Google Sheets (tab transactions) dan email Gmail! Status MATCHED.
echo.

echo ---------------------------------------------------------------------
echo [BABAK 3] DEMO KETAHANAN DATA: IDEMPOTENSI (ANTI DATA GANDA)
echo Simulasi: Mutasi dengan ID yang sama terkirim ulang 2x (gangguan jaringan bank)
echo ---------------------------------------------------------------------
pause
python simulator\send_webhook.py %URL_FLAG% --duplicate
echo.
echo ^>^> Panggilan ke-2 harus berstatus duplicates: 1 dan tidak menambah baris baru.
echo.

echo ---------------------------------------------------------------------
echo [BABAK 4] DEMO KEAMANAN: PENOLAKAN TOKEN ILEGAL / BAD ACTOR
echo Simulasi: Request POST dikirim tanpa token rahasia yang valid
echo ---------------------------------------------------------------------
pause
python simulator\send_webhook.py %URL_FLAG% --bad-token
echo.
echo ^>^> Endpoint menolak request dengan status 401 Unauthorized.
echo.
echo =====================================================================
echo  SIMULASI DEMO SELESAI DENGAN SUKSES!
echo =====================================================================
pause
