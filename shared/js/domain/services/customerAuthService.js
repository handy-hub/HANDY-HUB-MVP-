function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value || "");
}

function normalizePhone(value) {
  return (value || "").replace(/[^\d+]/g, "").trim();
}

function deriveCustomerName(user, nameInput) {
  const displayName = (user.displayName || "").trim();
  if (displayName) return displayName;

  const explicitName = (nameInput || "").trim();
  if (explicitName) return explicitName;

  const email = (user.email || "").trim();
  if (email.includes("@")) {
    return email.split("@")[0];
  }

  return "Customer";
}

function buildCustomerProfile(user, payload = {}, existing = null) {
  const nowIso = new Date().toISOString();
  const baseEmail = (payload.email || user.email || "").trim().toLowerCase();
  const safeEmail = isValidEmail(baseEmail)
    ? baseEmail
    : (existing && existing.email) || "";

  const safeName = deriveCustomerName(user, payload.fullName);
  const safePhone = (payload.phone || "").trim();
  const safeLocation = (payload.location || "").trim() || "Not specified";

  const previous = existing || {};

  return {
    bookings: typeof previous.bookings === "number" ? previous.bookings : 0,
    createdAt:
      typeof previous.createdAt === "string" && previous.createdAt
        ? previous.createdAt
        : nowIso,
    email: safeEmail,
    id: user.uid,
    joined:
      typeof previous.joined === "string" && previous.joined
        ? previous.joined
        : nowIso,
    location:
      typeof previous.location === "string" && previous.location
        ? previous.location
        : safeLocation,
    name:
      typeof previous.name === "string" && previous.name.trim()
        ? previous.name
        : safeName,
    phone:
      typeof previous.phone === "string"
        ? previous.phone
        : safePhone,
    spent: typeof previous.spent === "number" ? previous.spent : 0,
    status:
      typeof previous.status === "string" && ["active", "suspended"].includes(previous.status)
        ? previous.status
        : "active",
    userType: "customer"
  };
}

