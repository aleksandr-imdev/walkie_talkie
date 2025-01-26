import * as mediasoupClient from 'mediasoup-client';
import { io } from 'socket.io-client'

const socket = io();

const talkButton = document.getElementById('talk-button');
const joinButton = document.getElementById('join-button');
const endStreamButton = document.getElementById('end-stream-button');
const userList = document.getElementById('user-list');
const remoteAudio = document.getElementById('remote-audio');
const messageList = document.getElementById('message-list');
const seeUserListButton = document.getElementById('see-user-list');
const statusMessageElement = document.getElementById('status-message');

let isModerator = false;
let isAllowedToPlay = false;
let isTalking = false;
let device = new mediasoupClient.Device();
let sendTransport = null;
let recvTransport = null;
let producer = null;
let consumer = null;
let localStream = null;
let localTrack = null;

let remainingTime = null;
let lastUpdateTime = null;
let talkingInterval = null; // Храним ID интервала

// Для вывода сообщений через сокет
function getCurrentTimestamp() {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');

    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}     

function updateTalkingMessage() {
    const currentTime = Date.now();
    const elapsedTime = (currentTime - lastUpdateTime) / 1000; // Время, прошедшее с последнего обновления
    remainingTime = Math.max(0, remainingTime - elapsedTime); // Вычитаем прошедшее время
    lastUpdateTime = currentTime;

    statusMessageElement.innerText = `Говорите! Осталось ${remainingTime.toFixed(1)}с`;

    if (remainingTime <= 0) {
        stopTalking();
    }
}

joinButton.addEventListener('click', async (event) => {
    socket.emit('start-listening', streamId);
    event.target.remove();
    isAllowedToPlay = true;
});

endStreamButton.addEventListener('click', () => {
    socket.emit('end-stream', streamId);
});

socket.on('connect', () => {
    socket.emit('join-room', streamId);
});
socket.on('room-joined', () => {
    socket.emit('get-stream-messages', streamId);
    socket.emit('get-stream-participants', streamId);

    socket.emit('get-rtp-capabilities');
});

socket.on('rtp-capabilities', async (routerRtpCapabilities) => {
    try {
        if (!device.loaded) {
            await device.load(routerRtpCapabilities);
        }
        socket.emit('get-transports');
    } 
    catch (e) {
        console.error('Ошибка загрузки mediasoup-device: ', e);
    }
});

socket.on('transport-created', async (transportData) => {
    // Создаём транспорты
    sendTransport = device.createSendTransport(transportData.sendTransport);
    console.log('Send Transport создан');

    sendTransport.on('produce', async (parameters, callback, errback) => {
        try {
            socket.emit('produce', streamId, parameters, ({ id }) => {
                callback({ id });
            });
        } 
        catch (e) {
            errback(e);
        }
    });
    sendTransport.on('connect', ({ dtlsParameters }, callback, errback) => {
        try {
            console.log('Send Transport подключается');
            socket.emit('transport-connect', { type: 'send', dtlsParameters });
            callback();
        }
        catch (e) {
            errback(e);
        }
    });

    recvTransport = device.createRecvTransport(transportData.recvTransport);
    console.log('Recv Transport создан');

    recvTransport.on('consume', async (parameters, callback, errback) => {
        try {
            socket.emit('consume', parameters, ({ id, kind, producerId }) => {
                callback({ id, kind, producerId });
            });
        } 
        catch (e) {
            errback(e);
        }
    });
    recvTransport.on('connect', ({ dtlsParameters }, callback, errback) => {
        try {
            console.log('Recv Transport подключается');
            socket.emit('transport-connect', { type: 'recv', dtlsParameters });
            callback();
        }
        catch (e) {
            errback(e);
        }
    });
});

// Обработка кнопки "говорить"
talkButton.addEventListener('click', () => {
    if (!isModerator) {
        console.warn('У вас нет права говорить');
        return;
    }

    if (!isTalking) {
        startTalking();
    } 
    else {
        stopTalking();
    }
});

// Начать говорить
async function startTalking() {
    if (!streamId) {
        alert("Сначала зайдите в эфир");
        return;
    }

    if (isTalking) return;

    try {
        if (!localStream) {
            localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
            localTrack = localStream.getAudioTracks()[0];
        }

        // Добавляем трек в транспорт
        producer = await sendTransport.produce({ track: localTrack });
        console.log('Передача началась');

        socket.emit('start-talking', streamId, producer.id);
        isTalking = true;
        statusMessageElement.innerText = 'Говорите';

        remainingTime = messageDuration;
        lastUpdateTime = Date.now();
        talkingInterval = setInterval(updateTalkingMessage, 100);
    } 
    catch (e) {
        console.error('Ошибка получения доступа к микрофону:', e);
        statusMessageElement.innerText = 'Нет доступа к микрофону';
    }
}

