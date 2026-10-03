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

const BLOCKED_IPS = new Set();
const BLOCKED_FINGERPRINTS = new Set();
const GLOBAL_MUTED_USERS = new Set();

let currentAnnouncement = null;

const IDLE_TIMEOUT = 2 * 60 * 1000;
const DISCONNECT_GRACE = 30 * 1000;

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
  'Kabira Arijit Singh',
  'Hawayein Arijit Singh',
  'Muskurane Arijit Singh'
];

let autoDjIndex = 0;

const SIMILAR_ARTISTS = {
  'arijit singh': ['atif aslam', 'jubin nautiyal', 'sachet tandon', 'darshan raval', 'sonu nigam', 'armaan malik'],
  'atif aslam': ['arijit singh', 'jubin nautiyal', 'sonu nigam', 'darshan raval', 'rahat fateh ali khan'],
  'jubin nautiyal': ['arijit singh', 'atif aslam', 'darshan raval', 'sachet tandon', 'armaan malik'],
  'sachet tandon': ['arijit singh', 'jubin nautiyal', 'darshan raval', 'parampara tandon'],
  'darshan raval': ['jubin nautiyal', 'arijit singh', 'sachet tandon', 'armaan malik'],
  'armaan malik': ['arijit singh', 'jubin nautiyal', 'darshan raval'],
  'sonu nigam': ['arijit singh', 'udit narayan', 'kumar sanu', 'shaan'],
  'udit narayan': ['sonu nigam', 'kumar sanu', 'shaan', 'alka yagnik'],
  'kumar sanu': ['udit narayan', 'sonu nigam', 'alka yagnik'],
  'shaan': ['sonu nigam', 'udit narayan', 'kk'],
  'kk': ['shaan', 'sonu nigam', 'mohit chauhan'],
  'mohit chauhan': ['kk', 'sonu nigam', 'papon'],
  'neha kakkar': ['shreya ghoshal', 'sunidhi chauhan', 'dhvani bhanushali', 'jasmine sandlas'],
  'shreya ghoshal': ['neha kakkar', 'sunidhi chauhan', 'alka yagnik', 'shilpa rao'],
  'sunidhi chauhan': ['shreya ghoshal', 'neha kakkar', 'alka yagnik'],
  'alka yagnik': ['shreya ghoshal', 'sunidhi chauhan', 'sadhana sargam'],
  'dhvani bhanushali': ['neha kakkar', 'jasmine sandlas', 'akasa singh'],
  'jasmine sandlas': ['dhvani bhanushali', 'neha kakkar', 'guru randhawa'],
  'akasa singh': ['dhvani bhanushali', 'neha kakkar'],
  'shilpa rao': ['shreya ghoshal', 'sunidhi chauhan'],
  'sadhana sargam': ['alka yagnik', 'shreya ghoshal'],
  'guru randhawa': ['jasmine sandlas', 'badshah', 'harrdy sandhu', 'diljit dosanjh'],
  'diljit dosanjh': ['guru randhawa', 'harrdy sandhu', 'badshah', 'ammy virk'],
  'badshah': ['guru randhawa', 'yo yo honey singh', 'diljit dosanjh'],
  'harrdy sandhu': ['guru randhawa', 'diljit dosanjh', 'ammy virk'],
  'yo yo honey singh': ['badshah', 'guru randhawa'],
  'ammy virk': ['diljit dosanjh', 'harrdy sandhu', 'guru randhawa'],
  'rahat fateh ali khan': ['atif aslam', 'nusrat fateh ali khan', 'ali zafar'],
  'nusrat fateh ali khan': ['rahat fateh ali khan', 'atif aslam'],
  'ali zafar': ['rahat fateh ali khan', 'atif aslam', 'ali sethi'],
  'sid sriram': ['a.r. rahman', 'anirudh ravichander', 'harris jayaraj'],
  'a.r. rahman': ['sid sriram', 'anirudh ravichander', 'harris jayaraj'],
  'anirudh ravichander': ['sid sriram', 'a.r. rahman', 'yuvan shankar raja'],
  'pritam': ['arijit singh', 'amit trivedi', 'vishal shekhar'],
  'amit trivedi': ['pritam', 'arijit singh', 'vishal shekhar'],
  'vishal shekhar': ['pritam', 'shankar ehsaan loy', 'amit trivedi'],
  'shankar ehsaan loy': ['vishal shekhar', 'pritam', 'a.r. rahman']
};

const analytics = {
  visits: [], totalVisits: 0, uniqueUsers: new Set(),
  roomsCreated: 0, roomsDeleted: 0, songsPlayed: 0,
  messagesSent: 0, reactionsSent: 0,
  activeSessions: new Map(), dailyVisits: {}, hourlyVisits: {}
};

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

function isGloballyMuted(userName) {
  if (!userName) return false;
  return GLOBAL_MUTED_USERS.has(userName.toLowerCase());
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
        isAmbient: false,
        lastUpdated: Date.now()
      },
      playedHistory: [],
      isGlobal: true,
      _lastAutoDjAttempt: 0
    };
    console.log('🌍 Global room created');
  }
}
ensureGlobalRoom();
setInterval(ensureGlobalRoom, 30000);

// ✅ Real-time position calculator — hamesha live position deta hai
function getCurrentPosition(room) {
  if (!room || !room.state.track) return 0;
  if (!room.state.isPlaying) return room.state.position || 0;

  const lastUpdated = room.state.lastUpdated || Date.now();
  const elapsed = (Date.now() - lastUpdated) / 1000;
  let pos = (room.state.position || 0) + elapsed;

  // Agar duration se zyada ho gaya to 0 kar do
  if (room.state.track.duration > 0 && pos >= room.state.track.duration) {
    pos = 0;
  }
  return pos;
}

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

