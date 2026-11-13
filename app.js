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
let renderTimer = null;

// Valid Gift Card Codes for Pulse Pro
const VALID_GIFT_CODES = [
  'PULSE-PRO-9X4K-2026',
  'PULSE-VIP-7M2P-8841',
  'PULSE-GOLD-5T9W-3310',
  'PULSE-APEX-3R8L-6492',
  'PULSE-ULTRA-1Q6Z-9075'
];

// Restricted Phrases -> Opens dedicated warning.html
const BANNED_PHRASES = ['67', '6-7', '6 7'];

const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;
let screenShareTimer = null;
let screenStream = null;
let mediaRecorder = null;
let audioChunks = [];

const chimeAudio = new Audio(chrome.runtime.getURL('chime.mp3'));
const ringtoneAudio = new Audio(chrome.runtime.getURL('ringtone.mp3'));
const callingAudio = new Audio(chrome.runtime.getURL('calling.mp3'));
ringtoneAudio.loop = true;
callingAudio.loop = true;

function getState(keys, cb) { chrome.storage.local.get(keys, cb); }
function setState(obj, cb) { chrome.storage.local.set(obj, cb); }

// --- Pro & 3-Day Trial Checker ---
function checkProAccess(cb) {
  getState(['pulse_pro_permanent', 'pulse_trial_start'], (res) => {
    if (res.pulse_pro_permanent) {
      cb({ hasPro: true, statusText: 'Pulse Pro Active (Lifetime Gift Code)', isTrial: false });
      return;
    }
    let trialStart = res.pulse_trial_start;
    if (!trialStart) {
      trialStart = Date.now();
      setState({ pulse_trial_start: trialStart });
    }
    const elapsed = Date.now() - trialStart;
    if (elapsed < THREE_DAYS_MS) {
      const hoursLeft = Math.ceil((THREE_DAYS_MS - elapsed) / (1000 * 60 * 60));
      cb({ hasPro: true, statusText: `3-Day Free Trial Active (${hoursLeft} hours remaining)`, isTrial: true });
    } else {
      cb({ hasPro: false, statusText: 'Free Trial Expired — Redeem a Gift Card Code to unlock Pro', isTrial: false });
    }
  });
}

function updateProUI() {
  checkProAccess(({ hasPro, statusText, isTrial }) => {
    const popBadge = document.getElementById('popProBadge');
    const wsBadge = document.getElementById('wsProBadge');
    if (popBadge) {
      popBadge.style.display = hasPro ? 'inline-block' : 'none';
      popBadge.textContent = isTrial ? 'PRO TRIAL' : 'PRO';
    }
    if (wsBadge) {
      wsBadge.style.display = hasPro ? 'inline-block' : 'none';
      wsBadge.textContent = isTrial ? 'PRO TRIAL' : 'PRO';
    }

    const descEl = document.getElementById('proStatusDesc');
    const pillEl = document.getElementById('proStatusPill');
    if (descEl) descEl.textContent = statusText;
    if (pillEl) pillEl.textContent = hasPro ? (isTrial ? '3-DAY TRIAL' : 'PULSE PRO') : 'STANDARD TIER';

    document.querySelectorAll('.pro-gate').forEach(gate => {
      gate.style.display = hasPro ? 'none' : 'flex';
    });

    if (!hasPro) {
      getState(['pulse_settings'], (res) => {
        const s = res.pulse_settings || {};
        if (s.theme === 'pro-obsidian' || s.bgImageUrl) {
          s.theme = 'discord-dark';
          s.bgImageUrl = '';
          setState({ pulse_settings: s });
        }
      });
    }

    renderSoundboardSettings(hasPro);
    renderCallSoundboard(hasPro);
  });
}

