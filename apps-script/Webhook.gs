/**
 * Webhook.gs
 * Webhook receiver for incoming bank mutasi records.
 * Integrates 3-tier matching, deduplication idempotency, donor email alerts, and admin notifications.
 */

/**
 * Handles incoming multi-bank mutation payload from aggregator or simulator.
 * 
 * @param {Array<Object>} mutations - Array of incoming mutation payload items.
 * @returns {Object} Processing statistics.
 */
function handleWebhookMutations_(mutations) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000); // Wait up to 30s to serialize batch mutations

  let inserted = 0;
  let duplicates = 0;
  let matchedCount = 0;
  let unmatchedCount = 0;
  let ignoredDebit = 0;

  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const txSheet = ss.getSheetByName(SHEET_NAMES.TRANSACTIONS);
    const intentSheet = ss.getSheetByName(SHEET_NAMES.INTENTS);
    const queueSheet = ss.getSheetByName(SHEET_NAMES.REVIEW_QUEUE);

    const existingMutationIds = getExistingMutationIds_(txSheet);
    const usersByRef = getUsersMapByRefCode_();
    const pendingIntents = getPendingIntentsList_(intentSheet);
    const keywordMap = getKeywordDictionary_();
    const windowHours = parseInt(getConfig_('MATCH_WINDOW_HOURS') || '24', 10);

    const txRowsToAppend = [];
    const queueRowsToAppend = [];
    const matchedIntentsToUpdate = [];
    const donorNotifications = [];
    const adminAlerts = [];

    const now = new Date();

    for (let i = 0; i < mutations.length; i++) {
      const item = mutations[i];
      const type = (item.type || 'CR').toUpperCase();
      if (type !== 'CR') {
        ignoredDebit++;
        continue;
      }

      const mutationId = String(item.mutation_id || item.id || generateFallbackId_(item)).trim();
      if (existingMutationIds.has(mutationId)) {
        duplicates++;
        continue;
      }

      existingMutationIds.add(mutationId);
      const txId = 'TX_' + Utilities.getUuid().substring(0, 8);
      const bank = (item.bank || 'UNKNOWN').toUpperCase();
      const amount = parseFloat(item.amount) || 0;
      const desc = String(item.description || '').trim();
      const txDate = item.transaction_date || Utilities.formatDate(now, 'Asia/Jakarta', 'yyyy-MM-dd HH:mm:ss');
      const accountMasked = item.account_number_masked || maskAccountNumber(item.account_number);

      const rawDonorName = parseDonorName(bank, desc);
      const displayDonorName = maskDonorName(rawDonorName);
      const program = detectProgram(desc, keywordMap);

      // Perform 3-Tier Matcher logic
      const matchResult = matchTransaction({
        bank: bank,
        amount: amount,
        description: desc,
        tx_date: txDate
      }, {
        usersByRefCode: usersByRef,
        pendingIntents: pendingIntents,
        windowHours: windowHours,
        now: now
      });

      let matchStatus = matchResult.status;
      let matchTier = matchResult.tier;
      let matchedUserId = matchResult.user_id || '';
      let matchedRefCode = matchResult.ref_code || '';
      let matchedIntentId = matchResult.intent_id || '';

      if (matchStatus === 'MATCHED') {
        matchedCount++;
        if (matchedIntentId) {
          matchedIntentsToUpdate.push({ intent_id: matchedIntentId, tx_id: txId });
        }
        // Prepare donor notification email
        if (matchResult.user && matchResult.user.email) {
          donorNotifications.push({
            to_email: matchResult.user.email,
            full_name: matchResult.user.full_name,
            ref_code: matchedRefCode,
            amount: amount,
            bank: bank,
            date: txDate,
            program: program
          });
        }
      } else {
        // Tier 3: Route to Review Queue
        unmatchedCount++;
        const queueId = 'REV_' + Utilities.getUuid().substring(0, 8);
        queueRowsToAppend.push([
          queueId,
          txId,
          bank,
          amount,
          txDate,
          desc,
          matchResult.reason,
          matchResult.candidates_count || 0,
          'PENDING',
          '', '', '', ''
        ]);
      }

      // Record transaction
      txRowsToAppend.push([
        txId,
        mutationId,
        now.toISOString(),
        bank,
        accountMasked,
        txDate,
        amount,
        desc,                 // Stored in private spreadsheet
        rawDonorName,
        displayDonorName,
        matchStatus,
        matchTier,
        matchedUserId,
        matchedRefCode,
        matchedIntentId,
        program,
        'NO'                  // is_anonymous
      ]);

      adminAlerts.push({
        bank: bank,
        amount: amount,
        donor: displayDonorName,
        ref_code: matchedRefCode || 'BELUM TERIDENTIFIKASI',
        status: matchStatus,
        tier: matchTier
      });

      inserted++;
    }

    // Batch append to transactions
    if (txRowsToAppend.length > 0) {
      const startRow = txSheet.getLastRow() + 1;
      txSheet.getRange(startRow, 1, txRowsToAppend.length, txRowsToAppend[0].length).setValues(txRowsToAppend);
    }

    // Batch append to review queue
    if (queueRowsToAppend.length > 0) {
      const qStart = queueSheet.getLastRow() + 1;
      queueSheet.getRange(qStart, 1, queueRowsToAppend.length, queueRowsToAppend[0].length).setValues(queueRowsToAppend);
    }

    // Update matched intents to MATCHED status
    if (matchedIntentsToUpdate.length > 0) {
      updateMatchedIntentsBatch_(intentSheet, matchedIntentsToUpdate);
    }

    // Send donor notification emails
    for (let d = 0; d < donorNotifications.length; d++) {
      sendDonorDonationReceivedEmail_(donorNotifications[d]);
    }

    // Send admin real-time summary notification
    if (adminAlerts.length > 0) {
      sendAdminDonationAlert_(adminAlerts);
    }

  } finally {
    lock.releaseLock();
  }

  return {
    inserted: inserted,
    duplicates: duplicates,
    matched: matchedCount,
    unmatched: unmatchedCount,
    ignored_debit: ignoredDebit
  };
}

