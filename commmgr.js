require('dotenv').config();
const mediasoup = require('mediasoup');
const queries = require('./mysql');

// Конфигурация Mediasoup
const mediasoupOptions = {
    worker: {
        logLevel: process.env.MEDIASOUP_LOG_LEVEL || 'warn',
        rtcMinPort: Number(process.env.RTC_MIN_PORT) || 10000,
        rtcMaxPort: Number(process.env.RTC_MAX_PORT) || 20000,
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

// Запуск Mediasoup
async function setupMediasoup() {
    if (worker && router) return router;

    worker = await mediasoup.createWorker(mediasoupOptions.worker);
    worker.on('died', () => {
        console.error('Критическая ошибка: Mediasoup Worker завершил работу. Перезапуск процесса...');
        process.exit(1);
    });

    router = await worker.createRouter({ mediaCodecs: mediasoupOptions.router.mediaCodecs });
    console.log('Mediasoup Worker и Router успешно запущены');
    return router;
}

// Запуск при старте
setupMediasoup().catch(e => {
    console.error('Ошибка инициализации Mediasoup:', e);
});

// Middleware проверки нахождения сокета в комнате
const validateSocketInRoom = (socket, handler) => {
    return async (...args) => {
        try {
            const room = String(args[0]);
            const rooms = Array.from(socket.rooms);

            if (!rooms.includes(room)) {
                console.warn(`Сокет ${socket.id} не состоит в комнате ${room}`);
                socket.emit('warn', 'Вы не состоите в данной комнате.');
                return;
            }

            await handler(...args);
        } 
        catch (e) {
            console.error('Ошибка в validateSocketInRoom:', e);
            socket.emit('error', 'Произошла ошибка при обработке запроса.');
        }
    };
};

const communicationManager = (io, socket) => {
    socket.on('join-room', async (room) => {
        try {
            const roomId = Number(room);
            let [response] = await queries.getParticipantRoleByIds(roomId, socket.userId);
            
            if (!response) {
                // Если роли нет, по умолчанию слушатель
                await queries.addStreamParticipantRoleByIds(roomId, socket.userId, 'listener');
                socket.role = 'listener';
            } else {
                socket.role = response.role;
            }

            [response] = await queries.getUsernameById(socket.userId);
            socket.username = response ? response.username : `User_${socket.userId}`;

            socket.emit('role-updated', socket.role);
            if (socket.role === 'banned') {
                socket.emit('warn', 'Вы заблокированы в этом эфире');
                socket.disconnect(true);
                return;
            }

            const roomStr = String(roomId);
            socket.join(roomStr);
            console.log(`Пользователь ${socket.username} (${socket.id}) вошел в комнату ${roomStr}`);

            // Создаём метаданные комнаты в памяти, если их еще нет
            if (!io.sockets.adapter.customData) {
                io.sockets.adapter.customData = {};
            }
            if (!io.sockets.adapter.customData[roomStr]) {
                const [streamInfo] = await queries.getStreamInfoById(roomId);
                io.sockets.adapter.customData[roomStr] = {
                    messageDuration: streamInfo ? streamInfo.message_duration : 10,
                    currentSpeakerId: null,
                    currentSpeakerUsername: null,
                    timer: null,
                    producer: null,
                };
            }

            // Уведомляем комнату об изменении количества участников
            const participantsAmount = io.sockets.adapter.rooms.get(roomStr)?.size || 0;
            io.to(roomStr).emit('users-amount', participantsAmount);

            socket.emit('room-joined');
        } 
        catch (e) {
            console.error('Ошибка join-room:', e);
            socket.emit('error', 'Ошибка подключения к комнате');
        }
    });

    socket.on('start-listening', validateSocketInRoom(socket, (room) => {
        try {
            const roomData = io.sockets.adapter.customData ? io.sockets.adapter.customData[room] : null;
            if (roomData) {
                socket.emit('speaking-user', roomData.currentSpeakerUsername, roomData.producer?.id);
            }
        }
        catch (e) {
            console.error('Ошибка start-listening:', e);
            socket.emit('warn', 'Ошибка первичной отправки данных о говорящем');
        }
    }));

    // Пользователь начинает говорить (Push-to-Talk)
    socket.on('start-talking', validateSocketInRoom(socket, async (room, producerId) => {
        try {
            if (!['admin', 'moderator'].includes(socket.role)) {
                socket.emit('warn', 'Нет прав на говорение');
                return;
            }

            const roomData = io.sockets.adapter.customData[room];
            if (!roomData) return;

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

                if (roomData.producer) {
                    try { roomData.producer.close(); } catch (_) {}
                    roomData.producer = null;
                }
            }, roomData.messageDuration * 1000);

            // Пишем в историю сообщений эфира
            await queries.addMessageToStreamById(
                Number(room),
                socket.userId,
                `Участник ${socket.username} оставил голосовое сообщение`,
                io
            );
        } 
        catch (e) {
            console.error('Ошибка start-talking:', e);
            socket.emit('warn', 'Ошибка при попытке говорить');
        }
    }));

    // Пользователь отпустил кнопку "говорить"
    socket.on('stop-talking', validateSocketInRoom(socket, async (room) => {
        try {
            const roomData = io.sockets.adapter.customData ? io.sockets.adapter.customData[room] : null;
            if (!roomData) return;

            if (roomData.currentSpeakerId === socket.userId) {
                roomData.currentSpeakerId = null;
                roomData.currentSpeakerUsername = null;
                socket.broadcast.to(room).emit('speaking-user', null, null);

                if (roomData.timer) {
                    clearTimeout(roomData.timer);
                    roomData.timer = null;
                }

                if (roomData.producer) {
                    try { roomData.producer.close(); } catch (_) {}
                    roomData.producer = null;
                }
            }
        }
        catch (e) {
            console.error('Ошибка stop-talking:', e);
            socket.emit('warn', 'Ошибка при завершении говорения');
        }
    }));

    socket.on('get-rtp-capabilities', async () => {
        try {
            if (!router) {
                await setupMediasoup();
            }
            socket.emit('rtp-capabilities', {
                routerRtpCapabilities: router.rtpCapabilities,
            });
        }
        catch (e) {
            console.error('Ошибка get-rtp-capabilities:', e);
            socket.emit('error', 'Ошибка получения rtpCapabilities');
        }
    });
    
    socket.on('get-transports', async () => {
        try {
            if (!router) {
                await setupMediasoup();
            }

            const announcedIp = process.env.ANNOUNCED_IP || '127.0.0.1';
            const iceServers = [
                { urls: process.env.STUN_SERVER || 'stun:stun.l.google.com:19302' },
            ];
            if (process.env.TURN_SERVER && process.env.TURN_USERNAME) {
                iceServers.push({
                    urls: process.env.TURN_SERVER,
                    username: process.env.TURN_USERNAME,
                    credential: process.env.TURN_CREDENTIAL || '',
                });
            }

            const transportOptions = {
                listenIps: [{ ip: '0.0.0.0', announcedIp }],
                enableUdp: true,
                enableTcp: true,
                preferUdp: true,
                iceServers,
            };

            const sendTransport = await router.createWebRtcTransport(transportOptions);
            const recvTransport = await router.createWebRtcTransport(transportOptions);

            socket.sendTransport = sendTransport;
            socket.recvTransport = recvTransport;

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
            console.error('Ошибка get-transports:', e);
            socket.emit('error', 'Ошибка создания транспортов');
        }
    });

    socket.on('transport-connect', async ({ type, dtlsParameters }) => {
        try {
            if (type === 'send' && socket.sendTransport) {
                await socket.sendTransport.connect({ dtlsParameters });
            } 
            else if (type === 'recv' && socket.recvTransport) {
                await socket.recvTransport.connect({ dtlsParameters });
            }
        } 
        catch (e) {
            console.error('Ошибка transport-connect:', e);
            socket.emit('error', 'Ошибка при подключении транспорта');
        }
    });

    socket.on('produce', validateSocketInRoom(socket, async (room, parameters, callback) => {
        try {
            const roomData = io.sockets.adapter.customData[room];
            if (!socket.sendTransport) {
                throw new Error('sendTransport не инициализирован');
            }

            const producer = await socket.sendTransport.produce(parameters);
            if (roomData) {
                roomData.producer = producer;
            }

            if (typeof callback === 'function') {
                callback({ id: producer.id });
            }

            producer.on('transportclose', () => {
                if (roomData && roomData.producer?.id === producer.id) {
                    roomData.producer = null;
                }
            });

            producer.on('producerclose', () => {
                if (roomData && roomData.producer?.id === producer.id) {
                    roomData.producer = null;
                }
            });
        } 
        catch (e) {
            console.error('Ошибка produce:', e);
            socket.emit('error', 'Ошибка при создании продюсера');
        }
    }));  

    socket.on('consume', async ({ producerId }, callback) => {
        try {
            if (!router) await setupMediasoup();

            if (!router.canConsume({
                producerId,
                rtpCapabilities: router.rtpCapabilities,
            })) {
                throw new Error('Невозможно воспроизвести аудиопоток (rtpCapabilities несовместимы)');
            }

            if (!socket.recvTransport) {
                throw new Error('recvTransport не инициализирован');
            }

            const consumer = await socket.recvTransport.consume({
                producerId,
                rtpCapabilities: router.rtpCapabilities,
                paused: true,
            });

            socket.consumer = consumer;

            consumer.on('transportclose', () => {
                try { consumer.close(); } catch (_) {}
            });

            consumer.on('producerclose', () => {
                try { consumer.close(); } catch (_) {}
            });

            if (typeof callback === 'function') {
                callback({
                    id: consumer.id,
                    producerId: producerId,
                    kind: consumer.kind,
                    rtpParameters: consumer.rtpParameters,
                });
            }
            consumer.resume();
        }
        catch (e) {
            console.error('Ошибка consume:', e);
            socket.emit('error', 'Ошибка создания consumer');
        }
    });

    socket.on('get-stream-participants', validateSocketInRoom(socket, async (room) => {
        try {
            const socketsInRoom = await io.in(room).fetchSockets();
            const participants = socketsInRoom.map(s => ({
                userId: s.userId,
                username: s.username || `User_${s.userId}`,
            }));
            socket.emit('stream-participants', participants);
        } 
        catch (e) {
            console.error('Ошибка get-stream-participants:', e);
            socket.emit('error', 'Ошибка получения участников эфира');
        }
    }));

    socket.on('get-stream-messages', validateSocketInRoom(socket, async (room) => {
        try {
            const messages = await queries.getMessagesByStreamId(Number(room));
            socket.emit('stream-messages', messages);
        } 
        catch (e) {
            console.error('Ошибка get-stream-messages:', e);
            socket.emit('error', 'Ошибка получения сообщений');
        }
    }));

    socket.on('end-stream', validateSocketInRoom(socket, async (room) => {
        try {
            if (socket.role === 'admin') {
                io.to(room).emit('stream-ended');
                const socketsInRoom = await io.in(room).fetchSockets();

                for (const s of socketsInRoom) {
                    s.disconnect(true);
                }

                await queries.deleteStreamById(Number(room));
                if (io.sockets.adapter.customData) {
                    delete io.sockets.adapter.customData[room];
                }
            }
            else {
                socket.emit('warn', 'Только создатель эфира может завершить его');
            }
        } 
        catch (e) {
            console.error("Ошибка end-stream:", e);
            socket.emit('error', 'Ошибка завершения эфира');
        }
    }));

    socket.on('update-role', validateSocketInRoom(socket, async (room, targetId, newRole) => {
        try {
            if (!['moderator', 'listener', 'kick', 'banned'].includes(newRole)) {
                socket.emit('warn', 'Некорректная роль');
                return;
            }

            if (!['admin', 'moderator'].includes(socket.role)) {
                socket.emit('warn', 'Нет прав на обновление роли');
                return;
            }

            const socketsInRoom = await io.in(room).fetchSockets();
            const targetSocket = socketsInRoom.find(s => s.userId === Number(targetId));

            if (!targetSocket) {
                socket.emit('warn', 'Пользователь не найден в комнате');
                return;
            }

            if (targetSocket.userId === socket.userId) {
                socket.emit('warn', 'Нельзя менять роль самому себе');
                return;
            }

            // Нельзя менять роль администратора комнаты
            if (targetSocket.role === 'admin') {
                socket.emit('warn', 'Нельзя изменять роль создателя эфира');
                return;
            }

            // Модератор не может назначать модераторов или банить участников
            if (socket.role === 'moderator' && (newRole === 'moderator' || newRole === 'banned')) {
                socket.emit('warn', 'Только администратор может назначать модераторов или банить участников');
                return;
            }

            // Обновляем роль в базе данных (кроме временного кика)
            if (newRole !== 'kick') {
                await queries.setParticipantRoleByIds(Number(room), targetId, newRole);
            }

            targetSocket.role = newRole;
            targetSocket.emit('role-updated', newRole);

            const roomData = io.sockets.adapter.customData ? io.sockets.adapter.customData[room] : null;

            if (newRole !== 'moderator' && roomData && roomData.currentSpeakerId === targetSocket.userId) {
                if (roomData.producer) {
                    try { roomData.producer.close(); } catch (_) {}
                    roomData.producer = null;
                }
                socket.broadcast.to(room).emit('speaking-user', null, null);
            }
            
            if (newRole === 'banned') {
                if (targetSocket.recvTransport) try { targetSocket.recvTransport.close(); } catch (_) {}
                if (targetSocket.sendTransport) try { targetSocket.sendTransport.close(); } catch (_) {}
                targetSocket.disconnect(true);

                await queries.addMessageToStreamById(Number(room), socket.userId, `Участник ${targetSocket.username} был забанен`, io);
                return;
            }
            
            if (newRole === 'kick') {
                if (targetSocket.recvTransport) try { targetSocket.recvTransport.close(); } catch (_) {}
                if (targetSocket.sendTransport) try { targetSocket.sendTransport.close(); } catch (_) {}
                targetSocket.disconnect(true);

                await queries.addMessageToStreamById(Number(room), socket.userId, `Участник ${targetSocket.username} был исключён`, io);
                return;
            }
        }
        catch(e) {
            console.error("Ошибка update-role:", e);
            socket.emit('error', 'Ошибка обновления роли');
        }
    }));

    socket.on('disconnecting', async () => {
        try {
            const rooms = Array.from(socket.rooms).filter((room) => room !== socket.id);
        
            for (const room of rooms) {
                const roomData = io.sockets.adapter.customData ? io.sockets.adapter.customData[room] : null;
                if (roomData && roomData.currentSpeakerId === socket.userId) {
                    roomData.currentSpeakerId = null;
                    roomData.currentSpeakerUsername = null;
                    socket.broadcast.to(room).emit('speaking-user', null, null);

                    if (roomData.producer) {
                        try { roomData.producer.close(); } catch (_) {}
                        roomData.producer = null;
                    }

                    if (roomData.timer) {
                        clearTimeout(roomData.timer);
                        roomData.timer = null;
                    }
                }
                
                // Закрываем транспорты сокета
                if (socket.sendTransport) {
                    try { socket.sendTransport.close(); } catch (_) {}
                }
                if (socket.recvTransport) {
                    try { socket.recvTransport.close(); } catch (_) {}
                }

                console.log(`Пользователь ${socket.username || socket.id} вышел из комнаты ${room}`);
                socket.leave(room);

                const currentRoom = io.sockets.adapter.rooms.get(room);
                const participantsAmount = currentRoom ? currentRoom.size : 0;
                io.to(room).emit('users-amount', participantsAmount);

                // Очистка памяти, если комната опустела
                if (participantsAmount === 0 && io.sockets.adapter.customData) {
                    delete io.sockets.adapter.customData[room];
                }
            }
        }
        catch (e) {
            console.error('Ошибка disconnecting:', e);
        }
    });
};

module.exports = communicationManager;
module.exports.setupMediasoup = setupMediasoup;