function getApproxLocation(lat, lng) {
  const cities = [
    {name:'Delhi',lat:28.6139,lng:77.2090},{name:'Mumbai',lat:19.0760,lng:72.8777},
    {name:'Bangalore',lat:12.9716,lng:77.5946},{name:'Kolkata',lat:22.5726,lng:88.3639},
    {name:'Chennai',lat:13.0827,lng:80.2707},{name:'Hyderabad',lat:17.3850,lng:78.4867},
    {name:'Pune',lat:18.5204,lng:73.8567},{name:'Jaipur',lat:26.9124,lng:75.7873},
    {name:'Lucknow',lat:26.8467,lng:80.9462},{name:'Ahmedabad',lat:23.0225,lng:72.5714},
    {name:'Surat',lat:21.1702,lng:72.8311},{name:'Kanpur',lat:26.4499,lng:80.3319},
    {name:'Nagpur',lat:21.1458,lng:79.0882},{name:'Indore',lat:22.7196,lng:75.8577},
    {name:'Bhopal',lat:23.2599,lng:77.4126},{name:'Patna',lat:25.5941,lng:85.1376},
    {name:'Varanasi',lat:25.3176,lng:82.9739},{name:'Agra',lat:27.1767,lng:78.0081},
    {name:'Noida',lat:28.5355,lng:77.3910},{name:'Gurgaon',lat:28.4595,lng:77.0266},
    {name:'Chandigarh',lat:30.7333,lng:76.7794},{name:'Goa',lat:15.2993,lng:74.1240},
    {name:'Kochi',lat:9.9312,lng:76.2673},{name:'Guwahati',lat:26.1445,lng:91.7362},
    {name:'London',lat:51.5074,lng:-0.1278},{name:'New York',lat:40.7128,lng:-74.0060},
    {name:'Dubai',lat:25.2048,lng:55.2708},{name:'Singapore',lat:1.3521,lng:103.8198},
    {name:'Tokyo',lat:35.6762,lng:139.6503},{name:'Sydney',lat:-33.8688,lng:151.2093},
    {name:'Toronto',lat:43.6532,lng:-79.3832},{name:'Los Angeles',lat:34.0522,lng:-118.2437},
    {name:'Paris',lat:48.8566,lng:2.3522},{name:'Berlin',lat:52.5200,lng:13.4050},
    {name:'Moscow',lat:55.7558,lng:37.6173},{name:'São Paulo',lat:-23.5505,lng:-46.6333},
    {name:'Cape Town',lat:-33.9249,lng:18.4241},{name:'Seoul',lat:37.5665,lng:126.9780}
  ];
  let n=cities[0],md=Infinity;
  cities.forEach(c=>{
    const d=Math.sqrt((c.lat-lat)**2+(c.lng-lng)**2);
    if(d<md){md=d;n=c;}
  });
  return n.name;
}

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
    announcement: currentAnnouncement,
    createdAt: room.createdAt
  });
});

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
        blocked: u.blocked || { chat: false, play: false, voice: false },
        globallyMuted: isGloballyMuted(u.name)
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
    globallyMutedCount: GLOBAL_MUTED_USERS.size,
    currentAnnouncement,
    last7Days: last7, hourly,
    recentVisits: analytics.visits.slice(-30).reverse(),
    activeSessions: Array.from(analytics.activeSessions.values()),
    roomsList: activeRooms
  });
});

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

  console.log(`🚫 Blocked: IP=${ip}, FP=${fingerprint}`);
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
  const { password, userId, roomId } = req.body;
  if (!isAdmin(password)) return res.status(401).json({ error: 'Unauthorized' });

  console.log(`👢 Kick request: userId=${userId}, roomId=${roomId}`);

  let s = io.sockets.sockets.get(userId);

  if (!s && roomId && rooms[roomId]) {
    const room = rooms[roomId];
    const user = room.users.find(u => u.id === userId || u.name === userId);
    if (user) {
      s = io.sockets.sockets.get(user.id);
      if (!s) {
        room.users = room.users.filter(u => u.id !== user.id);
        io.to(roomId).emit('usersUpdate', getUsersWithStatus(room));
        return res.json({ success: true });
      }
    }
  }

  if (s) {
    s.emit('kicked', { message: 'Admin removed you' });
    if (roomId && rooms[roomId]) {
      const room = rooms[roomId];
      room.users = room.users.filter(u => u.id !== s.id);
      io.to(roomId).emit('usersUpdate', getUsersWithStatus(room));
    }
    setTimeout(() => {
      try { s.disconnect(true); } catch (e) {}
    }, 500);
    console.log(`✅ Kicked user: ${userId}`);
    res.json({ success: true });
  } else {
    console.log(`⚠️ User not found: ${userId}`);
    res.json({ success: false, error: 'User not found' });
  }
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

