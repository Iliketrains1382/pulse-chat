const APP_VERSION = '12.0';
const IS_POPUP = !!document.getElementById('friendsList') && !document.getElementById('railFriends');
const IS_WEB_HOSTED = window.location.protocol.startsWith('http');
const URL_PARAMS = new URLSearchParams(window.location.search);
const EXT_ID = URL_PARAMS.get('extId') || localStorage.getItem('pulse_ext_id') || '';
if (URL_PARAMS.get('extId')) localStorage.setItem('pulse_ext_id', URL_PARAMS.get('extId'));

const syncChannel = new BroadcastChannel('pulse_chat_v12_sync');

let peer = null;
let myCode = '';
let activeTarget = null;
let activeChannelId = 'general';
let splitTarget = null;
let liveConns = {};
let connectingLocks = {};
let peerPresence = {};
let currentCall = null;
let localStream = null;
let screenStream = null;
let screenShareTimer = null;
let callDurationTimer = null;
let callSeconds = 0;
let nerdStatsTimer = null;
let typingTimeout = null;
let isMuted = false;
let renderTimer = null;
let lastRenderSignature = '';
let logoClickCount = 0;
let replyingToMsg = null;
let lastMessageSentAt = 0;
let idleTimer = null;
let wasAutoIdled = false;
let escLastPressed = 0;
let currentCamIndex = 0;

const VALID_GIFT_CODES = [
  'PULSE-PRO-9X4K-2026',
  'PULSE-VIP-7M2P-8841',
  'PULSE-GOLD-5T9W-3310',
  'PULSE-APEX-3R8L-6492',
  'PULSE-ULTRA-1Q6Z-9075'
];

const BANNED_PHRASES = ['67', '6-7', '6 7'];
const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;

const MARKETPLACE_THEMES = [
  { id: 'cyber-dark', name: 'Cyber Neon Blue', author: 'PulseTeam', desc: 'Electric cyan accents on deep midnight slate' },
  { id: 'pro-obsidian', name: 'Obsidian Gold', author: 'VIP', desc: 'Pitch-black OLED theme with 24k gold highlights' },
  { id: 'emerald', name: 'Emerald Matrix', author: 'NatureDev', desc: 'Soothing deep forest green palette' },
  { id: 'purple', name: 'Royal Amethyst', author: 'Nebula', desc: 'Vibrant ultraviolet and plum workspace' },
  { id: 'crimson', name: 'Crimson Eclipse', author: 'RedShift', desc: 'High-energy ruby red dark theme' },
  { id: 'sunset', name: 'Solar Sunset', author: 'Horizon', desc: 'Warm amber and espresso tones' }
];

const EMOJI_LIST = ['😀','😂','🤣','😎','🥳','😍','🤔','😭','😡','🔥','❤️','💯','👍','👎','👏','🙌','🚀','⚡','🎮','🎧','📚','✅','❌','👀','💀','🤡','👑','🎂','🎉','🍕'];

const SLASH_COMMANDS = [
  { cmd: '/tts ', desc: 'Read message aloud via Text-to-Speech' },
  { cmd: '/rps ', desc: 'Play Rock-Paper-Scissors (/rps rock|paper|scissors)' },
  { cmd: '/poll ', desc: 'Create a quick poll (/poll Question | Opt1 | Opt2)' },
  { cmd: '/party', desc: 'Cycle party rainbow themes' },
  { cmd: '/flip', desc: 'Flip the screen upside down' },
  { cmd: '/matrix', desc: 'Activate Matrix Hacker theme' }
];

const getAssetUrl = (file) => (!IS_WEB_HOSTED && chrome?.runtime?.getURL) ? chrome.runtime.getURL(file) : file;
const chimeAudio = new Audio(getAssetUrl('chime.mp3'));
const ringtoneAudio = new Audio(getAssetUrl('ringtone.mp3'));
const callingAudio = new Audio(getAssetUrl('calling.mp3'));
ringtoneAudio.loop = true;
callingAudio.loop = true;

// --- Unified Storage Bridge ---
function getState(keys, cb) {
  if (!IS_WEB_HOSTED && chrome?.storage?.local) {
    chrome.storage.local.get(keys, cb);
  } else if (IS_WEB_HOSTED && EXT_ID && chrome?.runtime?.sendMessage) {
    try {
      chrome.runtime.sendMessage(EXT_ID, { type: 'STORAGE_GET', keys }, (res) => {
        if (chrome.runtime.lastError || !res) cb(getLocalFallback(keys));
        else cb(res);
      });
    } catch (e) {
      cb(getLocalFallback(keys));
    }
  } else {
    cb(getLocalFallback(keys));
  }
}

function getLocalFallback(keys) {
  const out = {};
  (Array.isArray(keys) ? keys : [keys]).forEach(k => {
    try { out[k] = JSON.parse(localStorage.getItem(k)); } catch (e) {}
  });
  return out;
}

function setState(obj, cb) {
  Object.keys(obj).forEach(k => {
    try { localStorage.setItem(k, JSON.stringify(obj[k])); } catch (e) {}
  });
  syncChannel.postMessage({ type: 'STATE_UPDATED', keys: Object.keys(obj) });

  if (!IS_WEB_HOSTED && chrome?.storage?.local) {
    chrome.storage.local.set(obj, cb);
  } else if (IS_WEB_HOSTED && EXT_ID && chrome?.runtime?.sendMessage) {
    try {
      chrome.runtime.sendMessage(EXT_ID, { type: 'STORAGE_SET', data: obj }, () => { if (cb) cb(); });
    } catch (e) {
      if (cb) cb();
    }
  } else {
    if (cb) cb();
  }
}

function archiveOldHistory(manual = false) {
  getState(['pulse_history', 'pulse_archive'], (res) => {
    const history = res.pulse_history || {};
    const archive = res.pulse_archive || [];
    let archivedCount = 0;
    Object.keys(history).forEach(chatId => {
      if (history[chatId].length > 100) {
        const overflow = history[chatId].splice(0, history[chatId].length - 100);
        archive.push({ chatId, archivedAt: Date.now(), messages: overflow });
        archivedCount += overflow.length;
      }
    });
    setState({ pulse_history: history, pulse_archive: archive }, () => {
      if (manual) alert(`☁️ Archived ${archivedCount} older messages safely.`);
      scheduleRefresh(true);
    });
  });
}

function removeFriendAndRecords(targetCode, alsoBlock = false) {
  const code = targetCode.trim().toUpperCase();
  getState(['pulse_friends', 'pulse_history', 'pulse_requests', 'pulse_outbox', 'pulse_blocked'], (res) => {
    const friends = (res.pulse_friends || []).filter(f => f.code !== code);
    const requests = (res.pulse_requests || []).filter(r => r.code !== code);
    const outbox = (res.pulse_outbox || []).filter(o => o.targetCode !== code);
    const blocked = res.pulse_blocked || [];
    const history = res.pulse_history || {};
    delete history[code];
    if (alsoBlock && !blocked.includes(code)) blocked.push(code);
    if (liveConns[code]) {
      try { liveConns[code].close(); } catch (e) {}
      delete liveConns[code];
    }
    if (activeTarget && activeTarget.id === code) activeTarget = null;
    setState({ pulse_friends: friends, pulse_history: history, pulse_requests: requests, pulse_outbox: outbox, pulse_blocked: blocked }, () => scheduleRefresh(true));
  });
}

// --- Pulse Pro & PIN Lock ---
function checkProAccess(cb) {
  getState(['pulse_pro_permanent', 'pulse_pro_sub', 'pulse_trial_start', 'pulse_boost_allocations'], (res) => {
    const allocations = res.pulse_boost_allocations || {};
    const usedBoosts = Object.values(allocations).reduce((a, b) => a + b, 0);

    if (res.pulse_pro_permanent) {
      cb({ hasPro: true, plan: 'Lifetime', statusText: 'Pulse Pro Active (Lifetime)', renewalText: '2 Group Boosts included', totalBoosts: 2, availableBoosts: Math.max(0, 2 - usedBoosts) });
      return;
    }
    const sub = res.pulse_pro_sub;
    if (sub && sub.active && sub.expiresAt > Date.now()) {
      cb({ hasPro: true, plan: sub.plan, statusText: `Pulse Pro ${sub.plan} Active`, renewalText: `Renews ${new Date(sub.expiresAt).toLocaleDateString()}`, totalBoosts: 2, availableBoosts: Math.max(0, 2 - usedBoosts) });
      return;
    }
    let trialStart = res.pulse_trial_start;
    if (!trialStart) {
      trialStart = Date.now();
      setState({ pulse_trial_start: trialStart });
    }
    const elapsed = Date.now() - trialStart;
    if (elapsed < THREE_DAYS_MS) {
      const hrs = Math.ceil((THREE_DAYS_MS - elapsed) / 3600000);
      cb({ hasPro: true, plan: 'trial', statusText: `3-Day Free Trial (${hrs}h left)`, renewalText: 'Includes 2 Group Boosts, Stickers & PIN Lock', totalBoosts: 2, availableBoosts: Math.max(0, 2 - usedBoosts) });
    } else {
      cb({ hasPro: false, plan: 'free', statusText: 'Free Tier — Upgrade to Pulse Pro', renewalText: 'No active subscription', totalBoosts: 0, availableBoosts: 0 });
    }
  });
}

function updateProUI() {
  checkProAccess(({ hasPro, statusText, renewalText, totalBoosts, availableBoosts }) => {
    const wsBadge = document.getElementById('wsProBadge');
    if (wsBadge) wsBadge.style.display = hasPro ? 'inline-block' : 'none';
    if (document.getElementById('proStatusDesc')) document.getElementById('proStatusDesc').textContent = statusText;
    if (document.getElementById('proRenewalDateText')) document.getElementById('proRenewalDateText').textContent = renewalText;
    if (document.getElementById('proStatusPill')) document.getElementById('proStatusPill').textContent = hasPro ? 'PULSE PRO' : 'FREE';
    if (document.getElementById('userBoostInventoryText')) document.getElementById('userBoostInventoryText').textContent = `${availableBoosts} / ${totalBoosts} Group Boosts Available`;
  });
}

function checkPinLockOnBoot() {
  getState(['pulse_app_pin'], (res) => {
    if (res.pulse_app_pin && res.pulse_app_pin.length === 4) {
      const lockScreen = document.getElementById('pinLockOverlay');
      if (lockScreen) lockScreen.style.display = 'flex';
    }
  });
}

// --- Group Boosts & Levels ---
function getGroupBoostLevel(boostCount) {
  if (boostCount >= 14) return { level: 3, nextGoal: 14, audio: '384 kbps', upload: '100 MB', stream: '1080p 60fps' };
  if (boostCount >= 7) return { level: 2, nextGoal: 14, audio: '256 kbps', upload: '50 MB', stream: '1080p 60fps' };
  if (boostCount >= 2) return { level: 1, nextGoal: 7, audio: '128 kbps', upload: '10 MB', stream: '720p 60fps' };
  return { level: 0, nextGoal: 2, audio: '96 kbps', upload: '10 MB', stream: '720p 30fps' };
}

function boostActiveGroup(delta) {
  if (!activeTarget || activeTarget.type !== 'group') return;
  checkProAccess(({ hasPro, availableBoosts }) => {
    if (!hasPro) return alert('⭐ Pulse Pro (or 3-Day Trial) is required for Group Boosts!');
    getState(['pulse_groups', 'pulse_boost_allocations'], (res) => {
      const groups = res.pulse_groups || [];
      const allocations = res.pulse_boost_allocations || {};
      const grp = groups.find(g => g.id === activeTarget.id);
      if (!grp) return;
      const cur = allocations[grp.id] || 0;
      if (delta > 0) {
        if (availableBoosts <= 0) return alert('All 2 Group Boosts are already allocated!');
        allocations[grp.id] = cur + 1;
        grp.boosts = (grp.boosts || 0) + 1;
      } else {
        if (cur <= 0) return alert('You have no boosts on this server.');
        allocations[grp.id] = cur - 1;
        grp.boosts = Math.max(0, (grp.boosts || 0) - 1);
      }
      setState({ pulse_groups: groups, pulse_boost_allocations: allocations }, () => {
        (grp.members || []).forEach(mc => {
          if (mc !== myCode) sendPayloadToCode(mc, { type: 'GROUP_INVITE_SYNC', group: grp });
        });
        updateProUI();
        scheduleRefresh(true);
      });
    });
  });
}

