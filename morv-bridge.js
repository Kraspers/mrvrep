(function () {
  const isAdmin = location.pathname.startsWith('/admmrv');
  let me = null;
  let activeServerId = localStorage.getItem('morv_active_server') || '';
  let syncTimer = null;
  let pullTimer = null;
  let lastVersion = 0;
  let applying = false;

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
    $.snm = payload.server && payload.server.visibleName ? payload.server.name : (st.snm || $.sid);
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

    const firstText = Object.values($.chs).find((c) => c.type === 'text');
    if (firstText) {
      $.cur = firstText.id;
      switchCh(firstText.id);
    } else {
      renderChs();
      setView('ch');
      setTb('morv', false, false);
    }

    const avaEl = document.getElementById('srvAva');
    if (avaEl) avaEl.textContent = ($.snm || $.sid || 'M')[0].toUpperCase();
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
      if ((r.version || 0) !== lastVersion) {
        lastVersion = r.version || 0;
        applyStateFromServer(r);
      }
    } catch {}
  }

  function localStateSnapshot() {
    return { sid: $.sid, snm: $.snm, cats: $.cats, chs: $.chs, msgs: $.msgs, unread: $.unread, pinned: $.pinned };
  }

  async function pushState() {
    if (!activeServerId || applying || !window.$ || !$.sid) return;
    try {
      const r = await api(`/api/servers/${activeServerId}/state`, {
        method: 'PUT', body: JSON.stringify({ state: localStateSnapshot() })
      });
      lastVersion = r.version || lastVersion;
    } catch {}
  }

  async function openServer(serverId) {
    saveActiveServer(serverId);
    if (typeof window.sim === 'function') window.sim = function () {};

    if (typeof boot === 'function') boot(serverId, serverId);
    await pullState();

    clearInterval(syncTimer);
    clearInterval(pullTimer);
    syncTimer = setInterval(pushState, 2200);
    pullTimer = setInterval(pullState, 1800);
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
          const r = await api('/api/servers', { method: 'POST' });
          closeSh('sh-create');
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
            await openServer(r.serverId);
            return;
          }
          if (codeMatch) {
            const r = await api(`/api/servers/${codeMatch[1]}/join-code`, {
              method: 'POST', body: JSON.stringify({ code: codeMatch[2] })
            });
            await openServer(r.serverId);
            return;
          }
          toast('Неверная ссылка или код');
        } catch { toast('Не удалось войти на сервер'); }
      };

      window.showQR = async function () {
        try {
          const r = await api('/api/servers/' + $.sid + '/invite', { method: 'POST' });
          document.getElementById('qrLink').textContent = r.inviteUrl;
          if (typeof drawQR === 'function') drawQR(r.inviteUrl);
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
          await openServer(r.serverId);
          history.replaceState({}, '', '/');
          return;
        } catch {}
      }

      const pathJoin = location.pathname.match(/^\/servers\/([a-z0-9_]+)\/([a-z0-9]{8})$/i);
      if (pathJoin) {
        try {
          const r = await api(`/api/servers/${pathJoin[1]}/join-code`, {
            method: 'POST', body: JSON.stringify({ code: pathJoin[2] })
          });
          await openServer(r.serverId);
          history.replaceState({}, '', '/');
          return;
        } catch {}
      }

      if (activeServerId) {
        try { await openServer(activeServerId); return; } catch {}
      }

      try {
        const list = await api('/api/servers');
        if (list.servers && list.servers[0]) await openServer(list.servers[0].id);
      } catch {}
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

      setInterval(loadServers, 5000);
    });
  }
})();