app.post('/api/admin/globalMute', (req, res) => {
  const { password, userId, mute } = req.body;
  if (!isAdmin(password)) return res.status(401).json({ error: 'Unauthorized' });

  const room = rooms[GLOBAL_ROOM_ID];
  if (!room) return res.status(404).json({ error: 'Room not found' });

  const user = room.users.find(u => u.id === userId);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const userNameKey = user.name.toLowerCase();

  if (mute) GLOBAL_MUTED_USERS.add(userNameKey);
  else GLOBAL_MUTED_USERS.delete(userNameKey);

  user.globallyMuted = !!mute;

  io.to(GLOBAL_ROOM_ID).emit('globalMuteUpdate', {
    userId: user.id,
    userName: user.name,
    muted: !!mute
  });

  const targetSocket = io.sockets.sockets.get(userId);
  if (targetSocket) {
    targetSocket.emit('youAreMuted', { muted: !!mute, by: '👑 Admin' });
  }

  io.to(GLOBAL_ROOM_ID).emit('usersUpdate', getUsersWithStatus(room));

  console.log(`🔇 Global mute: ${user.name} → ${mute ? 'MUTED' : 'UNMUTED'}`);
  res.json({ success: true, muted: !!mute });
});

app.get('/api/admin/globalMutedList', (req, res) => {
  const { password } = req.query;
  if (!isAdmin(password)) return res.status(401).json({ error: 'Unauthorized' });
  res.json({
    mutedUsers: Array.from(GLOBAL_MUTED_USERS),
    total: GLOBAL_MUTED_USERS.size
  });
});

app.post('/api/admin/forceSkip', async (req, res) => {
  const { password, searchQuery } = req.body;
  if (!isAdmin(password)) return res.status(401).json({ error: 'Unauthorized' });

  const room = rooms[GLOBAL_ROOM_ID];
  if (!room) return res.status(404).json({ error: 'Room not found' });

  let track = null;

  if (searchQuery && searchQuery.trim()) {
    track = await searchSong(searchQuery.trim());
    console.log(`🎵 Admin force search: "${searchQuery}" → ${track?.title || 'not found'}`);
  }

  if (!track) {
    const songName = AUTO_DJ_PLAYLIST[autoDjIndex % AUTO_DJ_PLAYLIST.length];
    autoDjIndex++;
    track = await searchSong(songName);
    console.log(`🎵 Admin force skip: ${songName}`);
  }

  if (!track) return res.status(404).json({ error: 'Song not found' });

  if (!room.playedHistory) room.playedHistory = [];
  if (room.state.track && !room.state.isAmbient) {
    room.playedHistory.push(room.state.track.id);
    if (room.playedHistory.length > 20) room.playedHistory.shift();
  }

  room.state = {
    track: track,
    position: 0,
    isPlaying: true,
    playedBy: 'admin',
    playedByName: '👑 Admin',
    autoDj: false,
    isAmbient: false,
    lastUpdated: Date.now()
  };

  io.to(GLOBAL_ROOM_ID).emit('stateSync', room.state);
  io.to(GLOBAL_ROOM_ID).emit('songChanged', {
    track: track,
    reason: 'admin',
    playedBy: '👑 Admin'
  });
  io.to(GLOBAL_ROOM_ID).emit('adminForceSkip', {
    track,
    message: `👑 Admin skipped to: ${track.title}`
  });

  console.log(`👑 Admin forced: ${track.title}`);
  res.json({ success: true, track });
});

app.post('/api/admin/announce', (req, res) => {
  const { password, message, duration } = req.body;
  if (!isAdmin(password)) return res.status(401).json({ error: 'Unauthorized' });
  if (!message || !message.trim()) return res.status(400).json({ error: 'Message required' });

  const announceMsg = String(message).slice(0, 300);
  const dur = Math.min(Math.max(parseInt(duration) || 10000, 2000), 60000);

  currentAnnouncement = {
    message: announceMsg,
    by: '👑 Admin',
    at: Date.now(),
    duration: dur
  };

  io.to(GLOBAL_ROOM_ID).emit('adminAnnounce', currentAnnouncement);

  console.log(`📢 Admin announce: ${announceMsg} (${dur}ms)`);

  setTimeout(() => {
    if (currentAnnouncement && currentAnnouncement.at === currentAnnouncement.at &&
        Date.now() - currentAnnouncement.at >= dur - 200) {
      currentAnnouncement = null;
      io.to(GLOBAL_ROOM_ID).emit('adminAnnounce', null);
      console.log('📢 Announcement cleared');
    }
  }, dur);

  res.json({ success: true, announcement: currentAnnouncement });
});

app.post('/api/admin/clearAnnounce', (req, res) => {
  const { password } = req.body;
  if (!isAdmin(password)) return res.status(401).json({ error: 'Unauthorized' });
  currentAnnouncement = null;
  io.to(GLOBAL_ROOM_ID).emit('adminAnnounce', null);
  res.json({ success: true });
});

