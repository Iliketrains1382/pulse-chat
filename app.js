const IS_POPUP = !!document.getElementById('view-chats');
let peer = null;
let myCode = '';
let activeTarget = null;
let liveConns = {};
let currentCall = null;
let msgTimestamps = [];

const chimeAudio = new Audio(chrome.runtime.getURL('chime.mp3'));
const ringtoneAudio = new Audio(chrome.runtime.getURL('ringtone.mp3'));
const callingAudio = new Audio(chrome.runtime.getURL('calling.mp3'));
ringtoneAudio.loop = true;
callingAudio.loop = true;

function playSound(audioObj) {
  chrome.storage.local.get(['pulse_settings'], (res) => {
    const s = res.pulse_settings || {};
    if (s.sound !== false && s.status !== 'dnd') {
      audioObj.volume = s.volume !== undefined ? parseFloat(s.volume) : 1.0;
      audioObj.currentTime = 0;
      audioObj.play().catch(() => {});
    }
  });
}

function stopCallAudio() {
  ringtoneAudio.pause();
  callingAudio.pause();
  ringtoneAudio.currentTime = 0;
  callingAudio.currentTime = 0;
}

function getState(keys, cb) { chrome.storage.local.get(keys, cb); }
function setState(obj, cb) { chrome.storage.local.set(obj, cb); }

document.addEventListener('DOMContentLoaded', () => {
  loadSettingsAndTheme();
  initPeerNetwork();
  bindUIEvents();
  deliverPendingInbox();
  refreshAllViews();

  chrome.storage.onChanged.addListener((changes) => {
    if (changes.pulse_settings) loadSettingsAndTheme();
    if (changes.pulse_pending_inbox) deliverPendingInbox();
    if (changes.pulse_friends || changes.pulse_groups || changes.pulse_requests || changes.pulse_history) {
      refreshAllViews();
      flushOfflineQueue();
    }
  });
});

function deliverPendingInbox() {
  getState(['pulse_pending_inbox', 'pulse_friends', 'pulse_history', 'pulse_requests', 'pulse_settings'], (res) => {
    const pending = res.pulse_pending_inbox || [];
    if (pending.length === 0) return;

    const friends = res.pulse_friends || [];
    const history = res.pulse_history || {};
    const requests = res.pulse_requests || [];
    const dmFilter = (res.pulse_settings || {}).dmFilter || 'requests';

    pending.forEach(item => {
      const isFriend = friends.some(f => f.code === item.senderCode);
      if (!isFriend) {
        if (dmFilter === 'friends_only') return;
        if (!requests.some(r => r.code === item.senderCode && r.type === 'message')) {
          requests.push({ type: 'message', code: item.senderCode, text: item.text });
        }
      } else {
        if (!history[item.senderCode]) history[item.senderCode] = [];
        history[item.senderCode].push({
          id: item.msgId,
          sender: item.senderCode,
          text: item.text,
          time: item.time,
          self: false
        });
        sendPayloadToCode(item.senderCode, { type: 'READ_ACK', msgId: item.msgId });
      }
    });

    playSound(chimeAudio);
    setState({ pulse_pending_inbox: [], pulse_history: history, pulse_requests: requests }, refreshAllViews);
  });
}

function initPeerNetwork() {
  getState(['pulse_my_code'], (res) => {
    myCode = res.pulse_my_code;
    if (!myCode) {
      myCode = Math.random().toString(36).substring(2, 6).toUpperCase();
      setState({ pulse_my_code: myCode });
    }
    document.getElementById('myCodeDisplay').textContent = myCode;
    if (document.getElementById('settingsProfileCode')) {
      document.getElementById('settingsProfileCode').textContent = myCode;
    }

    const peerId = IS_POPUP ? `pulse-pop-${myCode}` : `pulse-ws-${myCode}`;
    if (peer) peer.destroy();
    peer = new Peer(peerId);

    peer.on('open', (id) => {
      const dot = document.getElementById('statusDot');
      if (dot) dot.classList.add('online');
      if (document.getElementById('devFullId')) document.getElementById('devFullId').textContent = id;
      connectToAllFriends();
    });

    peer.on('connection', (conn) => handleIncomingConnection(conn));

    peer.on('call', (call) => {
      currentCall = call;
      playSound(ringtoneAudio);
      const callerCode = extractCode(call.peer);
      if (IS_POPUP) {
        chrome.tabs.create({ url: chrome.runtime.getURL('index.html') });
      } else {
        document.getElementById('callerNameTitle').textContent = `Call from ${callerCode}`;
        document.getElementById('callModal').style.display = 'flex';
      }
    });
  });
}

