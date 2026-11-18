/**
 * Auth.gs
 * Google OAuth ID Token verification (fail-closed), centralized RBAC,
 * and manual webhook HMAC-SHA256 authentication.
 */

/**
 * Reads configuration safely, prioritizing ScriptProperties over the config sheet.
 * Pure secrets must pass allowSheetFallback = false so they are never read from Sheets.
 *
 * @param {string} key - Configuration property name.
 * @param {boolean} allowSheetFallback - Whether non-secret config sheet fallback is permitted.
 * @returns {string} Trimmed setting value or empty string.
 */
function getSecureConfig_(key, allowSheetFallback) {
  try {
    // Check Google Apps Script ScriptProperties first for authoritative backend configuration
    const props = PropertiesService.getScriptProperties();
    const propVal = props ? props.getProperty(key) : null;
    if (propVal !== null && propVal !== undefined && String(propVal).trim() !== "") {
      return String(propVal).trim();
    }
  } catch (err) {
    Logger.log("ScriptProperties read warning for key " + key + ": " + err.message);
  }

  // Only non-secret operational values may fall back to the config tab in Google Sheets
  if (allowSheetFallback && typeof getConfig_ === "function") {
    return String(getConfig_(key) || "").trim();
  }
  return "";
}

/**
 * Constant-time string comparison to reduce timing side-channel leakage on signatures.
 *
 * @param {string} a - First hex/token string.
 * @param {string} b - Second hex/token string.
 * @returns {boolean} True when both strings match identically.
 */
function constantTimeEqual_(a, b) {
  const strA = String(a || "");
  const strB = String(b || "");
  let mismatch = strA.length ^ strB.length;
  const maxLen = Math.max(strA.length, strB.length);
  for (let i = 0; i < maxLen; i++) {
    const codeA = i < strA.length ? strA.charCodeAt(i) : 0;
    const codeB = i < strB.length ? strB.charCodeAt(i) : 0;
    mismatch |= codeA ^ codeB;
  }
  return mismatch === 0 && strA.length > 0;
}

/**
 * Converts a signed Apps Script byte array into a lowercase hexadecimal string.
 *
 * @param {Array<number>} bytes - Signed byte array returned by Utilities digests/HMAC.
 * @returns {string} Lowercase hex string.
 */
function bytesToHex_(bytes) {
  return (bytes || [])
    .map(function (b) {
      // Mask negative signed bytes with 0xff before converting to 2-digit hex
      const unsigned = b & 0xff;
      return (unsigned < 16 ? "0" : "") + unsigned.toString(16);
    })
    .join("");
}

/**
 * Validates Google id_token using Google's tokeninfo endpoint with fail-closed audience checks.
 * Mock tokens are strictly blocked unless ALLOW_MOCK_AUTH is explicitly "true".
 *
 * @param {string} idToken - Raw JWT credential string from POST JSON body.
 * @returns {Object} Verified user profile {sub, email, name, picture}.
 */
