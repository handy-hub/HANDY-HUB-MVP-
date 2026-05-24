// ===========================
//  Handy Hub – Profile JS
// ===========================
 
document.addEventListener('DOMContentLoaded', () => {
 
  /* ---- Greeting based on time of day ---- */
  const greetingEl = document.querySelector('.greeting');
  if (greetingEl) {
    const hour = new Date().getHours();
    let salutation = 'Good morning';
    if (hour >= 12 && hour < 17) salutation = 'Good afternoon';
    else if (hour >= 17) salutation = 'Good evening';
    greetingEl.textContent = `${salutation}, John Doe`; // Replace with dynamic name if available
  }
 
  /* ---- Top Up button ---- */
  const topUpBtn = document.querySelector('.topup-btn');
  if (topUpBtn) {
    topUpBtn.addEventListener('click', () => {
      showToast('Top Up', 'Redirecting to wallet top-up…');
    });
  }
 
  /* ---- Update Profile button ---- */
  const updateBtn = document.querySelector('.update-btn');
  if (updateBtn) {
    updateBtn.addEventListener('click', () => {
      showToast('Profile', 'Opening profile editor…');
    });
  }
 
  /* ---- Settings button ---- */
  const settingsBtn = document.querySelector('.icon-btn');
  if (settingsBtn) {
    settingsBtn.addEventListener('click', () => {
      showToast('Settings', 'Opening settings…');
    });
  }
 
  /* ---- User card chevron (edit) ---- */
  const chevronBtn = document.querySelector('.chevron-btn');
  if (chevronBtn) {
    chevronBtn.addEventListener('click', () => {
      showToast('Edit Profile', 'Opening profile details…');
    });
  }
 
  /* ---- Wallet rows ---- */
  const walletRows = document.querySelectorAll('.wallet-row');
  walletRows.forEach(row => {
    row.addEventListener('click', () => {
      const label = row.querySelector('.wallet-link')?.textContent ?? '';
      showToast('Wallet', `Opening ${label}…`);
    });
  });
 
  /* ---- Activity buttons ---- */
  const activityBtns = document.querySelectorAll('.activity-item');
  activityBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const label = btn.querySelector('span')?.textContent ?? '';
      showToast('Activity', `Opening ${label}…`);
    });
  });
 
  /* ---- Menu items ---- */
  const menuItems = document.querySelectorAll('.menu-item');
  menuItems.forEach(item => {
    item.addEventListener('click', () => {
      const title = item.querySelector('.menu-title')?.textContent ?? '';
      showToast(title, `Opening ${title}…`);
    });
  });
 
  /* ---- Bottom nav ---- */
  const navItems = document.querySelectorAll('.nav-item');
  navItems.forEach(item => {
    item.addEventListener('click', () => {
      navItems.forEach(n => n.classList.remove('active'));
      item.classList.add('active');
 
      // Swap label colour
      navItems.forEach(n => {
        const lbl = n.querySelector('span');
        if (lbl) lbl.classList.remove('active-label');
        const svgPaths = n.querySelectorAll('path, circle, polyline, line, rect, polygon');
        svgPaths.forEach(p => {
          p.setAttribute('stroke', '#aaa');
        });
      });
 
      const activeSpan = item.querySelector('span');
      if (activeSpan) activeSpan.classList.add('active-label');
      const activeSvgPaths = item.querySelectorAll('path, circle, polyline, line, rect, polygon');
      activeSvgPaths.forEach(p => {
        p.setAttribute('stroke', '#730201');
      });
 
      const label = item.querySelector('span')?.textContent ?? '';
      showToast('Navigation', `Navigating to ${label}…`);
    });
  });
 
  /* ---- Log Out button ---- */
  const logoutBtn = document.querySelector('.logout-btn');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', () => {
      if (confirm('Are you sure you want to log out?')) {
        showToast('Log Out', 'You have been logged out.');
      }
    });
  }
 
  /* ---- Camera / avatar change ---- */
  const cameraBtn = document.querySelector('.camera-btn');
  if (cameraBtn) {
    cameraBtn.addEventListener('click', () => {
      showToast('Photo', 'Opening photo picker…');
    });
  }
 
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
 

