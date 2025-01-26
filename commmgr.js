const mediasoup = require('mediasoup');
const queries = require('./mysql');

// Конфигурация
const mediasoupOptions = {
    // Настройки Worker
    worker: {
        logLevel: 'warn',
        rtcMinPort: 10000,
        rtcMaxPort: 20000,
    },
    router: {
        mediaCodecs: [
            {
                kind: 'audio',
                mimeType: 'audio/opus',
                clockRate: 48000,
                channels: 2,
            },
        ],
    },
};

// Объекты mediasoup
let worker, router;

// Запускаем Mediasoup
async function setupMediasoup() {
    worker = await mediasoup.createWorker(mediasoupOptions.worker);
    router = await worker.createRouter({ mediaCodecs: mediasoupOptions.router.mediaCodecs });
}
setupMediasoup().then(() => console.log('Mediasoup запущен'));

const validateSocketInRoom = (socket, handler) => {
    return async (...args) => {
        try {
            const room = args[0]; // Предполагаем, что первым аргументом всегда будет имя комнаты
            const rooms = Array.from(socket.rooms);

            if (!rooms.includes(room)) {
                console.log(`Сокет ${socket.id} не состоит в комнате ${room}, хотя вызвал обработчик для неё`);
                socket.emit('warn', 'Вы не состоите в данной комнате.');
                return;
            }

            // Если сокет состоит в комнате, вызываем обработчик
            await handler(...args);
        } 
        catch (e) {
            console.error('Ошибка в validateSocketInRoom:', e);
            socket.emit('error', 'Произошла ошибка при обработке запроса.');
        }
    };
};

