/**
 * Code.gs
 * Main HTTP router for DonasiAlumniApp.
 * Dispatches GET and POST endpoints for Frontend Web App and External Bank Webhooks.
 */

/**
 * Handles HTTP POST requests.
 * Routes:
 * - Bank Webhook: ?token=WEBHOOK_SECRET_TOKEN
 * - API actions: action=register, submit_verification, review_verification, create_intent, resolve_queue
 */
function doPost(e) {
  try {
    const params = (e && e.parameter) ? e.parameter : {};
    const pathAction = params.action || '';

    // Route 1: Bank Webhook endpoint (authenticated via token query param)
    const token = params.token;
    const expectedToken = getConfig_('WEBHOOK_TOKEN');

    if (token && token === expectedToken) {
      if (!e || !e.postData || !e.postData.contents) {
        return jsonResponse_({ status: 'error', message: 'Missing POST body payload' }, 400);
      }
      let payload;
      try {
        payload = JSON.parse(e.postData.contents);
      } catch (err) {
        return jsonResponse_({ status: 'error', message: 'Invalid JSON payload: ' + err.message }, 400);
      }

      const mutations = Array.isArray(payload) ? payload : [payload];
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

    // Route 2: Application API Actions (authenticated via Google ID token)
    let body = {};
    if (e && e.postData && e.postData.contents) {
      try {
        body = JSON.parse(e.postData.contents);
      } catch (pErr) {
        body = {};
      }
    }

    const idToken = body.id_token || params.id_token || '';

    if (pathAction === 'register_or_login') {
      const user = registerOrLoginUser(idToken, body.role, body.consent);
      return jsonResponse_({ status: 'ok', user: user });
    }

    if (pathAction === 'submit_verification') {
      const res = submitAlumniVerification(idToken, body);
      return jsonResponse_(res);
    }

    if (pathAction === 'review_verification') {
      const res = reviewAlumniVerification(idToken, body.verif_id, body.approve, body.reason);
      return jsonResponse_(res);
    }

    if (pathAction === 'create_intent') {
      const res = createDonationIntent(idToken, body);
      return jsonResponse_(res);
    }

    if (pathAction === 'resolve_queue') {
      const res = resolveReviewQueueItem(idToken, body.queue_id, body.target_ref_code);
      return jsonResponse_(res);
    }

    // If unauthorized or unknown action
    return jsonResponse_({ status: 'error', message: 'Unauthorized or unknown POST action: ' + pathAction }, 401);

  } catch (err) {
    return jsonResponse_({ status: 'error', message: err.message || err.toString() }, 500);
  }
}

/**
 * Handles HTTP GET requests.
 * Routes:
 * - action=health
 * - action=public_summary
 * - action=my_donations (requires id_token)
 * - action=admin_verifications (requires admin id_token)
 * - action=admin_queue (requires admin id_token)
 * - action=admin_insights (requires admin id_token)
 */
function doGet(e) {
  try {
    const params = (e && e.parameter) ? e.parameter : {};
    const action = params.action || 'public_summary';
    const idToken = params.id_token || '';

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

    if (action === 'my_donations') {
      return jsonResponse_(getMyDonations(idToken));
    }

    if (action === 'admin_verifications') {
      return jsonResponse_(getAdminVerifications(idToken));
    }

    if (action === 'admin_queue') {
      return jsonResponse_(getAdminReviewQueue(idToken));
    }

    if (action === 'admin_insights') {
      return jsonResponse_(getAdminInsights(idToken));
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

