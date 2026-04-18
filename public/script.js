// Поліфіл для crypto.randomUUID (для старих браузерів)
if (!crypto.randomUUID) {
    crypto.randomUUID = function() {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
            const r = crypto.getRandomValues(new Uint8Array(1))[0] % 16;
            const v = c === 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16);
        });
    };
}

let map, markers = [], addingMode = false, selectedLatLng;
const userId = localStorage.getItem('userId') || crypto.randomUUID();
localStorage.setItem('userId', userId);

// Капча – один раз на сесію
let captchaPassed = localStorage.getItem('captchaPassed') === 'true';

// Назви та емодзі для 7 типів подій
const typeNames = [
    '', 
    'Пропав собака', 
    'Пропала кішка', 
    'Жвавий трафік - обережно!', 
    'Тваринка в біді', 
    'Возз\'єднання', 
    'Поранилась', 
    'На жаль, не врятували'
];
const typeEmoji = [
    '', 
    '🐕', 
    '🐈', 
    '⚠️', 
    '📢', 
    '🎉', 
    '😿', 
    '💔'
];

// Функція екранування HTML (захист від XSS)
function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/[&<>]/g, function(m) {
        if (m === '&') return '&amp;';
        if (m === '<') return '&lt;';
        if (m === '>') return '&gt;';
        return m;
    });
}

// Нікнейм
const nicknameInput = document.getElementById('nickname');
if (nicknameInput) {
    nicknameInput.value = localStorage.getItem('nickname') || '';
    nicknameInput.addEventListener('change', async () => {
        const newNick = nicknameInput.value.trim() || 'Анонім';
        localStorage.setItem('nickname', newNick);
        try {
            await fetch('/api/users/nickname', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ user_id: userId, nickname: newNick })
            });
        } catch (err) { console.warn(err); }
    });
}

// Ініціалізація мапи
function initMap() {
    map = L.map('map').setView([50.45, 30.52], 12);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
    }).addTo(map);
    map.on('moveend', loadEvents);
    map.on('click', e => {
        if (addingMode) {
            selectedLatLng = e.latlng;
            if (!captchaPassed) generateCaptcha();
            document.getElementById('eventModal').style.display = 'flex';
        }
    });
    loadEvents();
}

// Капча
let captchaValue = null;
function generateCaptcha() {
    const num1 = Math.floor(Math.random() * 10) + 1;
    const num2 = Math.floor(Math.random() * 10) + 1;
    captchaValue = num1 + num2;
    document.getElementById('captchaQuestion').innerHTML = `${num1} + ${num2} = ?`;
    document.getElementById('captchaAnswer').value = '';
    document.getElementById('captchaBlock').style.display = 'block';
}
function hideCaptcha() {
    document.getElementById('captchaBlock').style.display = 'none';
}

// Завантаження подій
async function loadEvents() {
    if (!map) return;
    const b = map.getBounds();
    try {
        const res = await fetch(`/api/events?bounds=${b.getSouth()},${b.getWest()},${b.getNorth()},${b.getEast()}`);
        const events = await res.json();
        if (!Array.isArray(events)) {
            console.error('Помилка від сервера:', events);
            return;
        }
        markers.forEach(m => map.removeLayer(m));
        markers = events.map(e => {
            let color;
            if (!e.active) {
                color = '#9ca3af'; // сірий для неактивних
            } else if (e.user_id === userId) {
                color = '#10b981'; // зелений для своїх
            } else {
                switch (e.event_type) {
                    case 3: color = '#f44336'; break; // червоний для трафіку
                    case 5: color = '#f5e6c4'; break; // бежевий для возз'єднання
                    case 7: color = '#1a1a1a'; break; // чорний для "не врятували"
                    default: color = '#3b82f6'; break; // синій для інших
                }
            }
            const m = L.circleMarker([e.lat, e.lng], {
                radius: 10,
                fillColor: color,
                color: '#fff',
                weight: 2,
                fillOpacity: 0.9
            }).addTo(map);
            const commentText = e.comment || 'немає коментаря';
            const escapedComment = escapeHtml(commentText);
            const escapedNick = escapeHtml(e.nickname);
            const actions = e.user_id === userId ? `
                <button onclick="editEvent(${e.id}, '${escapeHtml(e.comment || '').replace(/'/g, "\\'")}')">✏️ Редагувати</button>
                <button onclick="deleteEvent(${e.id})">🗑️ Видалити</button>
            ` : '';
            m.bindPopup(`
                <b>${typeEmoji[e.event_type]} ${escapeHtml(typeNames[e.event_type])}</b><br>
                <i>${escapedComment}</i><br>
                <small>👤 ${escapedNick} • ${new Date(e.created_at).toLocaleString()}</small><br>
                ${actions}
                <button onclick="openCommentsModal(${e.id})">💬 Коментарі</button>
                <button onclick="reportEvent(${e.id})">⚠️ Скарга</button>
            `);
            return m;
        });
        applyFilters();
    } catch (err) { console.error(err); }
}

