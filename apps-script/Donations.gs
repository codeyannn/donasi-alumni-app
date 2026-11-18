/**
 * Donations.gs
 * Intent creation for verified Alumni and accountless Guest donors, header-aware v1/v2 persistence,
 * secure 256-bit Guest status lookup, idempotency protection, and payment simulation guards.
 */

var GUEST_REQUIRED_V2_COLUMNS = [
  'is_anonymous',
  'payment_channel',
  'donor_type',
  'donor_name',
  'donor_email',
  'program_id',
  'access_token_hash',
  'access_token_expires_at'
];

/**
 * Computes the next candidate sequential Guest number without mutating counters yet.
 * Scans counters.GUEST, legacy users.ref_code, and donation_intents.ref_code to prevent collisions.
 */
function computeNextGuestSeqCandidate_(ss) {
  let maxSeq = 0;
  const scanSheet = function (sheetName) {
    const s = ss.getSheetByName(sheetName);
    if (!s || s.getLastRow() <= 1) return;
    const hMap = getHeaderMap_(s);
    if (hMap.ref_code === undefined) return;
    const rows = s.getDataRange().getValues();
    for (let i = 1; i < rows.length; i++) {
      const m = String(rows[i][hMap.ref_code] || '').trim().toUpperCase().match(/^G(\d{6})$/);
      if (m) {
        const val = parseInt(m[1], 10);
        if (!isNaN(val) && val > maxSeq) maxSeq = val;
      }
    }
  };

  scanSheet(SHEET_NAMES.USERS);
  scanSheet(SHEET_NAMES.INTENTS);

  const ctrSheet = ss.getSheetByName(SHEET_NAMES.COUNTERS);
  const lastRow = ctrSheet ? ctrSheet.getLastRow() : 0;
  for (let i = 2; i <= lastRow; i++) {
    const name = String(ctrSheet.getRange(i, 1).getValue()).trim().toUpperCase();
    if (name === 'GUEST') {
      const cur = parseInt(ctrSheet.getRange(i, 2).getValue(), 10) || 0;
      return Math.max(cur, maxSeq) + 1;
    }
  }

  return maxSeq + 1;
}

/**
 * Advances counters.GUEST strictly forward after a donation_intents row has been persisted.
 */
function commitGuestCounterSequence_(ss, targetSeq) {
  const ctrSheet = ss.getSheetByName(SHEET_NAMES.COUNTERS);
  if (!ctrSheet) return;
  const lastRow = ctrSheet.getLastRow();
  for (let i = 2; i <= lastRow; i++) {
    const name = String(ctrSheet.getRange(i, 1).getValue()).trim().toUpperCase();
    if (name === 'GUEST') {
      const cur = parseInt(ctrSheet.getRange(i, 2).getValue(), 10) || 0;
      if (targetSeq > cur) {
        ctrSheet.getRange(i, 2).setValue(targetSeq);
      }
      return;
    }
  }
  ctrSheet.appendRow(['GUEST', targetSeq]);
}

/**
 * Computes and commits next sequential Guest reference number inside ScriptLock.
 */
function getNextGuestRefSequenceSafe_(ss) {
  const next = computeNextGuestSeqCandidate_(ss);
  commitGuestCounterSequence_(ss, next);
  return next;
}

/**
 * Appends a donation_intents row using header names so both 10-col v1 and 21-col v2 sheets
 * populate exact column positions without overwriting existing headers or cells.
 */
function appendIntentRowByHeader_(intentSheet, fieldValues) {
  const hMap = getHeaderMap_(intentSheet);
  const width = Math.max(
    10,
    typeof intentSheet.getLastColumn === 'function' ? intentSheet.getLastColumn() : 10
  );
  const row = new Array(width).fill('');
  const keys = Object.keys(fieldValues);

  for (let i = 0; i < keys.length; i++) {
    const colName = keys[i];
    if (hMap[colName] !== undefined) {
      row[hMap[colName]] = fieldValues[colName];
    }
  }

  intentSheet.appendRow(row);

  // Use legacy anonymity bridge property only when pre-P2.2 10-col sheet lacks column is_anonymous
  if (hMap.is_anonymous === undefined && fieldValues.intent_id && fieldValues.is_anonymous) {
    try {
      PropertiesService.getScriptProperties().setProperty(
        'INTENT_ANON_' + fieldValues.intent_id,
        fieldValues.is_anonymous
      );
    } catch (propErr) {
      Logger.log('Could not persist intent anon bridge: ' + propErr.message);
    }
  }
}

/**
 * Builds consistent payment instructions response for MANUAL_TRANSFER vs prepared MIDTRANS_SNAP.
 * Keeps gateway_fee = 0 per OPEN-03 and preserves donor nominal amount unchanged.
 */
function buildPaymentInstructionPayload_(params) {
  const channel = params.payment_channel;
  const amount = params.amount;
  const baseOut = {
    status: 'ok',
    intent_id: params.intent_id,
    ref_code: params.ref_code,
    donor_type: params.donor_type,
    payment_channel: channel,
    bank: params.bank,
    amount: amount,
    gross_amount: amount,
    gateway_fee: 0,
    net_amount: amount,
    program: params.program_name,
    program_id: params.program_id,
    is_anonymous: params.is_anonymous === 'YES',
    formatted_amount: formatRupiah(amount),
    expires_at: params.expires_at
  };

  if (channel === 'MIDTRANS_SNAP') {
    baseOut.order_id = params.midtrans_order_id;
    baseOut.snap_token = params.snap_token || '';
    baseOut.redirect_url = params.redirect_url || '';
    baseOut.payment_mode =
      params.payment_mode || (params.snap_token ? 'MIDTRANS_SANDBOX_ACTIVE' : 'MIDTRANS_SANDBOX_PREPARED');
    baseOut.sandbox_notice = 'Mode Sandbox — biaya gateway belum terkonfirmasi (gateway_fee = 0).';
    return baseOut;
  }

  // Generate 12-digit Bank Virtual Account and dynamic QRIS payload for manual reconciliation
  const vaInfo = generateVirtualAccount(params.bank, params.ref_code);
  const qrisString =
    `00020101021226670016ID.GO.BI.QRIS011893600999000000010215${vaInfo.va_number}` +
    `52048398530336054${String(amount).padStart(2, '0')}5802ID5923BEASISWA IKATAN ALUMNI` +
    `6007BANDUNG62170113${params.intent_id}6304ABCD`;

  baseOut.virtual_account = {
    bank: params.bank,
    bank_prefix: vaInfo.bank_prefix,
    va_number: vaInfo.va_number,
    va_formatted: vaInfo.va_formatted,
    account_name: 'BEASISWA IKA UPI - ' + String(params.donor_label || 'DONATUR').toUpperCase()
  };
  baseOut.qris = {
    merchant_name: 'BEASISWA IKA UPI',
    qris_payload: qrisString,
    amount: amount
  };
  baseOut.transfer_instruction = {
    target_bank: params.bank,
    amount: amount,
    transfer_note: params.ref_code,
    note_instruction: 'PENTING: Salin nomor Virtual Account di atas atau scan QRIS melalui m-banking/e-wallet Anda.'
  };
  return baseOut;
}

