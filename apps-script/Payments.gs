/**
 * Payments.gs
 * Midtrans Sandbox/Production REST API wrapper, SHA-512 webhook signature verifier,
 * and lock-safe receipt sequence allocator for Phase P5 Hybrid Payment.
 */

/**
 * Computes a 128-character lowercase hexadecimal SHA-512 digest using Apps Script Utilities.
 *
 * @param {string} rawString - Input string to hash.
 * @returns {string} 128-character lowercase hex SHA-512 hash.
 */
function computeSha512Hex_(rawString) {
  // Compute signed byte array digest via Google Apps Script Utilities
  const digestBytes = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_512,
    String(rawString === undefined || rawString === null ? '' : rawString)
  );

  // Convert signed bytes (-128..127) to unsigned 2-digit lowercase hex string
  let hex = '';
  for (let i = 0; i < digestBytes.length; i++) {
    const unsignedByte = digestBytes[i] < 0 ? digestBytes[i] + 256 : digestBytes[i];
    hex += unsignedByte.toString(16).padStart(2, '0');
  }
  return hex;
}

/**
 * Resolves Midtrans configuration and endpoint URLs.
 * Enforces ScriptProperties-only retrieval for MIDTRANS_SERVER_KEY (never reads server key from sheet).
 *
 * @param {Object=} options - Optional { requireServerKey: boolean }.
 * @returns {Object} { serverKey, isProduction, snapBaseUrl, apiBaseUrl, configured }.
 */
function getMidtransConfig_(options) {
  const opts = options || {};

  // Read MIDTRANS_SERVER_KEY strictly from ScriptProperties (allowSheetFallback = false)
  const serverKey = String(getSecureConfig_('MIDTRANS_SERVER_KEY', false) || '').trim();
  const isProdRaw = String(getSecureConfig_('MIDTRANS_IS_PRODUCTION', true) || 'false').trim().toLowerCase();
  const isProduction = isProdRaw === 'true';

  if (opts.requireServerKey === true && !serverKey) {
    throw new Error('Configuration Error: ScriptProperties.MIDTRANS_SERVER_KEY belum dikonfigurasi.');
  }

  return {
    serverKey: serverKey,
    isProduction: isProduction,
    configured: Boolean(serverKey),
    snapBaseUrl: isProduction ? 'https://app.midtrans.com' : 'https://app.sandbox.midtrans.com',
    apiBaseUrl: isProduction ? 'https://api.midtrans.com' : 'https://api.sandbox.midtrans.com'
  };
}

/**
 * Creates a Midtrans Snap transaction token via POST /snap/v1/transactions when MIDTRANS_SERVER_KEY
 * is provisioned in ScriptProperties. While OPEN-05 credentials are not yet set, returns a safe
 * prepared descriptor unless requireLiveSnap is explicitly requested.
 *
 * @param {Object} params - { order_id, amount, program_id, program_name, donor_name, donor_email, is_anonymous, ref_code, window_hours, requireLiveSnap }.
 * @returns {Object} { configured, snap_token, redirect_url, payment_mode }.
 */
