/**
 * Auth.gs
 * Google OAuth ID Token verification, caching, and role enforcement.
 * Follows the proven tokeninfo caching pattern from SuratKu.
 */

/**
 * Validates Google id_token using Google's tokeninfo endpoint with CacheService.
 *
 * @param {string} idToken - Raw JWT credential string from Google Sign-In.
 * @returns {Object} Verified user profile {sub, email, name, picture} or throws error.
 */
function verifyIdToken(idToken) {
  if (!idToken) {
    throw new Error("Authentication required: Missing ID token.");
  }

  // Handle mock dev tokens for offline local testing
  if (idToken.startsWith("mock_token_")) {
    const parts = idToken.split("_");
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

  // Check cache to avoid hitting Google servers on every API call
  const cache = CacheService.getUserCache();
  const cacheKey =
    "auth_" +
    Utilities.base64Encode(
      Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, idToken),
    ).substring(0, 32);
  const cachedUser = cache.get(cacheKey);
  if (cachedUser) {
    return JSON.parse(cachedUser);
  }

  // Call Google tokeninfo endpoint
  const url =
    "https://oauth2.googleapis.com/tokeninfo?id_token=" +
    encodeURIComponent(idToken);
  const response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });

  if (response.getResponseCode() !== 200) {
    throw new Error("Invalid or expired Google token.");
  }

  const payload = JSON.parse(response.getContentText());

  // Optional: check client id match if configured in config sheet
  const expectedClientId = getConfig_("GOOGLE_CLIENT_ID");
  if (expectedClientId && payload.aud !== expectedClientId) {
    throw new Error(
      "Token audience mismatch: Token was not issued for this application.",
    );
  }

  const user = {
    sub: payload.sub,
    email: (payload.email || "").toLowerCase().trim(),
    name: payload.name || payload.email,
    picture: payload.picture || "",
  };

  // Cache user profile for 10 minutes (600 seconds)
  cache.put(cacheKey, JSON.stringify(user), 600);
  return user;
}

/**
 * Requires valid authenticated user and returns their database record from 'users' sheet.
 *
 * @param {Object} e - Event parameter.
 * @returns {Object} Database user record.
 */
function requireUser_(e) {
  const token = getBearerOrParamToken_(e);
  const profile = verifyIdToken(token);
  const user = findUserByEmail_(profile.email);
  if (!user) {
    throw new Error("User not registered. Please complete registration first.");
  }
  return user;
}

/**
 * Requires authenticated user with ADMIN role.
 *
 * @param {Object} e - Event parameter.
 * @returns {Object} Database admin user record.
 */
function requireAdmin_(e) {
  const user = requireUser_(e);
  if (user.role !== "ADMIN" && !isAdminEmail_(user.email)) {
    throw new Error("Forbidden: Access restricted to system administrators.");
  }
  return user;
}

/**
 * Checks if an email is listed in ADMIN_EMAILS config.
 *
 * @param {string} email - Target email.
 * @returns {boolean} True if listed as admin.
 */
function isAdminEmail_(email) {
  if (!email) return false;
  const adminEmailsRaw = getConfig_("ADMIN_EMAILS") || "maulanaa1408@upi.edu";
  const adminList = adminEmailsRaw
    .split(",")
    .map((s) => s.trim().toLowerCase());
  return adminList.indexOf(email.toLowerCase()) !== -1;
}

/**
 * Helper to extract token from query parameters or Authorization header.
 */
function getBearerOrParamToken_(e) {
  const params = e && e.parameter ? e.parameter : {};
  if (params.id_token) return params.id_token;
  if (params.token) return params.token;
  return "";
}
