const express = require('express');
const router = express.Router();

// Для отладки

// Путь для отладки: задаёт userId в куки
router.get('/set-user', (req, res) => {
    const { userId } = req.query; // Получаем userId из query-параметров
    if (!userId) {
        return res.status(400).send('Отсутствует userId в параметрах');
    }

    res.cookie('userId', userId, { httpOnly: true });
    res.send(`User ID задан на ${userId}`);
});

module.exports = router;