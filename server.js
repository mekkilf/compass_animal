const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const crypto = require('crypto');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(express.static('public'));

// Rate limiter (на основі IP, в пам'яті)
const rateLimit = new Map();
app.use((req, res, next) => {
    const ip = req.ip;
    const now = Date.now();
    const windowMs = 10 * 60 * 1000;
    const maxRequests = 50;
    if (!rateLimit.has(ip)) rateLimit.set(ip, []);
    const requests = rateLimit.get(ip).filter(t => now - t < windowMs);
    if (requests.length >= maxRequests) {
        return res.status(429).json({ error: 'Забагато запитів. Зачекайте.' });
    }
    requests.push(now);
    rateLimit.set(ip, requests);
    next();
});

// Підключення до SQLite
const db = new sqlite3.Database('./savelifemap.db', (err) => {
    if (err) console.error('❌ Помилка БД:', err);
    else console.log('✅ SQLite підключено');
});

// Створення таблиць (без зберігання IP)
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        nickname TEXT NOT NULL DEFAULT 'Анонім',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        banned_until DATETIME
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        event_type INTEGER NOT NULL,
        lat REAL NOT NULL,
        lng REAL NOT NULL,
        comment TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        expires_at DATETIME,
        city TEXT DEFAULT 'kyiv',
        FOREIGN KEY(user_id) REFERENCES users(id)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS comments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id INTEGER NOT NULL,
        user_id TEXT NOT NULL,
        comment TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(event_id) REFERENCES events(id),
        FOREIGN KEY(user_id) REFERENCES users(id)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        target_type TEXT NOT NULL,
        target_id INTEGER NOT NULL,
        reporter_user_id TEXT NOT NULL,
        reporter_ip TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        resolved BOOLEAN DEFAULT 0
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS admin_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        admin_user TEXT NOT NULL,
        action TEXT NOT NULL,
        ip TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
});

// Функція часу життя події для 7 типів
function getExpiresAt(eventType) {
    const now = new Date();
    switch (parseInt(eventType)) {
        case 3: // Жвавий трафік - обережно!
            return new Date(now.getTime() + 4 * 24 * 60 * 60 * 1000);
        case 5: // Возз'єднання
        case 7: // На жаль, не врятували
            return new Date(now.getTime() + 5 * 60 * 60 * 1000);
        default: // 1,2,4,6
            return new Date(now.getTime() + 1 * 60 * 60 * 1000);
    }
}

// Адмін токен (з .env)
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
if (!ADMIN_TOKEN) {
    console.error('❌ Помилка: ADMIN_TOKEN не задано в .env');
    process.exit(1);
}
const ADMIN_TOKEN_HASH = crypto.createHash('sha256').update(ADMIN_TOKEN).digest('hex');
function isAdmin(req, res, next) {
    const token = req.headers['x-admin-token'];
    if (!token) return res.status(401).json({ error: 'Не авторизовано' });
    const hash = crypto.createHash('sha256').update(token).digest('hex');
    if (hash !== ADMIN_TOKEN_HASH) return res.status(403).json({ error: 'Невірний токен' });
    next();
}
function logAdminAction(adminUser, action, ip) {
    db.run('INSERT INTO admin_logs (admin_user, action, ip) VALUES (?, ?, ?)', [adminUser, action, ip]);
}

// ========== ПУБЛІЧНІ МАРШРУТИ ==========

