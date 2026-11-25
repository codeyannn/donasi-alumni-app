/**
 * guest.js
 * Accountless Guest donation checkout, active program loader, sessionStorage token persistence,
 * and secure status lookup via POST body without localStorage or URL query tokens.
 */

var GUEST_SESSION_STORAGE_KEY = 'DONASI_GUEST_SESSION';
var GUEST_PENDING_REQ_STORAGE_KEY = 'DONASI_GUEST_PENDING_REQ';
let guestPollingTimer = null;
let guestCountdownTimer = null;
let guestRequestCounter = 0;

/**
 * Escapes HTML special characters before injecting dynamic values into the DOM.
 */
function escapeGuestHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Generates an opaque per-submission client_request_id using Web Crypto when available.
 */
function generateClientRequestId_() {
  guestRequestCounter++;
  if (typeof window !== 'undefined' && window.crypto) {
    if (typeof window.crypto.randomUUID === 'function') {
      return window.crypto.randomUUID();
    }
    if (typeof window.crypto.getRandomValues === 'function') {
      const bytes = new Uint8Array(16);
      window.crypto.getRandomValues(bytes);
      return 'REQ_' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    }
  }
  return 'REQ_' + Date.now() + '_' + guestRequestCounter;
}

/**
 * Generates a 256-bit ephemeral proof-of-possession secret held only in browser sessionStorage
 * while a guest checkout submission is pending or recovering from a dropped HTTP response.
 */
function generateClientIdempotencyProof_() {
  if (typeof window !== 'undefined' && window.crypto && typeof window.crypto.getRandomValues === 'function') {
    const bytes = new Uint8Array(32);
    window.crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }
  return generateClientRequestId_() + '_' + generateClientRequestId_();
}

/**
 * Computes a deterministic fingerprint string for the active Guest form values.
 */
function buildGuestFormFingerprint_(payload) {
  return [
    payload.donor_name,
    payload.donor_email.toLowerCase(),
    String(payload.amount),
    payload.program_id,
    payload.payment_channel,
    payload.bank,
    String(Boolean(payload.is_anonymous))
  ].join('|');
}

/**
 * Retrieves or creates a pending { client_request_id, idempotency_proof } pair in sessionStorage
 * so retries after a dropped network response recover safely without losing access_token.
 */
function getOrCreatePendingGuestRequest_(fingerprint) {
  try {
    if (typeof window !== 'undefined' && window.sessionStorage) {
      const raw = window.sessionStorage.getItem(GUEST_PENDING_REQ_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && parsed.fingerprint === fingerprint && parsed.client_request_id && parsed.idempotency_proof) {
          return parsed;
        }
      }
      const fresh = {
        fingerprint,
        client_request_id: generateClientRequestId_(),
        idempotency_proof: generateClientIdempotencyProof_()
      };
      window.sessionStorage.setItem(GUEST_PENDING_REQ_STORAGE_KEY, JSON.stringify(fresh));
      return fresh;
    }
  } catch (ignoreStorageErr) {
    // Fall back cleanly to in-memory credentials when storage is unavailable
  }
  return {
    fingerprint,
    client_request_id: generateClientRequestId_(),
    idempotency_proof: generateClientIdempotencyProof_()
  };
}

/**
 * Clears in-flight idempotency state only after the access_token is durably received and saved.
 */
function clearPendingGuestRequest_() {
  try {
    if (typeof window !== 'undefined' && window.sessionStorage) {
      window.sessionStorage.removeItem(GUEST_PENDING_REQ_STORAGE_KEY);
    }
  } catch (ignoreRemoveErr) {}
}

/**
 * Saves Guest intent reference and raw access_token strictly in sessionStorage (OPEN-04).
 * Raw tokens must NEVER be stored in localStorage.
 */
function saveGuestSession(record) {
  try {
    if (typeof window !== 'undefined' && window.sessionStorage) {
      window.sessionStorage.setItem(GUEST_SESSION_STORAGE_KEY, JSON.stringify(record));
    }
  } catch (ignoreStorageErr) {
    // Fallback cleanly if browser restricts sessionStorage
  }
}

