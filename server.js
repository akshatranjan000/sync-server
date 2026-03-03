const { hostname } = require('os');
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
function eventUpdate(roomId, room, data) {
    const msg = JSON.stringify(data);
    for (const client of room.sockets) {
        if (client.readyState === WebSocket.OPEN) {
            client.send(msg);
        }
    }
    console.log(`🔄 Sent ${data.type} update to room ${roomId}`);
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
        if (msg.type === 'join') {
            const { roomId } = msg;
            currentRoomId = roomId;

            //Create room if it doesn't exist
            if (!rooms.has(roomId)) {
                rooms.set(roomId, {
                     sockets: new Set(),
                     state: null
                });
                console.log(`🏠 Created new room: ${roomId}`);
            }

            //Add user(socket) to the room
            const room = rooms.get(roomId);
            room.sockets.add(socket);
            console.log(`✅ Client joined room ${roomId} (${room.sockets.size} client(s) in room)`);

            //Send current state to the newly joined client
            if (room.state) {
                socket.send(JSON.stringify({ 
                    type: 'sync-state', 
                    state: room.state 
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
            msg.type === 'ratechange'
        ) {
            const nextTime = msg.currentTime ?? msg.time ?? (room.state ? room.state.time ?? 0 : 0);

            room.state = {
                url: msg.url ?? (room.state ? room.state.url : null),
                time: nextTime,
                isPlaying: msg.type === 'play' ? true : 
                           msg.type === 'pause' ? false : 
                           room.state ? room.state.isPlaying ?? false : false,
                playbackRate: msg.playbackRate ?? 
                (room.state ? room.state.playbackRate ?? 1 : 1),
                updatedAt: Date.now()
            }

            console.log(`📺 Room ${currentRoomId}: ${msg.type} at ${Number(nextTime).toFixed(2)}s`);
            eventUpdate(currentRoomId, room, { type: 'sync-state', state: room.state });
        }
    });

    socket.on('close', () => {
        if (!currentRoomId) return;

        const room = rooms.get(currentRoomId);
        if (!room) return;

        room.sockets.delete(socket);
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