function verifyIdToken(idToken) {
  if (!idToken || typeof idToken !== "string") {
    throw new Error("Authentication required: Missing ID token.");
  }

  const trimmedToken = idToken.trim();
  if (!trimmedToken) {
    throw new Error("Authentication required: Missing ID token.");
  }

  // Strictly block mock tokens in production unless explicitly enabled in ScriptProperties
  if (trimmedToken.startsWith("mock_token_")) {
    const allowMock =
      getSecureConfig_("ALLOW_MOCK_AUTH", false).toLowerCase() === "true";
    if (!allowMock) {
      if (typeof logAudit_ === "function") {
        logAudit_(
          "SECURITY_GATE",
          "BLOCKED_MOCK_TOKEN",
          "verifyIdToken",
          "Blocked mock_token attempt because ALLOW_MOCK_AUTH is disabled.",
        );
      }
      throw new Error("Unauthorized: Mock authentication is disabled in live mode.");
    }

    const parts = trimmedToken.split("_");
    const role = parts[2] ? parts[2].toUpperCase() : "GUEST";
    const email =
      role === "ADMIN" ? "maulanaa1408@upi.edu" : "user.demo@alumni.upi.edu";
    return {
      sub: "mock_sub_" + role.toLowerCase(),
      email: email,
      name: role === "ADMIN" ? "Maulana Admin" : "Alumni Demo",
      picture: "",
    };
  }

  // Enforce fail-closed client ID validation so third-party OAuth tokens cannot be replayed
  const expectedClientId = getSecureConfig_("GOOGLE_CLIENT_ID", true);
  if (!expectedClientId) {
    throw new Error(
      "Server authentication misconfigured: GOOGLE_CLIENT_ID is required.",
    );
  }

  // Check user cache keyed by token digest and expectedClientId to avoid cross-config stale cache
  const cache = CacheService.getUserCache();
  const digestSeed = expectedClientId + "::" + trimmedToken;
  const cacheKey =
    "auth_" +
    Utilities.base64Encode(
      Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, digestSeed),
    ).substring(0, 32);

  if (cache) {
    const cachedUser = cache.get(cacheKey);
    if (cachedUser) {
      return JSON.parse(cachedUser);
    }
  }

  // Validate token signature, expiry, and claims against Google tokeninfo endpoint
  const url =
    "https://oauth2.googleapis.com/tokeninfo?id_token=" +
    encodeURIComponent(trimmedToken);
  const response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });

  if (response.getResponseCode() !== 200) {
    throw new Error("Unauthorized: Invalid or expired Google token.");
  }

  const payload = JSON.parse(response.getContentText());

  // Verify token audience matches this application's Google Client ID
  if (!payload.aud || payload.aud !== expectedClientId) {
    if (typeof logAudit_ === "function") {
      logAudit_(
        payload.email || "UNKNOWN",
        "BLOCKED_AUD_MISMATCH",
        "verifyIdToken",
        "Token audience mismatch detected.",
      );
    }
    throw new Error(
      "Unauthorized: Token was not issued for this application.",
    );
  }

  // Reject unverified email claims to prevent identity spoofing
  if (String(payload.email_verified).toLowerCase() !== "true" || !payload.email) {
    throw new Error("Unauthorized: Google account email is not verified.");
  }

  const user = {
    sub: payload.sub,
    email: String(payload.email).toLowerCase().trim(),
    name: payload.name || payload.email,
    picture: payload.picture || "",
  };

  // Cache verified claims for 10 minutes (600 seconds)
  if (cache) {
    cache.put(cacheKey, JSON.stringify(user), 600);
  }
  return user;
}

/**
 * Authenticates an explicit ID token from POST body and returns the user's sheet record.
 *
 * @param {string} idToken - Google ID Token extracted from POST JSON body.
 * @returns {Object} Registered database user record.
 */
function requireUser_(idToken) {
  const profile = verifyIdToken(idToken);
  const user = findUserByEmail_(profile.email);
  if (!user) {
    throw new Error("User not registered. Please complete registration first.");
  }
  return user;
}

/**
 * Centralized admin authorization guard.
 * Validates Google token, confirms email exists in trusted backend ADMIN_EMAILS,
 * and confirms the database user record holds role === "ADMIN".
 *
 * @param {string} idToken - Google ID Token extracted from POST JSON body.
 * @returns {Object} Authenticated administrator user record.
 */
function requireAdmin_(idToken) {
  const user = requireUser_(idToken);
  const userRole = String(user.role || "").toUpperCase();

  if (!isAdminEmail_(user.email) || userRole !== "ADMIN") {
    if (typeof logAudit_ === "function") {
      logAudit_(
        user.email,
        "UNAUTHORIZED_ADMIN_ACCESS",
        "requireAdmin_",
        "Non-admin account attempted administrative operation.",
      );
    }
    throw new Error("Forbidden: Access restricted to system administrators.");
  }
  return user;
}