async function searchSong(query) {
  const q = encodeURIComponent(query);

  const tryAPI1 = async () => {
    try {
      const r = await axios.get(
        `https://saavn.dev/api/search/songs?query=${q}&limit=1`,
        { timeout: 5000 }
      );
      const list = r.data?.data?.results || [];
      if (list.length > 0) {
        const s = list[0];
        const audioUrl = s.downloadUrl?.[4]?.url || s.downloadUrl?.[3]?.url || s.downloadUrl?.[2]?.url;
        if (audioUrl) {
          return {
            id: s.id, title: s.name,
            artist: s.artists?.primary?.map(a => a.name).join(', ') || 'Unknown',
            duration: s.duration,
            image: s.image?.[2]?.url || s.image?.[1]?.url || s.image?.[0]?.url,
            audioUrl,
            _src: 'API1'
          };
        }
      }
    } catch (e) {}
    return null;
  };

  const tryAPI2 = async () => {
    try {
      const r = await axios.get(
        `https://saavnapi-nine.vercel.app/result?query=${q}`,
        { timeout: 5000 }
      );
      const list = Array.isArray(r.data) ? r.data : [];
      if (list.length > 0) {
        const s = list[0];
        const audioUrl = s.media_url || s.download_url || s.url;
        if (audioUrl) {
          return {
            id: s.id || Date.now().toString(),
            title: s.song || s.title || query,
            artist: s.primary_artists || s.singers || 'Unknown',
            duration: parseInt(s.duration) || 0,
            image: s.image,
            audioUrl,
            _src: 'API2'
          };
        }
      }
    } catch (e) {}
    return null;
  };

  const tryAPI3 = async () => {
    try {
      const r = await axios.get(
        `https://jiosaavn-api-2-harsh-patel.vercel.app/search/songs?query=${q}`,
        { timeout: 5000 }
      );
      const list = r.data?.data?.results || r.data?.results || [];
      if (list.length > 0) {
        const s = list[0];
        const audioUrl = s.downloadUrl?.[4]?.url || s.downloadUrl?.[3]?.url || s.downloadUrl?.[2]?.url || s.url;
        if (audioUrl) {
          return {
            id: s.id || Date.now().toString(),
            title: s.name || s.title,
            artist: s.artists?.primary?.map(a => a.name).join(', ') || s.primaryArtists || 'Unknown',
            duration: s.duration || 0,
            image: s.image?.[2]?.url || s.image?.[1]?.url || s.image?.[0]?.url || s.image,
            audioUrl,
            _src: 'API3'
          };
        }
      }
    } catch (e) {}
    return null;
  };

  try {
    const result = await Promise.any([
      tryAPI1(),
      tryAPI2(),
      tryAPI3()
    ].filter(p => p !== null));

    if (result) {
      console.log(`✅ Search success (${result._src}): ${result.title}`);
      delete result._src;
      return result;
    }
  } catch (e) {}

  console.log('❌ ALL search APIs failed for:', query);
  return null;
}

async function searchSimilarSongs(query, exclude = []) {
  const q = encodeURIComponent(query);

  const tryAPI1 = async () => {
    try {
      const r = await axios.get(
        `https://saavn.dev/api/search/songs?query=${q}&limit=10`,
        { timeout: 5000 }
      );
      const list = r.data?.data?.results || [];
      const filtered = list.filter(s => !exclude.includes(s.id));
      const mapped = filtered.map(s => ({
        id: s.id, title: s.name,
        artist: s.artists?.primary?.map(a => a.name).join(', ') || 'Unknown',
        duration: s.duration,
        image: s.image?.[2]?.url || s.image?.[1]?.url || s.image?.[0]?.url,
        audioUrl: s.downloadUrl?.[4]?.url || s.downloadUrl?.[3]?.url || s.downloadUrl?.[2]?.url
      })).filter(s => s.audioUrl);
      if (mapped.length > 0) return mapped;
    } catch (e) {}
    return null;
  };

  const tryAPI2 = async () => {
    try {
      const r = await axios.get(
        `https://saavnapi-nine.vercel.app/result?query=${q}`,
        { timeout: 5000 }
      );
      const list = Array.isArray(r.data) ? r.data : [];
      const filtered = list.filter(s => !exclude.includes(s.id));
      const mapped = filtered.map(s => ({
        id: s.id || Date.now().toString() + Math.random(),
        title: s.song || s.title || query,
        artist: s.primary_artists || s.singers || 'Unknown',
        duration: parseInt(s.duration) || 0,
        image: s.image,
        audioUrl: s.media_url || s.download_url || s.url
      })).filter(s => s.audioUrl);
      if (mapped.length > 0) return mapped;
    } catch (e) {}
    return null;
  };

  try {
    const result = await Promise.any([
      tryAPI1(),
      tryAPI2()
    ].filter(p => p !== null));
    if (result) return result;
  } catch (e) {}

  return [];
}

async function getNextSongFromContext(currentTrack, playedHistory = []) {
  if (!currentTrack) return null;

  const artist = (currentTrack.artist || '').split(',')[0].trim();
  const title = currentTrack.title || '';
  const currentId = currentTrack.id;
  const fullExclude = [currentId, ...playedHistory].filter(Boolean);

  const promises = [];

  if (artist && artist !== 'Unknown') {
    promises.push(
      searchSimilarSongs(artist, fullExclude).then(songs => ({ priority: 1, songs }))
    );
  }

  const artistLower = artist.toLowerCase();
  const similarArtists = SIMILAR_ARTISTS[artistLower] || [];
  similarArtists.slice(0, 3).forEach(simArtist => {
    promises.push(
      searchSimilarSongs(simArtist, fullExclude).then(songs => ({ priority: 2, songs }))
    );
  });

  const keywords = title.split(' ').filter(w => w.length > 3).slice(0, 2);
  keywords.forEach(keyword => {
    promises.push(
      searchSimilarSongs(keyword, fullExclude).then(songs => ({ priority: 3, songs }))
    );
  });

  if (promises.length === 0) return null;

  try {
    const results = await Promise.allSettled(promises);
    const fulfilled = results
      .filter(r => r.status === 'fulfilled' && r.value.songs && r.value.songs.length > 0)
      .map(r => r.value)
      .sort((a, b) => a.priority - b.priority);

    if (fulfilled.length > 0) {
      const best = fulfilled[0];
      const pick = best.songs[Math.floor(Math.random() * Math.min(3, best.songs.length))];
      console.log(`🎵 Next found (priority ${best.priority}): ${pick.title}`);
      return pick;
    }
  } catch (e) {
    console.error('Parallel search error:', e);
  }

  console.log('⚠️ No context match found — will use Auto DJ');
  return null;
}

