const mysql = require('mysql2');

// Данные для подключения к БД
const pool = mysql.createPool({
    host: 'localhost',
    user: 'root',
    password: 'root',
    database: 'walkie_talkie',
    waitForConnections: true,
    connectionLimit: 10, // Максимальное число запросов
    queueLimit: 10,
}).promise();

async function findUsersByName(substring, userId) {
    const [rows] = await pool.execute('SELECT id, username FROM users WHERE username LIKE ? AND id != ?', [`%${substring}%`, userId]);
    return rows;
}

async function getUserSubscriptions(subscribed_to_id) {
    const [rows] = await pool.execute('SELECT subscriber_id FROM subscriptions WHERE subscribed_to_id = ?', [`${subscribed_to_id}`]);
    return rows;
}

async function createStream(streamname, passwordHash, messageDuration, speakerIds, streamAdminId, streamDuration) {
    // Создание эфира
    const [rows] = await pool.execute(
        `INSERT INTO streams (name, password_hash, message_duration, end_time)
        VALUES (?, ?, ?, DATE_ADD(NOW(), INTERVAL ? HOUR))`,
        [
            streamname, passwordHash, messageDuration, streamDuration
        ]
    );
    const streamId = rows.insertId;

    // Добавление администратора
    await pool.execute(
        `INSERT INTO stream_participants (stream_id, user_id, role) VALUES (?, ?, ?)`,
        [streamId, streamAdminId, 'admin']
    );

    // Добавление модераторов
    if (Array.isArray(speakerIds) && speakerIds.length > 0) {
        const moderatorValues = speakerIds.map((id) => [streamId, id]);
        for (const moderator of moderatorValues) {
            await pool.execute(
                `INSERT INTO stream_participants (stream_id, user_id, role) VALUES (?, ?, ?)`,
                [moderator[0], moderator[1], 'moderator']
            )
        }
    }
    
    return streamId;
}

async function findStreamsByName(substring) {
    const [rows] = await pool.execute('SELECT id, name FROM streams WHERE name LIKE ?', [`%${substring}%`]);
    return rows;
}

async function getStreamInfoById(streamId) {
    const [rows] = await pool.execute(`SELECT * FROM streams WHERE id = ?`, [`${streamId}`]);
    return rows;
}

async function getStreamParticipantsById(streamId) {
    const [rows] = await pool.execute(`SELECT stream_participants.user_id, users.username FROM stream_participants JOIN users ON stream_participants.user_id = users.id WHERE stream_id = ?`, [`${streamId}`]);
    return rows;
}

module.exports = {
    findUsersByName,
    getUserSubscriptions,
    createStream,
    findStreamsByName,
    getStreamInfoById,
    getStreamParticipantsById
};

/*
Расписание удаление эфиров
CREATE EVENT delete_expired_records
ON SCHEDULE EVERY 1 HOUR
DO
DELETE FROM streams WHERE NOW() > end_time;
*/