// Фільтри
function applyFilters() {
    const filterType = document.getElementById('typeFilter')?.value || '';
    const onlyMine = document.getElementById('onlyMineCheckbox')?.checked || false;
    const searchText = document.getElementById('searchText')?.value.trim().toLowerCase() || '';

    markers.forEach(m => {
        const popupContent = m.getPopup().getContent();
        let visible = true;

        if (filterType !== '') {
            const typeMatch = popupContent.includes(typeEmoji[parseInt(filterType)]);
            if (!typeMatch) visible = false;
        }
        if (onlyMine && visible) {
            const isOwn = m.options.fillColor === '#10b981';
            if (!isOwn) visible = false;
        }
        if (searchText !== '' && visible) {
            if (!popupContent.toLowerCase().includes(searchText)) visible = false;
        }
        m.getElement().style.display = visible ? '' : 'none';
    });
}

document.getElementById('typeFilter')?.addEventListener('change', applyFilters);
document.getElementById('onlyMineCheckbox')?.addEventListener('change', applyFilters);
document.getElementById('searchText')?.addEventListener('input', applyFilters);

// Кнопка додавання події
const addBtn = document.getElementById('addBtn');
if (addBtn) {
    addBtn.onclick = () => {
        addingMode = !addingMode;
        if (addingMode) {
            addBtn.classList.add('cancel');
            addBtn.innerHTML = '✖ Скасувати';
        } else {
            addBtn.classList.remove('cancel');
            addBtn.innerHTML = '➕ Додати позначку';
        }
    };
}

// Закриття модалок
const closeModal = document.querySelector('#eventModal .close');
if (closeModal) closeModal.onclick = () => document.getElementById('eventModal').style.display = 'none';
const closeCommentsModal = document.getElementById('closeCommentsModal');
if (closeCommentsModal) closeCommentsModal.onclick = () => document.getElementById('commentsModal').style.display = 'none';
window.onclick = (event) => {
    const modal = document.getElementById('commentsModal');
    if (event.target === modal) modal.style.display = 'none';
};

// Збереження події
const saveEventBtn = document.getElementById('saveEvent');
if (saveEventBtn) {
    saveEventBtn.onclick = async () => {
        const type = document.getElementById('eventType').value;
        const comment = document.getElementById('eventComment').value;
        if (!type) return showToast('Оберіть тип позначки');
        if (!selectedLatLng) return showToast('Спочатку клікніть на мапу, щоб обрати місце');
        if (!captchaPassed) {
            const captchaAnswer = document.getElementById('captchaAnswer').value.trim();
            if (parseInt(captchaAnswer) !== captchaValue) {
                showToast('Невірна відповідь капчі');
                generateCaptcha();
                return;
            }
            captchaPassed = true;
            localStorage.setItem('captchaPassed', 'true');
            hideCaptcha();
        }
        const nickname = nicknameInput ? (nicknameInput.value.trim() || 'Анонім') : 'Анонім';
        localStorage.setItem('nickname', nickname);
        try {
            const res = await fetch('/api/events', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    user_id: userId,
                    nickname,
                    event_type: parseInt(type),
                    lat: selectedLatLng.lat,
                    lng: selectedLatLng.lng,
                    comment: comment.slice(0, 200)
                })
            });
            if (!res.ok) throw new Error(await res.text());
            document.getElementById('eventModal').style.display = 'none';
            document.getElementById('eventComment').value = '';
            setTimeout(() => {
                loadEvents();
                setTimeout(() => loadEvents(), 1000);
            }, 300);
            showToast('✅ Позначку додано');
        } catch (err) {
            showToast('Помилка: ' + err.message);
        }
    };
}

// Редагування події
window.editEvent = async (eventId, oldComment) => {
    const newComment = prompt('Введіть новий коментар:', oldComment);
    if (newComment === null) return;
    if (newComment.length > 200) return showToast('Коментар занадто довгий');
    try {
        await fetch(`/api/events/${eventId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ user_id: userId, comment: newComment })
        });
        loadEvents();
        showToast('✅ Коментар оновлено');
    } catch (err) { showToast('Помилка: ' + err.message); }
};

// Видалення події
window.deleteEvent = async (eventId) => {
    if (!confirm('Видалити подію?')) return;
    try {
        await fetch(`/api/events/${eventId}`, {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ user_id: userId })
        });
        loadEvents();
        showToast('🗑️ Подію видалено');
    } catch (err) { showToast('Помилка: ' + err.message); }
};

// Скарга (заглушка)
window.reportEvent = (eventId) => showToast(`Скаргу на подію ${eventId} надіслано адміну.`);

// Пошук адреси
const searchInput = document.getElementById('search');
if (searchInput) {
    searchInput.addEventListener('keypress', async (e) => {
        if (e.key === 'Enter') {
            const query = searchInput.value.trim();
            if (!query) return;
            try {
                const response = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=1`);
                const data = await response.json();
                if (data.length > 0) {
                    const { lat, lon } = data[0];
                    map.setView([lat, lon], 15);
                } else {
                    showToast('Адресу не знайдено');
                }
            } catch (err) { showToast('Помилка пошуку'); }
        }
    });
}

