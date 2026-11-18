/**
 * Admin.gs
 * Sensitive operational endpoints: verifications list, review queue manual resolution, and insights.
 */

/**
 * Returns pending and recent alumni verifications for Admin view.
 */
function getAdminVerifications(adminToken, filterStatus) {
  // Enforce centralized admin authorization guard (SEC-P0-7)
  const profile = requireAdmin_(adminToken);

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_NAMES.VERIFICATIONS);
  const list = [];
  if (!sheet || sheet.getLastRow() <= 1) return { status: 'ok', items: [] };

  const headerMap = typeof getHeaderMap_ === 'function' ? getHeaderMap_(sheet) : null;
  const colCount = Math.max(13, sheet.getLastColumn ? sheet.getLastColumn() : 13);
  const data = sheet.getRange(2, 1, sheet.getLastRow() - 1, colCount).getValues();
  const filterNorm = filterStatus ? normalizeVerificationStatus(filterStatus) : '';

  for (let i = 0; i < data.length; i++) {
    const row = data[i];
    const idx = function (name, fallbackIdx) {
      return headerMap && headerMap[name] !== undefined ? headerMap[name] : fallbackIdx;
    };
    const rawStatus = row[idx('status', 8)];
    const canonicalStatus = typeof normalizeVerificationStatus === 'function'
      ? normalizeVerificationStatus(rawStatus)
      : String(rawStatus || '').trim().toUpperCase();

    if (filterNorm && canonicalStatus !== filterNorm) {
      continue;
    }

    list.push({
      verif_id: row[idx('verif_id', 0)],
      user_id: row[idx('user_id', 1)],
      email: row[idx('email', 2)],
      full_name: row[idx('full_name', 3)],
      nim: row[idx('nim', 4)],
      grad_year: row[idx('grad_year', 5)],
      faculty: row[idx('faculty', 6)],
      // Never expose raw Drive proof file_id to client listing; fetch via admin_verif_proof
      has_file: Boolean(row[idx('proof_file_id', 7)]),
      status: canonicalStatus,
      raw_status: rawStatus,
      submitted_at: row[idx('submitted_at', 9)],
      reviewed_by: row[idx('reviewed_by', 10)],
      reviewed_at: row[idx('reviewed_at', 11)],
      reject_reason: row[idx('reject_reason', 12)]
    });
  }

  return {
    status: 'ok',
    items: list.reverse()
  };
}

/**
 * Returns review queue items (unmatched tier 3 transactions) for Admin.
 */
function getAdminReviewQueue(adminToken) {
  // Enforce centralized admin authorization guard (SEC-P0-7)
  const profile = requireAdmin_(adminToken);

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_NAMES.REVIEW_QUEUE);
  const list = [];
  if (!sheet || sheet.getLastRow() <= 1) return { status: 'ok', items: [] };

  const data = sheet.getRange(2, 1, sheet.getLastRow() - 1, 13).getValues();
  for (let i = 0; i < data.length; i++) {
    const row = data[i];
    list.push({
      queue_id: row[0],
      tx_id: row[1],
      bank: row[2],
      amount: row[3],
      formatted_amount: formatRupiah(row[3]),
      tx_date: row[4],
      description: row[5],
      reason: row[6],
      candidates_count: row[7],
      status: row[8],
      resolved_by: row[9],
      resolved_at: row[10],
      assigned_ref_code: row[12]
    });
  }

  return {
    status: 'ok',
    items: list.reverse()
  };
}

/**
 * Manually links an unmatched transaction from review queue to a specific user/ref_code
 * (supports both registered Alumni A000xxx in 'users' and accountless Guest G000xxx in 'donation_intents'),
 * issues an official KWT receipt_no upon confirmation, and tracks email_status (State Machine 2 & 4).
 */
