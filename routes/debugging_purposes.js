const express = require('express');
const router = express.Router();

// Путь для отладки: доступен ТОЛЬКО в режиме разработки
router.get('/set-user', (req, res) => {
    if (process.env.NODE_ENV === 'production') {
        return res.status(403).send('Отладочные пути отключены в продакшене');
    }

    const { userId } = req.query;
    if (!userId) {
        return res.status(400).send('Отсутствует userId в параметрах');
    }

    const cookieOptions = { 
        httpOnly: true, 
        sameSite: 'lax',
        signed: Boolean(process.env.COOKIE_SECRET)
    };

    res.cookie('userId', userId, cookieOptions);
    res.send(`[Dev Mode] User ID установлен на ${userId}`);
});

module.exports = router;