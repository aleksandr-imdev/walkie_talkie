require('dotenv').config();
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

const PORT = Number(process.env.PORT) || 3000;
const COOKIE_SECRET = process.env.COOKIE_SECRET || undefined;

if (process.env.NODE_ENV === 'development') {
    // Подключаем Webpack HMR только в режиме разработки
    try {
        const webpack = require('webpack');
        const webpackConfig = require('./webpack.config.js');
        const webpackDevMiddleware = require('webpack-dev-middleware');
        const webpackHotMiddleware = require('webpack-hot-middleware');
        const compiler = webpack(webpackConfig);

        app.use(
            webpackDevMiddleware(compiler, {
                publicPath: webpackConfig.output.publicPath,
                stats: { colors: true },
            })
        );
        app.use(webpackHotMiddleware(compiler));
    } catch (e) {
        console.warn('Webpack dev middleware не подключен (запущен без dev-зависимостей):', e.message);
    }
}

// Статические файлы
app.use(express.static(__dirname + '/public'));

// Модуль для работы с куками (с поддержкой подписи)
app.use(cookieParser(COOKIE_SECRET));

// Маршруты
if (process.env.NODE_ENV !== 'production') {
    app.use('/debug', require('./routes/debugging_purposes'));
}
app.use('/api', userManager.checkIfAuthorizedMiddleware, require('./routes/api'));

// Шаблонизатор EJS
app.set('view engine', 'ejs');
app.set('views', __dirname + '/public');

process.on('uncaughtException', (e) => {
    console.error('Необработанное исключение:', e);
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Необработанное отклонение промиса:', reason);
    process.exit(1);
});

// Авторизация сокетов через cookie
io.use(async (socket, next) => {
    const req = socket.request;
    const rawCookies = cookie.parse(req.headers.cookie || '');
    
    let signedCookies = {};
    if (COOKIE_SECRET) {
        signedCookies = cookieParser.signedCookies(rawCookies, COOKIE_SECRET);
    }
    
    req.cookies = cookieParser.JSONCookies(rawCookies);
    req.signedCookies = signedCookies;

    try {
        const userId = await userManager.getUserIdByRequest(req);
        socket.userId = userId;
        next();
    } 
    catch (e) {
        console.error('Ошибка авторизации Socket.io:', e.message);
        next(new Error('Unauthorized'));
    }
});

io.use((socket, next) => {
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

// Страница создания эфира
app.get('/create', (req, res) => {
    res.sendFile(__dirname + '/public/html/create.html');
});

// Страница присоединения к эфиру
app.get('/join', (req, res) => {
    res.sendFile(__dirname + '/public/html/join.html');
});

// Страница прослушивания / участия в эфире
app.get('/stream/:id', async (req, res) => {
    try {
        const streamId = Number(req.params.id);
        if (!streamId) {
            return res.status(400).send('Некорректный ID эфира');
        }

        const [response] = await queries.getStreamInfoById(streamId);
        if (!response) {
            return res.status(404).send('Эфир не найден');
        }

        return res.render('html/stream', { 
            streamId: streamId, 
            name: response.name, 
            messageDuration: response.message_duration 
        });
    }
    catch (e) {
        console.error('Ошибка входа на эфир:', e);
        return res.status(500).send('Внутренняя ошибка сервера');
    }
});

// Запуск сервера после готовности медиа-сервера Mediasoup
async function startServer() {
    try {
        await communicationManager.setupMediasoup();
        server.listen(PORT, () => {
            console.log(`Сервер запущен на http://localhost:${PORT}`);
        });
    } 
    catch (e) {
        console.error('Ошибка при запуске Mediasoup и сервера:', e);
        process.exit(1);
    }
}

startServer();