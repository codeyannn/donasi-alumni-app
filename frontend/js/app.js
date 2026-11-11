/**
 * app.js
 * User Dashboard business logic: personal summary, intent creation, and alumni verification form.
 */

let currentUser = null;

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
              ID Donatur Alumni Anda: <strong class="id-badge">${escapeApp(currentUser.ref_code)}</strong>. Setiap transfer dana yang menyertakan kode ini otomatis dicatat atas nama Anda.
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
      // NONE or REJECTED: Show upload verification form
      banner.style.display = 'block';
      banner.className = 'card';
      banner.style.borderTop = '3px solid var(--crimson-700)';
      banner.innerHTML = `
        <h3 class="card-title" style="color: var(--crimson-900);">Verifikasi Status Kelulusan Alumni UPI</h3>
        <p style="font-size: 13px; color: var(--text-sub); margin-bottom: 18px;">
          Untuk memperoleh ID resmi alumni (A000xxx) dan pelaporan donasi khusus alumni, mohon lengkapi verifikasi berikut. Berkas bukti (Ijazah / SKL / Kartu Alumni) akan otomatis dihapus oleh sistem setelah diverifikasi (kepatuhan UU No. 27/2022).
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
    // Guest role
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
  btn.innerText = 'Membuat Instruksi Transfer...';

  try {
    const res = await API.post('create_intent', {
      id_token: getAuthToken(),
      amount: amount,
      bank: bank,
      program: program,
      is_anonymous: isAnon
    });

    if (res.status === 'ok') {
      showTransferInstructionModal(res);
      await loadMyDonationsData();
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

  box.style.display = 'block';
  box.innerHTML = `
    <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 12px;">
      <div>
        <span class="badge badge-pending" style="margin-bottom: 4px;">Instruksi Transfer</span>
        <h3 style="font-family: var(--font-display); font-size: 17px; font-weight: 700; color: var(--crimson-900);">Rincian Rekening Tujuan & Kode Berita</h3>
      </div>
      <button class="btn btn-secondary" style="font-size: 11px; padding: 4px 10px;" onclick="document.getElementById('activeIntentBox').style.display='none'">Tutup</button>
    </div>
    <p style="font-size: 13px; color: var(--text-sub); margin-bottom: 16px;">
      Silakan transfer donasi sesuai rincian berikut melalui m-banking atau ATM bank Anda:
    </p>

    <div style="background: white; border: 1px solid var(--border-mid); border-radius: var(--radius-sm); padding: 18px; margin-bottom: 14px;">
      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 14px; margin-bottom: 14px;">
        <div>
          <div class="metric-label">Bank Tujuan</div>
          <div style="font-size: 16px; font-weight: 700; color: var(--text-main);">${escapeApp(res.bank)} (Rek. Beasiswa IKA UPI)</div>
        </div>
        <div>
          <div class="metric-label">Nominal Transfer</div>
          <div style="font-size: 18px; font-weight: 800; color: var(--crimson-700);">${escapeApp(res.formatted_amount)}</div>
        </div>
      </div>

      <div style="border-top: 1px solid var(--border-dim); padding-top: 14px;">
        <div class="metric-label">Kode Referensi Donatur Anda</div>
        <div style="display: flex; align-items: center; gap: 10px; margin-top: 4px;">
          <span class="id-badge" style="font-size: 16px;">${escapeApp(res.ref_code)}</span>
          <button class="btn btn-secondary" style="font-size: 11px; padding: 4px 10px;" onclick="navigator.clipboard.writeText('${res.ref_code}'); alert('Kode referensi berhasil disalin.');">Salin Kode</button>
        </div>
      </div>

      <div style="background: var(--gold-50); border-left: 3px solid var(--gold-500); padding: 10px 14px; font-size: 12px; color: var(--gold-600); margin-top: 14px;">
        <strong>Perhatian:</strong> Cantumkan kode <strong>${escapeApp(res.ref_code)}</strong> pada kolom <em>Berita/Keterangan</em> transfer agar mutasi teridentifikasi instan.
      </div>
    </div>
    <div style="font-size: 12px; color: var(--text-dim);">
      Sistem memantau mutasi secara real-time. Tanda terima sah akan langsung dikirimkan ke email Anda begitu dana terverifikasi.
    </div>
  `;
  window.scrollTo({ top: box.offsetTop - 80, behavior: 'smooth' });
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