/**
 * Builds existing mutation IDs set to guarantee idempotency.
 */
function getExistingMutationIds_(sheet) {
  const lastRow = sheet.getLastRow();
  const idSet = new Set();
  if (lastRow <= 1) return idSet;
  const ids = sheet.getRange(2, 2, lastRow - 1, 1).getValues();
  for (let i = 0; i < ids.length; i++) {
    const val = String(ids[i][0]).trim();
    if (val) idSet.add(val);
  }
  return idSet;
}

/**
 * Returns a Map of users keyed by their ref_code.
 */
function getUsersMapByRefCode_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_NAMES.USERS);
  const map = new Map();
  if (!sheet || sheet.getLastRow() <= 1) return map;

  const data = sheet.getRange(2, 1, sheet.getLastRow() - 1, 9).getValues();
  for (let i = 0; i < data.length; i++) {
    const refCode = String(data[i][5] || '').trim().toUpperCase();
    if (refCode) {
      map.set(refCode, {
        user_id: data[i][0],
        email: data[i][2],
        full_name: data[i][3],
        role: data[i][4],
        ref_code: refCode,
        verification_status: data[i][6]
      });
    }
  }
  return map;
}

/**
 * Returns array of currently PENDING donation intents.
 */
function getPendingIntentsList_(sheet) {
  const list = [];
  if (!sheet || sheet.getLastRow() <= 1) return list;
  const data = sheet.getRange(2, 1, sheet.getLastRow() - 1, 10).getValues();
  for (let i = 0; i < data.length; i++) {
    if (data[i][6] === 'PENDING') {
      list.push({
        intent_id: data[i][0],
        user_id: data[i][1],
        ref_code: data[i][2],
        amount: parseFloat(data[i][3]) || 0,
        bank: data[i][4],
        program: data[i][5],
        status: data[i][6],
        created_at: data[i][7]
      });
    }
  }
  return list;
}

/**
 * Updates status of matched intents in donation_intents sheet.
 */
function updateMatchedIntentsBatch_(sheet, updates) {
  const updateMap = new Map();
  updates.forEach(u => updateMap.set(u.intent_id, u.tx_id));

  const lastRow = sheet.getLastRow();
  if (lastRow <= 1) return;

  const ids = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i][0];
    if (updateMap.has(id)) {
      const rowIdx = i + 2;
      sheet.getRange(rowIdx, 7).setValue('MATCHED'); // status at col 7
      sheet.getRange(rowIdx, 10).setValue(updateMap.get(id)); // matched_tx_id at col 10
    }
  }
}

/**
 * Generates fallback mutation id if sender didn't include one.
 */
function generateFallbackId_(item) {
  const seed = (item.bank || '') + '_' + (item.amount || '') + '_' + (item.transaction_date || '') + '_' + (item.description || '');
  return Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, seed)).substring(0, 16);
}

