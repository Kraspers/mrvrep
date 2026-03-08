const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 3000);
const DATA_FILE = path.join(__dirname, 'data.json');
const ADMIN_PASSWORD = process.env.MORV_ADMIN_PASSWORD || 'mrv-admin';
const ADMIN_TOKEN = process.env.MORV_ADMIN_TOKEN || 'admin-token';
const INVITE_TTL = 24 * 60 * 60 * 1000;

const uid = (p) => `${p}_${crypto.randomBytes(5).toString('hex')}`;
const json = (res, status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); };
const parseBody = (req) => new Promise((resolve) => {
  let buf = '';
  req.on('data', (c) => { buf += c; if (buf.length > 2e6) req.destroy(); });
  req.on('end', () => { try { resolve(JSON.parse(buf || '{}')); } catch { resolve({}); } });
});
const now = () => Date.now();

function defaultState(serverId, serverName = '') {
  return {
    sid: serverId,
    snm: serverName,
    cats: [],
    chs: {},
    msgs: {},
    unread: {},
    pinned: {}
  };
}

function createData() {
  return {
    users: {}, sessions: {}, bannedIps: {}, bans: [],
    servers: {
      FO: { id: 'FO', name: 'FO', isPublicNamed: true, members: [], invites: {}, state: defaultState('FO', 'FO'), stateVersion: 1 },
      FSC: { id: 'FSC', name: 'FSC', isPublicNamed: true, members: [], invites: {}, state: defaultState('FSC', 'FSC'), stateVersion: 1 }
    }
  };
}
let db = fs.existsSync(DATA_FILE) ? JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) : createData();
const save = () => fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
const ip = (req) => (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();

function auth(req) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!token || !db.sessions[token]) return null;
  return { token, userId: db.sessions[token].userId };
}

function sendFile(res, file, ct = 'text/html; charset=utf-8') {
  if (!fs.existsSync(file)) return json(res, 404, { error: 'not_found' });
  res.writeHead(200, { 'Content-Type': ct });
  fs.createReadStream(file).pipe(res);
}

function banReason(req) {
  const addr = ip(req);
  return db.bannedIps[addr] || db.bannedIps.all || '';
}

