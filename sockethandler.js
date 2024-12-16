let currentSpeakers = {};
module.exports = (io, socket) => {
    console.log('A user connected');

    socket.on('join-room', (room) => {
        if (currentSpeakers[room]) {
            socket.emit('already-speaking');
            return;
        }
        socket.join(room);
        console.log(`Пользователь ${socket.id} зашёл в комнату ${room}`);
    });

    socket.on('offer', (offer, room) => {
        socket.broadcast.to(room).emit('offer', offer, room);
    });

    socket.on('answer', (answer, room) => {
        socket.broadcast.to(room).emit('answer', answer, room);
    });

    socket.on('ice-candidate', (candidate, room) => {
        socket.broadcast.to(room).emit('ice-candidate', candidate, room);
    });

    socket.on('start-talking', (room) => {
        if (currentSpeakers[room]) {
            socket.emit('already-speaking');
            return;
        }

        currentSpeakers[room] = socket.id;
        socket.broadcast.to(room).emit('speaker-changed', socket.id);
    });

    socket.on('stop-talking', (room) => {
        if (currentSpeakers[room] === socket.id) {
            delete currentSpeakers[room];
            socket.broadcast.to(room).emit('no-speaker');
        }
    });

    socket.on('disconnect', () => {
        console.log('Пользователь вышел');
        for (const room in currentSpeakers) {
            if (currentSpeakers[room] === socket.id) {
                delete currentSpeakers[room];
                socket.broadcast.to(room).emit('no-speaker');
                break;
            }
        }
    });
}