function extractCode(fullPeerId) {
  return fullPeerId.replace('pulse-pop-', '').replace('pulse-ws-', '').replace('pulse-bg-', '');
}

function connectToAllFriends() {
  getState(['pulse_friends'], (res) => {
    (res.pulse_friends || []).forEach(f => connectToCode(f.code));
  });
}

function connectToCode(targetCode) {
  if (!peer || targetCode === myCode) return;
  ['pulse-ws-', 'pulse-pop-', 'pulse-bg-'].forEach(prefix => {
    const fullId = prefix + targetCode;
    if (!liveConns[fullId] || !liveConns[fullId].open) {
      const conn = peer.connect(fullId);
      handleIncomingConnection(conn);
    }
  });
}

function handleIncomingConnection(conn) {
  const senderCode = extractCode(conn.peer);

  conn.on('open', () => {
    liveConns[conn.peer] = conn;
    if (document.getElementById('devConnCount')) {
      document.getElementById('devConnCount').textContent = Object.keys(liveConns).length;
    }
    flushOfflineQueue();
    refreshAllViews();
  });

  conn.on('data', (payload) => {
    if (!payload) return;

    if (payload.type === 'FRIEND_REQUEST') {
      addRequest({ type: 'friend', code: senderCode, name: payload.name || senderCode });
      return;
    }

    if (payload.type === 'GROUP_MSG') {
      saveMessageToHistory(payload.groupId, {
        sender: payload.senderName || senderCode,
        text: payload.text,
        time: Date.now(),
        self: false
      });
      notifyIfNotViewing(payload.groupId, `${payload.groupName} (${payload.senderName || senderCode})`, payload.text);
      return;
    }

    if (payload.type === 'DM') {
      getState(['pulse_friends', 'pulse_settings'], (res) => {
        const friends = res.pulse_friends || [];
        const dmFilter = (res.pulse_settings || {}).dmFilter || 'requests';
        const isFriend = friends.some(f => f.code === senderCode);

        if (!isFriend) {
          if (dmFilter === 'friends_only') return;
          addRequest({ type: 'message', code: senderCode, text: payload.text });
        } else {
          saveMessageToHistory(senderCode, {
            id: payload.msgId,
            sender: payload.senderName || senderCode,
            text: payload.text,
            time: Date.now(),
            self: false
          });
          conn.send({ type: 'READ_ACK', msgId: payload.msgId });
          notifyIfNotViewing(senderCode, payload.senderName || senderCode, payload.text);
        }
      });
    }

    if (payload.type === 'READ_ACK') {
      markMessageRead(senderCode, payload.msgId);
    }
  });

  conn.on('close', () => {
    delete liveConns[conn.peer];
    if (document.getElementById('devConnCount')) {
      document.getElementById('devConnCount').textContent = Object.keys(liveConns).length;
    }
    refreshAllViews();
  });
}

function sendPayloadToCode(targetCode, payload) {
  const wsConn = liveConns[`pulse-ws-${targetCode}`];
  const popConn = liveConns[`pulse-pop-${targetCode}`];
  const bgConn = liveConns[`pulse-bg-${targetCode}`];
  let sent = false;

  if (wsConn && wsConn.open) { wsConn.send(payload); sent = true; }
  if (popConn && popConn.open) { popConn.send(payload); sent = true; }
  if (!sent && bgConn && bgConn.open) { bgConn.send(payload); sent = true; }

  if (!sent) {
    getState(['pulse_outbox'], (res) => {
      const outbox = res.pulse_outbox || [];
      outbox.push({ targetCode, payload });
      setState({ pulse_outbox: outbox });
    });
    connectToCode(targetCode);
  }
  return sent;
}