/**
 * Authoritative resolver for trusted administrator email allowlist.
 * Prioritizes ScriptProperties.ADMIN_EMAILS over non-secret config sheet fallback,
 * returning an empty array when unconfigured (no hardcoded fallback email).
 *
 * @returns {string[]} Lowercase trimmed administrator email list.
 */
function getAuthorizedAdminEmails_() {
  const adminEmailsRaw = getSecureConfig_("ADMIN_EMAILS", true);
  if (!adminEmailsRaw) return [];

  return adminEmailsRaw
    .split(",")
    .map(function (s) {
      return s.trim().toLowerCase();
    })
    .filter(Boolean);
}

/**
 * Checks if an email is listed in trusted backend ADMIN_EMAILS configuration.
 *
 * @param {string} email - Target email address.
 * @returns {boolean} True when explicitly listed as admin in backend configuration.
 */
function isAdminEmail_(email) {
  if (!email) return false;
  const adminList = getAuthorizedAdminEmails_();
  return adminList.indexOf(String(email).trim().toLowerCase()) !== -1;
}

/**
 * Authenticates incoming manual bank mutation webhooks via HMAC-SHA256 and timestamp
 * inside the JSON POST body (eliminating static URL query tokens).
 *
 * Expected canonical signed message: `${timestamp}.${nonce}.${payload_raw}`
 *
 * @param {Object} body - Parsed JSON POST request body.
 * @returns {Array<Object>} Parsed array of bank mutation objects after verification.
 */
function verifyManualWebhookAuth_(body) {
  // Secret must come strictly from ScriptProperties (fail-closed if unconfigured)
  const secret = getSecureConfig_("WEBHOOK_MANUAL_SECRET", false);
  if (!secret) {
    throw new Error(
      "Unauthorized: Server webhook secret is not configured in ScriptProperties.",
    );
  }

  const auth = body && body.webhook_auth ? body.webhook_auth : null;
  if (
    !auth ||
    !auth.timestamp ||
    !auth.nonce ||
    !auth.signature ||
    typeof body.payload_raw !== "string"
  ) {
    throw new Error("Unauthorized: Missing webhook HMAC authentication fields.");
  }

  const timestamp = String(auth.timestamp).trim();
  const nonce = String(auth.nonce).trim();
  const providedSig = String(auth.signature).trim().toLowerCase();

  // Validate numeric epoch timestamp within a +/- 300-second window to block stale replays
  if (!/^\d+$/.test(timestamp)) {
    throw new Error("Unauthorized: Invalid webhook timestamp format.");
  }
  const nowSec = Math.floor(Date.now() / 1000);
  const tsSec = parseInt(timestamp, 10);
  if (Math.abs(nowSec - tsSec) > 300) {
    throw new Error("Unauthorized: Webhook timestamp expired or skewed.");
  }

  // Validate nonce format and prevent duplicate nonce replay inside the 5-minute window
  if (!/^[A-Za-z0-9_\-]{8,64}$/.test(nonce)) {
    throw new Error("Unauthorized: Invalid webhook nonce format.");
  }

  // Compute expected HMAC-SHA256 digest over timestamp, nonce, and exact payload string
  const message = timestamp + "." + nonce + "." + body.payload_raw;
  const sigBytes = Utilities.computeHmacSha256Signature(message, secret);
  const expectedSig = bytesToHex_(sigBytes);

  if (!constantTimeEqual_(providedSig, expectedSig)) {
    if (typeof logAudit_ === "function") {
      logAudit_(
        "WEBHOOK_GATE",
        "INVALID_WEBHOOK_HMAC",
        "verifyManualWebhookAuth_",
        "Rejected manual webhook due to HMAC signature mismatch.",
      );
    }
    throw new Error("Unauthorized: Invalid webhook HMAC signature.");
  }

  // Enforce single-use nonce cache only after signature checks succeed
  const cache = CacheService.getScriptCache();
  if (cache) {
    const nonceKey = "wh_nonce_" + nonce;
    if (cache.get(nonceKey)) {
      throw new Error("Unauthorized: Duplicate webhook nonce replay detected.");
    }
    cache.put(nonceKey, "1", 360);
  }

  const parsedPayload = JSON.parse(body.payload_raw);
  return Array.isArray(parsedPayload) ? parsedPayload : [parsedPayload];
}

