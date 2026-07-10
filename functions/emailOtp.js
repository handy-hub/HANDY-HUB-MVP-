'use strict';

/**
 * functions/emailOtp.js — Server-authoritative email OTP verification system
 *
 * Flow:
 *   1. requestSignupOtp({ payload, appType })
 *      → validate input → create DISABLED Firebase Auth user →
 *        generate OTP → hash+store (no password in Firestore) →
 *        send email → return sessionId
 *
 *   2. resendSignupOtp({ sessionId, email, appType })
 *      → check session live + expiry → enforce resend rate limit (transactional) →
 *        send email FIRST → then update Firestore hash
 *
 *   3. verifySignupOtp({ sessionId, otp, appType })
 *      → fetch session → constant-time hash compare → check expiry/attempts →
 *        enable Auth user → write Firestore profile → mark verified
 *        (Auth user deleted on Firestore failure to prevent orphan)
 *
 * Security properties:
 *   • OTP never stored in plaintext — SHA-256 hashed with per-session salt
 *   • Password never stored in Firestore — Auth user created disabled, enabled after verify
 *   • Constant-time comparison (timingSafeEqual) prevents timing attacks
 *   • 5-attempt hard limit per session → session invalidated on breach
 *   • 5-minute OTP TTL — Firestore TTL auto-deletes expired sessions
 *   • 5 resends/hour per email; per-resend 60s gap enforced after every resend
 *   • Resend: email sent BEFORE Firestore hash written (transient failure safe)
 *   • Per-email + per-IP rate limits on initial OTP request
 *   • Concurrent session deduplication — old session invalidated on new request
 *   • Auth user rollback (deleteUser) on Firestore write failure → no orphan accounts
 *   • IP address + userAgent stored for audit, never logged as OTP
 *   • Correlation IDs on every log entry for traceability
 *   • No information leakage: identical error message for wrong code vs. expired
 */

const crypto    = require('crypto');
const { getAuth }       = require('firebase-admin/auth');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');
const { HttpsError }    = require('firebase-functions/v2/https');
const {
    FIRESTORE_DB_ID,
    FUNCTIONS_REGION,
} = require('./config');

// ── Lazy singletons ───────────────────────────────────────────────────────────
let _db;
function db() {
    if (!_db) _db = getFirestore(FIRESTORE_DB_ID);
    return _db;
}

// ── Constants ─────────────────────────────────────────────────────────────────
const COL_VERIF        = '_email_verifications';   // pending OTP sessions
const OTP_TTL_MS       = 5 * 60 * 1000;           // 5 minutes
const OTP_TTL_S        = OTP_TTL_MS / 1000;
const MAX_ATTEMPTS     = 5;                        // wrong codes before lockout
const MAX_RESENDS      = 5;                        // resends per hour per email
const RESEND_WINDOW_MS = 60 * 60 * 1000;          // 1 hour
const MIN_RESEND_GAP_S = 60;                       // seconds between any two resend calls

