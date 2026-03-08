(function () {
  const isAdmin = location.pathname.startsWith('/admmrv');
  let me = null;
  let activeServerId = localStorage.getItem('morv_active_server') || '';
  let syncTimer = null;
  let pullTimer = null;
  let lastVersion = 0;
  let applying = false;

  async function api(path, opts = {}) {
    const token = localStorage.getItem('morv_token');
    const headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(path, Object.assign({}, opts, { headers }));
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'api_error');
    return data;
  }

  function saveActiveServer(id) {
    activeServerId = id;
    localStorage.setItem('morv_active_server', id);
  }

  async function ensureLogin() {
    if (!localStorage.getItem('morv_token')) {
      const login = await api('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ name: localStorage.getItem('morv_name') || '' })
      });
      localStorage.setItem('morv_token', login.token);
      localStorage.setItem('morv_name', login.user.name);
    }
    const r = await api('/api/me');
    me = r.user;
  }

  function applyStateFromServer(payload) {
    if (!payload || !payload.state || !window.$) return;
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
      name: u.name,
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
    return {
      sid: $.sid,
      snm: $.snm,
      cats: $.cats,
      chs: $.chs,
      msgs: $.msgs,
      unread: $.unread,
      pinned: $.pinned
    };
  }

  async function pushState() {
    if (!activeServerId || applying || !window.$ || !$.sid) return;
    try {
      const r = await api(`/api/servers/${activeServerId}/state`, {
        method: 'PUT',
        body: JSON.stringify({ state: localStateSnapshot() })
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
        } catch {}
      };

      window.joinServer = async function () {
        const v = (document.getElementById('joinInput') || {}).value || '';
        const m = v.match(/invite=([a-z0-9_]+)/i) || v.match(/([a-z0-9_]{10,})$/i);
        if (!m) return;
        try {
          const r = await api('/api/invites/' + m[1] + '/join', { method: 'POST' });
          await openServer(r.serverId);
        } catch {}
      };

      window.showQR = async function () {
        try {
          const r = await api('/api/servers/' + $.sid + '/invite', { method: 'POST' });
          document.getElementById('qrLink').textContent = r.inviteUrl;
          if (typeof drawQR === 'function') drawQR(r.inviteUrl);
          openSh('sh-qr');
        } catch {}
      };

      window.copyInv = async function () {
        try {
          const r = await api('/api/servers/' + $.sid + '/invite', { method: 'POST' });
          await navigator.clipboard.writeText(r.inviteUrl);
          toast('Ссылка скопирована!');
        } catch {}
      };

      window.doPanic = async function () {
        try { await api('/api/panic', { method: 'POST' }); } catch {}
        localStorage.removeItem('morv_token');
        localStorage.removeItem('morv_active_server');
        closeSh('sh-panic');
        if (typeof closeSettingsSection === 'function') closeSettingsSection();
        location.reload();
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
            window.STATE.foServers = r.servers.map((s) => ({ id: s.id, name: s.name || s.id, org: 'USER', status: 'active', created: new Date().toISOString().slice(0, 10), users: s.members }));
            if (typeof renderFOServers === 'function') renderFOServers();
            if (typeof refreshStats === 'function') refreshStats();
          }
        } catch {}
      }

      setInterval(loadServers, 5000);
    });
  }
})();
