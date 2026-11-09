require('dotenv').config();
const mysql = require('mysql2');

// Данные для подключения к БД из переменных окружения
const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD !== undefined ? process.env.DB_PASSWORD : 'root',
    database: process.env.DB_NAME || 'walkie_talkie',
    waitForConnections: true,
    connectionLimit: Number(process.env.DB_CONNECTION_LIMIT) || 10,
    queueLimit: 0,
}).promise();

async function getUsernameById(userId) {
    const [rows] = await pool.execute(`SELECT username FROM users WHERE id = ?`, [userId]);
    return rows;
}

async function findUsersByName(substring, userId) {
    const [rows] = await pool.execute(
        'SELECT id, username FROM users WHERE username LIKE ? AND id != ?',
        [`%${substring}%`, userId]
    );
    return rows;
}

async function getUserSubscriptions(subscribed_to_id) {
    const [rows] = await pool.execute(
        'SELECT subscriber_id FROM subscriptions WHERE subscribed_to_id = ?',
        [subscribed_to_id]
    );
    return rows;
}

async function createStream(streamname, passwordHash, messageDuration, speakerIds, streamAdminId) {
    const connection = await pool.getConnection();

    try {
        await connection.beginTransaction();

        // Создание эфира
        const [rows] = await connection.execute(
            `INSERT INTO streams (name, password_hash, message_duration) VALUES (?, ?, ?)`,
            [streamname, passwordHash, messageDuration]
        );
        const streamId = rows.insertId;

        // Добавление администратора
        await connection.execute(
            `INSERT INTO participants_roles (stream_id, user_id, role) VALUES (?, ?, 'admin')`,
            [streamId, streamAdminId]
        );

        // Добавление модераторов последовательно внутри транзакции
        if (Array.isArray(speakerIds) && speakerIds.length > 0) {
            for (const speakerId of speakerIds) {
                if (speakerId && speakerId !== streamAdminId) {
                    await connection.execute(
                        `INSERT IGNORE INTO participants_roles (stream_id, user_id, role) VALUES (?, ?, 'moderator')`,
                        [streamId, speakerId]
                    );
                }
            }
        }

        // Фиксируем изменения
        await connection.commit();
        return streamId;
    } 
    catch (e) {
        await connection.rollback();
        console.error('Ошибка создания эфира в БД:', e);
        throw e;
    } 
    finally {
        connection.release();
    }
}

async function deleteStreamById(streamId) {
    await pool.execute('DELETE FROM streams WHERE id = ?', [streamId]);
}

async function findStreamsByName(substring) {
    const [rows] = await pool.execute(
        'SELECT id, name FROM streams WHERE name LIKE ?',
        [`%${substring}%`]
    );
    return rows;
}

async function getStreamInfoById(streamId) {
    const [rows] = await pool.execute(`SELECT * FROM streams WHERE id = ?`, [streamId]);
    return rows;
}

async function getParticipantRoleByIds(streamId, userId) {
    const [rows] = await pool.execute(
        `SELECT role FROM participants_roles WHERE stream_id = ? AND user_id = ?`,
        [streamId, userId]
    );
    return rows;
}

async function setParticipantRoleByIds(streamId, userId, newRole) {
    const [rows] = await pool.execute(
        `UPDATE participants_roles SET role = ? WHERE stream_id = ? AND user_id = ?`,
        [newRole, streamId, userId]
    );
    return rows;
}

async function addStreamParticipantRoleByIds(streamId, userId, role) {
    const [rows] = await pool.execute(
        `INSERT IGNORE INTO participants_roles (stream_id, user_id, role) VALUES (?, ?, ?)`,
        [streamId, userId, role]
    );
    return rows;
}

async function addMessageToStreamById(streamId, userId, content, io = undefined) {
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();

        // FOR UPDATE блокирует чтение до завершения транзакции, предотвращая дубликаты
        const [rows] = await conn.execute(
            `SELECT COALESCE(MAX(message_number), 0) + 1 AS next_message_number FROM messages WHERE stream_id = ? FOR UPDATE`,
            [streamId]
        );
        const nextMessageNumber = rows[0].next_message_number;

        await conn.execute(
            `INSERT INTO messages (stream_id, message_number, user_id, content) VALUES (?, ?, ?, ?)`,
            [streamId, nextMessageNumber, userId, content]
        );

        await conn.commit();

        // Оповещаем участников только ПОСЛЕ успешной фиксации транзакции
        if (io) {
            io.to(streamId).emit('new-message', content);
        }

        return nextMessageNumber;
    } 
    catch (e) {
        await conn.rollback();
        console.error('Ошибка добавления сообщения в БД:', e);
        throw e;
    } 
    finally {
        conn.release();
    }
}

async function getMessagesByStreamId(streamId) {
    const [rows] = await pool.execute(
        `SELECT * FROM messages WHERE stream_id = ? ORDER BY message_number ASC`,
        [streamId]
    );
    return rows;
}

module.exports = {
    pool,
    getUsernameById,
    findUsersByName,
    getUserSubscriptions,
    createStream,
    deleteStreamById,
    findStreamsByName,
    getStreamInfoById,
    getParticipantRoleByIds,
    setParticipantRoleByIds,
    addStreamParticipantRoleByIds,
    addMessageToStreamById,
    getMessagesByStreamId
};