function resolveReviewQueueItem(adminToken, queueId, targetRefCode) {
  // Enforce centralized admin authorization guard (SEC-P0-7)
  const profile = requireAdmin_(adminToken);

  const lock = LockService.getScriptLock();
  lock.waitLock(15000);

  try {
    const targetCode = String(targetRefCode || '').trim().toUpperCase();
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const usersByRef = getUsersMapByRefCode_();
    let targetDonor = usersByRef.has(targetCode) ? usersByRef.get(targetCode) : null;

    // Also allow linking to an accountless Guest G000xxx from donation_intents
    if (!targetDonor && /^G\d{6}$/.test(targetCode)) {
      const intentSheet = ss.getSheetByName(SHEET_NAMES.INTENTS);
      if (intentSheet && intentSheet.getLastRow() > 1) {
        const iMap = getHeaderMap_(intentSheet);
        const iRows = intentSheet.getDataRange().getValues();
        for (let i = iRows.length - 1; i >= 1; i--) {
          if (String(iRows[i][iMap.ref_code] || '').trim().toUpperCase() === targetCode) {
            targetDonor = {
              user_id: String(iRows[i][iMap.user_id] || '').trim(),
              email: iMap.donor_email !== undefined ? String(iRows[i][iMap.donor_email] || '').trim() : '',
              full_name: iMap.donor_name !== undefined ? String(iRows[i][iMap.donor_name] || 'Donatur Tamu').trim() : 'Donatur Tamu',
              role: 'GUEST',
              ref_code: targetCode,
              access_token_hash: iMap.access_token_hash !== undefined ? String(iRows[i][iMap.access_token_hash] || '') : '',
              access_token_expires_at: iMap.access_token_expires_at !== undefined ? String(iRows[i][iMap.access_token_expires_at] || '') : ''
            };
            break;
          }
        }
      }
    }

    if (!targetDonor) {
      throw new Error('Kode referensi donatur "' + targetCode + '" tidak terdaftar di sistem.');
    }

    const qSheet = ss.getSheetByName(SHEET_NAMES.REVIEW_QUEUE);
    const txSheet = ss.getSheetByName(SHEET_NAMES.TRANSACTIONS);

    let targetTxId = null;
    let qRowIdx = -1;

    // Find queue record
    const qData = qSheet.getRange(2, 1, qSheet.getLastRow() - 1, 13).getValues();
    for (let i = 0; i < qData.length; i++) {
      if (qData[i][0] === queueId) {
        targetTxId = qData[i][1];
        qRowIdx = i + 2;
        break;
      }
    }

    if (!targetTxId || qRowIdx === -1) {
      throw new Error('Item review queue tidak ditemukan.');
    }

    const now = new Date();

    // 1. Update review_queue status
    qSheet.getRange(qRowIdx, 9, 1, 5).setValues([[
      'RESOLVED',
      profile.email,
      now.toISOString(),
      targetDonor.user_id || '',
      targetCode
    ]]);

    // 2. Update transaction record and issue official receipt_no now that it is confirmed
    let txAmount = 0;
    let txBank = '';
    let txDate = '';
    let txProgram = 'Umum';
    let receiptNo = '';
    let txRowIdx = -1;

    const tMap = typeof getHeaderMap_ === 'function' ? getHeaderMap_(txSheet) : null;
    const txData = txSheet.getDataRange().getValues();
    for (let j = 1; j < txData.length; j++) {
      const rTxId = String(txData[j][tMap && tMap.tx_id !== undefined ? tMap.tx_id : 0] || '').trim();
      if (rTxId === targetTxId) {
        txRowIdx = j + 1;
        txAmount = parseFloat(txData[j][tMap && tMap.amount !== undefined ? tMap.amount : 6]) || 0;
        txBank = String(txData[j][tMap && tMap.bank !== undefined ? tMap.bank : 3] || '');
        txDate = String(txData[j][tMap && tMap.tx_date !== undefined ? tMap.tx_date : 5] || '');
        txProgram = String(txData[j][tMap && tMap.program !== undefined ? tMap.program : 15] || 'Umum');

        const existingRec =
          tMap && tMap.receipt_no !== undefined ? String(txData[j][tMap.receipt_no] || '').trim() : '';
        receiptNo =
          existingRec || (typeof allocateNextReceiptNo_ === 'function' ? allocateNextReceiptNo_(ss, now) : '');

        txSheet.getRange(txRowIdx, (tMap && tMap.match_status !== undefined ? tMap.match_status : 10) + 1).setValue('MANUAL_MATCHED');
        txSheet.getRange(txRowIdx, (tMap && tMap.match_tier !== undefined ? tMap.match_tier : 11) + 1).setValue('MANUAL');
        txSheet.getRange(txRowIdx, (tMap && tMap.user_id !== undefined ? tMap.user_id : 12) + 1).setValue(targetDonor.user_id || '');
        txSheet.getRange(txRowIdx, (tMap && tMap.ref_code !== undefined ? tMap.ref_code : 13) + 1).setValue(targetCode);

        if (tMap) {
          if (tMap.gateway_status !== undefined) {
            txSheet.getRange(txRowIdx, tMap.gateway_status + 1).setValue('MANUAL_CONFIRMED');
          }
          if (tMap.donor_type !== undefined) {
            txSheet.getRange(txRowIdx, tMap.donor_type + 1).setValue(targetDonor.role === 'GUEST' ? 'GUEST' : 'ALUMNI');
          }
          if (tMap.donor_email !== undefined && targetDonor.email) {
            txSheet.getRange(txRowIdx, tMap.donor_email + 1).setValue(targetDonor.email);
          }
          if (tMap.receipt_no !== undefined && receiptNo) {
            txSheet.getRange(txRowIdx, tMap.receipt_no + 1).setValue(receiptNo);
          }
          if (tMap.receipt_issued_at !== undefined && receiptNo) {
            txSheet.getRange(txRowIdx, tMap.receipt_issued_at + 1).setValue(now.toISOString());
          }
          if (tMap.access_token_hash !== undefined && targetDonor.access_token_hash) {
            txSheet.getRange(txRowIdx, tMap.access_token_hash + 1).setValue(targetDonor.access_token_hash);
          }
          if (tMap.access_token_expires_at !== undefined && targetDonor.access_token_expires_at) {
            txSheet.getRange(txRowIdx, tMap.access_token_expires_at + 1).setValue(targetDonor.access_token_expires_at);
          }
        }
        break;
      }
    }

    // 3. Send confirmation email to the linked donor & update email_status
    let emailStatus = targetDonor.email ? 'PENDING' : 'NOT_APPLICABLE';
    if (targetDonor.email) {
      const mailOut = sendDonorDonationReceivedEmail_({
        to_email: targetDonor.email,
        full_name: targetDonor.full_name,
        ref_code: targetCode,
        amount: txAmount,
        bank: txBank,
        date: txDate,
        program: txProgram,
        receipt_no: receiptNo
      });
      if (mailOut && mailOut.sent === false) {
        emailStatus = 'FAILED';
        if (txRowIdx !== -1 && tMap) {
          if (tMap.email_status !== undefined) txSheet.getRange(txRowIdx, tMap.email_status + 1).setValue('FAILED');
          if (tMap.email_error !== undefined) txSheet.getRange(txRowIdx, tMap.email_error + 1).setValue(String(mailOut.error || 'MailApp error').slice(0, 200));
        }
      } else {
        emailStatus = 'SENT';
        if (txRowIdx !== -1 && tMap) {
          if (tMap.email_status !== undefined) txSheet.getRange(txRowIdx, tMap.email_status + 1).setValue('SENT');
          if (tMap.email_sent_at !== undefined) txSheet.getRange(txRowIdx, tMap.email_sent_at + 1).setValue(new Date().toISOString());
        }
      }
    }

    logAudit_(profile.email, 'MANUAL_MATCH', targetTxId, 'Assigned to ' + targetCode + ' via queue ' + queueId + ' receipt=' + receiptNo);

    if (typeof invalidatePublicSummaryCache_ === 'function') {
      invalidatePublicSummaryCache_();
    }

    return {
      status: 'ok',
      queue_id: queueId,
      tx_id: targetTxId,
      assigned_ref_code: targetCode,
      receipt_no: receiptNo,
      email_status: emailStatus
    };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Admin insights: gross/fee/net financial aggregates, matching tiers, channel/bank/program breakdown,
 * and donor demographics (excluding UNMATCHED and reversed REFUNDED/CHARGEBACK rows from verified revenue).
 */
function getAdminInsights(adminToken) {
  // Enforce centralized admin authorization guard (SEC-P0-7)
  requireAdmin_(adminToken);

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const txSheet = ss.getSheetByName(SHEET_NAMES.TRANSACTIONS);
  const userSheet = ss.getSheetByName(SHEET_NAMES.USERS);

  let totalGross = 0;
  let totalFee = 0;
  let totalNet = 0;
  let confirmedCount = 0;
  let unmatchedCount = 0;
  let reversedCount = 0;
  const tierCounts = { 1: 0, 2: 0, 3: 0, MANUAL: 0, '1-MIDTRANS': 0 };
  const bankAmounts = {};
  const channelBreakdown = {};
  const programBreakdown = {};

  if (txSheet && txSheet.getLastRow() > 1) {
    const tMap = typeof getHeaderMap_ === 'function' ? getHeaderMap_(txSheet) : null;
    const txs = txSheet.getDataRange().getValues();
    for (let i = 1; i < txs.length; i++) {
      const row = txs[i];
      const matchStatus = String(row[tMap && tMap.match_status !== undefined ? tMap.match_status : 10] || '').trim().toUpperCase();
      const gatewayStatus =
        tMap && tMap.gateway_status !== undefined
          ? String(row[tMap.gateway_status] || '').trim().toUpperCase()
          : '';
      const tier = String(row[tMap && tMap.match_tier !== undefined ? tMap.match_tier : 11] || '').trim();
      tierCounts[tier] = (tierCounts[tier] || 0) + 1;

      if (matchStatus !== 'MATCHED' && matchStatus !== 'MANUAL_MATCHED') {
        unmatchedCount++;
        continue;
      }

      if (gatewayStatus === 'REFUNDED' || gatewayStatus === 'PARTIAL_REFUNDED' || gatewayStatus === 'CHARGEBACK') {
        reversedCount++;
        continue;
      }

      const rawAmt = parseFloat(row[tMap && tMap.amount !== undefined ? tMap.amount : 6]) || 0;
      const grossAmt =
        tMap && tMap.gross_amount !== undefined && row[tMap.gross_amount] !== ''
          ? parseFloat(row[tMap.gross_amount]) || rawAmt
          : rawAmt;
      const feeAmt =
        tMap && tMap.gateway_fee !== undefined && row[tMap.gateway_fee] !== ''
          ? parseFloat(row[tMap.gateway_fee]) || 0
          : 0;
      const netAmt =
        tMap && tMap.net_amount !== undefined && row[tMap.net_amount] !== ''
          ? parseFloat(row[tMap.net_amount]) || grossAmt - feeAmt
          : grossAmt - feeAmt;

      const bank = String(row[tMap && tMap.bank !== undefined ? tMap.bank : 3] || 'UNKNOWN').trim();
      const channel =
        tMap && tMap.payment_channel !== undefined && String(row[tMap.payment_channel] || '').trim()
          ? String(row[tMap.payment_channel]).trim().toUpperCase()
          : 'MANUAL_TRANSFER';
      const program = String(row[tMap && tMap.program !== undefined ? tMap.program : 15] || 'Umum').trim();

      totalGross += grossAmt;
      totalFee += feeAmt;
      totalNet += netAmt;
      confirmedCount++;

      bankAmounts[bank] = (bankAmounts[bank] || 0) + netAmt;
      channelBreakdown[channel] = (channelBreakdown[channel] || 0) + netAmt;
      programBreakdown[program] = (programBreakdown[program] || 0) + netAmt;
    }
  }

  // Count user demographics
  let alumniCount = 0;
  let guestCount = 0;
  let verifiedAlumniCount = 0;

  if (userSheet && userSheet.getLastRow() > 1) {
    const uMap = typeof getHeaderMap_ === 'function' ? getHeaderMap_(userSheet) : null;
    const users = userSheet.getDataRange().getValues();
    for (let u = 1; u < users.length; u++) {
      const role = users[u][uMap && uMap.role !== undefined ? uMap.role : 4];
      const verif = users[u][uMap && uMap.verification_status !== undefined ? uMap.verification_status : 6];
      if (role === 'ALUMNI') alumniCount++;
      if (role === 'GUEST') guestCount++;
      if (typeof isApprovedVerificationStatus === 'function' ? isApprovedVerificationStatus(verif) : (verif === 'VERIFIED' || verif === 'APPROVED')) verifiedAlumniCount++;
    }
  }

  return {
    status: 'ok',
    total_gross: totalGross,
    total_fee: totalFee,
    total_net: totalNet,
    formatted_gross: formatRupiah(totalGross),
    formatted_fee: formatRupiah(totalFee),
    formatted_net: formatRupiah(totalNet),
    total_amount: totalNet,
    formatted_total: formatRupiah(totalNet),
    total_count: confirmedCount,
    unmatched_count: unmatchedCount,
    reversed_count: reversedCount,
    tier_distribution: tierCounts,
    channel_breakdown: channelBreakdown,
    bank_breakdown: bankAmounts,
    program_breakdown: programBreakdown,
    demographics: {
      registered_alumni: alumniCount,
      verified_alumni: verifiedAlumniCount,
      guests: guestCount
    }
  };
}

/**
 * Returns full transaction ledger and pending Midtrans Snap intents for Admin monitoring (Phase P7).
 * Supports filtering by payment_channel, status (match_status / gateway_status / email_status), and program_id.
 *
 * @param {string} adminToken - Valid administrator Google ID token.
 * @param {Object=} filters - Optional { channel, status, program_id }.
 * @returns {Object} { status, items, pending_midtrans_intents, summary }.
 */
function getAdminTransactions(adminToken, filters) {
  requireAdmin_(adminToken);

  const filterObj = filters && typeof filters === 'object' ? filters : {};
  const filterChannel = String(filterObj.channel || '').trim().toUpperCase();
  const filterStatus = String(filterObj.status || '').trim().toUpperCase();
  const filterProgramId = String(filterObj.program_id || '').trim().toUpperCase();

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const txSheet = ss.getSheetByName(SHEET_NAMES.TRANSACTIONS);
  const intentSheet = ss.getSheetByName(SHEET_NAMES.INTENTS);

  const items = [];
  let sumGross = 0;
  let sumFee = 0;
  let sumNet = 0;

  if (txSheet && txSheet.getLastRow() > 1) {
    const tMap = typeof getHeaderMap_ === 'function' ? getHeaderMap_(txSheet) : null;
    const rows = txSheet.getDataRange().getValues();
    for (let i = rows.length - 1; i >= 1; i--) {
      const r = rows[i];
      const matchStatus = String(r[tMap && tMap.match_status !== undefined ? tMap.match_status : 10] || '').trim().toUpperCase();
      const gatewayStatus =
        tMap && tMap.gateway_status !== undefined
          ? String(r[tMap.gateway_status] || '').trim().toUpperCase()
          : (matchStatus === 'UNMATCHED' ? 'UNMATCHED' : 'MANUAL_CONFIRMED');
      const paymentChannel =
        tMap && tMap.payment_channel !== undefined && String(r[tMap.payment_channel] || '').trim()
          ? String(r[tMap.payment_channel]).trim().toUpperCase()
          : 'MANUAL_TRANSFER';
      const programId =
        tMap && tMap.program_id !== undefined ? String(r[tMap.program_id] || '').trim().toUpperCase() : '';
      const emailStatus =
        tMap && tMap.email_status !== undefined ? String(r[tMap.email_status] || '').trim().toUpperCase() : '';

      if (filterChannel && paymentChannel !== filterChannel) continue;
      if (filterProgramId && programId !== filterProgramId) continue;
      if (
        filterStatus &&
        matchStatus !== filterStatus &&
        gatewayStatus !== filterStatus &&
        emailStatus !== filterStatus
      ) {
        continue;
      }

      const rawAmount = parseFloat(r[tMap && tMap.amount !== undefined ? tMap.amount : 6]) || 0;
      const grossAmt =
        tMap && tMap.gross_amount !== undefined && r[tMap.gross_amount] !== ''
          ? parseFloat(r[tMap.gross_amount]) || rawAmount
          : rawAmount;
      const feeAmt =
        tMap && tMap.gateway_fee !== undefined && r[tMap.gateway_fee] !== ''
          ? parseFloat(r[tMap.gateway_fee]) || 0
          : 0;
      const netAmt =
        tMap && tMap.net_amount !== undefined && r[tMap.net_amount] !== ''
          ? parseFloat(r[tMap.net_amount]) || grossAmt - feeAmt
          : grossAmt - feeAmt;

      const isVerifiedConfirmed =
        (matchStatus === 'MATCHED' || matchStatus === 'MANUAL_MATCHED') &&
        gatewayStatus !== 'REFUNDED' &&
        gatewayStatus !== 'PARTIAL_REFUNDED' &&
        gatewayStatus !== 'CHARGEBACK';
      if (isVerifiedConfirmed) {
        sumGross += grossAmt;
        sumFee += feeAmt;
        sumNet += netAmt;
      }

      items.push({
        tx_id: String(r[tMap && tMap.tx_id !== undefined ? tMap.tx_id : 0] || '').trim(),
        date: String(r[tMap && tMap.tx_date !== undefined ? tMap.tx_date : 5] || r[tMap && tMap.received_at !== undefined ? tMap.received_at : 2] || ''),
        ref_code: String(r[tMap && tMap.ref_code !== undefined ? tMap.ref_code : 13] || '').trim(),
        donor_type: tMap && tMap.donor_type !== undefined ? String(r[tMap.donor_type] || '').trim() : '',
        donor_name: String(r[tMap && tMap.donor_display_name !== undefined ? tMap.donor_display_name : 9] || ''),
        payment_channel: paymentChannel,
        bank: String(r[tMap && tMap.bank !== undefined ? tMap.bank : 3] || '').trim(),
        program: String(r[tMap && tMap.program !== undefined ? tMap.program : 15] || 'Umum').trim(),
        program_id: programId,
        gross_amount: grossAmt,
        gateway_fee: feeAmt,
        net_amount: netAmt,
        formatted_amount: formatRupiah(netAmt),
        match_status: matchStatus,
        match_tier: String(r[tMap && tMap.match_tier !== undefined ? tMap.match_tier : 11] || ''),
        gateway_order_id: tMap && tMap.gateway_order_id !== undefined ? String(r[tMap.gateway_order_id] || '').trim() : '',
        gateway_transaction_id: tMap && tMap.gateway_transaction_id !== undefined ? String(r[tMap.gateway_transaction_id] || '').trim() : '',
        gateway_status: gatewayStatus,
        receipt_no: tMap && tMap.receipt_no !== undefined ? String(r[tMap.receipt_no] || '').trim() : '',
        email_status: emailStatus,
        email_error: tMap && tMap.email_error !== undefined ? String(r[tMap.email_error] || '').trim() : ''
      });
    }
  }

  // Collect PENDING Midtrans Snap intents so Admin UI can monitor & trigger syncMidtransIntentStatusAdmin
  const pendingMidtransIntents = [];
  if (intentSheet && intentSheet.getLastRow() > 1) {
    const iMap = typeof getHeaderMap_ === 'function' ? getHeaderMap_(intentSheet) : null;
    if (iMap && iMap.payment_channel !== undefined && iMap.midtrans_order_id !== undefined) {
      const iRows = intentSheet.getDataRange().getValues();
      for (let j = iRows.length - 1; j >= 1; j--) {
        const ir = iRows[j];
        const iChannel = String(ir[iMap.payment_channel] || '').trim().toUpperCase();
        const iStatus = String(ir[iMap.status] || '').trim().toUpperCase();
        if (iChannel === 'MIDTRANS_SNAP' && iStatus === 'PENDING') {
          pendingMidtransIntents.push({
            intent_id: String(ir[iMap.intent_id] || '').trim(),
            order_id: String(ir[iMap.midtrans_order_id] || '').trim(),
            ref_code: String(ir[iMap.ref_code] || '').trim(),
            amount: parseFloat(ir[iMap.amount]) || 0,
            formatted_amount: formatRupiah(parseFloat(ir[iMap.amount]) || 0),
            program: String(ir[iMap.program] || '').trim(),
            program_id: iMap.program_id !== undefined ? String(ir[iMap.program_id] || '').trim() : '',
            created_at: String(ir[iMap.created_at] || ''),
            expires_at: String(ir[iMap.expires_at] || '')
          });
        }
      }
    }
  }

  return {
    status: 'ok',
    items: items,
    pending_midtrans_intents: pendingMidtransIntents,
    summary: {
      count: items.length,
      total_gross: sumGross,
      total_fee: sumFee,
      total_net: sumNet,
      formatted_gross: formatRupiah(sumGross),
      formatted_fee: formatRupiah(sumFee),
      formatted_net: formatRupiah(sumNet)
    }
  };
}

/**
 * Synchronizes a Midtrans Snap donation intent status on demand for Admin monitoring.
 * Queries Midtrans Core API GET /v2/{order_id}/status and runs the idempotent finalizer if settled.
 *
 * @param {string} adminToken - Valid administrator Google ID token.
 * @param {string} intentId - Target donation_intents.intent_id.
 * @returns {Object} Synchronization report.
 */
function syncMidtransIntentStatusAdmin(adminToken, intentId) {
  const profile = requireAdmin_(adminToken);
  const targetIntentId = String(intentId || '').trim();
  if (!targetIntentId) {
    throw new Error('Missing intent_id parameter.');
  }

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const intentSheet = ss.getSheetByName(SHEET_NAMES.INTENTS);
  if (!intentSheet || intentSheet.getLastRow() <= 1) {
    throw new Error('Donation intent tidak ditemukan.');
  }

  const hMap = getHeaderMap_(intentSheet);
  const rows = intentSheet.getDataRange().getValues();
  let targetRow = null;

  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][hMap.intent_id] || '').trim() === targetIntentId) {
      targetRow = rows[i];
      break;
    }
  }

  if (!targetRow) {
    throw new Error('Donation intent "' + targetIntentId + '" tidak ditemukan.');
  }

  const channel =
    hMap.payment_channel !== undefined ? String(targetRow[hMap.payment_channel] || '').trim().toUpperCase() : '';
  const orderId =
    hMap.midtrans_order_id !== undefined ? String(targetRow[hMap.midtrans_order_id] || '').trim() : '';

  if (channel !== 'MIDTRANS_SNAP' || !orderId) {
    throw new Error('Intent ini bukan transaksi Midtrans Snap atau belum memiliki midtrans_order_id.');
  }

  const beforeStatus = String(targetRow[hMap.status] || '').trim().toUpperCase();
  const inquiryData = queryMidtransTransactionStatus_(orderId);
  const syncRes = processMidtransStatusUpdate_(inquiryData, 'ADMIN_SYNC:' + profile.email);
  const afterStatus = String(syncRes.intent_status || beforeStatus).toUpperCase();

  logAudit_(
    profile.email,
    'ADMIN_SYNC_MIDTRANS',
    targetIntentId,
    'order=' + orderId + ' before=' + beforeStatus + ' after=' + afterStatus + ' gw=' + (syncRes.gateway_status || '')
  );

  return {
    status: 'ok',
    intent_id: targetIntentId,
    order_id: orderId,
    intent_status: afterStatus,
    gateway_status: syncRes.gateway_status || '',
    updated: beforeStatus !== afterStatus || syncRes.action_taken === 'confirmed_and_recorded' || syncRes.self_healed === true,
    tx_id: syncRes.tx_id || null,
    receipt_no: syncRes.receipt_no || ''
  };
}