// --- Custom Soundboard Uploader (3 Standard / 5 Pro) ---
function renderSoundboardSettings(hasPro) {
  const container = document.getElementById('soundboardSlotsContainer');
  if (!container) return;
  const maxSlots = hasPro ? 5 : 3;

  getState(['pulse_custom_sounds'], (res) => {
    const sounds = res.pulse_custom_sounds || [];
    container.innerHTML = '';

    for (let i = 0; i < 5; i++) {
      const slotData = sounds[i];
      const isLocked = i >= maxSlots;
      const row = document.createElement('div');
      row.className = 'setting-row';
      row.style.position = 'relative';

      if (isLocked) {
        row.innerHTML = `
          <div><strong>Slot ${i + 1} (Pulse Pro Exclusive)</strong><div style="font-size:0.78rem; color:#fbbf24;">Requires Pulse Pro to unlock slots 4 & 5</div></div>
          <button onclick="document.querySelector('[data-sec=pro]').click()" style="background:#eab308; color:#000;">🔒 Upgrade</button>
        `;
      } else {
        row.innerHTML = `
          <div>
            <strong>Slot ${i + 1}: ${slotData ? slotData.name : 'Empty Slot'}</strong>
            <div style="font-size:0.75rem; color:var(--muted);">Upload MP3/WAV sound effect</div>
          </div>
          <div style="display:flex; gap:6px; align-items:center;">
            ${slotData ? `<button class="btn-sec" data-play-slot="${i}">▶️ Play</button><button class="btn-danger" data-del-slot="${i}">✕</button>` : ''}
            <label style="background:var(--accent); color:#fff; padding:6px 12px; border-radius:8px; cursor:pointer; font-size:0.8rem; font-weight:700;">
              Upload <input type="file" accept="audio/*" data-upload-slot="${i}" style="display:none;" />
            </label>
          </div>
        `;
      }
      container.appendChild(row);
    }

    container.querySelectorAll('[data-play-slot]').forEach(btn => {
      btn.onclick = () => {
        const s = sounds[parseInt(btn.dataset.playSlot, 10)];
        if (s && s.data) new Audio(s.data).play();
      };
    });

    container.querySelectorAll('[data-del-slot]').forEach(btn => {
      btn.onclick = () => {
        sounds[parseInt(btn.dataset.delSlot, 10)] = null;
        setState({ pulse_custom_sounds: sounds }, () => updateProUI());
      };
    });

    container.querySelectorAll('[data-upload-slot]').forEach(inp => {
      inp.onchange = (e) => {
        const file = e.target.files[0];
        if (!file) return;
        if (file.size > 1500000) return alert('Please keep sound files under 1.5 MB for fast performance.');
        const reader = new FileReader();
        reader.onload = () => {
          sounds[parseInt(inp.dataset.uploadSlot, 10)] = {
            name: file.name.replace(/\.[^/.]+$/, '').substring(0, 16),
            data: reader.result
          };
          setState({ pulse_custom_sounds: sounds }, () => updateProUI());
        };
        reader.readAsDataURL(file);
      };
    });
  });
}

function renderCallSoundboard(hasPro) {
  const bar = document.getElementById('customSoundboardBar');
  if (!bar) return;
  const maxSlots = hasPro ? 5 : 3;

  getState(['pulse_custom_sounds'], (res) => {
    const sounds = res.pulse_custom_sounds || [];
    bar.innerHTML = `<span style="font-size:0.75rem; color:#94a3b8;">Soundboard:</span>`;

    const defaultBtn = document.createElement('button');
    defaultBtn.className = 'btn-sec';
    defaultBtn.style.cssText = 'padding:4px 8px; font-size:0.75rem;';
    defaultBtn.textContent = '🔔 Chime';
    defaultBtn.onclick = () => playSound(chimeAudio);
    bar.appendChild(defaultBtn);

    for (let i = 0; i < maxSlots; i++) {
      if (sounds[i] && sounds[i].data) {
        const b = document.createElement('button');
        b.className = 'btn-sec';
        b.style.cssText = 'padding:4px 8px; font-size:0.75rem;';
        b.textContent = `🔊 ${sounds[i].name}`;
        b.onclick = () => new Audio(sounds[i].data).play();
        bar.appendChild(b);
      }
    }
  });
}

