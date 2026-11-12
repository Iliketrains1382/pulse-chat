const IS_POPUP = !!document.getElementById('view-chats');
let peer = null;
let myCode = '';
let activeTarget = null;
let liveConns = {};
let currentCall = null;
let localStream = null;
let replyContext = null;
let typingTimeout = null;
let pttEnabled = false;
let isMuted = false;

// Screen Share Weekly Limit (10 minutes = 600 seconds)
const SCREEN_LIMIT_SEC = 600;
let screenShareTimer = null;
let screenStream = null;

// Voice Note Recording
let mediaRecorder = null;
let audioChunks = [];

const chimeAudio = new Audio(chrome.runtime.getURL('chime.mp3'));
const ringtoneAudio = new Audio(chrome.runtime.getURL('ringtone.mp3'));
const callingAudio = new Audio(chrome.runtime.getURL('calling.mp3'));
ringtoneAudio.loop = true;
callingAudio.loop = true;

function playSound(audioObj) {
  getState(['pulse_settings'], (res) => {
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
  checkWeeklyScreenQuota();
  checkStorageAutoPrune();
  refreshAllViews();

  // Silent Auto-Reconnect every 30 seconds
  setInterval(() => {
    connectToAllFriends();
  }, 30000);

  chrome.storage.onChanged.addListener((changes) => {
    if (changes.pulse_settings) loadSettingsAndTheme();
    if (changes.pulse_pending_inbox) deliverPendingInbox();
    if (changes.pulse_friends || changes.pulse_groups || changes.pulse_requests || changes.pulse_history) {
      refreshAllViews();
      flushOfflineQueue();
    }
  });
});

// --- 10-Minute Weekly Screen Share Limit ---
function getWeekStartTimestamp() {
  const now = new Date();
  const day = now.getDay();
  const diff = now.getDate() - day;
  return new Date(now.setDate(diff)).setHours(0, 0, 0, 0);
}

function checkWeeklyScreenQuota(cb) {
  getState(['pulse_screen_quota'], (res) => {
    const weekStart = getWeekStartTimestamp();
    let quota = res.pulse_screen_quota || { weekStart, usedSeconds: 0 };
    if (quota.weekStart !== weekStart) {
      quota = { weekStart, usedSeconds: 0 };
      setState({ pulse_screen_quota: quota });
    }
    const rem = Math.max(0, SCREEN_LIMIT_SEC - quota.usedSeconds);
    const mins = Math.floor(rem / 60);
    const secs = String(rem % 60).padStart(2, '0');
    const formatted = `${mins}:${secs}`;

    if (document.getElementById('screenTimeLeft')) document.getElementById('screenTimeLeft').textContent = formatted;
    if (document.getElementById('settingsScreenQuota')) document.getElementById('settingsScreenQuota').textContent = `${mins}m ${secs}s remaining this week`;
    if (cb) cb(rem, quota);
  });
}

function toggleScreenShare() {
  if (screenStream) {
    stopScreenShare();
    return;
  }
  checkWeeklyScreenQuota((rem, quota) => {
    if (rem <= 0) {
      alert('You have reached your 10-minute weekly screen share limit! It resets next week.');
      return;
    }
    navigator.mediaDevices.getDisplayMedia({ video: true }).then((stream) => {
      screenStream = stream;
      document.getElementById('localVideo').srcObject = stream;
      if (currentCall && currentCall.peerConnection) {
        const sender = currentCall.peerConnection.getSenders().find(s => s.track && s.track.kind === 'video');
        if (sender) sender.replaceTrack(stream.getVideoTracks()[0]);
      }

      stream.getVideoTracks()[0].onended = stopScreenShare;

      screenShareTimer = setInterval(() => {
        quota.usedSeconds += 1;
        setState({ pulse_screen_quota: quota }, () => {
          checkWeeklyScreenQuota((left) => {
            if (left <= 0) {
              stopScreenShare();
              alert('Your 10-minute weekly screen share time has expired.');
            }
          });
        });
      }, 1000);
    }).catch(() => {});
  });
}

function stopScreenShare() {
  if (screenShareTimer) clearInterval(screenShareTimer);
  screenShareTimer = null;
  if (screenStream) {
    screenStream.getTracks().forEach(t => t.stop());
    screenStream = null;
  }
  if (localStream) {
    document.getElementById('localVideo').srcObject = localStream;
    if (currentCall && currentCall.peerConnection) {
      const sender = currentCall.peerConnection.getSenders().find(s => s.track && s.track.kind === 'video');
      if (sender && localStream.getVideoTracks()[0]) sender.replaceTrack(localStream.getVideoTracks()[0]);
    }
  }
}

// --- Auto-Prune at 80% Storage ---
function checkStorageAutoPrune() {
  if (!chrome.storage.local.getBytesInUse) return;
  getState(['pulse_settings', 'pulse_history'], (res) => {
    const s = res.pulse_settings || {};
    if (s.autoPrune === false) return;
    chrome.storage.local.getBytesInUse(null, (bytes) => {
      const quotaBytes = chrome.storage.local.QUOTA_BYTES || 10485760;
      if (bytes / quotaBytes > 0.80) {
        const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);
        const history = res.pulse_history || {};
        Object.keys(history).forEach(chatId => {
          history[chatId] = history[chatId].filter(m => m.time > thirtyDaysAgo);
        });
        setState({ pulse_history: history });
      }
    });
  });
}