async function getSkipSong(currentTrack, playedHistory = []) {
  if (!currentTrack) return null;

  const artist = (currentTrack.artist || '').split(',')[0].trim();
  const currentId = currentTrack.id;
  const fullExclude = [currentId, ...playedHistory].filter(Boolean);

  if (artist && artist !== 'Unknown') {
    const artistSongs = await searchSimilarSongs(artist, fullExclude);
    if (artistSongs.length > 0) {
      const pick = artistSongs[Math.floor(Math.random() * Math.min(5, artistSongs.length))];
      console.log(`🎲 Skip: ${artist} → ${pick.title}`);
      return pick;
    }
  }

  const artistLower = artist.toLowerCase();
  const similarArtists = SIMILAR_ARTISTS[artistLower];
  if (similarArtists && similarArtists.length > 0) {
    const shuffled = [...similarArtists].sort(() => Math.random() - 0.5);
    for (const simArtist of shuffled) {
      const songs = await searchSimilarSongs(simArtist, fullExclude);
      if (songs.length > 0) {
        const pick = songs[Math.floor(Math.random() * Math.min(3, songs.length))];
        console.log(`🎲 Skip: similar ${simArtist} → ${pick.title}`);
        return pick;
      }
    }
  }

  const randomIndex = Math.floor(Math.random() * AUTO_DJ_PLAYLIST.length);
  const songName = AUTO_DJ_PLAYLIST[randomIndex];
  autoDjIndex++;
  console.log(`🎲 Skip: random from Auto DJ`);
  return await searchSong(songName);
}

async function playNextSong(reason = 'auto', user = null) {
  const room = rooms[GLOBAL_ROOM_ID];
  if (!room) return;

  const playedHistory = room.playedHistory || [];
  let nextSong = null;

  const currentIsAmbient = room.state.isAmbient || false;
  const currentTrackId = room.state.track?.id;

  if (!currentIsAmbient && currentTrackId) {
    if (reason === 'skip') {
      nextSong = await getSkipSong(room.state.track, playedHistory);
    } else if (reason === 'next' || reason === 'auto') {
      nextSong = await getNextSongFromContext(room.state.track, playedHistory);
    }
  }

  if (!nextSong) {
    for (let i = 0; i < 3; i++) {
      const songName = AUTO_DJ_PLAYLIST[autoDjIndex % AUTO_DJ_PLAYLIST.length];
      autoDjIndex++;
      console.log(`🎵 Auto DJ attempt ${i+1}/3: ${songName}`);
      nextSong = await searchSong(songName);
      if (nextSong) {
        console.log(`✅ Auto DJ got: ${nextSong.title}`);
        break;
      }
      if (i < 2) await new Promise(r => setTimeout(r, 500));
    }
  }

  if (!nextSong) {
    console.error('❌ playNextSong: all APIs failed, retrying in 10s');
    setTimeout(() => playNextSong(reason, user), 10000);
    return;
  }

  if (!room.playedHistory) room.playedHistory = [];
  if (room.state.track && !room.state.isAmbient && room.state.track.id !== nextSong.id) {
    room.playedHistory.push(room.state.track.id);
    if (room.playedHistory.length > 20) room.playedHistory.shift();
  }

  let playedByName = 'Someone';
  let autoDjFlag = false;

  if (reason === 'auto') {
    playedByName = '🎵 Auto DJ';
    autoDjFlag = true;
  } else if (user) {
    playedByName = user.name;
  }

  room.state = {
    track: nextSong,
    position: 0,
    isPlaying: true,
    playedBy: user ? user.id : null,
    playedByName: playedByName,
    autoDj: autoDjFlag,
    isAmbient: false,
    lastUpdated: Date.now()
  };

  console.log(`🎵 Playing: ${nextSong.title} (${reason} by ${playedByName})`);

  io.to(GLOBAL_ROOM_ID).emit('stateSync', room.state);
  io.to(GLOBAL_ROOM_ID).emit('songChanged', {
    track: nextSong,
    reason: reason,
    playedBy: playedByName
  });
}

async function getPreviousSong(prevId) {
  const apis = [
    async () => {
      const r = await axios.get(
        'https://saavn.dev/api/songs/' + encodeURIComponent(prevId),
        { timeout: 5000 }
      );
      const s = r.data?.data?.[0];
      if (!s) return null;
      return {
        id: s.id, title: s.name,
        artist: s.artists?.primary?.map(a => a.name).join(', ') || 'Unknown',
        duration: s.duration,
        image: s.image?.[2]?.url || s.image?.[1]?.url || s.image?.[0]?.url,
        audioUrl: s.downloadUrl?.[4]?.url || s.downloadUrl?.[3]?.url || s.downloadUrl?.[2]?.url
      };
    },
    async () => {
      const r = await axios.get(
        'https://jiosaavn-api-2-harsh-patel.vercel.app/song?id=' + encodeURIComponent(prevId),
        { timeout: 5000 }
      );
      const s = r.data?.data?.[0] || r.data?.[0];
      if (!s) return null;
      return {
        id: s.id, title: s.name || s.title,
        artist: s.artists?.primary?.map(a => a.name).join(', ') || s.primaryArtists || 'Unknown',
        duration: s.duration,
        image: s.image?.[2]?.url || s.image?.[1]?.url || s.image,
        audioUrl: s.downloadUrl?.[4]?.url || s.downloadUrl?.[3]?.url || s.downloadUrl?.[2]?.url || s.url
      };
    },
    async () => {
      const r = await axios.get(
        'https://saavnapi-nine.vercel.app/song?id=' + encodeURIComponent(prevId),
        { timeout: 5000 }
      );
      const s = r.data?.data || r.data?.[0];
      if (!s) return null;
      return {
        id: s.id, title: s.song || s.title,
        artist: s.primary_artists || s.singers || 'Unknown',
        duration: parseInt(s.duration) || 0,
        image: s.image,
        audioUrl: s.media_url || s.download_url || s.url
      };
    }
  ];

  for (const api of apis) {
    try {
      const track = await api();
      if (track && track.audioUrl) {
        console.log(`✅ Prev found: ${track.title}`);
        return track;
      }
    } catch (e) {
      console.log('Prev API failed:', e.message);
    }
  }
  return null;
}

