// --- 1. LANGUAGE DROPDOWN LOGIC ---
const langTrigger = document.getElementById('lang-trigger');
const langMenu = document.getElementById('lang-menu');
const currentLangDisplay = document.getElementById('current-lang');

if (langTrigger && langMenu) {
    langTrigger.addEventListener('click', (e) => {
        e.stopPropagation();
        langMenu.classList.toggle('active');
    });

    langMenu.querySelectorAll('li').forEach(item => {
        item.addEventListener('click', () => {
            if(currentLangDisplay) currentLangDisplay.textContent = item.textContent;
            langMenu.classList.remove('active');
            console.log("Language switched to:", item.dataset.lang);
        });
    });

    document.addEventListener('click', () => {
        langMenu.classList.remove('active');
    });
}

// --- 2. SEARCH PLACEHOLDER ROTATION ---
const searchInput = document.getElementById('dynamic-search');
const searchIcon = document.querySelector('.search-icon');
const phrases = [
    "AI Assisted Search...",
    "Find a Plumber...",
    "Fix a leaking pipe...",
    "Search for Electricians...",
    "AC Maintenance near me..."
];
let counter = 0;

function redirectToTracking(query = '') {
    const cleanQuery = query.trim();
    const target = cleanQuery ? `search-page.html?q=${encodeURIComponent(cleanQuery)}` : 'search-page.html';
    window.location.href = target;
}

if (searchInput) {
    setInterval(() => {
        searchInput.style.opacity = "0";
        setTimeout(() => {
            counter = (counter + 1) % phrases.length;
            searchInput.placeholder = phrases[counter];
            searchInput.style.opacity = "1";
        }, 400);
    }, 5000);

    searchInput.addEventListener('click', () => {
        redirectToTracking(searchInput.value);
    });

    searchInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
            event.preventDefault();
            redirectToTracking(searchInput.value);
        }
    });
}

if (searchIcon) {
    searchIcon.addEventListener('click', () => {
        redirectToTracking(searchInput ? searchInput.value : '');
    });
}

// --- 4. NOTIFICATION & ACTIVITY SYSTEM ---
const notifBtn = document.querySelector('.notification-wrapper');
const notifDot = document.querySelector('.notification-dot, .notification-badge');
const activityPanel = document.getElementById('activity-panel');
const activityOverlay = document.getElementById('activity-overlay');

function checkNotifications() {
    if (!notifDot) return false;
    let count = parseInt(localStorage.getItem('unread_notifications'), 10);
    if (isNaN(count)) count = 0;
    if (count > 0) {
        notifDot.textContent = count;
        notifDot.style.display = 'flex';
        return true;
    } else {
        notifDot.textContent = '';
        notifDot.style.display = 'none';
        return false;
    }
}

/**
 * Subscribe to real-time unread notification count from Firestore.
 * Called from authInit.js after auth resolves. Updates the badge live.
 * Falls back gracefully if databaseService or uid is unavailable.
 *
 * @param {object} databaseService  The app DI container's databaseService
 * @param {string} uid              Authenticated customer UID
 * @returns {function}              Unsubscribe function
 */
function initNotifications(databaseService, uid) {
    if (!uid || !databaseService) return function () {};
    try {
        return databaseService.subscribeToCollection(
            'customer_notifications',
            [
                { field: 'receiverId', op: '==',    value: uid   },
                { field: 'isRead',     op: '==',    value: false },
            ],
            {},
            function (records) {
                const count = Array.isArray(records) ? records.length : 0;
                try { localStorage.setItem('unread_notifications', String(count)); } catch {}
                if (!notifDot) return;
                if (count > 0) {
                    notifDot.textContent   = count > 99 ? '99+' : count;
                    notifDot.style.display = 'flex';
                } else {
                    notifDot.textContent   = '';
                    notifDot.style.display = 'none';
                }
            },
            function (err) {
                console.warn('[helpers] notification subscription error:', err && err.message);
            }
        );
    } catch (err) {
        console.warn('[helpers] initNotifications setup failed:', err && err.message);
        return function () {};
    }
}
window.HH_initNotifications = initNotifications;

if (notifBtn && activityPanel && activityOverlay) {
    notifBtn.addEventListener('click', () => {
        if (checkNotifications()) {
            activityPanel.classList.add('active');
            activityOverlay.classList.add('active');
        }
    });
}

