const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const cookieParser = require('cookie-parser');
const cookie = require('cookie');
const queries = require('./mysql');
const communicationManager = require('./commmgr');
const userManager = require('./usermgr');

const app = express();
const server = http.createServer(app);
const io = socketIO(server);

const PORT = 3000;

if (process.env.NODE_ENV === 'development') {
    // ТОЛЬКО ДЛЯ РАЗРАБОТКИ
    const webpack = require('webpack');
    const webpackConfig = require('./webpack.config.js');
    const webpackDevMiddleware = require('webpack-dev-middleware');
    const webpackHotMiddleware = require('webpack-hot-middleware');
    // Подключаем middleware для Webpack
    const compiler = webpack(webpackConfig);
    app.use(
        webpackDevMiddleware(compiler, {
            publicPath: webpackConfig.output.publicPath, // Указываем публичный путь
            stats: { colors: true },
        })
    );
    app.use(webpackHotMiddleware(compiler));
}

// Подключаем статические файлы
app.use(express.static(__dirname + '/public'));
// Подключаем модуль для работы с cookies
app.use(cookieParser());
// Подключаем дополнительные маршруты
app.use('/debug', require('./routes/debugging_purposes'));
app.use('/api', userManager.checkIfAuthorizedMiddleware, require('./routes/api'));
// Устанавливаем движок шаблонов EJS
app.set('view engine', 'ejs');
app.set('views', __dirname + '/public');

process.on('uncaughtException', (e) => {
    console.error('Необработанное исключение:', e);

    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Необработанное отклонение промиса:', reason);
    console.error('Промис:', promise);

    process.exit(1);
});

// Обработчик для сокетов
io.use(async (socket, next) => { // ТОЛЬКО ДЛЯ РАЗРАБОТКИ
    const req = socket.request;

    // Преобразуем куки из строки в объект
    const cookies = cookieParser.JSONCookies(
        cookie.parse(req.headers.cookie || '')
    );

    // Добавляем `cookies` в `req`, чтобы использовать getUserIdByRequest
    req.cookies = cookies;

    try {
        const userId = await userManager.getUserIdByRequest(req);
        socket.userId = userId;
        next();
    } 
    catch (e) {
        console.error('Ошибка авторизации:', e);
        next(new Error('Unauthorized'));
    }
});
io.use((socket, next)  => {
    if (!io.sockets.adapter.customData) {
        io.sockets.adapter.customData = {};
    }
    next();
});
io.on('connection', (socket) => {
    communicationManager(io, socket);
});

// Главная страница
app.get('/', (req, res) => {
    res.sendFile(__dirname + '/public/html/index.html');
});

// Создать эфир
app.get('/create', (req, res) => {
    res.sendFile(__dirname + '/public/html/create.html');
});

// Присоединиться к эфиру
app.get('/join', (req, res) => {
    res.sendFile(__dirname + '/public/html/join.html');
});

// Нахождение в эфире
app.get('/stream/:id', async (req, res) => {
    try {
        const streamId = req.params.id;
        const [response] = await queries.getStreamInfoById(streamId);
        if (typeof response === 'undefined') {
            res.status(404).end();
        }
        res.render('html/stream', { streamId: streamId, name: response.name, messageDuration: response.message_duration });
    }
    catch (e) {
        res.status(500).end();
        console.log('Ошибка входа на эфир', e);
    }
});

server.listen(PORT, () => {
    console.log(`Сервер запущен на http://localhost:${PORT}`);
});