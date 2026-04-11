const WebSocket = require('ws');

const PORT = process.env.PORT || 3000;
const wss = new WebSocket.Server({ port: PORT, host: '0.0.0.0' });

const rooms = new Map();

/*
Broadcasts a message to all clients in a room, except the specified client.
*/
function broadcast(roomId, data, except) {
    const msg = JSON.stringify(data);
    let broadcastCount = 0;
    for(const client of rooms.get(roomId).sockets) {
        if (client !== except && client.readyState === WebSocket.OPEN) {
            client.send(msg);
            broadcastCount++;
        }
    }
    console.log(`📢 Broadcasted ${data.type} to ${broadcastCount} client(s)`);
};

/*
Sends event update message to all clients in the room.
*/
function eventUpdate(roomId, room, data, except) {
    const msg = JSON.stringify(data);
    for (const client of room.sockets) {
        if (client !== except && client.readyState === WebSocket.OPEN) {
            client.send(msg);
        }
    }
    console.log(`🔄 Sent ${data.type} update to room ${roomId}`);
}

function getRoomParticipantList(room) {
    return Array.from(room.participants.values());
}

function sendToPeer(room, targetPeerId, data) {
    if (!targetPeerId) return false;
    const targetSocket = room.peerToSocket.get(targetPeerId);
    if (!targetSocket || targetSocket.readyState !== WebSocket.OPEN) {
        return false;
    }
    targetSocket.send(JSON.stringify(data));
    return true;
}