/**
 * Checks optional client_request_id in ScriptCache inside LockService to deduplicate double-submits.
 */
function checkIntentIdempotencyCache_(scopeKey, clientRequestId) {
  const reqId = String(clientRequestId || '').trim();
  if (!reqId) return null;
  const cache = CacheService.getScriptCache();
  if (!cache) return null;
  const digest = bytesToHex_(
    Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, scopeKey + '::' + reqId)
  );
  const raw = cache.get('idem_intent_' + digest);
  return { cacheKey: 'idem_intent_' + digest, cached: raw ? JSON.parse(raw) : null };
}

/**
 * Creates a donation intent for an authenticated & approved Alumni (or legacy admin/guest account).
 * Enforces APPROVED status for ALUMNI, validates active program & amount server-side.
 *
 * @param {string} idToken - Verified Google ID token from POST JSON body.
 * @param {Object} data - { amount, bank, program_id?, program?, payment_channel?, is_anonymous?, client_request_id? }.
 * @returns {Object} Created intent details and payment instructions.
 */
function createDonationIntent(idToken, data) {
  const user = requireUser_(idToken);
  const userRole = String(user.role || '').toUpperCase();
  const input = data || {};

  // Strictly block unverified, pending, revision, or rejected Alumni from creating donations
  if (userRole === 'ALUMNI') {
    const verifStatus = normalizeVerificationStatus(user.verification_status);
    if (!isApprovedVerificationStatus(verifStatus) || !/^A\d{6}$/.test(String(user.ref_code || '').trim())) {
      throw new Error(
        'Forbidden: Akun Alumni belum disetujui (status: ' + verifStatus + '). Selesaikan verifikasi sebelum berdonasi.'
      );
    }
  }

  const maxAmount = parseFloat(getSecureConfig_('MAX_DONATION_AMOUNT', true)) || 100000000;
  const amtCheck = validateDonationAmount(input.amount, maxAmount);
  if (!amtCheck.ok) {
    throw new Error(amtCheck.error);
  }
  const amount = amtCheck.amount;

  const channel = String(input.payment_channel || 'MANUAL_TRANSFER').trim().toUpperCase();
  if (SUPPORTED_PAYMENT_CHANNELS.indexOf(channel) === -1) {
    throw new Error('Kanal pembayaran tidak valid. Pilihan: ' + SUPPORTED_PAYMENT_CHANNELS.join(', '));
  }

  let bank = String(input.bank || '').toUpperCase().trim();
  if (channel === 'MANUAL_TRANSFER') {
    if (SUPPORTED_BANKS.indexOf(bank) === -1) {
      throw new Error('Bank tidak didukung. Pilihan: ' + SUPPORTED_BANKS.join(', '));
    }
  } else {
    bank = bank || 'MIDTRANS';
  }

  // Validate selected program against authoritative backend program catalog
  const resolvedProgram = resolveProgramForDonation_(input.program_id, input.program);
  const isAnon = input.is_anonymous === true || String(input.is_anonymous).toUpperCase() === 'YES' ? 'YES' : 'NO';

  const lock = LockService.getScriptLock();
  lock.waitLock(15000);

  try {
    const idem = checkIntentIdempotencyCache_(user.user_id, input.client_request_id);
    if (idem && idem.cached) {
      return Object.assign({ deduplicated: true }, idem.cached);
    }

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const intentSheet = ss.getSheetByName(SHEET_NAMES.INTENTS);
    if (!intentSheet) {
      throw new Error("Required sheet 'donation_intents' is missing.");
    }

    let refCode = String(user.ref_code || '').trim();
    if (!refCode) {
      // Legacy fallback only for pre-P4 historical records lacking ref_code
      const seq = getNextGuestRefSequenceSafe_(ss);
      refCode = formatRefCode('G', seq);
      updateUserVerificationStatus_(user.user_id, normalizeVerificationStatus(user.verification_status), refCode);
    }

    const now = new Date();
    const windowHours = parseInt(getConfig_('MATCH_WINDOW_HOURS') || '24', 10) || 24;
    const expiresAt = new Date(now.getTime() + windowHours * 60 * 60 * 1000);
    const intentId = 'INT_' + Utilities.getUuid().substring(0, 8);
    const orderId = channel === 'MIDTRANS_SNAP' ? formatMidtransOrderId(refCode, intentId) : '';
    const donorType = userRole === 'GUEST' ? 'GUEST' : 'ALUMNI';

    let snapResult = { snap_token: '', redirect_url: '', payment_mode: 'MIDTRANS_SANDBOX_PREPARED' };
    if (channel === 'MIDTRANS_SNAP' && typeof createMidtransSnapTransaction_ === 'function') {
      snapResult = createMidtransSnapTransaction_({
        order_id: orderId,
        amount: amount,
        program_id: resolvedProgram.program_id,
        program_name: resolvedProgram.name,
        donor_name: user.full_name,
        donor_email: user.email,
        is_anonymous: isAnon,
        ref_code: refCode,
        window_hours: windowHours
      });
    }

    appendIntentRowByHeader_(intentSheet, {
      intent_id: intentId,
      user_id: user.user_id,
      ref_code: refCode,
      amount: amount,
      bank: bank,
      program: resolvedProgram.name,
      status: 'PENDING',
      created_at: now.toISOString(),
      expires_at: expiresAt.toISOString(),
      matched_tx_id: '',
      is_anonymous: isAnon,
      payment_channel: channel,
      donor_type: donorType,
      donor_name: user.full_name,
      donor_email: user.email,
      program_id: resolvedProgram.program_id,
      midtrans_order_id: orderId,
      snap_token: snapResult.snap_token || ''
    });

    logAudit_(
      user.email,
      'CREATE_INTENT',
      intentId,
      channel + ' ' + bank + ' ' + amount + ' prog=' + resolvedProgram.program_id
    );

    const responsePayload = buildPaymentInstructionPayload_({
      intent_id: intentId,
      ref_code: refCode,
      donor_type: donorType,
      donor_label: user.full_name,
      payment_channel: channel,
      bank: bank,
      amount: amount,
      program_name: resolvedProgram.name,
      program_id: resolvedProgram.program_id,
      is_anonymous: isAnon,
      expires_at: expiresAt.toISOString(),
      midtrans_order_id: orderId,
      snap_token: snapResult.snap_token || '',
      redirect_url: snapResult.redirect_url || '',
      payment_mode: snapResult.payment_mode
    });

    if (idem && CacheService.getScriptCache()) {
      CacheService.getScriptCache().put(idem.cacheKey, JSON.stringify(responsePayload), 120);
    }

    return responsePayload;
  } finally {
    lock.releaseLock();
  }
}

var GUEST_IDEMPOTENCY_TTL_MS = 15 * 60 * 1000;

