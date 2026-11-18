/**
 * AuditLog.gs
 * Appends sanitized audit events to the audit_log sheet.
 */

/**
 * Redacts potential authentication tokens, JWT strings, or secrets from log text.
 *
 * @param {string} rawText - Input log text.
 * @returns {string} Sanitized text safe for persistence in audit_log.
 */
function redactSensitiveAuditText_(rawText) {
  let text = String(rawText || '');
  // Scrub Google JWT tokens (three dot-separated base64url segments starting with eyJ)
  text = text.replace(/\beyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\b/g, '[REDACTED_JWT]');
  // Scrub Midtrans keys and long base64 payloads
  text = text.replace(/\b(SB-Mid-server-|Mid-server-)[A-Za-z0-9_\-]+/g, '[REDACTED_MIDTRANS_KEY]');
  text = text.replace(/\bdata:[a-z0-9/+.-]+;base64,[A-Za-z0-9+/=]{32,}/gi, '[REDACTED_BASE64_FILE]');
  // Scrub mock tokens and explicit token/secret key-value pairs
  text = text.replace(/\bmock_token_[A-Za-z0-9_\-]*/gi, '[REDACTED_MOCK_TOKEN]');
  text = text.replace(/(id_token|access_token|idempotency_proof|secret|signature|signature_key|webhook_token|server_key|pepper)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]');
  return text;
}

/**
 * Records an immutable audit trail entry without exposing sensitive credentials.
 *
 * @param {string} actor - Email or system actor identifier.
 * @param {string} action - Action code (e.g., REGISTER, BLOCKED_MOCK_TOKEN).
 * @param {string} target - Entity ID or endpoint target.
 * @param {string} detail - Contextual event detail.
 */
function logAudit_(actor, action, target, detail) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(SHEET_NAMES.AUDIT_LOG);
    if (!sheet) return;

    sheet.appendRow([
      new Date().toISOString(),
      redactSensitiveAuditText_(actor || 'SYSTEM'),
      redactSensitiveAuditText_(action || 'UNKNOWN'),
      redactSensitiveAuditText_(target || ''),
      redactSensitiveAuditText_(detail || '')
    ]);
  } catch (e) {
    // Keep failures silent to main business flow while avoiding secret leakage
    Logger.log('Could not log audit: ' + e.message);
  }
}

/**
 * Returns paginated audit_log entries ordered newest-first strictly for Administrators (Phase P7).
 * Applies defensive redaction on read as well to ensure zero sensitive residue reaches admin UI.
 *
 * @param {string} adminToken - Valid administrator Google ID token.
 * @param {number=} limit - Maximum entries per page (default 50, max 200).
 * @param {number=} offset - Zero-based offset into newest-first list.
 * @returns {Object} { status, items, total, limit, offset }.
 */
function getAdminAuditLogs(adminToken, limit, offset) {
  requireAdmin_(adminToken);

  const parsedLimit = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));
  const parsedOffset = Math.max(0, parseInt(offset, 10) || 0);

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_NAMES.AUDIT_LOG);
  if (!sheet || sheet.getLastRow() <= 1) {
    return {
      status: 'ok',
      items: [],
      total: 0,
      limit: parsedLimit,
      offset: parsedOffset
    };
  }

  const hMap = typeof getHeaderMap_ === 'function' ? getHeaderMap_(sheet) : null;
  const rows = sheet.getDataRange().getValues();
  const allEntries = [];

  for (let i = rows.length - 1; i >= 1; i--) {
    const r = rows[i];
    allEntries.push({
      timestamp: String(r[hMap && hMap.timestamp !== undefined ? hMap.timestamp : 0] || ''),
      actor_email: redactSensitiveAuditText_(r[hMap && hMap.actor_email !== undefined ? hMap.actor_email : 1] || ''),
      action: redactSensitiveAuditText_(r[hMap && hMap.action !== undefined ? hMap.action : 2] || ''),
      target: redactSensitiveAuditText_(r[hMap && hMap.target !== undefined ? hMap.target : 3] || ''),
      detail: redactSensitiveAuditText_(r[hMap && hMap.detail !== undefined ? hMap.detail : 4] || '')
    });
  }

  const total = allEntries.length;
  const pageItems = allEntries.slice(parsedOffset, parsedOffset + parsedLimit);

  return {
    status: 'ok',
    items: pageItems,
    total: total,
    limit: parsedLimit,
    offset: parsedOffset
  };
}