// --- Initialization & Debounced Renders ---
function scheduleRefresh() {
  if (renderTimer) cancelAnimationFrame(renderTimer);
  renderTimer = requestAnimationFrame(() => refreshAllViews());
}

document.addEventListener('DOMContentLoaded', () => {
  loadSettingsAndTheme();
  updateProUI();
  initPeerNetwork();
  bindUIEvents();
  deliverPendingInbox();
  checkWeeklyScreenQuota();
  populateMicrophones();
  scheduleRefresh();

  setInterval(connectToAllFriends, 30000);

  chrome.storage.onChanged.addListener((changes) => {
    if (changes.pulse_settings || changes.pulse_custom_theme) loadSettingsAndTheme();
    if (changes.pulse_pro_permanent || changes.pulse_trial_start) updateProUI();
    if (changes.pulse_pending_inbox) deliverPendingInbox();
    if (changes.pulse_friends || changes.pulse_groups || changes.pulse_requests || changes.pulse_history) {
      scheduleRefresh();
      flushOfflineQueue();
    }
  });
});

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

// --- Screen Share Quota (10m Standard / 30m Pro) ---
function getWeekStartTimestamp() {
  const now = new Date();
  const diff = now.getDate() - now.getDay();
  return new Date(now.setDate(diff)).setHours(0, 0, 0, 0);
}

function checkWeeklyScreenQuota(cb) {
  checkProAccess(({ hasPro }) => {
    const limitSec = hasPro ? 1800 : 600;
    getState(['pulse_screen_quota'], (res) => {
      const weekStart = getWeekStartTimestamp();
      let quota = res.pulse_screen_quota || { weekStart, usedSeconds: 0 };
      if (quota.weekStart !== weekStart) {
        quota = { weekStart, usedSeconds: 0 };
        setState({ pulse_screen_quota: quota });
      }
      const rem = Math.max(0, limitSec - quota.usedSeconds);
      const mins = Math.floor(rem / 60);
      const secs = String(rem % 60).padStart(2, '0');
      const formatted = `${mins}:${secs}`;

      if (document.getElementById('screenTimeLeft')) document.getElementById('screenTimeLeft').textContent = formatted;
      if (document.getElementById('settingsScreenQuota')) document.getElementById('settingsScreenQuota').textContent = `${mins}m ${secs}s remaining this week`;
      if (cb) cb(rem, quota);
    });
  });
}

function toggleScreenShare() {
  if (screenStream) { stopScreenShare(); return; }
  checkWeeklyScreenQuota((rem, quota) => {
    if (rem <= 0) return alert('Weekly screen share quota reached!');
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
          checkWeeklyScreenQuota((left) => { if (left <= 0) stopScreenShare(); });
        });
      }, 1000);
    }).catch(() => {});
  });
}

function stopScreenShare() {
  if (screenShareTimer) clearInterval(screenShareTimer);
  screenShareTimer = null;
  if (screenStream) { screenStream.getTracks().forEach(t => t.stop()); screenStream = null; }
  if (localStream) {
    document.getElementById('localVideo').srcObject = localStream;
    if (currentCall && currentCall.peerConnection) {
      const sender = currentCall.peerConnection.getSenders().find(s => s.track && s.track.kind === 'video');
      if (sender && localStream.getVideoTracks()[0]) sender.replaceTrack(localStream.getVideoTracks()[0]);
    }
  }
}

// --- Microphone Enumeration & Calling ---
function populateMicrophones() {
  const sel = document.getElementById('micDeviceSelect');
  if (!sel || !navigator.mediaDevices) return;
  navigator.mediaDevices.enumerateDevices().then(devices => {
    devices.filter(d => d.kind === 'audioinput').forEach((mic, idx) => {
      const opt = document.createElement('option');
      opt.value = mic.deviceId;
      opt.textContent = mic.label || `Microphone ${idx + 1}`;
      sel.appendChild(opt);
    });
  }).catch(() => {});
}

