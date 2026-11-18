/**
 * Receipts.gs
 * Official donation receipt retrieval and verification module for Phase P6.
 * Enforces strict post-confirmation issuance, anti-IDOR ownership checks (Alumni id_token,
 * Guest 256-bit access_token, or Admin), reversal blocking (REFUNDED/CHARGEBACK),
 * and Sandbox fee disclosure (OPEN-03 & OPEN-04).
 */

/**
 * Resolves the Guest access_token_hash and expiry for a transaction row, falling back to the
 * linked donation_intents row if the transaction was matched before token hash propagation.
 *
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss - Active spreadsheet instance.
 * @param {Object} tMap - Header map of transactions sheet.
 * @param {Array} txRow - Target transaction row values.
 * @returns {Object} { hash: string, expiresAt: string }.
 */
function resolveTransactionGuestTokenRecord_(ss, tMap, txRow) {
  const directHash =
    tMap.access_token_hash !== undefined ? String(txRow[tMap.access_token_hash] || '').trim() : '';
  const directExp =
    tMap.access_token_expires_at !== undefined ? String(txRow[tMap.access_token_expires_at] || '').trim() : '';
  if (directHash) {
    return { hash: directHash, expiresAt: directExp };
  }

  // Fallback lookup on donation_intents by intent_id or ref_code
  const intentSheet = ss.getSheetByName(SHEET_NAMES.INTENTS);
  if (!intentSheet || intentSheet.getLastRow() <= 1) {
    return { hash: '', expiresAt: '' };
  }

  const iMap = getHeaderMap_(intentSheet);
  if (iMap.access_token_hash === undefined) {
    return { hash: '', expiresAt: '' };
  }

  const targetIntentId = tMap.intent_id !== undefined ? String(txRow[tMap.intent_id] || '').trim() : '';
  const targetRefCode = tMap.ref_code !== undefined ? String(txRow[tMap.ref_code] || '').trim().toUpperCase() : '';
  const iRows = intentSheet.getDataRange().getValues();

  for (let i = iRows.length - 1; i >= 1; i--) {
    const rIntentId = String(iRows[i][iMap.intent_id] || '').trim();
    const rRefCode = String(iRows[i][iMap.ref_code] || '').trim().toUpperCase();
    if ((targetIntentId && rIntentId === targetIntentId) || (!targetIntentId && targetRefCode && rRefCode === targetRefCode)) {
      const h = String(iRows[i][iMap.access_token_hash] || '').trim();
      const exp =
        iMap.access_token_expires_at !== undefined ? String(iRows[i][iMap.access_token_expires_at] || '').trim() : '';
      if (h) {
        return { hash: h, expiresAt: exp };
      }
    }
  }

  return { hash: '', expiresAt: '' };
}

/**
 * Resolves the canonical donor full name for a confirmed receipt from linked donation_intents or users,
 * falling back to transactions.donor_name_raw when no intent/user name is recorded.
 */
