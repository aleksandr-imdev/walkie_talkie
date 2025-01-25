const express = require('express');
const queries = require('../mysql');
const passmgr = require('../passmgr');
const usermgr = require('../usermgr');
const router = express.Router();
router.use(express.json());
router.use(express.urlencoded({ extended: true }));

router.get('/searchusers', async (req, res) => {
    try {
        const userId = await usermgr.getUserIdByRequest(req);

        if (req.query.query == "") res.json = "";
        else {
            const response = await queries.findUsersByName(req.query.query, userId);
            res.json(response);
        }
    }
    catch (e) {
        console.log("Ошибка поиска пользователей", e);
        res.status(500).end();
    }
});

router.get('/getsubs', async (req, res) => {
    try {
        const userId = await usermgr.getUserIdByRequest(req);
        const response = await queries.getUserSubscriptions(userId);
        res.json(response);
    }
    catch (e) {
        console.log("Ошибка получения подписчиков", e);
        res.status(500).end();
    }
});

router.get('/searchstreams', async (req, res) => {
    try {
        const response = await queries.findStreamsByName(req.query.query);
        res.json(response);
    }
    catch (e) {
        console.log("Ошибка поиска эфиров", e);
        res.status(500).end();
    }
});

router.post('/joinstream/:id', async (req, res) => {
    const id = req.params.id;
    const password = req.body.password;

    try {
        const userId = await usermgr.getUserIdByRequest(req);

        const [response] = await queries.getStreamInfoById(id);
        if (response.password_hash == null) {
            await queries.addStreamParticipantRoleByIds(id, userId, 'listener');
            res.redirect(`/stream/${id}`);
        }
        else {
            if (!password) {
                res.status(401).send('Введите пароль');
            }
            else if (await passmgr.verifyPassword(password, response.password_hash)) {
                await queries.addStreamParticipantRoleByIds(id, userId, 'listener');
                res.redirect(`/stream/${id}`);
            }
            else {
                res.status(403).send('Неверный пароль');
            }
        }
    }
    catch (e) {
        console.log("Ошибка поиска эфиров", e);
        res.status(500).end();
    }
});

router.post('/startstream', async (req, res) => {
    const userId = await usermgr.getUserIdByRequest(req);
    
    const { streamname, voice_message_duration, isprivate, streampass, speaker_ids } = req.body;
    let speaker_array;

    try {
        speaker_array = JSON.parse(speaker_ids); // Преобразуем строку в массив
    }
    catch(e) {
        console.log('Ошибка создания эфира', e);
        res.status(500).end();
    }

    // Проверка обязательных полей
    if (!streamname || !voice_message_duration || !Array.isArray(speaker_array) || typeof speaker_ids !== 'string' || speaker_ids.length === 0 || isprivate === undefined) {
        res.status(400).end();
    }

    // Обработка пароля
    let passwordHash = null;
    if (isprivate && streampass) {
        passwordHash = await passmgr.hashPassword(streampass);
    }

    try {
        const streamId = await queries.createStream(streamname, passwordHash, voice_message_duration, speaker_array, userId);

        const [response] = await queries.getUsernameById(userId);
        await queries.addMessageToStreamById(streamId, userId, `Пользователь ${response.username} создал эфир`);

        res.redirect(`/stream/${streamId}`);
    } 
    catch (e) {
        console.log('Ошибка создания эфира', e);
        res.status(500).end();
    }
});

module.exports = router;