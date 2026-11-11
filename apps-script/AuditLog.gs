/**
 * AuditLog.gs
 * Appends audit events to audit_log sheet.
 */

function logAudit_(actor, action, target, detail) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(SHEET_NAMES.AUDIT_LOG);
    if (!sheet) return;

    sheet.appendRow([
      new Date().toISOString(),
      String(actor || 'SYSTEM'),
      String(action || 'UNKNOWN'),
      String(target || ''),
      String(detail || '')
    ]);
  } catch (e) {
    Logger.log('Could not log audit: ' + e.message);
  }
}