module.exports = (io, socket) => {
    socket.on('join-room', async (room) => {
        try {
            let [response] = await queries.getParticipantRoleByIds(room, socket.userId);
            socket.role = response.role;

            [response] = await queries.getUsernameById(socket.userId);
            socket.username = response.username;

            socket.emit('role-updated', socket.role);
            if (socket.role === 'banned') {
                socket.disconnect();
                return;
            }

            socket.join(room);
            console.log(`Пользователь ${socket.id} зашёл в комнату ${room}`);

            // Отправляем сообщение, что пользователь зашёл
            await queries.addMessageToStreamById(room, socket.userId, `Участник ${response.username} зашёл`, io);

            // Создаём метаданные комнаты
            if (!io.sockets.adapter.customData[room]) {
                [response] = await queries.getStreamInfoById(room);
                io.sockets.adapter.customData[room] = {
                    messageDuration: response.message_duration,
                    currentSpeakerId: null,
                    currentSpeakerUsername: null,
                    timerId: null,
                    producer: null,
                };
            }

            // Устанавливаем количество участников
            const participantsAmount = io.sockets.adapter.rooms.get(room)?.size || 0;
            io.to(room).emit('users-amount', participantsAmount);

            socket.emit('room-joined');
        } 
        catch (e) {
            console.log('Ошибка join-room:', e);
            socket.emit('error', 'Ошибка подключения к комнате');
        }
    });

    socket.on('start-listening', validateSocketInRoom(socket, (room) => {
        try {
            const roomData = io.sockets.adapter.customData[room];
            socket.emit('speaking-user', roomData.currentSpeakerUsername, roomData.producer?.id);
        }
        catch (e) {
            console.log('Ошибка start-listening:', e);
            socket.emit('warn', 'Ошибка первичной отправки данных о говорящем');
        }
    }));

    // Пользователь начинает говорить
    socket.on('start-talking', validateSocketInRoom(socket, async (room, producerId) => {
        try {
            if (!['admin', 'moderator'].includes(socket.role)) {
                socket.emit('warn', 'Нет прав на говорение');
                return;
            }

            const roomData = io.sockets.adapter.customData[room];
            if (roomData.currentSpeakerId) {
                socket.emit('already-speaking');
                return;
            }

            socket.broadcast.to(room).emit('speaking-user', socket.username, producerId);
            roomData.currentSpeakerId = socket.userId;
            roomData.currentSpeakerUsername = socket.username;

            roomData.timer = setTimeout(() => {
                socket.emit('time-is-up');
                socket.broadcast.to(room).emit('speaking-user', null, null);

                roomData.timer = null;
                roomData.currentSpeakerId = null;
                roomData.currentSpeakerUsername = null;

                const producer = roomData.producer;
                if (producer) {
                    roomData.producer.close();
                    roomData.producer = null;
                }
            }, roomData.messageDuration * 1000);

            // Пишем в историю сообщений
            await queries.addMessageToStreamById(room, socket.userId, `Участник ${socket.username} оставил сообщение`, io);
        } 
        catch (e) {
            console.log('Ошибка start-talking:', e);
            socket.emit('warn', 'Ошибка при попытке говорить');
        }
    }));

    // Пользователь прекращает говорить
    socket.on('stop-talking', validateSocketInRoom(socket, async (room) => {
        try {
            const roomData = io.sockets.adapter.customData[room];

            if (roomData.currentSpeakerId === socket.userId) {
                roomData.currentSpeakerId = null;
                socket.broadcast.to(room).emit('speaking-user', null, null);

                clearTimeout(roomData.timer);
                roomData.timer = null;

                roomData.producer?.close();
                roomData.producer = null;
            }
        }
        catch (e) {
            console.log('Ошибка stop-talking:', e);
            socket.emit('warn', 'Ошибка при завершении говорения');
        }
    }));

    socket.on('get-rtp-capabilities', () => {
        try {
            socket.emit('rtp-capabilities', {
                routerRtpCapabilities: router.rtpCapabilities,
            });
        }
        catch (e) {
            console.log('Ошибка get-rtp-capabilities:', e);
            socket.emit('error', 'Ошибка получения rtpCapabilites');
        }
    });
    
    socket.on('get-transports', async () => {
        try {
            // Создаем два транспорта: один для отправки, другой для получения
            const sendTransport = await router.createWebRtcTransport({
                listenIps: [{ip: '0.0.0.0', announcedIp: '5.35.92.106'}],
                enableUdp: true,
                enableTcp: true,
                preferUdp: true,
                iceServers: [
                    { urls: 'stun:stun.l.google.com:19302' },
                    {
                        urls: 'turn:openrelay.metered.ca:80',
                        username: 'openrelayproject',
                        credential: 'openrelayproject'
                    }
                ]
            });
            const recvTransport = await router.createWebRtcTransport({
                listenIps: [{ip: '0.0.0.0', announcedIp: '5.35.92.106'}],
                enableUdp: true,
                enableTcp: true,
                preferUdp: true,
                iceServers: [
                    { urls: 'stun:stun.l.google.com:19302' },
                    {
                        urls: 'turn:openrelay.metered.ca:80',
                        username: 'openrelayproject',
                        credential: 'openrelayproject'
                    }
                ]
            });

            socket.sendTransport = sendTransport;
            socket.recvTransport = recvTransport;

            console.log(`Send Transport для ${socket.id} создан:`, sendTransport.id);
            console.log(`Recv Transport для ${socket.id} создан:`, recvTransport.id);

            socket.emit('transport-created', {
                sendTransport: {
                    id: sendTransport.id,
                    iceParameters: sendTransport.iceParameters,
                    iceCandidates: sendTransport.iceCandidates,
                    dtlsParameters: sendTransport.dtlsParameters,
                    sctpParameters: sendTransport.sctpParameters,
                },
                recvTransport: {
                    id: recvTransport.id,
                    iceParameters: recvTransport.iceParameters,
                    iceCandidates: recvTransport.iceCandidates,
                    dtlsParameters: recvTransport.dtlsParameters,
                    sctpParameters: recvTransport.sctpParameters,
                },
            });
        }
        catch (e) {
            console.log('Ошибка get-transports:', e);
            socket.emit('error', 'Ошибка получения транспортов');
        }
    });

    socket.on('transport-connect', async ({ type, dtlsParameters }) => {
        try {
            if (type === 'send') {
                await socket.sendTransport.connect({ dtlsParameters });
                console.log('sendTransport подключен');
            } 
            else if (type === 'recv') {
                await socket.recvTransport.connect({ dtlsParameters });
                console.log('recvTransport подключен');
            }
        } 
        catch (e) {
            console.log('Ошибка transport-connect:', e);
            socket.emit('error', 'Ошибка при подключении транспорта');
        }
    });

    socket.on('produce', validateSocketInRoom(socket, async (room, parameters, callback) => {
        try {
            const roomData = io.sockets.adapter.customData[room];

            const producer = await socket.sendTransport.produce(parameters);
            roomData.producer = producer;
            callback({ id: producer.id });

            producer.on('transportclose', () => {
                roomData.producer = null;
            });

            producer.on('producerclose', () => {
                roomData.producer = null;
            });
        } 
        catch (e) {
            console.log('Ошибка produce:', e);
            socket.emit('error', 'Ошибка при создании продюсера');
        }
    }));  

    socket.on('consume', async ({ producerId }, callback) => {
        try {
            if (!router.canConsume({
                producerId,
                rtpCapabilities: router.rtpCapabilities,
            })) {
                throw new Error('Невозможно потреблять поток с указанными rtpCapabilities');
            }

            const consumer = await socket.recvTransport.consume({
                producerId,
                rtpCapabilities: router.rtpCapabilities,
                paused: true,
            });

            socket.consumer = consumer;

            consumer.on('transportclose', () => {
                consumer.close();
            });

            consumer.on('producerclose', () => {
                consumer.close();
            });

            callback({
                id: consumer.id,
                producerId: producerId,
                kind: consumer.kind,
                rtpParameters: consumer.rtpParameters,
            });
            consumer.resume();
        }
        catch (e) {
            console.log('Ошибка consume:', e);
            socket.emit('error', 'Ошибка создания consumer');
        }
    });

    socket.on('get-stream-participants', validateSocketInRoom(socket, async (room) => {
        try {
            const sockets = await io.in(room).fetchSockets();
            const participants = [];

            sockets.forEach(socket => {
                participants.push({
                    userId: socket.userId,
                    username: socket.username,
                });
            });
            socket.emit('stream-participants', participants);
        } 
        catch (e) {
            console.log('Ошибка get-stream-participants:', e);
            socket.emit('error', 'Ошибка получения участников эфира');
        }
    }));

    socket.on('get-stream-messages', validateSocketInRoom(socket, async (room) => {
        try {
            const messages = await queries.getMessagesByStreamId(room);
            socket.emit('stream-messages', messages);
        } 
        catch (e) {
            console.log('Ошибка get-stream-messages:', e);
            socket.emit('error', 'Ошибка получения сообщений');
        }
    }));

    socket.on('end-stream', validateSocketInRoom(socket, async (room) => {
        try {
            if (socket.role === 'admin') {
                io.to(room).emit('stream-ended');
                const sockets = await io.in(room).fetchSockets();

                sockets.forEach(socket => {
                    socket.disconnect();
                });

                queries.deleteStreamById(room);
                delete io.sockets.adapter.customData[room];
            }
            else {
                socket.emit('warn', 'Нет права завершать эфир');
            }
        } 
        catch (e) {
            console.log("Ошибка end-stream", e);
            socket.emit('error', 'Ошибка завершения эфира');
        }
    }));

    socket.on('update-role', validateSocketInRoom(socket, async (room, targetId, newRole) => {
        try {
            console.log(`Обновление роли для ${targetId} в комнате ${room} на ${newRole}`);

            if (!['moderator', 'listener', 'kick', 'banned'].includes(newRole)) {
                socket.emit('warn', 'Некорректная роль');
                return;
            }

            if (!['admin', 'moderator'].includes(socket.role)) {
                socket.emit('warn', 'Нет прав на обновление роли');
                return;
            }

            // Найти сокет с указанным targetId и room
            const targetSocket = [...io.sockets.sockets.values()].find(s => 
                s.userId === targetId && s.rooms.has(room)
            );

            if (!targetSocket) {
                socket.emit('warn', 'Пользователь не найден');
                return;
            }

            if (targetSocket.id === socket.id) {
                socket.emit('warn', 'Нельзя менять роль себе');
                return;
            }

            // Обновить роль пользователя
            targetSocket.role = newRole;
            targetSocket.emit('role-updated', newRole);

            const roomData = io.sockets.adapter.customData[room];

            if (newRole !== 'moderator' && roomData.currentSpeakerId === targetSocket.userId) {
                roomData.producer?.close();
                roomData.producer = null;
                socket.broadcast.to(room).emit('speaking-user', null, null);
            }
            
            if (newRole === 'banned') {
                targetSocket.disconnect();

                if (targetSocket.recvTransport) targetSocket.recvTransport.close();
                if (targetSocket.sendTransport) targetSocket.sendTransport.close();

                await queries.addMessageToStreamById(room, socket.userId, `Участник ${targetSocket.username} был забанен`, io);
                return;
            }
            if (newRole === 'kick') {
                targetSocket.disconnect();

                if (targetSocket.recvTransport) targetSocket.recvTransport.close();
                if (targetSocket.sendTransport) targetSocket.sendTransport.close();

                await queries.addMessageToStreamById(room, socket.userId, `Участник ${targetSocket.username} был исключён`, io);
                return;
            }

            await queries.setParticipantRoleByIds(room, targetId, newRole);
        }
        catch(e) {
            console.log("Ошибка update-role", e);
            socket.emit('error', 'Ошибка обновления роли');
        }
    }));

    socket.on('disconnecting', async () => {
        try {
            const rooms = Array.from(socket.rooms).filter((room) => room !== socket.id);
        
            for (const room of rooms) {
                const roomData = io.sockets.adapter.customData[room];
                if (roomData.currentSpeakerId === socket.userId) {
                    roomData.currentSpeakerId = null;
                    socket.broadcast.to(room).emit('speaking-user', null, null);

                    roomData.producer?.close();
                    roomData.producer = null;

                    clearTimeout(roomData.timer);
                    roomData.timer = null;
                }
                
                // Закрываем транспорты
                if (socket.sendTransport) socket.sendTransport.close();
                if (socket.recvTransport) socket.recvTransport.close();

                console.log(`Пользователь ${socket.id} вышел из комнаты ${room}`);
                socket.leave(room);

                // Отправляем сообщение, что пользователь вышел
                await queries.addMessageToStreamById(room, socket.userId, `Участник ${socket.username} вышел`, io);
        
                const participantsAmount = io.sockets.adapter.rooms.get(room)?.size || 0;
                io.to(room).emit('users-amount', participantsAmount);
            }
        }
        catch (e) {
            console.log('Ошибка disconnecting:', e);
        }
    });
}