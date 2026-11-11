/**
 * Admin.gs
 * Sensitive operational endpoints: verifications list, review queue manual resolution, and insights.
 */

/**
 * Returns pending and recent alumni verifications for Admin view.
 */
function getAdminVerifications(adminToken) {
  const profile = verifyIdToken(adminToken);
  if (!isAdminEmail_(profile.email)) throw new Error('Akses admin ditolak.');

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_NAMES.VERIFICATIONS);
  const list = [];
  if (!sheet || sheet.getLastRow() <= 1) return { status: 'ok', items: [] };

  const data = sheet.getRange(2, 1, sheet.getLastRow() - 1, 13).getValues();
  for (let i = 0; i < data.length; i++) {
    const row = data[i];
    list.push({
      verif_id: row[0],
      user_id: row[1],
      email: row[2],
      full_name: row[3],
      nim: row[4],
      grad_year: row[5],
      faculty: row[6],
      has_file: Boolean(row[7]),
      file_id: row[7],
      status: row[8],
      submitted_at: row[9],
      reviewed_by: row[10],
      reviewed_at: row[11],
      reject_reason: row[12]
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
  const profile = verifyIdToken(adminToken);
  if (!isAdminEmail_(profile.email)) throw new Error('Akses admin ditolak.');

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
 * Manually links an unmatched transaction from review queue to a specific user/ref_code.
 */
function resolveReviewQueueItem(adminToken, queueId, targetRefCode) {
  const profile = verifyIdToken(adminToken);
  if (!isAdminEmail_(profile.email)) throw new Error('Akses admin ditolak.');

  const targetCode = String(targetRefCode || '').trim().toUpperCase();
  const usersByRef = getUsersMapByRefCode_();
  if (!usersByRef.has(targetCode)) {
    throw new Error('Kode referensi donatur "' + targetCode + '" tidak terdaftar di sistem.');
  }
  const targetUser = usersByRef.get(targetCode);

  const ss = SpreadsheetApp.getActiveSpreadsheet();
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
    targetUser.user_id,
    targetCode
  ]]);

  // 2. Update transaction record
  let txAmount = 0;
  let txBank = '';
  let txDate = '';
  let txProgram = 'Umum';

  const txData = txSheet.getRange(2, 1, txSheet.getLastRow() - 1, 17).getValues();
  for (let j = 0; j < txData.length; j++) {
    if (txData[j][0] === targetTxId) {
      const txRowIdx = j + 2;
      txAmount = txData[j][6];
      txBank = txData[j][3];
      txDate = txData[j][5];
      txProgram = txData[j][15];

      // Update match_status (col 11), match_tier (col 12), user_id (col 13), ref_code (col 14)
      txSheet.getRange(txRowIdx, 11).setValue('MANUAL_MATCHED');
      txSheet.getRange(txRowIdx, 12).setValue('MANUAL');
      txSheet.getRange(txRowIdx, 13).setValue(targetUser.user_id);
      txSheet.getRange(txRowIdx, 14).setValue(targetCode);
      break;
    }
  }

  // 3. Send confirmation email to the linked donor
  sendDonorDonationReceivedEmail_({
    to_email: targetUser.email,
    full_name: targetUser.full_name,
    ref_code: targetCode,
    amount: txAmount,
    bank: txBank,
    date: txDate,
    program: txProgram
  });

  logAudit_(profile.email, 'MANUAL_MATCH', targetTxId, 'Assigned to ' + targetCode + ' via queue ' + queueId);

  return {
    status: 'ok',
    queue_id: queueId,
    tx_id: targetTxId,
    assigned_ref_code: targetCode
  };
}

/**
 * Admin insights: totals, breakdown by faculty, graduation year, matching accuracy tiers.
 */
function getAdminInsights(adminToken) {
  const profile = verifyIdToken(adminToken);
  if (!isAdminEmail_(profile.email)) throw new Error('Akses admin ditolak.');

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const txSheet = ss.getSheetByName(SHEET_NAMES.TRANSACTIONS);
  const userSheet = ss.getSheetByName(SHEET_NAMES.USERS);
  const verifSheet = ss.getSheetByName(SHEET_NAMES.VERIFICATIONS);

  let totalAmount = 0;
  let totalCount = 0;
  const tierCounts = { 1: 0, 2: 0, 3: 0, 'MANUAL': 0 };
  const bankAmounts = {};

  if (txSheet && txSheet.getLastRow() > 1) {
    const txs = txSheet.getRange(2, 1, txSheet.getLastRow() - 1, 17).getValues();
    for (let i = 0; i < txs.length; i++) {
      const amt = parseFloat(txs[i][6]) || 0;
      const bank = txs[i][3];
      const tier = String(txs[i][11]);
      totalAmount += amt;
      totalCount++;
      bankAmounts[bank] = (bankAmounts[bank] || 0) + amt;
      tierCounts[tier] = (tierCounts[tier] || 0) + 1;
    }
  }

  // Count user demographics
  let alumniCount = 0;
  let guestCount = 0;
  let verifiedAlumniCount = 0;

  if (userSheet && userSheet.getLastRow() > 1) {
    const users = userSheet.getRange(2, 1, userSheet.getLastRow() - 1, 9).getValues();
    for (let u = 0; u < users.length; u++) {
      const role = users[u][4];
      const verif = users[u][6];
      if (role === 'ALUMNI') alumniCount++;
      if (role === 'GUEST') guestCount++;
      if (verif === 'VERIFIED') verifiedAlumniCount++;
    }
  }

  return {
    status: 'ok',
    total_amount: totalAmount,
    formatted_total: formatRupiah(totalAmount),
    total_count: totalCount,
    tier_distribution: tierCounts,
    bank_breakdown: bankAmounts,
    demographics: {
      registered_alumni: alumniCount,
      verified_alumni: verifiedAlumniCount,
      guests: guestCount
    }
  };
}