function getMediaStreamWithFallback(cb) {
  getState(['pulse_settings'], (res) => {
    const s = res.pulse_settings || {};
    const audioConstraints = {
      echoCancellation: s.echo !== false,
      noiseSuppression: s.noise !== false,
      autoGainControl: s.agc !== false
    };
    if (s.micDeviceId) audioConstraints.deviceId = { exact: s.micDeviceId };

    navigator.mediaDevices.getUserMedia({ video: true, audio: audioConstraints })
      .then(stream => cb(stream))
      .catch(() => {
        navigator.mediaDevices.getUserMedia({ video: false, audio: audioConstraints })
          .then(audioOnlyStream => cb(audioOnlyStream))
          .catch(() => alert('Microphone blocked! Click the lock/camera icon in your Chrome address bar and allow Microphone access.'));
      });
  });
}

// --- PeerJS Networking (Clean Logs & Safe Connection Guards) ---
function initPeerNetwork() {
  getState(['pulse_my_code'], (res) => {
    myCode = res.pulse_my_code;
    if (!myCode) {
      myCode = Math.random().toString(36).substring(2, 6).toUpperCase();
      setState({ pulse_my_code: myCode });
    }
    if (document.getElementById('myCodeDisplay')) document.getElementById('myCodeDisplay').textContent = myCode;

    const peerId = IS_POPUP ? `pulse-pop-${myCode}` : `pulse-ws-${myCode}`;
    if (peer) {
      try { peer.destroy(); } catch (e) {}
    }
    peer = new Peer(peerId);

    peer.on('open', () => connectToAllFriends());
    peer.on('connection', (conn) => handleIncomingConnection(conn));
    peer.on('error', (err) => {
      if (err.type !== 'peer-unavailable') {
        console.log('Peer status:', err.type);
      }
    });

    peer.on('call', (call) => {
      if (!call || !call.peer) return;
      currentCall = call;
      playSound(ringtoneAudio);
      const callerCode = call.peer.replace(/^pulse-(ws|pop|bg)-/, '');
      if (IS_POPUP) {
        chrome.tabs.create({ url: chrome.runtime.getURL('index.html') });
      } else {
        document.getElementById('callerNameTitle').textContent = `Call from ${callerCode}`;
        document.getElementById('callModal').style.display = 'flex';
      }
    });
  });
}

function connectToAllFriends() {
  if (!peer || !peer.open) return;
  getState(['pulse_friends'], (res) => {
    (res.pulse_friends || []).forEach(f => connectToCode(f.code));
  });
}

function connectToCode(targetCode) {
  if (!peer || !peer.open || !targetCode || targetCode === myCode) return;
  ['pulse-ws-', 'pulse-pop-', 'pulse-bg-'].forEach(prefix => {
    const fullId = prefix + targetCode;
    if (!liveConns[fullId] || !liveConns[fullId].open) {
      try {
        const conn = peer.connect(fullId);
        if (conn) handleIncomingConnection(conn);
      } catch (e) {}
    }
  });
}

