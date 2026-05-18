// navLoader.js
(function(){
    const topNavHTML = `
    <nav class="profile-card">
       <div class="menu-wrapper">
        <svg class="menu-icon" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org">
            <path d="M4 6H20M4 12H20M4 18H20" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
    </div>

    <div class="profile-info">
        <h2 class="greetingconsole.log("");">GOOD EVENING</h2>
        <p class="location">ACCRA, GHANA</p>
    </div>

    <button class="notification-wrapper-button">
            <div class="notification-wrapper">
        <svg class="notification-icon" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org">
            <path d="M12 22C13.1 22 14 21.1 14 20H10C10 21.1 10.9 22 12 22ZM18 16V11C18 7.93 16.37 5.36 13.5 4.68V4C13.5 3.17 12.83 2.5 12 2.5C11.17 2.5 10.5 3.17 10.5 4V4.68C7.64 5.36 6 7.92 6 11V16L4 18V19H20V18L18 16Z" fill="currentColor"/>
        </svg>
        <span class="notification-badge"></span>                                                                                                                                                                                                                                                                                                                                                            
    </div>
    </button>
    `;

    const bottomNavHTML = `
    <nav class="bottom-nav">
        <a href="dashboard.html" class="nav-item">
            <img src="" alt="Home">
            <span>Home</span>
        </a>

        <a href="booking.html" class="nav-item">
            <img src="" alt="Bookings">
            <span>Bookings</span>
        </a>

        <a href="messages.html" class="nav-item">
            <img src="" alt="Messages">
            <span>Messages</span>
        </a>

        <a href="saved.html" class="nav-item">
            <img src="" alt="Saved">
            <span>Saved</span>
        </a>

        <a href="profile.html" class="nav-item">
            <img src="" alt="Profile">
            <span>Profile</span>
        </a>
    </nav>
    `;

    function insertNavs() {
        const topPlaceholder = document.getElementById('top-nav-include') || document.querySelector('[data-include="top-nav"]');
        const bottomPlaceholder = document.getElementById('bottom-nav-include') || document.querySelector('[data-include="bottom-nav"]');

        if (topPlaceholder) topPlaceholder.innerHTML = topNavHTML;
        if (bottomPlaceholder) bottomPlaceholder.innerHTML = bottomNavHTML;
    }

    insertNavs();
})();
