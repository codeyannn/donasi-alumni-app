/**
 * Code.gs
 * Main HTTP router for DonasiAlumniApp.
 * Dispatches GET and POST endpoints for Frontend Web App and External Bank Webhooks.
 */

/**
 * Handles HTTP POST requests.
 * All authenticated actions and webhook payloads arrive via POST JSON body
 * (zero auth/webhook tokens accepted in URL query parameters).
 */
function doPost(e) {
  try {
    const params = (e && e.parameter) ? e.parameter : {};

    // SEC-P0-5: Reject any authentication or webhook token sent via URL query string
    if (params.token || params.id_token || params.access_token) {
      return jsonResponse_(
        {
          status: 'error',
          message: 'Forbidden: Authentication and webhook tokens must not be passed in URL query strings.',
        },
        400,
      );
    }

    if (!e || !e.postData || !e.postData.contents) {
      return jsonResponse_({ status: 'error', message: 'Missing POST JSON payload.' }, 400);
    }

    let body = {};
    try {
      body = JSON.parse(e.postData.contents);
    } catch (pErr) {
      return jsonResponse_({ status: 'error', message: 'Invalid JSON payload.' }, 400);
    }

    // Route 1: Manual Bank Webhook endpoint (authenticated via HMAC-SHA256 + timestamp in JSON body)
    if (body && body.webhook_auth && typeof body.payload_raw === 'string') {
      const mutations = verifyManualWebhookAuth_(body);
      const result = handleWebhookMutations_(mutations);
      return jsonResponse_({
        status: 'ok',
        inserted: result.inserted,
        duplicates: result.duplicates,
        matched: result.matched,
        unmatched: result.unmatched,
        ignored_debit: result.ignored_debit
      });
    }

    // Route 1b: Midtrans Server-to-Server Payment Notification Webhook (verified via SHA-512 signature_key)
    if (
      body &&
      !body.action &&
      body.order_id &&
      body.status_code !== undefined &&
      body.gross_amount !== undefined &&
      body.signature_key
    ) {
      const mtResult = handleMidtransWebhook_(body);
      return jsonResponse_(mtResult);
    }

    // Route 2: Application API Actions (id_token strictly extracted from POST body only)
    const pathAction = String(body.action || params.action || '').trim();
    const idToken = typeof body.id_token === 'string' ? body.id_token : '';

    if (pathAction === 'register_or_login') {
      const user = registerOrLoginUser(idToken, body.role, body.consent);
      return jsonResponse_({ status: 'ok', user: user });
    }

    if (pathAction === 'submit_verification') {
      const res = submitAlumniVerification(idToken, body);
      return jsonResponse_(res);
    }

    if (pathAction === 'review_verification') {
      const decisionInput = body.decision !== undefined ? body.decision : body.approve;
      const res = reviewAlumniVerification(idToken, body.verif_id, decisionInput, body.reason);
      return jsonResponse_(res);
    }

    if (pathAction === 'admin_verif_proof') {
      const res = getVerificationProofForAdmin(idToken, body.verif_id);
      return jsonResponse_(res);
    }

    if (pathAction === 'create_intent') {
      const res = createDonationIntent(idToken, body);
      return jsonResponse_(res);
    }

    if (pathAction === 'create_guest_intent') {
      const res = createGuestDonationIntent(body);
      return jsonResponse_(res);
    }

    if (pathAction === 'simulate_payment' || pathAction === 'simulate_manual_payment') {
      const res = simulateIntentPayment(idToken, body.intent_id, body.access_token);
      return jsonResponse_(res);
    }

    if (pathAction === 'resolve_queue') {
      const res = resolveReviewQueueItem(idToken, body.queue_id, body.target_ref_code);
      return jsonResponse_(res);
    }

    // Authenticated read operations moved from GET to POST (SEC-P0-5)
    if (pathAction === 'my_donations') {
      return jsonResponse_(getMyDonations(idToken));
    }

    if (pathAction === 'check_intent') {
      return jsonResponse_(checkIntentStatus(idToken, body.intent_id, body.access_token));
    }

    if (pathAction === 'guest_lookup') {
      return jsonResponse_(getGuestTransactionStatus(body.ref_code, body.access_token));
    }

    if (pathAction === 'rotate_guest_token') {
      return jsonResponse_(rotateGuestAccessToken(body));
    }

    if (pathAction === 'get_receipt') {
      return jsonResponse_(getReceiptData(body));
    }

    if (pathAction === 'admin_programs') {
      return jsonResponse_(getAllProgramsAdmin(idToken));
    }

    if (pathAction === 'save_program') {
      return jsonResponse_(saveProgramAdmin(idToken, body));
    }

    if (pathAction === 'delete_program') {
      return jsonResponse_(deleteProgramAdmin(idToken, body.program_id));
    }

    if (pathAction === 'admin_verifications') {
      return jsonResponse_(getAdminVerifications(idToken, body.filter_status));
    }

    if (pathAction === 'admin_queue') {
      return jsonResponse_(getAdminReviewQueue(idToken));
    }

    if (pathAction === 'admin_insights') {
      return jsonResponse_(getAdminInsights(idToken));
    }

    if (pathAction === 'admin_check_midtrans') {
      return jsonResponse_(syncMidtransIntentStatusAdmin(idToken, body.intent_id));
    }

    if (pathAction === 'retry_tx_email') {
      return jsonResponse_(retryTransactionEmail(idToken, body.tx_id));
    }

    if (pathAction === 'admin_transactions') {
      return jsonResponse_(getAdminTransactions(idToken, body.filters));
    }

    if (pathAction === 'admin_audit_logs') {
      return jsonResponse_(getAdminAuditLogs(idToken, body.limit, body.offset));
    }

    return jsonResponse_({ status: 'error', message: 'Unauthorized or unknown POST action: ' + pathAction }, 401);

  } catch (err) {
    // Return error message without echoing request parameters or secret values
    return jsonResponse_({ status: 'error', message: err.message || err.toString() }, 500);
  }
}

