/**
 * Users.gs
 * User registration, Google authentication profile lookup, 5-level alumni verification workflow,
 * private Google Drive proof handling, and lock-safe A000xxx Alumni ID issuance.
 */

/**
 * Registers a new user or returns an existing user record from Google OAuth claims.
 * Prevents duplicate Alumni rows across repeated logins and never allows client ADMIN self-assignment.
 *
 * @param {string} idToken - Verified Google ID Token from POST JSON body.
 * @param {string} requestedRole - Client hint ('ALUMNI' or interim transition 'GUEST').
 * @param {boolean} consent - Explicit UU No. 27/2022 personal data processing consent.
 * @returns {Object} User profile state with canonical 5-level verification_status.
 */
function registerOrLoginUser(idToken, requestedRole, consent) {
  const profile = verifyIdToken(idToken);
  const reqRole = String(requestedRole || "ALUMNI")
    .trim()
    .toUpperCase();

  // SEC-P0-1: Reject any client payload attempting ADMIN privilege escalation
  if (reqRole === "ADMIN") {
    logAudit_(
      profile.email,
      "SECURITY_ROLE_TAMPER",
      "register_or_login",
      "Rejected client payload attempting to specify ADMIN role.",
    );
    throw new Error(
      "Forbidden: ADMIN role cannot be requested from client payload.",
    );
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(15000);

  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const userSheet = ss.getSheetByName(SHEET_NAMES.USERS);
    if (!userSheet) {
      throw new Error("Required sheet 'users' is missing.");
    }

    // Prevent duplicate accounts by checking email and Google sub; preserve existing historical GUEST rows
    let existing =
      findUserByEmail_(profile.email) || findUserByGoogleSub_(profile.sub);
    if (existing) {
      if (isAdminEmail_(existing.email) && existing.role !== "ADMIN") {
        updateUserRole_(existing.user_id, "ADMIN");
        existing.role = "ADMIN";
      }
      const normStatus = normalizeVerificationStatus(
        existing.verification_status,
      );
      const latestNote =
        normStatus === "NEEDS_REVISION" || normStatus === "REJECTED"
          ? getLatestVerificationNoteForUser_(existing.user_id)
          : "";
      return {
        user_id: existing.user_id,
        email: existing.email,
        full_name: existing.full_name,
        role: existing.role,
        ref_code: existing.ref_code,
        verification_status: normStatus,
        raw_verification_status: existing.verification_status,
        reject_reason: latestNote,
      };
    }

    // P4: Retire new GUEST creation via Google Sign-In; Guests checkout without an account
    if (reqRole === "GUEST") {
      throw new Error(
        "Jalur Tamu tidak memerlukan login Google. Silakan gunakan formulir Donasi Tamu di halaman beranda.",
      );
    }

    // Require explicit UU PDP privacy consent on first registration
    if (!consent) {
      throw new Error(
        "Persetujuan pemrosesan data pribadi (UU No. 27/2022) wajib disetujui.",
      );
    }

    const now = new Date();
    const digest = Utilities.computeDigest(
      Utilities.DigestAlgorithm.MD5,
      profile.email + "_" + now.getTime(),
    );
    const userId = "USR_" + Utilities.base64Encode(digest).substring(0, 10);

    // Derive ADMIN strictly from trusted backend ADMIN_EMAILS allowlist; new signups default to ALUMNI
    let role = isAdminEmail_(profile.email) ? "ADMIN" : "ALUMNI";
    let refCode = "";
    let verifStatus = "NOT_SUBMITTED";

    if (role === "ADMIN") {
      const seq = getNextAlumniSafeSequence_("ALUMNI");
      refCode = formatRefCode("A", seq);
      verifStatus = "APPROVED";
    } else {
      verifStatus = "NOT_SUBMITTED";
      refCode = "";
    }

    const row = [
      userId,
      profile.sub,
      profile.email,
      sanitizeSpreadsheetFormula(profile.name),
      role,
      refCode,
      verifStatus,
      now.toISOString(),
      now.toISOString(),
    ];

    userSheet.appendRow(row);
    logAudit_(
      profile.email,
      "REGISTER",
      userId,
      "Registered as " + role + (refCode ? " with ref " + refCode : ""),
    );

    return {
      user_id: userId,
      email: profile.email,
      full_name: profile.name,
      role: role,
      ref_code: refCode,
      verification_status: verifStatus,
      raw_verification_status: verifStatus,
      reject_reason: "",
    };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Submits or resubmits an alumni graduation verification ticket.
 * Supports NOT_SUBMITTED -> PENDING and NEEDS_REVISION -> PENDING transitions.
 * Rejects resubmission from REJECTED (OPEN-01), APPROVED, or PENDING states.
 *
 * @param {string} idToken - Google ID token from POST JSON body.
 * @param {Object} data - { nim, grad_year, faculty, file_base64, file_name, file_mime }.
 * @returns {Object} Created verification ticket state.
 */
function submitAlumniVerification(idToken, data) {
  const user = requireUser_(idToken);
  if (String(user.role || "").toUpperCase() === "GUEST") {
    throw new Error("Akun tamu tidak dapat mengajukan verifikasi alumni.");
  }

  // Enforce backend verification state machine regardless of client UI state
  const eligibility = canAlumniSubmitVerification(user.verification_status);
  if (!eligibility.allowed) {
    throw new Error(eligibility.message);
  }

  const nimClean = sanitizeSpreadsheetFormula(data && data.nim);
  const yearClean = sanitizeSpreadsheetFormula(data && data.grad_year);
  const facultyClean = sanitizeSpreadsheetFormula(data && data.faculty);
  if (!nimClean || !yearClean || !facultyClean) {
    throw new Error("NIM, Tahun Lulus, dan Fakultas wajib diisi.");
  }

  // Validate and store proof document in private Drive folder when uploaded
  let fileId = "";
  const hasFilePayload =
    data &&
    data.file_base64 !== undefined &&
    data.file_base64 !== null &&
    String(data.file_base64).trim() !== "";
  const declaredFile =
    data &&
    (data.file_name || data.file_mime || data.file_base64 !== undefined);

  if (hasFilePayload) {
    const bytes = Utilities.base64Decode(data.file_base64);
    const metaCheck = validateProofFileMetadata(
      data.file_mime || "application/pdf",
      data.file_name || "bukti_alumni.pdf",
      bytes.length,
    );
    if (!metaCheck.ok) {
      throw new Error(metaCheck.error);
    }
    const safeFileName = sanitizeSpreadsheetFormula(
      data.file_name || "bukti_alumni",
    );
    const blob = Utilities.newBlob(
      bytes,
      metaCheck.normalizedMime,
      safeFileName + "_" + user.user_id,
    );
    const folder = getOrCreatePrivateFolder_("DonasiAlumni_Bukti_Privat");
    const file = folder.createFile(blob);
    // Keep document strictly private; only system owner and admin endpoint read it
    file.setSharing(DriveApp.Access.ANYONE, DriveApp.Permission.NONE);
    fileId = file.getId();
  } else if (declaredFile && data.file_base64 !== undefined) {
    throw new Error(
      "Berkas bukti kelulusan wajib dilampirkan dan tidak boleh kosong.",
    );
  }

  // Clean up any leftover Drive proof file if this is a NEEDS_REVISION resubmission
  if (eligibility.normalizedStatus === "NEEDS_REVISION") {
    cleanupUserPreviousProofFiles_(user.user_id);
  }

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const verifSheet = ss.getSheetByName(SHEET_NAMES.VERIFICATIONS);
  if (!verifSheet) {
    throw new Error("Required sheet 'alumni_verifications' is missing.");
  }

  const verifId = "VRF_" + Utilities.getUuid().substring(0, 8);
  const now = new Date();

  verifSheet.appendRow([
    verifId,
    user.user_id,
    user.email,
    sanitizeSpreadsheetFormula(user.full_name),
    nimClean,
    yearClean,
    facultyClean,
    fileId,
    "PENDING",
    now.toISOString(),
    "", // reviewed_by
    "", // reviewed_at
    "", // reject_reason
  ]);

  updateUserVerificationStatus_(user.user_id, "PENDING", "");
  const actionType =
    eligibility.normalizedStatus === "NEEDS_REVISION"
      ? "RESUBMIT_VERIFICATION"
      : "SUBMIT_VERIFICATION";
  logAudit_(
    user.email,
    actionType,
    verifId,
    "NIM: " + nimClean + " Thn: " + yearClean,
  );

  if (typeof sendAdminNewVerificationAlert_ === "function") {
    sendAdminNewVerificationAlert_(user, verifId, {
      nim: nimClean,
      grad_year: yearClean,
      faculty: facultyClean,
    });
  }

  return {
    status: "ok",
    verif_id: verifId,
    verification_status: "PENDING",
    message:
      "Pengajuan verifikasi alumni berhasil dikirim dan sedang menunggu tinjauan admin.",
  };
}

/**
 * Fetches private Drive verification proof bytes exclusively for authorized administrators.
 * Never opens Drive public sharing links and records every inspection to audit_log.
 *
 * @param {string} adminToken - Validated admin Google ID token.
 * @param {string} verifId - Target verification ticket ID.
 * @returns {Object} { status, verif_id, file_name, mime_type, base64_data }.
 */
function getVerificationProofForAdmin(adminToken, verifId) {
  const adminProfile = requireAdmin_(adminToken);
  const targetVerifId = String(verifId || "").trim();
  if (!targetVerifId) {
    throw new Error("Parameter verif_id wajib diisi.");
  }

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const verifSheet = ss.getSheetByName(SHEET_NAMES.VERIFICATIONS);
  if (!verifSheet || verifSheet.getLastRow() <= 1) {
    throw new Error("Data verifikasi kosong.");
  }

  const hMap =
    typeof getHeaderMap_ === "function" ? getHeaderMap_(verifSheet) : null;
  const rows = verifSheet.getDataRange().getValues();
  let foundFileId = "";
  let ticketOwnerEmail = "";

  for (let i = 1; i < rows.length; i++) {
    const idIdx = hMap && hMap.verif_id !== undefined ? hMap.verif_id : 0;
    if (String(rows[i][idIdx] || "").trim() === targetVerifId) {
      const fIdx =
        hMap && hMap.proof_file_id !== undefined ? hMap.proof_file_id : 7;
      const eIdx = hMap && hMap.email !== undefined ? hMap.email : 2;
      foundFileId = String(rows[i][fIdx] || "").trim();
      ticketOwnerEmail = String(rows[i][eIdx] || "").trim();
      break;
    }
  }

  if (!foundFileId) {
    throw new Error(
      "Dokumen bukti tidak ditemukan atau sudah dihapus sesuai kebijakan privasi.",
    );
  }

  const file = DriveApp.getFileById(foundFileId);
  const blob = file.getBlob();
  const base64Data = Utilities.base64Encode(blob.getBytes());

  logAudit_(
    adminProfile.email,
    "VIEW_VERIFICATION_PROOF",
    targetVerifId,
    "Admin inspected private proof for " + ticketOwnerEmail,
  );

  return {
    status: "ok",
    verif_id: targetVerifId,
    file_name: blob.getName() || "proof_" + targetVerifId,
    mime_type: blob.getContentType() || "application/octet-stream",
    base64_data: base64Data,
  };
}

/**
 * Admin reviews an alumni verification ticket inside ScriptLock.
 * Supports APPROVED (issues unique A000xxx ID), NEEDS_REVISION (allows resubmission),
 * and REJECTED (OPEN-01 final rejection). Deletes Drive proof after terminal/revision outcome.
 *
 * @param {string} adminToken - Admin Google ID token.
 * @param {string} verifId - Verification ticket ID.
 * @param {string|boolean} decisionOrApprove - 'APPROVED' | 'NEEDS_REVISION' | 'REJECTED' or boolean.
 * @param {string} reason - Reviewer note (mandatory for NEEDS_REVISION and REJECTED).
 * @returns {Object} Review outcome and newly issued ref_code if approved.
 */
function reviewAlumniVerification(
  adminToken,
  verifId,
  decisionOrApprove,
  reason,
) {
  const adminProfile = requireAdmin_(adminToken);
  const targetVerifId = String(verifId || "").trim();
  if (!targetVerifId) {
    throw new Error("Parameter verif_id wajib diisi.");
  }

  // Acquire ScriptLock before reading ticket state to eliminate concurrent double-review races
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);

  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const verifSheet = ss.getSheetByName(SHEET_NAMES.VERIFICATIONS);
    if (!verifSheet || verifSheet.getLastRow() <= 1) {
      throw new Error("Data verifikasi kosong.");
    }

    const hMap =
      typeof getHeaderMap_ === "function" ? getHeaderMap_(verifSheet) : null;
    const colCount =
      typeof verifSheet.getLastColumn === "function"
        ? Math.max(13, verifSheet.getLastColumn())
        : 13;
    const data = verifSheet
      .getRange(2, 1, verifSheet.getLastRow() - 1, colCount)
      .getValues();
    const idx = function (name, fallback) {
      return hMap && hMap[name] !== undefined ? hMap[name] : fallback;
    };

    let targetRowIdx = -1;
    let verifRecord = null;
    for (let i = 0; i < data.length; i++) {
      if (String(data[i][idx("verif_id", 0)] || "").trim() === targetVerifId) {
        targetRowIdx = i + 2;
        verifRecord = {
          verif_id: data[i][idx("verif_id", 0)],
          user_id: String(data[i][idx("user_id", 1)] || "").trim(),
          email: String(data[i][idx("email", 2)] || "").trim(),
          full_name: String(data[i][idx("full_name", 3)] || "").trim(),
          file_id: String(data[i][idx("proof_file_id", 7)] || "").trim(),
          status: String(data[i][idx("status", 8)] || "").trim(),
          submitted_at: data[i][idx("submitted_at", 9)],
        };
        break;
      }
    }

    if (targetRowIdx === -1 || !verifRecord) {
      throw new Error("Tiket verifikasi tidak ditemukan.");
    }

    const transition = validateVerificationTransition(
      verifRecord.status,
      decisionOrApprove,
      reason,
    );
    if (!transition.ok) {
      throw new Error(transition.error);
    }

    const nowIso = new Date().toISOString();
    const statusCol1 = idx("status", 8) + 1;
    const reviewedByCol1 = idx("reviewed_by", 10) + 1;
    const reviewedAtCol1 = idx("reviewed_at", 11) + 1;
    const reasonCol1 = idx("reject_reason", 12) + 1;

    if (transition.decision === "APPROVED") {
      // Preserve an existing A000xxx code if already minted; otherwise mint next unique sequence
      const userRecord = findUserById_(verifRecord.user_id);
      if (!userRecord) {
        throw new Error(
          "Akun alumni terkait tiket verifikasi tidak ditemukan.",
        );
      }

      let issuedRefCode = String(userRecord.ref_code || "").trim();
      if (!/^A\d{6}$/.test(issuedRefCode)) {
        const seq = getNextAlumniSafeSequence_("ALUMNI");
        issuedRefCode = formatRefCode("A", seq);
      }

      verifSheet.getRange(targetRowIdx, statusCol1).setValue("APPROVED");
      verifSheet
        .getRange(targetRowIdx, reviewedByCol1)
        .setValue(adminProfile.email);
      verifSheet.getRange(targetRowIdx, reviewedAtCol1).setValue(nowIso);
      verifSheet.getRange(targetRowIdx, reasonCol1).setValue("");

      updateUserVerificationStatus_(
        verifRecord.user_id,
        "APPROVED",
        issuedRefCode,
      );
      // Enforce UU PDP data minimization: trash private proof file once review concludes
      deleteDriveFileSafe_(verifRecord.file_id);

      if (typeof sendAlumniVerifiedEmail_ === "function") {
        sendAlumniVerifiedEmail_(
          verifRecord.email,
          verifRecord.full_name,
          issuedRefCode,
        );
      }
      logAudit_(
        adminProfile.email,
        "APPROVE_ALUMNI",
        verifRecord.user_id,
        "Generated Ref Code: " + issuedRefCode,
      );

      return {
        status: "ok",
        verif_id: targetVerifId,
        decision: "APPROVED",
        verification_status: "APPROVED",
        ref_code: issuedRefCode,
      };
    }

    if (transition.decision === "NEEDS_REVISION") {
      verifSheet.getRange(targetRowIdx, statusCol1).setValue("NEEDS_REVISION");
      verifSheet
        .getRange(targetRowIdx, reviewedByCol1)
        .setValue(adminProfile.email);
      verifSheet.getRange(targetRowIdx, reviewedAtCol1).setValue(nowIso);
      verifSheet.getRange(targetRowIdx, reasonCol1).setValue(transition.reason);

      updateUserVerificationStatus_(verifRecord.user_id, "NEEDS_REVISION", "");
      deleteDriveFileSafe_(verifRecord.file_id);

      if (typeof sendAlumniRevisionEmail_ === "function") {
        sendAlumniRevisionEmail_(
          verifRecord.email,
          verifRecord.full_name,
          transition.reason,
        );
      }
      logAudit_(
        adminProfile.email,
        "REQUEST_VERIFICATION_REVISION",
        verifRecord.user_id,
        "Reason: " + transition.reason,
      );

      return {
        status: "ok",
        verif_id: targetVerifId,
        decision: "NEEDS_REVISION",
        verification_status: "NEEDS_REVISION",
        reason: transition.reason,
      };
    }

    // Terminal OPEN-01 REJECTED branch
    verifSheet.getRange(targetRowIdx, statusCol1).setValue("REJECTED");
    verifSheet
      .getRange(targetRowIdx, reviewedByCol1)
      .setValue(adminProfile.email);
    verifSheet.getRange(targetRowIdx, reviewedAtCol1).setValue(nowIso);
    verifSheet.getRange(targetRowIdx, reasonCol1).setValue(transition.reason);

    updateUserVerificationStatus_(verifRecord.user_id, "REJECTED", "");
    deleteDriveFileSafe_(verifRecord.file_id);

    if (typeof sendAlumniRejectedEmail_ === "function") {
      sendAlumniRejectedEmail_(
        verifRecord.email,
        verifRecord.full_name,
        transition.reason,
      );
    }
    logAudit_(
      adminProfile.email,
      "REJECT_ALUMNI",
      verifRecord.user_id,
      "Reason: " + transition.reason,
    );

    return {
      status: "ok",
      verif_id: targetVerifId,
      decision: "REJECTED",
      verification_status: "REJECTED",
      reason: transition.reason,
    };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Increments and returns the next sequence number from 'counters' sheet while
 * guaranteeing the issued sequence is strictly higher than any existing ref_code in 'users'.
 */
function getNextAlumniSafeSequence_(counterName) {
  const targetName = String(counterName || "")
    .trim()
    .toUpperCase();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const userSheet = ss.getSheetByName(SHEET_NAMES.USERS);
  let maxExisting = 0;

  if (userSheet && userSheet.getLastRow() > 1) {
    const prefix = targetName === "GUEST" ? "G" : "A";
    const regex = new RegExp("^" + prefix + "(\\d{6})$");
    const uRows = userSheet.getDataRange().getValues();
    const uMap =
      typeof getHeaderMap_ === "function" ? getHeaderMap_(userSheet) : null;
    const refIdx = uMap && uMap.ref_code !== undefined ? uMap.ref_code : 5;
    for (let i = 1; i < uRows.length; i++) {
      const m = String(uRows[i][refIdx] || "")
        .trim()
        .toUpperCase()
        .match(regex);
      if (m) {
        const num = parseInt(m[1], 10);
        if (!isNaN(num) && num > maxExisting) maxExisting = num;
      }
    }
  }

  const sheet = ss.getSheetByName(SHEET_NAMES.COUNTERS);
  const lastRow = sheet.getLastRow();

  for (let i = 2; i <= lastRow; i++) {
    const name = String(sheet.getRange(i, 1).getValue()).trim().toUpperCase();
    if (name === targetName) {
      const currentVal = parseInt(sheet.getRange(i, 2).getValue(), 10) || 0;
      const nextVal = Math.max(currentVal, maxExisting) + 1;
      sheet.getRange(i, 2).setValue(nextVal);
      return nextVal;
    }
  }

  const initialNext = maxExisting + 1;
  sheet.appendRow([targetName, initialNext]);
  return initialNext;
}

/**
 * Preserved legacy alias for counter increments (called by other existing modules).
 */
function getNextCounterValue_(counterName) {
  return getNextAlumniSafeSequence_(counterName);
}

/**
 * Updates a user's verification_status and optional ref_code using header mapping.
 */
function updateUserVerificationStatus_(userId, status, refCode) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_NAMES.USERS);
  const data = sheet.getDataRange().getValues();
  const uMap =
    typeof getHeaderMap_ === "function" ? getHeaderMap_(sheet) : null;
  const uidIdx = uMap && uMap.user_id !== undefined ? uMap.user_id : 0;
  const refCol1 = (uMap && uMap.ref_code !== undefined ? uMap.ref_code : 5) + 1;
  const verCol1 =
    (uMap && uMap.verification_status !== undefined
      ? uMap.verification_status
      : 6) + 1;

  for (let i = 1; i < data.length; i++) {
    if (String(data[i][uidIdx]).trim() === userId) {
      const rowIdx = i + 1;
      if (refCode) {
        sheet.getRange(rowIdx, refCol1).setValue(refCode);
      }
      sheet.getRange(rowIdx, verCol1).setValue(status);
      return;
    }
  }
}