// --- Auto-Idle Detection (#27) & Panic Boss Key (#78) ---
function initActivityAndHotkeys() {
  const resetIdle = () => {
    if (wasAutoIdled) {
      wasAutoIdled = false;
      updateSetting('status', 'online');
      broadcastPresence();
    }
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      getState(['pulse_settings'], (res) => {
        const st = (res.pulse_settings || {}).status || 'online';
        if (st === 'online') {
          wasAutoIdled = true;
          updateSetting('status', 'idle');
          broadcastPresence();
        }
      });
    }, 5 * 60 * 1000);
  };
  ['mousemove', 'keydown', 'click'].forEach(ev => document.addEventListener(ev, resetIdle, { passive: true }));
  resetIdle();

  // Double-Esc Panic Boss Key (#78) & Ctrl+/ Shortcuts (#82)
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const now = Date.now();
      if (now - escLastPressed < 450) {
        const panic = document.getElementById('panicOverlay');
        if (panic) panic.style.display = panic.style.display === 'block' ? 'none' : 'block';
      }
      escLastPressed = now;
    }
    if ((e.ctrlKey || e.metaKey) && e.key === '/') {
      e.preventDefault();
      openShortcutsModal();
    }
  });
}

function broadcastPresence() {
  getState(['pulse_settings'], (res) => {
    const s = res.pulse_settings || {};
    Object.keys(liveConns).forEach(code => {
      if (liveConns[code]?.open) {
        liveConns[code].send({
          type: 'PRESENCE',
          status: s.status || 'online',
          activity: s.customActivity || '',
          birthday: s.birthday || ''
        });
      }
    });
  });
}

// --- Initialization ---
function scheduleRefresh(force = false) {
  if (renderTimer) cancelAnimationFrame(renderTimer);
  renderTimer = requestAnimationFrame(() => refreshAllViews(force));
}

document.addEventListener('DOMContentLoaded', () => {
  checkPinLockOnBoot();
  loadSettingsAndTheme();
  renderThemeMarketplace();
  updateProUI();
  initPeerNetwork();
  bindUIEvents();
  initActivityAndHotkeys();
  initWhiteboard();
  initMemeMaker();
  populateMicrophones();
  checkWeeklyScreenQuota();
  checkScheduledMessages();
  checkWhatsNewVersion();
  scheduleRefresh(true);

  setInterval(() => {
    if (peer && peer.disconnected && !peer.destroyed) {
      try { peer.reconnect(); } catch (e) {}
    }
    connectToAllFriends();
  }, 15000);

  setInterval(() => {
    flushOfflineQueue();
    checkScheduledMessages();
  }, 1500);

  syncChannel.onmessage = () => {
    loadSettingsAndTheme();
    updateProUI();
    scheduleRefresh(true);
  };
});

function checkWhatsNewVersion() {
  getState(['pulse_last_seen_ver'], (res) => {
    if (res.pulse_last_seen_ver !== APP_VERSION) {
      setState({ pulse_last_seen_ver: APP_VERSION });
      openWhatsNewModal();
    }
  });
}

function openWhatsNewModal() {
  const modal = document.getElementById('infoListModal');
  document.getElementById('infoListTitle').textContent = `✨ What's New in Pulse Chat v${APP_VERSION}`;
  document.getElementById('infoListBody').innerHTML = `
    <p><strong>🚀 50+ New Features Added:</strong></p>
    <ul style="padding-left:18px; display:flex; flex-direction:column; gap:6px;">
      <li><strong>Messaging:</strong> Reply threads, Edit & Delete messages, Markdown formatting, Slash command menu, Unread dividers, Scheduled messages, Polls, File/Image drag-and-drop & Clipboard paste, Mentions, and Message Forwarding.</li>
      <li><strong>Creative & Collaborative:</strong> Pulse Pro Emoji & Custom Sticker/Meme Maker, plus a real-time P2P Collaborative Whiteboard.</li>
      <li><strong>Group Servers:</strong> Multi-channel tabs (#text, 📢 announcements, 🔊 voice), Role permissions & colors, Member sidebar, Slowmode, Welcome rules, and Server Notification overrides.</li>
      <li><strong>Calls & Nerd Mode:</strong> Multi-peer call grid, Picture-in-Picture, Camera switcher, Per-user volume slider, YouTube Watch Together sync, and live WebRTC Nerd Stats.</li>
      <li><strong>Security & Customization:</strong> Pulse Pro 4-digit PIN lock, Double-Esc Panic Boss Key, Theme Marketplace, Developer Custom CSS editor, Split-Screen Dual Chat, and Birthday badges.</li>
    </ul>
  `;
  modal.style.display = 'flex';
}

function openShortcutsModal() {
  const modal = document.getElementById('infoListModal');
  document.getElementById('infoListTitle').textContent = '⌨️ Keyboard Shortcuts & Slash Commands';
  document.getElementById('infoListBody').innerHTML = `
    <div><strong>Esc (Press Twice):</strong> Toggle Panic Boss Screen (Biology Notes)</div>
    <div><strong>Ctrl + / :</strong> Open this Shortcuts Cheatsheet</div>
    <div><strong>Enter / Shift+Enter:</strong> Send message / New line</div>
    <div><strong>Ctrl + V (in chat):</strong> Paste screenshot image directly into chat</div>
    <hr style="border-color:var(--border);" />
    <div><strong>/tts [text]:</strong> Text-to-Speech voice message</div>
    <div><strong>/rps [rock|paper|scissors]:</strong> Challenge friend to Rock-Paper-Scissors</div>
    <div><strong>/poll Question | A | B:</strong> Post an interactive live poll</div>
    <div><strong>/party | /flip | /matrix:</strong> Fun visual chat effects</div>
  `;
  modal.style.display = 'flex';
}

// --- Audio & Media Helpers ---
function playSound(audioObj) {
  getState(['pulse_settings'], (res) => {
    const s = res.pulse_settings || {};
    if (s.sound !== false && s.status !== 'dnd') {
      audioObj.currentTime = 0;
      audioObj.play().catch(() => {});
    }
  });
}

function stopCallAudio() {
  ringtoneAudio.pause(); callingAudio.pause();
  ringtoneAudio.currentTime = 0; callingAudio.currentTime = 0;
}

function checkWeeklyScreenQuota(cb) {
  checkProAccess(({ hasPro }) => {
    const limitSec = hasPro ? 1800 : 600;
    getState(['pulse_screen_quota'], (res) => {
      const now = new Date();
      const weekStart = new Date(now.setDate(now.getDate() - now.getDay())).setHours(0, 0, 0, 0);
      let quota = res.pulse_screen_quota || { weekStart, usedSeconds: 0 };
      if (quota.weekStart !== weekStart) {
        quota = { weekStart, usedSeconds: 0 };
        setState({ pulse_screen_quota: quota });
      }
      const rem = Math.max(0, limitSec - quota.usedSeconds);
      if (document.getElementById('screenTimeLeft')) {
        document.getElementById('screenTimeLeft').textContent = `${Math.floor(rem / 60)}:${String(rem % 60).padStart(2, '0')}`;
      }
      if (cb) cb(rem, quota);
    });
  });
}

