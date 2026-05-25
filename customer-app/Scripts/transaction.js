// ===========================
//  Handy Hub – Transaction History JS
// ===========================

document.addEventListener('DOMContentLoaded', () => {

  /* ---- Back button ---- */
  const backBtn = document.querySelector('.back-btn');
  if (backBtn) {
    backBtn.addEventListener('click', () => {
      showToast('Navigation', 'Going back…');
    });
  }

  /* ---- Filter button ---- */
  const filterBtn = document.querySelector('.filter-btn');
  if (filterBtn) {
    filterBtn.addEventListener('click', () => {
      showToast('Filter', 'Opening filter options…');
    });
  }

  /* ---- Top Up button ---- */
  const topUpBtn = document.querySelector('.topup-btn');
  if (topUpBtn) {
    topUpBtn.addEventListener('click', () => {
      showToast('Top Up', 'Redirecting to wallet top-up…');
    });
  }

  /* ---- Withdraw button ---- */
  const withdrawBtn = document.querySelector('.withdraw-btn');
  if (withdrawBtn) {
    withdrawBtn.addEventListener('click', () => {
      showToast('Withdraw', 'Opening withdrawal options…');
    });
  }

  /* ---- Transaction items ---- */
  const txnItems = document.querySelectorAll('.txn-item');
  txnItems.forEach(item => {
    item.addEventListener('click', () => {
      const title = item.querySelector('.txn-title')?.textContent ?? '';
      const amount = item.querySelector('.txn-amount')?.textContent ?? '';
      showToast(title, `Amount: ${amount.trim()}`);
    });
  });

  /* ---- Download Statement button ---- */
  const downloadBtn = document.querySelector('.download-btn');
  if (downloadBtn) {
    downloadBtn.addEventListener('click', () => {
      showToast('Download', 'Preparing your statement…');
    });
  }

  /* ---- Bottom nav ---- */
  const navItems = document.querySelectorAll('.nav-item');
  navItems.forEach(item => {
    item.addEventListener('click', () => {
      navItems.forEach(n => {
        n.classList.remove('active');
        const lbl = n.querySelector('span');
        if (lbl) lbl.classList.remove('active-label');
        n.querySelectorAll('path, circle, polyline, line, rect, polygon').forEach(p => {
          p.setAttribute('stroke', '#aaa');
        });
      });

      item.classList.add('active');
      const activeSpan = item.querySelector('span');
      if (activeSpan) activeSpan.classList.add('active-label');
      item.querySelectorAll('path, circle, polyline, line, rect, polygon').forEach(p => {
        p.setAttribute('stroke', '#730201');
      });

      const label = item.querySelector('span')?.textContent ?? '';
      showToast('Navigation', `Navigating to ${label}…`);
    });
  });

  /* ==========================
     Toast notification helper
  ========================== */
    const HH_TOAST_INFO_ICON = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2"/><path d="M12 10V16" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><path d="M12 7.6V7.65" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>';

  function showToast(title, message, type = 'info') {
    document.querySelector('.toast.app-toast')?.remove();

    const toast = document.createElement('div');
    toast.className = `toast app-toast ${type}`;
    toast.setAttribute('role', 'status');
    toast.setAttribute('aria-live', 'polite');
    toast.setAttribute('aria-atomic', 'true');

    const icon = document.createElement('span');
    icon.className = 'toast-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.innerHTML = HH_TOAST_INFO_ICON;

    const text = document.createElement('span');
    text.className = 'toast-message';
    text.textContent = message ? `${title}: ${message}` : title;

    toast.append(icon, text);
    document.body.appendChild(toast);

    clearTimeout(showToast._timer);
    showToast._timer = setTimeout(() => {
      toast.classList.add('toast-exit');
      setTimeout(() => toast.remove(), 320);
    }, 3000);
  }

});