/**
 * Updates a user's role using header mapping.
 */
function updateUserRole_(userId, newRole) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_NAMES.USERS);
  const data = sheet.getDataRange().getValues();
  const uMap =
    typeof getHeaderMap_ === "function" ? getHeaderMap_(sheet) : null;
  const uidIdx = uMap && uMap.user_id !== undefined ? uMap.user_id : 0;
  const roleCol1 = (uMap && uMap.role !== undefined ? uMap.role : 4) + 1;

  for (let i = 1; i < data.length; i++) {
    if (String(data[i][uidIdx]).trim() === userId) {
      sheet.getRange(i + 1, roleCol1).setValue(newRole);
      return;
    }
  }
}

/**
 * Searches user record by email in 'users' sheet via header mapping.
 */
function findUserByEmail_(email) {
  if (!email) return null;
  const target = email.trim().toLowerCase();
  return findUserByPredicate_(function (u) {
    return (
      String(u.email || "")
        .trim()
        .toLowerCase() === target
    );
  });
}

/**
 * Searches user record by immutable Google 'sub' identifier to avoid duplicate logins.
 */
function findUserByGoogleSub_(sub) {
  if (!sub) return null;
  const target = String(sub).trim();
  return findUserByPredicate_(function (u) {
    return String(u.google_sub || "").trim() === target;
  });
}

