/**
 * Users.gs
 * User registration, profile fetching, alumni verification submission, and admin review logic.
 */

/**
 * Registers or returns existing user record.
 * Generates guest reference code (G000xxx) if registering as GUEST.
 * Alumni starts with verification_status = NONE and no ref_code until verified.
 * 
 * @param {string} idToken - Google ID Token.
 * @param {string} requestedRole - 'ALUMNI' or 'GUEST'.
 * @param {boolean} consent - Privacy consent flag (UU PDP).
 * @returns {Object} User profile state.
 */
function registerOrLoginUser(idToken, requestedRole, consent) {
  const profile = verifyIdToken(idToken);
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const userSheet = ss.getSheetByName(SHEET_NAMES.USERS);

  let existing = findUserByEmail_(profile.email);
  if (existing) {
    // If user is configured in ADMIN_EMAILS, elevate to ADMIN
    if (isAdminEmail_(existing.email) && existing.role !== 'ADMIN') {
      updateUserRole_(existing.user_id, 'ADMIN');
      existing.role = 'ADMIN';
    }
    return existing;
  }

  // Prevent registration without explicit privacy consent
  if (!consent) {
    throw new Error('Persetujuan pemrosesan data pribadi (UU No. 27/2022) wajib disetujui.');
  }

  // Lock counter to avoid race condition in ref_code sequencing
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);

  try {
    const now = new Date();
    const userId = 'USR_' + Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, profile.email + '_' + now.getTime())).substring(0, 10);
    let role = (requestedRole || 'GUEST').toUpperCase();
    if (isAdminEmail_(profile.email)) {
      role = 'ADMIN';
    }

    let refCode = '';
    let verifStatus = 'NONE';

    // If registering as GUEST, immediately issue Guest Reference Code (G000xxx)
    if (role === 'GUEST') {
      const seq = getNextCounterValue_('GUEST');
      refCode = formatRefCode('G', seq);
      verifStatus = 'NONE';
    } else if (role === 'ADMIN') {
      // Admin also gets an ID for administrative testing
      const seq = getNextCounterValue_('ALUMNI');
      refCode = formatRefCode('A', seq);
      verifStatus = 'VERIFIED';
    } else {
      // Alumni role: must submit verification proof first
      verifStatus = 'NONE';
      refCode = '';
    }

    const row = [
      userId,
      profile.sub,
      profile.email,
      profile.name,
      role,
      refCode,
      verifStatus,
      now.toISOString(),
      now.toISOString()
    ];

    userSheet.appendRow(row);
    logAudit_(profile.email, 'REGISTER', userId, 'Registered as ' + role + (refCode ? ' with ref ' + refCode : ''));

    return {
      user_id: userId,
      email: profile.email,
      full_name: profile.name,
      role: role,
      ref_code: refCode,
      verification_status: verifStatus
    };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Submits alumni graduation verification request.
 * Saves proof document to a private Drive folder, marks user as PENDING.
 * 
 * @param {string} idToken - Google auth token.
 * @param {Object} data - {nim, grad_year, faculty, file_base64, file_name, file_mime}
 * @returns {Object} Created verification ticket.
 */
