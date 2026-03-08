(function () {
  const isAdmin = location.pathname.startsWith('/admmrv');
  let me = null;
  let activeServerId = localStorage.getItem('morv_active_server') || '';
  let syncTimer = null;
  let pullTimer = null;
  let lastVersion = 0;
  let applying = false;
  let localDirty = false;
  let pendingRemote = null;
  const _serverCodeMap = JSON.parse(localStorage.getItem('morv_server_codes')||'{}');

  function _saveServerCode(sid, code){
    if(!sid||!code) return;
    _serverCodeMap[sid]=code;
    localStorage.setItem('morv_server_codes', JSON.stringify(_serverCodeMap));
  }

  function _extractCode(obj){
    const p = (obj && obj.deviceJoinPath) || '';
    const m = p.match(/\/servers\/[^/]+\/([a-z0-9]{8})/i);
    return m ? m[1] : '';
  }

  async function _deriveKey(serverId){
    const code = _serverCodeMap[serverId] || '';
    const enc = new TextEncoder();
    const base = await crypto.subtle.importKey('raw', enc.encode('morv-e2e:'+serverId+':'+code), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({name:'PBKDF2',salt:enc.encode('morv-salt-'+serverId),iterations:120000,hash:'SHA-256'}, base, {name:'AES-GCM',length:256}, false, ['encrypt','decrypt']);
  }

  const _b64 = (buf)=>btoa(String.fromCharCode(...new Uint8Array(buf)));
  const _unb64 = (s)=>Uint8Array.from(atob(s), c=>c.charCodeAt(0));

  async function _encryptText(serverId, text){
    if(!text) return text;
    if(String(text).startsWith('enc:v1:')) return text;
    const key = await _deriveKey(serverId);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({name:'AES-GCM',iv}, key, new TextEncoder().encode(String(text)));
    return 'enc:v1:'+_b64(iv)+':'+_b64(ct);
  }

  async function _decryptText(serverId, text){
    if(!text || !String(text).startsWith('enc:v1:')) return text;
    try{
      const [, , ivB64, ctB64] = String(text).split(':');
      const key = await _deriveKey(serverId);
      const pt = await crypto.subtle.decrypt({name:'AES-GCM',iv:_unb64(ivB64)}, key, _unb64(ctB64));
      return new TextDecoder().decode(pt);
    }catch{ return '🔒 зашифровано'; }
  }

  async function encryptState(serverId, st){
    const out = JSON.parse(JSON.stringify(st||{}));
    const msgs = out.msgs || {};
    for(const cid of Object.keys(msgs)){
      for(const m of msgs[cid]||[]){
        if(m && typeof m.text==='string' && !m.sys) m.text = await _encryptText(serverId, m.text);
      }
    }
    return out;
  }

  async function decryptState(serverId, st){
    const out = JSON.parse(JSON.stringify(st||{}));
    const msgs = out.msgs || {};
    for(const cid of Object.keys(msgs)){
      for(const m of msgs[cid]||[]){
        if(m && typeof m.text==='string' && !m.sys) m.text = await _decryptText(serverId, m.text);
      }
    }
    return out;
  }

  function setRoute(path) {
    try { history.replaceState({}, '', path); } catch {}
  }

  function showInviteExpired() {
    setRoute('/invite-expired');
    document.body.innerHTML = `<div style="min-height:100vh;background:#0c0c0e;color:#ececf4;display:flex;align-items:center;justify-content:center;font-family:Inter,sans-serif;padding:24px;">
      <div style="max-width:420px;text-align:center;">
        <div style="font-size:48px;margin-bottom:10px;">😔</div>
        <div style="font-size:18px;font-weight:700;margin-bottom:8px;">Похоже этот инвайт уже не действителен</div>
        <div style="font-size:13px;color:#7a7a94;">Попросите новую ссылку-приглашение.</div>
      </div>
    </div>`;
  }

  async function api(path, opts = {}, retry = true) {
    const token = localStorage.getItem('morv_token');
    const headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(path, Object.assign({}, opts, { headers }));
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if ((res.status === 401 || data.error === 'unauthorized') && retry && !isAdmin) {
        localStorage.removeItem('morv_token');
        await ensureLogin(true);
        return api(path, opts, false);
      }
      throw new Error(data.error || 'api_error');
    }
    return data;
  }

  function saveActiveServer(id) {
    activeServerId = id;
    localStorage.setItem('morv_active_server', id);
  }

  async function ensureLogin(force = false) {
    if (force) localStorage.removeItem('morv_token');
    if (!localStorage.getItem('morv_token')) {
      const deviceCode = localStorage.getItem('morv_device_code') || Math.random().toString(36).slice(2, 10);
      localStorage.setItem('morv_device_code', deviceCode);
      const login = await fetch('/api/auth/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: localStorage.getItem('morv_name') || '', deviceCode })
      }).then((r) => r.json());
      if (!login.token) throw new Error('login_failed');
      localStorage.setItem('morv_token', login.token);
      localStorage.setItem('morv_name', login.user.name);
    }
    const r = await api('/api/me');
    me = r.user;
    if (me && me.deviceCode) localStorage.setItem('morv_device_code', me.deviceCode);
  }

  function applyStateFromServer(payload) {
    if (!payload || !payload.state || !window.$ || !me) return;
    const st = payload.state;
    applying = true;
    $.sid = st.sid || activeServerId;
    $.snm = (payload.server && payload.server.name) ? payload.server.name : (st.snm || $.sid);
    $.srvAva = (payload.server && payload.server.avatar) ? payload.server.avatar : (st.srvAva || null);
    $.me = { id: me.id, name: me.name, emoji: $.me?.emoji || '🦊', you: true };

    $.cats = Array.isArray(st.cats) ? st.cats : [];
    $.chs = st.chs || {};
    $.msgs = st.msgs || {};
    $.unread = st.unread || {};
    $.pinned = st.pinned || {};

    const remoteMembers = (payload.members || []).map((u) => ({
      id: u.id,
      name: u.deviceCode ? `${u.name} · ${u.deviceCode}` : u.name,
      emoji: '🦊',
      you: u.id === me.id
    }));
    $.members = remoteMembers.length ? remoteMembers : [$.me];

    const current = $.cur && $.chs[$.cur] ? $.cur : null;
    const firstText = Object.values($.chs).find((c) => c.type === 'text');
    if (current) switchCh(current);
    else if (firstText) switchCh(firstText.id);
    else {
      renderChs();
      setView('ch');
      setTb('morv', false, false);
    }

    const avaEl = document.getElementById('srvAva');
    if (avaEl){
      if ($.srvAva){
        avaEl.innerHTML = `<img src="${$.srvAva}" style="width:100%;height:100%;object-fit:cover;border-radius:inherit;">`;
      } else {
        avaEl.textContent = ($.snm || $.sid || 'M')[0].toUpperCase();
      }
    }
    const srvNm = document.getElementById('srvNm');
    if (srvNm) srvNm.textContent = $.snm || $.sid;
    const srvId = document.getElementById('srvId');
    if (srvId) srvId.textContent = 'ID: ' + $.sid;
    const invBox = document.getElementById('invBox');
    if (invBox) invBox.textContent = 'morv.app/s/' + $.sid;

    applying = false;
  }

  async function pullState() {
    if (!activeServerId || applying) return;
    try {
      const r = await api(`/api/servers/${activeServerId}/state`);
      _saveServerCode(activeServerId, _extractCode(r.server));
      if ((r.version || 0) !== lastVersion) {
        if (localDirty) {
          pendingRemote = r;
        } else {
          lastVersion = r.version || 0;
          r.state = await decryptState(activeServerId, r.state);
          applyStateFromServer(r);
        }
      }
    } catch {}
  }

  function localStateSnapshot() {
    return { sid: $.sid, snm: $.snm, srvAva: $.srvAva || null, cats: $.cats, chs: $.chs, msgs: $.msgs, unread: $.unread, pinned: $.pinned };
  }

  async function pushState() {
    if (!activeServerId || applying || !window.$ || !$.sid || !localDirty) return;
    try {
      const encState = await encryptState(activeServerId, localStateSnapshot());
      const r = await api(`/api/servers/${activeServerId}/state`, {
        method: 'PUT', body: JSON.stringify({ state: encState, expectedVersion: lastVersion || 0, serverName: $.snm || '', serverAvatar: $.srvAva || '' })
      });
      lastVersion = r.version || lastVersion;
      localDirty = false;
      if (pendingRemote && (pendingRemote.version || 0) > lastVersion) {
        const pr = pendingRemote;
        pendingRemote = null;
        pr.state = await decryptState(activeServerId, pr.state);
        lastVersion = pr.version || lastVersion;
        applyStateFromServer(pr);
      }
    } catch (e) {
      if ((e.message||'').includes('state_conflict')) {
        localDirty = false;
        pendingRemote = null;
        await pullState();
      }
    }
  }

  function attachRealtimeHooks() {
    const wrap = (name) => {
      const fn = window[name];
      if (typeof fn !== 'function' || fn._rtWrapped) return;
      const wrapped = function (...args) {
        const out = fn.apply(this, args);
        localDirty = true;
        setTimeout(pushState, 0);
        return out;
      };
      wrapped._rtWrapped = true;
      window[name] = wrapped;
    };
    ['send', 'doMakeCat', 'doMakeCh', 'doEditCat', 'doEditCh', 'deleteCat', 'deleteCh', 'togglePin', 'togglePinCat', 'addBot', 'removeBot', 'doAnnounce'].forEach(wrap);

    const origSwitch = window.switchCh;
    if (typeof origSwitch === 'function' && !origSwitch._rtRouteWrapped) {
      const w = function (...args) {
        const r = origSwitch.apply(this, args);
        if ($.sid && $.cur) setRoute(`/servers/${$.sid}/ch/${$.cur}`);
        return r;
      };
      w._rtRouteWrapped = true;
      window.switchCh = w;
    }
  }

  async function openServer(serverId) {
    saveActiveServer(serverId);
    if (typeof window.sim === 'function') window.sim = function () {};

    if (typeof boot === 'function') boot(serverId, serverId);
    setRoute(`/servers/${serverId}`);
    attachRealtimeHooks();
    localDirty = false;
    await pullState();

    clearInterval(syncTimer);
    clearInterval(pullTimer);
    syncTimer = setInterval(pushState, 900);
    pullTimer = setInterval(pullState, 700);
  }

  if (!isAdmin) {
    document.addEventListener('DOMContentLoaded', async () => {
      const sub = document.querySelector('.privacy-badge-sub');
      if (sub) sub.remove();

      try {
        const access = await fetch('/api/access').then((r) => r.json());
        if (!access.allowed) {
          document.body.innerHTML = `<div style="padding:40px;font-family:Inter,sans-serif;color:#fff;background:#0c0c0e;min-height:100vh;">Доступ к Morv для вас был закрыт.<br><small>${access.reason || ''}</small></div>`;
          return;
        }
      } catch {}

      try { await ensureLogin(); } catch {}

      window.doCreateServer = async function () {
        try {
          const name=((document.getElementById('createSrvName')||{}).value||'').trim();
          const avatar=(window._srvAvaData||'');
          const r = await api('/api/servers', { method: 'POST', body: JSON.stringify({ name, avatar }) });
          closeSh('sh-create');
          _saveServerCode(r.server.id, _extractCode(r.server));
          await openServer(r.server.id);
        } catch { toast('Не удалось создать сервер'); }
      };

      window.joinServer = async function () {
        const v = ((document.getElementById('joinInput') || {}).value || '').trim();
        const inviteMatch = v.match(/invite=([a-z0-9_]+)/i) || v.match(/(inv_[a-z0-9]{10,})/i);
        const codeMatch = v.match(/\/servers\/([a-z0-9_]+)\/([a-z0-9]{8})/i);
        try {
          if (inviteMatch) {
            const r = await api('/api/invites/' + inviteMatch[1] + '/join', { method: 'POST' });
            const sl = await api('/api/servers');
            const srow = (sl.servers||[]).find(x=>x.id===r.serverId);
            _saveServerCode(r.serverId, _extractCode(srow));
            await openServer(r.serverId);
            return;
          }
          if (codeMatch) {
            const r = await api(`/api/servers/${codeMatch[1]}/join-code`, {
              method: 'POST', body: JSON.stringify({ code: codeMatch[2] })
            });
            _saveServerCode(r.serverId, codeMatch[2]);
            await openServer(r.serverId);
            return;
          }
          toast('Неверная ссылка или код');
        } catch (e) {
          if ((e.message || '').includes('invite_invalid')) showInviteExpired();
          else toast('Не удалось войти на сервер');
        }
      };

      window.showQR = async function () {
        try {
          const r = await api('/api/servers/' + $.sid + '/invite', { method: 'POST' });
          document.getElementById('qrLink').textContent = r.inviteUrl;
          const canvas=document.getElementById('qrCanvas');
          const ctx=canvas.getContext('2d');
          const img=new Image();
          img.onload=()=>{ ctx.clearRect(0,0,canvas.width,canvas.height); ctx.drawImage(img,0,0,canvas.width,canvas.height); };
          img.onerror=()=>{ if (typeof drawQR==='function') drawQR(r.inviteUrl); };
          img.src=(r.qrUrl||('/api/qr?text='+encodeURIComponent(r.inviteUrl)))+'&_=' + Date.now();
          openSh('sh-qr');
        } catch { toast('Не удалось создать инвайт'); }
      };

      window.copyInv = async function () {
        try {
          const r = await api('/api/servers/' + $.sid + '/invite', { method: 'POST' });
          await navigator.clipboard.writeText(r.inviteUrl);
          toast('Ссылка скопирована!');
        } catch { toast('Не удалось скопировать ссылку'); }
      };

      window.doPanic = async function () {
        try { await api('/api/panic', { method: 'POST' }); } catch {}
        localStorage.removeItem('morv_token');
        localStorage.removeItem('morv_active_server');
        closeSh('sh-panic');
        if (typeof closeSettingsSection === 'function') closeSettingsSection();
        location.href = '/login';
      };

      const inviteToken = new URLSearchParams(location.search).get('invite');
      if (inviteToken) {
        try {
          const r = await api('/api/invites/' + inviteToken + '/join', { method: 'POST' });
          const sl = await api('/api/servers');
          const srow = (sl.servers||[]).find(x=>x.id===r.serverId);
          _saveServerCode(r.serverId, _extractCode(srow));
          await openServer(r.serverId);
          setRoute(`/servers/${r.serverId}`);
          return;
        } catch { showInviteExpired(); return; }
      }

      const pathJoin = location.pathname.match(/^\/servers\/([a-z0-9_]+)\/([a-z0-9]{8})$/i);
      if (pathJoin) {
        try {
          const r = await api(`/api/servers/${pathJoin[1]}/join-code`, {
            method: 'POST', body: JSON.stringify({ code: pathJoin[2] })
          });
          _saveServerCode(r.serverId, pathJoin[2]);
          await openServer(r.serverId);
          setRoute(`/servers/${r.serverId}`);
          return;
        } catch { showInviteExpired(); return; }
      }

      const isPlainEntry = location.pathname==='/' || location.pathname==='/login';
      if (!isPlainEntry && activeServerId) {
        try { await openServer(activeServerId); return; } catch {}
      }

      if (isPlainEntry) {
        setRoute('/login');
      }
    });
  } else {
    document.addEventListener('DOMContentLoaded', () => {
      const oldLogin = window.doLogin;
      window.doLogin = async function () {
        const pwd = document.getElementById('pwdInp').value;
        try {
          const r = await fetch('/api/admin/login', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: pwd })
          }).then((x) => x.json());
          if (!r.token) throw new Error();
          localStorage.setItem('morv_admin_token', r.token);
          if (oldLogin) oldLogin();
          loadServers();
        } catch {
          if (oldLogin && pwd === 'mrvall106') {
            oldLogin();
            return;
          }
          const err = document.getElementById('loginErr');
          if (err) err.textContent = 'Неверный пароль';
        }
      };

      async function loadServers() {
        const token = localStorage.getItem('morv_admin_token');
        if (!token) return;
        try {
          const r = await fetch('/api/admin/servers', { headers: { Authorization: 'Bearer ' + token } }).then((x) => x.json());
          if (window.STATE) {
            window.STATE.foServers = r.servers.map((s) => ({
              id: s.id,
              name: s.name || s.id,
              org: 'USER',
              status: 'active',
              created: new Date().toISOString().slice(0, 10),
              users: s.members,
              joinCode: s.joinCode
            }));
            if (typeof renderFOServers === 'function') renderFOServers();
            if (typeof refreshStats === 'function') refreshStats();
          }
        } catch {}
      }

      setInterval(loadServers, 3000);
    });
  }
})();