/**
 * Searches user record by internal user_id.
 */
function findUserById_(userId) {
  if (!userId) return null;
  const target = String(userId).trim();
  return findUserByPredicate_(function (u) {
    return String(u.user_id || "").trim() === target;
  });
}

/**
 * Header-aware single-user lookup helper shared by email, google_sub, and user_id queries.
 */
function findUserByPredicate_(predicateFn) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_NAMES.USERS);
  if (!sheet || sheet.getLastRow() <= 1) return null;

  const uMap =
    typeof getHeaderMap_ === "function" ? getHeaderMap_(sheet) : null;
  const idx = function (name, fallback) {
    return uMap && uMap[name] !== undefined ? uMap[name] : fallback;
  };
  const data = sheet.getDataRange().getValues();

  for (let i = 1; i < data.length; i++) {
    const rec = {
      user_id: data[i][idx("user_id", 0)],
      google_sub: data[i][idx("google_sub", 1)],
      email: data[i][idx("email", 2)],
      full_name: data[i][idx("full_name", 3)],
      role: data[i][idx("role", 4)],
      ref_code: data[i][idx("ref_code", 5)],
      verification_status: data[i][idx("verification_status", 6)],
      consent_at: data[i][idx("consent_at", 7)],
      created_at: data[i][idx("created_at", 8)],
    };
    if (predicateFn(rec)) return rec;
  }
  return null;
}