/**
 * Retrieves current tab's Guest session token metadata from sessionStorage.
 */
function loadGuestSession() {
  try {
    if (typeof window !== 'undefined' && window.sessionStorage) {
      const raw = window.sessionStorage.getItem(GUEST_SESSION_STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    }
  } catch (ignoreStorageErr) {
    return null;
  }
  return null;
}

/**
 * Parses #ref=G000xxx&token=... URL fragment cleanly without reading or exposing URL query strings.
 */
function parseGuestFragmentParams() {
  if (typeof window === 'undefined' || !window.location || !window.location.hash) {
    return null;
  }
  const hash = window.location.hash.replace(/^#/, '');
  if (!hash) return null;
  const params = new URLSearchParams(hash);
  const ref = params.get('ref');
  const token = params.get('token');
  if (ref && token) {
    return { ref_code: ref.trim().toUpperCase(), access_token: token.trim() };
  }
  return null;
}

/**
 * Opens the inline accountless Guest donation checkout card without opening Google Sign-In.
 */
function openGuestCheckoutSection() {
  const card = document.getElementById('guestCheckoutSection');
  if (!card) return;
  card.style.display = 'block';
  card.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/**
 * Toggles visibility of manual bank dropdown based on chosen Guest payment channel.
 */
function handleGuestChannelChange() {
  const sel = document.getElementById('guestPaymentChannel');
  const bankGroup = document.getElementById('guestBankGroup');
  if (!sel || !bankGroup) return;
  bankGroup.style.display = sel.value === 'MIDTRANS_SNAP' ? 'none' : 'block';
}

/**
 * Loads active donation programs dynamically from backend GET active_programs endpoint
 * with instant sessionStorage Stale-While-Revalidate caching.
 */
async function loadGuestActivePrograms() {
  const selectEl = document.getElementById('guestProgramSelect');
  if (!selectEl) return;

  const applyProgramsToSelect = (programs) => {
    if (!Array.isArray(programs) || programs.length === 0) return;
    selectEl.innerHTML = programs
      .map((p) => `<option value="${escapeGuestHtml(p.program_id)}">${escapeGuestHtml(p.name)}</option>`)
      .join('');
  };

  // Render cached active programs immediately if available in sessionStorage
  try {
    if (typeof window !== 'undefined' && window.sessionStorage) {
      const cachedRaw = window.sessionStorage.getItem('DONASI_ACTIVE_PROGRAMS_CACHE');
      if (cachedRaw) {
        const cachedObj = JSON.parse(cachedRaw);
        if (cachedObj && Array.isArray(cachedObj.programs) && cachedObj.programs.length > 0) {
          applyProgramsToSelect(cachedObj.programs);
          // Avoid extra GAS round-trip when cache was populated less than 60 seconds ago
          if (cachedObj.ts && Date.now() - cachedObj.ts < 60000) {
            return;
          }
        }
      }
    }
  } catch (ignoreCacheErr) {}

  try {
    const res = await API.get('active_programs');
    if (res && res.status === 'ok' && Array.isArray(res.programs) && res.programs.length > 0) {
      applyProgramsToSelect(res.programs);
      try {
        if (typeof window !== 'undefined' && window.sessionStorage) {
          window.sessionStorage.setItem(
            'DONASI_ACTIVE_PROGRAMS_CACHE',
            JSON.stringify({ ts: Date.now(), programs: res.programs })
          );
        }
      } catch (ignoreSaveErr) {}
    }
  } catch (err) {
    console.error('Failed loading active programs for guest form:', err);
  }
}

/**
 * Submits accountless Guest donation checkout without calling register_or_login.
 */
async function handleGuestCheckoutSubmit(e) {
  e.preventDefault();

  const donorName = (document.getElementById('guestDonorName') || {}).value || '';
  const donorEmail = (document.getElementById('guestDonorEmail') || {}).value || '';
  const amount = parseFloat((document.getElementById('guestAmount') || {}).value || '0');
  const programId = (document.getElementById('guestProgramSelect') || {}).value || 'PRG-001';
  const channel = (document.getElementById('guestPaymentChannel') || {}).value || 'QRIS_SEABANK';
  const bankEl = document.getElementById('guestBank');
  const bank = channel === 'QRIS_SEABANK' ? 'SEABANK' : (bankEl ? bankEl.value : 'SEABANK');
  const isAnon = Boolean((document.getElementById('guestAnonCheck') || {}).checked);
  const consent = Boolean((document.getElementById('guestConsentCheck') || {}).checked);

  if (!consent) {
    alert('Mohon centang persetujuan pemrosesan data pribadi (UU No. 27/2022) terlebih dahulu.');
    return;
  }

  const btn = document.getElementById('btnGuestSubmitIntent');
  if (btn) {
    btn.disabled = true;
    btn.innerText = 'Membuat QRIS Dinamis...';
  }

  const requestPayload = {
    donor_name: donorName.trim(),
    donor_email: donorEmail.trim(),
    amount: amount,
    program_id: programId,
    payment_channel: channel,
    bank: channel === 'MIDTRANS_SNAP' ? 'MIDTRANS' : bank,
    is_anonymous: isAnon,
    consent: true
  };
  const pendingReq = getOrCreatePendingGuestRequest_(buildGuestFormFingerprint_(requestPayload));

  try {
    const res = await API.post('create_guest_intent', {
      ...requestPayload,
      client_request_id: pendingReq.client_request_id,
      idempotency_proof: pendingReq.idempotency_proof
    });

    if (res && res.status === 'ok') {
      if (res.access_token) {
        saveGuestSession({
          intent_id: res.intent_id,
          ref_code: res.ref_code,
          access_token: res.access_token,
          access_token_expires_at: res.access_token_expires_at || ''
        });
        clearPendingGuestRequest_();
      }
      renderGuestPaymentInstruction(res);
      if (res.access_token) {
        startGuestIntentPolling(res.intent_id, res.access_token, res.expires_at);
      }
    } else {
      alert('Gagal membuat donasi tamu: ' + ((res && res.message) || 'Terjadi kesalahan'));
    }
  } catch (err) {
    alert('Error menghubungi server: ' + err.message);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerText = 'Buat Instruksi Donasi Tamu';
    }
  }
}

/**
 * Dynamically loads Midtrans snap.js for Guest checkout when CONFIG.MIDTRANS_CLIENT_KEY is configured.
 */
function ensureGuestMidtransSnapLoaded_() {
  return new Promise((resolve) => {
    if (typeof window === 'undefined' || typeof document === 'undefined') {
      resolve(false);
      return;
    }
    if (window.snap && typeof window.snap.pay === 'function') {
      resolve(true);
      return;
    }
    const clientKey = (window.CONFIG && window.CONFIG.MIDTRANS_CLIENT_KEY) || '';
    if (!clientKey) {
      resolve(false);
      return;
    }
    const existing = document.getElementById('midtransSnapScript');
    if (existing) {
      existing.addEventListener('load', () => resolve(Boolean(window.snap)));
      existing.addEventListener('error', () => resolve(false));
      return;
    }
    const script = document.createElement('script');
    script.id = 'midtransSnapScript';
    script.src =
      (window.CONFIG && window.CONFIG.MIDTRANS_SNAP_URL) ||
      'https://app.sandbox.midtrans.com/snap/snap.js';
    script.setAttribute('data-client-key', clientKey);
    script.onload = () => resolve(Boolean(window.snap));
    script.onerror = () => resolve(false);
    document.head.appendChild(script);
  });
}

/**
 * Opens Midtrans Snap popup for Guest checkout when snap_token is available.
 */
async function openGuestMidtransSnap(snapToken, redirectUrl) {
  if (!snapToken) return;
  const loaded = await ensureGuestMidtransSnapLoaded_();
  if (loaded && window.snap && typeof window.snap.pay === 'function') {
    window.snap.pay(snapToken, {
      onSuccess: function () {},
      onPending: function () {},
      onError: function (err) {
        console.warn('Guest Midtrans Snap error:', err);
      }
    });
  } else if (redirectUrl) {
    window.open(redirectUrl, '_blank', 'noopener,noreferrer');
  } else {
    alert('Kredensial MIDTRANS_CLIENT_KEY Sandbox belum diaktifkan pada konfigurasi frontend (OPEN-05).');
  }
}

/**
 * Renders payment instructions and private fragment access notice after Guest intent creation.
 */
function renderGuestPaymentInstruction(res) {
  const box = document.getElementById('guestActiveIntentBox');
  if (!box) return;

  const sessionObj = loadGuestSession() || {};
  const token = res.access_token || sessionObj.access_token || '';
  const fragmentLink = token
    ? `${window.location.origin}${window.location.pathname}#ref=${encodeURIComponent(res.ref_code)}&token=${encodeURIComponent(token)}`
    : '';

  let paymentDetailHtml = '';
  if (res.payment_channel === 'MIDTRANS_SNAP') {
    const snapActionHtml = res.snap_token
      ? `<div style="margin-top: 10px;">
           <button type="button" class="btn btn-primary" style="font-size: 12px; padding: 7px 14px;" onclick="openGuestMidtransSnap('${escapeGuestHtml(res.snap_token)}', '${escapeGuestHtml(res.redirect_url || '')}')">
             Bayar Sekarang via Midtrans Snap
           </button>
         </div>`
      : `Integrasi Snap siap digunakan segera setelah kredensial Midtrans Sandbox (OPEN-05) diaktifkan.`;

    paymentDetailHtml = `
      <div style="background: #FFFBEB; border: 1px solid #FDE68A; border-radius: var(--radius-sm); padding: 14px; margin-bottom: 12px;">
        <div style="font-size: 12px; font-weight: 700; color: #92400E; margin-bottom: 4px;">Kanal Midtrans Snap (${escapeGuestHtml(res.order_id || '-')})</div>
        <div style="font-size: 13px; color: #78350F; line-height: 1.5;">
          Nominal Donasi: <strong>${escapeGuestHtml(res.formatted_amount)}</strong> (Biaya Gateway: Rp 0 — Mode Sandbox).<br>
          ${snapActionHtml}
        </div>
      </div>
    `;
  } else if (res.payment_channel === 'QRIS_SEABANK') {
    const qInfo = res.qris || {};
    const baseDisp = res.formatted_base_amount || res.formatted_amount;
    const uniqCode = Number(res.unique_code || qInfo.unique_code || 0);
    const noticeStyle =
      qInfo.qris_mode === 'LIVE_DYNAMIC_QRIS'
        ? 'background: #ECFDF5; border: 1px solid #A7F3D0; color: #065F46;'
        : 'background: #FFFBEB; border: 1px solid #FDE68A; color: #92400E;';

    paymentDetailHtml = `
      <div id="guestQrisPaymentCard" style="background: #FFFFFF; border: 1px solid var(--border-mid); border-radius: var(--radius-sm); padding: 16px; margin-bottom: 12px; text-align: center;">
        <div style="font-size: 11px; color: var(--text-dim); text-transform: uppercase; font-weight: 700;">QRIS Dinamis 1x Pakai &bull; Rekening IKA UPI</div>
        <div id="guestQrContainer" style="display: inline-flex; justify-content: center; padding: 12px; background: #FFFFFF; border: 1px solid var(--border-dim); border-radius: 8px; margin: 12px auto;"></div>
        <div style="font-family: var(--font-mono); font-size: 20px; font-weight: 800; color: var(--crimson-900); margin-bottom: 4px;">
          ${escapeGuestHtml(res.formatted_amount)}
        </div>
        <div style="font-size: 12px; color: var(--text-sub); margin-bottom: 8px;">
          Nominal Donasi: <strong>${escapeGuestHtml(baseDisp)}</strong> + Kode Unik Verifikasi: <strong>Rp ${uniqCode}</strong><br>
          Kode Referensi Tamu: <code>${escapeGuestHtml(res.ref_code)}</code>
        </div>
        <div id="guestQrisExpiryLabel" style="font-size: 12px; font-weight: 700; color: #B45309; margin-bottom: 10px;">
          Berlaku 15 menit (1x pembayaran)
        </div>
        <div style="${noticeStyle} border-radius: var(--radius-sm); padding: 8px 10px; font-size: 11px; text-align: left;">
          ${escapeGuestHtml(qInfo.qris_notice || 'Scan QRIS ini menggunakan aplikasi bank atau e-wallet yang mendukung QRIS.')}
        </div>
      </div>
    `;
  } else {
    const va = res.virtual_account || {};
    paymentDetailHtml = `
      <div style="background: #FFFFFF; border: 1px dashed var(--crimson-700); border-radius: var(--radius-sm); padding: 14px; margin-bottom: 12px;">
        <div style="font-size: 11px; color: var(--text-dim); text-transform: uppercase;">Nomor Virtual Account (${escapeGuestHtml(res.bank)})</div>
        <div style="font-family: var(--font-mono); font-size: 20px; font-weight: 800; color: var(--crimson-900); letter-spacing: 1px; margin: 4px 0;">
          ${escapeGuestHtml(va.va_formatted || va.va_number || '-')}
        </div>
        <div style="font-size: 12px; color: var(--text-sub);">Kode Referensi Tamu: <strong>${escapeGuestHtml(res.ref_code)}</strong></div>
      </div>
      <div id="guestQrContainer" style="display: flex; justify-content: center; padding: 10px; background: #FFFFFF; border: 1px solid var(--border-dim); border-radius: var(--radius-sm); margin-bottom: 12px;"></div>
    `;
  }

  const privateTokenBanner = fragmentLink
    ? `<div style="background: #F8FAFC; border: 1px solid var(--border-mid); border-radius: var(--radius-sm); padding: 12px; margin-top: 10px; font-size: 12px;">
        <strong>Tautan Akses Pribadi Anda (Simpan Baik-Baik):</strong>
        <div style="font-family: var(--font-mono); word-break: break-all; margin-top: 4px; color: var(--text-main);">${escapeGuestHtml(fragmentLink)}</div>
        <div style="color: var(--text-dim); margin-top: 4px;">Token disimpan sementara pada sesi browser ini (sessionStorage) sesuai kebijakan privasi.</div>
       </div>`
    : '';

  box.style.display = 'block';
  box.innerHTML = `
    <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px; margin-bottom: 10px;">
      <div>
        <span class="badge badge-pending">Menunggu Pembayaran (${escapeGuestHtml(res.ref_code)})</span>
        <h4 style="margin-top: 6px; font-family: var(--font-display); color: var(--crimson-900);">
          ${escapeGuestHtml(res.formatted_amount)} &bull; ${escapeGuestHtml(res.program)}
        </h4>
      </div>
      <span id="guestPollingStatusLabel" style="font-size: 12px; color: var(--gold-600); font-weight: 600;">Menunggu konfirmasi...</span>
    </div>
    ${paymentDetailHtml}
    ${privateTokenBanner}
  `;

  if (res.qris && res.qris.qris_payload && typeof QRCode !== 'undefined') {
    const qrEl = document.getElementById('guestQrContainer');
    if (qrEl) {
      qrEl.innerHTML = '';
      new QRCode(qrEl, {
        text: res.qris.qris_payload,
        width: 200,
        height: 200,
        colorDark: '#111827',
        colorLight: '#FFFFFF'
      });
    }
  }
}

/**
 * Closes single-use Guest QRIS card immediately once MATCHED or EXPIRED so it cannot be rescanned.
 */
function lockGuestQrisCard_(state, res, accessToken) {
  if (guestPollingTimer) {
    clearInterval(guestPollingTimer);
    guestPollingTimer = null;
  }
  if (guestCountdownTimer) {
    clearInterval(guestCountdownTimer);
    guestCountdownTimer = null;
  }

  const qrCard = document.getElementById('guestQrisPaymentCard');
  const label = document.getElementById('guestPollingStatusLabel');

  if (state === 'MATCHED') {
    const receiptHref =
      'receipt.html#ref=' +
      encodeURIComponent((res && res.ref_code) || '') +
      '&token=' +
      encodeURIComponent(accessToken || '');
    if (qrCard) {
      qrCard.style.background = '#ECFDF5';
      qrCard.style.borderColor = '#A7F3D0';
      qrCard.innerHTML = `
        <div style="font-size: 12px; font-weight: 700; color: #047857; text-transform: uppercase;">QRIS 1x Pakai Ditutup &bull; Terverifikasi Lunas</div>
        <div style="font-size: 16px; font-weight: 800; color: #065F46; margin: 6px 0;">
          Terima kasih! Donasi ${escapeGuestHtml((res && res.formatted_amount) || '')} telah masuk.
        </div>
        <div style="margin-top: 10px;">
          <a href="${escapeGuestHtml(receiptHref)}" class="btn btn-primary" style="font-size: 12px; padding: 7px 14px; text-decoration: none;">
            Lihat &amp; Cetak Kuitansi Resmi (${escapeGuestHtml((res && (res.receipt_no || res.tx_id)) || 'MATCHED')})
          </a>
        </div>
      `;
    }
    if (label) {
      label.style.color = '#047857';
      label.innerHTML = 'Terverifikasi Lunas! QRIS telah dinonaktifkan.';
    }
    return;
  }

  if (qrCard) {
    qrCard.style.background = '#FEF2F2';
    qrCard.style.borderColor = '#FECACA';
    qrCard.innerHTML = `
      <div style="font-size: 13px; font-weight: 700; color: #991B1B;">QRIS Kedaluwarsa (Waktu Habis)</div>
      <div style="font-size: 12px; color: #7F1D1D; margin-top: 4px;">
        QRIS hanya berlaku 1 kali pembayaran sebelum kedaluwarsa. Jangan scan QR ini lagi; klik tombol donasi kembali untuk menerbitkan QRIS baru.
      </div>
    `;
  }
  if (label) {
    label.style.color = '#DC2626';
    label.innerHTML = 'Kedaluwarsa';
  }
}

/**
 * Polls intent confirmation status using POST body access_token and enforces single-use countdown lock.
 */
function startGuestIntentPolling(intentId, accessToken, expiresAtIso) {
  if (guestPollingTimer) clearInterval(guestPollingTimer);
  if (guestCountdownTimer) clearInterval(guestCountdownTimer);

  const expiryMs = expiresAtIso ? new Date(expiresAtIso).getTime() : Date.now() + 15 * 60 * 1000;
  guestCountdownTimer = setInterval(() => {
    const expLabel = document.getElementById('guestQrisExpiryLabel');
    const remSec = Math.max(0, Math.floor((expiryMs - Date.now()) / 1000));
    if (expLabel) {
      const mm = String(Math.floor(remSec / 60)).padStart(2, '0');
      const ss = String(remSec % 60).padStart(2, '0');
      expLabel.innerText = `Sisa waktu pembayaran 1x pakai: ${mm}:${ss}`;
    }
    if (remSec <= 0) {
      lockGuestQrisCard_('EXPIRED', null, accessToken);
    }
  }, 1000);

  let attempts = 0;
  guestPollingTimer = setInterval(async () => {
    attempts++;
    if (attempts > 180) {
      clearInterval(guestPollingTimer);
      guestPollingTimer = null;
      return;
    }
    try {
      const res = await API.post('check_intent', {
        intent_id: intentId,
        access_token: accessToken
      });
      if (res && res.status === 'ok' && res.intent_status === 'MATCHED') {
        lockGuestQrisCard_('MATCHED', res, accessToken);
      } else if (res && res.status === 'ok' && res.intent_status === 'EXPIRED') {
        lockGuestQrisCard_('EXPIRED', res, accessToken);
      }
    } catch (ignorePollErr) {
      // Silently wait for next polling cycle
    }
  }, 5000);
}

/**
 * Handles secure Guest transaction lookup via POST body { ref_code, access_token }.
 */
async function handleGuestLookupSubmit(e) {
  if (e && e.preventDefault) e.preventDefault();
  const refInput = document.getElementById('lookupGuestRef');
  const tokInput = document.getElementById('lookupGuestToken');
  const outBox = document.getElementById('guestLookupResult');
  if (!refInput || !tokInput || !outBox) return;

  const refCode = refInput.value.trim().toUpperCase();
  const accessToken = tokInput.value.trim();

  try {
    const res = await API.post('guest_lookup', {
      ref_code: refCode,
      access_token: accessToken
    });

    if (res && res.status === 'ok') {
      const canOpenReceipt = res.intent_status === 'MATCHED' && Boolean(res.receipt_no);
      const receiptBtnHtml = canOpenReceipt
        ? `<div style="margin-top: 10px;">
             <a href="receipt.html#ref=${encodeURIComponent(res.ref_code)}&token=${encodeURIComponent(accessToken)}" class="btn btn-primary" style="font-size: 12px; padding: 6px 12px; text-decoration: none; display: inline-block;">
               Buka &amp; Cetak Kuitansi Resmi (${escapeGuestHtml(res.receipt_no)})
             </a>
           </div>`
        : '';

      outBox.style.display = 'block';
      outBox.innerHTML = `
        <div style="background: #F8FAFC; border: 1px solid var(--border-mid); border-radius: var(--radius-sm); padding: 14px; font-size: 13px;">
          <div><strong>Kode Referensi:</strong> ${escapeGuestHtml(res.ref_code)}</div>
          <div><strong>Status Intent:</strong> <span class="badge badge-neutral">${escapeGuestHtml(res.intent_status)}</span></div>
          <div><strong>Program:</strong> ${escapeGuestHtml(res.program)}</div>
          <div><strong>Nominal:</strong> ${escapeGuestHtml(res.formatted_amount)}</div>
          <div><strong>Kanal:</strong> ${escapeGuestHtml(res.payment_channel)} (${escapeGuestHtml(res.bank)})</div>
          <div><strong>No. Kuitansi:</strong> ${escapeGuestHtml(res.receipt_no || 'Belum terbit (menunggu konfirmasi)')}</div>
          ${receiptBtnHtml}
        </div>
      `;
    } else {
      outBox.style.display = 'block';
      outBox.innerHTML = `<div style="color: #DC2626; font-size: 13px;">${escapeGuestHtml((res && res.message) || 'Data tidak ditemukan.')}</div>`;
    }
  } catch (err) {
    outBox.style.display = 'block';
    outBox.innerHTML = `<div style="color: #DC2626; font-size: 13px;">Error: ${escapeGuestHtml(err.message)}</div>`;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  loadGuestActivePrograms();

  const frag = parseGuestFragmentParams();
  if (frag) {
    saveGuestSession(frag);
    const refInput = document.getElementById('lookupGuestRef');
    const tokInput = document.getElementById('lookupGuestToken');
    if (refInput) refInput.value = frag.ref_code;
    if (tokInput) tokInput.value = frag.access_token;
    handleGuestLookupSubmit();
  } else {
    const existing = loadGuestSession();
    if (existing && existing.ref_code && existing.access_token) {
      const refInput = document.getElementById('lookupGuestRef');
      const tokInput = document.getElementById('lookupGuestToken');
      if (refInput) refInput.value = existing.ref_code;
      if (tokInput) tokInput.value = existing.access_token;
    }
  }
});
