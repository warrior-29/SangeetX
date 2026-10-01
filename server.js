const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const axios = require('axios');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin@8174902497';

const rooms = {};
const blockedUsers = {};
const IDLE_TIMEOUT = 2 * 60 * 1000;

const analytics = {
  visits: [], totalVisits: 0, uniqueUsers: new Set(),
  roomsCreated: 0, roomsDeleted: 0, songsPlayed: 0,
  messagesSent: 0, reactionsSent: 0,
  activeSessions: new Map(), dailyVisits: {}, hourlyVisits: {}
};

function recordVisit(name, roomId, userAgent) {
  const now = new Date();
  const dateKey = now.toISOString().slice(0, 10);
  const hourKey = now.getHours().toString();
  analytics.totalVisits++;
  analytics.uniqueUsers.add(name.toLowerCase());
  analytics.visits.push({ time: now.toISOString(), name, roomId, userAgent });
  if (analytics.visits.length > 5000) analytics.visits.shift();
  analytics.dailyVisits[dateKey] = (analytics.dailyVisits[dateKey] || 0) + 1;
  analytics.hourlyVisits[hourKey] = (analytics.hourlyVisits[hourKey] || 0) + 1;
}

function isAdmin(password) { return password === ADMIN_PASSWORD; }

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/api/admin/stats', (req, res) => {
  if (!isAdmin(req.query.password)) return res.status(401).json({ error: 'Invalid password' });
  const today = new Date().toISOString().slice(0, 10);
  const todayVisits = analytics.dailyVisits[today] || 0;
  const last7 = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    last7.push({ date: key, count: analytics.dailyVisits[key] || 0 });
  }
  const hourly = [];
  for (let h = 0; h < 24; h++) hourly.push({ hour: h, count: analytics.hourlyVisits[h.toString()] || 0 });
  const activeRooms = Object.entries(rooms).map(([roomId, room]) => {
    const age = Math.floor((Date.now() - (room.createdAt || Date.now())) / 60000);
    return {
      roomId, ownerName: room.ownerName,
      userCount: room.users.length,
      pendingCount: room.pending.length,
      messageCount: room.messages.length,
      age,
      currentTrack: room.state.track ? { title: room.state.track.title, artist: room.state.track.artist } : null,
      isPlaying: room.state.isPlaying,
      users: room.users.map(u => ({ id: u.id, name: u.name, blocked: u.blocked || { chat: false, play: false, voice: false } }))
    };
  });
  res.json({
    totalVisits: analytics.totalVisits,
    uniqueUsers: analytics.uniqueUsers.size,
    todayVisits, roomsCreated: analytics.roomsCreated,
    roomsDeleted: analytics.roomsDeleted,
    songsPlayed: analytics.songsPlayed,
    messagesSent: analytics.messagesSent,
    reactionsSent: analytics.reactionsSent,
    activeNow: analytics.activeSessions.size,
    activeRooms: Object.keys(rooms).length,
    last7Days: last7, hourly,
    recentVisits: analytics.visits.slice(-30).reverse(),
    activeSessions: Array.from(analytics.activeSessions.values()),
    roomsList: activeRooms
  });
});

app.post('/api/admin/deleteRoom', (req, res) => {
  const { password, roomId } = req.body;
  if (!isAdmin(password)) return res.status(401).json({ error: 'Unauthorized' });
  const room = rooms[roomId];
  if (!room) return res.status(404).json({ error: 'Room not found' });
  io.to(roomId).emit('roomClosed', { message: 'Room closed by admin' });
  room.users.forEach(u => {
    const s = io.sockets.sockets.get(u.id);
    if (s) { s.leave(roomId); s.roomId = null; analytics.activeSessions.delete(u.id); }
  });
  room.pending.forEach(p => {
    const s = io.sockets.sockets.get(p.id);
    if (s) { s.emit('roomClosed', { message: 'Room closed by admin' }); s.pendingRoom = null; }
  });
  delete rooms[roomId]; delete blockedUsers[roomId];
  analytics.roomsDeleted++;
  console.log('🗑️ Admin deleted room:', roomId);
  res.json({ success: true, message: 'Room deleted' });
});