// Отримати події в межах видимої області
app.get('/api/events', (req, res) => {
    const { bounds } = req.query;
    if (!bounds) return res.status(400).json({ error: 'bounds required' });
    const [minLat, minLng, maxLat, maxLng] = bounds.split(',').map(Number);
    const query = `
        SELECT e.*, u.nickname,
               CASE WHEN e.expires_at > datetime('now') THEN 1 ELSE 0 END as active
        FROM events e
        JOIN users u ON e.user_id = u.id
        WHERE e.lat BETWEEN ? AND ? AND e.lng BETWEEN ? AND ?
          AND (u.banned_until IS NULL OR u.banned_until < datetime('now'))
    `;
    db.all(query, [minLat, maxLat, minLng, maxLng], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// Додати подію (з лімітом 10 за 10 годин)
app.post('/api/events', (req, res) => {
    const { user_id, nickname, event_type, lat, lng, comment } = req.body;
    if (!user_id || !event_type || !lat || !lng) {
        return res.status(400).json({ error: 'Не всі поля заповнені' });
    }
    db.get('SELECT banned_until FROM users WHERE id = ?', [user_id], (err, user) => {
        if (err) return res.status(500).json({ error: err.message });
        if (user && user.banned_until && new Date(user.banned_until) > new Date()) {
            return res.status(403).json({ error: 'Ваш аккаунт заблоковано' });
        }
        db.get(`SELECT COUNT(*) as count FROM events 
                WHERE user_id = ? AND created_at > datetime('now', '-10 hours')`, [user_id], (err, row) => {
            if (err) return res.status(500).json({ error: err.message });
            if (row.count >= 10) {
                return res.status(429).json({ error: 'Ліміт: не більше 10 подій за 10 годин' });
            }
            db.run(`INSERT OR REPLACE INTO users (id, nickname) VALUES (?, ?)`,
                [user_id, (nickname || 'Анонім').slice(0, 30)], function(err) {
                if (err) return res.status(500).json({ error: err.message });
                const expires_at = getExpiresAt(event_type).toISOString();
                db.run(`INSERT INTO events (user_id, event_type, lat, lng, comment, expires_at)
                        VALUES (?, ?, ?, ?, ?, ?)`,
                    [user_id, event_type, lat, lng, (comment || '').slice(0, 200), expires_at], function(err) {
                    if (err) return res.status(500).json({ error: err.message });
                    res.status(201).json({ id: this.lastID });
                });
            });
        });
    });
});

// Редагувати коментар події
app.put('/api/events/:id', (req, res) => {
    const { user_id, comment } = req.body;
    db.get('SELECT user_id FROM events WHERE id = ?', [req.params.id], (err, event) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!event) return res.status(404).json({ error: 'Подію не знайдено' });
        if (event.user_id !== user_id) return res.status(403).json({ error: 'Не автор' });
        db.run('UPDATE events SET comment = ? WHERE id = ?', [(comment || '').slice(0, 200), req.params.id], function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true });
        });
    });
});

// Видалити подію
app.delete('/api/events/:id', (req, res) => {
    const { user_id } = req.body;
    db.get('SELECT user_id FROM events WHERE id = ?', [req.params.id], (err, event) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!event) return res.status(404).json({ error: 'Подію не знайдено' });
        if (event.user_id !== user_id) return res.status(403).json({ error: 'Не автор' });
        db.run('DELETE FROM events WHERE id = ?', [req.params.id], function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true });
        });
    });
});

// Отримати коментарі до події
app.get('/api/events/:id/comments', (req, res) => {
    db.all(`
        SELECT c.*, u.nickname FROM comments c
        JOIN users u ON c.user_id = u.id
        WHERE c.event_id = ? ORDER BY c.created_at
    `, [req.params.id], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// Додати коментар (ліміт 10 на подію)
app.post('/api/events/:id/comments', (req, res) => {
    const { user_id, comment } = req.body;
    if (!comment || comment.trim() === '') {
        return res.status(400).json({ error: 'Коментар не може бути порожнім' });
    }
    db.get(`SELECT COUNT(*) as count FROM comments WHERE event_id = ? AND user_id = ?`, [req.params.id, user_id], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (row.count >= 10) {
            return res.status(429).json({ error: 'Ліміт: не більше 10 коментарів на подію' });
        }
        db.run(`INSERT INTO comments (event_id, user_id, comment) VALUES (?, ?, ?)`,
            [req.params.id, user_id, comment.slice(0, 200)], function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.status(201).json({ id: this.lastID });
        });
    });
});

// Редагувати коментар
app.put('/api/comments/:id', (req, res) => {
    const { user_id, comment } = req.body;
    db.get('SELECT user_id FROM comments WHERE id = ?', [req.params.id], (err, comm) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!comm) return res.status(404).json({ error: 'Коментар не знайдено' });
        if (comm.user_id !== user_id) return res.status(403).json({ error: 'Не автор' });
        db.run('UPDATE comments SET comment = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
            [comment.slice(0, 200), req.params.id], function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true });
        });
    });
});

// Видалити коментар
app.delete('/api/comments/:id', (req, res) => {
    const { user_id } = req.body;
    db.get('SELECT user_id FROM comments WHERE id = ?', [req.params.id], (err, comm) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!comm) return res.status(404).json({ error: 'Коментар не знайдено' });
        if (comm.user_id !== user_id) return res.status(403).json({ error: 'Не автор' });
        db.run('DELETE FROM comments WHERE id = ?', [req.params.id], function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true });
        });
    });
});