// --- PeerJS Networking ---
function initPeerNetwork() {
  getState(['pulse_my_code'], (res) => {
    myCode = res.pulse_my_code;
    if (!myCode) {
      myCode = Math.random().toString(36).substring(2, 6).toUpperCase();
      setState({ pulse_my_code: myCode });
    }
    if (document.getElementById('myCodeDisplay')) document.getElementById('myCodeDisplay').textContent = myCode;

    const peerId = IS_POPUP ? `pulse-pop-${myCode}` : `pulse-ws-${myCode}`;
    if (peer) peer.destroy();
    peer = new Peer(peerId);

    peer.on('open', () => {
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
    getState(['pulse_settings'], (res) => {
      const act = (res.pulse_settings || {}).customActivity || '';
      if (act) conn.send({ type: 'ACTIVITY_UPDATE', activity: act });
    });
    flushOfflineQueue();
    refreshAllViews();
  });

  conn.on('data', (payload) => {
    if (!payload) return;

    if (payload.type === 'TYPING') {
      if (activeTarget && activeTarget.id === senderCode && document.getElementById('typingIndicator')) {
        document.getElementById('typingIndicator').textContent = `${senderCode} is typing...`;
        clearTimeout(typingTimeout);
        typingTimeout = setTimeout(() => {
          document.getElementById('typingIndicator').textContent = '';
        }, 2500);
      }
      return;
    }

    if (payload.type === 'ACTIVITY_UPDATE') {
      updateFriendActivity(senderCode, payload.activity);
      return;
    }

    if (payload.type === 'EDIT_MSG') {
      applyRemoteEdit(senderCode, payload.msgId, payload.newText);
      return;
    }

    if (payload.type === 'DELETE_MSG') {
      applyRemoteDelete(senderCode, payload.msgId);
      return;
    }

    if (payload.type === 'POLL_VOTE') {
      applyPollVote(payload.chatId, payload.msgId, payload.optIdx);
      return;
    }

    if (payload.type === 'FRIEND_REQUEST') {
      addRequest({ type: 'friend', code: senderCode, name: payload.name || senderCode });
      return;
    }

    if (payload.type === 'GROUP_MSG') {
      saveMessageToHistory(payload.groupId, {
        id: payload.msgId,
        sender: payload.senderName || senderCode,
        text: payload.text,
        replyTo: payload.replyTo,
        poll: payload.poll,
        audioData: payload.audioData,
        time: Date.now(),
        self: false
      });
      notifyIfNotViewing(payload.groupId, `${payload.groupName} (${senderCode})`, payload.text || 'Sent media');
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
            sender: senderCode,
            text: payload.text,
            replyTo: payload.replyTo,
            poll: payload.poll,
            audioData: payload.audioData,
            time: Date.now(),
            self: false
          });
          conn.send({ type: 'READ_ACK', msgId: payload.msgId });
          notifyIfNotViewing(senderCode, senderCode, payload.text || 'Sent media');
        }
      });
    }

    if (payload.type === 'READ_ACK') {
      markMessageRead(senderCode, payload.msgId);
    }
  });

  conn.on('close', () => {
    delete liveConns[conn.peer];
    refreshAllViews();
  });
}

function updateFriendActivity(code, activity) {
  getState(['pulse_friends'], (res) => {
    const friends = res.pulse_friends || [];
    const f = friends.find(item => item.code === code);
    if (f) {
      f.activity = activity;
      setState({ pulse_friends: friends });
    }
  });
}