/**
 * Safely retries sending a donation confirmation/receipt email for a confirmed transaction
 * whose email_status is currently FAILED or PENDING (State Machine 4).
 * Rejects transactions that are already SENT, UNMATCHED, REFUNDED, or missing receipt_no.
 *
 * @param {string} adminToken - Valid administrator Google ID token.
 * @param {string} txId - Target transactions.tx_id.
 * @returns {Object} Updated email dispatch status report.
 */
function retryTransactionEmail(adminToken, txId) {
  const profile = requireAdmin_(adminToken);
  const targetTxId = String(txId || '').trim();
  if (!targetTxId) {
    throw new Error('Missing tx_id parameter.');
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(15000);

  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const txSheet = ss.getSheetByName(SHEET_NAMES.TRANSACTIONS);
    if (!txSheet || txSheet.getLastRow() <= 1) {
      throw new Error('Data transaksi tidak ditemukan.');
    }

    const tMap = getHeaderMap_(txSheet);
    if (tMap.email_status === undefined || tMap.receipt_no === undefined) {
      throw new Error("Schema error: Kolom 'email_status' atau 'receipt_no' belum tersedia pada sheet transactions.");
    }

    const rows = txSheet.getDataRange().getValues();
    let targetRowIdx1 = -1;
    let row = null;

    for (let i = 1; i < rows.length; i++) {
      if (String(rows[i][tMap.tx_id] || '').trim() === targetTxId) {
        targetRowIdx1 = i + 1;
        row = rows[i];
        break;
      }
    }

    if (targetRowIdx1 === -1 || !row) {
      throw new Error('Transaksi "' + targetTxId + '" tidak ditemukan.');
    }

    const matchStatus = String(row[tMap.match_status] || '').trim().toUpperCase();
    if (matchStatus !== 'MATCHED' && matchStatus !== 'MANUAL_MATCHED') {
      throw new Error('Retry email ditolak: Transaksi belum terkonfirmasi (status: ' + matchStatus + ').');
    }

    const gatewayStatus =
      tMap.gateway_status !== undefined ? String(row[tMap.gateway_status] || '').trim().toUpperCase() : '';
    if (gatewayStatus === 'REFUNDED' || gatewayStatus === 'PARTIAL_REFUNDED' || gatewayStatus === 'CHARGEBACK') {
      throw new Error('Retry email ditolak: Transaksi telah berstatus ' + gatewayStatus + '.');
    }

    const receiptNo = String(row[tMap.receipt_no] || '').trim();
    if (!receiptNo) {
      throw new Error('Retry email ditolak: Transaksi belum memiliki nomor kuitansi (receipt_no).');
    }

    const currentEmailStatus = String(row[tMap.email_status] || '').trim().toUpperCase();
    if (currentEmailStatus === 'SENT') {
      throw new Error('Retry email ditolak: Email kuitansi untuk transaksi ini sudah berstatus SENT.');
    }
    if (currentEmailStatus !== 'FAILED' && currentEmailStatus !== 'PENDING') {
      throw new Error('Retry email hanya diizinkan untuk status FAILED atau PENDING (status saat ini: ' + currentEmailStatus + ').');
    }

    const refCode = String(row[tMap.ref_code] || '').trim().toUpperCase();
    let recipientEmail = tMap.donor_email !== undefined ? String(row[tMap.donor_email] || '').trim() : '';
    let recipientName = String(row[tMap.donor_name_raw] || '').trim() || 'Donatur IKA UPI';

    if (!recipientEmail && refCode) {
      const usersByRef = getUsersMapByRefCode_();
      if (usersByRef.has(refCode)) {
        recipientEmail = usersByRef.get(refCode).email || '';
        recipientName = usersByRef.get(refCode).full_name || recipientName;
      }
    }

    if (!recipientEmail) {
      throw new Error('Alamat email donatur tidak ditemukan untuk transaksi "' + targetTxId + '".');
    }

    const mailOut = sendDonorDonationReceivedEmail_({
      to_email: recipientEmail,
      full_name: recipientName,
      ref_code: refCode,
      amount: parseFloat(row[tMap.amount]) || 0,
      bank: String(row[tMap.bank] || ''),
      date: String(row[tMap.tx_date] || ''),
      program: String(row[tMap.program] || 'Beasiswa Alumni UPI'),
      receipt_no: receiptNo
    });

    if (mailOut && mailOut.sent === false) {
      const errStr = String(mailOut.error || 'MailApp error').slice(0, 200);
      txSheet.getRange(targetRowIdx1, tMap.email_status + 1).setValue('FAILED');
      if (tMap.email_error !== undefined) {
        txSheet.getRange(targetRowIdx1, tMap.email_error + 1).setValue(errStr);
      }
      logAudit_(profile.email, 'RETRY_TX_EMAIL_FAILED', targetTxId, 'receipt=' + receiptNo + ' err=' + errStr);
      return {
        status: 'ok',
        tx_id: targetTxId,
        receipt_no: receiptNo,
        email_status: 'FAILED',
        email_error: errStr
      };
    }

    const sentAt = new Date().toISOString();
    txSheet.getRange(targetRowIdx1, tMap.email_status + 1).setValue('SENT');
    if (tMap.email_sent_at !== undefined) {
      txSheet.getRange(targetRowIdx1, tMap.email_sent_at + 1).setValue(sentAt);
    }
    if (tMap.email_error !== undefined) {
      txSheet.getRange(targetRowIdx1, tMap.email_error + 1).setValue('');
    }

    logAudit_(profile.email, 'RETRY_TX_EMAIL', targetTxId, 'receipt=' + receiptNo + ' status=SENT');

    return {
      status: 'ok',
      tx_id: targetTxId,
      receipt_no: receiptNo,
      email_status: 'SENT',
      email_sent_at: sentAt,
      email_error: ''
    };
  } finally {
    lock.releaseLock();
  }
}



