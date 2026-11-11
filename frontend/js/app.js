/**
 * app.js
 * User Dashboard business logic: personal summary, intent creation,
 * 2-Tab Virtual Account & QRIS instructions, 5-second real-time polling, and simulation triggers.
 */

let currentUser = null;
let activePollingTimer = null;
let activeIntentData = null;

async function initDashboard() {
  currentUser = getCurrentUser();
  if (!currentUser) {
    window.location.href = 'index.html';
    return;
  }

  renderVerificationStatusBanner();
  await loadMyDonationsData();
}

function setAmount(val) {
  document.getElementById('donationAmount').value = val;
}

function renderVerificationStatusBanner() {
  const banner = document.getElementById('verificationBanner');
  if (!banner) return;

  if (currentUser.role === 'ALUMNI') {
    if (currentUser.verification_status === 'VERIFIED') {
      banner.style.display = 'block';
      banner.className = 'card notice-box verified';
      banner.innerHTML = `
        <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 12px;">
          <div>
            <div style="font-size: 11px; font-weight: 700; color: var(--status-verified); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 2px;">Status Terverifikasi</div>
            <h4 style="font-family: var(--font-display); color: #065F46; font-size: 16px; margin-bottom: 4px;">Alumni UPI Resmi</h4>
            <p style="font-size: 13px; color: #047857; margin: 0;">
              ID Donatur Alumni Anda: <strong class="id-badge">${escapeApp(currentUser.ref_code)}</strong>. Setiap transfer dana atau pembayaran Virtual Account otomatis dicatat atas nama Anda.
            </p>
          </div>
          <span class="badge badge-verified">Terverifikasi</span>
        </div>
      `;
    } else if (currentUser.verification_status === 'PENDING') {
      banner.style.display = 'block';
      banner.className = 'card notice-box pending';
      banner.innerHTML = `
        <div style="font-size: 11px; font-weight: 700; color: var(--gold-600); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 2px;">Sedang Ditinjau</div>
        <h4 style="font-family: var(--font-display); color: #92400E; font-size: 16px; margin-bottom: 4px;">Pengajuan Verifikasi Sedang Diproses Admin</h4>
        <p style="font-size: 13px; color: #B45309; margin: 0; line-height: 1.5;">
          Dokumen kelulusan Anda sedang ditinjau. Begitu disetujui, kode ID Unik Alumni (A000xxx) akan diterbitkan dan dikirimkan ke email Anda.
        </p>
      `;
    } else {
      banner.style.display = 'block';
      banner.className = 'card';
      banner.style.borderTop = '3px solid var(--crimson-700)';
      banner.innerHTML = `
        <h3 class="card-title" style="color: var(--crimson-900);">Verifikasi Status Kelulusan Alumni UPI</h3>
        <p style="font-size: 13px; color: var(--text-sub); margin-bottom: 18px;">
          Untuk memperoleh ID resmi alumni (A000xxx) dan penerbitan nomor Virtual Account khusus alumni, mohon lengkapi verifikasi berikut. Berkas bukti akan otomatis dihapus oleh sistem setelah diverifikasi (UU No. 27/2022).
        </p>
        <form onsubmit="handleVerificationSubmit(event)" id="verifForm">
          <div class="grid-cols-3" style="margin-bottom: 14px;">
            <div class="form-group">
              <label>Nomor Induk Mahasiswa (NIM)</label>
              <input type="text" id="verifNim" class="form-control" placeholder="Contoh: 1802134" required>
            </div>
            <div class="form-group">
              <label>Tahun Kelulusan</label>
              <input type="number" id="verifYear" class="form-control" placeholder="Contoh: 2023" min="1960" max="2026" required>
            </div>
            <div class="form-group">
              <label>Fakultas / Kampus Daerah</label>
              <select id="verifFaculty" class="form-control" required>
                <option value="FIP">FIP (Ilmu Pendidikan)</option>
                <option value="FPIPS">FPIPS (Pendidikan Ilmu Pengetahuan Sosial)</option>
                <option value="FPBS">FPBS (Pendidikan Bahasa & Sastra)</option>
                <option value="FPMIPA">FPMIPA (Pendidikan Matematika & IPA)</option>
                <option value="FPTK">FPTK (Pendidikan Teknologi & Kejuruan)</option>
                <option value="FPOK">FPOK (Pendidikan Olahraga & Kesehatan)</option>
                <option value="FPEB">FPEB (Pendidikan Ekonomi & Bisnis)</option>
                <option value="FPSD">FPSD (Pendidikan Seni & Desain)</option>
                <option value="Kampus Daerah">Kampus Daerah (Cibiru/Tasik/Purwakarta/Sumedang/Serang)</option>
                <option value="SPs">Sekolah Pascasarjana (SPs)</option>
              </select>
            </div>
          </div>
          <div class="form-group">
            <label>Unggah Berkas Bukti (PDF / JPG / PNG, Max 5MB)</label>
            <input type="file" id="verifFile" class="form-control" accept=".pdf,.png,.jpg,.jpeg" required>
          </div>
          <button type="submit" id="btnSubmitVerif" class="btn btn-primary">Kirim Berkas Verifikasi</button>
        </form>
      `;
    }
  } else {
    banner.style.display = 'block';
    banner.className = 'card notice-box';
    banner.style.background = '#FFFFFF';
    banner.style.border = '1px solid var(--border-mid)';
    banner.innerHTML = `
      <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px;">
        <div>
          <div style="font-size: 11px; font-weight: 700; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 2px;">Jalur Tamu Simpatisan</div>
          <h4 style="font-family: var(--font-display); color: var(--text-main); font-size: 15px; margin-bottom: 2px;">Donatur Umum</h4>
          <p style="font-size: 13px; color: var(--text-sub); margin: 0;">
            ID Referensi Tamu Anda: <strong class="id-badge">${escapeApp(currentUser.ref_code || 'G000000')}</strong>. Anda dapat langsung menyalurkan donasi pada formulir di bawah.
          </p>
        </div>
        <span class="badge badge-neutral">Tamu</span>
      </div>
    `;
  }
}