export function createCustomerAuthService({ authRepository, customerRepository, artisanRepository }) {
  if (!authRepository || !customerRepository) {
    throw new Error("CustomerAuthService requires authRepository and customerRepository.");
  }

  // ── Application-boundary guard (RBAC) ──────────────────────────────────────
  // Authentication proves identity, not permission to enter the Customer app.
  // A valid Firebase credential may belong to an ARTISAN. If so, we must NOT
  // provision a customer profile for that UID (which would mint a second,
  // conflicting identity) and must NOT let the session proceed. This mirrors the
  // server-side mutual-exclusivity rule in firestore.rules — see roleGuard.js.
  async function assertNotArtisan(uid) {
    if (!artisanRepository || !uid) return;

    let snap;
    try {
      snap = await artisanRepository.getById(uid);
    } catch (_) {
      // Degrade open on a read error — the Firestore rules still forbid an
      // artisan UID from owning a customers/{uid} document, so no cross-role
      // identity can actually be created even if this check can't run.
      return;
    }

    if (snap && snap.exists && snap.data && snap.data.userType === "artisan") {
      // Tear down the just-established session so no artisan is left signed in
      // on the customer surface.
      try { await authRepository.signOut(); } catch (_) { /* ignore */ }
      throw Object.assign(
        new Error("This is an artisan account. Please use the HandyHub Pro (artisan) app to sign in."),
        { code: "auth/wrong-app-role" }
      );
    }
  }

  async function resolveEmailIdentifier(identifier) {
    const cleaned = (identifier || "").trim();
    if (!cleaned) {
      throw Object.assign(new Error("Missing identifier."), { code: "auth/missing-identifier" });
    }

    if (isValidEmail(cleaned)) {
      return cleaned.toLowerCase();
    }

    const normalized = normalizePhone(cleaned);
    if (!normalized && !cleaned) {
      throw Object.assign(new Error("Invalid phone value."), { code: "auth/invalid-phone-value" });
    }

    const matchedCustomer = await customerRepository.findByPhone(cleaned);
    if (!matchedCustomer || !matchedCustomer.data) {
      throw Object.assign(
        new Error("No customer account found for that phone number."),
        { code: "auth/customer-not-found" }
      );
    }

    const email = (matchedCustomer.data.email || "").trim().toLowerCase();
    if (!isValidEmail(email)) {
      throw Object.assign(
        new Error("No valid email is linked to that phone number."),
        { code: "auth/customer-email-missing" }
      );
    }

    return email;
  }

  async function verifyCustomerWrite(userId) {
    const record = await customerRepository.getById(userId);
    if (!record.exists) {
      throw new Error("Customer profile verification failed after write.");
    }
  }

  async function ensureCustomerProfile(user, profileInput = {}) {
    // Application-boundary check BEFORE any customer document is written.
    await assertNotArtisan(user.uid);

    const current = await customerRepository.getById(user.uid);
    const currentData = current.exists ? current.data : null;
    const profile = buildCustomerProfile(user, profileInput, currentData);

    await customerRepository.upsert(user.uid, profile, { merge: true });
    return profile;
  }

  async function finalizeSocialResult(result, profileInput = {}, rollbackIfNewUser = false) {
    if (!result || !result.user) return null;

    const metadata = authRepository.extractSignInMetadata(result);

    try {
      const profile = await ensureCustomerProfile(result.user, profileInput);
      return { user: result.user, metadata, profile };
    } catch (error) {
      if (rollbackIfNewUser && metadata.isNewUser && authRepository.getCurrentUser()) {
        try {
          await authRepository.deleteCurrentUser();
        } catch (rollbackError) {
          console.error("Rollback delete failed after social profile write error:", rollbackError);
        }
      }
      throw error;
    }
  }

  return {
    async signInWithIdentifier({ identifier, password }) {
      const email = await resolveEmailIdentifier(identifier);
      const credential = await authRepository.signInWithEmail(email, password);
      const profile = await ensureCustomerProfile(credential.user, { email });

      return {
        user: credential.user,
        profile
      };
    },

    async signUpWithEmail({ fullName, email, phone, location, password }) {
      const cleanEmail = (email || "").trim().toLowerCase();
      if (!isValidEmail(cleanEmail)) {
        throw Object.assign(new Error("Invalid email."), { code: "auth/invalid-email" });
      }

      const credential = await authRepository.signUpWithEmail(cleanEmail, password);
      const user = credential.user;

      try {
        // Defense-in-depth: never provision a customer profile onto an artisan UID.
        await assertNotArtisan(user.uid);

        const profile = buildCustomerProfile(user, {
          fullName,
          email: cleanEmail,
          phone,
          location
        });

        await customerRepository.upsert(user.uid, profile);
        await verifyCustomerWrite(user.uid);

        return { user, profile };
      } catch (error) {
        if (authRepository.getCurrentUser()) {
          try {
            await authRepository.deleteCurrentUser();
          } catch (rollbackError) {
            console.error("Rollback delete failed after email signup profile write error:", rollbackError);
          }
        }
        throw error;
      }
    },

    async startSocialLogin(providerName, options = {}) {
      const result = await authRepository.signInWithSocial(providerName, options);
      if (!result) {
        return { redirected: true };
      }

      return finalizeSocialResult(result);
    },

    async completeSocialLoginRedirect() {
      const redirectResult = await authRepository.getRedirectResult();
      if (!redirectResult || !redirectResult.user) return null;

      return finalizeSocialResult(redirectResult);
    },

    async startSocialSignup(providerName, profileInput = {}, options = {}) {
      const result = await authRepository.signInWithSocial(providerName, options);
      if (!result) {
        return { redirected: true };
      }

      return finalizeSocialResult(result, profileInput, true);
    },

    async completeSocialSignupRedirect(profileInput = {}) {
      const redirectResult = await authRepository.getRedirectResult();
      if (!redirectResult || !redirectResult.user) return null;

      return finalizeSocialResult(redirectResult, profileInput, true);
    }
  };
}

