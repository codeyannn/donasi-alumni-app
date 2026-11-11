/**
 * PublicApi.gs
 * Privacy-safe public aggregated donation statistics for unauthenticated public viewers.
 */

/**
 * Returns aggregated stats and latest sanitized donation list.
 * Conforms to UU PDP No. 27/2022 (no raw bank accounts, names masked).
 */
function getPublicSummary() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const txSheet = ss.getSheetByName(SHEET_NAMES.TRANSACTIONS);
  const orgName =
    getConfig_("ORG_NAME") || "Pengelola Beasiswa Ikatan Alumni UPI";

  if (!txSheet || txSheet.getLastRow() <= 1) {
    return {
      status: "ok",
      org_name: orgName,
      total_amount: 0,
      formatted_total: "Rp 0",
      total_count: 0,
      today_amount: 0,
      by_bank: {},
      by_program: {},
      recent_donations: [],
    };
  }

  const data = txSheet.getRange(2, 1, txSheet.getLastRow() - 1, 17).getValues();
  let totalAmount = 0;
  let totalCount = 0;
  let todayAmount = 0;

  const byBank = {};
  const byProgram = {};
  const recentList = [];

  const todayStr = Utilities.formatDate(
    new Date(),
    "Asia/Jakarta",
    "yyyy-MM-dd",
  );

  for (let i = 0; i < data.length; i++) {
    const row = data[i];
    const bank = String(row[3] || "UNKNOWN").trim();
    const amount = parseFloat(row[6]) || 0;
    const donorDisplay = String(row[9] || "Seseorang").trim();
    const refCode = String(row[13] || "").trim();
    const program = String(row[15] || "Umum").trim();
    const isAnon = String(row[16] || "NO").toUpperCase() === "YES";
    const txDateStr = String(row[5] || "").substring(0, 10);

    totalAmount += amount;
    totalCount++;

    if (txDateStr === todayStr) {
      todayAmount += amount;
    }

    byBank[bank] = (byBank[bank] || 0) + amount;
    byProgram[program] = (byProgram[program] || 0) + amount;

    recentList.push({
      date: txDateStr,
      bank: bank,
      amount: amount,
      formatted_amount: formatRupiah(amount),
      // If donor opted for anonymous, override display name
      donor: isAnon ? "Seseorang" : donorDisplay,
      is_alumni: refCode.startsWith("A"),
      program: program,
    });
  }

  return {
    status: "ok",
    org_name: orgName,
    last_updated: Utilities.formatDate(
      new Date(),
      "Asia/Jakarta",
      "yyyy-MM-dd HH:mm:ss",
    ),
    total_amount: totalAmount,
    formatted_total: formatRupiah(totalAmount),
    total_count: totalCount,
    today_amount: todayAmount,
    formatted_today: formatRupiah(todayAmount),
    by_bank: byBank,
    by_program: byProgram,
    recent_donations: recentList.reverse().slice(0, 20),
  };
}
