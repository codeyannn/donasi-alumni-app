/**
 * PublicApi.gs
 * Pure aggregate public donation statistics for unauthenticated viewers (Phase P7).
 * Zero individual transaction rows, zero donor names, and zero PII/pseudonymous data.
 */

var PUBLIC_SUMMARY_CACHE_KEY = "PUBLIC_AGGREGATE_SUMMARY_V2";

/**
 * Clears cached public summary so confirmed donations or reversals appear immediately.
 */
function invalidatePublicSummaryCache_() {
  try {
    const cache = CacheService.getScriptCache();
    if (cache && typeof cache.remove === "function") {
      cache.remove(PUBLIC_SUMMARY_CACHE_KEY);
    }
  } catch (ignoreCacheErr) {}
}

/**
 * Returns strictly aggregated public donation totals cached for 60 seconds.
 * Conforms to UU PDP No. 27/2022 and OPEN-02/P7 pure-aggregate rules.
 */
function getPublicSummary() {
  try {
    const cache = CacheService.getScriptCache();
    if (cache) {
      const cached = cache.get(PUBLIC_SUMMARY_CACHE_KEY);
      if (cached) {
        return JSON.parse(cached);
      }
    }
  } catch (ignoreReadCacheErr) {}

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const txSheet = ss.getSheetByName(SHEET_NAMES.TRANSACTIONS);
  const orgName =
    getConfig_("ORG_NAME") || "Pengelola Beasiswa Ikatan Alumni UPI";
  const lastUpdated = Utilities.formatDate(
    new Date(),
    "Asia/Jakarta",
    "yyyy-MM-dd HH:mm:ss",
  );

  if (!txSheet || txSheet.getLastRow() <= 1) {
    return {
      status: "ok",
      org_name: orgName,
      last_updated: lastUpdated,
      total_amount: 0,
      formatted_total: "Rp 0",
      total_count: 0,
      today_amount: 0,
      formatted_today: "Rp 0",
      by_bank: {},
      by_program: {},
    };
  }

  const tMap = typeof getHeaderMap_ === "function" ? getHeaderMap_(txSheet) : null;
  const data = txSheet.getDataRange().getValues().slice(1);
  let totalAmount = 0;
  let totalCount = 0;
  let todayAmount = 0;

  const byBank = {};
  const byProgram = {};

  const todayStr = Utilities.formatDate(
    new Date(),
    "Asia/Jakarta",
    "yyyy-MM-dd",
  );

  for (let i = 0; i < data.length; i++) {
    const row = data[i];
    const matchStatus = String(row[tMap && tMap.match_status !== undefined ? tMap.match_status : 10] || "").toUpperCase().trim();
    // Exclude UNMATCHED / unconfirmed transactions from public donation totals
    if (matchStatus !== "MATCHED" && matchStatus !== "MANUAL_MATCHED") {
      continue;
    }

    // Exclude reversed Midtrans transactions (REFUNDED / PARTIAL_REFUNDED / CHARGEBACK) from verified totals
    const gatewayStatus =
      tMap && tMap.gateway_status !== undefined
        ? String(row[tMap.gateway_status] || "").toUpperCase().trim()
        : "";
    if (
      gatewayStatus === "REFUNDED" ||
      gatewayStatus === "PARTIAL_REFUNDED" ||
      gatewayStatus === "CHARGEBACK"
    ) {
      continue;
    }

    const bank = String(row[tMap && tMap.bank !== undefined ? tMap.bank : 3] || "UNKNOWN").trim();
    const netCell = tMap && tMap.net_amount !== undefined ? row[tMap.net_amount] : "";
    const rawAmount = parseFloat(row[tMap && tMap.amount !== undefined ? tMap.amount : 6]) || 0;
    const amount = netCell !== "" && netCell !== undefined ? parseFloat(netCell) || rawAmount : rawAmount;
    const program = String(row[tMap && tMap.program !== undefined ? tMap.program : 15] || "Umum").trim();
    const txDateStr = String(row[tMap && tMap.tx_date !== undefined ? tMap.tx_date : 5] || "").substring(0, 10);

    totalAmount += amount;
    totalCount++;

    if (txDateStr === todayStr) {
      todayAmount += amount;
    }

    byBank[bank] = (byBank[bank] || 0) + amount;
    byProgram[program] = (byProgram[program] || 0) + amount;
  }

  const summary = {
    status: "ok",
    org_name: orgName,
    last_updated: lastUpdated,
    total_amount: totalAmount,
    formatted_total: formatRupiah(totalAmount),
    total_count: totalCount,
    today_amount: todayAmount,
    formatted_today: formatRupiah(todayAmount),
    by_bank: byBank,
    by_program: byProgram,
  };

  try {
    const cache = CacheService.getScriptCache();
    if (cache) {
      cache.put(PUBLIC_SUMMARY_CACHE_KEY, JSON.stringify(summary), 60);
    }
  } catch (ignoreWriteCacheErr) {}

  return summary;
}