function upsertParticipant(room, socket, participantInput) {
    if (!participantInput || typeof participantInput !== 'object' || !participantInput.peerId) {
        return null;
    }

    const participant = {
        peerId: participantInput.peerId,
        name: participantInput.name || 'User',
        avatar: participantInput.avatar || 'bear.png',
        callActive: Boolean(participantInput.callActive),
        cameraOn: participantInput.cameraOn !== false,
        micOn: participantInput.micOn !== false,
        updatedAt: Date.now()
    };

    room.participants.set(participant.peerId, participant);
    room.socketToPeerId.set(socket, participant.peerId);
    room.peerToSocket.set(participant.peerId, socket);
    return participant;
}
/*
Handles new client connections to the WebSocket server.
*/
wss.on('connection', (socket) => {
    console.log('🔌 New client connected');
    let currentRoomId = null;

    socket.on('message', (raw) => {
        let msg;
        try {
            msg = JSON.parse(raw);
        } catch (e) {
            console.error('❌ Failed to parse message:', raw);
            return;
        }
        if (msg.type === 'join' || msg.type === 'create-room') {
            const { roomId } = msg;
            currentRoomId = roomId;

            //Create room if it doesn't exist
            if (!rooms.has(roomId)) {
                rooms.set(roomId, {
                     sockets: new Set(),
                     state: null,
                     sourceMetadata: null,
                     participants: new Map(),
                     socketToPeerId: new Map(),
                     peerToSocket: new Map()
                });
                console.log(`🏠 Created new room: ${roomId}`);
            }

            //Add user(socket) to the room
            const room = rooms.get(roomId);
            room.sockets.add(socket);
            if (msg.sourceMetadata && !room.sourceMetadata) {
                room.sourceMetadata = {
                    pageUrl: msg.sourceMetadata.pageUrl || null,
                    pageTitle: msg.sourceMetadata.pageTitle || null,
                    site: msg.sourceMetadata.site || null,
                    adapterId: msg.sourceMetadata.adapterId || 'default',
                    createdAt: msg.sourceMetadata.createdAt || Date.now()
                };
            }

            const participant = upsertParticipant(room, socket, msg.participant);
            console.log(`✅ Client joined room ${roomId} (${room.sockets.size} client(s) in room)`);

            // Tell the joining client whether room state already exists.
            socket.send(JSON.stringify({
                type: msg.type === 'create-room' ? 'create-room-ack' : 'join-ack',
                roomId,
                hasState: Boolean(room.state),
                sourceMetadata: room.sourceMetadata,
                participants: getRoomParticipantList(room)
            }));

            if (participant) {
                broadcast(roomId, {
                    type: 'participant-joined',
                    participant
                }, socket);
            }

            //Send current state to the newly joined client
            if (room.state) {
                socket.send(JSON.stringify({ 
                    type: 'sync-state', 
                    state: room.state,
                    sourceMetadata: room.sourceMetadata
                }));
                console.log(`🔄 Sent current state to new client in room ${roomId}`);
            }

            return;
        }
        if (!currentRoomId) return;
        
        const room = rooms.get(currentRoomId);
        if (!room) return;

        if (msg.type === 'play' || 
            msg.type === 'pause' || 
            msg.type === 'seek' || 
            msg.type === 'ratechange' ||
            msg.type === 'state-update'
        ) {
            const nextTime = msg.currentTime ?? msg.time ?? (room.state ? room.state.time ?? 0 : 0);

            room.state = {
                url: msg.url ?? (room.state ? room.state.url : null),
                time: nextTime,
                isPlaying: msg.type === 'play' ? true : 
                           msg.type === 'pause' ? false : 
                           typeof msg.isPlaying === 'boolean' ? msg.isPlaying :
                           room.state ? room.state.isPlaying ?? false : false,
                playbackRate: msg.playbackRate ?? 
                (room.state ? room.state.playbackRate ?? 1 : 1),
                updatedAt: Date.now()
            }

            if (msg.sourceMetadata && !room.sourceMetadata) {
                room.sourceMetadata = {
                    pageUrl: msg.sourceMetadata.pageUrl || null,
                    pageTitle: msg.sourceMetadata.pageTitle || null,
                    site: msg.sourceMetadata.site || null,
                    adapterId: msg.sourceMetadata.adapterId || 'default',
                    createdAt: msg.sourceMetadata.createdAt || Date.now()
                };
            }

            console.log(`📺 Room ${currentRoomId}: ${msg.type} at ${Number(nextTime).toFixed(2)}s`);

            if (msg.type !== 'state-update') {
                eventUpdate(currentRoomId, room, {
                    type: msg.type,
                    state: room.state,
                    sourceMetadata: room.sourceMetadata
                }, socket);
            }
        }

        if (msg.type === 'ping') {
            console.log(`🏓 Received ping from client in room ${currentRoomId}`);
            socket.send(JSON.stringify({ type: 'pong' }));
        }

        if (msg.type === 'chatMessage') {
            console.log(`💬 Received chat message in room ${currentRoomId}: ${msg.text}`);
            broadcast(currentRoomId, msg, socket);
        }

        if (msg.type === 'participant-update') {
            const fallbackPeerId = room.socketToPeerId.get(socket);
            const participant = upsertParticipant(room, socket, {
                peerId: msg.peerId || fallbackPeerId,
                name: msg.name,
                avatar: msg.avatar,
                callActive: msg.callActive,
                cameraOn: msg.cameraOn,
                micOn: msg.micOn
            });

            if (participant) {
                broadcast(currentRoomId, {
                    type: 'participant-updated',
                    participant
                }, socket);
            }
        }

        if (msg.type === 'rtc-signal') {
            const fromPeerId = msg.fromPeerId || room.socketToPeerId.get(socket) || null;
            const forwarded = {
                type: 'rtc-signal',
                fromPeerId,
                toPeerId: msg.toPeerId || null,
                description: msg.description || null,
                candidate: msg.candidate || null
            };

            if (msg.toPeerId) {
                const delivered = sendToPeer(room, msg.toPeerId, forwarded);
                if (!delivered) {
                    console.log(`⚠️ Failed to deliver rtc-signal to ${msg.toPeerId} in room ${currentRoomId}`);
                }
            } else {
                broadcast(currentRoomId, forwarded, socket);
            }
        }

        if (msg.type === 'videoReaction') {
            console.log(`✨ Received video reaction in room ${currentRoomId}: ${msg.emoji}`);
            // Send to everyone including the sender so they see their own reaction
            const responseMsg = JSON.stringify(msg);
            for (const client of room.sockets) {
                if (client.readyState === WebSocket.OPEN) {
                    client.send(responseMsg);
                }
            }
        }

        if (msg.type === 'sync-state-ack') {
            const acknowledgedAt = new Date(msg.ackAt || Date.now()).toISOString();
            console.log(`✅ sync-state acknowledged in room ${currentRoomId} at ${acknowledgedAt} (time=${Number(msg.syncedTime || 0).toFixed(2)}s)`);
        }
    });

    socket.on('close', () => {
        if (!currentRoomId) return;

        const room = rooms.get(currentRoomId);
        if (!room) return;

        room.sockets.delete(socket);
        const peerId = room.socketToPeerId.get(socket);
        if (peerId) {
            room.socketToPeerId.delete(socket);
            room.peerToSocket.delete(peerId);
            room.participants.delete(peerId);
            broadcast(currentRoomId, {
                type: 'participant-left',
                peerId
            }, socket);
        }
        console.log(`👋 Client left room ${currentRoomId} (${room.sockets.size} client(s) remaining)`);

        //If room is empty, delete it
        if (room.sockets.size === 0) {
            rooms.delete(currentRoomId);
            console.log(`🗑️  Deleted empty room: ${currentRoomId}`);
        }
    })
});

setInterval(() => {
    console.log(`Current active rooms: ${Array.from(rooms.keys()).join(', ')}`);
}, 60000);

console.log(`WebSocket server running on port ${PORT} `);