function handleIncomingConnection(conn) {
  if (!conn || !conn.peer) return;
  const senderCode = conn.peer.replace(/^pulse-(ws|pop|bg)-/, '');

  conn.on('open', () => {
    liveConns[conn.peer] = conn;
    flushOfflineQueue();
    scheduleRefresh();
  });

  conn.on('data', (payload) => {
    if (!payload) return;

    if (payload.type === 'TYPING') {
      if (activeTarget && activeTarget.id === senderCode && document.getElementById('typingIndicator')) {
        document.getElementById('typingIndicator').textContent = `${senderCode} is typing...`;
        clearTimeout(typingTimeout);
        typingTimeout = setTimeout(() => { document.getElementById('typingIndicator').textContent = ''; }, 2500);
      }
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
      notifyIfNotViewing(payload.groupId, `${payload.groupName} (${senderCode})`, payload.text || 'Sent media', payload.msgId);
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
          if (conn.open) conn.send({ type: 'READ_ACK', msgId: payload.msgId });
          notifyIfNotViewing(senderCode, senderCode, payload.text || 'Sent media', payload.msgId);
        }
      });
    }

    if (payload.type === 'READ_ACK') {
      markMessageRead(senderCode, payload.msgId);
    }
  });

  conn.on('close', () => {
    delete liveConns[conn.peer];
    scheduleRefresh();
  });

  conn.on('error', () => {
    delete liveConns[conn.peer];
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
      if (!friends.some(f => f.code === item.senderCode)) {
        requests.push({ type: 'message', code: item.senderCode, text: item.text });
      } else {
        if (!history[item.senderCode]) history[item.senderCode] = [];
        if (!history[item.senderCode].some(m => m.id === item.msgId)) {
          history[item.senderCode].push({ id: item.msgId, sender: item.senderCode, text: item.text, time: item.time, self: false });
        }
      }
    });

    setState({ pulse_pending_inbox: [], pulse_history: history, pulse_requests: requests }, scheduleRefresh);
  });
}

