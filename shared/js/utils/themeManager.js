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

/* Currency auto-detect: sets pref_currency using GPS location or IP fallback if user hasn't chosen yet */
(async function () {
  if (localStorage.getItem('pref_currency')) return;

  // Currency mapping based on ISO 2-letter country codes
  const currencyMap = {
    'GH': 'GHC', // Ghana
    'NG': 'NGN', // Nigeria
    'US': 'USD', // United States
    'GB': 'GBP', // United Kingdom
    // Eurozone
    'AT': 'EUR', 'BE': 'EUR', 'CY': 'EUR', 'EE': 'EUR', 'FI': 'EUR', 
    'FR': 'EUR', 'DE': 'EUR', 'GR': 'EUR', 'IE': 'EUR', 'IT': 'EUR', 
    'LV': 'EUR', 'LT': 'EUR', 'LU': 'EUR', 'MT': 'EUR', 'NL': 'EUR', 
    'PT': 'EUR', 'SK': 'EUR', 'SI': 'EUR', 'ES': 'EUR', 'HR': 'EUR'
  };

  const defaultCurrency = 'GHC';

  // Helper function to set currency from country code
  function applyCurrency(countryCode) {
    const currency = currencyMap[countryCode?.toUpperCase()] || defaultCurrency;
    localStorage.setItem('pref_currency', currency);
  }

  // Fallback: Fetch location via IP address (Fast, no popup permission required)
  async function fallbackToIP() {
    try {
      const res = await fetch('https://country.is/'); // Free, open-source IP-to-country API
      const data = await res.json();
      if (data && data.country) {
        applyCurrency(data.country);
      } else {
        localStorage.setItem('pref_currency', defaultCurrency);
      }
    } catch (_) {
      localStorage.setItem('pref_currency', defaultCurrency);
    }
  }

  // Primary: Use browser Geolocation API for maximum accuracy
  if ("geolocation" in navigator) {
    navigator.geolocation.getCurrentPosition(
      async (position) => {
        try {
          const lat = position.coords.latitude;
          const lon = position.coords.longitude;
          
          // Free reverse geocoding API with no API keys required
          const geoUrl = `https://bigdatacloud.net{lat}&longitude=${lon}&localityLanguage=en`;
          const res = await fetch(geoUrl);
          const data = await res.json();
          
          if (data && data.countryCode) {
            applyCurrency(data.countryCode);
          } else {
            await fallbackToIP();
          }
        } catch (_) {
          await fallbackToIP();
        }
      },
      async (error) => {
        // User denied GPS or location timed out: run the IP fallback instantly
        await fallbackToIP();
      },
      { timeout: 6000 } // Don't let the GPS prompt hang indefinitely
    );
  } else {
    // Geolocation not supported by browser
    await fallbackToIP();
  }
})();