function userViewServer(s) {
  return { id: s.id, name: s.isPublicNamed ? s.name : '', visibleName: !!s.isPublicNamed };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/') return sendFile(res, path.join(__dirname, 'morv-full-release-2_0.html'));
  if (url.pathname === '/admmrv') return sendFile(res, path.join(__dirname, 'morv-admin.html'));
  if (url.pathname === '/morv-bridge.js') return sendFile(res, path.join(__dirname, 'morv-bridge.js'), 'application/javascript; charset=utf-8');
  if (url.pathname === '/health') return json(res, 200, { ok: true });

  if (url.pathname === '/api/access' && req.method === 'GET') {
    const reason = banReason(req);
    return json(res, 200, reason ? { allowed: false, message: 'Доступ к Morv для вас был закрыт.', reason } : { allowed: true });
  }

  if (url.pathname === '/api/auth/login' && req.method === 'POST') {
    const reason = banReason(req);
    if (reason) return json(res, 403, { error: 'banned', reason });
    const body = await parseBody(req);
    const userId = uid('usr');
    const token = uid('sess');
    db.users[userId] = { id: userId, name: (body.name || '').trim() || `user_${userId.slice(-4)}`, ips: [ip(req)] };
    db.sessions[token] = { userId, createdAt: now() };
    if (!db.servers.FO.members.includes(userId)) db.servers.FO.members.push(userId);
    if (!db.servers.FSC.members.includes(userId)) db.servers.FSC.members.push(userId);
    save();
    return json(res, 200, { token, user: db.users[userId] });
  }

  if (url.pathname === '/api/me' && req.method === 'GET') {
    const a = auth(req); if (!a) return json(res, 401, { error: 'unauthorized' });
    const u = db.users[a.userId]; if (!u) return json(res, 401, { error: 'unauthorized' });
    return json(res, 200, { user: { id: u.id, name: u.name } });
  }

  if (url.pathname === '/api/servers' && req.method === 'GET') {
    const a = auth(req); if (!a) return json(res, 401, { error: 'unauthorized' });
    const servers = Object.values(db.servers).filter((s) => s.members.includes(a.userId)).map(userViewServer);
    return json(res, 200, { servers });
  }

  if (url.pathname === '/api/servers' && req.method === 'POST') {
    const a = auth(req); if (!a) return json(res, 401, { error: 'unauthorized' });
    const sid = uid('srv');
    db.servers[sid] = { id: sid, name: '', isPublicNamed: false, members: [a.userId], invites: {}, state: defaultState(sid, sid), stateVersion: 1 };
    save();
    return json(res, 200, { server: userViewServer(db.servers[sid]) });
  }

  if (url.pathname.match(/^\/api\/servers\/[^/]+\/state$/) && req.method === 'GET') {
    const a = auth(req); if (!a) return json(res, 401, { error: 'unauthorized' });
    const sid = url.pathname.split('/')[3];
    const s = db.servers[sid];
    if (!s || !s.members.includes(a.userId)) return json(res, 404, { error: 'server_not_found' });
    return json(res, 200, { state: s.state, version: s.stateVersion, server: userViewServer(s), members: s.members.map((id) => db.users[id]).filter(Boolean).map((u) => ({ id: u.id, name: u.name })) });
  }

  if (url.pathname.match(/^\/api\/servers\/[^/]+\/state$/) && req.method === 'PUT') {
    const a = auth(req); if (!a) return json(res, 401, { error: 'unauthorized' });
    const sid = url.pathname.split('/')[3];
    const s = db.servers[sid];
    if (!s || !s.members.includes(a.userId)) return json(res, 404, { error: 'server_not_found' });
    const body = await parseBody(req);
    if (!body || typeof body !== 'object' || !body.state) return json(res, 400, { error: 'bad_state' });
    s.state = Object.assign(defaultState(sid, s.name || sid), body.state);
    s.state.sid = sid;
    s.stateVersion += 1;
    save();
    return json(res, 200, { ok: true, version: s.stateVersion });
  }

  if (url.pathname.startsWith('/api/servers/') && url.pathname.endsWith('/invite') && req.method === 'POST') {
    const a = auth(req); if (!a) return json(res, 401, { error: 'unauthorized' });
    const sid = url.pathname.split('/')[3];
    const s = db.servers[sid];
    if (!s || !s.members.includes(a.userId)) return json(res, 404, { error: 'server_not_found' });
    const token = uid('inv');
    const expiresAt = now() + INVITE_TTL;
    s.invites = { [token]: { token, expiresAt } };
    const inviteUrl = `http://${req.headers.host}/?invite=${token}`;
    save();
    return json(res, 200, { token, expiresAt, inviteUrl });
  }

  if (url.pathname.startsWith('/api/invites/') && url.pathname.endsWith('/join') && req.method === 'POST') {
    const a = auth(req); if (!a) return json(res, 401, { error: 'unauthorized' });
    const token = url.pathname.split('/')[3];
    const s = Object.values(db.servers).find((x) => x.invites[token] && x.invites[token].expiresAt > now());
    if (!s) return json(res, 404, { error: 'invite_invalid' });
    if (!s.members.includes(a.userId)) s.members.push(a.userId);
    save();
    return json(res, 200, { serverId: s.id });
  }

  if (url.pathname === '/api/panic' && req.method === 'POST') {
    const a = auth(req); if (!a) return json(res, 401, { error: 'unauthorized' });
    Object.keys(db.sessions).forEach((t) => { if (db.sessions[t].userId === a.userId) delete db.sessions[t]; });
    Object.values(db.servers).forEach((s) => {
      s.members = s.members.filter((m) => m !== a.userId);
      if (s.state && s.state.members) s.state.members = (s.state.members || []).filter((m) => m.id !== a.userId);
    });
    delete db.users[a.userId];
    save();
    return json(res, 200, { ok: true });
  }

  if (url.pathname === '/api/admin/login' && req.method === 'POST') {
    const body = await parseBody(req);
    if (body.password !== ADMIN_PASSWORD) return json(res, 401, { error: 'bad_password' });
    return json(res, 200, { token: ADMIN_TOKEN });
  }

  if (url.pathname === '/api/admin/servers' && req.method === 'GET') {
    if (req.headers.authorization !== `Bearer ${ADMIN_TOKEN}`) return json(res, 401, { error: 'unauthorized' });
    const servers = Object.values(db.servers).map((s) => ({ id: s.id, name: s.name, members: s.members.length }));
    return json(res, 200, { servers });
  }

  if (url.pathname === '/api/admin/ban-server' && req.method === 'POST') {
    if (req.headers.authorization !== `Bearer ${ADMIN_TOKEN}`) return json(res, 401, { error: 'unauthorized' });
    const body = await parseBody(req);
    const s = db.servers[body.serverId];
    const reason = body.reason || 'Заблокировано администратором';
    if (s) {
      s.members.forEach((uid) => {
        const u = db.users[uid];
        (u?.ips || []).forEach((addr) => { db.bannedIps[addr] = reason; });
        Object.keys(db.sessions).forEach((t) => { if (db.sessions[t].userId === uid) delete db.sessions[t]; });
      });
    }
    if (body.ip) db.bannedIps[body.ip] = reason;
    db.bans.push({ serverId: body.serverId, reason, at: now(), ip: body.ip || '' });
    save();
    return json(res, 200, { ok: true });
  }

  json(res, 404, { error: 'not_found' });
});

server.listen(PORT, () => console.log(`Server started: http://localhost:${PORT}`));
