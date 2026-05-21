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
  function showToast(title, message) {
    // Remove any existing toast
    const existing = document.getElementById('hh-toast');
    if (existing) existing.remove();
 
    const toast = document.createElement('div');
    toast.id = 'hh-toast';
    toast.innerHTML = `<strong>${title}</strong><span>${message}</span>`;
    Object.assign(toast.style, {
      position: 'fixed',
      bottom: '110px',
      left: '50%',
      transform: 'translateX(-50%) translateY(20px)',
      background: '#111',
      color: '#fff',
      padding: '10px 18px',
      borderRadius: '12px',
      fontSize: '13px',
      display: 'flex',
      gap: '6px',
      alignItems: 'center',
      opacity: '0',
      transition: 'opacity 0.25s ease, transform 0.25s ease',
      zIndex: '9999',
      whiteSpace: 'nowrap',
      boxShadow: '0 6px 24px rgba(0,0,0,0.22)',
      pointerEvents: 'none',
    });
 
    document.body.appendChild(toast);
 
    // Animate in
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        toast.style.opacity = '1';
        toast.style.transform = 'translateX(-50%) translateY(0)';
      });
    });
 
    // Fade out after 2s
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateX(-50%) translateY(10px)';
      setTimeout(() => toast.remove(), 300);
    }, 2000);
  }
 
});
 