function deliverPendingInbox() {
  getState(['pulse_pending_inbox', 'pulse_friends', 'pulse_history', 'pulse_requests'], (res) => {
    const pending = res.pulse_pending_inbox || [];
    if (pending.length === 0) return;

    const friends = res.pulse_friends || [];
    const history = res.pulse_history || {};
    const requests = res.pulse_requests || [];

    pending.forEach(item => {
      const isFriend = friends.some(f => f.code === item.senderCode);
      if (!isFriend) {
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

function sendPayloadToCode(targetCode, payload) {
  const wsConn = liveConns[`pulse-ws-${targetCode}`];
  const popConn = liveConns[`pulse-pop-${targetCode}`];
  const bgConn = liveConns[`pulse-bg-${targetCode}`];
  let sent = false;

  if (wsConn && wsConn.open) { wsConn.send(payload); sent = true; }
  if (popConn && popConn.open) { popConn.send(payload); sent = true; }
  if (!sent && bgConn && bgConn.open) { bgConn.send(payload); sent = true; }

  if (!sent && payload.type !== 'TYPING') {
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

// --- Message Formatting (Links & YouTube Embeds) ---
function formatMessageContent(rawText) {
  if (!rawText) return '';
  let escaped = rawText.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  
  const ytRegex = /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/;
  const ytMatch = escaped.match(ytRegex);
  let embedHtml = '';
  if (ytMatch && ytMatch[1]) {
    embedHtml = `<div style="margin-top:6px;"><iframe width="240" height="135" src="https://www.youtube.com/embed/${ytMatch[1]}" frameborder="0" allowfullscreen style="border-radius:8px;"></iframe></div>`;
  }

  escaped = escaped.replace(/(https?:\/\/[^\s]+)/g, '<a href="$1" target="_blank" style="color:#38bdf8; text-decoration:underline;">$1</a>');
  return escaped + embedHtml;
}

// --- History & Edits ---
function saveMessageToHistory(chatId, msgObj) {
  getState(['pulse_history'], (res) => {
    const history = res.pulse_history || {};
    if (!history[chatId]) history[chatId] = [];
    history[chatId].push(msgObj);
    setState({ pulse_history: history });
  });
}

function applyRemoteEdit(chatId, msgId, newText) {
  getState(['pulse_history'], (res) => {
    const history = res.pulse_history || {};
    if (history[chatId]) {
      const m = history[chatId].find(item => item.id === msgId);
      if (m) { m.text = newText; m.edited = true; }
      setState({ pulse_history: history });
    }
  });
}

function applyRemoteDelete(chatId, msgId) {
  getState(['pulse_history'], (res) => {
    const history = res.pulse_history || {};
    if (history[chatId]) {
      history[chatId] = history[chatId].filter(item => item.id !== msgId);
      setState({ pulse_history: history });
    }
  });
}

function applyPollVote(chatId, msgId, optIdx) {
  getState(['pulse_history'], (res) => {
    const history = res.pulse_history || {};
    if (history[chatId]) {
      const m = history[chatId].find(item => item.id === msgId);
      if (m && m.poll && m.poll.options[optIdx]) {
        m.poll.options[optIdx].votes += 1;
        setState({ pulse_history: history });
      }
    }
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

// --- Rendering Views ---
function refreshAllViews() {
  getState(['pulse_friends', 'pulse_groups', 'pulse_requests', 'pulse_history'], (res) => {
    const friends = res.pulse_friends || [];
    const groups = res.pulse_groups || [];
    const requests = res.pulse_requests || [];
    const history = res.pulse_history || {};

    const badge = document.getElementById('reqBadge');
    if (badge) {
      badge.textContent = requests.length;
      badge.style.display = requests.length > 0 ? 'inline-block' : 'none';
    }

    if (IS_POPUP) {
      renderList('friendsList', friends, 'dm');
      renderList('groupsList', groups, 'group');
      renderRequestsList('requestsList', requests);
    } else {
      const mode = document.getElementById('railGroups').classList.contains('active') ? 'group' :
                   document.getElementById('railRequests').classList.contains('active') ? 'req' : 'dm';
      if (mode === 'req') renderRequestsList('sidebarList', requests);
      else if (mode === 'group') renderList('sidebarList', groups, 'group');
      else renderList('sidebarList', friends, 'dm');
    }

    renderActiveChat(history);
    updateStorageStats();
  });
}

function renderList(containerId, items, type) {
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
        <div style="font-size:0.72rem; color:var(--muted);">${type === 'dm' ? (item.activity || `Code: ${id}`) : `${item.members.length} members`}</div>
      </div>
      ${type === 'dm' ? `<span style="color:${isOnline ? '#10b981' : '#64748b'};">●</span>` : ''}
    `;
    el.onclick = () => {
      activeTarget = { type, id, name: item.name, members: item.members, note: item.note };
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
        <span style="font-size:0.7rem; background:var(--accent); color:#fff; padding:2px 6px; border-radius:4px;">${req.type.toUpperCase()}</span>
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
      history[req.code].push({ id: 'msg-' + Date.now(), sender: req.code, text: req.text, time: Date.now(), self: false });
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
  const callBtn = document.getElementById('wsCallBtn') || document.getElementById('popupCallBtn');
  const notesBtn = document.getElementById('friendNotesBtn');
  const searchVal = (document.getElementById('chatSearchInput')?.value || '').toLowerCase();

  if (!activeTarget) {
    titleEl.textContent = 'Select a Friend or Group';
    box.innerHTML = '';
    if (callBtn) callBtn.style.display = 'none';
    if (notesBtn) notesBtn.style.display = 'none';
    return;
  }

  titleEl.textContent = `${activeTarget.type === 'group' ? '# ' : ''}${activeTarget.name}`;
  if (callBtn) callBtn.style.display = activeTarget.type === 'dm' ? 'inline-block' : 'none';
  if (notesBtn) notesBtn.style.display = activeTarget.type === 'dm' ? 'inline-block' : 'none';

  let msgs = history[activeTarget.id] || [];
  if (searchVal) {
    msgs = msgs.filter(m => (m.text || '').toLowerCase().includes(searchVal));
  }

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
      
      let bodyHtml = '';
      if (m.replyTo) {
        bodyHtml += `<div class="reply-quote">Replying to <strong>${m.replyTo.sender}</strong>: ${m.replyTo.text}</div>`;
      }
      if (m.audioData) {
        bodyHtml += `<audio controls src="${m.audioData}" style="max-width:210px; height:32px; margin-top:4px;"></audio>`;
      } else if (m.poll) {
        bodyHtml += `<div class="poll-card"><strong>📊 ${m.poll.question}</strong>`;
        m.poll.options.forEach((opt, oIdx) => {
          bodyHtml += `<div class="poll-opt" data-poll-msg="${m.id}" data-opt="${oIdx}"><span>${opt.label}</span><strong>${opt.votes} votes</strong></div>`;
        });
        bodyHtml += `</div>`;
      } else {
        bodyHtml += `<div>${formatMessageContent(m.text)} ${m.edited ? '<span style="font-size:0.7rem; opacity:0.7;">(edited)</span>' : ''}</div>`;
      }

      div.innerHTML = `
        <div class="msg-actions">
          <button class="msg-act-btn" data-reply="${m.id}">↩️</button>
          ${m.self && !m.audioData && !m.poll ? `<button class="msg-act-btn" data-edit="${m.id}">✏️</button><button class="msg-act-btn" data-del="${m.id}">🗑️</button>` : ''}
        </div>
        ${!m.self && activeTarget.type === 'group' ? `<div style="font-size:0.7rem; font-weight:700; color:var(--accent); margin-bottom:2px;">${m.sender}</div>` : ''}
        ${bodyHtml}
        <div class="msg-meta"><span>${timeStr}</span>${statusHtml}</div>
      `;

      div.querySelector('[data-reply]').onclick = () => {
        replyContext = { sender: m.self ? 'You' : m.sender, text: (m.text || 'Media').substring(0, 50) };
        document.getElementById('replyPreviewText').textContent = `Replying to ${replyContext.sender}: "${replyContext.text}"`;
        document.getElementById('replyBanner').style.display = 'flex';
        document.getElementById('msgInput').focus();
      };

      const editBtn = div.querySelector('[data-edit]');
      if (editBtn) {
        editBtn.onclick = () => {
          const updated = prompt('Edit message:', m.text);
          if (updated && updated.trim()) {
            applyRemoteEdit(activeTarget.id, m.id, updated.trim());
            if (activeTarget.type === 'dm') sendPayloadToCode(activeTarget.id, { type: 'EDIT_MSG', msgId: m.id, newText: updated.trim() });
          }
        };
      }

      const delBtn = div.querySelector('[data-del]');
      if (delBtn) {
        delBtn.onclick = () => {
          applyRemoteDelete(activeTarget.id, m.id);
          if (activeTarget.type === 'dm') sendPayloadToCode(activeTarget.id, { type: 'DELETE_MSG', msgId: m.id });
        };
      }

      div.querySelectorAll('.poll-opt').forEach(optEl => {
        optEl.onclick = () => {
          const oIdx = parseInt(optEl.dataset.opt, 10);
          applyPollVote(activeTarget.id, m.id, oIdx);
          if (activeTarget.type === 'dm') sendPayloadToCode(activeTarget.id, { type: 'POLL_VOTE', chatId: activeTarget.id, msgId: m.id, optIdx: oIdx });
          else if (activeTarget.type === 'group') {
            (activeTarget.members || []).forEach(mc => {
              if (mc !== myCode) sendPayloadToCode(mc, { type: 'POLL_VOTE', chatId: activeTarget.id, msgId: m.id, optIdx: oIdx });
            });
          }
        };
      });

      box.appendChild(div);
    });
    box.scrollTop = box.scrollHeight;
  });
}

// --- Sending Messages & Polls ---
function handleSendMessage(extraPayload = {}) {
  const input = document.getElementById('msgInput');
  const text = input ? input.value.trim() : '';
  if (!text && !extraPayload.poll && !extraPayload.audioData) return;
  if (!activeTarget) return;

  if (text.startsWith('/poll ')) {
    const matches = text.match(/"([^"]+)"/g);
    if (matches && matches.length >= 3) {
      const clean = matches.map(s => s.replace(/"/g, ''));
      extraPayload.poll = {
        question: clean[0],
        options: clean.slice(1).map(label => ({ label, votes: 0 }))
      };
    }
  }

  const msgId = 'msg-' + Date.now();
  const msgObj = {
    id: msgId,
    sender: myCode,
    text: extraPayload.poll ? '' : text,
    replyTo: replyContext,
    poll: extraPayload.poll || null,
    audioData: extraPayload.audioData || null,
    time: Date.now(),
    self: true,
    status: 'Sent'
  };

  if (activeTarget.type === 'dm') {
    const sent = sendPayloadToCode(activeTarget.id, {
      type: 'DM',
      msgId,
      text: msgObj.text,
      replyTo: replyContext,
      poll: msgObj.poll,
      audioData: msgObj.audioData
    });
    msgObj.status = sent ? 'Sent' : 'Queued';
    saveMessageToHistory(activeTarget.id, msgObj);
  } else if (activeTarget.type === 'group') {
    msgObj.sender = 'You';
    saveMessageToHistory(activeTarget.id, msgObj);
    (activeTarget.members || []).forEach(memberCode => {
      if (memberCode !== myCode) {
        sendPayloadToCode(memberCode, {
          type: 'GROUP_MSG',
          msgId,
          groupId: activeTarget.id,
          groupName: activeTarget.name,
          senderName: myCode,
          text: msgObj.text,
          replyTo: replyContext,
          poll: msgObj.poll,
          audioData: msgObj.audioData
        });
      }
    });
  }

  replyContext = null;
  if (document.getElementById('replyBanner')) document.getElementById('replyBanner').style.display = 'none';
  if (input) input.value = '';
}

// --- Settings & UI Events ---
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

    if (document.getElementById('footerDisplayName')) document.getElementById('footerDisplayName').textContent = s.displayName || 'User';
    if (document.getElementById('footerCustomActivity')) document.getElementById('footerCustomActivity').textContent = s.customActivity || 'Ready to chat';
    if (document.getElementById('setDisplayName')) document.getElementById('setDisplayName').value = s.displayName || '';
    if (document.getElementById('setCustomActivity')) document.getElementById('setCustomActivity').value = s.customActivity || '';
    if (document.getElementById('themeSelect')) {
      document.getElementById('themeSelect').value = theme;
      document.getElementById('customThemeBox').style.display = theme === 'custom' ? 'flex' : 'none';
    }
    if (document.getElementById('setOnlineStatus')) document.getElementById('setOnlineStatus').value = s.status || 'online';
    if (document.getElementById('setDmFilter')) document.getElementById('setDmFilter').value = s.dmFilter || 'requests';
    if (document.getElementById('setReceipts')) document.getElementById('setReceipts').checked = s.receipts !== false;
    if (document.getElementById('setAutoPrune')) document.getElementById('setAutoPrune').checked = s.autoPrune !== false;
    if (document.getElementById('setNotif')) document.getElementById('setNotif').checked = s.notifications !== false;
    if (document.getElementById('setSound')) document.getElementById('setSound').checked = s.sound !== false;
    if (document.getElementById('setVolume')) document.getElementById('setVolume').value = s.volume !== undefined ? s.volume : 1;
    if (document.getElementById('setFontSize')) document.getElementById('setFontSize').value = s.fontSize || (IS_POPUP ? '14px' : '15px');
    if (document.getElementById('setHighContrast')) document.getElementById('setHighContrast').checked = !!s.highContrast;
    if (document.getElementById('setCompact')) document.getElementById('setCompact').checked = !!s.compact;
    if (document.getElementById('setReducedMotion')) document.getElementById('setReducedMotion').checked = !!s.reducedMotion;
    if (document.getElementById('setEnterSend')) document.getElementById('setEnterSend').checked = s.enterSend !== false;
    if (document.getElementById('setTimeFormat')) document.getElementById('setTimeFormat').value = s.timeFormat || '12h';
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
    document.getElementById('popupCallBtn').onclick = () => {
      chrome.tabs.create({ url: chrome.runtime.getURL('index.html') });
    };
  } else {
    document.getElementById('railFriends').onclick = (e) => setActiveRail(e.currentTarget, 'DIRECT MESSAGES', '+ Add', promptAddFriend);
    document.getElementById('railGroups').onclick = (e) => setActiveRail(e.currentTarget, 'GROUP CHANNELS', '+ Group', promptCreateGroup);
    document.getElementById('railRequests').onclick = (e) => setActiveRail(e.currentTarget, 'REQUESTS', '', null);
    document.getElementById('railSettings').onclick = () => { document.getElementById('settingsOverlay').style.display = 'flex'; };
    document.getElementById('closeSettingsBtn').onclick = () => { document.getElementById('settingsOverlay').style.display = 'none'; };
    document.getElementById('sidebarActionBtn').onclick = promptAddFriend;

    document.querySelectorAll('.settings-tab').forEach(tab => {
      tab.onclick = () => {
        document.querySelectorAll('.settings-tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.settings-section').forEach(s => s.classList.remove('active'));
        tab.classList.add('active');
        document.getElementById(`sec-${tab.dataset.sec}`).classList.add('active');
      };
    });

    document.getElementById('settingsSearchInput').oninput = (e) => {
      const q = e.target.value.toLowerCase();
      document.querySelectorAll('.settings-section').forEach(sec => {
        if (!q) {
          sec.style.display = sec.classList.contains('active') ? 'flex' : 'none';
          return;
        }
        sec.style.display = sec.textContent.toLowerCase().includes(q) ? 'flex' : 'none';
      });
    };

    document.getElementById('friendNotesBtn').onclick = () => {
      if (!activeTarget || activeTarget.type !== 'dm') return;
      getState(['pulse_friends'], (res) => {
        const friends = res.pulse_friends || [];
        const f = friends.find(item => item.code === activeTarget.id);
        if (!f) return;
        const newName = prompt('Nickname for ' + f.code + ':', f.name);
        if (newName) f.name = newName.trim();
        const newNote = prompt('Private profile note:', f.note || '');
        if (newNote !== null) f.note = newNote.trim();
        setState({ pulse_friends: friends }, () => {
          activeTarget.name = f.name;
          refreshAllViews();
        });
      });
    };

    document.getElementById('chatSearchInput').oninput = () => refreshAllViews();

    document.getElementById('wsCallBtn').onclick = () => {
      if (!activeTarget || activeTarget.type !== 'dm') return;
      playSound(callingAudio);
      navigator.mediaDevices.getUserMedia({ video: true, audio: true }).then((stream) => {
        localStream = stream;
        document.getElementById('localVideo').srcObject = stream;
        document.getElementById('mediaArea').style.display = 'flex';
        const call = peer.call(`pulse-ws-${activeTarget.id}`, stream);
        currentCall = call;
        call.on('stream', (rem) => { stopCallAudio(); document.getElementById('remoteVideo').srcObject = rem; });
        call.on('close', endActiveCall);
      }).catch(() => {
        stopCallAudio();
        alert('Camera/Microphone access denied.');
      });
    };

    document.getElementById('acceptCallBtn').onclick = () => {
      stopCallAudio();
      document.getElementById('callModal').style.display = 'none';
      if (!currentCall) return;
      navigator.mediaDevices.getUserMedia({ video: true, audio: true }).then((stream) => {
        localStream = stream;
        document.getElementById('localVideo').srcObject = stream;
        document.getElementById('mediaArea').style.display = 'flex';
        currentCall.answer(stream);
        currentCall.on('stream', (rem) => { document.getElementById('remoteVideo').srcObject = rem; });
        currentCall.on('close', endActiveCall);
      });
    };

    document.getElementById('declineCallBtn').onclick = () => {
      stopCallAudio();
      document.getElementById('callModal').style.display = 'none';
      if (currentCall) currentCall.close();
    };

    document.getElementById('endCallBtn').onclick = endActiveCall;
    document.getElementById('shareScreenBtn').onclick = toggleScreenShare;

    document.getElementById('muteMicBtn').onclick = (e) => {
      isMuted = !isMuted;
      if (localStream) localStream.getAudioTracks().forEach(t => t.enabled = !isMuted);
      e.target.textContent = isMuted ? '🔇 Unmute' : '🎙️ Mute';
    };

    document.getElementById('pttToggleBtn').onclick = (e) => {
      pttEnabled = !pttEnabled;
      e.target.textContent = `Walkie PTT: ${pttEnabled ? 'ON (Hold Space)' : 'OFF'}`;
      if (localStream) localStream.getAudioTracks().forEach(t => t.enabled = !pttEnabled);
    };

    window.addEventListener('keydown', (e) => {
      if (pttEnabled && e.code === 'Space' && document.activeElement.tagName !== 'TEXTAREA' && document.activeElement.tagName !== 'INPUT') {
        if (localStream) localStream.getAudioTracks().forEach(t => t.enabled = true);
      }
    });
    window.addEventListener('keyup', (e) => {
      if (pttEnabled && e.code === 'Space') {
        if (localStream) localStream.getAudioTracks().forEach(t => t.enabled = false);
      }
    });

    document.querySelectorAll('.sb-btn').forEach(btn => {
      btn.onclick = () => {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.frequency.value = parseFloat(btn.dataset.freq);
        gain.gain.setValueAtTime(0.2, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.5);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start();
        osc.stop(ctx.currentTime + 0.5);
      };
    });
  }

  // Shared Controls (Both Popup & Workspace)
  document.getElementById('copyCodeBtn').onclick = () => {
    navigator.clipboard.writeText(myCode);
    alert('Copied Peer Code: ' + myCode);
  };

  document.getElementById('copyInviteBtn').onclick = () => {
    const link = `pulse://add/${myCode}`;
    navigator.clipboard.writeText(link);
    alert(`Copied 1-Click Invite Link: ${link}`);
  };

  document.getElementById('quickJoinBtn').onclick = () => {
    const link = prompt('Paste Invite Link (e.g. pulse://add/4A9F):');
    if (!link) return;
    const code = link.replace('pulse://add/', '').trim().toUpperCase().substring(0, 4);
    if (code) addFriendByCode(code, code);
  };

  document.getElementById('createPollBtn').onclick = () => {
    const q = prompt('Poll Question:');
    if (!q) return;
    const opts = prompt('Options (comma separated, e.g. Yes, No, Maybe):');
    if (!opts) return;
    const options = opts.split(',').map(o => ({ label: o.trim(), votes: 0 })).filter(o => o.label);
    if (options.length < 2) return alert('Enter at least 2 options.');
    handleSendMessage({ poll: { question: q, options } });
  };

  const vnBtn = document.getElementById('voiceNoteBtn');
  vnBtn.onmousedown = () => {
    navigator.mediaDevices.getUserMedia({ audio: true }).then((stream) => {
      audioChunks = [];
      mediaRecorder = new MediaRecorder(stream);
      mediaRecorder.ondataavailable = e => audioChunks.push(e.data);
      mediaRecorder.onstop = () => {
        const blob = new Blob(audioChunks, { type: 'audio/webm' });
        const reader = new FileReader();
        reader.onloadend = () => handleSendMessage({ audioData: reader.result });
        reader.readAsDataURL(blob);
        stream.getTracks().forEach(t => t.stop());
      };
      mediaRecorder.start();
      vnBtn.style.background = '#ef4444';
    }).catch(() => alert('Microphone access denied.'));
  };
  vnBtn.onmouseup = () => {
    if (mediaRecorder && mediaRecorder.state === 'recording') {
      mediaRecorder.stop();
      vnBtn.style.background = '';
    }
  };

  document.getElementById('msgInput').oninput = () => {
    if (activeTarget && activeTarget.type === 'dm') {
      sendPayloadToCode(activeTarget.id, { type: 'TYPING' });
    }
  };

  document.getElementById('cancelReplyBtn').onclick = () => {
    replyContext = null;
    document.getElementById('replyBanner').style.display = 'none';
  };

  document.getElementById('sendBtn').onclick = () => handleSendMessage();
  document.getElementById('msgInput').onkeydown = (e) => {
    getState(['pulse_settings'], (res) => {
      const enterSend = (res.pulse_settings || {}).enterSend !== false;
      if (enterSend && e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSendMessage();
      }
    });
  };

  // Settings Bindings
  document.getElementById('saveDisplayNameBtn').onclick = () => updateSetting('displayName', document.getElementById('setDisplayName').value.trim() || 'User');
  document.getElementById('saveActivityBtn').onclick = () => {
    const act = document.getElementById('setCustomActivity').value.trim();
    updateSetting('customActivity', act);
    Object.values(liveConns).forEach(conn => {
      if (conn.open) conn.send({ type: 'ACTIVITY_UPDATE', activity: act });
    });
  };
  document.getElementById('applyRecoverCodeBtn').onclick = () => {
    const code = document.getElementById('recoverCodeInput').value.trim().toUpperCase();
    if (code.length !== 4) return alert('Enter a 4-character code.');
    setState({ pulse_my_code: code }, () => {
      alert(`Peer Code restored to ${code}!`);
      initPeerNetwork();
    });
  };
  document.getElementById('setOnlineStatus').onchange = (e) => updateSetting('status', e.target.value);
  document.getElementById('setDmFilter').onchange = (e) => updateSetting('dmFilter', e.target.value);
  document.getElementById('setReceipts').onchange = (e) => updateSetting('receipts', e.target.checked);
  document.getElementById('setAutoPrune').onchange = (e) => updateSetting('autoPrune', e.target.checked);
  document.getElementById('setNotif').onchange = (e) => updateSetting('notifications', e.target.checked);
  document.getElementById('setSound').onchange = (e) => updateSetting('sound', e.target.checked);
  document.getElementById('setVolume').oninput = (e) => updateSetting('volume', e.target.value);
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
  document.getElementById('setFontSize').onchange = (e) => updateSetting('fontSize', e.target.value);
  document.getElementById('setHighContrast').onchange = (e) => updateSetting('highContrast', e.target.checked);
  document.getElementById('setCompact').onchange = (e) => updateSetting('compact', e.target.checked);
  document.getElementById('setReducedMotion').onchange = (e) => updateSetting('reducedMotion', e.target.checked);
  document.getElementById('setEnterSend').onchange = (e) => updateSetting('enterSend', e.target.checked);
  document.getElementById('setTimeFormat').onchange = (e) => updateSetting('timeFormat', e.target.value);

  document.getElementById('clearHistoryBtn').onclick = () => {
    if (confirm('Delete all saved message history?')) setState({ pulse_history: {} });
  };
}

function endActiveCall() {
  stopCallAudio();
  stopScreenShare();
  document.getElementById('mediaArea').style.display = 'none';
  if (localStream) localStream.getTracks().forEach(t => t.stop());
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

function addFriendByCode(code, name) {
  getState(['pulse_friends'], (res) => {
    const friends = res.pulse_friends || [];
    if (!friends.some(f => f.code === code)) {
      friends.push({ code, name });
      setState({ pulse_friends: friends }, () => {
        connectToCode(code);
        sendPayloadToCode(code, { type: 'FRIEND_REQUEST', name: myCode });
        refreshAllViews();
      });
    }
  });
}

function promptAddFriend() {
  const code = prompt('Enter friend\'s 4-Digit Peer Code:');
  if (!code) return;
  const cleanCode = code.trim().toUpperCase();
  const name = prompt(`Nickname for ${cleanCode}:`) || cleanCode;
  addFriendByCode(cleanCode, name);
}

function promptCreateGroup() {
  getState(['pulse_friends', 'pulse_groups'], (res) => {
    const friends = res.pulse_friends || [];
    if (friends.length === 0) return alert('Add at least one friend first!');
    const groupName = prompt('Group Name:');
    if (!groupName) return;
    const listStr = friends.map(f => `${f.name} (${f.code})`).join(', ');
    const codesInput = prompt(`Enter friend codes (comma separated):\n${listStr}`);
    if (!codesInput) return;
    const members = codesInput.split(',').map(c => c.trim().toUpperCase()).filter(Boolean);
    if (!members.includes(myCode)) members.push(myCode);
    const groups = res.pulse_groups || [];
    groups.push({ id: 'grp-' + Date.now(), name: groupName.trim(), members });
    setState({ pulse_groups: groups }, refreshAllViews);
  });
}