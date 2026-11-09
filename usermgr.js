/**
 * Модуль управления авторизацией и пользователями
 */

// Получить ID пользователя из запроса
async function getUserIdByRequest(req) {
    const userId = (req.signedCookies && req.signedCookies.userId) || (req.cookies && req.cookies.userId);
    if (!userId) {
        throw new Error('Пользователь не авторизован');
    }
    return Number(userId);
}

// Middleware для проверки авторизации
async function checkIfAuthorizedMiddleware(req, res, next) {
    try {
        const userId = await getUserIdByRequest(req);
        req.userId = userId;
        next();
    } 
    catch (e) {
        if (req.accepts('html') && !req.path.startsWith('/api')) {
            return res.status(401).redirect('/?unauthorized=true');
        }
        return res.status(401).json({ error: 'Требуется авторизация' });
    }
}

module.exports = {
    checkIfAuthorizedMiddleware,
    getUserIdByRequest
};