/**
 * Computes storage key for a guest idempotency request using an unguessable SHA-256 digest
 * of client_request_id without storing PII or raw tokens.
 */
function buildGuestIdempotencyStorageKey_(clientRequestId) {
  const reqId = String(clientRequestId || '').trim();
  if (!reqId) return '';
  const digest = bytesToHex_(
    Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, 'guest_idem::' + reqId)
  ).substring(0, 24);
  return 'IDEM_G_' + digest;
}

/**
 * Reads an unexpired Guest idempotency record from ScriptCache or ScriptProperties fallback.
 */
function loadGuestIdempotencyRecord_(clientRequestId) {
  const key = buildGuestIdempotencyStorageKey_(clientRequestId);
  if (!key) return null;

  let raw = null;
  try {
    const cache = CacheService.getScriptCache();
    raw = cache ? cache.get(key) : null;
  } catch (ignoreCacheErr) {
    raw = null;
  }

  if (!raw) {
    try {
      const props = PropertiesService.getScriptProperties();
      raw = props ? props.getProperty(key) : null;
    } catch (ignorePropErr) {
      raw = null;
    }
  }

  if (!raw) return null;
  const parsed = JSON.parse(raw);
  if (!parsed || (parsed.exp_ms && Date.now() > parsed.exp_ms)) {
    try {
      const props = PropertiesService.getScriptProperties();
      if (props) props.deleteProperty(key);
    } catch (ignoreDelErr) {}
    return null;
  }
  return parsed;
}

/**
 * Saves non-secret Guest idempotency metadata (hashes & IDs ONLY; never raw tokens or PII)
 * immediately after the intent row is appended to Sheets.
 */
function saveGuestIdempotencyRecord_(clientRequestId, record) {
  const key = buildGuestIdempotencyStorageKey_(clientRequestId);
  if (!key) return;
  const serialized = JSON.stringify(record);

  try {
    const cache = CacheService.getScriptCache();
    if (cache) cache.put(key, serialized, 900);
  } catch (ignoreCacheWrite) {}

  try {
    const props = PropertiesService.getScriptProperties();
    if (props) props.setProperty(key, serialized);
  } catch (ignorePropWrite) {}
}

/**
 * Rotates the access token for an existing Guest donation intent (and linked transaction if settled).
 * Caller MUST already hold ScriptLock and have completed authorization checks.
 * Immediately invalidates the previous token by replacing access_token_hash before returning the new token.
 */
function rotateGuestAccessTokenOnRow_(ss, intentSheet, rowIdx1, hMap, rowsMatrix, reasonTag) {
  const row = rowsMatrix[rowIdx1 - 1];
  const intentStatus = String(row[hMap.status] || '').trim().toUpperCase();
  if (intentStatus === 'EXPIRED' || intentStatus === 'CANCELLED' || intentStatus === 'FAILED') {
    throw new Error('Forbidden: Token tidak dapat dipulihkan atau dirotasi untuk intent berstatus ' + intentStatus + '.');
  }

  const intentId = String(row[hMap.intent_id] || '').trim();
  const refCode = String(row[hMap.ref_code] || '').trim();
  const newRawToken = generateGuestAccessToken_();
  const newTokenHash = hashAccessToken_(newRawToken);
  const ttlDays = parseInt(getSecureConfig_('GUEST_RECEIPT_TTL_DAYS', true) || '30', 10) || 30;
  const newTokenExpiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000).toISOString();

  // Persist new hash & expiry to donation_intents FIRST so previous token is immediately revoked
  intentSheet.getRange(rowIdx1, hMap.access_token_hash + 1).setValue(newTokenHash);
  intentSheet.getRange(rowIdx1, hMap.access_token_expires_at + 1).setValue(newTokenExpiresAt);

  // Sync linked confirmed transaction's access_token_hash when v2 receipt columns exist
  const matchedTxId = hMap.matched_tx_id !== undefined ? String(row[hMap.matched_tx_id] || '').trim() : '';
  if (matchedTxId) {
    const txSheet = ss.getSheetByName(SHEET_NAMES.TRANSACTIONS);
    if (txSheet && txSheet.getLastRow() > 1) {
      const tMap = getHeaderMap_(txSheet);
      if (tMap.access_token_hash !== undefined) {
        const txRows = txSheet.getDataRange().getValues();
        for (let t = 1; t < txRows.length; t++) {
          if (String(txRows[t][tMap.tx_id] || '').trim() === matchedTxId) {
            txSheet.getRange(t + 1, tMap.access_token_hash + 1).setValue(newTokenHash);
            if (tMap.access_token_expires_at !== undefined) {
              txSheet.getRange(t + 1, tMap.access_token_expires_at + 1).setValue(newTokenExpiresAt);
            }
            break;
          }
        }
      }
    }
  }

  logAudit_(
    'GUEST_TOKEN_MANAGER',
    'ROTATE_GUEST_TOKEN',
    intentId,
    'ref=' + refCode + ' reason=' + String(reasonTag || 'ROTATION')
  );

  return {
    intent_id: intentId,
    ref_code: refCode,
    donor_type: 'GUEST',
    donor_name: hMap.donor_name !== undefined ? String(row[hMap.donor_name] || '') : '',
    donor_email: hMap.donor_email !== undefined ? String(row[hMap.donor_email] || '') : '',
    payment_channel: hMap.payment_channel !== undefined ? String(row[hMap.payment_channel] || 'MANUAL_TRANSFER') : 'MANUAL_TRANSFER',
    bank: String(row[hMap.bank] || ''),
    amount: Number(row[hMap.amount]) || 0,
    program: String(row[hMap.program] || ''),
    program_id: hMap.program_id !== undefined ? String(row[hMap.program_id] || '') : '',
    is_anonymous: hMap.is_anonymous !== undefined ? String(row[hMap.is_anonymous] || 'NO') : 'NO',
    expires_at: String(row[hMap.expires_at] || ''),
    midtrans_order_id: hMap.midtrans_order_id !== undefined ? String(row[hMap.midtrans_order_id] || '') : '',
    snap_token: hMap.snap_token !== undefined ? String(row[hMap.snap_token] || '') : '',
    new_access_token: newRawToken,
    new_access_token_expires_at: newTokenExpiresAt
  };
}

/**
 * Creates a donation intent for an unauthenticated Guest without creating any record in 'users'.
 * Enforces payload-bound idempotency and proof-of-possession token rotation recovery when HTTP
 * responses are lost, while blocking unverified retries or mismatched payloads under the same request ID.
 *
 * @param {Object} data - Guest checkout payload + optional { client_request_id, idempotency_proof }.
 * @returns {Object} Intent instructions plus raw 256-bit access_token.
 */
