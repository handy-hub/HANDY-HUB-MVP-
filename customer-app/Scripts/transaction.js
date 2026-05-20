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
        p.setAttribute('stroke', '#e03030');
      });

      const label = item.querySelector('span')?.textContent ?? '';
      showToast('Navigation', `Navigating to ${label}…`);
    });
  });

  /* ==========================
     Toast notification helper
  ========================== */
  function showToast(title, message) {
    const existing = document.getElementById('hh-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.id = 'hh-toast';
    toast.innerHTML = `<strong>${title}</strong><span style="font-weight:400; opacity:0.8; margin-left:6px">${message}</span>`;
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
      alignItems: 'center',
      opacity: '0',
      transition: 'opacity 0.25s ease, transform 0.25s ease',
      zIndex: '9999',
      whiteSpace: 'nowrap',
      boxShadow: '0 6px 24px rgba(0,0,0,0.22)',
      pointerEvents: 'none',
    });

    document.body.appendChild(toast);

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        toast.style.opacity = '1';
        toast.style.transform = 'translateX(-50%) translateY(0)';
      });
    });

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateX(-50%) translateY(10px)';
      setTimeout(() => toast.remove(), 300);
    }, 2000);
  }

});