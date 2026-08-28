/**
 * ui-utils.js
 *
 * Shared UI utilities for every admin page.
 * Import what you need:
 *   import { showToast, esc, ageStr, fmtGHS, fmtNum } from './js/ui-utils.js';
 */

/* ── Toast notification ──────────────────────────────────────────────────── */
export function showToast(msg, type = 'info') {
  const t = document.getElementById('admin-toast');
  if (!t) return;
  t.textContent = msg;
  t.className   = `admin-toast show${type === 'error' ? ' error' : type === 'success' ? ' success' : ''}`;
  clearTimeout(t._tid);
  t._tid = setTimeout(() => t.classList.remove('show'), 3500);
}

/* ── HTML-escape (prevent XSS in dynamic innerHTML) ─────────────────────── */
export function esc(str) {
  return String(str ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

/* ── Relative time string ────────────────────────────────────────────────── */
export function ageStr(date) {
  if (!date) return '—';
  const d    = date instanceof Date ? date : new Date(date);
  const diff = Date.now() - d.getTime();
  const hrs  = Math.floor(diff / 3_600_000);
  const days = Math.floor(hrs / 24);
  if (days > 1)  return `${days}d ago`;
  if (hrs  > 0)  return `${hrs}h ago`;
  const mins = Math.floor(diff / 60_000);
  if (mins > 0)  return `${mins}m ago`;
  return 'Just now';
}

/* ── Currency formatter ──────────────────────────────────────────────────── */
export function fmtGHS(n) {
  return 'GHS ' + Number(n ?? 0).toLocaleString('en-GH', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/* ── Number formatter ────────────────────────────────────────────────────── */
export function fmtNum(n) {
  return Number(n ?? 0).toLocaleString('en-GH');
}

/* ── Verif badge updater — called from every page ────────────────────────── */
import { db } from './firebase-admin.js';
import { collection, query, where, onSnapshot }
  from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js';

export function subscribeVerifBadge() {
  const q = query(
    collection(db, 'verification_requests'),
    where('verificationStatus', '==', 'pending_review')
  );
  return onSnapshot(q, snap => {
    const n = snap.size;
    const badge    = document.getElementById('verif-badge');
    const hdrBadge = document.getElementById('hdr-verif-badge');
    if (badge)    badge.textContent   = n || '';
    if (hdrBadge) {
      hdrBadge.textContent   = n;
      hdrBadge.style.display = n > 0 ? 'flex' : 'none';
    }
  });
}

/* ── Date header ─────────────────────────────────────────────────────────── */
export function setDateHeader() {
  const el = document.getElementById('hdr-date');
  if (el) el.textContent = new Date().toLocaleDateString('en-GH', {
    weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
  });
}