/**
 * Handles HTTP GET requests.
 * Strictly restricted to unauthenticated public read endpoints without tokens.
 */
function doGet(e) {
  try {
    const params = (e && e.parameter) ? e.parameter : {};

    // SEC-P0-5: Reject any token passed in GET URL query parameters
    if (params.token || params.id_token || params.access_token) {
      return jsonResponse_(
        {
          status: 'error',
          message: 'Forbidden: Authentication tokens are not accepted in GET query strings. Use POST body.',
        },
        400,
      );
    }

    const action = String(params.action || 'public_summary').trim();

    if (action === 'health') {
      return jsonResponse_({
        status: 'ok',
        app: 'DonasiAlumniApp Backend',
        time: new Date().toISOString()
      });
    }

    if (action === 'public_summary') {
      return jsonResponse_(getPublicSummary());
    }

    if (action === 'active_programs') {
      return jsonResponse_(getActivePrograms());
    }

    // Reject private/admin actions on GET and instruct POST transport
    if (
      action === 'my_donations' ||
      action === 'check_intent' ||
      action === 'guest_lookup' ||
      action === 'rotate_guest_token' ||
      action === 'get_receipt' ||
      action === 'admin_verifications' ||
      action === 'admin_verif_proof' ||
      action === 'admin_queue' ||
      action === 'admin_insights' ||
      action === 'admin_programs' ||
      action === 'save_program' ||
      action === 'delete_program' ||
      action === 'admin_check_midtrans' ||
      action === 'retry_tx_email' ||
      action === 'admin_transactions' ||
      action === 'admin_audit_logs'
    ) {
      return jsonResponse_(
        {
          status: 'error',
          message: 'Method Not Allowed: Private actions require POST with token in JSON body.',
        },
        405,
      );
    }

    return jsonResponse_({ status: 'error', message: 'Unknown GET action: ' + action }, 404);

  } catch (err) {
    return jsonResponse_({ status: 'error', message: err.message || err.toString() }, 500);
  }
}

/**
 * Serializes output to JSON.
 */
function jsonResponse_(data, code) {
  const output = ContentService.createTextOutput(JSON.stringify(data));
  output.setMimeType(ContentService.MimeType.JSON);
  return output;
}

/**
 * Config reader helper.
 */
function getConfig_(key) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_NAMES.CONFIG);
  if (!sheet) return '';
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim() === key) {
      return String(data[i][1]).trim();
    }
  }
  return '';
}

/**
 * Keyword reader helper.
 */
function getKeywordDictionary_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_NAMES.KEYWORDS);
  if (!sheet || sheet.getLastRow() <= 1) return [];

  const data = sheet.getRange(2, 1, sheet.getLastRow() - 1, 2).getValues();
  const list = [];
  for (let i = 0; i < data.length; i++) {
    const kw = String(data[i][0]).trim().toUpperCase();
    const prog = String(data[i][1]).trim();
    if (kw && prog) list.push({ keyword: kw, program: prog });
  }
  return list;
}
