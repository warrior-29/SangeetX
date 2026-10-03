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

const GLOBAL_ROOM_ID = 'global';
const rooms = {};

// ===== BLOCK LISTS =====
const BLOCKED_IPS = new Set();
const BLOCKED_FINGERPRINTS = new Set();

const IDLE_TIMEOUT = 2 * 60 * 1000;
const DISCONNECT_GRACE = 60 * 1000;

// ===== AUTO DJ PLAYLIST =====
const AUTO_DJ_PLAYLIST = [
  'Kesariya Arijit Singh',
  'Tum Hi Ho Arijit Singh',
  'Apna Bana Le Arijit Singh',
  'Raataan Lambiyan Jubin Nautiyal',
  'Channa Mereya Arijit Singh',
  'Shayad Arijit Singh',
  'Tujhe Kitna Chahne Lage Arijit Singh',
  'Dil Diyan Gallan Atif Aslam',
  'Bekhayali Sachet Tandon',
  'Agar Tum Saath Ho Alka Yagnik',
  'Malang Malang',
  'Kabira Arijit Singh',
  'Hawayein Arijit Singh',
  'Pehla Pyaar',
  'Muskurane Arijit Singh'
];

let autoDjIndex = 0;
let autoDjTimer = null;
let autoDjActive = true;
let currentAutoDjTrack = null;

// ===== SIMILAR ARTIST MAPPING =====
const SIMILAR_ARTISTS = {
  'arijit singh': ['atif aslam', 'jubin nautiyal', 'sachet tandon', 'darshan raval'],
  'atif aslam': ['arijit singh', 'jubin nautiyal', 'sonu nigam'],
  'jubin nautiyal': ['arijit singh', 'atif aslam', 'darshan raval'],
  'sachet tandon': ['arijit singh', 'jubin nautiyal', 'darshan raval'],
  'neha kakkar': ['shreya ghoshal', 'sunidhi chauhan', 'dhvani bhanushali'],
  'shreya ghoshal': ['neha kakkar', 'sunidhi chauhan', 'alka yagnik']
};

const analytics = {
  visits: [], totalVisits: 0, uniqueUsers: new Set(),
  roomsCreated: 0, roomsDeleted: 0, songsPlayed: 0,
  messagesSent: 0, reactionsSent: 0,
  activeSessions: new Map(), dailyVisits: {}, hourlyVisits: {}
};

// ===== IP HELPER =====
function getClientIP(socket) {
  const handshake = socket.handshake;
  const forwarded = handshake.headers['x-forwarded-for'];
  const realIP = handshake.headers['x-real-ip'];
  const cfIP = handshake.headers['cf-connecting-ip'];
  
  let ip = cfIP || realIP || forwarded || 
           handshake.address || 
           socket.conn.remoteAddress || 
           'unknown';
  
  if (ip && ip.includes(',')) ip = ip.split(',')[0].trim();
  if (ip && ip.startsWith('::ffff:')) ip = ip.substring(7);
  
  return ip;
}

function isBlocked(socket, fingerprint) {
  const ip = getClientIP(socket);
  
  if (BLOCKED_IPS.has(ip)) return { blocked: true, reason: 'IP', detail: ip };
  if (fingerprint && fingerprint !== 'unknown' && BLOCKED_FINGERPRINTS.has(fingerprint)) {
    return { blocked: true, reason: 'Fingerprint', detail: fingerprint };
  }
  
  return { blocked: false };
}

function ensureGlobalRoom() {
  if (!rooms[GLOBAL_ROOM_ID]) {
    rooms[GLOBAL_ROOM_ID] = {
      roomId: GLOBAL_ROOM_ID,
      ownerId: 'server',
      ownerName: '🌍 Global Room',
      createdAt: Date.now(),
      users: [],
      pending: [],
      messages: [],
      state: { 
        track: null, 
        position: 0, 
        isPlaying: false, 
        playedBy: null,
        playedByName: null,
        autoDj: false,
        lastUpdated: Date.now() 
      },
      isGlobal: true
    };
    console.log('🌍 Global room created');
  }
}
ensureGlobalRoom();
setInterval(ensureGlobalRoom, 30000);

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