// Закончить говорить
function stopTalking() {
    if (!isTalking) return;
    if (!localStream) return;
    if (!localTrack) return;

    localTrack.stop();
    localStream = null;
    producer.close();

    socket.emit('stop-talking', streamId);
    isTalking = false;

    statusMessageElement.innerText = '';
    
    if (talkingInterval) {
        clearInterval(talkingInterval); // Очищаем интервал
        talkingInterval = null;
    }
}

socket.on('users-amount', (usersAmount) => {
    seeUserListButton.innerText = `${usersAmount} online`;
    // Обновляем список участников
    socket.emit('get-stream-participants', streamId);
});

socket.on('stream-participants', async (users) => {
    userList.innerHTML = '';

    // Вывод на страницу
    users.forEach(user => {
        const li = document.createElement('li');

        li.innerText = user.username;
        const allowSpeakBtn = document.createElement('button');
        allowSpeakBtn.innerText = 'Дать говорить';
        allowSpeakBtn.className = 'change-role-btn';
        allowSpeakBtn.disabled = !isModerator;
        allowSpeakBtn.onclick = () => socket.emit('update-role', streamId, user.userId, 'moderator');
        const muteBtn = document.createElement('button');
        muteBtn.innerText = 'Заглушить';
        muteBtn.className = 'change-role-btn';
        muteBtn.disabled = !isModerator;
        muteBtn.onclick = () => socket.emit('update-role', streamId, user.userId, 'listener');
        const kickBtn = document.createElement('button');
        kickBtn.innerText = 'Выгнать';
        kickBtn.className = 'change-role-btn';
        kickBtn.disabled = !isModerator;
        kickBtn.onclick = () => socket.emit('update-role', streamId, user.userId, 'kick');
        const banBtn = document.createElement('button');
        banBtn.innerText = 'Забанить';
        banBtn.className = 'change-role-btn';
        banBtn.disabled = !isModerator;
        banBtn.onclick = () => socket.emit('update-role', streamId, user.userId, 'banned');

        li.appendChild(allowSpeakBtn);
        li.appendChild(muteBtn);
        li.appendChild(kickBtn);
        li.appendChild(banBtn);

        userList.appendChild(li);
    });
});

socket.on('stream-messages', async (messages) => {
    messageList.innerHTML = '';

    // Вывод на страницу
    messages.forEach(message => {
        const li = document.createElement('li');

        li.innerText = `${message.created_at} ${message.content}`;
        messageList.appendChild(li);
    });
});

socket.on('new-message', (content) => {
    const li = document.createElement('li');

    li.innerText = `${getCurrentTimestamp()} ${content}`;
    messageList.appendChild(li);
});

socket.on('role-updated', (newRole) => {
    if (newRole === 'kick') {
        document.body.innerHTML = 'Вас выгнали с эфира';
        isModerator = false;
    }
    else if (newRole === 'banned') {
        document.body.innerHTML = 'Вы забанены на эфире';
        isModerator = false;
    }
    else if (newRole === 'listener') {
        talkButton.disabled = true;

        const changeRoleBtns = Array.from(document.getElementsByClassName('change-role-btn'));
        changeRoleBtns.forEach(button => {
            button.disabled = true;
        });

        isModerator = false;
        stopTalking();
    }
    else if (['moderator', 'admin'].includes(newRole)) {
        talkButton.disabled = false;

        const changeRoleBtns = Array.from(document.getElementsByClassName('change-role-btn'));
        changeRoleBtns.forEach(button => {
            button.disabled = false;
        });

        isModerator = true;
    }
    endStreamButton.style.display = newRole == 'admin' ? '' : 'none';
});

socket.on('stream-ended', () => {
    document.body.innerHTML = 'Эфир завершён';
});

socket.on('time-is-up', () => {
    stopTalking();
});

socket.on('speaking-user', async (username, producerId) => {
    if (username && producerId && isAllowedToPlay) {
        statusMessageElement.innerText = `Говорит ${username}`;

        const { id, kind, rtpParameters } = await new Promise((resolve) => {
            socket.emit('consume', { producerId }, resolve);
        });

        consumer = await recvTransport.consume({
            id,
            producerId,
            kind,
            rtpParameters,
            rtpCapabilities: device.rtpCapabilities,
        });

        const stream = new MediaStream();
        stream.addTrack(consumer.track);

        remoteAudio.srcObject = stream;
        await remoteAudio.play().catch((error) => {
            console.error('Ошибка воспроизведения:', error);
        });
    }
    else {
        statusMessageElement.innerText = '';
        
        if (consumer) {
            consumer.close();
            consumer = null;
            remoteAudio.srcObject = null;
        }
    }
});

socket.on('already-speaking', () => {
    alert('Кто-то уже говорит');
    stopTalking();
});

socket.on('error', (message) => {
    alert(`Ошибка - ${message}. Страница будет перезагружена`);
    location.reload();
});

socket.on('warn', (message) => {
    console.warn(message);
    stopTalking();
});