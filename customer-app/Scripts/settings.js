// ===========================
//  Handy Hub – Settings JS
// ===========================

document.addEventListener('DOMContentLoaded', () => {

  /* ---- Back button ---- */
  document.querySelector('.back-btn')?.addEventListener('click', () => {
    showToast('Navigation', 'Going back…');
  });

  /* ---- User card ---- */
  document.querySelector('.chevron-btn')?.addEventListener('click', () => {
    showToast('Profile', 'Opening profile editor…');
  });

  /* ---- Menu items ---- */
  document.querySelectorAll('.menu-item').forEach(item => {
    item.addEventListener('click', () => {
      const title = item.querySelector('.menu-title')?.textContent ?? '';
      const value = item.querySelector('.menu-value')?.textContent ?? '';
      showToast(title, value ? `Current: ${value}` : `Opening ${title}…`);
    });
  });

  /* ---- Delete Account ---- */
  document.querySelector('.delete-btn')?.addEventListener('click', () => {
    if (confirm('Are you sure you want to delete your account? This action cannot be undone.')) {
      showToast('Account', 'Processing account deletion…');
    }
  });

  /* ---- Bottom nav ---- */
  document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', () => {
      document.querySelectorAll('.nav-item').forEach(n => {
        n.classList.remove('active');
        n.querySelector('span')?.classList.remove('active-label');
        n.querySelectorAll('path, circle, polyline, line, rect, polygon').forEach(p => p.setAttribute('stroke', '#aaa'));
      });
      item.classList.add('active');
      item.querySelector('span')?.classList.add('active-label');
      item.querySelectorAll('path, circle, polyline, line, rect, polygon').forEach(p => p.setAttribute('stroke', '#e03030'));
      const label = item.querySelector('span')?.textContent ?? '';
      showToast('Navigation', `Navigating to ${label}…`);
    });
  });

  /* ---- Toast helper ---- */
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

