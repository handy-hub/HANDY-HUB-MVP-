/** Central user-safe error classification and diagnostic logging. */

const COPY = {
  offline:      { title: 'You’re offline', message: 'Check your internet connection and try again.', actionLabel: 'Retry' },
  timeout:      { title: 'This is taking longer than expected', message: 'The request could not be completed in time. Please try again.', actionLabel: 'Retry' },
  unavailable:  { title: 'We couldn’t load this right now', message: 'Our service is temporarily unavailable. Please try again shortly.', actionLabel: 'Retry' },
  unauthorized: { title: 'Please sign in again', message: 'Your session has expired. Sign in to continue.', actionLabel: 'Sign In' },
  forbidden:    { title: 'You can’t access this information', message: 'This content is not available for your account.', actionLabel: 'Go Back' },
  notFound:     { title: 'We couldn’t find what you’re looking for', message: 'It may have been removed, changed, or is no longer available.', actionLabel: 'Go Back' },
  invalid:      { title: 'Check the details', message: 'Some information is missing or invalid. Review it and try again.', actionLabel: 'Review' },
  rateLimited:  { title: 'Please wait a moment', message: 'There have been too many attempts. Try again shortly.', actionLabel: 'Try Again' },
  conflict:     { title: 'That has already been updated', message: 'Refresh the page to see the latest information.', actionLabel: 'Refresh' },
  cancelled:    { title: 'The request was cancelled', message: 'No changes were made.', actionLabel: null },
  failure:      { title: 'We couldn’t complete that', message: 'Please try again. If the problem continues, contact support.', actionLabel: 'Retry' },
};

const CONTEXT_COPY = {
  'booking-create': { title: 'We couldn’t create your booking', message: 'No booking was submitted. Please review the details and try again.', actionLabel: 'Try Again' },
  profile:          { title: 'We couldn’t load your profile', message: 'Your account is still safe. Please retry or refresh the page.', actionLabel: 'Retry' },
  tracking:         { title: 'Live location is temporarily unavailable', message: 'Please retry while we reconnect.', actionLabel: 'Retry' },
  upload:           { title: 'We couldn’t upload that file', message: 'Check your connection and file, then try again.', actionLabel: 'Try Again' },
  message:          { title: 'Your message wasn’t sent', message: 'Check your connection and try sending it again.', actionLabel: 'Try Again' },
  // Payment state is uncertain unless a backend response explicitly proves it.
  payment:          { title: 'We couldn’t confirm your payment', message: 'Your payment status may still be updating. Do not pay again yet. Check your transactions before retrying.', actionLabel: 'View Transactions' },
};

function normalizedCode(error) {
  const raw = String(error?.code || error?.name || '').toLowerCase();
  return raw.replace(/^firebase(error)?:\s*/i, '').replace(/^functions\//, '').replace(/^firestore\//, '');
}

export function classifyError(error, { context = 'general', online = typeof navigator === 'undefined' ? true : navigator.onLine } = {}) {
  const code = normalizedCode(error);
  let kind = 'failure';
  if (!online || code.includes('network-request-failed')) kind = 'offline';
  else if (code.includes('deadline-exceeded') || code.includes('timeout')) kind = 'timeout';
  else if (code.includes('unavailable') || code === 'internal' || code.endsWith('/internal')) kind = 'unavailable';
  else if (code.includes('unauthenticated') || code.includes('user-token-expired')) kind = 'unauthorized';
  else if (code.includes('permission-denied')) kind = 'forbidden';
  else if (code.includes('not-found') || code.includes('user-not-found')) kind = 'notFound';
  else if (code.includes('invalid-argument') || code.includes('invalid-email') || code.includes('wrong-password')) kind = 'invalid';
  else if (code.includes('resource-exhausted') || code.includes('too-many-requests') || code.includes('rate-limit')) kind = 'rateLimited';
  else if (code.includes('already-exists') || code.includes('aborted')) kind = 'conflict';
  else if (code.includes('cancelled') || code.includes('popup-closed')) kind = 'cancelled';

  const base = kind === 'failure' && CONTEXT_COPY[context] ? CONTEXT_COPY[context] : COPY[kind];
  return { kind, context, code: code || 'unknown', ...base };
}

export function reportError(error, { context = 'general', operation = 'unknown', metadata = {} } = {}) {
  const safeMetadata = Object.fromEntries(Object.entries(metadata).filter(([key]) =>
    !/token|password|secret|otp|card|address|phone|email/i.test(key)));
  const diagnostic = {
    timestamp: new Date().toISOString(), context, operation,
    code: normalizedCode(error) || 'unknown', message: String(error?.message || error || '').slice(0, 300),
    metadata: safeMetadata,
  };
  console.error('[HandyHub]', diagnostic);
  return classifyError(error, { context });
}

/** Back-compatible string API used by existing toast call sites. */
export function mapError(error, fallback = '') {
  const mapped = classifyError(error);
  return mapped.message || fallback || COPY.failure.message;
}