function sendPayloadToCode(targetCode, payload) {
  const wsConn = liveConns[`pulse-ws-${targetCode}`];
  const popConn = liveConns[`pulse-pop-${targetCode}`];
  const bgConn = liveConns[`pulse-bg-${targetCode}`];
  let sent = false;

  if (wsConn && wsConn.open) { wsConn.send(payload); sent = true; }
  else if (popConn && popConn.open) { popConn.send(payload); sent = true; }
  else if (bgConn && bgConn.open) { bgConn.send(payload); sent = true; }

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
      if (sendPayloadToCode(item.targetCode, item.payload)) {
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
    if (!history[chatId].some(m => m.id === msgObj.id)) {
      history[chatId].push(msgObj);
      setState({ pulse_history: history });
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

function notifyIfNotViewing(chatId, title, text, msgId) {
  const isViewing = document.hasFocus() && activeTarget && activeTarget.id === chatId;
  if (!isViewing && !IS_POPUP) {
    playSound(chimeAudio);
    chrome.runtime.sendMessage({
      type: 'NEW_MESSAGE_NOTIFICATION',
      senderCode: chatId,
      senderName: title,
      text: text,
      msgId
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
        <div style="font-size:0.72rem; color:var(--muted);">${type === 'dm' ? `Code: ${id}` : `${item.members.length} members`}</div>
      </div>
      ${type === 'dm' ? `<span style="color:${isOnline ? '#10b981' : '#64748b'};">●</span>` : ''}
    `;
    el.onclick = () => {
      activeTarget = { type, id, name: item.name, members: item.members };
      if (IS_POPUP) switchPopupTab('chats');
      scheduleRefresh();
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
      <div><strong>${req.code}</strong> ${req.text ? `<div style="font-size:0.8rem; color:var(--muted);">"${req.text}"</div>` : ''}</div>
      <div style="display:flex; gap:6px; width:100%;">
        <button class="btn-success" style="flex:1;" data-accept="${idx}">Accept</button>
        <button class="btn-danger" style="flex:1;" data-decline="${idx}">Decline</button>
      </div>
    `;
    el.querySelector('[data-accept]').onclick = () => {
      getState(['pulse_requests', 'pulse_friends'], (res) => {
        const reqs = res.pulse_requests || [];
        const friends = res.pulse_friends || [];
        if (!friends.some(f => f.code === req.code)) friends.push({ code: req.code, name: req.code });
        reqs.splice(idx, 1);
        setState({ pulse_requests: reqs, pulse_friends: friends }, () => { connectToCode(req.code); scheduleRefresh(); });
      });
    };
    el.querySelector('[data-decline]').onclick = () => {
      getState(['pulse_requests'], (res) => {
        const reqs = res.pulse_requests || [];
        reqs.splice(idx, 1);
        setState({ pulse_requests: reqs }, scheduleRefresh);
      });
    };
    container.appendChild(el);
  });
}

function renderActiveChat(history) {
  const titleEl = document.getElementById('activeChatTitle');
  const box = document.getElementById('messagesBox');
  const callBtn = document.getElementById('wsCallBtn') || document.getElementById('popupCallBtn');

  if (!activeTarget) {
    titleEl.textContent = 'Select a Friend or Group';
    box.innerHTML = '';
    if (callBtn) callBtn.style.display = 'none';
    return;
  }

  titleEl.textContent = `${activeTarget.type === 'group' ? '# ' : ''}${activeTarget.name}`;
  if (callBtn) callBtn.style.display = activeTarget.type === 'dm' ? 'inline-block' : 'none';

  getState(['pulse_settings'], (res) => {
    const s = res.pulse_settings || {};
    const limit = parseInt(s.renderLimit || '150', 10);
    const msgs = (history[activeTarget.id] || []).slice(-limit);
    box.innerHTML = '';

    msgs.forEach(m => {
      const div = document.createElement('div');
      div.className = `message ${m.self ? 'sent' : 'received'}`;
      const timeStr = new Date(m.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: s.timeFormat !== '24h' });
      const statusHtml = (m.self && s.receipts !== false && m.status) ? `<span>${m.status === 'Queued' ? '🕒' : m.status === 'Read' ? '✓✓' : '✓'}</span>` : '';
      
      let body = m.audioData ? `<audio controls src="${m.audioData}" style="max-width:200px; height:30px;"></audio>` : (m.text || '');
      div.innerHTML = `<div>${body}</div><div class="msg-meta"><span>${timeStr}</span>${statusHtml}</div>`;
      box.appendChild(div);
    });
    box.scrollTop = box.scrollHeight;
  });
}

// --- Sending Messages + Restricted Phrase Check (warning.html) ---
function handleSendMessage(extraPayload = {}) {
  const input = document.getElementById('msgInput');
  const text = input ? input.value.trim() : '';
  if (!text && !extraPayload.audioData) return;
  if (!activeTarget) return;

  const matchedBan = BANNED_PHRASES.find(phrase => text.includes(phrase));
  if (matchedBan) {
    if (input) input.value = '';
    chrome.tabs.create({
      url: chrome.runtime.getURL(`warning.html?term=${encodeURIComponent(matchedBan)}`)
    });
    return;
  }

  const msgId = 'msg-' + Date.now() + '-' + Math.random().toString(36).substring(2, 5);
  const msgObj = {
    id: msgId,
    sender: myCode,
    text,
    audioData: extraPayload.audioData || null,
    time: Date.now(),
    self: true,
    status: 'Sent'
  };

  if (activeTarget.type === 'dm') {
    const sent = sendPayloadToCode(activeTarget.id, { type: 'DM', msgId, text, audioData: msgObj.audioData });
    msgObj.status = sent ? 'Sent' : 'Queued';
    saveMessageToHistory(activeTarget.id, msgObj);
  } else if (activeTarget.type === 'group') {
    msgObj.sender = 'You';
    saveMessageToHistory(activeTarget.id, msgObj);
    (activeTarget.members || []).forEach(mc => {
      if (mc !== myCode) sendPayloadToCode(mc, { type: 'GROUP_MSG', msgId, groupId: activeTarget.id, groupName: activeTarget.name, senderName: myCode, text });
    });
  }

  if (input) input.value = '';
}

function loadSettingsAndTheme() {
  getState(['pulse_settings', 'pulse_custom_theme'], (res) => {
    const s = res.pulse_settings || {};
    const theme = s.theme || 'discord-dark';
    document.documentElement.setAttribute('data-theme', theme);
    document.body.style.fontFamily = s.fontFamily || 'system-ui, sans-serif';
    document.body.style.setProperty('--font-size', s.fontSize || '15px');
    document.body.classList.toggle('no-animations', !!s.noAnimations);
    if (document.getElementById('footerDisplayName')) document.getElementById('footerDisplayName').textContent = s.displayName || 'User';
    if (document.getElementById('footerCustomActivity')) document.getElementById('footerCustomActivity').textContent = s.customActivity || 'Ready to chat';
  });
}

function updateSetting(key, val) {
  getState(['pulse_settings'], (res) => {
    const s = res.pulse_settings || {};
    s[key] = val;
    setState({ pulse_settings: s });
  });
}

function switchPopupTab(tabName) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tabName));
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === `view-${tabName}`));
}