// ===== WELCOME MESSAGES =====
const WELCOME_MESSAGES = [
  "Kaise ho? Music sunte hain! 🎵",
  "Welcome! Aaj kya sunna hai?",
  "Hey! Koi gaana suggest karo 🎶",
  "Swagat hai! Enjoy karo 🎉",
  "Hi! Gaana chala do koi",
  "Namaste! Music lovers welcome 🌟"
];

function getRandomWelcome() {
  return WELCOME_MESSAGES[Math.floor(Math.random() * WELCOME_MESSAGES.length)];
}

// ===== GLOBAL STATS =====
app.get('/api/global/stats', (req, res) => {
  ensureGlobalRoom();
  const room = rooms[GLOBAL_ROOM_ID];
  const now = Date.now();
  const online = room.users.filter(u => now - u.lastActive < 2 * 60 * 1000);
  
  res.json({
    totalUsers: room.users.length,
    onlineUsers: online.length,
    currentTrack: room.state.track ? {
      title: room.state.track.title,
      artist: room.state.track.artist,
      isPlaying: room.state.isPlaying,
      playedBy: room.state.playedByName,
      autoDj: room.state.autoDj
    } : null,
    createdAt: room.createdAt
  });
});

// ===== ADMIN ROUTES =====
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
      roomId, 
      ownerName: room.ownerName || 'Global',
      userCount: room.users.length,
      onlineCount: room.users.filter(u => Date.now() - u.lastActive < 2 * 60 * 1000).length,
      messageCount: room.messages.length,
      age,
      isGlobal: room.isGlobal || false,
      currentTrack: room.state.track ? { 
        title: room.state.track.title, 
        artist: room.state.track.artist,
        playedBy: room.state.playedByName,
        autoDj: room.state.autoDj
      } : null,
      isPlaying: room.state.isPlaying,
      users: room.users.map(u => ({
        id: u.id,
        name: u.name,
        ip: u.ip || 'unknown',
        fingerprint: u.fingerprint || 'unknown',
        status: Date.now() - u.lastActive < 2 * 60 * 1000 ? 'online' : 'offline',
        lastActive: u.lastActive,
        blocked: u.blocked || { chat: false, play: false, voice: false }
      }))
    };
  });
  
  res.json({
    totalVisits: analytics.totalVisits,
    uniqueUsers: analytics.uniqueUsers.size,
    todayVisits,
    songsPlayed: analytics.songsPlayed,
    messagesSent: analytics.messagesSent,
    reactionsSent: analytics.reactionsSent,
    activeNow: analytics.activeSessions.size,
    activeRooms: Object.keys(rooms).length,
    blockedCount: BLOCKED_IPS.size + BLOCKED_FINGERPRINTS.size,
    last7Days: last7, hourly,
    recentVisits: analytics.visits.slice(-30).reverse(),
    activeSessions: Array.from(analytics.activeSessions.values()),
    roomsList: activeRooms
  });
});

// ===== ADMIN: BLOCK/UNBLOCK =====
app.post('/api/admin/blockUser', (req, res) => {
  const { password, userId, ip, fingerprint, reason } = req.body;
  if (!isAdmin(password)) return res.status(401).json({ error: 'Unauthorized' });
  
  let blocked = false;
  if (ip && ip !== 'unknown') { BLOCKED_IPS.add(ip); blocked = true; }
  if (fingerprint && fingerprint !== 'unknown') { BLOCKED_FINGERPRINTS.add(fingerprint); blocked = true; }
  if (!blocked) return res.status(400).json({ error: 'No identifier' });
  
  io.sockets.sockets.forEach(s => {
    if ((ip && s.userIP === ip) || (fingerprint && s.userFingerprint === fingerprint) || (userId && s.id === userId)) {
      s.emit('blocked', { message: 'You have been blocked', reason: reason || 'Rule violation' });
      setTimeout(() => s.disconnect(true), 500);
    }
  });
  
  const room = rooms[GLOBAL_ROOM_ID];
  if (room) {
    room.users = room.users.filter(u => {
      if ((ip && u.ip === ip) || (fingerprint && u.fingerprint === fingerprint)) return false;
      return true;
    });
    io.to(GLOBAL_ROOM_ID).emit('usersUpdate', getUsersWithStatus(room));
  }
  
  res.json({ success: true });
});