if (activityOverlay && activityPanel) {
    activityOverlay.addEventListener('click', () => {
        activityPanel.classList.remove('active');
        activityOverlay.classList.remove('active');
    });
}

// --- 5. GREETING & LOCATION ---
function updateGreeting() {
    const nameElement = document.querySelector('.name');
    if (!nameElement) return;
    const hour = new Date().getHours();
    let greeting = (hour < 12) ? "GOOD MORNING" : (hour < 17) ? "GOOD AFTERNOON" : (hour < 21) ? "GOOD EVENING" : "GOOD NIGHT";
    nameElement.textContent = greeting;
}

function updateLocation() {
    const locationElement = document.querySelector('.location');
    if (!locationElement || !navigator.geolocation) return;

    navigator.geolocation.getCurrentPosition((pos) => {
        const url = `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${pos.coords.latitude}&longitude=${pos.coords.longitude}&localityLanguage=en`;
        fetch(url).then(res => res.json()).then(data => {
            locationElement.textContent = `${(data.city || "ACCRA").toUpperCase()}, ${(data.countryName || "GHANA").toUpperCase()}`;
        }).catch(() => { locationElement.textContent = "ACCRA, GHANA"; });
    });
}

// --- 6. SIDEBAR TOGGLE ---
const menuWrapper = document.querySelector('.menu-wrapper');
const sidebar = document.getElementById('sidebar');
const sidebarOverlay = document.getElementById('sidebar-overlay');
const closeSidebarBtn = document.getElementById('close-sidebar');

if (menuWrapper && sidebar && sidebarOverlay) menuWrapper.addEventListener('click', () => {
    sidebar.classList.add('active');
    sidebarOverlay.classList.add('active');
});

const closeFunc = () => {
    if (!sidebar || !sidebarOverlay) return;
    sidebar.classList.remove('active');
    sidebarOverlay.classList.remove('active');
};
if (closeSidebarBtn) closeSidebarBtn.addEventListener('click', closeFunc);
if (sidebarOverlay) sidebarOverlay.addEventListener('click', closeFunc);

// --- 7. DYNAMIC SERVICE SLIDER (THE ALGORITHM) ---

// Define serviceIcons if not already defined globally
const serviceIcons = window.serviceIcons || {
    electrician: '../shared/assets/icons/electricals.png',
    plumber:     '../shared/assets/icons/plummer.png',
    carpenter:   '../shared/assets/icons/carpenter.png',
    acUnit:      '../shared/assets/icons/cooling.png',
    welder:      '../shared/assets/icons/welder.png',
    gardener:    '../shared/assets/icons/gardener.svg',
    painter:     '../shared/assets/icons/painter.png',
    cleaner:     '../shared/assets/icons/cleaner.svg',
    nav: {
        home: { filled: 'icons/nav-home-filled.png', outline: 'icons/nav-home-outline.png' },
        bookings: { filled: 'icons/nav-bookings-filled.png', outline: 'icons/nav-bookings-outline.png' },
        profile: { filled: 'icons/nav-profile-filled.png', outline: 'icons/nav-profile-outline.png' }
    }
};

const services = [
    { id: 'elec', name: 'Electrician', img: serviceIcons.electrician },
    { id: 'plum', name: 'Plumber', img: serviceIcons.plumber },
    { id: 'carp', name: 'Carpenter', img: serviceIcons.carpenter },
    { id: 'ac', name: 'A/C Tech', img: serviceIcons.acUnit },
    { id: 'weld', name: 'Welder', img: serviceIcons.welder },
    { id: 'gard', name: 'Gardener', img: serviceIcons.gardener },
    { id: 'paint', name: 'Painter', img: serviceIcons.painter },
    { id: 'clean', name: 'Cleaner', img: serviceIcons.cleaner }
];


function renderServices() {
    const sliderBox = document.getElementById('service-slider');
    if (!sliderBox) {
        return;
    }

    const scores = JSON.parse(localStorage.getItem('service_scores') || '{}');
    
    // 2. Now .sort() will work because 'services' is an Array
    const sorted = [...services].sort((a, b) => (scores[b.id] || 0) - (scores[a.id] || 0));

    sliderBox.innerHTML = sorted.map(s => `
        <button onclick="handleServiceClick('${s.id}')">
            <div class="c-one">
                <img src="${s.img}" alt="${s.name}">
            </div>
            <p>${s.name}</p>
        </button>
    `).join('');
}

