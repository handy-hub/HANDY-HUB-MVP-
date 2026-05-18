(() => {
    const notifications = [
        { id: 1, type: 'Bookings', title: 'Booking Confirmed', msg: 'Kwame Mensah (Plumber) has accepted your booking.', time: '2m ago', icon: 'fa-calendar-check', unread: true, group: 'New' },
        { id: 2, type: 'Messages', title: 'New Message', msg: 'Kwame Mensah sent you a message regarding your booking.', time: '5m ago', icon: 'fa-comment-dots', unread: true, group: 'New' },
        { id: 3, type: 'Bookings', title: 'Reminder', msg: 'Your booking with Emmanuel Asare is tomorrow at 10:00 AM.', time: '1h ago', icon: 'fa-bell', unread: true, group: 'New' },
        { id: 4, type: 'Offers', title: 'Special Offer', msg: 'Get 15% OFF on your next booking. Valid till 31st May.', time: '2h ago', icon: 'fa-tag', unread: true, group: 'New' },
        { id: 5, type: 'Messages', title: 'Review Request', msg: 'How was your experience with Kofi Boateng (Carpenter)? Leave a review.', time: '3h ago', icon: 'fa-star', unread: true, group: 'New' },
        { id: 6, type: 'Bookings', title: 'Payment Successful', msg: 'Your payment of GHC 120.00 was successful.', time: 'Yesterday, 6:45 PM', icon: 'fa-wallet', unread: false, group: 'Earlier' },
        { id: 7, type: 'General', title: 'Safety Update', msg: 'We\'re committed to your safety. Learn more about our verified professionals.', time: 'Yesterday, 12:15 PM', icon: 'fa-shield-halved', unread: false, group: 'Earlier' },
        { id: 8, type: 'General', title: 'Update', msg: 'We\'ve updated our Terms of Service and Privacy Policy.', time: 'Yesterday, 9:30 AM', icon: 'fa-bullhorn', unread: false, group: 'Earlier' }
    ];

    const tabs = [
        { name: 'All', count: 5 },
        { name: 'Bookings', count: 3 },
        { name: 'Messages', count: 1 },
        { name: 'Offers', count: 1 }
    ];

    let currentFilter = 'All';

    const dom = {
        tabContainer: document.getElementById('tabContainer'),
        notifList: document.getElementById('notif-list'),
        pushBox: document.getElementById('pushBox'),
        pushCloseBtn: document.getElementById('push-close-btn')
    };

    function renderTabs() {
        if (!dom.tabContainer) {
            return;
        }

        dom.tabContainer.innerHTML = tabs.map(tab => `
            <button type="button" data-filter="${tab.name}" class="flex items-center space-x-2 px-5 py-2 rounded-full whitespace-nowrap transition ${currentFilter === tab.name ? 'bg-[#b10c0c] text-white shadow-lg' : 'bg-gray-100 text-gray-800'}">
                <span class="text-sm font-bold">${tab.name}</span>
                <span class="${currentFilter === tab.name ? 'badge-white' : 'badge-red'}">${tab.count}</span>
            </button>
        `).join('');

        dom.tabContainer.querySelectorAll('button[data-filter]').forEach(button => {
            button.addEventListener('click', () => filterBy(button.dataset.filter));
        });
    }

    function renderNotifications() {
        if (!dom.notifList) {
            return;
        }

        const filtered = currentFilter === 'All'
            ? notifications
            : notifications.filter(n => n.type === currentFilter);

        const groups = ['New', 'Earlier'];
        let html = '';

        groups.forEach(group => {
            const groupItems = filtered.filter(n => n.group === group);
            if (groupItems.length > 0) {
                html += `<h3 class="text-sm font-bold mt-6 mb-2">${group}</h3>`;
                groupItems.forEach(item => {
                    html += `
                        <div data-id="${item.id}" class="notification-card flex items-start space-x-4 py-4 px-2 mb-2 rounded-2xl ${item.unread ? 'glass-card' : ''}">
                            <div class="icon-box">
                                <i class="fa-solid ${item.icon}"></i>
                            </div>
                            <div class="flex-1">
                                <div class="flex justify-between items-start">
                                    <h4 class="font-bold text-[15px] leading-tight">${item.title}</h4>
                                    <span class="text-[11px] text-gray-400">${item.time}</span>
                                </div>
                                <p class="text-[12px] text-gray-500 mt-1 leading-normal pr-4">${item.msg}</p>
                            </div>
                            ${item.unread ? '<div class="pt-6"><div class="unread-dot"></div></div>' : ''}
                        </div>
                    `;
                });
            }
        });

        dom.notifList.innerHTML = html;
        attachNotificationHandlers();
    }

    function attachNotificationHandlers() {
        dom.notifList.querySelectorAll('.notification-card').forEach(card => {
            card.addEventListener('click', () => {
                markAsRead(Number(card.dataset.id));
            });
        });
    }

    function filterBy(name) {
        if (!name) {
            return;
        }

        currentFilter = name;
        renderTabs();
        renderNotifications();
    }

    function markAsRead(id) {
        const item = notifications.find(n => n.id === id);
        if (!item) {
            return;
        }

        item.unread = false;
        renderNotifications();
    }

    function attachPushBoxHandler() {
        if (!dom.pushCloseBtn || !dom.pushBox) {
            return;
        }

        dom.pushCloseBtn.addEventListener('click', () => {
            dom.pushBox.remove();
        });
    }

    document.addEventListener('DOMContentLoaded', () => {
        renderTabs();
        renderNotifications();
        attachPushBoxHandler();
    });
})();
