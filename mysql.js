const mysql = require('mysql2');

// Данные для подключения к БД
const pool = mysql.createPool({
    host: 'localhost',
    user: 'root',
    password: 'root',
    database: 'walkie_talkie',
    waitForConnections: true,
    connectionLimit: 10, // Максимальное число соединений
    queueLimit: 10,
}).promise();

async function getUsernameById(userId) {
    const [rows] = await pool.execute(`SELECT username FROM users WHERE id = ?`, [userId]);
    return rows;
}

async function findUsersByName(substring, userId) {
    const [rows] = await pool.execute('SELECT id, username FROM users WHERE username LIKE ? AND id != ?', [`%${substring}%`, userId]);
    return rows;
}

async function getUserSubscriptions(subscribed_to_id) {
    const [rows] = await pool.execute('SELECT subscriber_id FROM subscriptions WHERE subscribed_to_id = ?', [subscribed_to_id]);
    return rows;
}

async function createStream(streamname, passwordHash, messageDuration, speakerIds, streamAdminId) {
    const connection = await pool.getConnection(); // Получаем соединение из пула

    try {
        // Начинаем транзакцию
        await connection.beginTransaction();

        // Создание эфира
        const [rows] = await connection.execute(
            `INSERT INTO streams (name, password_hash, message_duration)
            VALUES (?, ?, ?)`,
            [streamname, passwordHash, messageDuration]
        );
        const streamId = rows.insertId;

        // Создание события для отложенного удаления
        /*await connection.execute(
            `CREATE EVENT delete_stream_event_${streamId}
            ON SCHEDULE AT CURRENT_TIMESTAMP + INTERVAL ? HOUR
            DO DELETE FROM streams WHERE id = ?`,
            [streamDuration, streamId]
        );*/

        // Добавление администратора
        await connection.execute(
            `INSERT INTO participants_roles (stream_id, user_id, role) 
            VALUES (?, ?, ?)`, [streamId, streamAdminId, 'admin']
        );

        // Добавление модераторов
        if (Array.isArray(speakerIds) && speakerIds.length > 0) {
            const moderatorValues = speakerIds.map((id) => [streamId, id, 'moderator']);
            const sql = `INSERT INTO participants_roles (stream_id, user_id, role) VALUES (?, ?, ?)`;

            moderatorValues.forEach(async value => {
                await connection.execute(sql, value);
            });
        }

        // Фиксируем изменения
        await connection.commit();

        return streamId;
    } 
    catch (e) {
        // Если возникла ошибка, откатываем транзакцию
        await connection.rollback();
        console.log(e);
    } 
    finally {
        // Возвращаем соединение в пул
        connection.release();
    }
}

async function deleteStreamById(streamId) {
    await pool.execute('DELETE FROM streams WHERE id = ?', [streamId]);
}

async function findStreamsByName(substring) {
    const [rows] = await pool.execute('SELECT id, name FROM streams WHERE name LIKE ?', [`%${substring}%`]);
    return rows;
}

async function getStreamInfoById(streamId) {
    const [rows] = await pool.execute(`SELECT * FROM streams WHERE id = ?`, [streamId]);
    return rows;
}

async function getParticipantRoleByIds(streamId, userId) {
    const [rows] = await pool.execute(`SELECT role FROM participants_roles WHERE stream_id = ? AND user_id = ?`, [streamId, userId]);
    return rows;
}

async function setParticipantRoleByIds(streamId, userId, newRole) {
    const [rows] = await pool.execute(`UPDATE participants_roles SET role = ? WHERE stream_id = ? AND user_id = ?`, [newRole, streamId, userId]);
    return rows;
}

async function addStreamParticipantRoleByIds(streamId, userId, role) {
    const [rows] = await pool.execute(`INSERT IGNORE INTO participants_roles (stream_id, user_id, role) VALUES (?, ?, ?)`, [streamId, userId, role]);
    return rows;
}

async function addMessageToStreamById(streamId, userId, content, io = undefined) {
    const conn = await pool.getConnection(); // Получаем соединение из пула
    try {
        await conn.beginTransaction(); // Начинаем транзакцию

        // Получаем следующий message_number для streamId
        const [rows] = await conn.execute(
            `SELECT COALESCE(MAX(message_number), 0) + 1 AS next_message_number FROM messages WHERE stream_id = ?`,
            [streamId]
        );
        const nextMessageNumber = rows[0].next_message_number;

        // Добавляем сообщение
        await conn.execute(
            `INSERT IGNORE INTO messages (stream_id, message_number, user_id, content) VALUES (?, ?, ?, ?)`,
            [streamId, nextMessageNumber, userId, content]
        );

        await conn.commit(); // Завершаем транзакцию
    } 
    catch (e) {
        await conn.rollback(); // В случае ошибки откатываем транзакцию
        console.log(e);
    } 
    finally {
        conn.release(); // Освобождаем соединение

        // После завершения транзакции отправляем сообщение в эфир
        if (io) {
            io.to(streamId).emit('new-message', content);
        }
    }
}

async function getMessagesByStreamId(streamId) {
    const [rows] = await pool.execute(`SELECT * FROM messages WHERE stream_id = ? ORDER BY message_number ASC`, [streamId]);
    return rows;
}

module.exports = {
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