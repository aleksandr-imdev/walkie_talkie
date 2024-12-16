const socket = io();

// ICE серверы
const iceConfiguration = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        {
            urls: 'turn:openrelay.metered.ca:80',
            username: 'openrelayproject',
            credential: 'openrelayproject'
        }
    ]
};

const talkButton = document.getElementById('talk-button');
const remoteAudio = document.getElementById('remote-audio');
const localAudio = document.getElementById('local-audio');

let localStream;
let pc; // Объект peer-connection
let currentRoom;
let isTalking = false;
let currentSpeakerId = null;
let remoteAudioStream;

joinRoom();

// Присоединиться к комнате
async function joinRoom() {
    currentRoom = streamId;
    socket.emit('join-room', streamId);
}

// Получить аудио пользователя
navigator.mediaDevices.getUserMedia({ audio: true })
    .then(stream => {
        localStream = stream;
        localAudio.srcObject = stream;
    })
    .catch(error => console.error('Error accessing media devices:', error));

// Обработка кнопки "говорить"
talkButton.addEventListener('click', () => {
    if (!isTalking) {
        startTalking();
    } else {
        stopTalking();
    }
});

// Начать говорить
async function startTalking() {
    if (!currentRoom) {
        alert("Join a room first!");
        return;
    }

    if (isTalking) return; // Ограничение на одного говорящего

    if (currentSpeakerId && currentSpeakerId !== socket.id) {
        alert("Someone is already speaking.");
        return;
    }

    socket.emit('start-talking', currentRoom);
    isTalking = true;

    try {
        pc = new RTCPeerConnection(iceConfiguration);
        localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

        pc.onicecandidate = event => {
            if (event.candidate) {
                socket.emit('ice-candidate', event.candidate, currentRoom);
            }
        };

        pc.ontrack = event => {
            if (event.track.kind === 'audio') {
                remoteAudio.srcObject = event.streams[0];
                remoteAudioStream = event.streams[0];
            }
        };

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.emit('offer', offer, currentRoom);
    } catch (error) {
        console.error("Error starting talk:", error);
        stopTalking();
    }
}

// Закончить говорить
function stopTalking() {
    if (!isTalking) return;

    isTalking = false;
    socket.emit('stop-talking', currentRoom);
    closePeerConnection();
}

// Закрыть peer-connection
function closePeerConnection() {
    if (pc) {
        pc.close();
        pc = null;
    }
    if (remoteAudioStream) {
        remoteAudioStream.getTracks().forEach(track => track.stop());
        remoteAudio.srcObject = null;
        remoteAudioStream = null;
    }
}

// Обработка RTC offer
socket.on('offer', async (offer, room) => {
    if (isTalking || room !== currentRoom) return;

    try {
        pc = new RTCPeerConnection(iceConfiguration);

        pc.ontrack = event => {
            if (event.track.kind === 'audio') {
                remoteAudio.srcObject = event.streams[0];
                remoteAudioStream = event.streams[0];
            }
        };

        pc.onicecandidate = event => {
            if (event.candidate) {
                socket.emit('ice-candidate', event.candidate, room);
            }
        };

        await pc.setRemoteDescription(new RTCSessionDescription(offer)); // Remote Desctiption
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit('answer', answer, room);
    } catch (error) {
        console.error("Error handling offer", error);
        closePeerConnection();
    }
});

// Обработка RTC ответа
socket.on('answer', async (answer, room) => {
    if (room !== currentRoom) return;
    try {
      if (pc && pc.connectionState !== "closed") { // Проверяем, открыто ли соединение
        await pc.setRemoteDescription(new RTCSessionDescription(answer));
      } else {
        console.warn("Received answer but no active peer connection.");
      }
    } catch (error) {
        console.error("Error handling answer", error);
        closePeerConnection();
    }
});

// Handle ICE candidates
socket.on('ice-candidate', async (candidate, room) => {
    if (room === currentRoom && pc && pc.remoteDescription) { // Проверяем, открыто ли соединение
        try {
            if (candidate) {
                await pc.addIceCandidate(new RTCIceCandidate(candidate));
            }
        } catch (error) {
            console.error("Error adding ICE candidate", error);
        }
    }
});

// Обработка смены говорящего
socket.on('speaker-changed', (speakerId) => {
    currentSpeakerId = speakerId;
    if (speakerId !== socket.id) {
        closePeerConnection();
    }
});

// Обработка отсутствие говорящего
socket.on('no-speaker', () => {
    currentSpeakerId = null;
    closePeerConnection();
});

// Сообщение "кто-то уже говорить"
socket.on('already-speaking', () => {
    alert("Кто-то уже говорит");
    stopTalking();
});

socket.on('room-join-error', (error) => {
    alert(error);
});