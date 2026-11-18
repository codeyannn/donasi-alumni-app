/**
 * receipt.js
 * Secure official donation receipt viewer and PDF print controller for Phase P6.
 * Reads credentials strictly from client-side URL #fragment, sessionStorage (Guest),
 * or authenticated Alumni/Admin session token via POST body (zero URL query tokens).
 */

var RECEIPT_GUEST_SESSION_KEY = 'DONASI_GUEST_SESSION';

/**
 * Escapes HTML special characters before injecting dynamic strings into DOM templates.
 */
function escapeReceiptHtml(str) {
  if (str === undefined || str === null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Extracts receipt lookup parameters from client-side URL hash (#ref=...&token=...&tx=...&receipt=...).
 * Never reads sensitive tokens from window.location.search (query string).
 */
function parseReceiptHashFragment() {
  if (typeof window === 'undefined' || !window.location || !window.location.hash) {
    return {};
  }
  const rawHash = window.location.hash.replace(/^#/, '').trim();
  if (!rawHash) return {};

  const params = new URLSearchParams(rawHash);
  return {
    ref_code: (params.get('ref') || params.get('ref_code') || '').trim().toUpperCase(),
    access_token: (params.get('token') || params.get('access_token') || '').trim(),
    tx_id: (params.get('tx') || params.get('tx_id') || '').trim(),
    receipt_no: (params.get('receipt') || params.get('receipt_no') || '').trim().toUpperCase()
  };
}

/**
 * Loads Guest session credentials stored in sessionStorage for the current tab.
 */
function loadGuestReceiptSession() {
  try {
    if (typeof window !== 'undefined' && window.sessionStorage) {
      const raw = window.sessionStorage.getItem(RECEIPT_GUEST_SESSION_KEY);
      return raw ? JSON.parse(raw) : null;
    }
  } catch (ignoreErr) {
    return null;
  }
  return null;
}

/**
 * Saves Guest fragment credentials into sessionStorage so page refreshes in the same tab remain authenticated.
 */
function persistGuestReceiptSession(refCode, accessToken) {
  if (!refCode || !accessToken) return;
  try {
    if (typeof window !== 'undefined' && window.sessionStorage) {
      const existing = loadGuestReceiptSession() || {};
      window.sessionStorage.setItem(
        RECEIPT_GUEST_SESSION_KEY,
        JSON.stringify({
          ...existing,
          ref_code: refCode,
          access_token: accessToken
        })
      );
    }
  } catch (ignoreErr) {}
}

/**
 * Updates the status banner at the top of receipt.html.
 */
function setReceiptBannerState(title, message, isError) {
  const banner = document.getElementById('receiptStateBanner');
  const titleEl = document.getElementById('receiptStateTitle');
  const msgEl = document.getElementById('receiptStateMessage');
  if (!banner || !titleEl || !msgEl) return;

  banner.style.display = 'block';
  banner.style.borderTop = isError ? '4px solid #DC2626' : '4px solid var(--gold-500)';
  titleEl.style.color = isError ? '#991B1B' : 'var(--crimson-900)';
  titleEl.innerText = title;
  msgEl.innerText = message;
}

/**
 * Renders the verified official donation receipt document into #receiptDocumentCard.
 */
function renderOfficialReceiptDocument(receipt) {
  const docCard = document.getElementById('receiptDocumentCard');
  const contentEl = document.getElementById('receiptDocumentContent');
  const banner = document.getElementById('receiptStateBanner');
  const printBtn = document.getElementById('btnPrintReceipt');
  if (!docCard || !contentEl) return;

  if (banner) banner.style.display = 'none';
  if (printBtn) printBtn.style.display = 'inline-block';
  docCard.style.display = 'block';

  const sandboxBannerHtml = receipt.is_sandbox
    ? `<div style="background: #FFFBEB; border: 1px solid #FDE68A; border-radius: var(--radius-sm); padding: 10px 14px; margin-bottom: 18px; font-size: 12px; color: #92400E;">
         <strong>Keterangan Lingkungan (OPEN-03):</strong> ${escapeReceiptHtml(receipt.environment_notice)}
       </div>`
    : '';

  contentEl.innerHTML = `
    <div style="display: flex; justify-content: space-between; align-items: flex-start; flex-wrap: wrap; gap: 16px; border-bottom: 2px solid var(--border-mid); padding-bottom: 18px; margin-bottom: 20px;">
      <div>
        <div style="font-size: 11px; font-weight: 700; color: var(--crimson-700); text-transform: uppercase; letter-spacing: 0.8px;">
          Bukti Tanda Terima Donasi Sah
        </div>
        <h2 style="font-family: var(--font-display); font-size: 22px; color: var(--crimson-900); margin: 4px 0;">
          ${escapeReceiptHtml(receipt.org_name || 'Pengelola Beasiswa Ikatan Alumni UPI')}
        </h2>
        <div style="font-size: 12px; color: var(--text-sub);">
          Universitas Pendidikan Indonesia &bull; Sistem Penghimpunan Dana Beasiswa Terverifikasi
        </div>
      </div>
      <div style="text-align: right;">
        <div style="font-size: 11px; color: var(--text-dim); text-transform: uppercase;">Nomor Kuitansi Resmi</div>
        <div style="font-family: var(--font-mono); font-size: 18px; font-weight: 800; color: var(--crimson-900);">
          ${escapeReceiptHtml(receipt.receipt_no)}
        </div>
        <span class="badge badge-verified" style="margin-top: 4px; display: inline-block;">
          ${escapeReceiptHtml(receipt.match_status)} / ${escapeReceiptHtml(receipt.gateway_status)}
        </span>
      </div>
    </div>

    ${sandboxBannerHtml}

    <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 14px; margin-bottom: 20px; font-size: 13px;">
      <div style="background: #F8FAFC; border: 1px solid var(--border-dim); border-radius: var(--radius-sm); padding: 12px;">
        <div style="font-size: 11px; color: var(--text-dim); text-transform: uppercase;">Identitas Donatur</div>
        <div style="font-weight: 700; color: var(--text-main); font-size: 15px; margin-top: 2px;">
          ${escapeReceiptHtml(receipt.donor_name)}
        </div>
        <div style="font-size: 12px; color: var(--text-sub); margin-top: 4px;">
          Kode Referensi: <strong style="font-family: var(--font-mono);">${escapeReceiptHtml(receipt.ref_code)}</strong>
          (${escapeReceiptHtml(receipt.donor_type)})
        </div>
      </div>

      <div style="background: #F8FAFC; border: 1px solid var(--border-dim); border-radius: var(--radius-sm); padding: 12px;">
        <div style="font-size: 11px; color: var(--text-dim); text-transform: uppercase;">Program Beasiswa Tujuan</div>
        <div style="font-weight: 700; color: var(--crimson-900); font-size: 15px; margin-top: 2px;">
          ${escapeReceiptHtml(receipt.program_name)}
        </div>
        <div style="font-size: 12px; color: var(--text-sub); margin-top: 4px;">
          ID Program: <code style="font-family: var(--font-mono);">${escapeReceiptHtml(receipt.program_id || 'PRG-001')}</code>
        </div>
      </div>
    </div>

    <div style="background: #FFFFFF; border: 1px solid var(--border-mid); border-radius: var(--radius-sm); padding: 16px; margin-bottom: 20px;">
      <div style="font-size: 12px; font-weight: 700; color: var(--text-main); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 10px;">
        Rincian Finansial &amp; Kanal Pembayaran
      </div>
      <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
        <tbody>
          <tr style="border-bottom: 1px solid var(--border-dim);">
            <td style="padding: 8px 0; color: var(--text-sub);">ID Transaksi Sistem</td>
            <td style="padding: 8px 0; text-align: right; font-family: var(--font-mono); font-weight: 600;">${escapeReceiptHtml(receipt.tx_id)}</td>
          </tr>
          <tr style="border-bottom: 1px solid var(--border-dim);">
            <td style="padding: 8px 0; color: var(--text-sub);">Waktu Konfirmasi Transaksi</td>
            <td style="padding: 8px 0; text-align: right;">${escapeReceiptHtml(receipt.tx_date || receipt.issued_at)}</td>
          </tr>
          <tr style="border-bottom: 1px solid var(--border-dim);">
            <td style="padding: 8px 0; color: var(--text-sub);">Kanal &amp; Metode Pembayaran</td>
            <td style="padding: 8px 0; text-align: right; font-weight: 600;">
              ${escapeReceiptHtml(receipt.payment_channel)} (${escapeReceiptHtml(receipt.bank)})
            </td>
          </tr>
          <tr style="border-bottom: 1px solid var(--border-dim);">
            <td style="padding: 8px 0; color: var(--text-sub);">Nominal Donasi Kotor (Gross Amount)</td>
            <td style="padding: 8px 0; text-align: right; font-family: var(--font-mono);">${escapeReceiptHtml(receipt.formatted_gross_amount)}</td>
          </tr>
          <tr style="border-bottom: 1px solid var(--border-dim);">
            <td style="padding: 8px 0; color: var(--text-sub);">Biaya Payment Gateway (Gateway Fee)</td>
            <td style="padding: 8px 0; text-align: right; font-family: var(--font-mono);">${escapeReceiptHtml(receipt.formatted_gateway_fee)}</td>
          </tr>
          <tr>
            <td style="padding: 10px 0 4px 0; font-weight: 700; color: var(--crimson-900); font-size: 15px;">Nominal Bersih Diterima Kas Beasiswa (Net Amount)</td>
            <td style="padding: 10px 0 4px 0; text-align: right; font-family: var(--font-mono); font-weight: 800; color: #047857; font-size: 17px;">
              ${escapeReceiptHtml(receipt.formatted_net_amount)}
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 12px; font-size: 11px; color: var(--text-dim); padding-top: 12px; border-top: 1px dashed var(--border-mid);">
      <div>
        Diterbitkan secara elektronik pada: <strong>${escapeReceiptHtml(receipt.issued_at)}</strong><br>
        Dokumen ini sah sebagai bukti penerimaan dana tanpa memerlukan tanda tangan basah.
      </div>
      <div class="no-print">
        <button type="button" class="btn btn-primary" style="font-size: 12px; padding: 8px 16px;" onclick="window.print()">
          Cetak / Unduh PDF
        </button>
      </div>
    </div>
  `;
}

/**
 * Requests receipt data from backend POST get_receipt endpoint and renders the result.
 */
async function fetchAndRenderReceipt(requestBody) {
  setReceiptBannerState(
    'Memuat Bukti Kuitansi Resmi...',
    'Memverifikasi kepemilikan transaksi dan status konfirmasi dana.',
    false
  );

  try {
    const res = await API.post('get_receipt', requestBody);
    if (res && res.status === 'ok' && res.receipt) {
      renderOfficialReceiptDocument(res.receipt);
    } else {
      setReceiptBannerState(
        'Kuitansi Tidak Dapat Ditampilkan',
        (res && res.message) || 'Data kuitansi tidak ditemukan atau belum terkonfirmasi.',
        true
      );
    }
  } catch (err) {
    setReceiptBannerState(
      'Gagal Memuat Kuitansi',
      err.message || 'Terjadi kesalahan jaringan saat menghubungi server.',
      true
    );
  }
}

/**
 * Handles manual receipt lookup form submission on receipt.html.
 */
async function handleManualReceiptLookup(e) {
  if (e && e.preventDefault) e.preventDefault();
  const refOrTx = ((document.getElementById('receiptInputRefOrTx') || {}).value || '').trim();
  const accessTokenInput = ((document.getElementById('receiptInputAccessToken') || {}).value || '').trim();
  const idToken = typeof getAuthToken === 'function' ? getAuthToken() : '';
  const guestSession = loadGuestReceiptSession() || {};

  if (!refOrTx) return;

  const payload = {};
  if (/^KWT-/i.test(refOrTx)) {
    payload.receipt_no = refOrTx.toUpperCase();
  } else if (/^TX_/i.test(refOrTx)) {
    payload.tx_id = refOrTx;
  } else {
    payload.ref_code = refOrTx.toUpperCase();
  }

  const effectiveAccessToken = accessTokenInput || guestSession.access_token || '';
  if (effectiveAccessToken) {
    payload.access_token = effectiveAccessToken;
    if (payload.ref_code) {
      persistGuestReceiptSession(payload.ref_code, effectiveAccessToken);
    }
  } else if (idToken) {
    payload.id_token = idToken;
  } else {
    setReceiptBannerState(
      'Otorisasi Diperlukan',
      'Silakan masukkan Token Akses Tamu 256-bit Anda atau login sebagai Alumni UPI terlebih dahulu.',
      true
    );
    return;
  }

  await fetchAndRenderReceipt(payload);
}

/**
 * Initializes receipt.html by inspecting #fragment credentials, sessionStorage, or Alumni login token.
 */
async function initReceiptPage() {
  // Reject any accidental token in URL query string and clean address bar
  if (typeof window !== 'undefined' && window.location && window.location.search) {
    const q = new URLSearchParams(window.location.search);
    if (q.has('token') || q.has('access_token') || q.has('id_token')) {
      setReceiptBannerState(
        'Peringatan Keamanan URL',
        'Token tidak boleh dikirim pada query string URL (?token=...). Gunakan tautan fragment (#ref=...&token=...) atau formulir di bawah.',
        true
      );
      return;
    }
  }

  const frag = parseReceiptHashFragment();
  const guestSession = loadGuestReceiptSession() || {};
  const idToken = typeof getAuthToken === 'function' ? getAuthToken() : '';

  if (frag.ref_code && frag.access_token) {
    persistGuestReceiptSession(frag.ref_code, frag.access_token);
  }

  const targetRef = frag.ref_code || guestSession.ref_code || '';
  const targetAccessToken = frag.access_token || guestSession.access_token || '';
  const targetTxId = frag.tx_id || '';
  const targetReceiptNo = frag.receipt_no || '';

  // Pre-fill lookup inputs for convenience
  const refInput = document.getElementById('receiptInputRefOrTx');
  const tokInput = document.getElementById('receiptInputAccessToken');
  if (refInput && (targetReceiptNo || targetTxId || targetRef)) {
    refInput.value = targetReceiptNo || targetTxId || targetRef;
  }
  if (tokInput && targetAccessToken) {
    tokInput.value = targetAccessToken;
  }

  if ((targetTxId || targetReceiptNo) && idToken) {
    await fetchAndRenderReceipt({
      tx_id: targetTxId,
      receipt_no: targetReceiptNo,
      id_token: idToken
    });
    return;
  }

  if ((targetRef || targetTxId || targetReceiptNo) && targetAccessToken) {
    await fetchAndRenderReceipt({
      ref_code: targetRef,
      tx_id: targetTxId,
      receipt_no: targetReceiptNo,
      access_token: targetAccessToken
    });
    return;
  }

  setReceiptBannerState(
    'Masukkan Identitas Kuitansi',
    'Masukkan Kode Referensi / ID Transaksi beserta Token Akses Tamu (atau login sebagai Alumni) pada formulir di bawah.',
    false
  );
}

if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', initReceiptPage);
}
