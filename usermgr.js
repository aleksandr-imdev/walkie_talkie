// Проверить, авторизован ли пользователь
async function checkIfAuthorizedMiddleware(req, res, next) {
    next();
}

// Получить id пользователя
async function getUserIdByRequest(req) {
    const userId = req.cookies.userId;
    if (!userId) {
        throw new Error('Пользователь не авторизован');
    }
    return userId;
}

module.exports = {
    checkIfAuthorizedMiddleware,
    getUserIdByRequest
}