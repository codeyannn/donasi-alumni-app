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
    const claimedIntentIds = new Set();

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

      // Perform 3-Tier Matcher logic (supports both Alumni users and non-account Guest intents)
      const matchResult = matchTransaction({
        bank: bank,
        amount: amount,
        description: desc,
        tx_date: txDate
      }, {
        usersByRefCode: usersByRef,
        pendingIntents: pendingIntents,
        windowHours: windowHours,
        now: now,
        claimedIntentIds: claimedIntentIds
      });

      let matchStatus = matchResult.status;
      let matchTier = matchResult.tier;
      let matchedUserId = matchResult.user_id || '';
      let matchedRefCode = matchResult.ref_code || '';
      let matchedIntentId = matchResult.intent_id || '';

      // P1.1: Preserve explicit donor anonymity from intent; separate from failed name parsing (OPEN-02)
      const isAnonymous =
        matchResult.intent &&
        (String(matchResult.intent.is_anonymous || '').toUpperCase() === 'YES' ||
          getIntentAnonBridge_(matchResult.intent.intent_id) === 'YES')
          ? 'YES'
          : 'NO';
      const displayDonorName = maskDonorName(rawDonorName, isAnonymous === 'YES');

      // P1.2: Preserve donor-selected program from matched intent; use detectProgram only as fallback
      const intentProgram =
        matchStatus === 'MATCHED' && matchResult.intent && matchResult.intent.program
          ? String(matchResult.intent.program).trim()
          : '';
      const program = intentProgram || detectProgram(desc, keywordMap);
      const programId =
        matchStatus === 'MATCHED' && matchResult.intent && matchResult.intent.program_id
          ? String(matchResult.intent.program_id).trim()
          : '';
      const donorEmail =
        (matchResult.user && matchResult.user.email) ||
        (matchResult.intent && matchResult.intent.donor_email) ||
        '';
      const donorFullName =
        (matchResult.user && matchResult.user.full_name) ||
        (matchResult.intent && matchResult.intent.donor_name) ||
        rawDonorName ||
        'Donatur IKA UPI';
      const donorType =
        (matchResult.intent && matchResult.intent.donor_type) ||
        (/^G/i.test(matchedRefCode) ? 'GUEST' : matchedRefCode ? 'ALUMNI' : '');
      const intentTokenHash =
        (matchResult.intent && matchResult.intent.access_token_hash) || '';
      const intentTokenExp =
        (matchResult.intent && matchResult.intent.access_token_expires_at) || '';

      let receiptNo = '';
      let receiptIssuedAt = '';

      if (matchStatus === 'MATCHED') {
        matchedCount++;
        // Issue official receipt_no strictly for confirmed MATCHED transactions
        if (typeof allocateNextReceiptNo_ === 'function') {
          receiptNo = allocateNextReceiptNo_(ss, now);
          receiptIssuedAt = now.toISOString();
        }
        if (matchedIntentId) {
          claimedIntentIds.add(matchedIntentId);
          matchedIntentsToUpdate.push({ intent_id: matchedIntentId, tx_id: txId });
        }
        // Prepare donor notification email (for both Alumni and Guest with email)
        if (donorEmail) {
          donorNotifications.push({
            tx_offset: txRowsToAppend.length,
            to_email: donorEmail,
            full_name: donorFullName,
            ref_code: matchedRefCode,
            amount: amount,
            bank: bank,
            date: txDate,
            program: program,
            receipt_no: receiptNo
          });
        }
      } else {
        // Tier 3: Route to Review Queue (strictly never issues receipt_no)
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

      // Record transaction (write-ahead before intent closure; supports V1 17-col and V2 35-col schemas)
      txRowsToAppend.push(
        buildTransactionRowByHeader_(txSheet, {
          tx_id: txId,
          mutation_id: mutationId,
          received_at: now.toISOString(),
          bank: bank,
          account_masked: accountMasked,
          tx_date: txDate,
          amount: amount,
          description: desc,
          donor_name_raw: rawDonorName,
          donor_display_name: displayDonorName,
          match_status: matchStatus,
          match_tier: matchTier,
          user_id: matchedUserId,
          ref_code: matchedRefCode,
          intent_id: matchedIntentId,
          program: program,
          is_anonymous: isAnonymous,
          donor_type: donorType,
          donor_email: donorEmail,
          program_id: programId,
          payment_channel: 'MANUAL_TRANSFER',
          gateway_order_id: '',
          gateway_transaction_id: '',
          gateway_payment_type: 'manual_bank_transfer',
          gateway_status: matchStatus === 'MATCHED' ? 'MANUAL_CONFIRMED' : 'UNMATCHED',
          gross_amount: amount,
          gateway_fee: 0,
          net_amount: amount,
          receipt_no: receiptNo,
          receipt_issued_at: receiptIssuedAt,
          access_token_hash: intentTokenHash,
          access_token_expires_at: intentTokenExp,
          email_status: matchStatus === 'MATCHED' && donorEmail ? 'PENDING' : 'NOT_APPLICABLE',
          email_sent_at: '',
          email_error: ''
        })
      );

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
    let txStartRow = -1;
    if (txRowsToAppend.length > 0) {
      txStartRow = txSheet.getLastRow() + 1;
      txSheet.getRange(txStartRow, 1, txRowsToAppend.length, txRowsToAppend[0].length).setValues(txRowsToAppend);
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

    if (matchedCount > 0 && typeof invalidatePublicSummaryCache_ === 'function') {
      invalidatePublicSummaryCache_();
    }

    // Send donor notification emails and record email_status / email_sent_at / email_error in V2 columns
    const tMapAfter = typeof getHeaderMap_ === 'function' ? getHeaderMap_(txSheet) : null;
    for (let d = 0; d < donorNotifications.length; d++) {
      const notif = donorNotifications[d];
      const mailRes = sendDonorDonationReceivedEmail_(notif);
      if (txStartRow !== -1 && tMapAfter && tMapAfter.email_status !== undefined) {
        const targetTxRow1 = txStartRow + (notif.tx_offset || 0);
        if (mailRes && mailRes.sent === false) {
          txSheet.getRange(targetTxRow1, tMapAfter.email_status + 1).setValue('FAILED');
          if (tMapAfter.email_error !== undefined) {
            txSheet.getRange(targetTxRow1, tMapAfter.email_error + 1).setValue(String(mailRes.error || 'MailApp error').slice(0, 200));
          }
        } else {
          txSheet.getRange(targetTxRow1, tMapAfter.email_status + 1).setValue('SENT');
          if (tMapAfter.email_sent_at !== undefined) {
            txSheet.getRange(targetTxRow1, tMapAfter.email_sent_at + 1).setValue(new Date().toISOString());
          }
        }
      }
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
 * Reads temporary pre-P2 anonymity preference stored for a donation intent.
 */
function getIntentAnonBridge_(intentId) {
  if (!intentId) return 'NO';
  try {
    const val = PropertiesService.getScriptProperties().getProperty('INTENT_ANON_' + intentId);
    return String(val || 'NO').toUpperCase() === 'YES' ? 'YES' : 'NO';
  } catch (e) {
    return 'NO';
  }
}

/**
 * Returns array of currently PENDING donation intents (supports optional extended columns).
 */
function getPendingIntentsList_(sheet) {
  const list = [];
  if (!sheet || sheet.getLastRow() <= 1) return list;
  const hMap = typeof getHeaderMap_ === 'function' ? getHeaderMap_(sheet) : null;
  const idx = function (name, fallback) {
    return hMap && hMap[name] !== undefined ? hMap[name] : fallback;
  };
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (String(row[idx('status', 6)] || '').trim().toUpperCase() === 'PENDING') {
      const intentId = row[idx('intent_id', 0)];
      const anonColVal = hMap && hMap.is_anonymous !== undefined ? row[hMap.is_anonymous] : row[10];
      const isAnon = anonColVal
        ? String(anonColVal).trim().toUpperCase()
        : getIntentAnonBridge_(intentId);
      list.push({
        intent_id: intentId,
        user_id: row[idx('user_id', 1)],
        ref_code: row[idx('ref_code', 2)],
        amount: parseFloat(row[idx('amount', 3)]) || 0,
        bank: row[idx('bank', 4)],
        program: row[idx('program', 5)],
        program_id: hMap && hMap.program_id !== undefined ? String(row[hMap.program_id] || '').trim() : '',
        status: row[idx('status', 6)],
        created_at: row[idx('created_at', 7)],
        expires_at: row[idx('expires_at', 8)],
        is_anonymous: isAnon,
        payment_channel: hMap && hMap.payment_channel !== undefined ? String(row[hMap.payment_channel] || 'MANUAL_TRANSFER') : 'MANUAL_TRANSFER',
        donor_type: hMap && hMap.donor_type !== undefined ? String(row[hMap.donor_type] || '') : '',
        donor_name: hMap && hMap.donor_name !== undefined ? String(row[hMap.donor_name] || '') : (row[13] || ''),
        donor_email: hMap && hMap.donor_email !== undefined ? String(row[hMap.donor_email] || '') : (row[14] || ''),
        access_token_hash: hMap && hMap.access_token_hash !== undefined ? String(row[hMap.access_token_hash] || '') : '',
        access_token_expires_at:
          hMap && hMap.access_token_expires_at !== undefined ? String(row[hMap.access_token_expires_at] || '') : ''
      });
    }
  }
  return list;
}

/**
 * Updates status of matched intents in donation_intents sheet only if still PENDING.
 */
function updateMatchedIntentsBatch_(sheet, updates) {
  const updateMap = new Map();
  updates.forEach(u => updateMap.set(u.intent_id, u.tx_id));

  const lastRow = sheet.getLastRow();
  if (lastRow <= 1) return;

  const rows = sheet.getRange(2, 1, lastRow - 1, 7).getValues();
  for (let i = 0; i < rows.length; i++) {
    const id = rows[i][0];
    const currentStatus = String(rows[i][6] || '').toUpperCase();
    if (updateMap.has(id) && currentStatus === 'PENDING') {
      const rowIdx = i + 2;
      sheet.getRange(rowIdx, 7).setValue('MATCHED'); // status at col 7
      sheet.getRange(rowIdx, 10).setValue(updateMap.get(id)); // matched_tx_id at col 10
      try {
        PropertiesService.getScriptProperties().deleteProperty('INTENT_ANON_' + id);
      } catch (e) {}
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

/**
 * Builds a complete row array for the transactions sheet mapped by header names (V1 17-col or V2 35-col).
 *
 * @param {GoogleAppsScript.Spreadsheet.Sheet} txSheet - Target transactions sheet.
 * @param {Object} record - Key-value map matching transactions column headers.
 * @returns {Array} Ordered row values matching the sheet's actual header columns.
 */
function buildTransactionRowByHeader_(txSheet, record) {
  const colCount = Math.max(17, txSheet.getLastColumn ? txSheet.getLastColumn() : 17);
  const headers = txSheet.getRange(1, 1, 1, colCount).getValues()[0];
  const row = new Array(headers.length).fill('');
  for (let c = 0; c < headers.length; c++) {
    const key = String(headers[c] || '').trim();
    if (key && Object.prototype.hasOwnProperty.call(record, key) && record[key] !== undefined) {
      row[c] = record[key];
    }
  }
  return row;
}

/**
 * Handles incoming Midtrans server-to-server HTTP POST webhook notifications.
 * Verifies SHA-512 signature_key against ScriptProperties.MIDTRANS_SERVER_KEY before processing.
 *
 * @param {Object} payload - Raw JSON notification body from Midtrans.
 * @returns {Object} Structured processing result.
 */
function handleMidtransWebhook_(payload) {
  // Enforce fail-closed SHA-512 signature verification before acquiring lock
  verifyMidtransWebhookPayload_(payload);
  return processMidtransStatusUpdate_(payload, 'MIDTRANS_WEBHOOK');
}

/**
 * Processes a verified Midtrans transaction status payload (from Webhook or Active Status Inquiry).
 * Implements State Machine 1 (Intent), State Machine 3 (Gateway), State Machine 4 (Email),
 * and Self-Healing Write-Ahead persistence inside LockService.
 *
 * @param {Object} statusPayload - Verified Midtrans status object.
 * @param {string=} sourceLabel - Audit source ('MIDTRANS_WEBHOOK', 'ACTIVE_INQUIRY', 'ADMIN_SYNC').
 * @returns {Object} Processing summary { status, action_taken, order_id, intent_id, intent_status, gateway_status, tx_id, receipt_no }.
 */
function processMidtransStatusUpdate_(statusPayload, sourceLabel) {
  const payload = statusPayload || {};
  const source = String(sourceLabel || 'MIDTRANS_WEBHOOK');
  const orderId = String(payload.order_id || '').trim();
  if (!orderId) {
    throw new Error('Missing order_id in Midtrans status payload.');
  }

  const state = mapMidtransTransactionState(payload.transaction_status, payload.fraud_status);

  // If Active Inquiry received 404 before customer selected channel in Snap popup, keep PENDING without locking writes
  if (state.gateway_status === 'NOT_FOUND_404') {
    return {
      status: 'ok',
      action_taken: 'noop_not_found_404',
      order_id: orderId,
      intent_status: 'PENDING',
      gateway_status: 'NOT_FOUND_404'
    };
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const intentSheet = ss.getSheetByName(SHEET_NAMES.INTENTS);
    const txSheet = ss.getSheetByName(SHEET_NAMES.TRANSACTIONS);
    if (!intentSheet || !txSheet || intentSheet.getLastRow() <= 1) {
      return { status: 'ignored', reason: 'intent_sheet_empty', order_id: orderId };
    }

    const iMap = getHeaderMap_(intentSheet);
    const iData = intentSheet.getDataRange().getValues();
    let intentRowIdx1 = -1;
    let intentRow = null;

    for (let i = 1; i < iData.length; i++) {
      const rowOrderId =
        iMap.midtrans_order_id !== undefined ? String(iData[i][iMap.midtrans_order_id] || '').trim() : '';
      if (rowOrderId === orderId) {
        intentRowIdx1 = i + 1;
        intentRow = iData[i];
        break;
      }
    }

    if (intentRowIdx1 === -1 || !intentRow) {
      logAudit_('SYSTEM_MIDTRANS', 'MIDTRANS_UNKNOWN_ORDER', orderId, 'Ignored status update for unknown order_id (' + source + ').');
      return { status: 'ignored', reason: 'order_id_not_found', order_id: orderId };
    }

    const intentId = String(intentRow[iMap.intent_id] || '').trim();
    const currentIntentStatus = String(intentRow[iMap.status] || '').trim().toUpperCase();
    const expectedAmount = Math.round(parseFloat(intentRow[iMap.amount]) || 0);

    // Verify gross_amount matches the donation_intents nominal amount when gross_amount is present
    if (payload.gross_amount !== undefined && payload.gross_amount !== null && String(payload.gross_amount).trim() !== '') {
      const grossNum = Math.round(parseFloat(payload.gross_amount) || 0);
      if (grossNum !== expectedAmount) {
        logAudit_(
          'SYSTEM_MIDTRANS',
          'MIDTRANS_AMOUNT_MISMATCH',
          intentId,
          'Expected ' + expectedAmount + ' but received gross_amount=' + payload.gross_amount + ' for ' + orderId
        );
        throw new Error('Forbidden: Midtrans gross_amount mismatch against donation intent.');
      }
    }

    // Case 1: Reversal events (refund / partial_refund / chargeback) — mutate existing transaction gateway_status in-place
    if (state.is_reversal) {
      return applyMidtransReversalInPlace_(ss, txSheet, intentId, orderId, state.gateway_status, payload, source);
    }

    // Case 2: Confirmed settlement / capture(accept) -> Write-Ahead + Self-Healing Finalizer
    if (state.should_finalize_tx) {
      return recordConfirmedMidtransTransaction_(
        ss,
        intentSheet,
        txSheet,
        intentRowIdx1,
        iMap,
        intentRow,
        payload,
        state,
        source
      );
    }

    // Case 3: One-Way Terminal Protection — never downgrade MATCHED intent on late pending/expire/cancel/deny
    if (currentIntentStatus === 'MATCHED') {
      const matchedTxId = String(intentRow[iMap.matched_tx_id] || '').trim();
      return {
        status: 'ok',
        action_taken: 'noop_already_matched',
        order_id: orderId,
        intent_id: intentId,
        intent_status: 'MATCHED',
        gateway_status: 'SETTLED',
        tx_id: matchedTxId
      };
    }

    // Case 4: Terminal non-paid statuses (EXPIRED / CANCELLED / FAILED)
    if (state.is_terminal_failure && currentIntentStatus !== state.intent_status) {
      intentSheet.getRange(intentRowIdx1, iMap.status + 1).setValue(state.intent_status);
      logAudit_(
        'SYSTEM_MIDTRANS',
        'MIDTRANS_INTENT_' + state.intent_status,
        intentId,
        'order=' + orderId + ' via=' + source
      );
      return {
        status: 'ok',
        action_taken: 'intent_closed_' + state.intent_status.toLowerCase(),
        order_id: orderId,
        intent_id: intentId,
        intent_status: state.intent_status,
        gateway_status: state.gateway_status,
        receipt_no: ''
      };
    }

    // Case 5: Still PENDING or CHALLENGE (do not write final transaction or issue receipt_no)
    return {
      status: 'ok',
      action_taken: 'pending_or_challenge',
      order_id: orderId,
      intent_id: intentId,
      intent_status: currentIntentStatus || 'PENDING',
      gateway_status: state.gateway_status,
      receipt_no: ''
    };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Idempotent Write-Ahead + Self-Healing finalizer for confirmed Midtrans transactions.
 * Guarantees:
 * 1. Zero duplicate transaction rows on repeated/concurrent webhook + active inquiry calls.
 * 2. Self-healing update of donation_intents.status='MATCHED' if a prior run crashed after writing transactions.
 * 3. gateway_fee = 0 and net_amount = gross_amount in Sandbox mode (OPEN-03).
 * 4. Isolated email dispatch so MailApp failures never roll back confirmed transactions.
 */
function recordConfirmedMidtransTransaction_(
  ss,
  intentSheet,
  txSheet,
  intentRowIdx1,
  iMap,
  intentRow,
  payload,
  state,
  source
) {
  const orderId = String(payload.order_id || '').trim();
  const gatewayTxId = String(payload.transaction_id || '').trim();
  const mutationKey = 'MT_' + orderId;
  const intentId = String(intentRow[iMap.intent_id] || '').trim();
  const currentIntentStatus = String(intentRow[iMap.status] || '').trim().toUpperCase();

  const tMap = getHeaderMap_(txSheet);
  const tRows = txSheet.getDataRange().getValues();

  // Step 1: Check if transaction row already exists (by gateway_order_id, gateway_transaction_id, or mutation_id)
  let existingTxRowIdx1 = -1;
  let existingTxId = '';
  let existingReceiptNo = '';
  let existingEmailStatus = '';

  for (let i = 1; i < tRows.length; i++) {
    const rMutId = tMap.mutation_id !== undefined ? String(tRows[i][tMap.mutation_id] || '').trim() : '';
    const rOrderId = tMap.gateway_order_id !== undefined ? String(tRows[i][tMap.gateway_order_id] || '').trim() : '';
    const rGwTxId =
      tMap.gateway_transaction_id !== undefined ? String(tRows[i][tMap.gateway_transaction_id] || '').trim() : '';

    if (
      rMutId === mutationKey ||
      (orderId && rOrderId === orderId) ||
      (gatewayTxId && rGwTxId === gatewayTxId)
    ) {
      existingTxRowIdx1 = i + 1;
      existingTxId = String(tRows[i][tMap.tx_id] || '').trim();
      existingReceiptNo = tMap.receipt_no !== undefined ? String(tRows[i][tMap.receipt_no] || '').trim() : '';
      existingEmailStatus = tMap.email_status !== undefined ? String(tRows[i][tMap.email_status] || '').trim() : '';
      break;
    }
  }

  // Step 2: Self-Healing Write-Ahead Recovery if transaction row already exists
  if (existingTxRowIdx1 !== -1) {
    let selfHealed = false;
    if (currentIntentStatus !== 'MATCHED' || String(intentRow[iMap.matched_tx_id] || '').trim() !== existingTxId) {
      intentSheet.getRange(intentRowIdx1, iMap.status + 1).setValue('MATCHED');
      intentSheet.getRange(intentRowIdx1, iMap.matched_tx_id + 1).setValue(existingTxId);
      selfHealed = true;
      logAudit_(
        'SYSTEM_MIDTRANS',
        'MIDTRANS_SELF_HEAL_INTENT',
        intentId,
        'Healed PENDING intent to MATCHED for existing tx=' + existingTxId
      );
    }
    return {
      status: 'ok',
      action_taken: selfHealed ? 'self_healed_intent' : 'duplicate_noop',
      duplicate: true,
      self_healed: selfHealed,
      order_id: orderId,
      intent_id: intentId,
      intent_status: 'MATCHED',
      gateway_status: state.gateway_status,
      tx_id: existingTxId,
      receipt_no: existingReceiptNo,
      email_status: existingEmailStatus
    };
  }

  // Step 3: Allocate IDs and prepare full V2 transaction record (OPEN-03: gateway_fee = 0 in Sandbox)
  const now = new Date();
  const txId = 'TX_' + Utilities.getUuid().substring(0, 8);
  const receiptNo = typeof allocateNextReceiptNo_ === 'function' ? allocateNextReceiptNo_(ss, now) : '';
  const amount = Math.round(parseFloat(intentRow[iMap.amount]) || 0);
  const refCode = String(intentRow[iMap.ref_code] || '').trim();
  const userId = String(intentRow[iMap.user_id] || '').trim();
  const programName = String(intentRow[iMap.program] || 'Beasiswa Alumni UPI').trim();
  const programId = iMap.program_id !== undefined ? String(intentRow[iMap.program_id] || '').trim() : '';
  const isAnonymous =
    iMap.is_anonymous !== undefined && String(intentRow[iMap.is_anonymous] || '').trim().toUpperCase() === 'YES'
      ? 'YES'
      : getIntentAnonBridge_(intentId);
  const donorType =
    iMap.donor_type !== undefined && String(intentRow[iMap.donor_type] || '').trim()
      ? String(intentRow[iMap.donor_type]).trim().toUpperCase()
      : /^G/i.test(refCode)
      ? 'GUEST'
      : 'ALUMNI';
  const donorNameRaw =
    iMap.donor_name !== undefined && String(intentRow[iMap.donor_name] || '').trim()
      ? String(intentRow[iMap.donor_name]).trim()
      : 'Donatur Midtrans';
  const donorEmail =
    iMap.donor_email !== undefined ? String(intentRow[iMap.donor_email] || '').trim() : '';
  const displayDonorName = maskDonorName(donorNameRaw, isAnonymous === 'YES');
  const normalizedBank = normalizeMidtransChannel(payload);
  const txDateStr = String(
    payload.settlement_time || payload.transaction_time || Utilities.formatDate(now, 'Asia/Jakarta', 'yyyy-MM-dd HH:mm:ss')
  );
  const tokenHash = iMap.access_token_hash !== undefined ? String(intentRow[iMap.access_token_hash] || '') : '';
  const tokenExp = iMap.access_token_expires_at !== undefined ? String(intentRow[iMap.access_token_expires_at] || '') : '';

  const txRowValues = buildTransactionRowByHeader_(txSheet, {
    tx_id: txId,
    mutation_id: mutationKey,
    received_at: now.toISOString(),
    bank: normalizedBank,
    account_masked: 'MIDTRANS-GATEWAY',
    tx_date: txDateStr,
    amount: amount,
    description: 'Midtrans Snap ' + orderId + ' (' + (payload.payment_type || 'snap') + ')',
    donor_name_raw: donorNameRaw,
    donor_display_name: displayDonorName,
    match_status: 'MATCHED',
    match_tier: '1-MIDTRANS',
    user_id: userId,
    ref_code: refCode,
    intent_id: intentId,
    program: programName,
    is_anonymous: isAnonymous,
    donor_type: donorType,
    donor_email: donorEmail,
    program_id: programId,
    payment_channel: 'MIDTRANS_SNAP',
    gateway_order_id: orderId,
    gateway_transaction_id: gatewayTxId,
    gateway_payment_type: String(payload.payment_type || 'snap'),
    gateway_status: state.gateway_status,
    gross_amount: amount,
    gateway_fee: 0,
    net_amount: amount,
    receipt_no: receiptNo,
    receipt_issued_at: now.toISOString(),
    access_token_hash: tokenHash,
    access_token_expires_at: tokenExp,
    email_status: donorEmail ? 'PENDING' : 'NOT_APPLICABLE',
    email_sent_at: '',
    email_error: ''
  });

  // Step 4: Write-Ahead — append transactions row FIRST before closing intent
  const newTxRowIdx1 = txSheet.getLastRow() + 1;
  txSheet.getRange(newTxRowIdx1, 1, 1, txRowValues.length).setValues([txRowValues]);

  // Step 5: Close donation_intents to MATCHED and link matched_tx_id
  intentSheet.getRange(intentRowIdx1, iMap.status + 1).setValue('MATCHED');
  intentSheet.getRange(intentRowIdx1, iMap.matched_tx_id + 1).setValue(txId);

  // Step 6: Isolated email dispatch (never rolls back MATCHED transaction if MailApp fails)
  let finalEmailStatus = donorEmail ? 'PENDING' : 'NOT_APPLICABLE';
  if (donorEmail) {
    try {
      const mailOut = sendDonorDonationReceivedEmail_({
        to_email: donorEmail,
        full_name: donorNameRaw,
        ref_code: refCode,
        amount: amount,
        bank: normalizedBank,
        date: txDateStr,
        program: programName,
        receipt_no: receiptNo
      });
      if (mailOut && mailOut.sent === false) {
        throw new Error(mailOut.error || 'MailApp dispatch failed');
      }
      finalEmailStatus = 'SENT';
      if (tMap.email_status !== undefined) {
        txSheet.getRange(newTxRowIdx1, tMap.email_status + 1).setValue('SENT');
      }
      if (tMap.email_sent_at !== undefined) {
        txSheet.getRange(newTxRowIdx1, tMap.email_sent_at + 1).setValue(new Date().toISOString());
      }
    } catch (mailErr) {
      finalEmailStatus = 'FAILED';
      if (tMap.email_status !== undefined) {
        txSheet.getRange(newTxRowIdx1, tMap.email_status + 1).setValue('FAILED');
      }
      if (tMap.email_error !== undefined) {
        txSheet
          .getRange(newTxRowIdx1, tMap.email_error + 1)
          .setValue(String((mailErr && mailErr.message) || mailErr || 'MailApp error').slice(0, 200));
      }
    }
  }

  try {
    sendAdminDonationAlert_([
      {
        bank: normalizedBank,
        amount: amount,
        donor: displayDonorName,
        ref_code: refCode,
        status: 'MATCHED',
        tier: '1-MIDTRANS'
      }
    ]);
  } catch (ignoreAdminMailErr) {}

  logAudit_(
    'SYSTEM_MIDTRANS',
    'MIDTRANS_PAYMENT_CONFIRMED',
    txId,
    'order=' + orderId + ' ref=' + refCode + ' receipt=' + receiptNo + ' via=' + source
  );

  if (typeof invalidatePublicSummaryCache_ === 'function') {
    invalidatePublicSummaryCache_();
  }

  return {
    status: 'ok',
    action_taken: 'confirmed_and_recorded',
    duplicate: false,
    self_healed: false,
    order_id: orderId,
    intent_id: intentId,
    intent_status: 'MATCHED',
    gateway_status: state.gateway_status,
    tx_id: txId,
    receipt_no: receiptNo,
    email_status: finalEmailStatus
  };
}

/**
 * Updates an existing confirmed Midtrans transaction in-place upon refund/partial_refund/chargeback.
 * Strictly forbids deleting historical rows or inserting negative/credit duplicate rows.
 */
function applyMidtransReversalInPlace_(ss, txSheet, intentId, orderId, reversalStatus, payload, source) {
  const tMap = getHeaderMap_(txSheet);
  if (tMap.gateway_status === undefined) {
    throw new Error("Schema error: Kolom 'gateway_status' belum tersedia pada sheet transactions.");
  }

  const tRows = txSheet.getDataRange().getValues();
  let targetRowIdx1 = -1;
  let targetTxId = '';

  for (let i = 1; i < tRows.length; i++) {
    const rOrderId = tMap.gateway_order_id !== undefined ? String(tRows[i][tMap.gateway_order_id] || '').trim() : '';
    const rIntentId = tMap.intent_id !== undefined ? String(tRows[i][tMap.intent_id] || '').trim() : '';
    if ((orderId && rOrderId === orderId) || (intentId && rIntentId === intentId)) {
      targetRowIdx1 = i + 1;
      targetTxId = String(tRows[i][tMap.tx_id] || '').trim();
      break;
    }
  }

  if (targetRowIdx1 === -1) {
    logAudit_('SYSTEM_MIDTRANS', 'MIDTRANS_REVERSAL_ORPHAN', orderId, 'Reversal ' + reversalStatus + ' had no matching transaction row.');
    return { status: 'ignored', reason: 'transaction_not_found_for_reversal', order_id: orderId };
  }

  txSheet.getRange(targetRowIdx1, tMap.gateway_status + 1).setValue(reversalStatus);

  logAudit_(
    'SYSTEM_MIDTRANS',
    'MIDTRANS_TRANSACTION_' + reversalStatus,
    targetTxId,
    'order=' + orderId + ' via=' + source
  );

  if (typeof invalidatePublicSummaryCache_ === 'function') {
    invalidatePublicSummaryCache_();
  }

  return {
    status: 'ok',
    action_taken: 'updated_in_place_' + reversalStatus.toLowerCase(),
    order_id: orderId,
    intent_id: intentId,
    intent_status: 'MATCHED',
    gateway_status: reversalStatus,
    tx_id: targetTxId
  };
}

/**
 * Polls Gmail for incoming SeaBank / QRIS credit notifications and feeds them into handleWebhookMutations_.
 * Designed to run on a 1-minute Apps Script Time-Driven Trigger once SeaBank email notifications are active.
 *
 * @returns {Object} Polling summary { status, threads_scanned, mutations_parsed, webhook_result }.
 */
function pollSeabankGmailNotifications() {
  if (typeof GmailApp === 'undefined') {
    return { status: 'error', message: 'GmailApp is only available inside Google Apps Script runtime.' };
  }

  const labelName = 'DonasiAlumni_Processed';
  const query =
    getSecureConfig_('SEABANK_GMAIL_QUERY', true) ||
    '(from:alerts@seabank.co.id OR from:seabank) -label:' + labelName + ' newer_than:2d';

  let label = GmailApp.getUserLabelByName(labelName);
  if (!label) {
    label = GmailApp.createLabel(labelName);
  }

  const threads = GmailApp.search(query, 0, 20);
  const mutations = [];
  const processedThreads = [];

  for (let i = 0; i < threads.length; i++) {
    const messages = threads[i].getMessages();
    let threadHadValidMutation = false;

    for (let j = 0; j < messages.length; j++) {
      const msg = messages[j];
      const parsed = parseSeabankNotificationEmail(msg.getSubject(), msg.getPlainBody() || msg.getBody());
      if (parsed && parsed.amount > 0) {
        mutations.push({
          mutation_id: 'GMAIL_' + msg.getId(),
          bank: 'SEABANK',
          type: 'CR',
          amount: parsed.amount,
          description: parsed.description,
          transaction_date: Utilities.formatDate(msg.getDate(), 'Asia/Jakarta', 'yyyy-MM-dd HH:mm:ss')
        });
        threadHadValidMutation = true;
      }
    }

    if (threadHadValidMutation) {
      processedThreads.push(threads[i]);
    }
  }

  let webhookResult = null;
  if (mutations.length > 0) {
    webhookResult = handleWebhookMutations_(mutations);
    for (let k = 0; k < processedThreads.length; k++) {
      processedThreads[k].addLabel(label);
    }
  }

  return {
    status: 'ok',
    threads_scanned: threads.length,
    mutations_parsed: mutations.length,
    webhook_result: webhookResult
  };
}