function resolveTransactionDonorName_(ss, tMap, txRow) {
  const targetIntentId = tMap.intent_id !== undefined ? String(txRow[tMap.intent_id] || '').trim() : '';
  const targetUserId = tMap.user_id !== undefined ? String(txRow[tMap.user_id] || '').trim() : '';
  const targetRefCode = tMap.ref_code !== undefined ? String(txRow[tMap.ref_code] || '').trim().toUpperCase() : '';

  const intentSheet = ss.getSheetByName(SHEET_NAMES.INTENTS);
  if (intentSheet && intentSheet.getLastRow() > 1 && (targetIntentId || targetRefCode)) {
    const iMap = getHeaderMap_(intentSheet);
    if (iMap.donor_name !== undefined) {
      const iRows = intentSheet.getDataRange().getValues();
      for (let i = iRows.length - 1; i >= 1; i--) {
        const rIntentId = String(iRows[i][iMap.intent_id] || '').trim();
        const rRefCode = String(iRows[i][iMap.ref_code] || '').trim().toUpperCase();
        if ((targetIntentId && rIntentId === targetIntentId) || (!targetIntentId && targetRefCode && rRefCode === targetRefCode)) {
          const iName = String(iRows[i][iMap.donor_name] || '').trim();
          if (iName) return iName;
        }
      }
    }
  }

  const userSheet = ss.getSheetByName(SHEET_NAMES.USERS);
  if (userSheet && userSheet.getLastRow() > 1 && (targetUserId || targetRefCode)) {
    const uMap = getHeaderMap_(userSheet);
    const uRows = userSheet.getDataRange().getValues();
    for (let u = 1; u < uRows.length; u++) {
      const rUserId = uMap.user_id !== undefined ? String(uRows[u][uMap.user_id] || '').trim() : '';
      const rRef = uMap.ref_code !== undefined ? String(uRows[u][uMap.ref_code] || '').trim().toUpperCase() : '';
      if ((targetUserId && rUserId === targetUserId) || (targetRefCode && rRef === targetRefCode)) {
        const uName = uMap.full_name !== undefined ? String(uRows[u][uMap.full_name] || '').trim() : '';
        if (uName) return uName;
      }
    }
  }

  return String(txRow[tMap.donor_name_raw] || '').trim() || 'Donatur Beasiswa UPI';
}

/**
 * Retrieves official receipt details for a confirmed donation transaction.
 * Strictly requires either Alumni/Admin id_token OR Guest 256-bit access_token (OPEN-04).
 * Rejects UNMATCHED, unconfirmed, or REFUNDED/CHARGEBACK transactions.
 *
 * @param {Object} body - Request payload { tx_id?, receipt_no?, ref_code?, id_token?, access_token? }.
 * @returns {Object} Structured receipt payload.
 */
