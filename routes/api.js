const express = require('express');
const queries = require('../mysql');
const passmgr = require('../passmgr');
const usermgr = require('../usermgr');

const router = express.Router();
router.use(express.json());
router.use(express.urlencoded({ extended: true }));

// Поиск пользователей по подстроке
router.get('/searchusers', async (req, res) => {
    try {
        const userId = await usermgr.getUserIdByRequest(req);
        const query = (req.query.query || '').trim();

        if (!query) {
            return res.json([]);
        }

        const response = await queries.findUsersByName(query, userId);
        return res.json(response);
    }
    catch (e) {
        console.error("Ошибка поиска пользователей:", e);
        return res.status(500).json({ error: 'Ошибка поиска пользователей' });
    }
});

// Получение подписок пользователя
router.get('/getsubs', async (req, res) => {
    try {
        const userId = await usermgr.getUserIdByRequest(req);
        const response = await queries.getUserSubscriptions(userId);
        return res.json(response);
    }
    catch (e) {
        console.error("Ошибка получения подписчиков:", e);
        return res.status(500).json({ error: 'Ошибка получения подписчиков' });
    }
});

// Поиск эфиров по имени
router.get('/searchstreams', async (req, res) => {
    try {
        const query = (req.query.query || '').trim();
        if (!query) {
            return res.json([]);
        }

        const response = await queries.findStreamsByName(query);
        return res.json(response);
    }
    catch (e) {
        console.error("Ошибка поиска эфиров:", e);
        return res.status(500).json({ error: 'Ошибка поиска эфиров' });
    }
});

// Подключение к эфиру с проверкой пароля
router.post('/joinstream/:id', async (req, res) => {
    const id = Number(req.params.id);
    const password = req.body.password;

    try {
        const userId = await usermgr.getUserIdByRequest(req);
        const [response] = await queries.getStreamInfoById(id);

        if (!response) {
            return res.status(404).send('Эфир не найден');
        }

        // Если эфир публичный (без пароля)
        if (response.password_hash == null) {
            await queries.addStreamParticipantRoleByIds(id, userId, 'listener');
            return res.redirect(`/stream/${id}`);
        }

        // Если эфир закрытый
        if (!password) {
            return res.status(401).send('Введите пароль');
        }

        const isMatch = await passmgr.verifyPassword(password, response.password_hash);
        if (isMatch) {
            await queries.addStreamParticipantRoleByIds(id, userId, 'listener');
            return res.redirect(`/stream/${id}`);
        } 
        else {
            return res.status(403).send('Неверный пароль');
        }
    }
    catch (e) {
        console.error("Ошибка входа в эфир:", e);
        return res.status(500).send('Внутренняя ошибка сервера при входе в эфир');
    }
});

// Создание нового эфира
router.post('/startstream', async (req, res) => {
    try {
        const userId = await usermgr.getUserIdByRequest(req);
        const { streamname, voice_message_duration, isprivate, streampass, speaker_ids } = req.body;

        let speaker_array = [];
        if (speaker_ids) {
            try {
                speaker_array = typeof speaker_ids === 'string' ? JSON.parse(speaker_ids) : speaker_ids;
            } 
            catch (e) {
                console.error('Ошибка парсинга speaker_ids:', e);
                return res.status(400).send('Некорректный формат списка спикеров');
            }
        }

        // Проверка обязательных полей
        if (!streamname || !voice_message_duration || !Array.isArray(speaker_array) || isprivate === undefined) {
            return res.status(400).send('Заполнены не все обязательные поля');
        }

        // Хеширование пароля при наличии
        let passwordHash = null;
        if (Number(isprivate) === 1 && streampass) {
            passwordHash = await passmgr.hashPassword(streampass);
        }

        const streamId = await queries.createStream(
            streamname,
            passwordHash,
            Number(voice_message_duration),
            speaker_array,
            userId
        );

        const [user] = await queries.getUsernameById(userId);
        const username = user ? user.username : 'Пользователь';
        await queries.addMessageToStreamById(streamId, userId, `Пользователь ${username} создал эфир`);

        return res.redirect(`/stream/${streamId}`);
    } 
    catch (e) {
        console.error('Ошибка создания эфира:', e);
        return res.status(500).send('Ошибка создания эфира на сервере');
    }
});

module.exports = router;