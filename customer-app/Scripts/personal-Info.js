// ===========================
//  Handy Hub – Personal Information JS
// ===========================

document.addEventListener('DOMContentLoaded', () => {

  const modalOverlay = document.getElementById('modal-overlay');
  const modalTitle   = document.getElementById('modal-title');
  const modalInput   = document.getElementById('modal-input');
  const modalSave    = document.getElementById('modal-save');
  const modalClose   = document.getElementById('modal-close');

  // Field labels for the modal title
  const fieldLabels = {
    fullname: 'Full Name',
    email:    'Email Address',
    phone:    'Phone Number',
    dob:      'Date of Birth',
    gender:   'Gender',
    address:  'Primary Address',
  };

  let activeField = null;

  /* ---- Open modal when a detail item is clicked ---- */
  document.querySelectorAll('.detail-item').forEach(item => {
    item.addEventListener('click', () => {
      activeField = item.dataset.field;
      const currentVal = document.getElementById(`val-${activeField}`)?.textContent ?? '';
      modalTitle.textContent = `Edit ${fieldLabels[activeField]}`;
      modalInput.value = currentVal;
      modalInput.placeholder = `Enter ${fieldLabels[activeField]}`;
      openModal();
    });
  });

  /* ---- Save from modal ---- */
  modalSave.addEventListener('click', () => {
    const newVal = modalInput.value.trim();
    if (newVal && activeField) {
      document.getElementById(`val-${activeField}`).textContent = newVal;
      showToast('Updated', `${fieldLabels[activeField]} saved`);
    }
    closeModal();
  });

  /* ---- Close modal ---- */
  modalClose.addEventListener('click', closeModal);
  modalOverlay.addEventListener('click', (e) => {
    if (e.target === modalOverlay) closeModal();
  });

  /* ---- Enter key saves ---- */
  modalInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') modalSave.click();
  });

  function openModal() {
    modalOverlay.classList.add('active');
    setTimeout(() => modalInput.focus(), 300);
  }

  function closeModal() {
    modalOverlay.classList.remove('active');
    activeField = null;
  }

  /* ---- Change Photo button ---- */
  document.getElementById('change-photo-btn')?.addEventListener('click', () => {
    document.getElementById('photo-input').click();
  });

  document.getElementById('photo-input')?.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) {
      showToast('Error', 'File exceeds 2MB limit');
      return;
    }
    const reader = new FileReader();
    reader.onload = (ev) => {
      document.getElementById('profile-img').src = ev.target.result;
      showToast('Photo', 'Profile photo updated');
    };
    reader.readAsDataURL(file);
  });

  /* ---- Save Changes button ---- */
  document.getElementById('save-btn')?.addEventListener('click', () => {
    const btn = document.getElementById('save-btn');
    btn.textContent = 'Saving…';
    btn.style.opacity = '0.7';
    setTimeout(() => {
      btn.textContent = 'Save Changes';
      btn.style.opacity = '1';
      showToast('Success', 'Your changes have been saved');
    }, 1200);
  });

  /* ---- Back button ---- */
  document.querySelector('.back-btn')?.addEventListener('click', () => {
    showToast('Navigation', 'Going back…');
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