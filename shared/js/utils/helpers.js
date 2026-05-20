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
    const target = cleanQuery ? `tracking.html?q=${encodeURIComponent(cleanQuery)}` : 'tracking.html';
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

// --- 3. SLIDER DOTS SYNC ---
const dots = document.querySelectorAll('.dot');
const slider = document.querySelector('.slider');
const adsContainer = document.querySelector('.ads');

function getTranslateXFromTransform(transformValue) {
    if (!transformValue || transformValue === 'none') return 0;

    try {
        if (typeof DOMMatrixReadOnly !== 'undefined') {
            return Math.abs(new DOMMatrixReadOnly(transformValue).m41);
        }
        if (typeof WebKitCSSMatrix !== 'undefined') {
            return Math.abs(new WebKitCSSMatrix(transformValue).m41);
        }
    } catch (error) {
        // Fall through to regex parser.
    }

    const match2d = transformValue.match(/matrix\(([^)]+)\)/);
    if (match2d) {
        const parts = match2d[1].split(',').map((part) => Number(part.trim()));
        return Math.abs(parts[4] || 0);
    }

    const match3d = transformValue.match(/matrix3d\(([^)]+)\)/);
    if (match3d) {
        const parts = match3d[1].split(',').map((part) => Number(part.trim()));
        return Math.abs(parts[12] || 0);
    }

    return 0;
}

if (slider && dots.length > 0 && adsContainer) {
    setInterval(() => {
        const style = window.getComputedStyle(slider);
        const xPosition = getTranslateXFromTransform(style.transform || style.webkitTransform);
        const containerWidth = adsContainer.offsetWidth;
        if (!containerWidth) return;
        const activeIndex = Math.round(xPosition / containerWidth) % dots.length;

        dots.forEach((dot, index) => {
            dot.classList.toggle('active', index === activeIndex);
        });
    }, 700);
}

// --- 4. NOTIFICATION & ACTIVITY SYSTEM ---
const notifBtn = document.querySelector('.notification-wrapper');
const notifDot = document.querySelector('.notification-dot, .notification-badge');
const notifList = document.getElementById('notification-list');
const activityPanel = document.getElementById('activity-panel');
const activityOverlay = document.getElementById('activity-overlay');

function checkNotifications() {
    if (!notifList || !notifDot) return false;
    const count = notifList.querySelectorAll('.notification-item').length;
    if (count > 0) {
        notifDot.classList.add('active');
        return true;
    } else {
        notifDot.classList.remove('active');
        return false;
    }
}

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
    electrician: 'icons/electrician.png',
    plumber: 'icons/plumber.png',
    carpenter: 'icons/carpenter.png',
    acUnit: 'icons/ac.png',
    welder: 'icons/welder.png',
    gardener: 'icons/gardener.png',
    painter: 'icons/painter.png',
    cleaner: 'icons/cleaner.png',
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

function handleServiceClick(serviceId) {
    if (!serviceId) return;
    const scores = JSON.parse(localStorage.getItem('service_scores') || '{}');
    scores[serviceId] = (scores[serviceId] || 0) + 1;
    localStorage.setItem('service_scores', JSON.stringify(scores));
    renderServices();
}

window.handleServiceClick = handleServiceClick;

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
    fetch('tracking.html')
        .then(response => response.text())
        .then(html => {
            // Put the tracking.html code inside the hidden container
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