function createMidtransSnapTransaction_(params) {
  const input = params || {};
  const cfg = getMidtransConfig_({ requireServerKey: input.requireLiveSnap === true });

  // Return structural prepared state when Sandbox Server Key has not yet been provisioned (OPEN-05)
  if (!cfg.configured) {
    return {
      configured: false,
      snap_token: '',
      redirect_url: '',
      payment_mode: 'MIDTRANS_SANDBOX_PREPARED'
    };
  }

  const orderId = String(input.order_id || '').trim();
  const grossAmount = Math.round(Number(input.amount) || 0);
  if (!orderId || grossAmount < 10000) {
    throw new Error('Invalid Midtrans Snap request: order_id dan nominal minimal Rp 10.000 wajib diisi.');
  }

  // Mask customer display name on gateway payload when donor selected explicit anonymity
  const customerFirstName =
    String(input.is_anonymous || '').toUpperCase() === 'YES'
      ? 'Seseorang (Anonim)'
      : String(input.donor_name || 'Donatur IKA UPI').trim().slice(0, 50);
  const customerEmail = String(input.donor_email || '').trim();
  const windowHours = parseInt(input.window_hours || '24', 10) || 24;

  const snapRequestBody = {
    transaction_details: {
      order_id: orderId,
      gross_amount: grossAmount
    },
    item_details: [
      {
        id: String(input.program_id || 'PRG-001').slice(0, 50),
        price: grossAmount,
        quantity: 1,
        name: String(input.program_name || 'Donasi Beasiswa Alumni UPI').slice(0, 50)
      }
    ],
    customer_details: {
      first_name: customerFirstName,
      email: customerEmail
    },
    expiry: {
      unit: 'hour',
      duration: windowHours
    },
    custom_field1: String(input.ref_code || ''),
    custom_field2: String(input.program_id || '')
  };

  // Encode Basic Auth header using ServerKey + ':' without exposing key in error logs
  const basicAuth = Utilities.base64Encode(cfg.serverKey + ':');
  const url = cfg.snapBaseUrl + '/snap/v1/transactions';

  const response = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: {
      Accept: 'application/json',
      Authorization: 'Basic ' + basicAuth
    },
    payload: JSON.stringify(snapRequestBody),
    muteHttpExceptions: true
  });

  const statusCode = response.getResponseCode();
  let parsed = {};
  try {
    parsed = JSON.parse(response.getContentText() || '{}');
  } catch (ignoreParseErr) {
    parsed = {};
  }

  if ((statusCode === 200 || statusCode === 201) && parsed.token) {
    return {
      configured: true,
      snap_token: String(parsed.token),
      redirect_url: String(parsed.redirect_url || ''),
      payment_mode: cfg.isProduction ? 'MIDTRANS_LIVE' : 'MIDTRANS_SANDBOX_ACTIVE'
    };
  }

  const errMsg =
    parsed && Array.isArray(parsed.error_messages) && parsed.error_messages.length > 0
      ? parsed.error_messages.join('; ')
      : parsed.status_message || 'HTTP ' + statusCode;
  throw new Error('Gagal membuat transaksi Midtrans Snap: ' + errMsg);
}

/**
 * Queries Midtrans Core API GET /v2/{order_id}/status for Active Status Inquiry & Admin Sync.
 * Treats HTTP 404 / status_code 404 (before customer picks channel in Snap popup) as NOT_FOUND_404.
 *
 * @param {string} orderId - Target Midtrans order_id.
 * @returns {Object} Normalized inquiry response object.
 */
function queryMidtransTransactionStatus_(orderId) {
  const cleanOrderId = String(orderId || '').trim();
  if (!cleanOrderId) {
    throw new Error('Missing Midtrans order_id for status inquiry.');
  }

  // Fail closed when MIDTRANS_SERVER_KEY is absent
  const cfg = getMidtransConfig_({ requireServerKey: true });
  const basicAuth = Utilities.base64Encode(cfg.serverKey + ':');
  const url = cfg.apiBaseUrl + '/v2/' + encodeURIComponent(cleanOrderId) + '/status';

  const response = UrlFetchApp.fetch(url, {
    method: 'get',
    headers: {
      Accept: 'application/json',
      Authorization: 'Basic ' + basicAuth
    },
    muteHttpExceptions: true
  });

  const httpStatus = response.getResponseCode();
  let parsed = {};
  try {
    parsed = JSON.parse(response.getContentText() || '{}');
  } catch (ignoreErr) {
    parsed = {};
  }

  const midtransCode = String(parsed.status_code || httpStatus || '').trim();
  if (httpStatus === 404 || midtransCode === '404') {
    return {
      http_status: 404,
      status_code: '404',
      order_id: cleanOrderId,
      transaction_status: 'not_found_404',
      fraud_status: '',
      status_message: parsed.status_message || 'Transaction does not exist yet in Midtrans.'
    };
  }

  if (httpStatus >= 500 || httpStatus === 401 || httpStatus === 403) {
    throw new Error('Midtrans Status Inquiry gagal (HTTP ' + httpStatus + ').');
  }

  return Object.assign({}, parsed, {
    http_status: httpStatus,
    order_id: String(parsed.order_id || cleanOrderId).trim(),
    transaction_status: String(parsed.transaction_status || '').trim().toLowerCase(),
    fraud_status: String(parsed.fraud_status || '').trim().toLowerCase()
  });
}