/**
 * Generates an opaque 64-hex-char (256-bit output) guest access token.
 * Uses Web Crypto CSPRNG (32 raw bytes) when available in compatible V8 shims/tests.
 *
 * GAS Runtime Limitation: Native Google Apps Script V8 does not expose
 * crypto.getRandomValues() or Node crypto.randomBytes(). In native GAS, this function
 * mixes 4 RFC 4122 UUIDv4 calls (122 random bits each = 488 nominal bits) through SHA-256.
 * Because Google does not publicly guarantee internal SecureRandom seeding of Utilities.getUuid(),
 * strict 256-bit cryptographic strength in GAS runtime relies on Google's JVM UUIDv4 CSPRNG.
 *
 * @returns {string} 64-character lowercase hexadecimal token (never logged or stored plaintext).
 */
function generateGuestAccessToken_() {
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    const rawBytes = new Uint8Array(32);
    crypto.getRandomValues(rawBytes);
    const hexParts = [];
    for (let i = 0; i < rawBytes.length; i++) {
      const h = rawBytes[i].toString(16);
      hexParts.push(h.length === 1 ? "0" + h : h);
    }
    return hexParts.join("");
  }

  // Do not count predictable timestamps as secret entropy; mix 4 independent UUIDv4 tokens
  const seed =
    Utilities.getUuid() +
    ":" +
    Utilities.getUuid() +
    ":" +
    Utilities.getUuid() +
    ":" +
    Utilities.getUuid();
  const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, seed);
  return bytesToHex_(digest);
}

/**
 * Computes a canonical SHA-256 fingerprint of a Guest checkout payload so idempotency retries
 * cannot silently alter amount, email, program, or payment channel under the same request ID.
 *
 * @param {Object} clean - Validated Guest donor input object.
 * @param {string} programId - Resolved authoritative program_id.
 * @returns {string} Hex SHA-256 payload digest.
 */
function computeGuestPayloadHash_(clean, programId) {
  const canonical = [
    String(clean.donor_name || "").trim(),
    String(clean.donor_email || "").trim().toLowerCase(),
    String(clean.amount || 0),
    String(programId || "").trim().toUpperCase(),
    String(clean.payment_channel || "").trim().toUpperCase(),
    String(clean.bank || "").trim().toUpperCase(),
    String(clean.is_anonymous || "NO").trim().toUpperCase(),
  ].join("|");
  return bytesToHex_(
    Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, canonical),
  );
}

/**
 * Computes a peppered SHA-256 digest binding client_request_id to the caller's ephemeral
 * idempotency_proof secret (fail-closed if TOKEN_PEPPER is absent in ScriptProperties).
 *
 * @param {string} clientRequestId - Caller-generated request UUID/identifier.
 * @param {string} idempotencyProof - Ephemeral high-entropy caller secret held in browser sessionStorage.
 * @returns {string} Hex SHA-256 proof digest.
 */
function computeIdempotencyProofHash_(clientRequestId, idempotencyProof) {
  const reqId = String(clientRequestId || "").trim();
  const proof = String(idempotencyProof || "").trim();
  if (!reqId || !proof || proof.length < 32) {
    throw new Error("Forbidden: Valid idempotency_proof (minimum 32 chars) is required.");
  }
  const pepper = getSecureConfig_("TOKEN_PEPPER", false);
  if (!pepper) {
    throw new Error(
      "Server security misconfigured: TOKEN_PEPPER is required in ScriptProperties.",
    );
  }
  return bytesToHex_(
    Utilities.computeDigest(
      Utilities.DigestAlgorithm.SHA_256,
      pepper + "::idem::" + reqId + "::" + proof,
    ),
  );
}