function bindUIEvents() {
  if (IS_POPUP) {
    document.querySelectorAll('.tab-btn').forEach(btn => btn.onclick = () => switchPopupTab(btn.dataset.tab));
    document.getElementById('openWorkspaceBtn').onclick = () => chrome.tabs.create({ url: chrome.runtime.getURL('index.html') });
    document.getElementById('addFriendBtn').onclick = promptAddFriend;
    document.getElementById('createGroupBtn').onclick = promptCreateGroup;
    document.getElementById('popupCallBtn').onclick = () => chrome.tabs.create({ url: chrome.runtime.getURL('index.html') });
  } else {
    document.getElementById('railFriends').onclick = (e) => setActiveRail(e.currentTarget, 'DIRECT MESSAGES', '+ Add', promptAddFriend);
    document.getElementById('railGroups').onclick = (e) => setActiveRail(e.currentTarget, 'GROUP CHANNELS', '+ Group', promptCreateGroup);
    document.getElementById('railRequests').onclick = (e) => setActiveRail(e.currentTarget, 'REQUESTS', '', null);
    document.getElementById('railSettings').onclick = () => { document.getElementById('settingsOverlay').style.display = 'flex'; updateProUI(); };
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

    document.getElementById('redeemCodeBtn').onclick = () => {
      const code = document.getElementById('giftCodeInput').value.trim().toUpperCase();
      if (VALID_GIFT_CODES.includes(code)) {
        setState({ pulse_pro_permanent: true }, () => {
          alert('🎉 Gift Card Redeemed! Pulse Pro is now permanently unlocked!');
          updateProUI();
        });
      } else {
        alert('Invalid Gift Card Code. Please check the code and try again.');
      }
    };

    document.getElementById('applyProThemeBtn').onclick = () => updateSetting('theme', 'pro-obsidian');

    document.getElementById('testMicBtn').onclick = () => {
      const status = document.getElementById('micTestStatus');
      status.textContent = 'Requesting microphone access...';
      getMediaStreamWithFallback((stream) => {
        status.textContent = '✅ Microphone working! Audio stream active.';
        status.style.color = '#10b981';
        stream.getTracks().forEach(t => t.stop());
      });
    };

    document.getElementById('wsCallBtn').onclick = () => {
      if (!activeTarget || activeTarget.type !== 'dm') return;
      playSound(callingAudio);
      getMediaStreamWithFallback((stream) => {
        localStream = stream;
        document.getElementById('localVideo').srcObject = stream;
        document.getElementById('mediaArea').style.display = 'flex';
        const call = peer.call(`pulse-ws-${activeTarget.id}`, stream);
        currentCall = call;
        call.on('stream', (rem) => { stopCallAudio(); document.getElementById('remoteVideo').srcObject = rem; });
        call.on('close', endActiveCall);
      });
    };

    document.getElementById('acceptCallBtn').onclick = () => {
      stopCallAudio();
      document.getElementById('callModal').style.display = 'none';
      if (!currentCall) return;
      getMediaStreamWithFallback((stream) => {
        localStream = stream;
        document.getElementById('localVideo').srcObject = stream;
        document.getElementById('mediaArea').style.display = 'flex';
        currentCall.answer(stream);
        currentCall.on('stream', (rem) => { document.getElementById('remoteVideo').srcObject = rem; });
        currentCall.on('close', endActiveCall);
      });
    };

    document.getElementById('declineCallBtn').onclick = () => { stopCallAudio(); document.getElementById('callModal').style.display = 'none'; if (currentCall) currentCall.close(); };
    document.getElementById('endCallBtn').onclick = endActiveCall;
    document.getElementById('shareScreenBtn').onclick = toggleScreenShare;

    document.getElementById('muteMicBtn').onclick = (e) => {
      isMuted = !isMuted;
      if (localStream) localStream.getAudioTracks().forEach(t => t.enabled = !isMuted);
      e.target.textContent = isMuted ? '🔇 Unmute' : '🎙️ Mute';
    };

    document.getElementById('saveDisplayNameBtn').onclick = () => updateSetting('displayName', document.getElementById('setDisplayName').value.trim() || 'User');
    document.getElementById('saveActivityBtn').onclick = () => updateSetting('customActivity', document.getElementById('setCustomActivity').value.trim());
    document.getElementById('applyRecoverCodeBtn').onclick = () => {
      const c = document.getElementById('recoverCodeInput').value.trim().toUpperCase();
      if (c.length === 4) setState({ pulse_my_code: c }, () => { initPeerNetwork(); alert('Code restored!'); });
    };
    document.getElementById('themeSelect').onchange = (e) => updateSetting('theme', e.target.value);
    document.getElementById('setNoAnimations').onchange = (e) => updateSetting('noAnimations', e.target.checked);
    document.getElementById('setRenderLimit').onchange = (e) => updateSetting('renderLimit', e.target.value);
    document.getElementById('micDeviceSelect').onchange = (e) => updateSetting('micDeviceId', e.target.value);
    document.getElementById('setEcho').onchange = (e) => updateSetting('echo', e.target.checked);
    document.getElementById('setNoise').onchange = (e) => updateSetting('noise', e.target.checked);
    document.getElementById('setAgc').onchange = (e) => updateSetting('agc', e.target.checked);
    document.getElementById('setFontFamily').onchange = (e) => updateSetting('fontFamily', e.target.value);
    document.getElementById('setFontSize').onchange = (e) => updateSetting('fontSize', e.target.value);
    document.getElementById('clearHistoryBtn').onclick = () => { if (confirm('Clear all history?')) setState({ pulse_history: {} }); };
  }

  document.getElementById('copyCodeBtn').onclick = () => { navigator.clipboard.writeText(myCode); alert('Copied: ' + myCode); };
  document.getElementById('quickJoinBtn').onclick = () => {
    const link = prompt('Paste Invite Link or 4-Digit Code:');
    if (link) addFriendByCode(link.replace('pulse://add/', '').trim().toUpperCase().substring(0, 4), link.trim().toUpperCase().substring(0, 4));
  };
  document.getElementById('sendBtn').onclick = () => handleSendMessage();
  document.getElementById('msgInput').onkeydown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSendMessage(); }
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
  if (actionText) { actBtn.style.display = 'inline-block'; actBtn.textContent = actionText; actBtn.onclick = actionFn; }
  else actBtn.style.display = 'none';
  scheduleRefresh();
}

function addFriendByCode(code, name) {
  getState(['pulse_friends'], (res) => {
    const friends = res.pulse_friends || [];
    if (!friends.some(f => f.code === code)) {
      friends.push({ code, name });
      setState({ pulse_friends: friends }, () => { connectToCode(code); scheduleRefresh(); });
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
    const codesInput = prompt(`Enter friend codes (comma separated):`);
    if (!codesInput) return;
    const members = codesInput.split(',').map(c => c.trim().toUpperCase()).filter(Boolean);
    if (!members.includes(myCode)) members.push(myCode);
    const groups = res.pulse_groups || [];
    groups.push({ id: 'grp-' + Date.now(), name: groupName.trim(), members });
    setState({ pulse_groups: groups }, scheduleRefresh);
  });
}