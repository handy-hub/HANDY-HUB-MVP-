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

/* Currency is not auto-detected. This block used to ask for the device's GPS
   position on first load and send it to a third-party reverse-geocoder
   (api.bigdatacloud.net), or the IP to country.is, to pick a currency that
   nothing reads: every amount is formatted as GHS (shared/js/utils/currency.js).
   It ran on every page that loads this file, including both Settings pages.
   An explicit choice in customer Settings still sets pref_currency. */