/**
 * Computes a peppered SHA-256 digest of a raw guest access token.
 * Fails closed when TOKEN_PEPPER is absent from ScriptProperties.
 *
 * @param {string} rawToken - Raw 64-hex-char guest access token from POST body.
 * @returns {string} Hex-encoded SHA-256 token hash safe for database storage.
 */
function hashAccessToken_(rawToken) {
  const tokenStr = String(rawToken || "").trim();
  if (!tokenStr) {
    throw new Error("Authentication required: Missing access_token.");
  }
  const pepper = getSecureConfig_("TOKEN_PEPPER", false);
  if (!pepper) {
    throw new Error(
      "Server security misconfigured: TOKEN_PEPPER is required in ScriptProperties.",
    );
  }
  const digest = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    pepper + "::" + tokenStr,
  );
  return bytesToHex_(digest);
}

/**
 * Records failed guest token attempts in ScriptCache to slow down brute-force guessing.
 * Never logs raw token values in cache keys or audit logs.
 */
function enforceGuestTokenRateLimit_(scopeKey, shouldIncrement) {
  const cache = CacheService.getScriptCache();
  if (!cache || !scopeKey) return;
  const safeScope = bytesToHex_(
    Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, String(scopeKey)),
  ).substring(0, 16);
  const key = "gt_fail_" + safeScope;
  const current = parseInt(cache.get(key) || "0", 10) || 0;

  if (current >= 10) {
    throw new Error(
      "Too Many Requests: Percobaan token tidak valid terlalu banyak. Coba lagi nanti.",
    );
  }
  if (shouldIncrement) {
    cache.put(key, String(current + 1), 900);
  }
}

/**
 * Validates a guest access_token against stored SHA-256 hash and expiry timestamp.
 * Uses constant-time equality and rate-limiting without logging secret token strings.
 *
 * @param {string} rawToken - Raw 256-bit hex access_token provided by Guest.
 * @param {string} storedHash - Persisted access_token_hash from donation_intents/transactions.
 * @param {string} expiresAtIso - ISO expiry timestamp string.
 * @param {string} scopeKey - Rate-limit bucket identifier (e.g. intent_id or ref_code).
 * @returns {boolean} True when valid and unexpired; otherwise throws Unauthorized/Forbidden.
 */
function verifyGuestAccessToken_(rawToken, storedHash, expiresAtIso, scopeKey) {
  enforceGuestTokenRateLimit_(scopeKey, false);

  const tokenStr = String(rawToken || "").trim();
  if (!/^[a-f0-9]{64}$/i.test(tokenStr)) {
    enforceGuestTokenRateLimit_(scopeKey, true);
    throw new Error("Unauthorized: Invalid guest access_token format.");
  }

  if (!storedHash || !String(storedHash).trim()) {
    enforceGuestTokenRateLimit_(scopeKey, true);
    throw new Error("Forbidden: Access token is not configured for this record.");
  }

  if (expiresAtIso) {
    const expDate = new Date(expiresAtIso);
    if (isNaN(expDate.getTime()) || expDate.getTime() < Date.now()) {
      throw new Error("Unauthorized: Guest access_token has expired.");
    }
  }

  const candidateHash = hashAccessToken_(tokenStr);
  if (!constantTimeEqual_(candidateHash.toLowerCase(), String(storedHash).trim().toLowerCase())) {
    enforceGuestTokenRateLimit_(scopeKey, true);
    if (typeof logAudit_ === "function") {
      logAudit_(
        "GUEST_TOKEN_GATE",
        "INVALID_GUEST_TOKEN",
        String(scopeKey || "unknown"),
        "Rejected invalid guest access_token attempt.",
      );
    }
    throw new Error("Forbidden: Invalid guest access_token.");
  }

  return true;
}