function flushOfflineQueue() {
  getState(['pulse_outbox'], (res) => {
    const outbox = res.pulse_outbox || [];
    if (outbox.length === 0) return;

    const remaining = [];
    outbox.forEach(item => {
      const wsConn = liveConns[`pulse-ws-${item.targetCode}`];
      const popConn = liveConns[`pulse-pop-${item.targetCode}`];
      const bgConn = liveConns[`pulse-bg-${item.targetCode}`];

      if ((wsConn && wsConn.open) || (popConn && popConn.open) || (bgConn && bgConn.open)) {
        if (wsConn && wsConn.open) wsConn.send(item.payload);
        else if (popConn && popConn.open) popConn.send(item.payload);
        else if (bgConn && bgConn.open) bgConn.send(item.payload);
        markMessageDelivered(item.targetCode, item.payload.msgId);
      } else {
        remaining.push(item);
      }
    });
    setState({ pulse_outbox: remaining });
  });
}

function saveMessageToHistory(chatId, msgObj) {
  getState(['pulse_history'], (res) => {
    const history = res.pulse_history || {};
    if (!history[chatId]) history[chatId] = [];
    history[chatId].push(msgObj);
    setState({ pulse_history: history });
  });
}

function markMessageDelivered(chatId, msgId) {
  getState(['pulse_history'], (res) => {
    const history = res.pulse_history || {};
    if (history[chatId]) {
      const msg = history[chatId].find(m => m.id === msgId);
      if (msg && msg.status !== 'Read') msg.status = 'Sent';
      setState({ pulse_history: history });
    }
  });
}

function markMessageRead(chatId, msgId) {
  getState(['pulse_history'], (res) => {
    const history = res.pulse_history || {};
    if (history[chatId]) {
      const msg = history[chatId].find(m => m.id === msgId);
      if (msg) msg.status = 'Read';
      setState({ pulse_history: history });
    }
  });
}

function addRequest(reqObj) {
  getState(['pulse_requests'], (res) => {
    const reqs = res.pulse_requests || [];
    if (!reqs.some(r => r.code === reqObj.code && r.type === reqObj.type)) {
      reqs.push(reqObj);
      setState({ pulse_requests: reqs });
      playSound(chimeAudio);
    }
  });
}

function notifyIfNotViewing(chatId, title, text) {
  const isViewing = document.hasFocus() && activeTarget && activeTarget.id === chatId;
  if (!isViewing) {
    playSound(chimeAudio);
    chrome.runtime.sendMessage({
      type: 'NEW_MESSAGE_NOTIFICATION',
      senderCode: chatId,
      senderName: title,
      text: text
    });
  }
}

function refreshAllViews() {
  getState(['pulse_friends', 'pulse_groups', 'pulse_requests', 'pulse_history', 'pulse_settings'], (res) => {
    const friends = res.pulse_friends || [];
    const groups = res.pulse_groups || [];
    const requests = res.pulse_requests || [];
    const history = res.pulse_history || {};
    const devMode = !!(res.pulse_settings || {}).devMode;

    const badge = document.getElementById('reqBadge');
    if (badge) {
      badge.textContent = requests.length;
      badge.style.display = requests.length > 0 ? 'inline-block' : 'none';
    }

    if (IS_POPUP) {
      renderList('friendsList', friends, 'dm', devMode);
      renderList('groupsList', groups, 'group', devMode);
      renderRequestsList('requestsList', requests);
    } else {
      const mode = document.getElementById('railGroups').classList.contains('active') ? 'group' :
                   document.getElementById('railRequests').classList.contains('active') ? 'req' : 'dm';
      if (mode === 'req') renderRequestsList('sidebarList', requests);
      else if (mode === 'group') renderList('sidebarList', groups, 'group', devMode);
      else renderList('sidebarList', friends, 'dm', devMode);
    }

    renderActiveChat(history);
    updateStorageStats();
  });
}

function renderList(containerId, items, type, devMode) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = '';

  if (items.length === 0) {
    container.innerHTML = `<div style="color:var(--muted); text-align:center; padding:16px; font-size:0.82rem;">No ${type === 'dm' ? 'friends' : 'groups'} yet.</div>`;
    return;
  }

  items.forEach(item => {
    const id = type === 'dm' ? item.code : item.id;
    const isOnline = type === 'dm' && (liveConns[`pulse-ws-${id}`]?.open || liveConns[`pulse-pop-${id}`]?.open);
    const el = document.createElement('div');
    el.className = `list-card ${activeTarget && activeTarget.id === id ? 'active' : ''}`;
    el.innerHTML = `
      <div>
        <div style="font-weight:700;">${type === 'group' ? '# ' : ''}${item.name}</div>
        <div style="font-size:0.72rem; color:var(--muted);">${type === 'dm' ? (devMode ? `pulse-ws-${id}` : `Code: ${id}`) : `${item.members.length} members`}</div>
      </div>
      ${type === 'dm' ? `<span style="color:${isOnline ? '#10b981' : '#64748b'};">●</span>` : ''}
    `;
    el.onclick = () => {
      activeTarget = { type, id, name: item.name, members: item.members };
      if (IS_POPUP) switchPopupTab('chats');
      refreshAllViews();
    };
    container.appendChild(el);
  });
}

