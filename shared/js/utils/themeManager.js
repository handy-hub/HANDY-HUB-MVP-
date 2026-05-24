/* themeManager.js — apply saved theme preference immediately to avoid flash */
(function () {
  var theme = localStorage.getItem('pref_theme') || 'Light';
  var root = document.documentElement;
  if (theme === 'Dark') {
    root.setAttribute('data-theme', 'dark');
    root.classList.add('dark');
    root.style.colorScheme = 'dark';
  } else {
    root.removeAttribute('data-theme');
    root.classList.remove('dark');
    root.style.colorScheme = 'light';
  }
})();

/* Exported helper so pages can call applyTheme('Dark') at runtime */
function applyTheme(value) {
  var root = document.documentElement;
  if (value === 'Dark') {
    root.setAttribute('data-theme', 'dark');
    root.classList.add('dark');
    root.style.colorScheme = 'dark';
  } else {
    root.removeAttribute('data-theme');
    root.classList.remove('dark');
    root.style.colorScheme = 'light';
  }
  localStorage.setItem('pref_theme', value);
}

/* Currency auto-detect: sets pref_currency from timezone if user hasn't chosen yet */
(function () {
  if (localStorage.getItem('pref_currency')) return;
  var tz = '';
  try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (e) {}
  var currency = 'GHC';
  if (/^America\//.test(tz)) currency = 'USD';
  else if (/^Europe\/London$/.test(tz)) currency = 'GBP';
  else if (/^Europe\//.test(tz)) currency = 'EUR';
  else if (/^Africa\/(Lagos|Abuja|Kano)/.test(tz)) currency = 'NGN';
  else if (/^Africa\/(Accra|Kumasi|Takoradi)/.test(tz)) currency = 'GHC';
  localStorage.setItem('pref_currency', currency);
})();