async function handleVerificationSubmit(e) {
  e.preventDefault();
  const nim = document.getElementById('verifNim').value;
  const year = document.getElementById('verifYear').value;
  const faculty = document.getElementById('verifFaculty').value;
  const fileInput = document.getElementById('verifFile');

  if (!fileInput.files || fileInput.files.length === 0) {
    alert('Silakan pilih berkas dokumen bukti kelulusan.');
    return;
  }

  const file = fileInput.files[0];
  const btn = document.getElementById('btnSubmitVerif');
  btn.disabled = true;
  btn.innerText = 'Mengunggah & Memproses...';

  const reader = new FileReader();
  reader.onload = async function() {
    const base64Data = reader.result.split(',')[1];
    try {
      const res = await API.post('submit_verification', {
        id_token: getAuthToken(),
        nim: nim,
        grad_year: year,
        faculty: faculty,
        file_base64: base64Data,
        file_name: file.name,
        file_mime: file.type
      });

      if (res.status === 'ok') {
        alert('Pengajuan verifikasi berhasil dikirim! Mohon tunggu persetujuan admin.');
        currentUser.verification_status = 'PENDING';
        window.localStorage.setItem('DONASI_USER', JSON.stringify(currentUser));
        renderVerificationStatusBanner();
      } else {
        alert('Gagal mengirim verifikasi: ' + (res.message || 'Error'));
      }
    } catch (err) {
      alert('Error: ' + err.message);
    } finally {
      btn.disabled = false;
      btn.innerText = 'Kirim Berkas Verifikasi';
    }
  };
  reader.readAsDataURL(file);
}