function renderRequestsList(containerId, requests) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = '';

  if (requests.length === 0) {
    container.innerHTML = `<div style="color:var(--muted); text-align:center; padding:16px; font-size:0.82rem;">No pending requests.</div>`;
    return;
  }

  requests.forEach((req, idx) => {
    const el = document.createElement('div');
    el.className = 'list-card';
    el.style.flexDirection = 'column';
    el.style.alignItems = 'flex-start';
    el.style.gap = '8px';
    el.innerHTML = `
      <div>
        <span style="font-size:0.7rem; background:var(--accent); color:#fff; padding:2px 6px; border-radius:4px;">${req.type.toUpperCase()} REQUEST</span>
        <strong style="margin-left:6px;">${req.code}</strong>
        ${req.text ? `<div style="font-size:0.8rem; color:var(--muted); margin-top:4px;">"${req.text}"</div>` : ''}
      </div>
      <div style="display:flex; gap:6px; width:100%;">
        <button class="btn-success" style="flex:1;" data-accept="${idx}">Accept</button>
        <button class="btn-danger" style="flex:1;" data-decline="${idx}">Decline</button>
      </div>
    `;
    el.querySelector('[data-accept]').onclick = () => acceptRequest(idx);
    el.querySelector('[data-decline]').onclick = () => declineRequest(idx);
    container.appendChild(el);
  });
}

function acceptRequest(idx) {
  getState(['pulse_requests', 'pulse_friends', 'pulse_history'], (res) => {
    const reqs = res.pulse_requests || [];
    const friends = res.pulse_friends || [];
    const history = res.pulse_history || {};
    const req = reqs[idx];

    if (req && !friends.some(f => f.code === req.code)) {
      friends.push({ code: req.code, name: req.name || req.code });
    }
    if (req && req.text) {
      if (!history[req.code]) history[req.code] = [];
      history[req.code].push({ sender: req.code, text: req.text, time: Date.now(), self: false });
    }

    reqs.splice(idx, 1);
    setState({ pulse_requests: reqs, pulse_friends: friends, pulse_history: history }, () => {
      connectToCode(req.code);
      refreshAllViews();
    });
  });
}

function declineRequest(idx) {
  getState(['pulse_requests'], (res) => {
    const reqs = res.pulse_requests || [];
    reqs.splice(idx, 1);
    setState({ pulse_requests: reqs }, refreshAllViews);
  });
}

function renderActiveChat(history) {
  const titleEl = document.getElementById('activeChatTitle');
  const box = document.getElementById('messagesBox');
  const callBtn = document.getElementById('popupCallBtn') || document.getElementById('wsCallBtn');
  const offlineBanner = document.getElementById('offlineBanner');

  if (!activeTarget) {
    titleEl.textContent = 'Select a Friend or Group';
    box.innerHTML = '';
    if (callBtn) callBtn.style.display = 'none';
    return;
  }

  titleEl.textContent = `${activeTarget.type === 'group' ? '# ' : ''}${activeTarget.name}`;
  if (callBtn) callBtn.style.display = activeTarget.type === 'dm' ? 'inline-block' : 'none';

  if (offlineBanner && activeTarget.type === 'dm') {
    const isOnline = liveConns[`pulse-ws-${activeTarget.id}`]?.open || liveConns[`pulse-pop-${activeTarget.id}`]?.open;
    offlineBanner.style.display = isOnline ? 'none' : 'inline-block';
  } else if (offlineBanner) {
    offlineBanner.style.display = 'none';
  }

  const msgs = history[activeTarget.id] || [];
  box.innerHTML = '';

  getState(['pulse_settings'], (res) => {
    const s = res.pulse_settings || {};
    const showReceipts = s.receipts !== false;
    const use24h = s.timeFormat === '24h';

    msgs.forEach(m => {
      const div = document.createElement('div');
      div.className = `message ${m.self ? 'sent' : 'received'}`;
      const timeStr = new Date(m.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: !use24h });
      const statusHtml = (m.self && showReceipts && m.status) ? `<span>${m.status === 'Queued' ? '🕒 Queued' : m.status === 'Read' ? '✓✓ Read' : '✓ Sent'}</span>` : '';
      
      div.innerHTML = `
        ${!m.self && activeTarget.type === 'group' ? `<div style="font-size:0.7rem; font-weight:700; color:var(--accent); margin-bottom:2px;">${m.sender}</div>` : ''}
        <div>${m.text}</div>
        <div class="msg-meta"><span>${timeStr}</span>${statusHtml}</div>
      `;
      box.appendChild(div);
    });
    box.scrollTop = box.scrollHeight;
  });
}