function submitAlumniVerification(idToken, data) {
  const profile = verifyIdToken(idToken);
  const user = findUserByEmail_(profile.email);
  if (!user) throw new Error('Pengguna tidak ditemukan.');
  if (user.role === 'GUEST') throw new Error('Akun tamu tidak dapat mengajukan verifikasi alumni.');
  if (user.verification_status === 'VERIFIED') throw new Error('Akun Anda sudah berstatus Alumni Terverifikasi (' + user.ref_code + ').');

  if (!data.nim || !data.grad_year || !data.faculty) {
    throw new Error('NIM, Tahun Lulus, dan Fakultas wajib diisi.');
  }

  // Upload proof document to private Drive folder
  let fileId = '';
  if (data.file_base64) {
    const bytes = Utilities.base64Decode(data.file_base64);
    // Limit proof file size to 5MB
    if (bytes.length > 5 * 1024 * 1024) {
      throw new Error('Ukuran file bukti melebihi batas 5MB.');
    }
    const blob = Utilities.newBlob(bytes, data.file_mime || 'application/pdf', (data.file_name || 'bukti_alumni') + '_' + user.user_id);
    const folder = getOrCreatePrivateFolder_('DonasiAlumni_Bukti_Privat');
    const file = folder.createFile(blob);
    // Ensure file is private (only owner/admin has access)
    file.setSharing(DriveApp.Access.ANYONE, DriveApp.Permission.NONE);
    fileId = file.getId();
  }

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const verifSheet = ss.getSheetByName(SHEET_NAMES.VERIFICATIONS);
  const verifId = 'VRF_' + Utilities.getUuid().substring(0, 8);
  const now = new Date();

  verifSheet.appendRow([
    verifId,
    user.user_id,
    user.email,
    user.full_name,
    String(data.nim).trim(),
    String(data.grad_year).trim(),
    String(data.faculty).trim(),
    fileId,
    'PENDING',
    now.toISOString(),
    '', // reviewed_by
    '', // reviewed_at
    ''  // reject_reason
  ]);

  // Update user verification status to PENDING
  updateUserVerificationStatus_(user.user_id, 'PENDING', '');
  logAudit_(user.email, 'SUBMIT_VERIFICATION', verifId, 'NIM: ' + data.nim + ' Thn: ' + data.grad_year);

  // Notify admin via email
  sendAdminNewVerificationAlert_(user, verifId, data);

  return {
    status: 'ok',
    verif_id: verifId,
    verification_status: 'PENDING',
    message: 'Pengajuan verifikasi alumni berhasil dikirim dan sedang menunggu tinjauan admin.'
  };
}

/**
 * Admin reviews an alumni verification ticket.
 * On APPROVAL: Generates sequential Alumni Ref Code (A000471) via LockService,
 * updates user status to VERIFIED, deletes proof document from Drive (UU PDP data minimization),
 * and dispatches congratulatory email with ref_code to the alumnus.
 * On REJECTION: Records reason, deletes proof document, and emails user.
 * 
 * @param {string} adminToken - Admin ID token.
 * @param {string} verifId - Verification ticket ID.
 * @param {boolean} approve - True if approved, false if rejected.
 * @param {string} reason - Rejection explanation if false.
 * @returns {Object} Review outcome.
 */