// Геолокація
const geolocateBtn = document.getElementById('geolocateBtn');
if (geolocateBtn) {
    geolocateBtn.onclick = () => {
        if (!navigator.geolocation) {
            showToast('Геолокація не підтримується');
            return;
        }
        navigator.geolocation.getCurrentPosition(
            (position) => {
                map.setView([position.coords.latitude, position.coords.longitude], 15);
                showToast('Ви тут!');
            },
            () => showToast('Не вдалося визначити місце (потрібен HTTPS)')
        );
    };
}

// Сповіщення
function showToast(message, duration = 3000) {
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), duration);
}

// ===== Коментарі =====
let currentEventId = null;

window.openCommentsModal = async (eventId) => {
    currentEventId = eventId;
    const modal = document.getElementById('commentsModal');
    if (modal) {
        modal.style.display = 'flex';
        await loadCommentsToModal(eventId);
    }
};

async function loadCommentsToModal(eventId) {
    try {
        const res = await fetch(`/api/events/${eventId}/comments`);
        const comments = await res.json();
        const container = document.getElementById('commentsList');
        if (!container) return;
        if (comments.length === 0) {
            container.innerHTML = '<p>📭 Немає коментарів. Будьте першим!</p>';
        } else {
            container.innerHTML = comments.map(c => `
                <div class="comment-item" data-id="${c.id}">
                    <strong>${escapeHtml(c.nickname)}</strong>
                    <p>${escapeHtml(c.comment)}</p>
                    <small>📅 ${new Date(c.created_at).toLocaleString()}</small>
                    ${c.user_id === userId ? `
                        <div class="comment-actions">
                            <button onclick="editComment(${c.id}, '${escapeHtml(c.comment).replace(/'/g, "\\'")}')">✏️ Редагувати</button>
                            <button onclick="deleteComment(${c.id})">🗑️ Видалити</button>
                        </div>
                    ` : ''}
                </div>
            `).join('');
        }
    } catch (err) {
        showToast('Помилка завантаження коментарів');
    }
}

async function addComment() {
    const commentText = document.getElementById('newCommentText');
    const comment = commentText?.value.trim();
    if (!comment) return showToast('Введіть текст коментаря');
    if (comment.length > 200) return showToast('Коментар занадто довгий');
    try {
        const res = await fetch(`/api/events/${currentEventId}/comments`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ user_id: userId, comment: comment.slice(0, 200) })
        });
        if (res.ok) {
            commentText.value = '';
            await loadCommentsToModal(currentEventId);
            showToast('✅ Коментар додано');
        } else {
            const err = await res.json();
            showToast(err.error || 'Помилка додавання');
        }
    } catch (err) { showToast('Помилка мережі'); }
}

window.editComment = async (commentId, oldText) => {
    const newText = prompt('Редагувати коментар:', oldText);
    if (newText && newText.trim() && newText !== oldText) {
        if (newText.length > 200) return showToast('Коментар занадто довгий');
        try {
            const res = await fetch(`/api/comments/${commentId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ user_id: userId, comment: newText.trim() })
            });
            if (res.ok) {
                await loadCommentsToModal(currentEventId);
                showToast('✅ Коментар оновлено');
            } else {
                showToast('Помилка редагування');
            }
        } catch (err) { showToast('Помилка мережі'); }
    }
};

window.deleteComment = async (commentId) => {
    if (!confirm('Видалити коментар?')) return;
    try {
        const res = await fetch(`/api/comments/${commentId}`, {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ user_id: userId })
        });
        if (res.ok) {
            await loadCommentsToModal(currentEventId);
            showToast('🗑️ Коментар видалено');
        } else {
            showToast('Помилка видалення');
        }
    } catch (err) { showToast('Помилка мережі'); }
};

// Кнопка меню (бургер)
const menuToggle = document.getElementById('menuToggle');
const rightPanel = document.getElementById('right-panel');
if (menuToggle && rightPanel) {
    menuToggle.addEventListener('click', () => {
        rightPanel.classList.toggle('open');
    });
}

const submitCommentBtn = document.getElementById('submitCommentBtn');
if (submitCommentBtn) submitCommentBtn.onclick = addComment;

// Запуск мапи
if (typeof L !== 'undefined') {
    initMap();
    if (captchaPassed) hideCaptcha();
} else {
    console.error('Leaflet не завантажився');
}