app.post('/api/admin/kickUser', (req, res) => {
  const { password, roomId, userId } = req.body;
  if (!isAdmin(password)) return res.status(401).json({ error: 'Unauthorized' });
  const room = rooms[roomId];
  if (!room) return res.status(404).json({ error: 'Room not found' });
  const user = room.users.find(u => u.id === userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.id === room.ownerId) return res.status(400).json({ error: 'Use delete room for owner' });
  room.users = room.users.filter(u => u.id !== userId);
  const s = io.sockets.sockets.get(userId);
  if (s) { s.leave(roomId); s.roomId = null; s.emit('kicked', { message: 'Admin removed you from the room' }); }
  analytics.activeSessions.delete(userId);
  io.to(roomId).emit('usersUpdate', getUsersWithStatus(room));
  res.json({ success: true, message: user.name + ' kicked' });
});

app.post('/api/admin/blockAction', (req, res) => {
  const { password, roomId, userId, action, block } = req.body;
  if (!isAdmin(password)) return res.status(401).json({ error: 'Unauthorized' });
  const room = rooms[roomId];
  if (!room) return res.status(404).json({ error: 'Room not found' });
  const user = room.users.find(u => u.id === userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (!user.blocked) user.blocked = { chat: false, play: false, voice: false };
  if (['chat', 'play', 'voice'].includes(action)) user.blocked[action] = !!block;
  const s = io.sockets.sockets.get(userId);
  if (s) s.emit('permissionsUpdate', { blocked: user.blocked });
  io.to(roomId).emit('usersUpdate', getUsersWithStatus(room));
  res.json({ success: true, blocked: user.blocked });
});

app.post('/api/admin/deleteMessage', (req, res) => {
  const { password, roomId, messageId } = req.body;
  if (!isAdmin(password)) return res.status(401).json({ error: 'Unauthorized' });
  const room = rooms[roomId];
  if (!room) return res.status(404).json({ error: 'Room not found' });
  const index = room.messages.findIndex(m => m.id === messageId);
  if (index === -1) return res.status(404).json({ error: 'Message not found' });
  room.messages.splice(index, 1);
  io.to(roomId).emit('messageDeleted', { messageId });
  res.json({ success: true });
});

app.get('/api/admin/roomChat', (req, res) => {
  const { password, roomId } = req.query;
  if (!isAdmin(password)) return res.status(401).json({ error: 'Unauthorized' });
  const room = rooms[roomId];
  if (!room) return res.status(404).json({ error: 'Room not found' });
  res.json({ messages: room.messages });
});

io.on('connection', (socket) => {
  console.log('Connected:', socket.id);

  socket.on('createRoom', ({ roomId, userName }) => {
    if (rooms[roomId]) {
      socket.emit('createRoomResult', { success: false, message: 'This room already exists' });
      return;
    }
    rooms[roomId] = {
      ownerId: socket.id, ownerName: userName, createdAt: Date.now(),
      users: [{
        id: socket.id, name: userName, lastActive: Date.now(),
        blocked: { chat: false, play: false, voice: false },
        location: null, chatActive: false
      }],
      pending: [], messages: [],
      state: { track: null, position: 0, isPlaying: false, lastUpdated: Date.now() }
    };
    if (!blockedUsers[roomId]) blockedUsers[roomId] = [];
    socket.join(roomId);
    socket.roomId = roomId;
    socket.userName = userName;
    analytics.roomsCreated++;
    recordVisit(userName, roomId, socket.handshake.headers['user-agent'] || 'unknown');
    analytics.activeSessions.set(socket.id, { name: userName, roomId, joinedAt: Date.now(), role: 'owner' });
    socket.emit('createRoomResult', { success: true, roomId, isOwner: true });
    socket.emit('stateSync', rooms[roomId].state);
    socket.emit('chatHistory', rooms[roomId].messages);
    socket.emit('blockedList', blockedUsers[roomId]);
    io.to(roomId).emit('usersUpdate', getUsersWithStatus(rooms[roomId]));
    console.log(userName + ' created room ' + roomId);
  });

  socket.on('requestJoin', ({ roomId, userName }) => {
    const room = rooms[roomId];
    if (!room) { socket.emit('joinResult', { success: false, message: 'Room not found' }); return; }
    const blocked = blockedUsers[roomId] || [];
    if (blocked.find(b => b.name.toLowerCase() === userName.toLowerCase())) {
      socket.emit('joinResult', { success: false, message: 'You are blocked from this room' });
      return;
    }
    if (room.users.find(u => u.id === socket.id)) {
      socket.emit('joinResult', { success: true, roomId }); return;
    }
    room.pending = room.pending.filter(p => p.id !== socket.id);
    room.pending.push({ id: socket.id, name: userName });
    socket.userName = userName;
    socket.pendingRoom = roomId;
    recordVisit(userName, roomId, socket.handshake.headers['user-agent'] || 'unknown');
    io.to(room.ownerId).emit('joinRequest', { userId: socket.id, userName, roomId });
    socket.emit('joinResult', { success: false, pending: true, message: 'Waiting for owner approval...' });
  });

  socket.on('approveJoin', ({ roomId, userId }) => {
    const room = rooms[roomId];
    if (!room || room.ownerId !== socket.id) return;
    const pending = room.pending.find(p => p.id === userId);
    if (!pending) return;
    room.pending = room.pending.filter(p => p.id !== userId);
    room.users.push({
      ...pending, lastActive: Date.now(),
      blocked: { chat: false, play: false, voice: false },
      location: null, chatActive: false
    });
    const userSocket = io.sockets.sockets.get(userId);
    if (userSocket) {
      userSocket.join(roomId);
      userSocket.roomId = roomId;
      userSocket.pendingRoom = null;
      userSocket.emit('joinResult', { success: true, roomId, isOwner: false });
      userSocket.emit('stateSync', room.state);
      userSocket.emit('chatHistory', room.messages);
      analytics.activeSessions.set(userId, { name: pending.name, roomId, joinedAt: Date.now(), role: 'member' });
      room.users.forEach(u => {
        if (u.location && u.id !== userId) {
          io.to(userId).emit('partnerLocation', { location: u.location, userId: u.id, userName: u.name });
        }
      });
    }
    io.to(roomId).emit('usersUpdate', getUsersWithStatus(room));
  });

  socket.on('denyJoin', ({ roomId, userId }) => {
    const room = rooms[roomId];
    if (!room || room.ownerId !== socket.id) return;
    const pending = room.pending.find(p => p.id === userId);
    if (!pending) return;
    room.pending = room.pending.filter(p => p.id !== userId);
    const userSocket = io.sockets.sockets.get(userId);
    if (userSocket) userSocket.emit('joinResult', { success: false, message: 'Owner declined your request' });
  });

  socket.on('removeUser', ({ roomId, userId }) => {
    const room = rooms[roomId];
    if (!room || room.ownerId !== socket.id) return;
    if (userId === socket.id) return;
    room.users = room.users.filter(u => u.id !== userId);
    const userSocket = io.sockets.sockets.get(userId);
    if (userSocket) {
      userSocket.leave(roomId);
      userSocket.roomId = null;
      userSocket.emit('kicked', { message: 'Owner removed you from the room' });
    }
    analytics.activeSessions.delete(userId);
    io.to(roomId).emit('usersUpdate', getUsersWithStatus(room));
  });

  socket.on('shareLocation', ({ roomId, location }) => {
    const room = rooms[roomId];
    if (!room) return;
    if (!location || typeof location.lat !== 'number' || typeof location.lng !== 'number') return;
    const user = room.users.find(u => u.id === socket.id);
    if (user) { user.location = location; user.lastActive = Date.now(); }
    socket.to(roomId).emit('partnerLocation', { location, userId: socket.id, userName: socket.userName });
    console.log(`📍 Location shared in ${roomId} by ${socket.userName}`);
  });

  socket.on('chatPresence', ({ roomId, active }) => {
    const room = rooms[roomId];
    if (!room) return;
    const user = room.users.find(u => u.id === socket.id);
    if (!user) return;
    user.chatActive = !!active;
    user.lastActive = Date.now();
    room.users.forEach(u => {
      const userSocket = io.sockets.sockets.get(u.id);
      if (userSocket) {
        const activeUsers = room.users.filter(x => x.chatActive).map(x => ({
          id: x.id, name: x.name, isMe: x.id === u.id
        }));
        userSocket.emit('chatPresenceUpdate', { users: activeUsers });
      }
    });
    console.log(`💬 Chat presence: ${user.name} is ${active ? 'IN' : 'OUT'}`);
  });

  // ===== TYPING — IMPROVED =====
  socket.on('typing', ({ roomId, isTyping, userName: clientName }) => {
    const room = rooms[roomId];
    if (!room) return;
    const user = room.users.find(u => u.id === socket.id);
    if (!user) return;
    
    // Fallback name
    const name = user.name || socket.userName || clientName || 'Someone';
    
    socket.to(roomId).emit('userTyping', {
      userName: name,
      userId: socket.id,
      isTyping: !!isTyping
    });
    
    console.log(`⌨️ ${name} ${isTyping ? 'is' : 'stopped'} typing in ${roomId}`);
  });

  socket.on('updateState', ({ roomId, newState }) => {
    const room = rooms[roomId];
    if (!room) return;
    const user = room.users.find(u => u.id === socket.id);
    if (!user) return;
    user.lastActive = Date.now();
    if (user.blocked && user.blocked.play) {
      socket.emit('permissionDenied', { action: 'play', message: 'You are blocked from controlling playback' });
      return;
    }
    if (newState.track && (!room.state.track || room.state.track.id !== newState.track.id)) analytics.songsPlayed++;
    room.state = { ...room.state, ...newState, lastUpdated: Date.now() };
    socket.to(roomId).emit('stateSync', room.state);
    io.to(roomId).emit('usersUpdate', getUsersWithStatus(room));
  });

  socket.on('heartbeat', ({ roomId, position, isPlaying }) => {
    const room = rooms[roomId];
    if (!room) return;
    const user = room.users.find(u => u.id === socket.id);
    if (!user) return;
    user.lastActive = Date.now();
    if (user.blocked && user.blocked.play) return;
    room.state.position = position;
    room.state.isPlaying = isPlaying;
    room.state.lastUpdated = Date.now();
    socket.to(roomId).emit('heartbeat', { position, isPlaying });
  });

  socket.on('activity', ({ roomId }) => {
    const room = rooms[roomId];
    if (!room) return;
    const user = room.users.find(u => u.id === socket.id);
    if (user) user.lastActive = Date.now();
  });

  socket.on('chatMessage', ({ roomId, text, mentions }) => {
    const room = rooms[roomId];
    if (!room) return;
    const user = room.users.find(u => u.id === socket.id);
    if (!user) return;
    user.lastActive = Date.now();
    if (user.blocked && user.blocked.chat) {
      socket.emit('permissionDenied', { action: 'chat', message: 'You are blocked from chatting' });
      return;
    }
    analytics.messagesSent++;
    const msg = {
      id: Date.now() + '-' + Math.random().toString(36).slice(2, 7),
      userId: socket.id, userName: socket.userName,
      text: String(text).slice(0, 500), mentions: mentions || [],
      time: Date.now(), type: 'text'
    };
    room.messages.push(msg);
    if (room.messages.length > 100) room.messages.shift();
    io.to(roomId).emit('chatMessage', msg);
  });

  socket.on('voiceSignal', ({ roomId, signal }) => {
    const room = rooms[roomId];
    if (!room) return;
    const user = room.users.find(u => u.id === socket.id);
    if (user && user.blocked && user.blocked.voice) return;
    socket.to(roomId).emit('voiceSignal', { signal, from: socket.id, userName: socket.userName });
  });

  socket.on('pttState', ({ roomId, isTalking }) => {
    const room = rooms[roomId];
    if (!room) return;
    const user = room.users.find(u => u.id === socket.id);
    if (!user) return;
    user.lastActive = Date.now();
    if (user.blocked && user.blocked.voice) return;
    socket.to(roomId).emit('pttState', { userName: socket.userName, isTalking });
  });

  socket.on('reaction', ({ roomId, emoji }) => {
    const room = rooms[roomId];
    if (room) {
      const user = room.users.find(u => u.id === socket.id);
      if (user) user.lastActive = Date.now();
    }
    analytics.reactionsSent++;
    socket.to(roomId).emit('reaction', { emoji, userName: socket.userName });
  });

  socket.on('syncPing', ({ roomId, clientTime, position }) => {
    socket.emit('syncPong', { clientTime, serverTime: Date.now() });
  });

  socket.on('moodUpdate', ({ roomId, mood, emoji, text, color }) => {
    const room = rooms[roomId];
    if (room) {
      const user = room.users.find(u => u.id === socket.id);
      if (user) user.lastActive = Date.now();
    }
    socket.to(roomId).emit('partnerMood', { mood, emoji, text, color });
  });

  socket.on('disconnect', () => {
    const roomId = socket.roomId;
    const pendingRoom = socket.pendingRoom;
    analytics.activeSessions.delete(socket.id);
    if (pendingRoom && rooms[pendingRoom]) {
      rooms[pendingRoom].pending = rooms[pendingRoom].pending.filter(p => p.id !== socket.id);
    }
    if (roomId && rooms[roomId]) {
      const room = rooms[roomId];
      socket.to(roomId).emit('userTyping', { userName: socket.userName, userId: socket.id, isTyping: false });
      room.users = room.users.filter(u => u.id !== socket.id);
      room.users.forEach(u => {
        const userSocket = io.sockets.sockets.get(u.id);
        if (userSocket) {
          const activeUsers = room.users.filter(x => x.chatActive).map(x => ({
            id: x.id, name: x.name, isMe: x.id === u.id
          }));
          userSocket.emit('chatPresenceUpdate', { users: activeUsers });
        }
      });
      if (room.ownerId === socket.id) {
        room.ownerOnline = false;
        io.to(roomId).emit('ownerOffline', { message: 'Owner is offline. Room will stay active for 30 minutes.' });
        room.deleteTimer = setTimeout(() => {
          if (rooms[roomId] && rooms[roomId].ownerId === socket.id) {
            io.to(roomId).emit('roomClosed', { message: 'Room expired' });
            delete rooms[roomId];
          }
        }, 30 * 60 * 1000);
        return;
      }
      io.to(roomId).emit('usersUpdate', getUsersWithStatus(room));
    }
  });
});

function getUsersWithStatus(room) {
  const now = Date.now();
  return room.users.map(u => ({
    id: u.id, name: u.name,
    isOwner: u.id === room.ownerId,
    status: now - u.lastActive > IDLE_TIMEOUT ? 'idle' : 'online',
    blocked: u.blocked || { chat: false, play: false, voice: false }
  }));
}

async function searchFromSaavnDev(query) {
  const r = await axios.get(
    'https://saavn.dev/api/search/songs?query=' + encodeURIComponent(query) + '&limit=15',
    { timeout: 10000 }
  );
  const list = r.data?.data?.results || [];
  return list.map(s => ({
    id: s.id, title: s.name,
    artist: s.artists?.primary?.map(a => a.name).join(', ') || 'Unknown',
    duration: s.duration,
    image: s.image?.[2]?.url || s.image?.[1]?.url || s.image?.[0]?.url,
    audioUrl: s.downloadUrl?.[4]?.url || s.downloadUrl?.[3]?.url || s.downloadUrl?.[2]?.url
  }));
}

async function searchFromSaavnNine(query) {
  const r = await axios.get(
    'https://saavnapi-nine.vercel.app/result',
    { params: { query }, timeout: 10000 }
  );
  const list = Array.isArray(r.data) ? r.data : [];
  return list.slice(0, 15).map(s => ({
    id: s.id, title: s.song,
    artist: s.primary_artists || s.singers || 'Unknown',
    duration: parseInt(s.duration) || 0,
    image: s.image,
    audioUrl: s.media_url || s.download_url
  }));
}

app.get('/api/search', async (req, res) => {
  const query = req.query.q;
  if (!query) return res.json({ results: [] });
  try {
    const songs = await searchFromSaavnDev(query);
    if (songs.length > 0) return res.json({ results: songs });
  } catch (e) { console.log('API 1 failed:', e.message); }
  try {
    const songs = await searchFromSaavnNine(query);
    if (songs.length > 0) return res.json({ results: songs });
  } catch (e) { console.log('API 2 failed:', e.message); }
  res.json({ results: [], error: 'Search failed' });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log('🚀 Server running on port ' + PORT);
  console.log('🔐 Admin panel: /admin');
});
