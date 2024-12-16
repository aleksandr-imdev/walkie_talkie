const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const cookieParser = require('cookie-parser');
const queries = require('./mysql');
const socketHandler = require('./sockethandler');

const app = express();
const server = http.createServer(app);
const io = socketIO(server);

const PORT = 3000;

// Подключаем статические файлы (например, HTML, CSS)
app.use(express.static(__dirname + '/public'));
// Подключаем модуль для работы с cookies
app.use(cookieParser());
// Подключаем дополнительные маршруты
app.use('/debug', require('./routes/debugging_purposes'));
app.use('/api', require('./routes/api'));
// Устанавливаем движок шаблонов EJS
app.set('view engine', 'ejs');
app.set('views', __dirname + '/public');

// Обработчик для сокетов
io.on('connection', (socket) => {
    socketHandler(io, socket);
});

// Главная страница
app.get('/', (req, res) => {
    res.sendFile(__dirname + '/public/index.html');
});

// Создать эфир
app.get('/create', (req, res) => {
    res.sendFile(__dirname + '/public/create.html');
});

// Присоединиться к эфиру
app.get('/join', (req, res) => {
    res.sendFile(__dirname + '/public/join.html');
});

// Нахождение в эфире
app.get('/stream/:id', async (req, res) => {
    const streamId = req.params.id;
    const [response] = await queries.getStreamInfoById(streamId);
    res.render('stream', { streamId: streamId, name: response.name, messageDuration: response.message_duration });
});

server.listen(PORT, () => {
    console.log(`Сервер запущен на http://localhost:${PORT}`);
});