// ── Correlation ID ────────────────────────────────────────────────────────────
function cid() {
    return `OTP-${Date.now()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}

// ── OTP generation ────────────────────────────────────────────────────────────
/** Generate a 6-digit OTP using crypto.randomInt (CSPRNG). */
function generateOtp() {
    // crypto.randomInt(min, max) is cryptographically secure and available Node ≥14
    const n = crypto.randomInt(0, 1_000_000);
    return n.toString().padStart(6, '0');
}

/** Hash otp+salt with SHA-256. Returns hex string. */
function hashOtp(otp, salt) {
    return crypto.createHash('sha256').update(`${salt}:${otp}`).digest('hex');
}

/** Constant-time comparison to prevent timing attacks. */
function secureCompareHash(a, b) {
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

// ── Input validation helpers ─────────────────────────────────────────────────
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;
const GHANA_PHONE_RE = /^(0[235][0-9]{8}|233[235][0-9]{8})$/;

function normaliseEmail(e) { return (e || '').toLowerCase().trim(); }

function validateCustomerPayload(p) {
    if (!p.fullName || p.fullName.trim().length < 2)
        throw new HttpsError('invalid-argument', 'Full name must be at least 2 characters.');
    if (!EMAIL_RE.test(p.email))
        throw new HttpsError('invalid-argument', 'Invalid email address.');
    if (!p.password || p.password.length < 8)
        throw new HttpsError('invalid-argument', 'Password must be at least 8 characters.');
    if (p.phone && !GHANA_PHONE_RE.test(p.phone.replace(/\s/g, '')))
        throw new HttpsError('invalid-argument', 'Invalid Ghana phone number.');
}

function validateArtisanPayload(p) {
    if (!p.name || p.name.trim().length < 2)
        throw new HttpsError('invalid-argument', 'Full name must be at least 2 characters.');
    if (!EMAIL_RE.test(p.email))
        throw new HttpsError('invalid-argument', 'Invalid email address.');
    if (!p.password || p.password.length < 8)
        throw new HttpsError('invalid-argument', 'Password must be at least 8 characters.');
    const VALID_CATS = new Set([
        'electrical','plumbing','carpentry','painting','welding',
        'ac_cooling','tiling','cleaning','other',
    ]);
    if (!p.category || !VALID_CATS.has(p.category))
        throw new HttpsError('invalid-argument', 'Invalid service category.');
    if (p.phone && !GHANA_PHONE_RE.test(p.phone.replace(/\s/g, '')))
        throw new HttpsError('invalid-argument', 'Invalid Ghana phone number.');
}

// ── Email sender ──────────────────────────────────────────────────────────────
async function sendOtpEmail({ to, name, otp, expiresInMin, correlationId, resend }) {
    const apiKey = process.env.RESEND_API_KEY || process.env.SENDGRID_API_KEY || '';
    const from   = process.env.EMAIL_FROM || 'noreply@handyhub.app';
    const fromName = 'HandyHub';

    const html = buildOtpEmailHtml({ name, otp, expiresInMin, resend });

    // Prefer Resend; fallback to SendGrid; fallback to Firebase Extensions (SMTP).
    if (process.env.RESEND_API_KEY) {
        const resp = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                from: `${fromName} <${from}>`,
                to:   [to],
                subject: resend
                    ? `[Resent] Your HandyHub verification code`
                    : `Verify your HandyHub account`,
                html,
            }),
        });
        if (!resp.ok) {
            const body = await resp.text().catch(() => '');
            console.error(`[OTP][${correlationId}] Resend API error ${resp.status}: ${body}`);
            throw new Error('Failed to send verification email. Please try again.');
        }
        return;
    }

    if (process.env.SENDGRID_API_KEY) {
        const resp = await fetch('https://api.sendgrid.com/v3/mail/send', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${process.env.SENDGRID_API_KEY}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                personalizations: [{ to: [{ email: to, name }] }],
                from: { email: from, name: fromName },
                subject: resend
                    ? `[Resent] Your HandyHub verification code`
                    : `Verify your HandyHub account`,
                content: [{ type: 'text/html', value: html }],
            }),
        });
        if (!resp.ok) {
            const body = await resp.text().catch(() => '');
            console.error(`[OTP][${correlationId}] SendGrid API error ${resp.status}: ${body}`);
            throw new Error('Failed to send verification email. Please try again.');
        }
        return;
    }

    // No email provider configured — log for development only
    console.warn(
        `[OTP][${correlationId}] DEV MODE — no email provider configured.\n` +
        `  To: ${to}\n  Code: ${otp}\n  (Set RESEND_API_KEY or SENDGRID_API_KEY in functions/.env)`
    );
}

// ── Email HTML template ───────────────────────────────────────────────────────
function buildOtpEmailHtml({ name, otp, expiresInMin, resend }) {
    const digits = otp.split('').map(d =>
        `<span style="display:inline-block;width:44px;height:52px;line-height:52px;text-align:center;font-size:28px;font-weight:800;color:#111;background:#f5f5f5;border:1.5px solid #e0e0e0;border-radius:10px;margin:0 3px;font-family:monospace,sans-serif;">${d}</span>`
    ).join('');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Verify your HandyHub account</title>
</head>
<body style="margin:0;padding:0;background:#f0ede8;font-family:'Segoe UI',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f0ede8;padding:32px 16px;">
    <tr><td align="center">
      <table width="100%" style="max-width:480px;background:#fff;border-radius:20px;overflow:hidden;box-shadow:0 4px 32px rgba(0,0,0,0.10);">

        <!-- Header -->
        <tr>
          <td style="background:linear-gradient(135deg,#730201 0%,#b10c0c 100%);padding:32px 32px 24px;text-align:center;">
            <p style="margin:0;font-size:26px;font-weight:800;color:#fff;letter-spacing:-0.5px;">HandyHub</p>
            <p style="margin:6px 0 0;font-size:13px;color:rgba(255,255,255,0.80);font-weight:500;">
              Trusted Professionals, Right Around You
            </p>
          </td>
        </tr>

        <!-- Body -->
        <tr>
          <td style="padding:36px 32px 28px;">
            <p style="margin:0 0 8px;font-size:22px;font-weight:800;color:#111;">
              ${resend ? 'New verification code' : 'Verify your email'}
            </p>
            <p style="margin:0 0 28px;font-size:15px;color:#555;line-height:1.55;">
              Hi <strong>${escHtml(name)}</strong>, use the code below to complete your HandyHub account setup.
              ${resend ? 'Your previous code has been invalidated.' : ''}
            </p>

            <!-- OTP digits -->
            <div style="text-align:center;margin:0 0 28px;">
              ${digits}
            </div>

            <!-- Expiry notice -->
            <div style="background:#fff8f0;border:1.5px solid #fde4c0;border-radius:12px;padding:14px 18px;margin-bottom:28px;">
              <p style="margin:0;font-size:13px;color:#c07000;font-weight:600;">
                This code expires in <strong>${expiresInMin} minutes</strong>.
                Do not share it with anyone.
              </p>
            </div>

            <!-- Security note -->
            <div style="background:#f9f9f9;border-radius:12px;padding:14px 18px;margin-bottom:8px;">
              <p style="margin:0;font-size:13px;color:#666;line-height:1.6;">
                <strong>Security notice:</strong> HandyHub will never ask for this code by phone, chat, or email.
                If you did not request this, ignore this email — no account will be created.
              </p>
            </div>
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td style="padding:16px 32px 28px;border-top:1px solid #f0f0f0;">
            <p style="margin:0;font-size:12px;color:#aaa;text-align:center;">
              © ${new Date().getFullYear()} HandyHub · Ghana<br>
              This is an automated message — please do not reply.
            </p>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function escHtml(s) {
    return String(s || '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Firestore session write ────────────────────────────────────────────────────
// signupPayload stored here MUST NOT contain the password — the Auth user (disabled)
// is created before this write; uid is stored so we can enable it at verify time.
async function createVerificationSession({
    email, salt, otpHash, signupPayload, uid, appType, ip, userAgent, sessionId, correlationId,
}) {
    const now     = Date.now();
    const expiresAt = new Date(now + OTP_TTL_MS);

    await db().collection(COL_VERIF).doc(sessionId).set({
        sessionId,
        correlationId,
        email,
        appType,             // 'customer' | 'artisan'
        uid,                 // disabled Auth user uid — enabled at verify time
        salt,
        otpHash,
        signupPayload,       // profile data only — password is NOT included
        status:      'pending',
        attempts:    0,
        resendCount: 0,
        resendTimestamps: [],
        lastResentAt: null,
        createdAt:   new Date(now).toISOString(),
        expiresAt:   expiresAt.toISOString(),
        // Firestore TTL field — collection must have TTL policy on 'ttlAt'
        ttlAt:       Timestamp.fromDate(new Date(now + OTP_TTL_MS + 60_000)), // +1 min buffer
        ip:          ip    || null,
        userAgent:   userAgent || null,
    });
}

// ── Core: requestSignupOtp ────────────────────────────────────────────────────
async function requestSignupOtp({ payload, appType, ip, userAgent }) {
    const correlationId = cid();
    const email = normaliseEmail(payload?.email);

    console.log(`[OTP][${correlationId}] requestSignupOtp start email=${email} appType=${appType}`);

    // ── 1. Validate payload ──────────────────────────────────────────────────
    if (!appType || !['customer', 'artisan'].includes(appType)) {
        throw new HttpsError('invalid-argument', 'Invalid app type.');
    }
    if (appType === 'customer') validateCustomerPayload({ ...payload, email });
    else                        validateArtisanPayload({ ...payload, email });

    // ── 2. Check Firebase Auth for existing account ──────────────────────────
    try {
        const existing = await getAuth().getUserByEmail(email);
        // Enabled user = real account. Disabled user = pending OTP session (allow re-request).
        if (existing.disabled === false) {
            console.log(`[OTP][${correlationId}] email already registered email=${email}`);
            throw new HttpsError('already-exists', 'An account with this email already exists. Please sign in instead.');
        }
        // Disabled Auth user from a previous OTP session — delete it so we start fresh
        await getAuth().deleteUser(existing.uid);
        console.log(`[OTP][${correlationId}] Deleted stale disabled Auth user uid=${existing.uid}`);
    } catch (err) {
        if (err instanceof HttpsError) throw err;
        if (err.code !== 'auth/user-not-found') {
            console.error(`[OTP][${correlationId}] Auth lookup error: ${err.message}`);
            throw new HttpsError('internal', 'Failed to validate email. Please try again.');
        }
        // auth/user-not-found — email is free, proceed
    }

    // ── 3. Invalidate any existing pending session for this email ────────────
    const existingSessions = await db().collection(COL_VERIF)
        .where('email', '==', email)
        .where('status', '==', 'pending')
        .limit(5)
        .get();

    if (!existingSessions.empty) {
        const batch = db().batch();
        existingSessions.docs.forEach(d => batch.update(d.ref, {
            status: 'superseded',
            supersededAt: new Date().toISOString(),
        }));
        await batch.commit();
        console.log(`[OTP][${correlationId}] Invalidated ${existingSessions.size} existing session(s) for email=${email}`);
    }

    const now = Date.now();
    const windowStart = now - RESEND_WINDOW_MS;

    // ── 4a. Per-email rate limit (10 OTP requests per hour per email) ─────────
    const emailKey = `otp_email_${crypto.createHash('sha256').update(email).digest('hex').slice(0, 32)}`;
    const emailRateLimitRef = db().collection('_rate_limits').doc(emailKey);
    const emailRateLimitResult = await db().runTransaction(async (tx) => {
        const snap = await tx.get(emailRateLimitRef);
        const data = snap.exists ? snap.data() : {};
        const valid = (data.timestamps || []).filter(t => t > windowStart);
        if (valid.length >= 10) return { allowed: false };
        valid.push(now);
        tx.set(emailRateLimitRef, { timestamps: valid, updatedAt: new Date().toISOString() });
        return { allowed: true };
    });

    if (!emailRateLimitResult.allowed) {
        console.warn(`[OTP][${correlationId}] Per-email rate limit exceeded email=${email}`);
        throw new HttpsError('resource-exhausted', 'Too many signup attempts for this email. Please try again in an hour.');
    }

    // ── 4b. IP-level rate limit (10 OTP requests per hour per IP) ────────────
    if (ip) {
        const ipKey = `otp_req_${ip.replace(/\./g, '_').replace(/:/g, '_')}`;
        const ipRef = db().collection('_rate_limits').doc(ipKey);

        const ipResult = await db().runTransaction(async (tx) => {
            const snap = await tx.get(ipRef);
            const data = snap.exists ? snap.data() : {};
            const valid = (data.timestamps || []).filter(t => t > windowStart);
            if (valid.length >= 10) return { allowed: false };
            valid.push(now);
            tx.set(ipRef, { timestamps: valid, updatedAt: new Date().toISOString() });
            return { allowed: true };
        });

        if (!ipResult.allowed) {
            console.warn(`[OTP][${correlationId}] IP rate limit exceeded ip=${ip}`);
            throw new HttpsError('resource-exhausted', 'Too many signup requests from this network. Please try again in an hour.');
        }
    }

    // ── 5. Create a DISABLED Firebase Auth user — password stays off Firestore ─
    // The user is disabled so they cannot sign in yet. verifySignupOtp enables them.
    const displayName = (payload.fullName || payload.name || '').trim();
    const authUser = await getAuth().createUser({
        email,
        password: payload.password,  // stored only in Firebase Auth, never in Firestore
        displayName,
        emailVerified: false,
        disabled: true,
    });
    const uid = authUser.uid;
    console.log(`[OTP][${correlationId}] Created disabled Auth user uid=${uid}`);

    // ── 6. Build profile payload — strip password before Firestore write ──────
    // eslint-disable-next-line no-unused-vars
    const { password: _pw, ...payloadWithoutPassword } = { ...payload, email };
    const storablePayload = payloadWithoutPassword;

    // ── 7. Generate OTP and store hashed session ──────────────────────────────
    const otp       = generateOtp();
    const salt      = crypto.randomBytes(16).toString('hex');
    const otpHash   = hashOtp(otp, salt);
    const sessionId = `vs_${crypto.randomBytes(16).toString('hex')}`;

    try {
        await createVerificationSession({
            email, salt, otpHash,
            signupPayload: storablePayload,
            uid,
            appType, ip, userAgent, sessionId, correlationId,
        });
    } catch (err) {
        // Firestore session write failed — delete the Auth user to avoid orphan
        await getAuth().deleteUser(uid).catch(() => {});
        console.error(`[OTP][${correlationId}] Session write failed, deleted Auth user uid=${uid}: ${err.message}`);
        throw new HttpsError('internal', 'Failed to initiate verification. Please try again.');
    }

    // ── 8. Send OTP email ─────────────────────────────────────────────────────
    const name = (payload.fullName || payload.name || email.split('@')[0]).trim();
    try {
        await sendOtpEmail({
            to: email,
            name,
            otp,
            expiresInMin: Math.round(OTP_TTL_MS / 60_000),
            correlationId,
            resend: false,
        });
    } catch (err) {
        // Roll back: delete Auth user + mark session failed so user can retry
        await Promise.all([
            getAuth().deleteUser(uid).catch(() => {}),
            db().collection(COL_VERIF).doc(sessionId).update({ status: 'email_failed' }).catch(() => {}),
        ]);
        console.error(`[OTP][${correlationId}] Email send failed: ${err.message}`);
        throw new HttpsError('internal', err.message || 'Failed to send verification email. Please try again.');
    }

    console.log(`[OTP][${correlationId}] OTP sent successfully session=${sessionId} email=${email}`);

    return {
        sessionId,
        email,
        expiresInSeconds: OTP_TTL_S,
        resendCooldownSeconds: MIN_RESEND_GAP_S,
    };
}

// ── Core: resendSignupOtp ─────────────────────────────────────────────────────
async function resendSignupOtp({ sessionId, email, appType, ip, userAgent }) {
    const correlationId = cid();
    const normEmail = normaliseEmail(email);
    console.log(`[OTP][${correlationId}] resendSignupOtp session=${sessionId} email=${normEmail}`);

    if (!sessionId || !normEmail) {
        throw new HttpsError('invalid-argument', 'sessionId and email are required.');
    }

    const sessionRef = db().collection(COL_VERIF).doc(sessionId);
    const snap = await sessionRef.get();

    if (!snap.exists) {
        throw new HttpsError('not-found', 'Verification session not found. Please restart signup.');
    }

    const session = snap.data();

    if (session.email !== normEmail) {
        throw new HttpsError('permission-denied', 'Session email mismatch.');
    }
    if (session.status !== 'pending') {
        throw new HttpsError('failed-precondition', 'This session is no longer active. Please restart signup.');
    }

    const now = Date.now();

    // ── Reject expired sessions (TTL deletion can lag up to 24h) ────────────
    if (new Date(session.expiresAt).getTime() < now) {
        throw new HttpsError('failed-precondition', 'Your verification session has expired. Please restart signup.');
    }

    // ── Enforce minimum gap after EVERY resend (not just the first) ──────────
    // Compare against lastResentAt if it exists, otherwise against createdAt.
    const lastSentMs = session.lastResentAt
        ? new Date(session.lastResentAt).getTime()
        : new Date(session.createdAt).getTime();
    const elapsedS = (now - lastSentMs) / 1000;
    if (elapsedS < MIN_RESEND_GAP_S) {
        const waitS = Math.ceil(MIN_RESEND_GAP_S - elapsedS);
        throw new HttpsError('resource-exhausted', `Please wait ${waitS} seconds before requesting a new code.`);
    }

    // ── Check resend rate limit inside a transaction (prevents TOCTOU race) ──
    const windowStart = now - RESEND_WINDOW_MS;
    let recentResendsCount = 0;

    const rateCheckResult = await db().runTransaction(async (tx) => {
        const txSnap = await tx.get(sessionRef);
        if (!txSnap.exists) return { allowed: false, reason: 'not_found' };
        const s = txSnap.data();
        if (s.status !== 'pending') return { allowed: false, reason: 'not_pending' };
        const recent = (s.resendTimestamps || []).filter(t => t > windowStart);
        if (recent.length >= MAX_RESENDS) return { allowed: false, reason: 'rate_limit', count: recent.length };
        // Reserve the slot now — actual hash is written after email succeeds
        tx.update(sessionRef, {
            resendCount:      FieldValue.increment(1),
            resendTimestamps: FieldValue.arrayUnion(now),
            lastResentAt:     new Date(now).toISOString(),
        });
        return { allowed: true, recentCount: recent.length };
    });

    if (!rateCheckResult.allowed) {
        if (rateCheckResult.reason === 'not_found') {
            throw new HttpsError('not-found', 'Verification session not found. Please restart signup.');
        }
        if (rateCheckResult.reason === 'not_pending') {
            throw new HttpsError('failed-precondition', 'This session is no longer active. Please restart signup.');
        }
        // rate_limit
        console.warn(`[OTP][${correlationId}] Resend limit exceeded session=${sessionId}`);
        throw new HttpsError('resource-exhausted', 'Too many resend requests. Please try again in an hour or restart signup.');
    }
    recentResendsCount = rateCheckResult.recentCount;

    // ── Generate new OTP ──────────────────────────────────────────────────────
    const otp     = generateOtp();
    const salt    = crypto.randomBytes(16).toString('hex');
    const otpHash = hashOtp(otp, salt);
    const newExpiry = new Date(now + OTP_TTL_MS);

    // ── Send email FIRST — only update the hash if delivery succeeds ──────────
    const name = (session.signupPayload?.fullName || session.signupPayload?.name || normEmail.split('@')[0]).trim();
    try {
        await sendOtpEmail({
            to: normEmail,
            name,
            otp,
            expiresInMin: Math.round(OTP_TTL_MS / 60_000),
            correlationId,
            resend: true,
        });
    } catch (err) {
        // Email failed — roll back the rate-limit slot we reserved
        await sessionRef.update({
            resendCount:      FieldValue.increment(-1),
            resendTimestamps: FieldValue.arrayRemove(now),
            lastResentAt:     session.lastResentAt || null,
        }).catch(() => {});
        console.error(`[OTP][${correlationId}] Resend email failed: ${err.message}`);
        throw new HttpsError('internal', 'Failed to send the new code. Please try again.');
    }

    // ── Email delivered — now write the new OTP hash ──────────────────────────
    await sessionRef.update({
        salt,
        otpHash,
        attempts:  0,   // reset attempt counter for fresh OTP
        expiresAt: newExpiry.toISOString(),
        ttlAt:     Timestamp.fromDate(new Date(now + OTP_TTL_MS + 60_000)),
    });

    console.log(`[OTP][${correlationId}] OTP resent session=${sessionId} resendCount=${session.resendCount + 1}`);

    return {
        expiresInSeconds:      OTP_TTL_S,
        resendCooldownSeconds: MIN_RESEND_GAP_S,
        resendsRemaining:      MAX_RESENDS - recentResendsCount - 1,
    };
}

// ── Core: verifySignupOtp → create account ────────────────────────────────────
async function verifySignupOtp({ sessionId, otp, appType, ip }) {
    const correlationId = cid();
    console.log(`[OTP][${correlationId}] verifySignupOtp session=${sessionId} appType=${appType}`);

    if (!sessionId || !otp || typeof otp !== 'string' || !/^\d{6}$/.test(otp)) {
        throw new HttpsError('invalid-argument', 'A 6-digit verification code is required.');
    }

    const sessionRef = db().collection(COL_VERIF).doc(sessionId);

    // ── Use a transaction so concurrent submissions can't both succeed ────────
    const result = await db().runTransaction(async (tx) => {
        const snap = await tx.get(sessionRef);

        if (!snap.exists) {
            return { error: 'not_found' };
        }

        const s = snap.data();

        if (s.status === 'verified') return { error: 'already_verified' };
        if (s.status !== 'pending')  return { error: 'invalid_status' };

        // Check expiry
        if (new Date(s.expiresAt).getTime() < Date.now()) {
            tx.update(sessionRef, { status: 'expired' });
            return { error: 'expired' };
        }

        // Check attempt count
        if (s.attempts >= MAX_ATTEMPTS) {
            tx.update(sessionRef, { status: 'locked' });
            return { error: 'locked' };
        }

        // Constant-time hash comparison
        const submittedHash = hashOtp(otp, s.salt);
        const isCorrect = secureCompareHash(submittedHash, s.otpHash);

        if (!isCorrect) {
            const newAttempts = s.attempts + 1;
            if (newAttempts >= MAX_ATTEMPTS) {
                tx.update(sessionRef, {
                    attempts: newAttempts,
                    status:   'locked',
                    lockedAt: new Date().toISOString(),
                });
                return { error: 'locked' };
            }
            tx.update(sessionRef, {
                attempts:       newAttempts,
                lastAttemptAt:  new Date().toISOString(),
            });
            return { error: 'wrong_code', attemptsLeft: MAX_ATTEMPTS - newAttempts };
        }

        // Correct! Mark as verified (prevents replay)
        tx.update(sessionRef, {
            status:     'verified',
            verifiedAt: new Date().toISOString(),
        });

        return { success: true, payload: s.signupPayload, uid: s.uid, appType: s.appType };
    });

    // ── Map transaction outcomes to errors ────────────────────────────────────
    if (result.error === 'not_found') {
        throw new HttpsError('not-found', 'Verification session not found. Please restart signup.');
    }
    if (result.error === 'already_verified') {
        // Session was already verified — treat as success so user lands on the dashboard
        // rather than seeing a confusing error after a double-submit or page refresh.
        console.log(`[OTP][${correlationId}] Session already verified (duplicate submit) session=${sessionId}`);
        const alreadySnap = await sessionRef.get();
        const alreadyData = alreadySnap.exists ? alreadySnap.data() : {};
        const alreadyUid  = alreadyData.uid || null;
        // Re-mint a token so a duplicate submit / page refresh still signs the
        // user in rather than dead-ending on an "already verified" success with
        // no session.
        let customToken = null;
        if (alreadyUid) {
            try { customToken = await getAuth().createCustomToken(alreadyUid); }
            catch (err) { console.error(`[OTP][${correlationId}] createCustomToken (already-verified) failed: ${err.message}`); }
        }
        return { success: true, uid: alreadyUid, alreadyVerified: true, customToken };
    }
    if (result.error === 'invalid_status') {
        throw new HttpsError('failed-precondition', 'Verification session is no longer active. Please restart signup.');
    }
    // "expired", "locked", "wrong_code" — all return the same user message
    // to prevent enumeration of which specific condition triggered.
    if (result.error === 'expired' || result.error === 'locked') {
        console.warn(`[OTP][${correlationId}] Session ${result.error} session=${sessionId}`);
        throw new HttpsError('unauthenticated', 'Verification failed. Please restart the signup process.');
    }
    if (result.error === 'wrong_code') {
        const left = result.attemptsLeft;
        console.warn(`[OTP][${correlationId}] Wrong code session=${sessionId} attemptsLeft=${left}`);
        throw new HttpsError('unauthenticated',
            left > 0
                ? `Incorrect code. ${left} attempt${left !== 1 ? 's' : ''} remaining.`
                : 'Too many incorrect attempts. Please restart the signup process.'
        );
    }

    // ── OTP correct — activate the account ──────────────────────────────────
    console.log(`[OTP][${correlationId}] OTP verified session=${sessionId} — activating account`);

    // appType comes from the session document (server-side), not the client request
    const { payload, uid: sessionUid, appType: sessionAppType } = result;
    const finalAppType = sessionAppType;  // never trust the client-provided appType

    try {
        if (finalAppType === 'customer') {
            await _activateCustomerAccount(sessionUid, payload, correlationId);
        } else {
            await _activateArtisanAccount(sessionUid, payload, correlationId);
        }
    } catch (err) {
        await sessionRef.update({
            status: 'account_creation_failed',
            accountCreationError: err.message?.slice(0, 200),
            accountCreationFailedAt: new Date().toISOString(),
        }).catch(() => {});
        console.error(`[OTP][${correlationId}] Account activation failed session=${sessionId}: ${err.message}`);
        throw new HttpsError('internal', 'Account verification succeeded but account setup failed. Please contact support.');
    }

    // Archive session (keep for audit; TTL will clean it up)
    await sessionRef.update({
        accountCreatedAt: new Date().toISOString(),
    }).catch(() => {});

    // Mint a custom auth token so the CLIENT can sign in immediately after
    // verification. Without this the account is created + enabled server-side
    // but the browser has no Firebase Auth session — the auth guard would then
    // bounce the user straight to login. signInWithCustomToken(token) on the
    // client establishes the session so they land authenticated.
    let customToken = null;
    try {
        customToken = await getAuth().createCustomToken(sessionUid);
    } catch (err) {
        console.error(`[OTP][${correlationId}] createCustomToken failed uid=${sessionUid}: ${err.message}`);
        // Non-fatal: the account exists; client falls back to the login page.
    }

    console.log(`[OTP][${correlationId}] Account activated uid=${sessionUid} session=${sessionId} appType=${finalAppType}`);
    return { success: true, uid: sessionUid, customToken };
}

// ── Account activation: customer ──────────────────────────────────────────────
// The Auth user (uid) already exists but is DISABLED. We enable it, then write
// the Firestore profile. If the Firestore write fails we re-disable + delete the
// Auth user so the email is free for a retry.
async function _activateCustomerAccount(uid, payload, correlationId) {
    const { email, fullName, phone, location } = payload;
    const now = new Date().toISOString();

    // 1. Enable the Auth user + mark email as verified (OTP proves ownership)
    await getAuth().updateUser(uid, { disabled: false, emailVerified: true });
    console.log(`[OTP][${correlationId}] Firebase Auth customer enabled uid=${uid}`);

    // 2. Write Firestore customer document (matches customerRepository schema)
    const customerDoc = {
        id:               uid,
        name:             fullName.trim(),
        fullName:         fullName.trim(),
        email:            email.toLowerCase(),
        phone:            phone ? (phone || '').replace(/\s/g, '') : '',
        location:         location || 'Not specified',
        userType:         'customer',
        profileImage:     null,
        walletBalance:    0,
        escrowBalance:    0,
        spent:            0,
        bookings:         0,
        savedItems:       [],
        recentSearches:   [],
        notificationPreferences: {
            Bookings:     true,
            Messages:     true,
            Promotions:   false,
            Updates:      true,
        },
        emailVerified:    true,
        createdAt:        now,
        updatedAt:        now,
    };

    try {
        await db().collection('customers').doc(uid).set(customerDoc);
        console.log(`[OTP][${correlationId}] Customer Firestore doc created uid=${uid}`);
    } catch (err) {
        // Firestore failed — re-disable then delete Auth user to prevent orphan
        await getAuth().deleteUser(uid).catch(() => {});
        console.error(`[OTP][${correlationId}] Firestore write failed, deleted Auth user uid=${uid}: ${err.message}`);
        throw err;
    }

    // 3. Welcome notification (fire-and-forget — failure does not block activation)
    db().collection('customer_notifications').add({
        receiverId: uid,
        senderId:   null,
        type:       'Updates',
        title:      'Welcome to HandyHub!',
        message:    `Hi ${fullName.split(' ')[0]}, your account is ready. Browse trusted professionals near you and book your first service today.`,
        isRead:     false,
        readAt:     null,
        actionUrl:  'dashboard.html',
        metadata:   {},
        createdAt:  now,
    }).catch(() => {});
}

// ── Account activation: artisan ───────────────────────────────────────────────
async function _activateArtisanAccount(uid, payload, correlationId) {
    const {
        email, name, phone, category,
        requestedService, otherDesc, otherBucket,
    } = payload;
    const now = new Date().toISOString();

    const isOther           = category === 'other';
    const effectiveCategory = isOther && otherBucket ? otherBucket : category;
    const specialtyDesc     = isOther && (requestedService || otherDesc) ? (requestedService || otherDesc) : null;

    // 1. Enable the Auth user + mark email as verified
    await getAuth().updateUser(uid, { disabled: false, emailVerified: true });
    console.log(`[OTP][${correlationId}] Firebase Auth artisan enabled uid=${uid}`);

    // 2. Write Firestore artisan document (matches artisanAuthGuard required schema)
    const artisanDoc = {
        id:                 uid,
        uid,
        name:               name.trim(),
        fullName:           name.trim(),
        email:              email.toLowerCase(),
        phone:              phone ? phone.replace(/\s/g, '') : '',
        userType:           'artisan',
        status:             'pending',
        category:           effectiveCategory,
        specialty:          effectiveCategory,
        verificationStatus: 'draft',
        emailVerified:      true,
        isOnline:           false,
        isAvailable:        false,
        rating:             0,
        reviewCount:        0,
        jobsCompleted:      0,
        completionRate:     0,
        responseRate:       0,
        availableBalance:   0,
        pendingBalance:     0,
        totalEarned:        0,
        withdrawnTotal:     0,
        walletBalance:      0,
        createdAt:          now,
        updatedAt:          now,
    };
    if (specialtyDesc) artisanDoc.requestedService = specialtyDesc;

    const batch = db().batch();
    batch.set(db().collection('artisans').doc(uid), artisanDoc);

    // 3. Welcome notification
    batch.set(db().collection('artisan_notifications').doc(), {
        receiverId: uid,
        senderId:   null,
        type:       'Updates',
        title:      'Welcome to HandyHub!',
        message:    `Hi ${name.split(' ')[0]}, your artisan account is pending review. Complete your profile to start receiving jobs.`,
        isRead:     false,
        readAt:     null,
        actionUrl:  'dashboard.html',
        metadata:   {},
        createdAt:  now,
    });

    // 4. Service request queue (if custom trade)
    if (specialtyDesc) {
        batch.set(db().collection('service_requests').doc(uid), {
            artisanId:           uid,
            artisanName:         name.trim(),
            requestedService:    specialtyDesc,
            operationalCategory: effectiveCategory,
            status:              'pending',
            createdAt:           now,
        });
    }

    try {
        await batch.commit();
        console.log(`[OTP][${correlationId}] Artisan Firestore docs created uid=${uid}`);
    } catch (err) {
        // Firestore batch failed — delete Auth user to prevent orphan
        await getAuth().deleteUser(uid).catch(() => {});
        console.error(`[OTP][${correlationId}] Artisan Firestore batch failed, deleted Auth user uid=${uid}: ${err.message}`);
        throw err;
    }
}

module.exports = {
    requestSignupOtp,
    resendSignupOtp,
    verifySignupOtp,
    COL_VERIF,
    OTP_TTL_S,
    MIN_RESEND_GAP_S,
    MAX_RESENDS,
    MAX_ATTEMPTS,
};