function handleSendMessage() {
  const input = document.getElementById('msgInput');
  const text = input.value.trim();
  if (!text || !activeTarget) return;

  getState(['pulse_settings'], (res) => {
    const s = res.pulse_settings || {};
    if (s.antiSpam !== false) {
      const now = Date.now();
      msgTimestamps.push(now);
      msgTimestamps = msgTimestamps.filter(t => now - t < 2000);
      if (msgTimestamps.length > 5) {
        alert('Slow down! You are sending messages too fast.');
        return;
      }
    }

    const msgId = 'msg-' + Date.now();
    const senderName = s.displayName || myCode;

    if (activeTarget.type === 'dm') {
      const sent = sendPayloadToCode(activeTarget.id, { type: 'DM', text, msgId, senderName });
      saveMessageToHistory(activeTarget.id, {
        id: msgId,
        sender: senderName,
        text,
        time: Date.now(),
        self: true,
        status: sent ? 'Sent' : 'Queued'
      });
    } else if (activeTarget.type === 'group') {
      saveMessageToHistory(activeTarget.id, {
        id: msgId,
        sender: 'You',
        text,
        time: Date.now(),
        self: true
      });
      (activeTarget.members || []).forEach(memberCode => {
        if (memberCode !== myCode) {
          sendPayloadToCode(memberCode, {
            type: 'GROUP_MSG',
            groupId: activeTarget.id,
            groupName: activeTarget.name,
            senderName,
            text
          });
        }
      });
    }

    input.value = '';
  });
}

function loadSettingsAndTheme() {
  getState(['pulse_settings', 'pulse_custom_theme'], (res) => {
    const s = res.pulse_settings || {};
    const theme = s.theme || 'discord-dark';
    document.documentElement.setAttribute('data-theme', theme);

    if (theme === 'custom' && res.pulse_custom_theme) {
      const c = res.pulse_custom_theme;
      document.documentElement.style.setProperty('--bg-dark', c.bg);
      document.documentElement.style.setProperty('--bg-panel', c.bg);
      document.documentElement.style.setProperty('--accent', c.accent);
      document.documentElement.style.setProperty('--sent', c.accent);
      document.documentElement.style.setProperty('--text', c.text);
    } else {
      ['--bg-dark', '--bg-panel', '--accent', '--sent', '--text'].forEach(p => document.documentElement.style.removeProperty(p));
    }

    document.body.style.setProperty('--font-size', s.fontSize || (IS_POPUP ? '14px' : '15px'));
    document.body.classList.toggle('high-contrast', !!s.highContrast);
    document.body.classList.toggle('compact', !!s.compact);
    document.body.classList.toggle('reduced-motion', !!s.reducedMotion);

    const displayName = s.displayName || 'User';
    if (document.getElementById('footerDisplayName')) document.getElementById('footerDisplayName').textContent = displayName;
    if (document.getElementById('settingsProfileName')) document.getElementById('settingsProfileName').textContent = displayName;
    if (document.getElementById('setDisplayName')) document.getElementById('setDisplayName').value = s.displayName || '';

    const status = s.status || 'online';
    const dot = document.getElementById('footerStatusDot');
    if (dot) dot.className = `status-pill status-${status}`;
    if (document.getElementById('setOnlineStatus')) document.getElementById('setOnlineStatus').value = status;

    if (document.getElementById('themeSelect')) {
      document.getElementById('themeSelect').value = theme;
      document.getElementById('customThemeBox').style.display = theme === 'custom' ? 'flex' : 'none';
      document.getElementById('setSound').checked = s.sound !== false;
      document.getElementById('setNotif').checked = s.notifications !== false;
      document.getElementById('setEnterSend').checked = s.enterSend !== false;
      document.getElementById('setReceipts').checked = s.receipts !== false;
      document.getElementById('setFontSize').value = s.fontSize || (IS_POPUP ? '14px' : '15px');
      document.getElementById('setHighContrast').checked = !!s.highContrast;
      document.getElementById('setCompact').checked = !!s.compact;
      if (document.getElementById('setReducedMotion')) document.getElementById('setReducedMotion').checked = !!s.reducedMotion;
      if (document.getElementById('setAntiSpam')) document.getElementById('setAntiSpam').checked = s.antiSpam !== false;
      if (document.getElementById('setDmFilter')) document.getElementById('setDmFilter').value = s.dmFilter || 'requests';
      if (document.getElementById('setVolume')) document.getElementById('setVolume').value = s.volume !== undefined ? s.volume : 1;
      if (document.getElementById('setEcho')) document.getElementById('setEcho').checked = s.echo !== false;
      if (document.getElementById('setNoise')) document.getElementById('setNoise').checked = s.noise !== false;
      if (document.getElementById('setTimeFormat')) document.getElementById('setTimeFormat').value = s.timeFormat || '12h';
      if (document.getElementById('setDevMode')) {
        document.getElementById('setDevMode').checked = !!s.devMode;
        if (document.getElementById('devDebugBox')) document.getElementById('devDebugBox').style.display = s.devMode ? 'block' : 'none';
      }
    }
  });
}