function toggleScreenShare() {
  if (screenStream) { stopScreenShare(); return; }
  checkWeeklyScreenQuota((rem, quota) => {
    if (rem <= 0) return alert('Weekly screen share quota reached!');
    navigator.mediaDevices.getDisplayMedia({ video: true, audio: true }).then((stream) => {
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
      autoGainControl: true
    };
    if (s.micDeviceId) audioConstraints.deviceId = { exact: s.micDeviceId };

    navigator.mediaDevices.getUserMedia({ video: true, audio: audioConstraints })
      .then(stream => cb(stream))
      .catch(() => {
        navigator.mediaDevices.getUserMedia({ video: false, audio: audioConstraints })
          .then(audioOnly => cb(audioOnly))
          .catch(() => alert('Microphone access blocked in browser permissions!'));
      });
  });
}

// --- Universal Cross-Version P2P Engine ---
function initPeerNetwork() {
  getState(['pulse_my_code', 'pulse_settings'], (res) => {
    myCode = res.pulse_my_code;
    if (!myCode) {
      myCode = Math.random().toString(36).substring(2, 6).toUpperCase();
      setState({ pulse_my_code: myCode });
    }
    const isStreamer = (res.pulse_settings || {}).streamerMode;
    if (document.getElementById('myCodeDisplay')) {
      document.getElementById('myCodeDisplay').textContent = isStreamer ? '****' : myCode;
    }

    const peerId = IS_POPUP ? `pulse-pop-${myCode}` : `pulse-ws-${myCode}`;
    if (peer) { try { peer.destroy(); } catch (e) {} }
    liveConns = {};
    connectingLocks = {};

    peer = new Peer(peerId, {
      debug: 0,
      config: {
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun1.l.google.com:19302' },
          { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
          { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' }
        ],
        iceCandidatePoolSize: 2
      }
    });

    peer.on('open', () => {
      if (document.getElementById('meshStatusText')) {
        document.getElementById('meshStatusText').textContent = `🟢 Connected (${isStreamer ? '****' : myCode})`;
      }
      connectToAllFriends();
      flushOfflineQueue();
    });

    peer.on('disconnected', () => {
      if (document.getElementById('meshStatusText')) {
        document.getElementById('meshStatusText').textContent = `🟡 Reconnecting...`;
      }
      setTimeout(() => {
        if (peer && peer.disconnected && !peer.destroyed) {
          try { peer.reconnect(); } catch (e) {}
        }
      }, 1000);
    });

    peer.on('connection', (conn) => handleIncomingConnection(conn));
    peer.on('error', (err) => { if (err.type === 'peer-unavailable') return; });

    peer.on('call', (call) => {
      if (!call || !call.peer) return;
      const callerCode = call.peer.replace(/^pulse-(ws-|pop-|bg-)?/, '');
      getState(['pulse_blocked'], (blkRes) => {
        if ((blkRes.pulse_blocked || []).includes(callerCode)) {
          try { call.close(); } catch (e) {}
          return;
        }
        currentCall = call;
        playSound(ringtoneAudio);
        document.getElementById('callerNameTitle').textContent = `Call from ${callerCode}`;
        document.getElementById('callModal').style.display = 'flex';
      });
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
  const code = targetCode.trim().toUpperCase();
  if (liveConns[code] && liveConns[code].open) return;
  if (connectingLocks[code] && Date.now() - connectingLocks[code] < 15000) return;
  connectingLocks[code] = Date.now();

  ['pulse-ws-', 'pulse-bg-', 'pulse-'].forEach(prefix => {
    try {
      const conn = peer.connect(`${prefix}${code}`, { reliable: true });
      if (conn) handleIncomingConnection(conn);
    } catch (e) {}
  });
}

function handleIncomingConnection(conn) {
  if (!conn || !conn.peer) return;
  const senderCode = conn.peer.replace(/^pulse-(ws-|pop-|bg-)?/, '');

  conn.on('open', () => {
    delete connectingLocks[senderCode];
    if (liveConns[senderCode] && liveConns[senderCode] !== conn && liveConns[senderCode].open) {
      try { conn.close(); } catch (e) {}
      return;
    }
    liveConns[senderCode] = conn;
    broadcastPresence();
    flushOfflineQueue();
    scheduleRefresh(true);
  });

  conn.on('data', (payload) => {
    if (!payload) return;
    getState(['pulse_blocked'], (blkRes) => {
      if ((blkRes.pulse_blocked || []).includes(senderCode)) return;

      if (payload.type === 'PRESENCE') {
        peerPresence[senderCode] = { status: payload.status, activity: payload.activity, birthday: payload.birthday };
        scheduleRefresh(true);
        return;
      }

      if (payload.type === 'TYPING') {
        if (activeTarget && activeTarget.id === senderCode && document.getElementById('typingIndicator')) {
          document.getElementById('typingIndicator').textContent = `${senderCode} is typing...`;
          clearTimeout(typingTimeout);
          typingTimeout = setTimeout(() => { document.getElementById('typingIndicator').textContent = ''; }, 2500);
        }
        return;
      }

      if (payload.type === 'REACTION') {
        applyMessageReaction(payload.chatId, payload.msgId, payload.emoji);
        return;
      }

      if (payload.type === 'EDIT_MSG') {
        editMessageInHistory(payload.chatId, payload.msgId, payload.newText, false);
        return;
      }

      if (payload.type === 'DELETE_MSG') {
        deleteMessageFromHistory(payload.chatId, payload.msgId, false);
        return;
      }

      if (payload.type === 'PIN_MSG') {
        setPinnedMessage(payload.chatId, payload.msgObj, false);
        return;
      }

      if (payload.type === 'POLL_VOTE') {
        voteOnPoll(payload.chatId, payload.msgId, payload.optIdx, senderCode, false);
        return;
      }

      if (payload.type === 'WB_STROKE') {
        drawRemoteStroke(payload);
        return;
      }

      if (payload.type === 'YT_SYNC') {
        applyRemoteYtSync(payload);
        return;
      }

      if (payload.type === 'GROUP_INVITE_SYNC') {
        getState(['pulse_groups'], (gRes) => {
          const groups = gRes.pulse_groups || [];
          const idx = groups.findIndex(g => g.id === payload.group.id);
          if (idx >= 0) groups[idx] = payload.group;
          else {
            groups.push(payload.group);
            if (payload.group.welcomeMsg) {
              saveMessageToHistory(payload.group.id, {
                id: 'sys-' + Date.now(),
                sender: '🤖 Server Welcome Bot',
                text: payload.group.welcomeMsg,
                time: Date.now(),
                self: false
              });
            }
          }
          setState({ pulse_groups: groups }, () => scheduleRefresh(true));
        });
        return;
      }

      if (payload.type === 'GROUP_MSG') {
        const storeKey = payload.channelId && payload.channelId !== 'general' ? `${payload.groupId}:${payload.channelId}` : payload.groupId;
        saveMessageToHistory(storeKey, {
          id: payload.msgId,
          sender: payload.senderName || senderCode,
          guildTag: payload.guildTag || '',
          text: payload.text,
          image: payload.image,
          fileName: payload.fileName,
          fileData: payload.fileData,
          replyTo: payload.replyTo,
          poll: payload.poll,
          time: Date.now(),
          self: false
        });
        incrementUnreadIfNeeded(payload.groupId);
        notifyIfNotViewing(payload.groupId, `${payload.groupName} (${senderCode})`, payload.text || 'Sent an attachment');
        return;
      }

      if (payload.type === 'DM') {
        getState(['pulse_friends', 'pulse_settings'], (res) => {
          const friends = res.pulse_friends || [];
          const dmFilter = (res.pulse_settings || {}).dmFilter || 'requests';
          if (!friends.some(f => f.code === senderCode)) {
            if (dmFilter === 'friends_only') return;
            addRequest({ type: 'message', code: senderCode, text: payload.text || '[Attachment]' });
          } else {
            saveMessageToHistory(senderCode, {
              id: payload.msgId,
              sender: senderCode,
              guildTag: payload.guildTag || '',
              text: payload.text,
              image: payload.image,
              fileName: payload.fileName,
              fileData: payload.fileData,
              replyTo: payload.replyTo,
              poll: payload.poll,
              time: Date.now(),
              self: false
            });
            incrementUnreadIfNeeded(senderCode);
            if (payload.tts) speakText(`${senderCode} says ${payload.text}`);
            if (conn.open) conn.send({ type: 'READ_ACK', msgId: payload.msgId });
            notifyIfNotViewing(senderCode, senderCode, payload.text || 'Sent an attachment');
          }
        });
      }

      if (payload.type === 'READ_ACK') {
        markMessageRead(senderCode, payload.msgId);
      }
    });
  });

  const cleanup = () => {
    if (liveConns[senderCode] === conn) delete liveConns[senderCode];
    try {
      if (conn.peerConnection) conn.peerConnection.close();
      conn.close();
    } catch (e) {}
    scheduleRefresh(true);
  };
  conn.on('close', cleanup);
  conn.on('error', cleanup);
}

// --- Outbox Queue (#74) & Scheduled Messages (#15) ---
function sendPayloadToCode(targetCode, payload) {
  const code = targetCode.trim().toUpperCase();
  const conn = liveConns[code];
  let sent = false;
  if (conn && conn.open) {
    try { conn.send(payload); sent = true; } catch (e) { delete liveConns[code]; }
  }
  if (!sent && payload.type !== 'TYPING' && payload.type !== 'WB_STROKE') {
    getState(['pulse_outbox'], (res) => {
      const outbox = res.pulse_outbox || [];
      if (!outbox.some(item => item.payload?.msgId === payload.msgId && payload.msgId)) {
        outbox.push({ targetCode: code, payload, queuedAt: Date.now() });
        setState({ pulse_outbox: outbox }, updateQueueBadge);
      }
    });
    connectToCode(code);
  }
  return sent;
}

function flushOfflineQueue() {
  getState(['pulse_outbox'], (res) => {
    const outbox = res.pulse_outbox || [];
    updateQueueBadge();
    if (outbox.length === 0) return;
    const remaining = [];
    outbox.forEach(item => {
      if (sendPayloadToCode(item.targetCode, item.payload)) {
        if (item.payload?.msgId) markMessageDelivered(item.targetCode, item.payload.msgId);
      } else {
        remaining.push(item);
      }
    });
    if (remaining.length !== outbox.length) {
      setState({ pulse_outbox: remaining }, updateQueueBadge);
    }
  });
}

function updateQueueBadge() {
  getState(['pulse_outbox'], (res) => {
    const len = (res.pulse_outbox || []).length;
    const b = document.getElementById('queueBadge');
    if (b) { b.textContent = len; b.style.display = len > 0 ? 'inline-block' : 'none'; }
  });
}

function checkScheduledMessages() {
  getState(['pulse_scheduled'], (res) => {
    const list = res.pulse_scheduled || [];
    if (list.length === 0) return;
    const now = Date.now();
    const due = list.filter(s => s.sendAt <= now);
    const future = list.filter(s => s.sendAt > now);
    if (due.length > 0) {
      setState({ pulse_scheduled: future }, () => {
        due.forEach(item => dispatchDirectOrGroupText(item.target, item.text, item.channelId));
      });
    }
  });
}

// --- History Mutations (Edit #3, Delete #4, Pin #1, Unread #12/#13, Polls #20) ---
function saveMessageToHistory(chatId, msgObj) {
  getState(['pulse_history'], (res) => {
    const history = res.pulse_history || {};
    if (!history[chatId]) history[chatId] = [];
    if (!history[chatId].some(m => m.id === msgObj.id)) {
      history[chatId].push(msgObj);
      setState({ pulse_history: history }, () => scheduleRefresh(true));
    }
  });
}

function editMessageInHistory(chatId, msgId, newText, broadcast = true) {
  getState(['pulse_history'], (res) => {
    const history = res.pulse_history || {};
    const msg = (history[chatId] || []).find(m => m.id === msgId);
    if (msg) {
      msg.text = newText;
      msg.edited = true;
      setState({ pulse_history: history }, () => scheduleRefresh(true));
      if (broadcast && activeTarget?.type === 'dm') {
        sendPayloadToCode(activeTarget.id, { type: 'EDIT_MSG', chatId: myCode, msgId, newText });
      }
    }
  });
}

function deleteMessageFromHistory(chatId, msgId, broadcast = true) {
  getState(['pulse_history'], (res) => {
    const history = res.pulse_history || {};
    if (history[chatId]) {
      history[chatId] = history[chatId].filter(m => m.id !== msgId);
      setState({ pulse_history: history }, () => scheduleRefresh(true));
      if (broadcast && activeTarget?.type === 'dm') {
        sendPayloadToCode(activeTarget.id, { type: 'DELETE_MSG', chatId: myCode, msgId });
      }
    }
  });
}

function setPinnedMessage(chatId, msgObj, broadcast = true) {
  getState(['pulse_pins'], (res) => {
    const pins = res.pulse_pins || {};
    if (msgObj) pins[chatId] = msgObj;
    else delete pins[chatId];
    setState({ pulse_pins: pins }, () => scheduleRefresh(true));
    if (broadcast && activeTarget?.type === 'dm') {
      sendPayloadToCode(activeTarget.id, { type: 'PIN_MSG', chatId: myCode, msgObj });
    }
  });
}

function voteOnPoll(chatId, msgId, optIdx, voter, broadcast = true) {
  getState(['pulse_history'], (res) => {
    const history = res.pulse_history || {};
    const msg = (history[chatId] || []).find(m => m.id === msgId);
    if (msg && msg.poll) {
      msg.poll.options.forEach(o => { o.votes = (o.votes || []).filter(v => v !== voter); });
      msg.poll.options[optIdx].votes.push(voter);
      setState({ pulse_history: history }, () => scheduleRefresh(true));
      if (broadcast && activeTarget?.type === 'dm') {
        sendPayloadToCode(activeTarget.id, { type: 'POLL_VOTE', chatId: myCode, msgId, optIdx });
      }
    }
  });
}

function applyMessageReaction(chatId, msgId, emoji) {
  getState(['pulse_history'], (res) => {
    const history = res.pulse_history || {};
    const msg = (history[chatId] || []).find(m => m.id === msgId);
    if (msg) {
      if (!msg.reactions) msg.reactions = {};
      msg.reactions[emoji] = (msg.reactions[emoji] || 0) + 1;
      setState({ pulse_history: history }, () => scheduleRefresh(true));
    }
  });
}

function markMessageDelivered(chatId, msgId) {
  getState(['pulse_history'], (res) => {
    const history = res.pulse_history || {};
    const msg = (history[chatId] || []).find(m => m.id === msgId);
    if (msg && msg.status !== 'Read') msg.status = 'Sent';
    setState({ pulse_history: history }, () => scheduleRefresh(true));
  });
}

function markMessageRead(chatId, msgId) {
  getState(['pulse_history'], (res) => {
    const history = res.pulse_history || {};
    const msg = (history[chatId] || []).find(m => m.id === msgId);
    if (msg) msg.status = 'Read';
    setState({ pulse_history: history }, () => scheduleRefresh(true));
  });
}

function incrementUnreadIfNeeded(chatId) {
  if (activeTarget && activeTarget.id === chatId && document.hasFocus()) return;
  getState(['pulse_unreads'], (res) => {
    const unreads = res.pulse_unreads || {};
    unreads[chatId] = (unreads[chatId] || 0) + 1;
    setState({ pulse_unreads: unreads }, updatePageTitleUnread);
  });
}

function clearUnread(chatId) {
  getState(['pulse_unreads'], (res) => {
    const unreads = res.pulse_unreads || {};
    if (unreads[chatId]) {
      delete unreads[chatId];
      setState({ pulse_unreads: unreads }, updatePageTitleUnread);
    }
  });
}

function updatePageTitleUnread() {
  getState(['pulse_unreads'], (res) => {
    const total = Object.values(res.pulse_unreads || {}).reduce((a, b) => a + b, 0);
    document.title = total > 0 ? `(${total}) Pulse Chat v${APP_VERSION}` : `Pulse Chat v${APP_VERSION} — Workspace`;
  });
}

function addRequest(reqObj) {
  getState(['pulse_requests'], (res) => {
    const reqs = res.pulse_requests || [];
    if (!reqs.some(r => r.code === reqObj.code && r.type === reqObj.type)) {
      reqs.push(reqObj);
      setState({ pulse_requests: reqs }, () => scheduleRefresh(true));
      playSound(chimeAudio);
    }
  });
}

// --- Desktop Notification with Quick-Reply (#84) & Mute Check (#36/#50) ---
function notifyIfNotViewing(chatId, title, text) {
  if (document.hasFocus() && activeTarget && activeTarget.id === chatId) return;
  getState(['pulse_friend_meta', 'pulse_groups'], (res) => {
    const fMeta = (res.pulse_friend_meta || {})[chatId];
    if (fMeta && fMeta.muted) return;

    const grp = (res.pulse_groups || []).find(g => g.id === chatId);
    if (grp) {
      if (grp.notifOverride === 'mute') return;
      if (grp.notifOverride === 'mentions' && !text.includes(`@${myCode}`) && !text.includes('@everyone')) return;
    }

    playSound(chimeAudio);
    if ('Notification' in window && Notification.permission === 'granted') {
      const n = new Notification(title, { body: text });
      n.onclick = () => {
        window.focus();
        const reply = prompt(`Quick Reply to ${title}:`);
        if (reply && reply.trim()) {
          dispatchDirectOrGroupText({ type: grp ? 'group' : 'dm', id: chatId, name: title, members: grp?.members }, reply.trim(), 'general');
        }
      };
    } else if ('Notification' in window && Notification.permission !== 'denied') {
      Notification.requestPermission();
    }
  });
}

// --- Rich Markdown (#9), Mentions (#23), Spoilers ---
function formatMessageText(rawText, settings) {
  let out = rawText.replace(/</g, '&lt;').replace(/>/g, '&gt;');
  if (settings.autoEmoji !== false) {
    out = out.replace(/:\)/g, '😊').replace(/:\(/g, '😢').replace(/<3/g, '❤️').replace(/:D/g, '😄');
  }
  // Inline code, bold, italic, strikethrough (#9)
  out = out.replace(/`([^`]+)`/g, '<code style="background:rgba(0,0,0,0.3); padding:1px 5px; border-radius:4px;">$1</code>');
  out = out.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/\*(.+?)\*/g, '<em>$1</em>');
  out = out.replace(/~~(.+?)~~/g, '<del>$1</del>');
  // Mentions (#23)
  out = out.replace(/(@[A-Z0-9]{4}|@everyone)/gi, '<span style="background:rgba(240,178,50,0.3); color:#fde047; font-weight:800; padding:0 4px; border-radius:4px;">$1</span>');
  // Spoilers
  out = out.replace(/\|\|(.+?)\|\|/g, '<span class="spoiler-box" onclick="this.classList.toggle(\'revealed\')">$1</span>');
  return out;
}

// --- Rendering Sidebar & Active Chat ---
function refreshAllViews(force = false) {
  getState(['pulse_friends', 'pulse_groups', 'pulse_requests', 'pulse_history', 'pulse_settings', 'pulse_unreads', 'pulse_pins', 'pulse_friend_meta', 'pulse_outbox'], (res) => {
    const friends = res.pulse_friends || [];
    const groups = res.pulse_groups || [];
    const requests = res.pulse_requests || [];
    const history = res.pulse_history || {};
    const settings = res.pulse_settings || {};
    const unreads = res.pulse_unreads || {};
    const pins = res.pulse_pins || {};
    const fMeta = res.pulse_friend_meta || {};
    const outbox = res.pulse_outbox || [];

    const onlineCodes = Object.keys(liveConns).filter(k => liveConns[k]?.open).join(',');
    const storeKey = getActiveHistoryKey();
    const activeMsgs = storeKey ? (history[storeKey] || []) : [];
    const lastMsg = activeMsgs[activeMsgs.length - 1];
    const sig = `${storeKey}|${friends.length}|${groups.length}|${requests.length}|${activeMsgs.length}|${lastMsg?.id}|${lastMsg?.text}|${lastMsg?.status}|${onlineCodes}|${JSON.stringify(unreads[activeTarget?.id])}`;

    if (!force && sig === lastRenderSignature) return;
    lastRenderSignature = sig;

    const badge = document.getElementById('reqBadge');
    if (badge) {
      badge.textContent = requests.length;
      badge.style.display = requests.length > 0 ? 'inline-block' : 'none';
    }

    const isGroups = document.getElementById('railGroups')?.classList.contains('active');
    const isReqs = document.getElementById('railRequests')?.classList.contains('active');
    const isQueue = document.getElementById('railQueue')?.classList.contains('active');

    if (isQueue) renderQueueSidebar('sidebarList', outbox);
    else if (isReqs) renderRequestsList('sidebarList', requests);
    else if (isGroups) renderList('sidebarList', groups, 'group', settings, unreads, fMeta);
    else renderList('sidebarList', friends, 'dm', settings, unreads, fMeta);

    renderActiveChat(history, settings, groups, pins, unreads);
    if (splitTarget) renderSplitChat(history, settings);
  });
}

function getActiveHistoryKey() {
  if (!activeTarget) return null;
  if (activeTarget.type === 'group' && activeChannelId && activeChannelId !== 'general') {
    return `${activeTarget.id}:${activeChannelId}`;
  }
  return activeTarget.id;
}

function renderList(containerId, items, type, settings, unreads, fMeta) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = '';

  if (items.length === 0) {
    container.innerHTML = `<div style="color:var(--muted); text-align:center; padding:12px; font-size:0.78rem;">No ${type === 'dm' ? 'friends' : 'groups'} yet.</div>`;
    return;
  }

  const todayMmDd = `${String(new Date().getMonth() + 1).padStart(2, '0')}-${String(new Date().getDate()).padStart(2, '0')}`;

  items.forEach(item => {
    const id = type === 'dm' ? item.code : item.id;
    const isOnline = type === 'dm' && !!liveConns[id]?.open;
    const pres = peerPresence[id] || {};
    const statusDotColor = !isOnline ? '#64748b' : pres.status === 'dnd' ? '#ef4444' : pres.status === 'idle' ? '#f59e0b' : '#10b981';
    const meta = fMeta[id] || {};
    const displayName = meta.nickname || item.name;
    const isBirthday = pres.birthday === todayMmDd;
    const unreadCnt = unreads[id] || 0;

    const el = document.createElement('div');
    el.className = `list-card ${activeTarget && activeTarget.id === id ? 'active' : ''}`;
    el.innerHTML = `
      <div style="flex:1; overflow:hidden;">
        <div style="font-weight:700; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
          ${type === 'group' ? (item.icon || '#') + ' ' : ''}${displayName} ${isBirthday ? '🎂' : ''} ${meta.muted ? '🔇' : ''}
        </div>
        <div class="muted-sub" style="font-size:0.7rem; color:var(--muted); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
          ${type === 'dm' ? (pres.activity || (settings.streamerMode ? '••••' : id)) : `${(item.members || []).length} members`}
        </div>
      </div>
      <div style="display:flex; align-items:center; gap:6px;">
        ${unreadCnt > 0 ? `<span style="background:var(--danger); color:#fff; font-size:0.68rem; font-weight:800; padding:1px 6px; border-radius:10px;">${unreadCnt}</span>` : ''}
        ${type === 'dm' ? `<span style="color:${statusDotColor}; font-size:0.8rem;">●</span>` : ''}
        ${type === 'dm' ? `<button data-remove-friend="${id}" style="background:rgba(239,68,68,0.18); color:#ef4444; padding:2px 6px; font-size:0.72rem;">✕</button>` : ''}
      </div>
    `;
    el.onclick = (e) => {
      if (e.target.closest('[data-remove-friend]')) return;
      activeTarget = { type, id, name: displayName, members: item.members, admin: item.admin, icon: item.icon };
      activeChannelId = 'general';
      clearUnread(id);
      if (type === 'dm') connectToCode(id);
      scheduleRefresh(true);
    };
    const remBtn = el.querySelector('[data-remove-friend]');
    if (remBtn) {
      remBtn.onclick = (e) => {
        e.stopPropagation();
        if (confirm(`Remove ${displayName} and delete chat history?`)) removeFriendAndRecords(id, false);
      };
    }
    container.appendChild(el);
  });
}

function renderQueueSidebar(containerId, outbox) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = '';
  if (outbox.length === 0) {
    container.innerHTML = `<div style="color:var(--muted); text-align:center; padding:12px; font-size:0.8rem;">Offline Outbox is empty!</div>`;
    return;
  }
  outbox.forEach((item, idx) => {
    const el = document.createElement('div');
    el.className = 'list-card';
    el.innerHTML = `
      <div style="overflow:hidden;">
        <strong>To ${item.targetCode}</strong>
        <div style="font-size:0.74rem; color:var(--muted);">${item.payload?.text || '[Attachment]'}</div>
      </div>
      <button class="btn-danger" style="padding:3px 7px; font-size:0.7rem;" data-drop-q="${idx}">Cancel</button>
    `;
    el.querySelector('[data-drop-q]').onclick = () => {
      outbox.splice(idx, 1);
      setState({ pulse_outbox: outbox }, () => { updateQueueBadge(); scheduleRefresh(true); });
    };
    container.appendChild(el);
  });
}

function renderRequestsList(containerId, requests) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = '';
  if (requests.length === 0) {
    container.innerHTML = `<div style="color:var(--muted); text-align:center; padding:12px; font-size:0.8rem;">No pending requests.</div>`;
    return;
  }
  requests.forEach((req, idx) => {
    const el = document.createElement('div');
    el.className = 'list-card';
    el.style.flexDirection = 'column';
    el.style.alignItems = 'stretch';
    el.innerHTML = `
      <div><strong>${req.code}</strong><div style="font-size:0.75rem; color:var(--muted);">"${req.text || ''}"</div></div>
      <div style="display:flex; gap:6px; margin-top:6px;">
        <button class="btn-success" style="flex:1; padding:4px;" data-accept="${idx}">Accept</button>
        <button class="btn-danger" style="flex:1; padding:4px;" data-decline="${idx}">Decline</button>
      </div>
    `;
    el.querySelector('[data-accept]').onclick = () => {
      getState(['pulse_requests', 'pulse_friends'], (res) => {
        const reqs = res.pulse_requests || [];
        const friends = res.pulse_friends || [];
        if (!friends.some(f => f.code === req.code)) friends.push({ code: req.code, name: req.code });
        reqs.splice(idx, 1);
        setState({ pulse_requests: reqs, pulse_friends: friends }, () => { connectToCode(req.code); scheduleRefresh(true); });
      });
    };
    el.querySelector('[data-decline]').onclick = () => {
      getState(['pulse_requests'], (res) => {
        const reqs = res.pulse_requests || [];
        reqs.splice(idx, 1);
        setState({ pulse_requests: reqs }, () => scheduleRefresh(true));
      });
    };
    container.appendChild(el);
  });
}

function renderActiveChat(history, settings, groups, pins, unreads) {
  const titleEl = document.getElementById('activeChatTitle');
  const box = document.getElementById('messagesBox');
  if (!titleEl || !box) return;

  const callBtn = document.getElementById('wsCallBtn');
  const infoBtn = document.getElementById('profileInspectBtn');
  const splitBtn = document.getElementById('splitScreenBtn');
  const memBtn = document.getElementById('toggleMembersBtn');
  const addMemBtn = document.getElementById('addGroupMemberBtn');
  const grpSetBtn = document.getElementById('groupSettingsBtn');
  const boostBtn = document.getElementById('headerBoostBtn');
  const levelBadge = document.getElementById('headerBoostLevelBadge');
  const boostStrip = document.getElementById('groupBoostBarStrip');
  const channelBar = document.getElementById('channelTabsBar');
  const pinnedBanner = document.getElementById('pinnedBanner');

  if (!activeTarget) {
    titleEl.textContent = 'Select a Friend or Group';
    [callBtn, infoBtn, splitBtn, memBtn, addMemBtn, grpSetBtn, boostBtn, levelBadge, boostStrip, channelBar, pinnedBanner].forEach(el => { if (el) el.style.display = 'none'; });
    box.innerHTML = `
      <div class="empty-welcome">
        <div style="font-size:2.2rem;">⚡</div>
        <strong>Pulse Chat v${APP_VERSION}</strong>
        <p style="font-size:0.82rem; color:var(--muted);">Select a friend or group on the left, create custom stickers 🎨, or open the live P2P Whiteboard ✏️.</p>
      </div>
    `;
    return;
  }

  const isGroup = activeTarget.type === 'group';
  const currentGroup = isGroup ? groups.find(g => g.id === activeTarget.id) : null;
  titleEl.textContent = `${isGroup ? ((currentGroup?.icon || '#') + ' ') : ''}${currentGroup?.name || activeTarget.name}`;

  if (callBtn) callBtn.style.display = 'inline-block';
  if (splitBtn) splitBtn.style.display = 'inline-block';
  if (infoBtn) infoBtn.style.display = !isGroup ? 'inline-block' : 'none';
  if (memBtn) memBtn.style.display = isGroup ? 'inline-block' : 'none';
  if (addMemBtn) addMemBtn.style.display = isGroup ? 'inline-block' : 'none';
  if (grpSetBtn) grpSetBtn.style.display = isGroup ? 'inline-block' : 'none';
  if (boostBtn) boostBtn.style.display = isGroup ? 'inline-block' : 'none';

  // Group Channels Strip (#40, #45)
  if (isGroup && currentGroup && channelBar) {
    const channels = currentGroup.channels || [{ id: 'general', name: 'general', type: 'text' }];
    channelBar.style.display = 'flex';
    channelBar.innerHTML = '';
    channels.forEach(ch => {
      const pill = document.createElement('div');
      pill.className = `channel-pill ${activeChannelId === ch.id ? 'active' : ''}`;
      const icon = ch.type === 'voice' ? '🔊' : ch.type === 'announcement' ? '📢' : '#';
      pill.textContent = `${icon} ${ch.name}`;
      pill.onclick = () => {
        if (ch.type === 'voice') {
          startVoiceOrVideoCall();
          return;
        }
        activeChannelId = ch.id;
        scheduleRefresh(true);
      };
      channelBar.appendChild(pill);
    });
  } else if (channelBar) {
    channelBar.style.display = 'none';
  }

  // Group Boost Strip
  if (currentGroup && levelBadge && boostStrip) {
    const boosts = currentGroup.boosts || 0;
    const bInfo = getGroupBoostLevel(boosts);
    levelBadge.style.display = 'inline-block';
    levelBadge.textContent = `LEVEL ${bInfo.level}`;
    boostStrip.style.display = 'flex';
    document.getElementById('boostBarLabel').textContent = `🚀 Boosts: ${boosts} / ${bInfo.nextGoal}`;
    document.getElementById('boostBarFill').style.width = `${Math.min(100, (boosts / bInfo.nextGoal) * 100)}%`;
    document.getElementById('boostPerksSummary').textContent = `${bInfo.audio} • ${bInfo.stream}`;
  } else {
    if (levelBadge) levelBadge.style.display = 'none';
    if (boostStrip) boostStrip.style.display = 'none';
  }

  // Pinned Banner (#1)
  const storeKey = getActiveHistoryKey();
  const pinnedObj = pins[storeKey];
  if (pinnedObj && pinnedBanner) {
    pinnedBanner.style.display = 'flex';
    document.getElementById('pinnedBannerText').textContent = `📌 Pinned (${pinnedObj.sender}): ${pinnedObj.text || '[Attachment]'}`;
  } else if (pinnedBanner) {
    pinnedBanner.style.display = 'none';
  }

  // Render Messages
  const msgs = (history[storeKey] || []).slice(-150);
  box.innerHTML = '';
  if (msgs.length === 0) {
    box.innerHTML = `<div class="empty-welcome"><strong>No messages yet</strong><p style="font-size:0.8rem; color:var(--muted);">Say hello, paste a screenshot, or type <code>/</code> for commands!</p></div>`;
    return;
  }

  const unreadStartIdx = msgs.length - (unreads[activeTarget.id] || 0);
  const frag = document.createDocumentFragment();

  msgs.forEach((m, idx) => {
    if (idx === unreadStartIdx && unreads[activeTarget.id] > 0) {
      const divLine = document.createElement('div');
      divLine.className = 'unread-divider';
      divLine.textContent = 'NEW MESSAGES';
      frag.appendChild(divLine);
    }

    const div = document.createElement('div');
    const isMentioned = !m.self && m.text && (m.text.includes(`@${myCode}`) || m.text.includes('@everyone'));
    div.className = `message ${m.self ? 'sent' : 'received'} ${isMentioned ? 'mentioned' : ''}`;

    const timeStr = new Date(m.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const statusHtml = (m.self && m.status) ? `<span>${m.status === 'Queued' ? '🕒' : m.status === 'Read' ? '✓✓' : '✓'}</span>` : '';
    const editedHtml = m.edited ? `<span style="font-style:italic;">(edited)</span>` : '';
    const senderLabel = (!m.self && isGroup) ? `<div style="font-size:0.72rem; font-weight:800; color:#fbbf24; margin-bottom:2px;">${m.sender}</div>` : '';
    const replyHtml = m.replyTo ? `<div class="reply-quote">↩️ <strong>${m.replyTo.sender}:</strong> ${m.replyTo.text}</div>` : '';

    let mediaHtml = '';
    if (m.image) mediaHtml += `<img src="${m.image}" style="max-width:240px; max-height:220px; border-radius:8px; display:block; margin-top:4px;" />`;
    if (m.fileData && m.fileName) mediaHtml += `<a href="${m.fileData}" download="${m.fileName}" style="display:inline-block; margin-top:4px; background:rgba(0,0,0,0.25); padding:5px 9px; border-radius:6px; color:#fff; text-decoration:none; font-size:0.78rem;">📄 Download ${m.fileName}</a>`;

    let pollHtml = '';
    if (m.poll) {
      const totalVotes = m.poll.options.reduce((sum, o) => sum + (o.votes || []).length, 0);
      pollHtml = `<div style="background:rgba(0,0,0,0.22); padding:8px; border-radius:8px; margin-top:6px;">
        <div style="font-weight:800; margin-bottom:6px;">📊 ${m.poll.question}</div>
        ${m.poll.options.map((opt, oIdx) => {
          const cnt = (opt.votes || []).length;
          const pct = totalVotes > 0 ? Math.round((cnt / totalVotes) * 100) : 0;
          return `<div data-vote-msg="${m.id}" data-vote-opt="${oIdx}" style="background:rgba(255,255,255,0.1); padding:5px 8px; border-radius:6px; margin-bottom:4px; cursor:pointer; font-size:0.78rem;">
            ${opt.label} — <strong>${cnt} (${pct}%)</strong>
          </div>`;
        }).join('')}
      </div>`;
    }

    let reactHtml = '';
    if (m.reactions) {
      reactHtml = `<div style="display:flex; gap:4px; margin-top:4px; flex-wrap:wrap;">` +
        Object.entries(m.reactions).map(([em, cnt]) => `<span style="background:rgba(0,0,0,0.28); border-radius:10px; padding:1px 6px; font-size:0.72rem;">${em} ${cnt}</span>`).join('') +
        `</div>`;
    }

    div.innerHTML = `
      <div class="msg-actions">
        <button data-act-reply title="Reply">↩️</button>
        <button data-act-react title="React">🔥</button>
        <button data-act-pin title="Pin">📌</button>
        <button data-act-fwd title="Forward">➡️</button>
        ${m.self ? `<button data-act-edit title="Edit">✏️</button><button data-act-del title="Delete">🗑️</button>` : ''}
      </div>
      ${senderLabel}
      ${replyHtml}
      <div>${formatMessageText(m.text || '', settings)}</div>
      ${mediaHtml}
      ${pollHtml}
      ${reactHtml}
      <div class="msg-meta">${editedHtml}<span>${timeStr}</span>${statusHtml}</div>
    `;

    div.querySelector('[data-act-reply]').onclick = () => {
      replyingToMsg = { id: m.id, sender: m.self ? 'You' : m.sender, text: (m.text || '[Attachment]').slice(0, 60) };
      document.getElementById('replyPreviewBar').style.display = 'flex';
      document.getElementById('replyPreviewText').textContent = `Replying to ${replyingToMsg.sender}: "${replyingToMsg.text}"`;
      document.getElementById('msgInput').focus();
    };
    div.querySelector('[data-act-react]').onclick = () => {
      const em = prompt('Enter emoji reaction:', '👍') || '👍';
      applyMessageReaction(storeKey, m.id, em);
      if (activeTarget.type === 'dm') sendPayloadToCode(activeTarget.id, { type: 'REACTION', chatId: myCode, msgId: m.id, emoji: em });
    };
    div.querySelector('[data-act-pin]').onclick = () => setPinnedMessage(storeKey, m, true);
    div.querySelector('[data-act-fwd]').onclick = () => {
      const dest = prompt('Enter Friend 4-Digit Code to forward this message to:');
      if (dest && dest.trim().length === 4) {
        dispatchDirectOrGroupText({ type: 'dm', id: dest.trim().toUpperCase(), name: dest.trim().toUpperCase() }, `↪️ Forwarded: ${m.text || '[Attachment]'}`, 'general');
        alert('Forwarded!');
      }
    };
    div.querySelector('[data-act-edit]')?.addEventListener('click', () => {
      const updated = prompt('Edit message:', m.text);
      if (updated && updated.trim()) editMessageInHistory(storeKey, m.id, updated.trim(), true);
    });
    div.querySelector('[data-act-del]')?.addEventListener('click', () => {
      if (confirm('Delete this message?')) deleteMessageFromHistory(storeKey, m.id, true);
    });
    div.querySelectorAll('[data-vote-msg]').forEach(btn => {
      btn.onclick = () => voteOnPoll(storeKey, btn.dataset.voteMsg, parseInt(btn.dataset.voteOpt, 10), myCode, true);
    });

    frag.appendChild(div);
  });
  box.appendChild(frag);
  box.scrollTop = box.scrollHeight;
}

function renderSplitChat(history, settings) {
  const box = document.getElementById('splitMessagesBox');
  if (!box || !splitTarget) return;
  document.getElementById('splitChatTitle').textContent = `◫ ${splitTarget.name}`;
  const msgs = (history[splitTarget.id] || []).slice(-60);
  box.innerHTML = '';
  msgs.forEach(m => {
    const div = document.createElement('div');
    div.className = `message ${m.self ? 'sent' : 'received'}`;
    div.innerHTML = `<div>${formatMessageText(m.text || '[Attachment]', settings)}</div>`;
    box.appendChild(div);
  });
  box.scrollTop = box.scrollHeight;
}

// --- Sending Messages, Slash Commands, Polls, Attachments & Clipboard Paste ---
function handleSendMessage(customInputId = 'msgInput', targetOverride = null) {
  const input = document.getElementById(customInputId);
  let text = input ? input.value.trim() : '';
  const target = targetOverride || activeTarget;
  if (!text || !target) return;

  // Fun Slash Commands
  if (text.toLowerCase() === '/flip') { document.body.classList.toggle('flip-mode'); input.value = ''; return; }
  if (text.toLowerCase() === '/matrix') { updateSetting('theme', 'matrix'); input.value = ''; return; }
  if (text.toLowerCase() === '/party') {
    input.value = '';
    const cols = ['cyber-dark', 'emerald', 'purple', 'crimson', 'sunset', 'pro-obsidian'];
    let i = 0;
    const t = setInterval(() => {
      document.documentElement.setAttribute('data-theme', cols[i++ % cols.length]);
      if (i > 12) { clearInterval(t); loadSettingsAndTheme(); }
    }, 180);
    return;
  }

  // Mini-game: Rock-Paper-Scissors (#64)
  if (text.toLowerCase().startsWith('/rps ')) {
    const choice = text.slice(5).trim().toLowerCase();
    const moves = ['rock', 'paper', 'scissors'];
    if (moves.includes(choice)) {
      const botMove = moves[Math.floor(Math.random() * 3)];
      const win = (choice === 'rock' && botMove === 'scissors') || (choice === 'paper' && botMove === 'rock') || (choice === 'scissors' && botMove === 'paper');
      const outcome = choice === botMove ? 'Tie!' : win ? 'You Win! 🎉' : 'You Lose! 💀';
      text = `🎮 **RPS Challenge:** Played **${choice.toUpperCase()}** vs **${botMove.toUpperCase()}** → **${outcome}**`;
    }
  }

  // Quick Poll Command (#20)
  if (text.toLowerCase().startsWith('/poll ')) {
    const parts = text.slice(6).split('|').map(p => p.trim()).filter(Boolean);
    if (parts.length >= 3) {
      input.value = '';
      sendRichMessage(target, {
        text: '',
        poll: { question: parts[0], options: parts.slice(1).map(label => ({ label, votes: [] })) }
      });
      return;
    }
  }

  let isTts = false;
  if (text.toLowerCase().startsWith('/tts ')) {
    isTts = true;
    text = text.slice(5).trim();
    if ('speechSynthesis' in window) window.speechSynthesis.speak(new SpeechSynthesisUtterance(text));
  }

  const matchedBan = BANNED_PHRASES.find(p => text.includes(p));
  if (matchedBan) {
    input.value = '';
    window.open(getAssetUrl(`warning.html?term=${encodeURIComponent(matchedBan)}`), '_blank');
    return;
  }

  input.value = '';
  document.getElementById('slashMenu').style.display = 'none';
  dispatchDirectOrGroupText(target, text, activeChannelId, isTts);
}

function dispatchDirectOrGroupText(target, text, channelId = 'general', isTts = false) {
  getState(['pulse_settings', 'pulse_groups'], (res) => {
    const settings = res.pulse_settings || {};
    const groups = res.pulse_groups || [];

    if (target.type === 'group') {
      const grp = groups.find(g => g.id === target.id);
      if (grp) {
        // Announcement Channel Check (#45)
        const ch = (grp.channels || []).find(c => c.id === channelId);
        if (ch && ch.type === 'announcement' && grp.admin !== myCode) {
          return alert('📢 Only the server owner can post in Announcement channels!');
        }
        // Slowmode Check (#22)
        if (grp.slowmodeSec > 0 && grp.admin !== myCode) {
          const waitLeft = Math.ceil((grp.slowmodeSec * 1000 - (Date.now() - lastMessageSentAt)) / 1000);
          if (waitLeft > 0) return alert(`⏳ Slowmode active! Please wait ${waitLeft}s.`);
        }
        // AutoMod Check
        if (Array.isArray(grp.autoModWords)) {
          const hit = grp.autoModWords.find(w => w && text.toLowerCase().includes(w.toLowerCase()));
          if (hit) return alert(`🛡️ AutoMod blocked restricted word: "${hit}"`);
        }
      }
    }

    lastMessageSentAt = Date.now();
    sendRichMessage(target, { text, tts: isTts }, channelId);
  });
}

function sendRichMessage(target, extraFields, channelId = 'general') {
  getState(['pulse_settings'], (res) => {
    const guildTag = ((res.pulse_settings || {}).equippedTag || '').toUpperCase();
    const msgId = 'msg-' + Date.now() + '-' + Math.random().toString(36).substring(2, 5);
    const replySnapshot = replyingToMsg ? { ...replyingToMsg } : null;
    replyingToMsg = null;
    if (document.getElementById('replyPreviewBar')) document.getElementById('replyPreviewBar').style.display = 'none';

    const msgObj = {
      id: msgId,
      sender: target.type === 'group' ? 'You' : myCode,
      guildTag,
      time: Date.now(),
      self: true,
      status: 'Sent',
      replyTo: replySnapshot,
      ...extraFields
    };

    if (target.type === 'dm') {
      const sent = sendPayloadToCode(target.id, { type: 'DM', msgId, guildTag, replyTo: replySnapshot, ...extraFields });
      msgObj.status = sent ? 'Sent' : 'Queued';
      saveMessageToHistory(target.id, msgObj);
    } else if (target.type === 'group') {
      const storeKey = channelId && channelId !== 'general' ? `${target.id}:${channelId}` : target.id;
      saveMessageToHistory(storeKey, msgObj);
      (target.members || []).forEach(mc => {
        if (mc !== myCode) {
          sendPayloadToCode(mc, {
            type: 'GROUP_MSG',
            msgId,
            groupId: target.id,
            groupName: target.name,
            channelId,
            members: target.members,
            senderName: myCode,
            guildTag,
            replyTo: replySnapshot,
            ...extraFields
          });
        }
      });
    }
  });
}

// --- Custom Sticker & Meme Maker (Replaces GIF Search) ---
function initMemeMaker() {
  const canvas = document.getElementById('memeCanvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  let loadedImg = null;

  const redrawMeme = () => {
    ctx.fillStyle = '#111827';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (loadedImg) ctx.drawImage(loadedImg, 0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 4;
    ctx.font = 'bold 24px Impact, sans-serif';
    ctx.textAlign = 'center';
    const top = (document.getElementById('memeTopText')?.value || '').toUpperCase();
    const bot = (document.getElementById('memeBottomText')?.value || '').toUpperCase();
    if (top) { ctx.strokeText(top, canvas.width / 2, 32); ctx.fillText(top, canvas.width / 2, 32); }
    if (bot) { ctx.strokeText(bot, canvas.width / 2, canvas.height - 14); ctx.fillText(bot, canvas.width / 2, canvas.height - 14); }
  };

  document.getElementById('memeImageUpload')?.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const img = new Image();
    img.onload = () => { loadedImg = img; redrawMeme(); };
    img.src = URL.createObjectURL(file);
  });
  document.getElementById('memeTopText')?.addEventListener('input', redrawMeme);
  document.getElementById('memeBottomText')?.addEventListener('input', redrawMeme);

  document.getElementById('saveStickerBtn')?.addEventListener('click', () => {
    const dataUrl = canvas.toDataURL('image/webp', 0.75);
    getState(['pulse_stickers'], (res) => {
      const list = res.pulse_stickers || [];
      list.unshift(dataUrl);
      setState({ pulse_stickers: list.slice(0, 24) }, () => alert('🎨 Sticker saved to your Pulse Pro Sticker Tray!'));
    });
  });

  document.getElementById('sendStickerNowBtn')?.addEventListener('click', () => {
    if (!activeTarget) return alert('Select a chat first!');
    const dataUrl = canvas.toDataURL('image/webp', 0.75);
    sendRichMessage(activeTarget, { text: '', image: dataUrl }, activeChannelId);
    document.getElementById('stickerMakerModal').style.display = 'none';
  });
}

// --- Live Collaborative Whiteboard (Replaces Link Previews) ---
function initWhiteboard() {
  const canvas = document.getElementById('whiteboardCanvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  let drawing = false;
  let lastX = 0, lastY = 0;

  const drawSegment = (x1, y1, x2, y2, color, size) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = size;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  };

  canvas.addEventListener('pointerdown', (e) => {
    drawing = true;
    const r = canvas.getBoundingClientRect();
    lastX = e.clientX - r.left;
    lastY = e.clientY - r.top;
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!drawing) return;
    const r = canvas.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    const color = document.getElementById('wbColorPicker').value;
    const size = parseInt(document.getElementById('wbBrushSize').value, 10);
    drawSegment(lastX, lastY, x, y, color, size);

    if (activeTarget) {
      const stroke = { type: 'WB_STROKE', x1: lastX, y1: lastY, x2: x, y2: y, color, size };
      if (activeTarget.type === 'dm') sendPayloadToCode(activeTarget.id, stroke);
      else (activeTarget.members || []).forEach(mc => { if (mc !== myCode) sendPayloadToCode(mc, stroke); });
    }
    lastX = x; lastY = y;
  });

  window.addEventListener('pointerup', () => { drawing = false; });
  document.getElementById('wbClearBtn')?.addEventListener('click', () => ctx.clearRect(0, 0, canvas.width, canvas.height));

  window.drawRemoteStroke = (s) => {
    drawSegment(s.x1, s.y1, s.x2, s.y2, s.color, s.size);
  };
}

// --- Calls, PiP (#52), Camera Switch (#56), Watch Together (#60) & Nerd Stats (#54/#62) ---
function startVoiceOrVideoCall() {
  if (!activeTarget) return;
  playSound(callingAudio);
  getMediaStreamWithFallback((stream) => {
    localStream = stream;
    document.getElementById('localVideo').srcObject = stream;
    document.getElementById('mediaArea').style.display = 'flex';
    startCallTimersAndNerdStats(stream);

    const targets = activeTarget.type === 'dm' ? [activeTarget.id] : (activeTarget.members || []).filter(m => m !== myCode);
    targets.forEach(code => {
      const call = peer.call(`pulse-ws-${code}`, stream);
      currentCall = call;
      call.on('stream', (rem) => {
        stopCallAudio();
        const remVid = document.getElementById('remoteVideo');
        remVid.srcObject = rem;
        document.getElementById('remoteVideoLabel').textContent = code;
      });
      call.on('close', endActiveCall);
    });
  });
}

function startCallTimersAndNerdStats(stream) {
  callSeconds = 0;
  clearInterval(callDurationTimer);
  callDurationTimer = setInterval(() => {
    callSeconds++;
    const el = document.getElementById('callTimerText');
    if (el) el.textContent = `${String(Math.floor(callSeconds / 60)).padStart(2, '0')}:${String(callSeconds % 60).padStart(2, '0')}`;
  }, 1000);

  // Mic Level Meter & WebRTC RTT/Bitrate Stats (#54, #62)
  try {
    const audioCtx = new AudioContext();
    const analyser = audioCtx.createAnalyser();
    const src = audioCtx.createMediaStreamSource(stream);
    src.connect(analyser);
    const dataArr = new Uint8Array(analyser.frequencyBinCount);

    clearInterval(nerdStatsTimer);
    nerdStatsTimer = setInterval(async () => {
      analyser.getByteFrequencyData(dataArr);
      const avg = dataArr.reduce((a, b) => a + b, 0) / dataArr.length;
      const meter = document.getElementById('micLevelMeter');
      if (meter) meter.value = Math.min(100, Math.round(avg * 2));

      if (currentCall && currentCall.peerConnection) {
        const stats = await currentCall.peerConnection.getStats();
        let rtt = '--';
        stats.forEach(report => {
          if (report.type === 'candidate-pair' && report.state === 'succeeded' && report.currentRoundTripTime) {
            rtt = Math.round(report.currentRoundTripTime * 1000);
          }
        });
        const readout = document.getElementById('webrtcStatsReadout');
        if (readout) readout.textContent = `RTT: ${rtt} ms | Duration: ${callSeconds}s | ICE: Connected`;
      }
    }, 800);
  } catch (e) {}
}

function endActiveCall() {
  stopCallAudio();
  stopScreenShare();
  clearInterval(callDurationTimer);
  clearInterval(nerdStatsTimer);
  document.getElementById('mediaArea').style.display = 'none';
  if (localStream) localStream.getTracks().forEach(t => t.stop());
  if (currentCall) try { currentCall.close(); } catch (e) {}
}

function applyRemoteYtSync(payload) {
  const box = document.getElementById('watchTogetherBox');
  const frame = document.getElementById('ytSyncFrame');
  if (!box || !frame) return;
  box.style.display = 'block';
  frame.style.display = 'block';
  frame.src = `https://www.youtube.com/embed/${payload.videoId}?autoplay=1`;
}

// --- Settings, Theme Marketplace (#80) & Custom CSS (#79) ---
function renderThemeMarketplace() {
  const grid = document.getElementById('themeMarketplaceGrid');
  if (!grid) return;
  grid.innerHTML = '';
  MARKETPLACE_THEMES.forEach(t => {
    const card = document.createElement('div');
    card.className = 'setting-row';
    card.style.flexDirection = 'column';
    card.style.alignItems = 'flex-start';
    card.innerHTML = `
      <div><strong>${t.name}</strong> <span style="font-size:0.7rem; color:var(--muted);">by ${t.author}</span></div>
      <div style="font-size:0.75rem; color:var(--muted); margin:4px 0 8px;">${t.desc}</div>
      <button class="btn-success" style="padding:4px 10px; font-size:0.75rem;">Install Theme</button>
    `;
    card.querySelector('button').onclick = () => updateSetting('theme', t.id);
    grid.appendChild(card);
  });
}

function loadSettingsAndTheme() {
  getState(['pulse_settings', 'pulse_custom_css'], (res) => {
    const s = res.pulse_settings || {};
    document.documentElement.setAttribute('data-theme', s.theme || 'discord-dark');
    if (document.getElementById('customUserCss')) {
      document.getElementById('customUserCss').textContent = s.devMode ? (res.pulse_custom_css || '') : '';
    }
    if (document.getElementById('customCssInput')) document.getElementById('customCssInput').value = res.pulse_custom_css || '';
    if (document.getElementById('footerDisplayName')) document.getElementById('footerDisplayName').textContent = s.displayName || 'User';
    if (document.getElementById('footerAvatar')) document.getElementById('footerAvatar').textContent = s.avatarEmoji || '😎';
    if (document.getElementById('footerCustomActivity')) document.getElementById('footerCustomActivity').textContent = s.customActivity || 'Ready to chat';
    if (document.getElementById('quickStatusSelect')) document.getElementById('quickStatusSelect').value = s.status || 'online';

    const tagEl = document.getElementById('footerGuildTag');
    if (tagEl) {
      tagEl.textContent = (s.equippedTag || '').toUpperCase();
      tagEl.style.display = s.equippedTag ? 'inline-block' : 'none';
    }

    const sendBtn = document.getElementById('sendBtn');
    if (sendBtn) sendBtn.style.display = s.showSendBtn === false ? 'none' : 'inline-block';

    const setVal = (id, v) => { const el = document.getElementById(id); if (el && v !== undefined) el.value = v; };
    const setChk = (id, v) => { const el = document.getElementById(id); if (el) el.checked = !!v; };
    setVal('themeSelect', s.theme || 'discord-dark');
    setVal('setDisplayName', s.displayName || '');
    setVal('setAvatarEmoji', s.avatarEmoji || '😎');
    setVal('setCustomActivity', s.customActivity || '');
    setVal('setEquippedTag', s.equippedTag || '');
    setVal('setBirthday', s.birthday || '');
    setVal('setDmFilter', s.dmFilter || 'requests');
    setChk('setShowSendBtn', s.showSendBtn !== false);
    setChk('setAutoEmoji', s.autoEmoji !== false);
    setChk('setAllowTts', s.allowTts !== false);
    setChk('setDevMode', s.devMode);
    setChk('setStreamerMode', s.streamerMode);
  });
}

function updateSetting(key, val) {
  getState(['pulse_settings'], (res) => {
    const s = res.pulse_settings || {};
    s[key] = val;
    setState({ pulse_settings: s }, () => {
      loadSettingsAndTheme();
      broadcastPresence();
      scheduleRefresh(true);
    });
  });
}

// --- Bind All UI Events ---
function bindUIEvents() {
  // Rail Navigation
  document.getElementById('railFriends').onclick = (e) => setActiveRail(e.currentTarget, 'DIRECT MESSAGES', '+ Add', promptAddFriend);
  document.getElementById('railGroups').onclick = (e) => setActiveRail(e.currentTarget, 'GROUP SERVERS', '+ Group', promptCreateGroup);
  document.getElementById('railRequests').onclick = (e) => setActiveRail(e.currentTarget, 'REQUESTS', '', null);
  document.getElementById('railQueue').onclick = (e) => setActiveRail(e.currentTarget, 'OUTBOX QUEUE', 'Retry All', flushOfflineQueue);
  document.getElementById('railStickers').onclick = () => { document.getElementById('stickerMakerModal').style.display = 'flex'; };
  document.getElementById('railWhiteboard').onclick = () => { document.getElementById('whiteboardModal').style.display = 'flex'; };
  document.getElementById('railWhatsNew').onclick = openWhatsNewModal;
  document.getElementById('railShortcuts').onclick = openShortcutsModal;
  document.getElementById('railSettings').onclick = () => { document.getElementById('settingsOverlay').style.display = 'flex'; updateProUI(); };
  document.getElementById('sidebarActionBtn').onclick = promptAddFriend;

  document.getElementById('copyCodeBtn').onclick = () => { navigator.clipboard.writeText(myCode); alert('Copied: ' + myCode); };
  document.getElementById('archiveBtn').onclick = () => archiveOldHistory(true);
  document.getElementById('quickStatusSelect').onchange = (e) => updateSetting('status', e.target.value);

  // PIN Unlock (#77)
  document.getElementById('unlockPinBtn').onclick = () => {
    getState(['pulse_app_pin'], (res) => {
      if (document.getElementById('unlockPinInput').value === res.pulse_app_pin) {
        document.getElementById('pinLockOverlay').style.display = 'none';
      } else {
        alert('Incorrect PIN!');
      }
    });
  };
  document.getElementById('saveAppPinBtn').onclick = () => {
    checkProAccess(({ hasPro }) => {
      if (!hasPro) return alert('⭐ App Lock PIN is a Pulse Pro feature!');
      const pin = document.getElementById('setAppPinInput').value.trim();
      if (pin && pin.length !== 4) return alert('Enter a 4-digit PIN (or leave blank to disable).');
      setState({ pulse_app_pin: pin }, () => alert(pin ? '🔒 App Lock PIN enabled!' : '🔓 App Lock PIN disabled.'));
    });
  };

  // Composer & Attachments (#17, #18, #5, #15, #20)
  document.getElementById('sendBtn').onclick = () => handleSendMessage('msgInput');
  const msgInput = document.getElementById('msgInput');
  msgInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSendMessage('msgInput'); }
  });
  msgInput.addEventListener('input', () => {
    const val = msgInput.value;
    const menu = document.getElementById('slashMenu');
    if (val.startsWith('/')) {
      const matches = SLASH_COMMANDS.filter(c => c.cmd.startsWith(val.toLowerCase()));
      if (matches.length > 0) {
        menu.style.display = 'block';
        menu.innerHTML = matches.map(m => `<div class="slash-item" data-cmd="${m.cmd}"><strong>${m.cmd}</strong> — <span style="opacity:0.8;">${m.desc}</span></div>`).join('');
        menu.querySelectorAll('.slash-item').forEach(el => {
          el.onclick = () => { msgInput.value = el.dataset.cmd; menu.style.display = 'none'; msgInput.focus(); };
        });
      } else menu.style.display = 'none';
    } else menu.style.display = 'none';
  });

  // Clipboard Image Paste (#18)
  msgInput.addEventListener('paste', (e) => {
    const items = e.clipboardData?.items || [];
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile();
        const reader = new FileReader();
        reader.onload = () => { if (activeTarget) sendRichMessage(activeTarget, { text: '', image: reader.result }, activeChannelId); };
        reader.readAsDataURL(file);
      }
    }
  });

  // File / Image Attachment (#17)
  document.getElementById('fileAttachInput').onchange = (e) => {
    const file = e.target.files[0];
    if (!file || !activeTarget) return;
    if (file.size > 3000000) return alert('Please keep P2P files under 3 MB.');
    const reader = new FileReader();
    reader.onload = () => {
      if (file.type.startsWith('image/')) sendRichMessage(activeTarget, { text: '', image: reader.result }, activeChannelId);
      else sendRichMessage(activeTarget, { text: '', fileName: file.name, fileData: reader.result }, activeChannelId);
    };
    reader.readAsDataURL(file);
  };

  // Pulse Pro Emoji & Sticker Picker (#5)
  document.getElementById('emojiPickerBtn').onclick = () => {
    checkProAccess(({ hasPro }) => {
      document.getElementById('proEmojiLockNotice').style.display = hasPro ? 'none' : 'block';
      const grid = document.getElementById('emojiGridBox');
      grid.innerHTML = '';
      EMOJI_LIST.forEach((em, idx) => {
        const span = document.createElement('span');
        span.style.cursor = 'pointer';
        span.textContent = (!hasPro && idx >= 8) ? '🔒' : em;
        span.onclick = () => {
          if (!hasPro && idx >= 8) return alert('⭐ Upgrade to Pulse Pro (or 3-Day Trial) for the full Emoji & Sticker Tray!');
          msgInput.value += em;
          document.getElementById('emojiStickerModal').style.display = 'none';
          msgInput.focus();
        };
        grid.appendChild(span);
      });

      getState(['pulse_stickers'], (res) => {
        const sGrid = document.getElementById('savedStickersGrid');
        sGrid.innerHTML = '';
        (res.pulse_stickers || []).forEach(dataUrl => {
          const img = document.createElement('img');
          img.src = dataUrl;
          img.style.cssText = 'width:100%; border-radius:8px; cursor:pointer; border:1px solid var(--border);';
          img.onclick = () => {
            if (!hasPro) return alert('⭐ Custom Stickers require Pulse Pro!');
            if (activeTarget) sendRichMessage(activeTarget, { text: '', image: dataUrl }, activeChannelId);
            document.getElementById('emojiStickerModal').style.display = 'none';
          };
          sGrid.appendChild(img);
        });
      });

      document.getElementById('emojiStickerModal').style.display = 'flex';
    });
  };

  // Schedule Message (#15) & Poll Button (#20)
  document.getElementById('scheduleMsgBtn').onclick = () => {
    if (!activeTarget) return;
    const text = prompt('Message text to schedule:');
    if (!text) return;
    const mins = parseInt(prompt('Send in how many minutes?', '5') || '0', 10);
    if (mins > 0) {
      getState(['pulse_scheduled'], (res) => {
        const list = res.pulse_scheduled || [];
        list.push({ target: activeTarget, text, channelId: activeChannelId, sendAt: Date.now() + mins * 60000 });
        setState({ pulse_scheduled: list }, () => alert(`⏰ Scheduled to send in ${mins} minute(s)!`));
      });
    }
  };

  document.getElementById('createPollBtn').onclick = () => {
    if (!activeTarget) return;
    const q = prompt('Poll Question:');
    if (!q) return;
    const opts = (prompt('Options separated by commas (e.g. Yes, No, Maybe):') || '').split(',').map(s => s.trim()).filter(Boolean);
    if (opts.length >= 2) {
      sendRichMessage(activeTarget, { text: '', poll: { question: q, options: opts.map(label => ({ label, votes: [] })) } }, activeChannelId);
    }
  };

  document.getElementById('cancelReplyBtn').onclick = () => {
    replyingToMsg = null;
    document.getElementById('replyPreviewBar').style.display = 'none';
  };
  document.getElementById('unpinMsgBtn').onclick = () => {
    const key = getActiveHistoryKey();
    if (key) setPinnedMessage(key, null, true);
  };

  // Split Screen (#85), Friend Info (#28/#29/#36), Member Drawer (#44)
  document.getElementById('splitScreenBtn').onclick = () => {
    if (!activeTarget) return;
    splitTarget = { ...activeTarget };
    document.getElementById('splitChatPane').style.display = 'flex';
    scheduleRefresh(true);
  };
  document.getElementById('closeSplitBtn').onclick = () => {
    splitTarget = null;
    document.getElementById('splitChatPane').style.display = 'none';
  };
  document.getElementById('splitSendBtn').onclick = () => handleSendMessage('splitMsgInput', splitTarget);

  document.getElementById('profileInspectBtn').onclick = () => {
    if (!activeTarget || activeTarget.type !== 'dm') return;
    getState(['pulse_friend_meta', 'pulse_groups'], (res) => {
      const meta = (res.pulse_friend_meta || {})[activeTarget.id] || {};
      document.getElementById('friendInfoTitle').textContent = `👤 ${activeTarget.name} (${activeTarget.id})`;
      document.getElementById('friendCustomNick').value = meta.nickname || '';
      document.getElementById('friendPrivateNote').value = meta.note || '';
      document.getElementById('friendMuteToggle').checked = !!meta.muted;
      const mutuals = (res.pulse_groups || []).filter(g => (g.members || []).includes(activeTarget.id)).map(g => g.name);
      document.getElementById('friendMutualGroups').textContent = mutuals.length ? mutuals.join(', ') : 'None';
      document.getElementById('friendInfoModal').style.display = 'flex';
    });
  };
  document.getElementById('saveFriendInfoBtn').onclick = () => {
    if (!activeTarget) return;
    getState(['pulse_friend_meta'], (res) => {
      const all = res.pulse_friend_meta || {};
      all[activeTarget.id] = {
        nickname: document.getElementById('friendCustomNick').value.trim(),
        note: document.getElementById('friendPrivateNote').value.trim(),
        muted: document.getElementById('friendMuteToggle').checked
      };
      setState({ pulse_friend_meta: all }, () => {
        document.getElementById('friendInfoModal').style.display = 'none';
        scheduleRefresh(true);
      });
    });
  };

  document.getElementById('toggleMembersBtn').onclick = () => {
    const drawer = document.getElementById('groupMemberDrawer');
    if (drawer.style.display === 'flex') { drawer.style.display = 'none'; return; }
    drawer.style.display = 'flex';
    drawer.innerHTML = '<strong>MEMBERS</strong>';
    (activeTarget?.members || []).forEach(mc => {
      const online = mc === myCode || !!liveConns[mc]?.open;
      const row = document.createElement('div');
      row.style.fontSize = '0.8rem';
      row.innerHTML = `<span style="color:${online ? '#10b981' : '#64748b'};">●</span> ${mc}`;
      drawer.appendChild(row);
    });
  };

  // Group Settings & Channels (#40, #41, #42, #49, #50, #97)
  document.getElementById('addGroupMemberBtn').onclick = openGroupMemberAdder;
  document.getElementById('headerBoostBtn').onclick = () => boostActiveGroup(1);
  document.getElementById('boostThisGroupBtn').onclick = () => boostActiveGroup(1);
  document.getElementById('unboostThisGroupBtn').onclick = () => boostActiveGroup(-1);
  document.getElementById('groupSettingsBtn').onclick = openGroupSettingsDrawer;

  document.querySelectorAll('.grp-tab').forEach(tab => {
    tab.onclick = () => {
      document.querySelectorAll('.grp-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.grp-section').forEach(s => s.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById(`gsec-${tab.dataset.gsec}`).classList.add('active');
    };
  });

  document.getElementById('saveGrpProfileBtn').onclick = () => {
    getState(['pulse_groups'], (res) => {
      const groups = res.pulse_groups || [];
      const grp = groups.find(g => g.id === activeTarget?.id);
      if (!grp) return;
      grp.name = document.getElementById('grpEditName').value.trim() || grp.name;
      grp.icon = document.getElementById('grpEditIcon').value.trim() || '#';
      grp.slowmodeSec = parseInt(document.getElementById('grpSlowmodeSec').value || '0', 10);
      grp.welcomeMsg = document.getElementById('grpWelcomeMsg').value.trim();
      setState({ pulse_groups: groups }, () => { alert('✅ Server Overview Saved!'); scheduleRefresh(true); });
    });
  };

  document.getElementById('addChannelBtn').onclick = () => {
    const name = document.getElementById('newChannelName').value.trim().toLowerCase().replace(/\s+/g, '-');
    const type = document.getElementById('newChannelType').value;
    if (!name) return;
    getState(['pulse_groups'], (res) => {
      const groups = res.pulse_groups || [];
      const grp = groups.find(g => g.id === activeTarget?.id);
      if (!grp) return;
      if (!grp.channels) grp.channels = [{ id: 'general', name: 'general', type: 'text' }];
      grp.channels.push({ id: 'ch-' + Date.now(), name, type });
      document.getElementById('newChannelName').value = '';
      setState({ pulse_groups: groups }, () => { openGroupSettingsDrawer(); scheduleRefresh(true); });
    });
  };

  document.getElementById('addRoleBtn').onclick = () => {
    const name = document.getElementById('newRoleName').value.trim();
    const color = document.getElementById('newRoleColor').value;
    const perm = document.getElementById('newRolePerm').value;
    if (!name) return;
    getState(['pulse_groups'], (res) => {
      const groups = res.pulse_groups || [];
      const grp = groups.find(g => g.id === activeTarget?.id);
      if (!grp) return;
      if (!grp.roles) grp.roles = [];
      grp.roles.push({ name, color, perm });
      document.getElementById('newRoleName').value = '';
      setState({ pulse_groups: groups }, openGroupSettingsDrawer);
    });
  };

  document.getElementById('saveAutoModBtn').onclick = () => {
    getState(['pulse_groups'], (res) => {
      const groups = res.pulse_groups || [];
      const grp = groups.find(g => g.id === activeTarget?.id);
      if (!grp) return;
      grp.autoModWords = document.getElementById('grpAutoModWords').value.split(',').map(w => w.trim()).filter(Boolean);
      grp.notifOverride = document.getElementById('grpNotifOverride').value;
      setState({ pulse_groups: groups }, () => alert('🛡️ Safety & Notification Rules Saved!'));
    });
  };

  document.getElementById('leaveGroupBtn').onclick = () => {
    if (!activeTarget || !confirm('Leave this group server?')) return;
    getState(['pulse_groups'], (res) => {
      const groups = (res.pulse_groups || []).filter(g => g.id !== activeTarget.id);
      activeTarget = null;
      document.getElementById('groupSettingsOverlay').style.display = 'none';
      setState({ pulse_groups: groups }, () => scheduleRefresh(true));
    });
  };

  document.getElementById('deleteGroupServerBtn').onclick = () => {
    if (!activeTarget || !confirm('Permanently delete this server?')) return;
    getState(['pulse_groups'], (res) => {
      const groups = (res.pulse_groups || []).filter(g => g.id !== activeTarget.id);
      activeTarget = null;
      document.getElementById('groupSettingsOverlay').style.display = 'none';
      setState({ pulse_groups: groups }, () => scheduleRefresh(true));
    });
  };

  // Call Controls (#52 PiP, #54 Nerd Stats, #55 Vol, #56 Switch Cam, #60 Watch Together)
  document.getElementById('wsCallBtn').onclick = startVoiceOrVideoCall;
  document.getElementById('endCallBtn').onclick = endActiveCall;
  document.getElementById('shareScreenBtn').onclick = toggleScreenShare;
  document.getElementById('muteMicBtn').onclick = (e) => {
    isMuted = !isMuted;
    if (localStream) localStream.getAudioTracks().forEach(t => t.enabled = !isMuted);
    e.target.textContent = isMuted ? '🔇 Unmute' : '🎙️ Mute';
  };
  document.getElementById('pipCallBtn').onclick = async () => {
    const vid = document.getElementById('remoteVideo');
    if (vid && document.pictureInPictureEnabled) await vid.requestPictureInPicture().catch(() => {});
  };
  document.getElementById('switchCamBtn').onclick = async () => {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cams = devices.filter(d => d.kind === 'videoinput');
    if (cams.length < 2) return alert('Only 1 camera detected.');
    currentCamIndex = (currentCamIndex + 1) % cams.length;
    const newStream = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: cams[currentCamIndex].deviceId } } });
    const newTrack = newStream.getVideoTracks()[0];
    document.getElementById('localVideo').srcObject = newStream;
    if (currentCall?.peerConnection) {
      const sender = currentCall.peerConnection.getSenders().find(s => s.track?.kind === 'video');
      if (sender) sender.replaceTrack(newTrack);
    }
  };
  document.getElementById('peerCallVolSlider').oninput = (e) => {
    const vid = document.getElementById('remoteVideo');
    if (vid) vid.volume = Math.min(1, parseFloat(e.target.value));
  };
  document.getElementById('toggleNerdStatsBtn').onclick = () => {
    const p = document.getElementById('nerdStatsPanel');
    p.style.display = p.style.display === 'block' ? 'none' : 'block';
  };
  document.getElementById('toggleWatchBtn').onclick = () => {
    const b = document.getElementById('watchTogetherBox');
    b.style.display = b.style.display === 'block' ? 'none' : 'block';
  };
  document.getElementById('loadYtSyncBtn').onclick = () => {
    const url = document.getElementById('ytSyncUrlInput').value.trim();
    const match = url.match(/(?:v=|youtu\.be\/)([A-Za-z0-9_-]{11})/);
    if (!match) return alert('Paste a valid YouTube link!');
    const payload = { type: 'YT_SYNC', videoId: match[1] };
    applyRemoteYtSync(payload);
    if (activeTarget?.type === 'dm') sendPayloadToCode(activeTarget.id, payload);
    else (activeTarget?.members || []).forEach(mc => { if (mc !== myCode) sendPayloadToCode(mc, payload); });
  };
  document.getElementById('closeYtSyncBtn').onclick = () => { document.getElementById('watchTogetherBox').style.display = 'none'; };

  document.getElementById('acceptCallBtn').onclick = () => {
    stopCallAudio();
    document.getElementById('callModal').style.display = 'none';
    if (!currentCall) return;
    getMediaStreamWithFallback((stream) => {
      localStream = stream;
      document.getElementById('localVideo').srcObject = stream;
      document.getElementById('mediaArea').style.display = 'flex';
      startCallTimersAndNerdStats(stream);
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

  // User Settings & Custom CSS (#79)
  document.querySelectorAll('.settings-tab').forEach(tab => {
    tab.onclick = () => {
      document.querySelectorAll('.settings-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.settings-section').forEach(s => s.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById(`sec-${tab.dataset.sec}`).classList.add('active');
    };
  });

  document.getElementById('applyCustomCssBtn').onclick = () => {
    getState(['pulse_settings'], (res) => {
      if (!(res.pulse_settings || {}).devMode) return alert('Enable Developer Mode above first!');
      const css = document.getElementById('customCssInput').value;
      setState({ pulse_custom_css: css }, () => { loadSettingsAndTheme(); alert('🎨 Custom CSS Applied!'); });
    });
  };

  document.getElementById('subMonthlyBtn').onclick = () => {
    setState({ pulse_pro_sub: { active: true, plan: 'Monthly', expiresAt: Date.now() + 30 * 86400000 } }, () => { updateProUI(); alert('⭐ Pulse Pro Monthly Activated!'); });
  };
  document.getElementById('subYearlyBtn').onclick = () => {
    setState({ pulse_pro_sub: { active: true, plan: 'Yearly', expiresAt: Date.now() + 365 * 86400000 } }, () => { updateProUI(); alert('⭐ Pulse Pro Yearly Activated!'); });
  };
  document.getElementById('redeemCodeBtn').onclick = () => {
    const code = document.getElementById('giftCodeInput').value.trim().toUpperCase();
    if (VALID_GIFT_CODES.includes(code)) {
      setState({ pulse_pro_permanent: true }, () => { updateProUI(); alert('🎉 Lifetime Pulse Pro Unlocked!'); });
    } else alert('Invalid Gift Code.');
  };

  const bindVal = (id, key) => { const el = document.getElementById(id); if (el) el.onchange = (e) => updateSetting(key, e.target.value); };
  const bindChk = (id, key) => { const el = document.getElementById(id); if (el) el.onchange = (e) => updateSetting(key, e.target.checked); };
  bindVal('themeSelect', 'theme');
  bindVal('setDisplayName', 'displayName');
  bindVal('setAvatarEmoji', 'avatarEmoji');
  bindVal('setCustomActivity', 'customActivity');
  bindVal('setEquippedTag', 'equippedTag');
  bindVal('setBirthday', 'birthday');
  bindVal('setDmFilter', 'dmFilter');
  bindVal('micDeviceSelect', 'micDeviceId');
  bindChk('setShowSendBtn', 'showSendBtn');
  bindChk('setAutoEmoji', 'autoEmoji');
  bindChk('setAllowTts', 'allowTts');
  bindChk('setDevMode', 'devMode');
  bindChk('setStreamerMode', 'streamerMode');
  bindChk('setEcho', 'echo');
  bindChk('setNoise', 'noise');

  // Close Modals
  const closeMap = {
    closeSettingsBtn: 'settingsOverlay',
    closeGroupSettingsBtn: 'groupSettingsOverlay',
    closeGroupMemberModal: 'groupMemberModal',
    closeEmojiStickerModal: 'emojiStickerModal',
    closeStickerMakerModal: 'stickerMakerModal',
    closeWhiteboardModal: 'whiteboardModal',
    closeFriendInfoModal: 'friendInfoModal',
    closeInfoListModal: 'infoListModal'
  };
  Object.entries(closeMap).forEach(([btnId, modalId]) => {
    document.getElementById(btnId)?.addEventListener('click', () => { document.getElementById(modalId).style.display = 'none'; });
  });
}

function setActiveRail(btn, title, actionText, actionFn) {
  document.querySelectorAll('.rail-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById('sidebarTitle').textContent = title;
  const actBtn = document.getElementById('sidebarActionBtn');
  if (actionText) { actBtn.style.display = 'inline-block'; actBtn.textContent = actionText; actBtn.onclick = actionFn; }
  else actBtn.style.display = 'none';
  scheduleRefresh(true);
}

function openGroupMemberAdder() {
  if (!activeTarget || activeTarget.type !== 'group') return;
  getState(['pulse_friends', 'pulse_groups'], (res) => {
    const friends = res.pulse_friends || [];
    const groups = res.pulse_groups || [];
    const grp = groups.find(g => g.id === activeTarget.id);
    const list = document.getElementById('groupFriendPickerList');
    list.innerHTML = '';
    friends.forEach(f => {
      const added = (grp?.members || []).includes(f.code);
      const row = document.createElement('div');
      row.className = 'list-card';
      row.innerHTML = `<span><strong>${f.name}</strong> (${f.code})</span><button class="${added ? 'btn-sec' : 'btn-success'}" ${added ? 'disabled' : ''}>${added ? '✓ Added' : '+ Add'}</button>`;
      if (!added) {
        row.querySelector('button').onclick = () => {
          grp.members.push(f.code);
          activeTarget.members = grp.members;
          setState({ pulse_groups: groups }, () => {
            grp.members.forEach(mc => { if (mc !== myCode) sendPayloadToCode(mc, { type: 'GROUP_INVITE_SYNC', group: grp }); });
            openGroupMemberAdder();
            scheduleRefresh(true);
          });
        };
      }
      list.appendChild(row);
    });
    document.getElementById('groupMemberModal').style.display = 'flex';
  });
}

function openGroupSettingsDrawer() {
  if (!activeTarget || activeTarget.type !== 'group') return;
  getState(['pulse_groups'], (res) => {
    const groups = res.pulse_groups || [];
    const grp = groups.find(g => g.id === activeTarget.id);
    if (!grp) return;

    document.getElementById('grpDrawerTitle').textContent = `${grp.name.toUpperCase()} — SERVER SETTINGS`;
    document.getElementById('grpEditName').value = grp.name || '';
    document.getElementById('grpEditIcon').value = grp.icon || '#';
    document.getElementById('grpSlowmodeSec').value = grp.slowmodeSec || 0;
    document.getElementById('grpWelcomeMsg').value = grp.welcomeMsg || '';
    document.getElementById('grpAutoModWords').value = (grp.autoModWords || []).join(', ');
    document.getElementById('grpNotifOverride').value = grp.notifOverride || 'all';

    const boosts = grp.boosts || 0;
    const bInfo = getGroupBoostLevel(boosts);
    document.getElementById('grpBoostSummaryTitle').textContent = `Server Level ${bInfo.level} (${boosts} Boosts)`;

    const chList = document.getElementById('grpChannelsList');
    chList.innerHTML = '';
    (grp.channels || [{ id: 'general', name: 'general', type: 'text' }]).forEach((ch, idx) => {
      const r = document.createElement('div');
      r.className = 'setting-row';
      r.innerHTML = `<span>#${ch.name} (${ch.type})</span>${idx > 0 ? `<button class="btn-danger" style="padding:3px 7px;">Delete</button>` : ''}`;
      r.querySelector('button')?.addEventListener('click', () => {
        grp.channels.splice(idx, 1);
        setState({ pulse_groups: groups }, () => { openGroupSettingsDrawer(); scheduleRefresh(true); });
      });
      chList.appendChild(r);
    });

    const rolesList = document.getElementById('grpRolesList');
    rolesList.innerHTML = '';
    (grp.roles || []).forEach((role, idx) => {
      const r = document.createElement('div');
      r.className = 'setting-row';
      r.innerHTML = `<span style="color:${role.color}; font-weight:800;">● ${role.name} (${role.perm})</span><button class="btn-danger" style="padding:3px 7px;">Delete</button>`;
      r.querySelector('button').onclick = () => {
        grp.roles.splice(idx, 1);
        setState({ pulse_groups: groups }, openGroupSettingsDrawer);
      };
      rolesList.appendChild(r);
    });

    const memList = document.getElementById('grpMemberManageList');
    memList.innerHTML = '';
    (grp.members || []).forEach(mc => {
      const r = document.createElement('div');
      r.className = 'setting-row';
      r.innerHTML = `<span><strong>${mc}</strong></span>${mc !== myCode ? `<button class="btn-danger" style="padding:3px 7px;">Kick</button>` : '<span>You</span>'}`;
      r.querySelector('button')?.addEventListener('click', () => {
        grp.members = grp.members.filter(m => m !== mc);
        setState({ pulse_groups: groups }, () => { openGroupSettingsDrawer(); scheduleRefresh(true); });
      });
      memList.appendChild(r);
    });

    document.getElementById('groupSettingsOverlay').style.display = 'flex';
  });
}

function promptAddFriend() {
  const code = prompt('Enter friend\'s 4-Digit Peer Code:');
  if (!code) return;
  const clean = code.trim().toUpperCase();
  const name = prompt(`Nickname for ${clean}:`) || clean;
  getState(['pulse_friends', 'pulse_blocked'], (res) => {
    const friends = res.pulse_friends || [];
    const blocked = (res.pulse_blocked || []).filter(b => b !== clean);
    if (!friends.some(f => f.code === clean)) {
      friends.push({ code: clean, name });
      setState({ pulse_friends: friends, pulse_blocked: blocked }, () => { connectToCode(clean); scheduleRefresh(true); });
    }
  });
}

function promptCreateGroup() {
  const name = prompt('Enter New Group Server Name:');
  if (!name) return;
  const newGrp = {
    id: 'grp-' + Date.now(),
    name: name.trim(),
    members: [myCode],
    admin: myCode,
    boosts: 0,
    channels: [{ id: 'general', name: 'general', type: 'text' }],
    roles: [{ name: 'Owner', color: '#f59e0b', perm: 'admin' }]
  };
  getState(['pulse_groups'], (res) => {
    const groups = res.pulse_groups || [];
    groups.push(newGrp);
    activeTarget = { type: 'group', id: newGrp.id, name: newGrp.name, members: newGrp.members, admin: myCode };
    setState({ pulse_groups: groups }, () => { scheduleRefresh(true); openGroupMemberAdder(); });
  });
}