function getReceiptData(body) {
  const input = body || {};
  const idToken = typeof input.id_token === 'string' ? input.id_token.trim() : '';
  const accessToken = typeof input.access_token === 'string' ? input.access_token.trim() : '';
  const reqTxId = typeof input.tx_id === 'string' ? input.tx_id.trim() : '';
  const reqReceiptNo = typeof input.receipt_no === 'string' ? input.receipt_no.trim().toUpperCase() : '';
  const reqRefCode = typeof input.ref_code === 'string' ? input.ref_code.trim().toUpperCase() : '';

  // OPEN-04: Reject unauthenticated queries (e.g. ref_code + donor_email without cryptographic token)
  if (!idToken && !accessToken) {
    throw new Error('Authentication required: Sertakan id_token (Alumni/Admin) atau access_token (Tamu).');
  }
  if (!reqTxId && !reqReceiptNo && !reqRefCode) {
    throw new Error('Parameter pencarian kuitansi wajib diisi (tx_id, receipt_no, atau ref_code).');
  }

  let callerUser = null;
  if (idToken) {
    callerUser = requireUser_(idToken);
  }

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const txSheet = ss.getSheetByName(SHEET_NAMES.TRANSACTIONS);
  if (!txSheet || txSheet.getLastRow() <= 1) {
    throw new Error('Data transaksi tidak ditemukan.');
  }

  const tMap = getHeaderMap_(txSheet);
  const tRows = txSheet.getDataRange().getValues();
  let matchedRow = null;

  // Scan from newest to oldest so ref_code queries resolve the latest confirmed transaction
  for (let i = tRows.length - 1; i >= 1; i--) {
    const row = tRows[i];
    const rowTxId = String(row[tMap.tx_id] || '').trim();
    const rowReceiptNo =
      tMap.receipt_no !== undefined ? String(row[tMap.receipt_no] || '').trim().toUpperCase() : '';
    const rowRefCode = String(row[tMap.ref_code] || '').trim().toUpperCase();

    if (reqTxId && rowTxId === reqTxId) {
      matchedRow = row;
      break;
    }
    if (!reqTxId && reqReceiptNo && rowReceiptNo === reqReceiptNo) {
      matchedRow = row;
      break;
    }
    if (!reqTxId && !reqReceiptNo && reqRefCode && rowRefCode === reqRefCode) {
      matchedRow = row;
      break;
    }
  }

  if (!matchedRow) {
    if (!callerUser && reqRefCode) {
      enforceGuestTokenRateLimit_('receipt_ref_' + reqRefCode, true);
    }
    throw new Error('Transaksi atau kuitansi tidak ditemukan.');
  }

  const txId = String(matchedRow[tMap.tx_id] || '').trim();
  const refCode = String(matchedRow[tMap.ref_code] || '').trim().toUpperCase();
  const ownerUserId = String(matchedRow[tMap.user_id] || '').trim();

  // Step 1: Verify ownership / authorization before revealing any transaction state
  if (callerUser) {
    const isAdmin = String(callerUser.role || '').toUpperCase() === 'ADMIN';
    const callerRef = String(callerUser.ref_code || '').trim().toUpperCase();
    const ownsByUser = ownerUserId && ownerUserId === callerUser.user_id;
    const ownsByRef = callerRef && refCode && callerRef === refCode;

    if (!isAdmin && !ownsByUser && !ownsByRef) {
      logAudit_(
        callerUser.email,
        'UNAUTHORIZED_RECEIPT_ACCESS',
        txId,
        'Blocked get_receipt attempt for transaction owned by another donor.'
      );
      throw new Error('Forbidden: Anda tidak berhak mengakses kuitansi donasi milik donatur lain.');
    }
  } else {
    const tokenRecord = resolveTransactionGuestTokenRecord_(ss, tMap, matchedRow);
    verifyGuestAccessToken_(
      accessToken,
      tokenRecord.hash,
      tokenRecord.expiresAt,
      'receipt_' + (txId || refCode)
    );
  }

  // Step 2: Verify transaction is confirmed (never issue or display receipts for UNMATCHED)
  const matchStatus = String(matchedRow[tMap.match_status] || '').trim().toUpperCase();
  if (matchStatus !== 'MATCHED' && matchStatus !== 'MANUAL_MATCHED') {
    throw new Error('Forbidden: Kuitansi belum tersedia karena transaksi belum terkonfirmasi (status: ' + matchStatus + ').');
  }

  // Step 3: Block reversed / voided gateway transactions (REFUNDED / PARTIAL_REFUNDED / CHARGEBACK)
  const gatewayStatus =
    tMap.gateway_status !== undefined && String(matchedRow[tMap.gateway_status] || '').trim()
      ? String(matchedRow[tMap.gateway_status]).trim().toUpperCase()
      : 'MANUAL_CONFIRMED';
  if (
    gatewayStatus === 'REFUNDED' ||
    gatewayStatus === 'PARTIAL_REFUNDED' ||
    gatewayStatus === 'CHARGEBACK'
  ) {
    throw new Error(
      'Forbidden: Kuitansi telah dinonaktifkan karena transaksi berstatus ' + gatewayStatus + '.'
    );
  }

  // Step 4: Require valid receipt_no
  const receiptNo = tMap.receipt_no !== undefined ? String(matchedRow[tMap.receipt_no] || '').trim() : '';
  if (!receiptNo) {
    throw new Error('Forbidden: Nomor kuitansi belum diterbitkan untuk transaksi ini.');
  }

  const amount = Math.round(parseFloat(matchedRow[tMap.amount]) || 0);
  const grossAmount =
    tMap.gross_amount !== undefined && matchedRow[tMap.gross_amount] !== ''
      ? Math.round(parseFloat(matchedRow[tMap.gross_amount]) || amount)
      : amount;
  const gatewayFee =
    tMap.gateway_fee !== undefined && matchedRow[tMap.gateway_fee] !== ''
      ? Math.round(parseFloat(matchedRow[tMap.gateway_fee]) || 0)
      : 0;
  const netAmount =
    tMap.net_amount !== undefined && matchedRow[tMap.net_amount] !== ''
      ? Math.round(parseFloat(matchedRow[tMap.net_amount]) || grossAmount - gatewayFee)
      : grossAmount - gatewayFee;

  const isAnonymous = String(matchedRow[tMap.is_anonymous] || 'NO').trim().toUpperCase() === 'YES';
  const donorNameRaw = resolveTransactionDonorName_(ss, tMap, matchedRow);
  const donorDisplayName = String(matchedRow[tMap.donor_display_name] || '').trim() || maskDonorName(donorNameRaw, isAnonymous);
  const donorType =
    tMap.donor_type !== undefined && String(matchedRow[tMap.donor_type] || '').trim()
      ? String(matchedRow[tMap.donor_type]).trim().toUpperCase()
      : /^G/i.test(refCode)
      ? 'GUEST'
      : 'ALUMNI';
  const programName = String(matchedRow[tMap.program] || 'Beasiswa Alumni UPI').trim();
  const programId = tMap.program_id !== undefined ? String(matchedRow[tMap.program_id] || '').trim() : '';
  const paymentChannel =
    tMap.payment_channel !== undefined && String(matchedRow[tMap.payment_channel] || '').trim()
      ? String(matchedRow[tMap.payment_channel]).trim().toUpperCase()
      : 'MANUAL_TRANSFER';
  const bank = String(matchedRow[tMap.bank] || '').trim();
  const gatewayPaymentType =
    tMap.gateway_payment_type !== undefined ? String(matchedRow[tMap.gateway_payment_type] || '').trim() : '';
  const gatewayOrderId =
    tMap.gateway_order_id !== undefined ? String(matchedRow[tMap.gateway_order_id] || '').trim() : '';
  const issuedAt =
    tMap.receipt_issued_at !== undefined && String(matchedRow[tMap.receipt_issued_at] || '').trim()
      ? String(matchedRow[tMap.receipt_issued_at]).trim()
      : String(matchedRow[tMap.received_at] || '').trim();
  const txDate = String(matchedRow[tMap.tx_date] || '').trim();

  const isProdConfig = String(getSecureConfig_('MIDTRANS_IS_PRODUCTION', true) || 'false').trim().toLowerCase() === 'true';
  const isSandbox = !isProdConfig;
  const orgName = getConfig_('ORG_NAME') || 'Pengelola Beasiswa Ikatan Alumni UPI';

  return {
    status: 'ok',
    receipt: {
      receipt_no: receiptNo,
      issued_at: issuedAt,
      tx_id: txId,
      ref_code: refCode,
      donor_type: donorType,
      donor_name: isAnonymous ? 'Seseorang (Donatur Anonim)' : donorNameRaw,
      donor_display_name: donorDisplayName,
      is_anonymous: isAnonymous,
      program_name: programName,
      program_id: programId,
      gross_amount: grossAmount,
      gateway_fee: gatewayFee,
      net_amount: netAmount,
      formatted_gross_amount: formatRupiah(grossAmount),
      formatted_gateway_fee: formatRupiah(gatewayFee),
      formatted_net_amount: formatRupiah(netAmount),
      payment_channel: paymentChannel,
      bank: bank,
      gateway_payment_type: gatewayPaymentType,
      gateway_order_id: gatewayOrderId,
      tx_date: txDate,
      match_status: matchStatus,
      gateway_status: gatewayStatus,
      is_sandbox: isSandbox,
      environment_notice: isSandbox
        ? 'Mode Sandbox — Biaya gateway Rp 0 (belum terkonfirmasi biaya aktual production).'
        : 'Bukti Kuitansi Resmi Terverifikasi',
      org_name: orgName
    }
  };
}