function updateSetting(key, val) {
  getState(['pulse_settings'], (res) => {
    const s = res.pulse_settings || {};
    s[key] = val;
    setState({ pulse_settings: s });
  });
}

function updateStorageStats() {
  const el = document.getElementById('storageStats');
  if (!el || !chrome.storage.local.getBytesInUse) return;
  chrome.storage.local.getBytesInUse(null, (bytes) => {
    const kb = (bytes / 1024).toFixed(1);
    el.textContent = `Storage Used: ${kb} KB`;
  });
}

function switchPopupTab(tabName) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tabName));
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === `view-${tabName}`));
}

function bindUIEvents() {
  if (IS_POPUP) {
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.onclick = () => switchPopupTab(btn.dataset.tab);
    });
    document.getElementById('openWorkspaceBtn').onclick = () => {
      chrome.tabs.create({ url: chrome.runtime.getURL('index.html') });
    };
    document.getElementById('addFriendBtn').onclick = promptAddFriend;
    document.getElementById('createGroupBtn').onclick = promptCreateGroup;
  } else {
    document.getElementById('railFriends').onclick = (e) => setActiveRail(e.currentTarget, 'DIRECT MESSAGES', '+ Add Friend', promptAddFriend);
    document.getElementById('railGroups').onclick = (e) => setActiveRail(e.currentTarget, 'GROUP CHANNELS', '+ Create Group', promptCreateGroup);
    document.getElementById('railRequests').onclick = (e) => setActiveRail(e.currentTarget, 'PENDING REQUESTS', '', null);
    document.getElementById('railSettings').onclick = () => { document.getElementById('settingsOverlay').style.display = 'flex'; };
    document.getElementById('closeSettingsBtn').onclick = () => { document.getElementById('settingsOverlay').style.display = 'none'; };
    document.getElementById('sidebarActionBtn').onclick = promptAddFriend;

    // Settings Category Tabs
    document.querySelectorAll('.settings-tab').forEach(tab => {
      tab.onclick = () => {
        document.querySelectorAll('.settings-tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.settings-section').forEach(s => s.classList.remove('active'));
        tab.classList.add('active');
        document.getElementById(`sec-${tab.dataset.sec}`).classList.add('active');
      };
    });

    // Settings Search Filter
    document.getElementById('settingsSearchInput').oninput = (e) => {
      const q = e.target.value.toLowerCase();
      document.querySelectorAll('.settings-section').forEach(sec => {
        if (!q) {
          sec.style.display = sec.classList.contains('active') ? 'flex' : 'none';
          return;
        }
        const match = sec.textContent.toLowerCase().includes(q);
        sec.style.display = match ? 'flex' : 'none';
      });
    };

    if (document.getElementById('regenCodeBtn')) {
      document.getElementById('regenCodeBtn').onclick = () => {
        if (confirm('Generate a new 4-digit Peer Code? Friends will need your new code.')) {
          const newCode = Math.random().toString(36).substring(2, 6).toUpperCase();
          setState({ pulse_my_code: newCode }, () => initPeerNetwork());
        }
      };
    }

    if (document.getElementById('testRingtoneBtn')) {
      document.getElementById('testRingtoneBtn').onclick = () => playSound(chimeAudio);
    }

    if (document.getElementById('exportDataBtn')) {
      document.getElementById('exportDataBtn').onclick = () => {
        getState(null, (allData) => {
          const blob = new Blob([JSON.stringify(allData, null, 2)], { type: 'application/json' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `pulse-backup-${Date.now()}.json`;
          a.click();
        });
      };
    }
  }

  document.getElementById('copyCodeBtn').onclick = () => {
    navigator.clipboard.writeText(myCode);
    const btn = document.getElementById('copyCodeBtn');
    btn.textContent = 'Copied!';
    setTimeout(() => btn.textContent = 'Copy', 1500);
  };

  document.getElementById('sendBtn').onclick = handleSendMessage;
  document.getElementById('msgInput').onkeydown = (e) => {
    getState(['pulse_settings'], (res) => {
      const enterSend = (res.pulse_settings || {}).enterSend !== false;
      if (enterSend && e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSendMessage();
      }
    });
  };

  // Bind All Settings Controls
  if (document.getElementById('saveDisplayNameBtn')) {
    document.getElementById('saveDisplayNameBtn').onclick = () => {
      updateSetting('displayName', document.getElementById('setDisplayName').value.trim() || 'User');
    };
  }
  if (document.getElementById('setOnlineStatus')) document.getElementById('setOnlineStatus').onchange = (e) => updateSetting('status', e.target.value);
  if (document.getElementById('setDmFilter')) document.getElementById('setDmFilter').onchange = (e) => updateSetting('dmFilter', e.target.value);
  if (document.getElementById('setAntiSpam')) document.getElementById('setAntiSpam').onchange = (e) => updateSetting('antiSpam', e.target.checked);
  if (document.getElementById('setVolume')) document.getElementById('setVolume').oninput = (e) => updateSetting('volume', e.target.value);
  if (document.getElementById('setEcho')) document.getElementById('setEcho').onchange = (e) => updateSetting('echo', e.target.checked);
  if (document.getElementById('setNoise')) document.getElementById('setNoise').onchange = (e) => updateSetting('noise', e.target.checked);
  if (document.getElementById('setReducedMotion')) document.getElementById('setReducedMotion').onchange = (e) => updateSetting('reducedMotion', e.target.checked);
  if (document.getElementById('setTimeFormat')) document.getElementById('setTimeFormat').onchange = (e) => updateSetting('timeFormat', e.target.value);
  if (document.getElementById('setDevMode')) document.getElementById('setDevMode').onchange = (e) => updateSetting('devMode', e.target.checked);

  document.getElementById('themeSelect').onchange = (e) => updateSetting('theme', e.target.value);
  document.getElementById('saveCustomThemeBtn').onclick = () => {
    setState({
      pulse_custom_theme: {
        bg: document.getElementById('custBg').value,
        accent: document.getElementById('custAccent').value,
        text: document.getElementById('custText').value
      }
    }, () => updateSetting('theme', 'custom'));
  };
  document.getElementById('setSound').onchange = (e) => updateSetting('sound', e.target.checked);
  document.getElementById('setNotif').onchange = (e) => updateSetting('notifications', e.target.checked);
  document.getElementById('setEnterSend').onchange = (e) => updateSetting('enterSend', e.target.checked);
  document.getElementById('setReceipts').onchange = (e) => updateSetting('receipts', e.target.checked);
  document.getElementById('setFontSize').onchange = (e) => updateSetting('fontSize', e.target.value);
  document.getElementById('setHighContrast').onchange = (e) => updateSetting('highContrast', e.target.checked);
  document.getElementById('setCompact').onchange = (e) => updateSetting('compact', e.target.checked);

  document.getElementById('clearHistoryBtn').onclick = () => {
    if (confirm('Delete all saved message history to free up storage?')) {
      setState({ pulse_history: {} }, () => alert('History cleared!'));
    }
  };

  // WebRTC Calling with Voice Processing Settings
  const callBtn = document.getElementById('popupCallBtn') || document.getElementById('wsCallBtn');
  if (callBtn) {
    callBtn.onclick = () => {
      if (!activeTarget || activeTarget.type !== 'dm') return;
      if (IS_POPUP) {
        chrome.tabs.create({ url: chrome.runtime.getURL('index.html') });
        return;
      }
      getState(['pulse_settings'], (res) => {
        const s = res.pulse_settings || {};
        playSound(callingAudio);
        navigator.mediaDevices.getUserMedia({
          video: true,
          audio: { echoCancellation: s.echo !== false, noiseSuppression: s.noise !== false }
        }).then((stream) => {
          document.getElementById('localVideo').srcObject = stream;
          document.getElementById('mediaArea').style.display = 'flex';
          const call = peer.call(`pulse-ws-${activeTarget.id}`, stream);
          currentCall = call;
          call.on('stream', (remStream) => {
            stopCallAudio();
            document.getElementById('remoteVideo').srcObject = remStream;
          });
          call.on('close', endActiveCall);
        }).catch(() => {
          stopCallAudio();
          alert('Camera/Microphone access denied.');
        });
      });
    };
  }

  if (!IS_POPUP) {
    document.getElementById('acceptCallBtn').onclick = () => {
      stopCallAudio();
      document.getElementById('callModal').style.display = 'none';
      if (!currentCall) return;
      getState(['pulse_settings'], (res) => {
        const s = res.pulse_settings || {};
        navigator.mediaDevices.getUserMedia({
          video: true,
          audio: { echoCancellation: s.echo !== false, noiseSuppression: s.noise !== false }
        }).then((stream) => {
          document.getElementById('localVideo').srcObject = stream;
          document.getElementById('mediaArea').style.display = 'flex';
          currentCall.answer(stream);
          currentCall.on('stream', (remStream) => {
            document.getElementById('remoteVideo').srcObject = remStream;
          });
          currentCall.on('close', endActiveCall);
        });
      });
    };

    document.getElementById('declineCallBtn').onclick = () => {
      stopCallAudio();
      document.getElementById('callModal').style.display = 'none';
      if (currentCall) currentCall.close();
    };

    document.getElementById('endCallBtn').onclick = endActiveCall;
  }
}

function endActiveCall() {
  stopCallAudio();
  document.getElementById('mediaArea').style.display = 'none';
  if (currentCall) currentCall.close();
}

function setActiveRail(btn, title, actionText, actionFn) {
  document.querySelectorAll('.rail-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById('sidebarTitle').textContent = title;
  const actBtn = document.getElementById('sidebarActionBtn');
  if (actionText) {
    actBtn.style.display = 'inline-block';
    actBtn.textContent = actionText;
    actBtn.onclick = actionFn;
  } else {
    actBtn.style.display = 'none';
  }
  refreshAllViews();
}

function promptAddFriend() {
  const code = prompt('Enter your friend\'s 4-Digit Peer Code:');
  if (!code) return;
  const cleanCode = code.trim().toUpperCase();
  const name = prompt(`Enter a nickname for ${cleanCode}:`) || cleanCode;

  getState(['pulse_friends', 'pulse_settings'], (res) => {
    const friends = res.pulse_friends || [];
    const myName = (res.pulse_settings || {}).displayName || myCode;
    if (!friends.some(f => f.code === cleanCode)) {
      friends.push({ code: cleanCode, name });
      setState({ pulse_friends: friends }, () => {
        connectToCode(cleanCode);
        sendPayloadToCode(cleanCode, { type: 'FRIEND_REQUEST', name: myName });
        refreshAllViews();
      });
    }
  });
}

function promptCreateGroup() {
  getState(['pulse_friends', 'pulse_groups'], (res) => {
    const friends = res.pulse_friends || [];
    if (friends.length === 0) return alert('Add at least one friend first to create a group!');

    const groupName = prompt('Enter Group Name:');
    if (!groupName) return;

    const friendListStr = friends.map(f => `${f.name} (${f.code})`).join(', ');
    const codesInput = prompt(`Enter friend codes to add (comma separated):\nAvailable: ${friendListStr}`);
    if (!codesInput) return;

    const members = codesInput.split(',').map(c => c.trim().toUpperCase()).filter(Boolean);
    if (!members.includes(myCode)) members.push(myCode);

    const groups = res.pulse_groups || [];
    const newGroup = { id: 'grp-' + Date.now(), name: groupName.trim(), members };
    groups.push(newGroup);
    setState({ pulse_groups: groups }, refreshAllViews);
  });
}