/**
 * Verifies an incoming server-to-server Midtrans webhook notification payload.
 * Fails closed when MIDTRANS_SERVER_KEY is unset or SHA-512 signature_key does not match.
 *
 * @param {Object} payload - Raw parsed POST body from Midtrans notification.
 * @returns {boolean} True when valid; throws Error otherwise.
 */
function verifyMidtransWebhookPayload_(payload) {
  const cfg = getMidtransConfig_({ requireServerKey: true });
  const isValid = verifyMidtransSignature(payload, cfg.serverKey, computeSha512Hex_);
  if (!isValid) {
    logAudit_(
      'SYSTEM_WEBHOOK',
      'MIDTRANS_SIGNATURE_REJECTED',
      payload && payload.order_id ? String(payload.order_id) : 'UNKNOWN',
      'Rejected webhook with invalid SHA-512 signature_key.'
    );
    throw new Error('Forbidden: Invalid Midtrans signature_key.');
  }
  return true;
}

/**
 * Allocates the next sequential receipt number (KWT-YYYY-000001) inside an active ScriptLock.
 * Ensures monotonic progression against both counters.RECEIPT and existing transactions.receipt_no.
 *
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss - Active spreadsheet instance.
 * @param {Date=} nowDate - Optional reference date (defaults to current Date).
 * @returns {string} Newly allocated KWT-YYYY-XXXXXX receipt number.
 */
function allocateNextReceiptNo_(ss, nowDate) {
  const targetSs = ss || SpreadsheetApp.getActiveSpreadsheet();
  const refDate = nowDate instanceof Date ? nowDate : new Date();
  const yearStr = String(refDate.getUTCFullYear());

  // Scan transactions.receipt_no high-water mark so counter never regresses
  let maxExistingSeq = 0;
  const txSheet = targetSs.getSheetByName(SHEET_NAMES.TRANSACTIONS);
  if (txSheet && txSheet.getLastRow() > 1) {
    const tMap = typeof getHeaderMap_ === 'function' ? getHeaderMap_(txSheet) : null;
    if (tMap && tMap.receipt_no !== undefined) {
      const tRows = txSheet.getDataRange().getValues();
      for (let i = 1; i < tRows.length; i++) {
        const recVal = String(tRows[i][tMap.receipt_no] || '').trim().toUpperCase();
        const match = recVal.match(/^KWT-\d{4}-(\d{6})$/);
        if (match) {
          const num = parseInt(match[1], 10);
          if (!isNaN(num) && num > maxExistingSeq) {
            maxExistingSeq = num;
          }
        }
      }
    }
  }

  // Read and update counters.RECEIPT row using header mapping
  const ctrSheet = targetSs.getSheetByName(SHEET_NAMES.COUNTERS);
  let nextSeq = maxExistingSeq + 1;

  if (ctrSheet) {
    const cMap = typeof getHeaderMap_ === 'function' ? getHeaderMap_(ctrSheet) : { name: 0, value: 1 };
    const nameIdx = cMap.name !== undefined ? cMap.name : 0;
    const valIdx = cMap.value !== undefined ? cMap.value : 1;
    const cRows = ctrSheet.getDataRange().getValues();
    let receiptRowIdx1 = -1;
    let currentCtrVal = 0;

    for (let i = 1; i < cRows.length; i++) {
      if (String(cRows[i][nameIdx] || '').trim().toUpperCase() === 'RECEIPT') {
        receiptRowIdx1 = i + 1;
        currentCtrVal = parseInt(cRows[i][valIdx], 10) || 0;
        break;
      }
    }

    nextSeq = Math.max(currentCtrVal, maxExistingSeq) + 1;
    if (receiptRowIdx1 !== -1) {
      ctrSheet.getRange(receiptRowIdx1, valIdx + 1).setValue(nextSeq);
    } else {
      ctrSheet.appendRow(['RECEIPT', nextSeq]);
    }
  }

  return 'KWT-' + yearStr + '-' + String(nextSeq).padStart(6, '0');
}