async function handleCreateIntent(e) {
  e.preventDefault();
  const amount = parseFloat(document.getElementById('donationAmount').value);
  const bank = document.getElementById('targetBank').value;
  const program = document.getElementById('programSelect').value;
  const isAnon = document.getElementById('anonCheck').checked;

  if (currentUser.role === 'ALUMNI' && currentUser.verification_status !== 'VERIFIED') {
    alert('Mohon tunggu verifikasi alumni disetujui terlebih dahulu agar donasi Anda tercatat dengan ID Alumni.');
    return;
  }

  const btn = document.getElementById('btnSubmitIntent');
  btn.disabled = true;
  btn.innerText = 'Membuat Virtual Account & QRIS...';

  try {
    const res = await API.post('create_intent', {
      id_token: getAuthToken(),
      amount: amount,
      bank: bank,
      program: program,
      is_anonymous: isAnon
    });

    if (res.status === 'ok') {
      activeIntentData = res;
      showTransferInstructionModal(res);
      startRealtimePolling(res.intent_id);
    } else {
      alert('Gagal membuat instruksi donasi: ' + (res.message || 'Error'));
    }
  } catch (err) {
    alert('Error: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.innerText = 'Lanjutkan ke Instruksi Transfer';
  }
}

function showTransferInstructionModal(res) {
  const box = document.getElementById('activeIntentBox');
  if (!box) return;

  const va = res.virtual_account || {
    va_number: '895081000471',
    va_formatted: '89508 1 000471',
    bank: res.bank,
    bank_prefix: '89508'
  };

  box.style.display = 'block';
  box.innerHTML = `
    <!-- Header Modal -->
    <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 14px; flex-wrap: wrap; gap: 8px;">
      <div>
        <span class="badge badge-pending" style="margin-bottom: 4px;">Instruksi Pembayaran Otomatis</span>
        <h3 style="font-family: var(--font-display); font-size: 18px; font-weight: 700; color: var(--crimson-900);">
          Pembayaran Donasi: ${escapeApp(res.formatted_amount)}
        </h3>
      </div>
      <button class="btn btn-secondary" style="font-size: 11px; padding: 4px 10px;" onclick="closeInstructionBox()">Tutup</button>
    </div>

    <!-- 2-Tab Navigation Buttons -->
    <div style="display: flex; gap: 6px; margin-bottom: 16px; border-bottom: 1px solid var(--border-dim); padding-bottom: 8px;">
      <button id="tabBtnVA" class="btn btn-primary" style="font-size: 12px; padding: 7px 14px;" onclick="switchInstructionTab('va')">
        Virtual Account (${escapeApp(res.bank)})
      </button>
      <button id="tabBtnQRIS" class="btn btn-secondary" style="font-size: 12px; padding: 7px 14px;" onclick="switchInstructionTab('qris')">
        Scan QRIS (Semua Bank / E-Wallet)
      </button>
    </div>

    <!-- Content Tab 1: Virtual Account -->
    <div id="contentTabVA" style="display: block; background: #FFFFFF; border: 1px solid var(--border-mid); border-radius: var(--radius-sm); padding: 18px; margin-bottom: 16px;">
      <div style="font-size: 12px; color: var(--text-dim); text-transform: uppercase; font-weight: 600; margin-bottom: 2px;">Bank Penagihan</div>
      <div style="font-size: 15px; font-weight: 700; color: var(--text-main); margin-bottom: 12px;">Bank ${escapeApp(res.bank)} Virtual Account</div>

      <div style="background: #FAFAFA; border: 1px dashed var(--crimson-700); border-radius: var(--radius-sm); padding: 14px; margin-bottom: 12px;">
        <div style="font-size: 11px; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px;">Nomor Virtual Account (12 Digit)</div>
        <div style="display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px;">
          <span style="font-family: var(--font-mono); font-size: 22px; font-weight: 800; color: var(--crimson-900); letter-spacing: 2px;">
            ${escapeApp(va.va_formatted)}
          </span>
          <button class="btn btn-primary" style="font-size: 11px; padding: 6px 12px;" onclick="navigator.clipboard.writeText('${va.va_number}'); alert('Nomor Virtual Account ${va.va_number} berhasil disalin!');">
            Salin Nomor VA
          </button>
        </div>
      </div>

      <div style="font-size: 12px; color: var(--text-sub); line-height: 1.6;">
        &bull; <strong>Kode Prefix Perusahaan:</strong> <code>${escapeApp(va.bank_prefix)}</code> (Lembaga Beasiswa IKA UPI)<br>
        &bull; <strong>Nama Penerima:</strong> BEASISWA IKA UPI - ${escapeApp(currentUser.full_name || 'ALUMNI')}<br>
        &bull; <strong>Nominal Transfer:</strong> ${escapeApp(res.formatted_amount)} (Harus persis sama)<br>
        &bull; Bebas biaya admin melalui transfer sesama Bank ${escapeApp(res.bank)} atau BI-FAST.
      </div>
    </div>

    <!-- Content Tab 2: QRIS (Scan QR) -->
    <div id="contentTabQRIS" style="display: none; background: #FFFFFF; border: 1px solid var(--border-mid); border-radius: var(--radius-sm); padding: 18px; margin-bottom: 16px; text-align: center;">
      <div style="font-size: 12px; color: var(--text-dim); text-transform: uppercase; font-weight: 600; margin-bottom: 4px;">Merchant Resmi QRIS</div>
      <div style="font-size: 16px; font-weight: 800; color: var(--crimson-900); margin-bottom: 12px;">BEASISWA IKATAN ALUMNI UPI</div>
      
      <!-- Real Canvas QR Render Container -->
      <div style="display: flex; justify-content: center; margin-bottom: 12px;">
        <div id="qrisContainer" style="background: #FFFFFF; padding: 12px; border: 1px solid var(--border-mid); border-radius: 8px; box-shadow: 0 2px 6px rgba(0,0,0,0.05); display: inline-block;"></div>
      </div>

      <div style="font-family: var(--font-mono); font-size: 17px; font-weight: 800; color: var(--crimson-700); margin-bottom: 6px;">
        ${escapeApp(res.formatted_amount)}
      </div>
      <p style="font-size: 12px; color: var(--text-dim); max-width: 400px; margin: 0 auto;">
        Buka BCA Mobile, Livin Mandiri, BRImo, BNI Mobile, BSI Mobile, atau e-wallet apa pun, lalu scan kode QR di atas untuk membayar.
      </p>
    </div>

    <!-- Real-time Polling Status & Simulation Trigger -->
    <div style="background: #FFFDF9; border: 1px solid var(--gold-500); border-radius: var(--radius-sm); padding: 14px; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 12px;">
      <div style="display: flex; align-items: center; gap: 10px;">
        <span style="display: inline-block; width: 10px; height: 10px; background: var(--gold-500); border-radius: 50%; animation: pulse 1.5s infinite;"></span>
        <div>
          <div style="font-size: 12px; font-weight: 700; color: var(--gold-600);" id="pollingStatusLabel">
            Memantau Mutasi Bank Masuk (Cek otomatis per 5 detik)...
          </div>
          <div style="font-size: 11px; color: var(--text-dim);" id="pollingCountdownLabel">
            Pengecekan berikutnya dalam 5 detik
          </div>
        </div>
      </div>
      
      <!-- Simulation Button for Presentations -->
      <button class="btn btn-gold" style="font-size: 11px; padding: 6px 12px;" onclick="triggerSimulatedPayment('${res.intent_id}')">
        Simulasikan Pembayaran Masuk (Demo)
      </button>
    </div>
  `;

  // Render QR Code immediately in background
  setTimeout(() => {
    const qrisElem = document.getElementById('qrisContainer');
    if (qrisElem && window.QRCode) {
      qrisElem.innerHTML = '';
      new QRCode(qrisElem, {
        text: (res.qris && res.qris.qris_payload) || `QRIS-DONASI-${res.intent_id}-${va.va_number}-${res.amount}`,
        width: 180,
        height: 180,
        colorDark: "#6B0E17",
        colorLight: "#FFFFFF",
        correctLevel: QRCode.CorrectLevel.M
      });
    }
  }, 50);

  window.scrollTo({ top: box.offsetTop - 80, behavior: 'smooth' });
}

function switchInstructionTab(tab) {
  const tabVA = document.getElementById('contentTabVA');
  const tabQR = document.getElementById('contentTabQRIS');
  const btnVA = document.getElementById('tabBtnVA');
  const btnQR = document.getElementById('tabBtnQRIS');

  if (tab === 'va') {
    tabVA.style.display = 'block';
    tabQR.style.display = 'none';
    btnVA.className = 'btn btn-primary';
    btnQR.className = 'btn btn-secondary';
  } else {
    tabVA.style.display = 'none';
    tabQR.style.display = 'block';
    btnVA.className = 'btn btn-secondary';
    btnQR.className = 'btn btn-primary';
  }
}

function closeInstructionBox() {
  if (activePollingTimer) {
    clearInterval(activePollingTimer);
    activePollingTimer = null;
  }
  document.getElementById('activeIntentBox').style.display = 'none';
}

/**
 * 5-Second Real-Time Polling Engine
 */
function startRealtimePolling(intentId) {
  if (activePollingTimer) {
    clearInterval(activePollingTimer);
  }

  let secondsLeft = 5;
  activePollingTimer = setInterval(async () => {
    secondsLeft--;
    const countdownElem = document.getElementById('pollingCountdownLabel');
    if (countdownElem) {
      countdownElem.innerText = `Pengecekan berikutnya dalam ${secondsLeft} detik`;
    }

    if (secondsLeft <= 0) {
      secondsLeft = 5;
      try {
        const check = await API.get('check_intent', {
          id_token: getAuthToken(),
          intent_id: intentId
        });

        if (check.status === 'ok' && check.intent_status === 'MATCHED') {
          // STOP polling and display success banner
          clearInterval(activePollingTimer);
          activePollingTimer = null;
          handlePaymentSuccess(intentId);
        }
      } catch (err) {
        console.warn('[POLLING-ERR]', err);
      }
    }
  }, 1000);
}

/**
 * Triggered when payment is confirmed by real-time poller
 */
async function handlePaymentSuccess(intentId) {
  const box = document.getElementById('activeIntentBox');
  if (!box) return;

  box.style.borderTop = '4px solid var(--status-verified)';
  box.style.background = '#ECFDF5';
  box.innerHTML = `
    <div style="display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; padding: 10px 0;">
      <div>
        <div style="font-size: 11px; font-weight: 700; color: var(--status-verified); text-transform: uppercase; letter-spacing: 0.5px;">Pembayaran Terverifikasi Real-Time</div>
        <h3 style="font-family: var(--font-display); font-size: 19px; color: #065F46; margin: 4px 0;">
          Alhamdulillah! Donasi Anda Telah Masuk ke Kas Beasiswa
        </h3>
        <p style="font-size: 13px; color: #047857; margin: 0;">
          Dana telah dicatat ke buku kas Google Sheets pengelola. Email bukti tanda terima sah telah dikirimkan ke email Anda.
        </p>
      </div>
      <button class="btn btn-success" onclick="closeInstructionBox()">Selesai</button>
    </div>
  `;

  // Instantly refresh personal donations history table and public stats
  await loadMyDonationsData();
}

/**
 * Trigger simulated payment from UI button (Demo Mode / Presentation helper)
 */
async function triggerSimulatedPayment(intentId) {
  const label = document.getElementById('pollingStatusLabel');
  if (label) {
    label.innerText = 'Mengirimkan sinyal mutasi pembayaran bank...';
  }

  try {
    const res = await API.post('simulate_payment', {
      id_token: getAuthToken(),
      intent_id: intentId
    });

    if (res.status === 'ok') {
      // The next polling cycle will catch MATCHED, or trigger immediately
      handlePaymentSuccess(intentId);
    } else {
      alert('Gagal simulasi: ' + (res.message || 'Error'));
    }
  } catch (e) {
    alert('Simulasi pembayaran gagal: ' + e.message);
  }
}

async function loadMyDonationsData() {
  try {
    const data = await API.get('my_donations', { id_token: getAuthToken() });
    if (data.status === 'ok') {
      if (data.user) {
        currentUser = { ...currentUser, ...data.user };
        window.localStorage.setItem('DONASI_USER', JSON.stringify(currentUser));
        document.getElementById('myRefCodeDisplay').innerText = currentUser.ref_code || 'BELUM TERVERIFIKASI';
      }

      document.getElementById('myTotalDonated').innerText = data.summary.formatted_total || 'Rp 0';
      document.getElementById('myTxCount').innerText = `${data.summary.total_count || 0} Kali`;

      const tbody = document.getElementById('myDonationsTable');
      tbody.innerHTML = '';

      if (!data.history || data.history.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--text-dim); padding: 24px;">Belum ada riwayat donasi. Silakan salurkan donasi pertama Anda di atas.</td></tr>';
        return;
      }

      data.history.forEach(item => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td>${escapeApp(item.date)}</td>
          <td><strong>${escapeApp(item.bank)}</strong></td>
          <td style="color: var(--crimson-700); font-weight: 700;">${escapeApp(item.formatted_amount)}</td>
          <td>${escapeApp(item.program)}</td>
          <td><span class="id-badge" style="font-size: 12px;">${escapeApp(item.ref_code || '-')}</span></td>
          <td><span class="badge badge-verified">Terverifikasi</span></td>
        `;
        tbody.appendChild(tr);
      });
    }
  } catch (err) {
    console.error('Error fetching my donations:', err);
  }
}

function escapeApp(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

document.addEventListener('DOMContentLoaded', initDashboard);