// Скарга на подію або коментар
app.post('/api/report', (req, res) => {
    const { user_id, target_type, target_id } = req.body;
    const ip = req.ip;
    db.run(`INSERT INTO reports (target_type, target_id, reporter_user_id, reporter_ip) VALUES (?, ?, ?, ?)`,
        [target_type, target_id, user_id, ip], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.status(201).json({ success: true });
    });
});

// Оновлення нікнейму
app.put('/api/users/nickname', (req, res) => {
    const { user_id, nickname } = req.body;
    db.run('UPDATE users SET nickname = ? WHERE id = ?', [nickname.slice(0, 30), user_id], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

// ========== АДМІН-МАРШРУТИ ==========

app.get('/admin/api/events', isAdmin, (req, res) => {
    db.all('SELECT * FROM events ORDER BY created_at DESC', (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.delete('/admin/api/events/:id', isAdmin, (req, res) => {
    const adminIp = req.ip;
    db.run('DELETE FROM events WHERE id = ?', [req.params.id], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        logAdminAction('admin', `Видалено подію ${req.params.id}`, adminIp);
        res.json({ success: true });
    });
});

app.get('/admin/api/comments', isAdmin, (req, res) => {
    db.all('SELECT * FROM comments ORDER BY created_at DESC', (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.delete('/admin/api/comments/:id', isAdmin, (req, res) => {
    const adminIp = req.ip;
    db.run('DELETE FROM comments WHERE id = ?', [req.params.id], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        logAdminAction('admin', `Видалено коментар ${req.params.id}`, adminIp);
        res.json({ success: true });
    });
});

app.get('/admin/api/reports', isAdmin, (req, res) => {
    db.all('SELECT * FROM reports ORDER BY created_at DESC', (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.post('/admin/api/reports/:id/resolve', isAdmin, (req, res) => {
    const adminIp = req.ip;
    db.run('UPDATE reports SET resolved = 1 WHERE id = ?', [req.params.id], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        logAdminAction('admin', `Вирішено скаргу ${req.params.id}`, adminIp);
        res.json({ success: true });
    });
});

app.post('/admin/api/ban', isAdmin, (req, res) => {
    const { user_id, days } = req.body;
    const adminIp = req.ip;
    const bannedUntil = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
    db.run('UPDATE users SET banned_until = ? WHERE id = ?', [bannedUntil, user_id], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        logAdminAction('admin', `Заблоковано користувача ${user_id} на ${days} днів`, adminIp);
        res.json({ success: true });
    });
});

app.get('/admin/api/logs', isAdmin, (req, res) => {
    db.all('SELECT * FROM admin_logs ORDER BY created_at DESC LIMIT 500', (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.get('/admin/api/stats', isAdmin, (req, res) => {
    db.get('SELECT COUNT(*) as total_events FROM events', (err, events) => {
        if (err) return res.status(500).json({ error: err.message });
        db.get('SELECT COUNT(*) as total_comments FROM comments', (err, comments) => {
            if (err) return res.status(500).json({ error: err.message });
            db.get('SELECT COUNT(*) as pending_reports FROM reports WHERE resolved = 0', (err, reports) => {
                if (err) return res.status(500).json({ error: err.message });
                db.get('SELECT COUNT(*) as active_events FROM events WHERE expires_at > datetime("now")', (err, active) => {
                    if (err) return res.status(500).json({ error: err.message });
                    res.json({
                        total_events: events.total_events,
                        total_comments: comments.total_comments,
                        pending_reports: reports.pending_reports,
                        active_events: active.active_events
                    });
                });
            });
        });
    });
});

app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ========== АВТОМАТИЧНЕ ВИДАЛЕННЯ ЗАСТАРІЛИХ ПОДІЙ ==========
setInterval(() => {
    db.run(`DELETE FROM events WHERE expires_at < datetime('now')`, function(err) {
        if (err) {
            console.error('❌ Помилка автовидалення:', err.message);
        } else if (this.changes > 0) {
            console.log(`🧹 Автовидалено ${this.changes} застарілих подій.`);
        }
    });
}, 30 * 60 * 1000); // кожні 30 хвилин

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server on http://localhost:${PORT}`));