app.post('/api/admin/unblockUser', (req, res) => {
  const { password, ip, fingerprint } = req.body;
  if (!isAdmin(password)) return res.status(401).json({ error: 'Unauthorized' });
  if (ip) BLOCKED_IPS.delete(ip);
  if (fingerprint) BLOCKED_FINGERPRINTS.delete(fingerprint);
  res.json({ success: true });
});

app.get('/api/admin/blockedList', (req, res) => {
  const { password } = req.query;
  if (!isAdmin(password)) return res.status(401).json({ error: 'Unauthorized' });
  res.json({
    blockedIPs: Array.from(BLOCKED_IPS),
    blockedFingerprints: Array.from(BLOCKED_FINGERPRINTS),
    total: BLOCKED_IPS.size + BLOCKED_FINGERPRINTS.size
  });
});

app.post('/api/admin/kickUser', (req, res) => {
  const { password, userId } = req.body;
  if (!isAdmin(password)) return res.status(401).json({ error: 'Unauthorized' });
  const s = io.sockets.sockets.get(userId);
  if (s) {
    s.emit('kicked', { message: 'Admin removed you' });
    setTimeout(() => s.disconnect(true), 500);
  }
  res.json({ success: true });
});

app.post('/api/admin/blockAction', (req, res) => {
  const { password, userId, action, block } = req.body;
  if (!isAdmin(password)) return res.status(401).json({ error: 'Unauthorized' });
  const room = rooms[GLOBAL_ROOM_ID];
  if (!room) return res.status(404).json({ error: 'Room not found' });
  const user = room.users.find(u => u.id === userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (!user.blocked) user.blocked = { chat: false, play: false, voice: false };
  if (['chat', 'play', 'voice'].includes(action)) user.blocked[action] = !!block;
  const s = io.sockets.sockets.get(userId);
  if (s) s.emit('permissionsUpdate', { blocked: user.blocked });
  io.to(GLOBAL_ROOM_ID).emit('usersUpdate', getUsersWithStatus(room));
  res.json({ success: true, blocked: user.blocked });
});

app.post('/api/admin/deleteMessage', (req, res) => {
  const { password, messageId } = req.body;
  if (!isAdmin(password)) return res.status(401).json({ error: 'Unauthorized' });
  const room = rooms[GLOBAL_ROOM_ID];
  if (!room) return res.status(404).json({ error: 'Room not found' });
  const index = room.messages.findIndex(m => m.id === messageId);
  if (index === -1) return res.status(404).json({ error: 'Message not found' });
  room.messages.splice(index, 1);
  io.to(GLOBAL_ROOM_ID).emit('messageDeleted', { messageId });
  res.json({ success: true });
});

app.get('/api/admin/roomChat', (req, res) => {
  const { password } = req.query;
  if (!isAdmin(password)) return res.status(401).json({ error: 'Unauthorized' });
  const room = rooms[GLOBAL_ROOM_ID];
  if (!room) return res.status(404).json({ error: 'Room not found' });
  res.json({ messages: room.messages });
});

// ============================================================
// 🎵 SONG SEARCH + AUTO-NEXT ENGINE
// ============================================================

async function searchSong(query) {
  try {
    const r = await axios.get(
      'https://saavn.dev/api/search/songs?query=' + encodeURIComponent(query) + '&limit=1',
      { timeout: 8000 }
    );
    const list = r.data?.data?.results || [];
    if (list.length > 0) {
      const s = list[0];
      return {
        id: s.id, title: s.name,
        artist: s.artists?.primary?.map(a => a.name).join(', ') || 'Unknown',
        duration: s.duration,
        image: s.image?.[2]?.url || s.image?.[1]?.url || s.image?.[0]?.url,
        audioUrl: s.downloadUrl?.[4]?.url || s.downloadUrl?.[3]?.url || s.downloadUrl?.[2]?.url
      };
    }
  } catch (e) { console.log('Search error:', e.message); }
  return null;
}

async function searchSimilarSongs(query, exclude = []) {
  try {
    const r = await axios.get(
      'https://saavn.dev/api/search/songs?query=' + encodeURIComponent(query) + '&limit=10',
      { timeout: 8000 }
    );
    const list = r.data?.data?.results || [];
    const filtered = list.filter(s => !exclude.includes(s.id));
    return filtered.map(s => ({
      id: s.id, title: s.name,
      artist: s.artists?.primary?.map(a => a.name).join(', ') || 'Unknown',
      duration: s.duration,
      image: s.image?.[2]?.url || s.image?.[1]?.url || s.image?.[0]?.url,
      audioUrl: s.downloadUrl?.[4]?.url || s.downloadUrl?.[3]?.url || s.downloadUrl?.[2]?.url
    }));
  } catch (e) { return []; }
}

// ✅ Get next song based on context (artist/mood)
async function getNextSongFromContext(currentTrack, playedHistory = []) {
  if (!currentTrack) return null;
  
  const artist = (currentTrack.artist || '').split(',')[0].trim();
  const title = currentTrack.title || '';
  
  // ✅ Try 1: Same artist ke aur songs
  if (artist && artist !== 'Unknown') {
    const artistSongs = await searchSimilarSongs(artist, [currentTrack.id, ...playedHistory]);
    if (artistSongs.length > 0) {
      console.log(`🎵 Next from same artist: ${artist}`);
      return artistSongs[0];
    }
  }
  
  // ✅ Try 2: Similar artist ke songs
  const artistLower = artist.toLowerCase();
  const similarArtists = SIMILAR_ARTISTS[artistLower];
  if (similarArtists && similarArtists.length > 0) {
    for (const simArtist of similarArtists) {
      const songs = await searchSimilarSongs(simArtist, [currentTrack.id, ...playedHistory]);
      if (songs.length > 0) {
        console.log(`🎵 Next from similar artist: ${simArtist}`);
        return songs[0];
      }
    }
  }
  
  // ✅ Try 3: Song title keyword search
  const keyword = title.split(' ')[0];
  if (keyword && keyword.length > 3) {
    const keywordSongs = await searchSimilarSongs(keyword, [currentTrack.id, ...playedHistory]);
    if (keywordSongs.length > 0) {
      console.log(`🎵 Next from keyword: ${keyword}`);
      return keywordSongs[0];
    }
  }
  
  // ✅ Fallback: Auto DJ playlist
  return null;
}

// ✅ Play next song
async function playNextSong(reason = 'auto') {
  const room = rooms[GLOBAL_ROOM_ID];
  if (!room) return;
  
  const playedHistory = room.playedHistory || [];
  let nextSong = null;
  
  // Context-based
  if (reason === 'auto' || reason === 'next') {
    nextSong = await getNextSongFromContext(room.state.track, playedHistory);
  }
  
  // Fallback: Auto DJ playlist
  if (!nextSong) {
    const songName = AUTO_DJ_PLAYLIST[autoDjIndex % AUTO_DJ_PLAYLIST.length];
    autoDjIndex++;
    nextSong = await searchSong(songName);
    console.log(`🎵 Next from Auto DJ: ${songName}`);
  }
  
  if (!nextSong) return;
  
  // Track history (last 20)
  if (!room.playedHistory) room.playedHistory = [];
  if (room.state.track) {
    room.playedHistory.push(room.state.track.id);
    if (room.playedHistory.length > 20) room.playedHistory.shift();
  }
  
  // Update state
  room.state = {
    track: nextSong,
    position: 0,
    isPlaying: true,
    playedBy: null,
    playedByName: reason === 'next' ? '⏭️ Skip' : '🎵 Auto DJ',
    autoDj: reason !== 'user',
    lastUpdated: Date.now()
  };
  
  console.log(`🎵 Playing: ${nextSong.title} (${reason})`);
  
  io.to(GLOBAL_ROOM_ID).emit('stateSync', room.state);
  io.to(GLOBAL_ROOM_ID).emit('songChanged', {
    track: nextSong,
    reason: reason,
    playedBy: room.state.playedByName
  });
}

// ✅ Check if song ended (every 2 sec)
function startSongEndCheck() {
  setInterval(async () => {
    const room = rooms[GLOBAL_ROOM_ID];
    if (!room || !room.state.track || !room.state.isPlaying) return;
    
    // Duration check (in seconds)
    const duration = room.state.track.duration || 0;
    const position = room.state.position || 0;
    const lastUpdated = room.state.lastUpdated || Date.now();
    
    // Estimate current position
    const elapsed = (Date.now() - lastUpdated) / 1000;
    const estimatedPos = position + elapsed;
    
    // ✅ Song ended? (2 sec tolerance)
    if (duration > 0 && estimatedPos >= duration - 2) {
      console.log(`🎵 Song ended, auto-playing next...`);
      await playNextSong('auto');
    }
  }, 3000);
}

// ✅ Auto DJ initial start
function startAutoDj() {
  setTimeout(async () => {
    const room = rooms[GLOBAL_ROOM_ID];
    if (room && !room.state.track) {
      await playNextSong('auto');
    }
  }, 3000);
}

// ===== SOCKET.IO =====
io.on('connection', (socket) => {
  const ip = getClientIP(socket);
  const fp = socket.handshake.auth?.fingerprint || 
             socket.handshake.query?.fingerprint ||
             'unknown';
  
  console.log('Connected:', socket.id, 'IP:', ip);
  
  const blockStatus = isBlocked(socket, fp);
  if (blockStatus.blocked) {
    socket.emit('blocked', { 
      message: 'You have been blocked from this room',
      reason: blockStatus.reason
    });
    setTimeout(() => socket.disconnect(true), 1000);
    return;
  }
  
  // ===== JOIN GLOBAL =====
  socket.on('joinGlobal', ({ userName, fingerprint }) => {
    ensureGlobalRoom();
    const room = rooms[GLOBAL_ROOM_ID];
    const userFp = fingerprint || fp;
    
    if (BLOCKED_IPS.has(ip) || (userFp && BLOCKED_FINGERPRINTS.has(userFp))) {
      socket.emit('blocked', { message: 'You are blocked' });
      setTimeout(() => socket.disconnect(true), 500);
      return;
    }
    
    // Direct join
    let existingUser = room.users.find(u => u.fingerprint === userFp);
    
    if (existingUser) {
      const oldSocket = io.sockets.sockets.get(existingUser.id);
      if (oldSocket && oldSocket.id !== socket.id) {
        oldSocket.leave(GLOBAL_ROOM_ID);
      }
      existingUser.id = socket.id;
      existingUser.name = userName;
      existingUser.lastActive = Date.now();
      existingUser.status = 'online';
      existingUser.ip = ip;
      delete existingUser.disconnectedAt;
      console.log(`🔄 Reconnect: ${userName}`);
    } else {
      room.users.push({
        id: socket.id, name: userName, ip: ip, fingerprint: userFp,
        lastActive: Date.now(), status: 'online',
        blocked: { chat: false, play: false, voice: false },
        location: null, chatActive: false, joinedAt: Date.now()
      });
      console.log(`👋 New: ${userName}`);
    }
    
    socket.join(GLOBAL_ROOM_ID);
    socket.roomId = GLOBAL_ROOM_ID;
    socket.userName = userName;
    socket.userIP = ip;
    socket.userFingerprint = userFp;
    
    recordVisit(userName, GLOBAL_ROOM_ID, socket.handshake.headers['user-agent'] || 'unknown');
    analytics.activeSessions.set(socket.id, {
      name: userName, roomId: GLOBAL_ROOM_ID, joinedAt: Date.now(), role: 'member'
    });
    
    socket.emit('joinResult', { 
      success: true, 
      roomId: GLOBAL_ROOM_ID,
      isGlobal: true, 
      isOwner: false 
    });
    socket.emit('stateSync', room.state);
    socket.emit('chatHistory', room.messages);
    
    io.to(GLOBAL_ROOM_ID).emit('usersUpdate', getUsersWithStatus(room));
    io.to(GLOBAL_ROOM_ID).emit('globalStats', {
      totalUsers: room.users.length,
      onlineUsers: room.users.filter(u => 
        u.status !== 'disconnected' && 
        Date.now() - u.lastActive < 2 * 60 * 1000
      ).length
    });
    
    // Welcome
    io.to(GLOBAL_ROOM_ID).emit('userJoined', {
      userName,
      message: `${userName} joined 🎉`
    });
    
    setTimeout(() => {
      const botMsg = {
        id: 'bot-' + Date.now(),
        userId: 'bot', userName: '🤖 Music Bot',
        text: getRandomWelcome(),
        time: Date.now(), type: 'bot'
      };
      socket.emit('chatMessage', botMsg);
    }, 3000);
    
    console.log(`🌍 ${userName} joined (${room.users.length} total)`);
  });
  
  // ===== UPDATE STATE (User plays song) =====
  socket.on('updateState', ({ roomId, newState }) => {
    const room = rooms[roomId || GLOBAL_ROOM_ID];
    if (!room) return;
    const user = room.users.find(u => u.id === socket.id);
    if (!user) return;
    user.lastActive = Date.now();
    
    if (user.blocked && user.blocked.play) {
      socket.emit('permissionDenied', { action: 'play', message: 'You are blocked' });
      return;
    }
    
    // ✅ User played a song — mark who
    if (newState.track) {
      newState.autoDj = false;
      newState.playedBy = socket.id;
      newState.playedByName = user.name;
      console.log(`🎵 ${user.name} playing: ${newState.track.title}`);
      
      // Add to history
      if (!room.playedHistory) room.playedHistory = [];
      if (room.state.track && room.state.track.id !== newState.track.id) {
        room.playedHistory.push(room.state.track.id);
        if (room.playedHistory.length > 20) room.playedHistory.shift();
      }
    }
    
    if (newState.track && (!room.state.track || room.state.track.id !== newState.track.id)) {
      analytics.songsPlayed++;
    }
    
    room.state = { ...room.state, ...newState, lastUpdated: Date.now() };
    socket.to(room.roomId).emit('stateSync', room.state);
    io.to(room.roomId).emit('usersUpdate', getUsersWithStatus(room));
  });
  
  // ===== NEXT BUTTON (User requests next) =====
  socket.on('requestNext', async ({ roomId }) => {
    const room = rooms[roomId || GLOBAL_ROOM_ID];
    if (!room) return;
    const user = room.users.find(u => u.id === socket.id);
    if (!user) return;
    user.lastActive = Date.now();
    
    if (user.blocked && user.blocked.play) {
      socket.emit('permissionDenied', { action: 'play', message: 'You are blocked' });
      return;
    }
    
    console.log(`⏭️ ${user.name} requested next`);
    
    // Broadcast who skipped
    io.to(room.roomId).emit('skipNotice', {
      userName: user.name,
      message: `${user.name} skipped ⏭️`
    });
    
    // Play next in same context
    await playNextSong('next');
  });
  
  // ===== HEARTBEAT =====
  socket.on('heartbeat', ({ roomId, position, isPlaying }) => {
    const room = rooms[roomId || GLOBAL_ROOM_ID];
    if (!room) return;
    const user = room.users.find(u => u.id === socket.id);
    if (!user) return;
    user.lastActive = Date.now();
    if (user.blocked && user.blocked.play) return;
    room.state.position = position;
    room.state.isPlaying = isPlaying;
    room.state.lastUpdated = Date.now();
    socket.to(room.roomId).emit('heartbeat', { position, isPlaying });
  });
  
  socket.on('activity', ({ roomId }) => {
    const room = rooms[roomId || GLOBAL_ROOM_ID];
    if (!room) return;
    const user = room.users.find(u => u.id === socket.id);
    if (user) user.lastActive = Date.now();
  });
  
  socket.on('chatMessage', ({ roomId, text, mentions }) => {
    const room = rooms[roomId || GLOBAL_ROOM_ID];
    if (!room) return;
    const user = room.users.find(u => u.id === socket.id);
    if (!user) return;
    user.lastActive = Date.now();
    if (user.blocked && user.blocked.chat) {
      socket.emit('permissionDenied', { action: 'chat', message: 'You are blocked' });
      return;
    }
    analytics.messagesSent++;
    const msg = {
      id: Date.now() + '-' + Math.random().toString(36).slice(2, 7),
      userId: socket.id, userName: user.name,
      text: String(text).slice(0, 500), mentions: mentions || [],
      time: Date.now(), type: 'text'
    };
    room.messages.push(msg);
    if (room.messages.length > 100) room.messages.shift();
    io.to(room.roomId).emit('chatMessage', msg);
  });
  
  socket.on('voiceSignal', ({ roomId, signal }) => {
    const room = rooms[roomId || GLOBAL_ROOM_ID];
    if (!room) return;
    const user = room.users.find(u => u.id === socket.id);
    if (user && user.blocked && user.blocked.voice) return;
    socket.to(room.roomId).emit('voiceSignal', { signal, from: socket.id, userName: user?.name });
  });
  
  socket.on('pttState', ({ roomId, isTalking }) => {
    const room = rooms[roomId || GLOBAL_ROOM_ID];
    if (!room) return;
    const user = room.users.find(u => u.id === socket.id);
    if (!user) return;
    user.lastActive = Date.now();
    if (user.blocked && user.blocked.voice) return;
    socket.to(room.roomId).emit('pttState', { userName: user.name, isTalking });
  });
  
  socket.on('reaction', ({ roomId, emoji }) => {
    const room = rooms[roomId || GLOBAL_ROOM_ID];
    if (!room) return;
    const user = room.users.find(u => u.id === socket.id);
    if (user) user.lastActive = Date.now();
    analytics.reactionsSent++;
    socket.to(room.roomId).emit('reaction', { emoji, userName: user?.name });
  });
  
  socket.on('chatPresence', ({ roomId, active }) => {
    const room = rooms[roomId || GLOBAL_ROOM_ID];
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
  });
  
  socket.on('typing', ({ roomId, isTyping }) => {
    const room = rooms[roomId || GLOBAL_ROOM_ID];
    if (!room) return;
    const user = room.users.find(u => u.id === socket.id);
    if (!user) return;
    socket.to(room.roomId).emit('userTyping', {
      userName: user.name, userId: socket.id, isTyping: !!isTyping
    });
  });
  
  socket.on('moodUpdate', ({ roomId, mood, emoji, text, color }) => {
    const room = rooms[roomId || GLOBAL_ROOM_ID];
    if (!room) return;
    const user = room.users.find(u => u.id === socket.id);
    if (user) user.lastActive = Date.now();
    socket.to(room.roomId).emit('partnerMood', { mood, emoji, text, color });
  });
  
  socket.on('shareLocation', ({ roomId, location }) => {
    const room = rooms[roomId || GLOBAL_ROOM_ID];
    if (!room) return;
    if (!location || typeof location.lat !== 'number' || typeof location.lng !== 'number') return;
    const user = room.users.find(u => u.id === socket.id);
    if (user) { user.location = location; user.lastActive = Date.now(); }
    socket.to(room.roomId).emit('partnerLocation', { location, userId: socket.id, userName: user?.name });
  });
  
  socket.on('syncPing', ({ roomId, clientTime }) => {
    socket.emit('syncPong', { clientTime, serverTime: Date.now() });
  });
  
  socket.on('disconnect', () => {
    const roomId = socket.roomId;
    analytics.activeSessions.delete(socket.id);
    
    if (roomId && rooms[roomId]) {
      const room = rooms[roomId];
      const user = room.users.find(u => u.id === socket.id);
      
      if (user) {
        user.status = 'disconnected';
        user.disconnectedAt = Date.now();
        
        io.to(roomId).emit('usersUpdate', getUsersWithStatus(room));
        io.to(roomId).emit('globalStats', {
          totalUsers: room.users.length,
          onlineUsers: room.users.filter(u => 
            u.status !== 'disconnected' && 
            Date.now() - u.lastActive < 2 * 60 * 1000
          ).length
        });
        
        setTimeout(() => {
          const r = rooms[roomId];
          if (!r) return;
          const u = r.users.find(x => x.id === socket.id);
          if (u && u.status === 'disconnected') {
            r.users = r.users.filter(x => x.id !== socket.id);
            io.to(roomId).emit('usersUpdate', getUsersWithStatus(r));
          }
        }, DISCONNECT_GRACE);
      }
    }
  });
});

function getUsersWithStatus(room) {
  const now = Date.now();
  return room.users.map(u => ({
    id: u.id, name: u.name, isOwner: false, isGlobal: true,
    status: u.status === 'disconnected' ? 'idle' :
            now - u.lastActive > IDLE_TIMEOUT ? 'idle' : 'online',
    blocked: u.blocked || { chat: false, play: false, voice: false }
  }));
}

// ===== SEARCH APIs =====
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
  console.log('🌍 Global room mode');
  console.log('🎵 Auto DJ started');
  startAutoDj();
  startSongEndCheck();
  console.log('🔐 Admin panel: /admin');
});