// Inline onclick="handleServiceClick(...)" attributes rendered by renderServices()
// are evaluated at click time. By that point dashboard.html's inline script has
// already set window.handleServiceClick to its navigating version, which is what
// runs. This local function is kept as a safe non-navigating fallback for any
// hypothetical page that renders the old slider without its own override.
function handleServiceClick(serviceId) {
    if (!serviceId) return;
    const scores = JSON.parse(localStorage.getItem('service_scores') || '{}');
    scores[serviceId] = (scores[serviceId] || 0) + 1;
    localStorage.setItem('service_scores', JSON.stringify(scores));
    renderServices();
}

// Do NOT assign to window here. dashboard.html's inline script is the sole owner
// of window.handleServiceClick and sets the navigating version. Assigning here
// creates a race that dashboard.html silently wins anyway — removing the
// assignment eliminates the confusion without changing observable behaviour.
if (typeof window.handleServiceClick === 'undefined') {
    window.handleServiceClick = handleServiceClick;
}

function initNavbar() {
    const navItems = document.querySelectorAll('.nav-item');
    const path = window.location.pathname;
    const navIcons = window.serviceIcons && window.serviceIcons.nav;

    if (!navItems.length || !navIcons) return;

    navItems.forEach(item => {
        const img = item.querySelector('img');
        if (!img) return;

        const href = item.getAttribute('href');
        if (!href) return;

        const type = href.replace('.html', ''); // Gets 'home', 'bookings', etc.
        const iconKey = type === 'index' ? 'home' : type;
        const iconSet = navIcons[iconKey];
        if (!iconSet) return;
        
        // Match home page correctly
        const isHome = (path.endsWith('index.html') || path === '/') && type === 'index';
        const isCurrentPage = path.includes(type);

        if (isHome || isCurrentPage) {
            item.classList.add('active');
            // Use the FILLED version from your Icons file
            img.src = iconSet.filled;
        } else {
            item.classList.remove('active');
            // Use the OUTLINE version
            img.src = iconSet.outline;
        }
    });
}

// Run on load
window.addEventListener('DOMContentLoaded', initNavbar);
document.addEventListener("DOMContentLoaded", () => {
    const searchTrigger = document.getElementById('dynamic-search');
    const searchContainer = document.getElementById('search-container');
    const homeContent = document.getElementById('home-content');
    if (!searchTrigger || !searchContainer || !homeContent) return;

    // 1. Pre-fetch the search page code immediately
    fetch('search-page.html')
        .then(response => response.text())
        .then(html => {
            // Put the search-page.html code inside the hidden container
            searchContainer.innerHTML = html;
        })
        .catch((error) => {
            console.error('Search prefetch failed:', error);
        });

    // 2. Switch views instantly on click
    searchTrigger.addEventListener('click', () => {
        homeContent.style.display = 'none';
        searchContainer.style.display = 'block';

        // Automatically pull up the keyboard in the new search bar
        const activeInput = searchContainer.querySelector('input');
        if (activeInput) activeInput.focus();

        // Handle the Back button automatically
        const backBtn = searchContainer.querySelector('.back-btn');
        if (backBtn) {
            backBtn.onclick = (e) => {
                e.preventDefault();
                searchContainer.style.display = 'none';
                homeContent.style.display = 'block';
            };
        }
    });
});

function timeAgo(date) {
    const now = new Date();
    const seconds = Math.floor((now - new Date(date)) / 1000);

    let interval = Math.floor(seconds / 31536000);
    if (interval >= 1) return interval + "y ago";

    interval = Math.floor(seconds / 2592000);
    if (interval >= 1) return interval + "mo ago";

    interval = Math.floor(seconds / 86400);
    if (interval >= 1) return interval + "d ago";

    interval = Math.floor(seconds / 3600);
    if (interval >= 1) return interval + "h ago";

    interval = Math.floor(seconds / 60);
    if (interval >= 1) return interval + "m ago";

    return "Just now";
}

function updateTimestamps() {
    document.querySelectorAll('.timestamp').forEach(span => {
        const rawTime = span.getAttribute('data-time');
        if (rawTime) {
            span.textContent = timeAgo(rawTime);
        }
    });
}

// Run immediately and then every 60 seconds to keep it fresh
updateTimestamps();
setInterval(updateTimestamps, 60000);

// INITIALIZE EVERYTHING
updateGreeting();
updateLocation();
checkNotifications();
renderServices();