function createGuestDonationIntent(data) {
  const maxAmount = parseFloat(getSecureConfig_('MAX_DONATION_AMOUNT', true)) || 100000000;
  const inputCheck = validateGuestDonorInput(data, maxAmount);
  if (!inputCheck.ok) {
    throw new Error(inputCheck.error);
  }
  const clean = inputCheck.value;
  const resolvedProgram = resolveProgramForDonation_(data && data.program_id, data && data.program);

  const clientReqId = data && data.client_request_id ? String(data.client_request_id).trim() : '';
  if (clientReqId && !/^[A-Za-z0-9_\-]{16,128}$/.test(clientReqId)) {
    throw new Error('Format client_request_id tidak valid (minimal 16 karakter alfanumerik/UUID).');
  }

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const intentSheet = ss.getSheetByName(SHEET_NAMES.INTENTS);
  if (!intentSheet) {
    throw new Error("Required sheet 'donation_intents' is missing.");
  }

  // Explicitly require v2 Guest columns so token hash & donor metadata are never silently dropped on v1 sheets
  const hMap = getHeaderMap_(intentSheet);
  const missingCols = GUEST_REQUIRED_V2_COLUMNS.filter(function (c) {
    return hMap[c] === undefined;
  });
  if (missingCols.length > 0) {
    throw new Error(
      "Schema dependency error: Kolom P2.2 ('" + missingCols.join("', '") +
      "') belum tersedia pada sheet 'donation_intents'. Jalankan migrasi P2.2 sebelum mengaktifkan checkout Guest tanpa akun."
    );
  }

  const payloadHash = computeGuestPayloadHash_(clean, resolvedProgram.program_id);
  const rawProof = data && data.idempotency_proof ? String(data.idempotency_proof).trim() : '';

  const lock = LockService.getScriptLock();
  lock.waitLock(15000);

  try {
    // Step 1: Check existing idempotency record BEFORE burning new-creation email rate limit or counter
    if (clientReqId) {
      const existingIdem = loadGuestIdempotencyRecord_(clientReqId);
      if (existingIdem) {
        // Strict payload binding: same client_request_id with altered payload MUST be rejected (409)
        if (!constantTimeEqual_(payloadHash, existingIdem.payload_hash)) {
          throw new Error(
            '409 Conflict: Idempotency conflict — client_request_id sudah digunakan untuk payload donasi yang berbeda.'
          );
        }

        // Prevent hijacking by requiring proof-of-possession secret generated by originating browser tab
        if (!existingIdem.proof_hash || !rawProof) {
          enforceGuestTokenRateLimit_('idem_' + clientReqId, true);
          throw new Error(
            'Forbidden: Idempotency recovery ditolak. Bukti permintaan (idempotency_proof) wajib disertakan.'
          );
        }

        const candidateProofHash = computeIdempotencyProofHash_(clientReqId, rawProof);
        if (!constantTimeEqual_(candidateProofHash, existingIdem.proof_hash)) {
          enforceGuestTokenRateLimit_('idem_' + clientReqId, true);
          logAudit_(
            'GUEST_TOKEN_GATE',
            'BLOCKED_IDEMPOTENCY_HIJACK',
            existingIdem.intent_id,
            'Rejected mismatched idempotency_proof on retry.'
          );
          throw new Error('Forbidden: Bukti permintaan (idempotency_proof) tidak valid.');
        }

        // Proof verified: locate existing row and ROTATE token immediately so old lost token cannot persist
        const allRows = intentSheet.getDataRange().getValues();
        let targetRowIdx = -1;
        for (let r = 1; r < allRows.length; r++) {
          if (String(allRows[r][hMap.intent_id] || '').trim() === existingIdem.intent_id) {
            targetRowIdx = r + 1;
            break;
          }
        }
        if (targetRowIdx === -1) {
          throw new Error('Intent terkait idempotency tidak ditemukan di database.');
        }

        const rotated = rotateGuestAccessTokenOnRow_(
          ss,
          intentSheet,
          targetRowIdx,
          hMap,
          allRows,
          'IDEMPOTENCY_RETRY_RECOVERY'
        );

        const recoveredPayload = buildPaymentInstructionPayload_({
          intent_id: rotated.intent_id,
          ref_code: rotated.ref_code,
          donor_type: 'GUEST',
          donor_label: rotated.is_anonymous === 'YES' ? 'DONATUR ANONIM' : rotated.donor_name,
          payment_channel: rotated.payment_channel,
          bank: rotated.bank,
          amount: rotated.amount,
          program_name: rotated.program,
          program_id: rotated.program_id,
          is_anonymous: rotated.is_anonymous,
          expires_at: rotated.expires_at,
          midtrans_order_id: rotated.midtrans_order_id,
          snap_token: rotated.snap_token || ''
        });

        return Object.assign({}, recoveredPayload, {
          deduplicated: true,
          recovered: true,
          token_rotated: true,
          access_token: rotated.new_access_token,
          access_token_expires_at: rotated.new_access_token_expires_at
        });
      }
    }

    // Step 2: Rate limit applies only to brand-new Guest intent creations
    const cache = CacheService.getScriptCache();
    if (cache) {
      const emailDigest = bytesToHex_(
        Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, clean.donor_email)
      ).substring(0, 16);
      const rateKey = 'guest_rl_' + emailDigest;
      const count = parseInt(cache.get(rateKey) || '0', 10) || 0;
      if (count >= 5) {
        throw new Error('Too Many Requests: Batas pembuatan donasi tamu untuk email ini tercapai. Coba beberapa saat lagi.');
      }
      cache.put(rateKey, String(count + 1), 900);
    }

    // Step 3: Allocate candidate sequence and generate credentials BEFORE writing any row
    const candidateSeq = computeNextGuestSeqCandidate_(ss);
    const refCode = formatRefCode('G', candidateSeq);
    const intentId = 'INT_' + Utilities.getUuid().substring(0, 8);
    const rawAccessToken = generateGuestAccessToken_();
    const tokenHash = hashAccessToken_(rawAccessToken);
    const proofHash = clientReqId && rawProof ? computeIdempotencyProofHash_(clientReqId, rawProof) : '';

    const now = new Date();
    const windowHours = parseInt(getConfig_('MATCH_WINDOW_HOURS') || '24', 10) || 24;
    const expiresAt = new Date(now.getTime() + windowHours * 60 * 60 * 1000);
    const ttlDays = parseInt(getSecureConfig_('GUEST_RECEIPT_TTL_DAYS', true) || '30', 10) || 30;
    const tokenExpiresAt = new Date(now.getTime() + ttlDays * 24 * 60 * 60 * 1000);
    const orderId = clean.payment_channel === 'MIDTRANS_SNAP' ? formatMidtransOrderId(refCode, intentId) : '';

    let snapResult = { snap_token: '', redirect_url: '', payment_mode: 'MIDTRANS_SANDBOX_PREPARED' };
    if (clean.payment_channel === 'MIDTRANS_SNAP' && typeof createMidtransSnapTransaction_ === 'function') {
      snapResult = createMidtransSnapTransaction_({
        order_id: orderId,
        amount: clean.amount,
        program_id: resolvedProgram.program_id,
        program_name: resolvedProgram.name,
        donor_name: clean.donor_name,
        donor_email: clean.donor_email,
        is_anonymous: clean.is_anonymous,
        ref_code: refCode,
        window_hours: windowHours
      });
    }

    // Write intent row FIRST; if this throws, counters and idempotency records remain untouched
    appendIntentRowByHeader_(intentSheet, {
      intent_id: intentId,
      user_id: '', // Accountless Guest: zero record created in users sheet
      ref_code: refCode,
      amount: clean.amount,
      bank: clean.bank,
      program: resolvedProgram.name,
      status: 'PENDING',
      created_at: now.toISOString(),
      expires_at: expiresAt.toISOString(),
      matched_tx_id: '',
      is_anonymous: clean.is_anonymous,
      payment_channel: clean.payment_channel,
      donor_type: 'GUEST',
      donor_name: clean.donor_name,
      donor_email: clean.donor_email,
      program_id: resolvedProgram.program_id,
      midtrans_order_id: orderId,
      snap_token: snapResult.snap_token || '',
      access_token_hash: tokenHash,
      access_token_expires_at: tokenExpiresAt.toISOString()
    });

    // Save non-secret idempotency record immediately after durable intent append
    if (clientReqId) {
      saveGuestIdempotencyRecord_(clientReqId, {
        intent_id: intentId,
        ref_code: refCode,
        payload_hash: payloadHash,
        proof_hash: proofHash,
        exp_ms: Date.now() + GUEST_IDEMPOTENCY_TTL_MS
      });
    }

    // Advance counter after row & idempotency commit (note: candidate scan also prevents G000xxx collision if counter update fails)
    commitGuestCounterSequence_(ss, candidateSeq);

    // Audit log records metadata only; raw access_token & idempotency_proof must NEVER appear in logs
    logAudit_(
      'GUEST_CHECKOUT',
      'CREATE_GUEST_INTENT',
      intentId,
      'ref=' + refCode + ' channel=' + clean.payment_channel + ' amount=' + clean.amount
    );

    const responsePayload = buildPaymentInstructionPayload_({
      intent_id: intentId,
      ref_code: refCode,
      donor_type: 'GUEST',
      donor_label: clean.is_anonymous === 'YES' ? 'DONATUR ANONIM' : clean.donor_name,
      payment_channel: clean.payment_channel,
      bank: clean.bank,
      amount: clean.amount,
      program_name: resolvedProgram.name,
      program_id: resolvedProgram.program_id,
      is_anonymous: clean.is_anonymous,
      expires_at: expiresAt.toISOString(),
      midtrans_order_id: orderId,
      snap_token: snapResult.snap_token || '',
      redirect_url: snapResult.redirect_url || '',
      payment_mode: snapResult.payment_mode
    });

    return Object.assign({}, responsePayload, {
      access_token: rawAccessToken,
      access_token_expires_at: tokenExpiresAt.toISOString()
    });
  } finally {
    lock.releaseLock();
  }
}

