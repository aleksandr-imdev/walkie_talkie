const express = require('express');
const queries = require('../mysql');
const passmgr = require('../passmgr');
const router = express.Router();
router.use(express.json());
router.use(express.urlencoded({ extended: true }));

const userId = 1; // Получить id пользователя каким либо способом

router.get('/searchusers', async (req, res) => {
    try {
        if (req.query.query == "") res.json = "";
        else {
            const response = await queries.findUsersByName(req.query.query, userId);
            res.json(response);
        }
    }
    catch (e) {
        console.error("Ошибка поиска пользователей", e);
        res.status(500);
    }
});

router.get('/getsubs', async (req, res) => {
    try {
        const response = await queries.getUserSubscriptions(req.query.id);
        res.json(response);
    }
    catch (e) {
        console.error("Ошибка получения подписчиков", e);
        res.status(500);
    }
});

router.get('/searchstreams', async (req, res) => {
    try {
        const response = await queries.findStreamsByName(req.query.query);
        res.json(response);
    }
    catch (e) {
        console.error("Ошибка поиска эфиров", e);
        res.status(500);
    }
});

router.get('/getstreamparticipants', async (req, res) => {
    try {
        const response = await queries.getStreamParticipantsById(req.query.id);
        res.json(response);
    }
    catch (e) {
        console.error("Ошибка поиска эфиров", e);
        res.status(500);
    }
});

router.post('/joinstream/:id', async (req, res) => {
    const id = req.params.id;
    const password = req.body.password;

    try {
        const [response] = await queries.getStreamInfoById(id);
        if (response.password_hash == null) {
            res.redirect(`/stream/${id}`);
        }
        else {
            if (!password) {
                res.status(401).send('Введите пароль');
            }
            else if (await passmgr.verifyPassword(password, response.password_hash)) {
                res.redirect(`/stream/${id}`);
            }
            else {
                res.status(403).send('Неверный пароль');
            }
        }
    }
    catch (e) {
        console.error("Ошибка поиска эфиров", e);
        res.status(500);
    }
});

router.post('/startstream', async (req, res) => {
    const { streamname, stream_duration, voice_message_duration, isprivate, streampass, speaker_ids } = req.body;
    let speaker_array = JSON.parse(speaker_ids); // Преобразуем строку в массив

    // Проверка обязательных полей
    if (!streamname || !stream_duration || !voice_message_duration || !Array.isArray(speaker_array) || speaker_ids.length === 0 || isprivate === undefined) {
        res.status(400);
        return;
    }

    // Обработка пароля
    let passwordHash = null;
    if (isprivate && streampass) {
        passwordHash = await passmgr.hashPassword(streampass);
    }

    try {
        const streamId = await queries.createStream(streamname, passwordHash, voice_message_duration, speaker_array, userId, stream_duration);
        res.redirect(`/stream/${streamId}`);
    } 
    catch (e) {
        console.error('Ошибка создания стрима', e);
        res.status(500);
    }
});

module.exports = router;