/**
 * Returns chronological decision history for a user without exposing private Drive file IDs.
 */
function getVerificationHistoryForUser_(userId) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_NAMES.VERIFICATIONS);
  if (!sheet || sheet.getLastRow() <= 1) return [];

  const hMap =
    typeof getHeaderMap_ === "function" ? getHeaderMap_(sheet) : null;
  const idx = function (name, fallback) {
    return hMap && hMap[name] !== undefined ? hMap[name] : fallback;
  };
  const rows = sheet.getDataRange().getValues();
  const out = [];

  for (let i = 1; i < rows.length; i++) {
    if (
      String(rows[i][idx("user_id", 1)] || "").trim() !== String(userId).trim()
    )
      continue;
    out.push({
      verif_id: rows[i][idx("verif_id", 0)],
      nim: rows[i][idx("nim", 4)],
      grad_year: rows[i][idx("grad_year", 5)],
      faculty: rows[i][idx("faculty", 6)],
      status: normalizeVerificationStatus(rows[i][idx("status", 8)]),
      submitted_at: rows[i][idx("submitted_at", 9)],
      reviewed_by: rows[i][idx("reviewed_by", 10)],
      reviewed_at: rows[i][idx("reviewed_at", 11)],
      reject_reason: rows[i][idx("reject_reason", 12)],
    });
  }
  return out.reverse();
}