/**
 * Explicitly rotates a Guest access_token inside ScriptLock, revoking the prior token immediately.
 * Authorized callers:
 * 1) Admin (via valid id_token -> rotates & dispatches #fragment link via email without returning raw token); OR
 * 2) Current token owner (via valid current access_token -> rotates & returns new token).
 *
 * @param {Object} data - { intent_id?, ref_code?, access_token?, id_token?, recovery_base_url? }.
 * @returns {Object} Rotation outcome.
 */
function rotateGuestAccessToken(data) {
  const input = data || {};
  const targetIntentId = String(input.intent_id || '').trim();
  const targetRefCode = String(input.ref_code || '').trim().toUpperCase();
  if (!targetIntentId && !targetRefCode) {
    throw new Error('Parameter intent_id atau ref_code wajib diisi untuk rotasi token.');
  }

  let isAdminCaller = false;
  let adminProfile = null;
  if (input.id_token) {
    adminProfile = requireAdmin_(input.id_token);
    isAdminCaller = true;
  } else if (!input.access_token) {
    throw new Error('Authentication required: Sertakan access_token aktif atau id_token Admin.');
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(15000);

  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const intentSheet = ss.getSheetByName(SHEET_NAMES.INTENTS);
    if (!intentSheet || intentSheet.getLastRow() <= 1) {
      throw new Error('Data donation intent tidak ditemukan.');
    }

    const hMap = getHeaderMap_(intentSheet);
    if (hMap.access_token_hash === undefined || hMap.access_token_expires_at === undefined) {
      throw new Error("Schema dependency error: Kolom 'access_token_hash' belum tersedia sebelum P2.2.");
    }

    const rows = intentSheet.getDataRange().getValues();
    let rowIdx1 = -1;
    for (let i = rows.length - 1; i >= 1; i--) {
      const rId = String(rows[i][hMap.intent_id] || '').trim();
      const rRef = String(rows[i][hMap.ref_code] || '').trim().toUpperCase();
      const dType = hMap.donor_type !== undefined ? String(rows[i][hMap.donor_type] || '').trim().toUpperCase() : '';
      if (dType && dType !== 'GUEST') continue;
      if ((targetIntentId && rId === targetIntentId) || (!targetIntentId && targetRefCode && rRef === targetRefCode)) {
        rowIdx1 = i + 1;
        break;
      }
    }

    if (rowIdx1 === -1) {
      throw new Error('Intent donasi Tamu tidak ditemukan.');
    }

    const targetRow = rows[rowIdx1 - 1];
    if (!isAdminCaller) {
      const scope = 'rot_' + (targetIntentId || targetRefCode);
      verifyGuestAccessToken_(
        input.access_token,
        targetRow[hMap.access_token_hash],
        targetRow[hMap.access_token_expires_at],
        scope
      );
    }

    const rotated = rotateGuestAccessTokenOnRow_(
      ss,
      intentSheet,
      rowIdx1,
      hMap,
      rows,
      isAdminCaller ? 'ADMIN_ASSISTED_RECOVERY:' + adminProfile.email : 'GUEST_SELF_ROTATION'
    );

    if (isAdminCaller) {
      const baseUrl = String(input.recovery_base_url || 'https://beasiswa-alumni-upi.netlify.app/').replace(/#.*$/, '').replace(/\?.*$/, '');
      const fragmentUrl =
        baseUrl +
        '#ref=' +
        encodeURIComponent(rotated.ref_code) +
        '&token=' +
        encodeURIComponent(rotated.new_access_token);
      let emailRes = { sent: false, error: 'Email donatur kosong.' };
      if (rotated.donor_email && typeof sendGuestAccessRecoveryEmail_ === 'function') {
        emailRes = sendGuestAccessRecoveryEmail_(
          rotated.donor_email,
          rotated.donor_name,
          rotated.ref_code,
          fragmentUrl
        );
      }
      return {
        status: 'ok',
        intent_id: rotated.intent_id,
        ref_code: rotated.ref_code,
        token_rotated: true,
        email_dispatched: Boolean(emailRes.sent),
        access_token_expires_at: rotated.new_access_token_expires_at
      };
    }

    return {
      status: 'ok',
      intent_id: rotated.intent_id,
      ref_code: rotated.ref_code,
      token_rotated: true,
      access_token: rotated.new_access_token,
      access_token_expires_at: rotated.new_access_token_expires_at
    };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Helper to look up matched transaction metadata for an intent without exposing internal PII/hashes.
 */
function findConfirmedTxSummaryForIntent_(ss, matchedTxId) {
  if (!matchedTxId) return null;
  const txSheet = ss.getSheetByName(SHEET_NAMES.TRANSACTIONS);
  if (!txSheet || txSheet.getLastRow() <= 1) return null;

  const tMap = getHeaderMap_(txSheet);
  const rows = txSheet.getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) {
    const txId = String(rows[i][tMap.tx_id] || '').trim();
    if (txId === String(matchedTxId).trim()) {
      const mStatus = String(rows[i][tMap.match_status] || '').trim().toUpperCase();
      const confirmed = mStatus === 'MATCHED' || mStatus === 'MANUAL_MATCHED';
      return {
        tx_id: txId,
        match_status: mStatus,
        gateway_status: tMap.gateway_status !== undefined ? String(rows[i][tMap.gateway_status] || '') : (confirmed ? 'MANUAL_CONFIRMED' : 'UNMATCHED'),
        receipt_no: confirmed && tMap.receipt_no !== undefined ? String(rows[i][tMap.receipt_no] || '') : '',
        email_status: tMap.email_status !== undefined ? String(rows[i][tMap.email_status] || '') : ''
      };
    }
  }
  return null;
}

/**
 * Checks donation intent status using either Alumni/Admin id_token OR Guest 256-bit access_token.
 * Uses header-aware mapping cleanly across v1 and v2 schemas.
 *
 * @param {string} idToken - Optional Alumni/Admin Google ID token.
 * @param {string} intentId - Target intent_id.
 * @param {string=} accessToken - Optional raw 256-bit Guest access_token.
 * @returns {Object} Intent status metadata.
 */
function checkIntentStatus(idToken, intentId, accessToken) {
  const targetIntentId = String(intentId || '').trim();
  if (!targetIntentId) throw new Error('Missing intent_id parameter.');

  let user = null;
  if (idToken) {
    user = requireUser_(idToken);
  } else if (!accessToken) {
    throw new Error('Authentication required: Provide id_token or guest access_token.');
  }

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const intentSheet = ss.getSheetByName(SHEET_NAMES.INTENTS);
  if (!intentSheet || intentSheet.getLastRow() <= 1) {
    return { status: 'ok', intent_status: 'NOT_FOUND' };
  }

  const hMap = getHeaderMap_(intentSheet);
  const data = intentSheet.getDataRange().getValues();

  for (let i = 1; i < data.length; i++) {
    if (String(data[i][hMap.intent_id] || '').trim() === targetIntentId) {
      const ownerUserId = String(data[i][hMap.user_id] || '').trim();

      if (user) {
        const isAdmin = String(user.role || '').toUpperCase() === 'ADMIN';
        if (ownerUserId !== user.user_id && !isAdmin) {
          logAudit_(
            user.email,
            'UNAUTHORIZED_INTENT_ACCESS',
            targetIntentId,
            'Blocked check_intent request for intent owned by another user.'
          );
          throw new Error('Forbidden: You are not authorized to access this donation intent.');
        }
      } else {
        const storedHash = hMap.access_token_hash !== undefined ? data[i][hMap.access_token_hash] : '';
        const tokenExp = hMap.access_token_expires_at !== undefined ? data[i][hMap.access_token_expires_at] : '';
        verifyGuestAccessToken_(accessToken, storedHash, tokenExp, 'intent_' + targetIntentId);
      }

      let intentStatus = String(data[i][hMap.status] || '').trim();
      let matchedTxId = String(data[i][hMap.matched_tx_id] || '').trim();
      const paymentChannel =
        hMap.payment_channel !== undefined ? String(data[i][hMap.payment_channel] || 'MANUAL_TRANSFER') : 'MANUAL_TRANSFER';
      const orderId =
        hMap.midtrans_order_id !== undefined ? String(data[i][hMap.midtrans_order_id] || '').trim() : '';
      let activeGatewayStatus = '';

      // Dual-Mode Active Status Inquiry for PENDING Midtrans Snap intents (throttled >= 5s via last_inquiry_at)
      if (
        paymentChannel === 'MIDTRANS_SNAP' &&
        intentStatus.toUpperCase() === 'PENDING' &&
        orderId &&
        typeof getMidtransConfig_ === 'function' &&
        getMidtransConfig_().configured
      ) {
        const lastInqStr =
          hMap.last_inquiry_at !== undefined ? String(data[i][hMap.last_inquiry_at] || '').trim() : '';
        const lastInqMs = lastInqStr ? new Date(lastInqStr).getTime() : 0;
        const nowMs = Date.now();

        if (!lastInqMs || isNaN(lastInqMs) || nowMs - lastInqMs >= 5000) {
          if (hMap.last_inquiry_at !== undefined) {
            intentSheet.getRange(i + 1, hMap.last_inquiry_at + 1).setValue(new Date(nowMs).toISOString());
          }
          try {
            const inquiryPayload = queryMidtransTransactionStatus_(orderId);
            const syncResult = processMidtransStatusUpdate_(inquiryPayload, 'ACTIVE_INQUIRY');
            if (syncResult && syncResult.intent_status) {
              intentStatus = syncResult.intent_status;
            }
            if (syncResult && syncResult.tx_id) {
              matchedTxId = syncResult.tx_id;
            }
            if (syncResult && syncResult.gateway_status) {
              activeGatewayStatus = syncResult.gateway_status;
            }
          } catch (ignoreInqErr) {
            // Keep existing PENDING state if transient network error occurs during polling
          }
        }
      }

      const txSummary = findConfirmedTxSummaryForIntent_(ss, matchedTxId);

      return {
        status: 'ok',
        intent_id: targetIntentId,
        ref_code: String(data[i][hMap.ref_code] || '').trim(),
        amount: Number(data[i][hMap.amount]) || 0,
        formatted_amount: formatRupiah(Number(data[i][hMap.amount]) || 0),
        bank: String(data[i][hMap.bank] || '').trim(),
        program: String(data[i][hMap.program] || '').trim(),
        program_id: hMap.program_id !== undefined ? String(data[i][hMap.program_id] || '').trim() : '',
        payment_channel: paymentChannel,
        order_id: orderId,
        intent_status: intentStatus,
        matched_tx_id: matchedTxId || null,
        tx_id: txSummary ? txSummary.tx_id : (matchedTxId || null),
        gateway_status: txSummary ? txSummary.gateway_status : (activeGatewayStatus || intentStatus),
        receipt_no: txSummary ? txSummary.receipt_no : '',
        email_status: txSummary ? txSummary.email_status : '',
        created_at: data[i][hMap.created_at]
      };
    }
  }

  return { status: 'ok', intent_status: 'NOT_FOUND' };
}

/**
 * Looks up Guest transaction status securely by G000xxx ref_code AND 256-bit access_token in POST body.
 * Rejects unauthenticated ref_code-only or email-only queries to comply with OPEN-04 anti-IDOR rules.
 *
 * @param {string} refCode - Guest G000xxx reference code.
 * @param {string} accessToken - Raw 256-bit Guest access_token.
 * @returns {Object} Verified Guest intent/transaction status summary.
 */
function getGuestTransactionStatus(refCode, accessToken) {
  const cleanRef = String(refCode || '').trim().toUpperCase();
  if (!/^G\d{6}$/.test(cleanRef)) {
    throw new Error('Format kode referensi Tamu tidak valid (contoh: G000001).');
  }
  if (!accessToken || typeof accessToken !== 'string') {
    throw new Error('Authentication required: Missing guest access_token.');
  }

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const intentSheet = ss.getSheetByName(SHEET_NAMES.INTENTS);
  if (!intentSheet || intentSheet.getLastRow() <= 1) {
    throw new Error('Data transaksi Tamu tidak ditemukan.');
  }

  const hMap = getHeaderMap_(intentSheet);
  if (hMap.access_token_hash === undefined) {
    throw new Error("Schema dependency error: Kolom 'access_token_hash' belum tersedia sebelum migrasi P2.2.");
  }

  const rows = intentSheet.getDataRange().getValues();
  // Scan latest matching intent row for refCode first, verifying access_token strictly
  for (let i = rows.length - 1; i >= 1; i--) {
    const rowRef = String(rows[i][hMap.ref_code] || '').trim().toUpperCase();
    const donorType = hMap.donor_type !== undefined ? String(rows[i][hMap.donor_type] || '').trim().toUpperCase() : 'GUEST';
    if (rowRef === cleanRef && donorType === 'GUEST') {
      const storedHash = rows[i][hMap.access_token_hash];
      const tokenExp = hMap.access_token_expires_at !== undefined ? rows[i][hMap.access_token_expires_at] : '';
      verifyGuestAccessToken_(accessToken, storedHash, tokenExp, 'ref_' + cleanRef);

      const intentId = String(rows[i][hMap.intent_id] || '').trim();
      const matchedTxId = String(rows[i][hMap.matched_tx_id] || '').trim();
      const txSummary = findConfirmedTxSummaryForIntent_(ss, matchedTxId);
      const amount = Number(rows[i][hMap.amount]) || 0;

      return {
        status: 'ok',
        intent_id: intentId,
        ref_code: cleanRef,
        intent_status: String(rows[i][hMap.status] || '').trim(),
        tx_id: txSummary ? txSummary.tx_id : (matchedTxId || null),
        receipt_no: txSummary ? txSummary.receipt_no : '',
        amount: amount,
        formatted_amount: formatRupiah(amount),
        bank: String(rows[i][hMap.bank] || '').trim(),
        program: String(rows[i][hMap.program] || '').trim(),
        program_id: hMap.program_id !== undefined ? String(rows[i][hMap.program_id] || '').trim() : '',
        payment_channel: hMap.payment_channel !== undefined ? String(rows[i][hMap.payment_channel] || 'MANUAL_TRANSFER') : 'MANUAL_TRANSFER',
        gateway_status: txSummary ? txSummary.gateway_status : String(rows[i][hMap.status] || '').trim(),
        is_anonymous: hMap.is_anonymous !== undefined ? String(rows[i][hMap.is_anonymous] || 'NO') === 'YES' : false,
        created_at: rows[i][hMap.created_at]
      };
    }
  }

  enforceGuestTokenRateLimit_('ref_' + cleanRef, true);
  throw new Error('Forbidden: Kode referensi atau access_token tidak cocok.');
}

/**
 * Triggers instant manual bank simulation strictly for MANUAL_TRANSFER intents owned by caller.
 * Supports Alumni/Admin id_token or Guest access_token and blocks MIDTRANS_SNAP forgery.
 *
 * @param {string} idToken - Optional Alumni/Admin Google ID token.
 * @param {string} intentId - Target intent_id.
 * @param {string=} accessToken - Optional raw 256-bit Guest access_token.
 * @returns {Object} Webhook processing result.
 */
function simulateIntentPayment(idToken, intentId, accessToken) {
  let user = null;
  if (idToken) {
    user = requireUser_(idToken);
  } else if (!accessToken) {
    throw new Error('Authentication required: Missing token for payment simulation.');
  }

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const intentSheet = ss.getSheetByName(SHEET_NAMES.INTENTS);
  if (!intentSheet || intentSheet.getLastRow() <= 1) {
    throw new Error('Intent not found.');
  }

  const hMap = getHeaderMap_(intentSheet);
  const data = intentSheet.getDataRange().getValues();
  let targetIntent = null;

  for (let i = 1; i < data.length; i++) {
    if (String(data[i][hMap.intent_id] || '').trim() === String(intentId || '').trim()) {
      targetIntent = {
        intent_id: data[i][hMap.intent_id],
        user_id: data[i][hMap.user_id],
        ref_code: data[i][hMap.ref_code],
        amount: data[i][hMap.amount],
        bank: data[i][hMap.bank],
        program: data[i][hMap.program],
        status: data[i][hMap.status],
        payment_channel: hMap.payment_channel !== undefined ? String(data[i][hMap.payment_channel] || 'MANUAL_TRANSFER') : 'MANUAL_TRANSFER',
        donor_name: hMap.donor_name !== undefined ? String(data[i][hMap.donor_name] || '') : '',
        access_token_hash: hMap.access_token_hash !== undefined ? data[i][hMap.access_token_hash] : '',
        access_token_expires_at: hMap.access_token_expires_at !== undefined ? data[i][hMap.access_token_expires_at] : ''
      };
      break;
    }
  }

  if (!targetIntent) throw new Error('Intent not found.');

  if (user) {
    if (String(targetIntent.user_id || '').trim() !== user.user_id && String(user.role || '').toUpperCase() !== 'ADMIN') {
      throw new Error('Forbidden: You are not authorized to simulate this donation intent.');
    }
  } else {
    verifyGuestAccessToken_(accessToken, targetIntent.access_token_hash, targetIntent.access_token_expires_at, 'sim_' + targetIntent.intent_id);
  }

  if (String(targetIntent.payment_channel).toUpperCase() === 'MIDTRANS_SNAP') {
    throw new Error('Forbidden: Simulasi bank manual tidak dapat memalsukan transaksi Midtrans Snap.');
  }

  if (targetIntent.status === 'MATCHED') return { status: 'ok', message: 'Already paid' };

  const donorLabel = (user && user.full_name) || targetIntent.donor_name || 'DONATUR';
  const vaInfo = generateVirtualAccount(targetIntent.bank, targetIntent.ref_code);
  const fakeMutation = {
    mutation_id: 'SIM_' + targetIntent.bank + '_' + Date.now().toString().slice(-6),
    bank: targetIntent.bank,
    amount: targetIntent.amount,
    type: 'CR',
    description: `PEMBAYARAN VA ${vaInfo.va_number} AN ${String(donorLabel).toUpperCase()} BEASISWA`,
    transaction_date: Utilities.formatDate(new Date(), 'Asia/Jakarta', 'yyyy-MM-dd HH:mm:ss')
  };

  const result = handleWebhookMutations_([fakeMutation]);
  return {
    status: 'ok',
    message: 'Simulated payment processed successfully',
    mutation: fakeMutation,
    result: result
  };
}

/**
 * Retrieves the logged-in Alumni/Admin's personal donation history and stats.
 */
function getMyDonations(idToken) {
  const user = requireUser_(idToken);

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const txSheet = ss.getSheetByName(SHEET_NAMES.TRANSACTIONS);
  const intentSheet = ss.getSheetByName(SHEET_NAMES.INTENTS);

  const history = [];
  let myTotalDonated = 0;
  let myTxCount = 0;
  const bankBreakdown = {};

  if (txSheet && txSheet.getLastRow() > 1) {
    const tMap = getHeaderMap_(txSheet);
    const txData = txSheet.getDataRange().getValues();
    for (let i = 1; i < txData.length; i++) {
      const row = txData[i];
      if ((user.user_id && row[tMap.user_id] === user.user_id) || (user.ref_code && row[tMap.ref_code] === user.ref_code)) {
        const amt = parseFloat(row[tMap.amount]) || 0;
        const b = String(row[tMap.bank] || 'UNKNOWN').trim();
        const gwStat = tMap.gateway_status !== undefined ? String(row[tMap.gateway_status] || '').trim().toUpperCase() : '';
        const isReversed = gwStat === 'REFUNDED' || gwStat === 'PARTIAL_REFUNDED' || gwStat === 'CHARGEBACK';
        if (!isReversed) {
          myTotalDonated += amt;
          myTxCount++;
          bankBreakdown[b] = (bankBreakdown[b] || 0) + amt;
        }

        history.push({
          type: 'TRANSACTION',
          id: row[tMap.tx_id],
          tx_id: row[tMap.tx_id],
          date: row[tMap.tx_date] || row[tMap.received_at],
          bank: b,
          payment_channel: tMap.payment_channel !== undefined ? String(row[tMap.payment_channel] || 'MANUAL_TRANSFER') : 'MANUAL_TRANSFER',
          amount: amt,
          formatted_amount: formatRupiah(amt),
          program: row[tMap.program] || 'Umum',
          match_status: row[tMap.match_status],
          gateway_status: gwStat || 'MANUAL_CONFIRMED',
          ref_code: row[tMap.ref_code],
          receipt_no: tMap.receipt_no !== undefined ? String(row[tMap.receipt_no] || '') : ''
        });
      }
    }
  }

  const pendingIntents = [];
  if (intentSheet && intentSheet.getLastRow() > 1) {
    const iMap = getHeaderMap_(intentSheet);
    const itData = intentSheet.getDataRange().getValues();
    for (let j = 1; j < itData.length; j++) {
      const it = itData[j];
      if (it[iMap.user_id] === user.user_id && it[iMap.status] === 'PENDING') {
        const channel = iMap.payment_channel !== undefined ? String(it[iMap.payment_channel] || 'MANUAL_TRANSFER') : 'MANUAL_TRANSFER';
        const vaInfo = channel === 'MANUAL_TRANSFER' ? generateVirtualAccount(it[iMap.bank], it[iMap.ref_code]) : { va_number: '', va_formatted: '' };
        pendingIntents.push({
          intent_id: it[iMap.intent_id],
          ref_code: it[iMap.ref_code],
          amount: it[iMap.amount],
          formatted_amount: formatRupiah(it[iMap.amount]),
          bank: it[iMap.bank],
          payment_channel: channel,
          va_number: vaInfo.va_number,
          va_formatted: vaInfo.va_formatted,
          program: it[iMap.program],
          created_at: it[iMap.created_at],
          expires_at: it[iMap.expires_at]
        });
      }
    }
  }

  const normVerifStatus = typeof normalizeVerificationStatus === 'function'
    ? normalizeVerificationStatus(user.verification_status)
    : String(user.verification_status || '').toUpperCase();
  const verifHistory = typeof getVerificationHistoryForUser_ === 'function'
    ? getVerificationHistoryForUser_(user.user_id)
    : [];
  const latestReason =
    (normVerifStatus === 'NEEDS_REVISION' || normVerifStatus === 'REJECTED') && typeof getLatestVerificationNoteForUser_ === 'function'
      ? getLatestVerificationNoteForUser_(user.user_id)
      : '';

  return {
    status: 'ok',
    user: {
      user_id: user.user_id,
      email: user.email,
      full_name: user.full_name,
      role: user.role,
      ref_code: user.ref_code,
      verification_status: normVerifStatus,
      raw_verification_status: user.verification_status,
      reject_reason: latestReason
    },
    verification_history: verifHistory,
    summary: {
      total_donated: myTotalDonated,
      formatted_total: formatRupiah(myTotalDonated),
      total_count: myTxCount,
      by_bank: bankBreakdown
    },
    active_intents: pendingIntents,
    history: history.reverse()
  };
}

/**
 * Periodic trigger function to expire stale pending donation intents older than MATCH_WINDOW_HOURS.
 */
function expireStaleIntents() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_NAMES.INTENTS);
  if (!sheet || sheet.getLastRow() <= 1) return;

  const hMap = getHeaderMap_(sheet);
  const statusCol1 = (hMap.status !== undefined ? hMap.status : 6) + 1;
  const now = new Date();
  const data = sheet.getDataRange().getValues();

  for (let i = 1; i < data.length; i++) {
    const status = String(data[i][hMap.status] || '').trim().toUpperCase();
    const expiresAt = new Date(data[i][hMap.expires_at]);
    if (status === 'PENDING' && !isNaN(expiresAt.getTime()) && expiresAt < now) {
      sheet.getRange(i + 1, statusCol1).setValue('EXPIRED');
      try {
        PropertiesService.getScriptProperties().deleteProperty('INTENT_ANON_' + data[i][hMap.intent_id]);
      } catch (e) {}
    }
  }

  // Prune expired IDEM_G_* idempotency entries from ScriptProperties to preserve property quota
  try {
    const props = PropertiesService.getScriptProperties();
    if (props && typeof props.getKeys === 'function') {
      const keys = props.getKeys();
      const nowMs = now.getTime();
      for (let k = 0; k < keys.length; k++) {
        if (keys[k].indexOf('IDEM_G_') === 0) {
          const valRaw = props.getProperty(keys[k]);
          if (valRaw) {
            const parsed = JSON.parse(valRaw);
            if (!parsed || !parsed.exp_ms || nowMs > parsed.exp_ms) {
              props.deleteProperty(keys[k]);
            }
          }
        }
      }
    }
  } catch (ignorePruneErr) {}
}