function reviewAlumniVerification(adminToken, verifId, approve, reason) {
  const adminProfile = verifyIdToken(adminToken);
  if (!isAdminEmail_(adminProfile.email)) {
    throw new Error('Hanya administrator yang berwenang meninjau verifikasi alumni.');
  }

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const verifSheet = ss.getSheetByName(SHEET_NAMES.VERIFICATIONS);
  const lastRow = verifSheet.getLastRow();
  if (lastRow <= 1) throw new Error('Data verifikasi kosong.');

  const data = verifSheet.getRange(2, 1, lastRow - 1, 13).getValues();
  let targetRowIdx = -1;
  let verifRecord = null;

  for (let i = 0; i < data.length; i++) {
    if (String(data[i][0]).trim() === verifId) {
      targetRowIdx = i + 2;
      verifRecord = {
        verif_id: data[i][0],
        user_id: data[i][1],
        email: data[i][2],
        full_name: data[i][3],
        nim: data[i][4],
        file_id: data[i][7],
        status: data[i][8]
      };
      break;
    }
  }

  if (targetRowIdx === -1 || !verifRecord) {
    throw new Error('Tiket verifikasi tidak ditemukan.');
  }

  if (verifRecord.status !== 'PENDING') {
    throw new Error('Tiket ini sudah diproses sebelumnya dengan status: ' + verifRecord.status);
  }

  const now = new Date();
  let generatedRefCode = '';

  const lock = LockService.getScriptLock();
  lock.waitLock(15000);

  try {
    if (approve) {
      // Issue unique Alumni Reference Code (e.g., A000471)
      const seq = getNextCounterValue_('ALUMNI');
      generatedRefCode = formatRefCode('A', seq);

      // Update verifications row
      verifSheet.getRange(targetRowIdx, 9, 1, 5).setValues([[
        'VERIFIED',
        verifRecord.submitted_at || now.toISOString(),
        adminProfile.email,
        now.toISOString(),
        ''
      ]]);

      // Update user status & ref_code
      updateUserVerificationStatus_(verifRecord.user_id, 'VERIFIED', generatedRefCode);

      // UU PDP: Delete sensitive proof file from Drive immediately after review
      deleteDriveFileSafe_(verifRecord.file_id);

      // Send congratulations email to alumni
      sendAlumniVerifiedEmail_(verifRecord.email, verifRecord.full_name, generatedRefCode);
      logAudit_(adminProfile.email, 'APPROVE_ALUMNI', verifRecord.user_id, 'Generated Ref Code: ' + generatedRefCode);

      return {
        status: 'ok',
        verif_id: verifId,
        decision: 'VERIFIED',
        ref_code: generatedRefCode
      };
    } else {
      // Rejection branch
      verifSheet.getRange(targetRowIdx, 9, 1, 5).setValues([[
        'REJECTED',
        verifRecord.submitted_at || now.toISOString(),
        adminProfile.email,
        now.toISOString(),
        reason || 'Bukti dokumen tidak sesuai ketentuan kelulusan UPI.'
      ]]);

      updateUserVerificationStatus_(verifRecord.user_id, 'REJECTED', '');
      deleteDriveFileSafe_(verifRecord.file_id);

      sendAlumniRejectedEmail_(verifRecord.email, verifRecord.full_name, reason);
      logAudit_(adminProfile.email, 'REJECT_ALUMNI', verifRecord.user_id, 'Reason: ' + reason);

      return {
        status: 'ok',
        verif_id: verifId,
        decision: 'REJECTED'
      };
    }
  } finally {
    lock.releaseLock();
  }
}

/**
 * Increments and returns the next sequence number from 'counters' sheet.
 */
function getNextCounterValue_(counterName) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_NAMES.COUNTERS);
  const lastRow = sheet.getLastRow();

  for (let i = 2; i <= lastRow; i++) {
    const name = String(sheet.getRange(i, 1).getValue()).trim().toUpperCase();
    if (name === counterName.toUpperCase()) {
      const currentVal = parseInt(sheet.getRange(i, 2).getValue(), 10) || 0;
      const nextVal = currentVal + 1;
      sheet.getRange(i, 2).setValue(nextVal);
      return nextVal;
    }
  }

  // If counter doesn't exist, append new row
  sheet.appendRow([counterName.toUpperCase(), 1]);
  return 1;
}

/**
 * Updates a user's verification_status and optional ref_code.
 */
function updateUserVerificationStatus_(userId, status, refCode) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_NAMES.USERS);
  const data = sheet.getDataRange().getValues();

  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim() === userId) {
      const rowIdx = i + 1;
      if (refCode) {
        sheet.getRange(rowIdx, 6).setValue(refCode); // ref_code at col 6
      }
      sheet.getRange(rowIdx, 7).setValue(status);     // verification_status at col 7
      return;
    }
  }
}

/**
 * Updates a user's role.
 */
function updateUserRole_(userId, newRole) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_NAMES.USERS);
  const data = sheet.getDataRange().getValues();

  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim() === userId) {
      sheet.getRange(i + 1, 5).setValue(newRole); // role at col 5
      return;
    }
  }
}

/**
 * Searches user record by email in 'users' sheet.
 */
function findUserByEmail_(email) {
  if (!email) return null;
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_NAMES.USERS);
  if (!sheet) return null;

  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][2]).trim().toLowerCase() === email.trim().toLowerCase()) {
      return {
        user_id: data[i][0],
        google_sub: data[i][1],
        email: data[i][2],
        full_name: data[i][3],
        role: data[i][4],
        ref_code: data[i][5],
        verification_status: data[i][6],
        consent_at: data[i][7],
        created_at: data[i][8]
      };
    }
  }
  return null;
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
    Logger.log('Could not trash drive file ' + fileId + ': ' + e.message);
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

