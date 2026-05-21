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
  function showToast(title, message) {
    document.getElementById('hh-toast')?.remove();
    const toast = document.createElement('div');
    toast.id = 'hh-toast';
    toast.innerHTML = `<strong>${title}</strong><span style="font-weight:400;opacity:0.8;margin-left:6px">${message}</span>`;
    Object.assign(toast.style, {
      position: 'fixed', bottom: '110px', left: '50%',
      transform: 'translateX(-50%) translateY(20px)',
      background: '#111', color: '#fff', padding: '10px 18px',
      borderRadius: '12px', fontSize: '13px', display: 'flex',
      alignItems: 'center', opacity: '0',
      transition: 'opacity 0.25s ease, transform 0.25s ease',
      zIndex: '9999', whiteSpace: 'nowrap',
      boxShadow: '0 6px 24px rgba(0,0,0,0.22)', pointerEvents: 'none',
    });
    document.body.appendChild(toast);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      toast.style.opacity = '1';
      toast.style.transform = 'translateX(-50%) translateY(0)';
    }));
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateX(-50%) translateY(10px)';
      setTimeout(() => toast.remove(), 300);
    }, 2000);
  }

});