/**
 * Returns latest reviewer note for a user (used when NEEDS_REVISION or REJECTED).
 */
function getLatestVerificationNoteForUser_(userId) {
  const history = getVerificationHistoryForUser_(userId);
  for (let i = 0; i < history.length; i++) {
    if (history[i].reject_reason) {
      return String(history[i].reject_reason);
    }
  }
  return "";
}

/**
 * Cleans up leftover Drive files from prior tickets before saving a revised proof upload.
 */
function cleanupUserPreviousProofFiles_(userId) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_NAMES.VERIFICATIONS);
  if (!sheet || sheet.getLastRow() <= 1) return;

  const rows = sheet.getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) {
    if (
      String(rows[i][1] || "").trim() === String(userId).trim() &&
      rows[i][7]
    ) {
      deleteDriveFileSafe_(rows[i][7]);
    }
  }
}

/**
 * Safely removes proof file from Google Drive to respect data minimization.
 */
function deleteDriveFileSafe_(fileId) {
  if (!fileId) return;
  try {
    const file = DriveApp.getFileById(fileId);
    file.setTrashed(true);
  } catch (e) {
    Logger.log("Could not trash drive file " + fileId + ": " + e.message);
  }
}

/**
 * Retrieves or creates private Google Drive folder for incoming proofs.
 */
function getOrCreatePrivateFolder_(folderName) {
  const folders = DriveApp.getFoldersByName(folderName);
  if (folders.hasNext()) {
    return folders.next();
  }
  const created = DriveApp.createFolder(folderName);
  created.setSharing(DriveApp.Access.ANYONE, DriveApp.Permission.NONE);
  return created;
}
