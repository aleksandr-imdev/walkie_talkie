const bcrypt = require('bcrypt');
const saltRounds = 10; // Уровень криптования

// Хэширование пароля
async function hashPassword(password) {
    const hashedPassword = await bcrypt.hash(password, saltRounds);
    return hashedPassword;
}

// Проверка пароля
async function verifyPassword(password, hashedPassword) {
    const match = await bcrypt.compare(password, hashedPassword);
    return match;
}

module.exports = {
    hashPassword,
    verifyPassword
};