(function(){
  const isAdmin = location.pathname.startsWith('/admmrv');

  async function api(path, opts={}){
    const token = localStorage.getItem('morv_token');
    const headers = Object.assign({'Content-Type':'application/json'}, opts.headers||{});
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(path, Object.assign({}, opts, { headers }));
    const data = await res.json().catch(()=>({}));
    if (!res.ok) throw new Error(data.error || 'api_error');
    return data;
  }

  if (!isAdmin) {
    document.addEventListener('DOMContentLoaded', async () => {
      const sub = document.querySelector('.privacy-badge-sub');
      if (sub) sub.remove();

      try {
        const access = await fetch('/api/access').then(r=>r.json());
        if (!access.allowed) {
          document.body.innerHTML = `<div style="padding:40px;font-family:Inter,sans-serif;color:#fff;background:#0c0c0e;min-height:100vh;">${access.message}<br><small>${access.reason||''}</small></div>`;
          return;
        }
      } catch {}

      if (!localStorage.getItem('morv_token')) {
        try {
          const login = await api('/api/auth/login', { method:'POST', body: JSON.stringify({ name: localStorage.getItem('morv_name') || '' })});
          localStorage.setItem('morv_token', login.token);
          localStorage.setItem('morv_name', login.user.name);
        } catch {}
      }

      if (typeof window.sim === 'function') window.sim = function(){};

      const oldCreate = window.doCreateServer;
      window.doCreateServer = async function(){
        try {
          const r = await api('/api/servers', { method:'POST' });
          closeSh('sh-create');
          if (typeof boot === 'function') boot(r.server.id, r.server.id);
        } catch {
          oldCreate && oldCreate();
        }
      };

      window.joinServer = async function(){
        const v=(document.getElementById('joinInput')||{}).value||'';
        const m=v.match(/invite=([a-z0-9_]+)/i)||v.match(/([a-z0-9_]{10,})$/i);
        if(!m) return;
        try {
          const r = await api('/api/invites/'+m[1]+'/join', { method:'POST' });
          boot(r.serverId, r.serverId);
        } catch {}
      };

      window.showQR = async function(){
        try {
          const r = await api('/api/servers/'+$.sid+'/invite', { method:'POST' });
          document.getElementById('qrLink').textContent=r.inviteUrl;
          const img = new Image();
          img.onload = function(){
            const canvas=document.getElementById('qrCanvas');
            const ctx=canvas.getContext('2d');
            ctx.clearRect(0,0,canvas.width,canvas.height);
            ctx.drawImage(img,0,0,canvas.width,canvas.height);
          };
          img.src = r.qrDataUrl;
          openSh('sh-qr');
        } catch {}
      };

      window.copyInv = async function(){
        try {
          const r = await api('/api/servers/'+$.sid+'/invite', { method:'POST' });
          await navigator.clipboard.writeText(r.inviteUrl);
          toast('Ссылка скопирована!');
        } catch {}
      };

      window.doPanic = async function(){
        try { await api('/api/panic', { method:'POST' }); } catch {}
        closeSh('sh-panic');
        if (typeof closeSettingsSection === 'function') closeSettingsSection();
        location.reload();
      };
    });
  } else {
    document.addEventListener('DOMContentLoaded', () => {
      const oldLogin = window.doLogin;
      window.doLogin = async function(){
        const pwd = document.getElementById('pwdInp').value;
        try {
          const r = await fetch('/api/admin/login', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({password:pwd})}).then(x=>x.json());
          if (!r.token) throw new Error();
          localStorage.setItem('morv_admin_token', r.token);
          if (oldLogin) oldLogin();
          loadServers();
        } catch {
          const err = document.getElementById('loginErr');
          if (err) err.textContent = 'Неверный пароль';
        }
      };

      async function loadServers(){
        const token = localStorage.getItem('morv_admin_token');
        if (!token) return;
        try {
          const r = await fetch('/api/admin/servers', { headers: { Authorization: 'Bearer '+token }}).then(x=>x.json());
          if (window.STATE) {
            window.STATE.foServers = r.servers.map(s=>({ id:s.id, name:s.name||s.id, org:'USER', status:'active', created:new Date().toISOString().slice(0,10), users:s.members }));
            if (typeof renderFOServers === 'function') renderFOServers();
            if (typeof refreshStats === 'function') refreshStats();
          }
        } catch {}
      }

      setInterval(loadServers, 5000);
    });
  }
})();