function startSongEndCheck() {
  setInterval(async () => {
    const room = rooms[GLOBAL_ROOM_ID];
    if (!room) return;

    if (!room.state.track || !room.state.isPlaying) {
      return;
    }

    const duration = room.state.track.duration || 0;
    const currentPos = getCurrentPosition(room);

    if (duration > 0 && currentPos >= duration - 2) {
      room._lastAutoDjAttempt = Date.now();
      console.log(`🎵 Song ended — next`);
      await playNextSong('auto');
    }
  }, 3000);
}

function startPositionUpdater() {
  setInterval(() => {
    const room = rooms[GLOBAL_ROOM_ID];
    if (!room || !room.state.track || !room.state.isPlaying) return;

    const lastUpdated = room.state.lastUpdated || Date.now();
    const elapsed = (Date.now() - lastUpdated) / 1000;

    if (elapsed > 5) {
      room.state.position = (room.state.position || 0) + elapsed;
      room.state.lastUpdated = Date.now();
    }
  }, 2000);
}

function startAutoDj() {
  console.log('🎵 Auto DJ: Waiting for user to play a song...');
}

io.on('connection', (socket) => {
  const ip = getClientIP(socket);
  const fp = socket.handshake.auth?.fingerprint ||
             socket.handshake.query?.fingerprint ||
             'unknown';

  console.log('Connected:', socket.id, 'IP:', ip, 'FP:', fp.slice(-8));

  const blockStatus = isBlocked(socket, fp);
  if (blockStatus.blocked) {
    socket.emit('blocked', {
      message: 'You have been blocked from this room',
      reason: blockStatus.reason
    });
    setTimeout(() => socket.disconnect(true), 1000);
    return;
  }

  socket.on('joinGlobal', ({ userName, fingerprint }) => {
    ensureGlobalRoom();
    const room = rooms[GLOBAL_ROOM_ID];
    const userFp = fingerprint || fp;

    if (BLOCKED_IPS.has(ip) || (userFp && BLOCKED_FINGERPRINTS.has(userFp))) {
      socket.emit('blocked', { message: 'You are blocked' });
      setTimeout(() => socket.disconnect(true), 500);
      return;
    }

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
      existingUser.globallyMuted = isGloballyMuted(userName);
      delete existingUser.disconnectedAt;
      console.log(`🔄 Reconnect: ${userName}`);
    } else {
      room.users.push({
        id: socket.id, name: userName, ip: ip, fingerprint: userFp,
        lastActive: Date.now(), status: 'online',
        blocked: { chat: false, play: false, voice: false },
        location: null, timezone: null, chatActive: false, joinedAt: Date.now(),
        globallyMuted: isGloballyMuted(userName)
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

    socket.emit('globalMuteState', { muted: isGloballyMuted(userName) });

    if (currentAnnouncement) {
      socket.emit('adminAnnounce', currentAnnouncement);
    }

    // ✅ Real-time position bhejo — actual jahan gaana chal raha hai
    if (room.state.track && room.state.isPlaying) {
      const currentPosition = getCurrentPosition(room);

      socket.emit('stateSync', {
        track: room.state.track,
        position: currentPosition,
        isPlaying: true,
        playedByName: room.state.playedByName,
        autoDj: room.state.autoDj,
        lastUpdated: Date.now()
      });

      socket.emit('songChanged', {
        track: room.state.track,
        reason: 'sync',
        playedBy: room.state.playedByName
      });

      console.log(`🔄 Synced ${userName} to position ${currentPosition.toFixed(1)}s`);
    }

    socket.emit('chatHistory', room.messages);

    io.to(GLOBAL_ROOM_ID).emit('usersUpdate', getUsersWithStatus(room));
    io.to(GLOBAL_ROOM_ID).emit('globalStats', {
      totalUsers: room.users.length,
      onlineUsers: room.users.filter(u =>
        u.status !== 'disconnected' &&
        Date.now() - u.lastActive < 2 * 60 * 1000
      ).length
    });

    io.to(GLOBAL_ROOM_ID).emit('userJoined', {
      userName,
      message: `${userName} joined 🎉`,
      welcomeMessage: getRandomWelcome()
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

  // ✅ updateState — drift > 3s reject karo
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

    const serverPos = getCurrentPosition(room);
    const isTrackChange = newState.track &&
      (!room.state.track || room.state.track.id !== newState.track.id);

    // ✅ TRACK CHANGE — allow
    if (isTrackChange) {
      newState.autoDj = false;
      newState.isAmbient = false;
      newState.playedBy = socket.id;
      newState.playedByName = user.name;
      console.log(`🎵 ${user.name} playing: ${newState.track.title}`);

      if (!room.playedHistory) room.playedHistory = [];
      if (room.state.track && room.state.track.id !== newState.track.id) {
        room.playedHistory.push(room.state.track.id);
        if (room.playedHistory.length > 20) room.playedHistory.shift();
      }

      analytics.songsPlayed++;

      room.state = { ...room.state, ...newState, lastUpdated: Date.now() };
      socket.to(room.roomId).emit('stateSync', room.state);
      io.to(room.roomId).emit('usersUpdate', getUsersWithStatus(room));
      return;
    }

    // ✅ SAME TRACK — position validation
    if (room.state.track && newState.track &&
        room.state.track.id === newState.track.id &&
        newState.position !== undefined) {

      const clientPos = newState.position;
      const drift = Math.abs(clientPos - serverPos);

      // ✅ Drift > 3s — reject + correct position bhejo
      if (drift > 3) {
        console.log(`🚫 Rejected ${user.name}: drift ${drift.toFixed(1)}s (server: ${serverPos.toFixed(1)}s, client: ${clientPos.toFixed(1)}s)`);

        socket.emit('stateSync', {
          track: room.state.track,
          position: serverPos,
          isPlaying: room.state.isPlaying,
          playedByName: room.state.playedByName,
          autoDj: room.state.autoDj,
          lastUpdated: Date.now()
        });
        return;
      }

      // ✅ Drift chhota — accept
      room.state.position = clientPos;
      room.state.isPlaying = newState.isPlaying !== undefined ? newState.isPlaying : room.state.isPlaying;
      room.state.lastUpdated = Date.now();

      socket.to(room.roomId).emit('stateSync', room.state);
      return;
    }

    // ✅ Baaki updates
    room.state = { ...room.state, ...newState, lastUpdated: Date.now() };
    socket.to(room.roomId).emit('stateSync', room.state);
  });

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

    console.log(`⏭️ ${user.name} requested NEXT`);

    socket.emit('nextAck', { status: 'loading' });

    io.to(room.roomId).emit('skipNotice', {
      userName: user.name,
      message: `⏭️ Loading next song...`
    });

    try {
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Timeout')), 10000)
      );
      await Promise.race([
        playNextSong('next', user),
        timeoutPromise
      ]);
      socket.emit('nextAck', { status: 'success', track: room.state.track?.title || 'Next' });
      console.log(`✅ Next: ${room.state.track?.title}`);
    } catch (e) {
      console.error('Next error:', e.message);
      const randomSong = AUTO_DJ_PLAYLIST[Math.floor(Math.random() * AUTO_DJ_PLAYLIST.length)];
      const fallbackTrack = await searchSong(randomSong);
      if (fallbackTrack) {
        room.state = {
          track: fallbackTrack,
          position: 0,
          isPlaying: true,
          playedBy: user.id,
          playedByName: user.name,
          autoDj: false,
          isAmbient: false,
          lastUpdated: Date.now()
        };
        io.to(GLOBAL_ROOM_ID).emit('stateSync', room.state);
        io.to(GLOBAL_ROOM_ID).emit('songChanged', {
          track: fallbackTrack,
          reason: 'next',
          playedBy: user.name
        });
        socket.emit('nextAck', { status: 'fallback', track: fallbackTrack.title });
      } else {
        socket.emit('nextAck', { status: 'error' });
      }
    }
  });

  socket.on('requestPrev', async ({ roomId }) => {
    const room = rooms[roomId || GLOBAL_ROOM_ID];
    if (!room) return;
    const user = room.users.find(u => u.id === socket.id);
    if (!user) return;
    user.lastActive = Date.now();

    if (user.blocked && user.blocked.play) {
      socket.emit('permissionDenied', { action: 'play', message: 'You are blocked' });
      return;
    }

    console.log(`⏮️ ${user.name} requested PREV`);

    socket.emit('prevAck', { status: 'loading' });

    if (room.playedHistory && room.playedHistory.length > 0) {
      const prevId = room.playedHistory[room.playedHistory.length - 1];

      const prevTrack = await getPreviousSong(prevId);

      if (prevTrack && prevTrack.audioUrl) {
        room.playedHistory.pop();

        if (room.state.track && !room.state.isAmbient) {
          room.playedHistory.push(room.state.track.id);
        }

        room.state = {
          track: prevTrack,
          position: 0,
          isPlaying: true,
          playedBy: user.id,
          playedByName: user.name,
          autoDj: false,
          isAmbient: false,
          lastUpdated: Date.now()
        };

        io.to(GLOBAL_ROOM_ID).emit('stateSync', room.state);
        io.to(GLOBAL_ROOM_ID).emit('songChanged', {
          track: prevTrack,
          reason: 'prev',
          playedBy: user.name
        });
        io.to(room.roomId).emit('skipNotice', {
          userName: user.name,
          message: `⏮️ Previous`
        });
        socket.emit('prevAck', { status: 'success', track: prevTrack.title });
        return;
      }
    }

    const randomSong = AUTO_DJ_PLAYLIST[Math.floor(Math.random() * AUTO_DJ_PLAYLIST.length)];
    const fallbackTrack = await searchSong(randomSong);
    if (fallbackTrack) {
      room.state = {
        track: fallbackTrack,
        position: 0,
        isPlaying: true,
        playedBy: user.id,
        playedByName: user.name,
        autoDj: false,
        isAmbient: false,
        lastUpdated: Date.now()
      };
      io.to(GLOBAL_ROOM_ID).emit('stateSync', room.state);
      io.to(GLOBAL_ROOM_ID).emit('songChanged', {
        track: fallbackTrack,
        reason: 'prev',
        playedBy: user.name
      });
      socket.emit('prevAck', { status: 'fallback', track: fallbackTrack.title });
    } else {
      socket.emit('prevAck', { status: 'error' });
    }
  });

  socket.on('requestSkip', async ({ roomId }) => {
    const room = rooms[roomId || GLOBAL_ROOM_ID];
    if (!room) return;
    const user = room.users.find(u => u.id === socket.id);
    if (!user) return;
    user.lastActive = Date.now();

    if (user.blocked && user.blocked.play) {
      socket.emit('permissionDenied', { action: 'play', message: 'You are blocked' });
      return;
    }

    console.log(`🎲 ${user.name} SKIPPED`);

    io.to(room.roomId).emit('skipNotice', {
      userName: user.name,
      message: `🎲 Skipped`
    });

    await playNextSong('skip', user);
  });

  socket.on('requestSyncState', ({ roomId }) => {
    const room = rooms[roomId || GLOBAL_ROOM_ID];
    if (!room) return;

    const currentPosition = getCurrentPosition(room);

    console.log(`🔄 Sync request — position: ${currentPosition.toFixed(1)}s`);

    socket.emit('stateSync', {
      track: room.state.track,
      position: currentPosition,
      isPlaying: room.state.isPlaying,
      playedByName: room.state.playedByName,
      autoDj: room.state.autoDj,
      lastUpdated: Date.now()
    });

    if (room.state.track) {
      socket.emit('songChanged', {
        track: room.state.track,
        reason: 'sync',
        playedBy: room.state.playedByName
      });
    }
  });

  socket.on('heartbeat', ({ roomId, position, isPlaying }) => {
    const room = rooms[roomId || GLOBAL_ROOM_ID];
    if (!room) return;
    const user = room.users.find(u => u.id === socket.id);
    if (!user) return;
    user.lastActive = Date.now();
    if (user.blocked && user.blocked.play) return;

    // ✅ Heartbeat me bhi drift check
    const serverPos = getCurrentPosition(room);
    const drift = Math.abs(position - serverPos);

    if (drift > 3) {
      console.log(`🚫 Heartbeat drift rejected: ${drift.toFixed(1)}s`);
      socket.emit('stateSync', {
        track: room.state.track,
        position: serverPos,
        isPlaying: room.state.isPlaying,
        playedByName: room.state.playedByName,
        autoDj: room.state.autoDj,
        lastUpdated: Date.now()
      });
      return;
    }

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

    if (isGloballyMuted(user.name)) {
      socket.emit('permissionDenied', {
        action: 'chat',
        message: '🚫 You are globally muted by admin'
      });
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

  socket.on('shareLocation', ({ roomId, location, timezone }) => {
    const room = rooms[roomId || GLOBAL_ROOM_ID];
    if (!room) return;
    if (!location || typeof location.lat !== 'number' || typeof location.lng !== 'number') return;
    const user = room.users.find(u => u.id === socket.id);
    if (user) { 
      user.location = location; 
      if (timezone) user.timezone = timezone;
      user.lastActive = Date.now(); 
    }
    socket.to(room.roomId).emit('partnerLocation', { location, userId: socket.id, userName: user?.name });
  });

  socket.on('requestGlobalListeners', ({ roomId }) => {
    const room = rooms[roomId || GLOBAL_ROOM_ID];
    if (!room) return;

    const cityCounts = {};
    room.users.forEach(u => {
      if (u.location && u.location.lat && u.location.lng) {
        const city = getApproxLocation(u.location.lat, u.location.lng);
        if (!cityCounts[city]) {
          cityCounts[city] = {
            city,
            lat: u.location.lat,
            lng: u.location.lng,
            userCount: 0
          };
        }
        cityCounts[city].userCount++;
      }
    });

    const listeners = Object.values(cityCounts);

    socket.emit('globalListeners', {
      listeners,
      currentTrack: room.state.track ? {
        title: room.state.track.title,
        artist: room.state.track.artist
      } : null,
      totalCities: listeners.length,
      totalListeners: listeners.reduce((sum, l) => sum + l.userCount, 0)
    });

    console.log(`🌍 Global listeners: ${listeners.length} cities, ${listeners.reduce((s, l) => s + l.userCount, 0)} users`);
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

        console.log(`⏳ ${user.name} disconnected — 30s grace`);

        io.to(roomId).emit('usersUpdate', getUsersWithStatus(room));
        io.to(roomId).emit('globalStats', {
          totalUsers: room.users.length,
          onlineUsers: room.users.filter(u =>
            u.status !== 'disconnected' &&
            Date.now() - u.lastActive < 2 * 60 * 1000
          ).length
        });

        io.to(roomId).emit('userLeft', {
          userName: user.name,
          message: `${user.name} left`
        });

        setTimeout(() => {
          const r = rooms[roomId];
          if (!r) return;
          const u = r.users.find(x => x.id === socket.id);
          if (u && u.status === 'disconnected') {
            console.log(`❌ ${u.name} removed after 30s grace`);
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
    blocked: u.blocked || { chat: false, play: false, voice: false },
    globallyMuted: isGloballyMuted(u.name)
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
  console.log('🌍 Global room mode');
  console.log('🎵 Auto DJ: Waiting for user to play a song...');
  console.log('⏱️  Session grace: 30 seconds');
  ensureGlobalRoom();
  startAutoDj();
  startSongEndCheck();
  startPositionUpdater();
  console.log('🔐 Admin panel: /admin');
});
