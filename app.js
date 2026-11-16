const IS_POPUP = !!document.getElementById('friendsList') && !document.getElementById('railFriends');
const IS_WEB_HOSTED = window.location.protocol.startsWith('http');
const URL_PARAMS = new URLSearchParams(window.location.search);
const EXT_ID = URL_PARAMS.get('extId') || localStorage.getItem('pulse_ext_id') || '';
if (URL_PARAMS.get('extId')) localStorage.setItem('pulse_ext_id', URL_PARAMS.get('extId'));

const syncChannel = new BroadcastChannel('pulse_chat_v11_sync');

let peer = null;
let myCode = '';
let activeTarget = null;
let liveConns = {};
let connectingLocks = {};
let currentCall = null;
let localStream = null;
let typingTimeout = null;
let isMuted = false;
let renderTimer = null;
let lastRenderSignature = '';
let logoClickCount = 0;

const VALID_GIFT_CODES = [
  'PULSE-PRO-9X4K-2026',
  'PULSE-VIP-7M2P-8841',
  'PULSE-GOLD-5T9W-3310',
  'PULSE-APEX-3R8L-6492',
  'PULSE-ULTRA-1Q6Z-9075'
];

const BANNED_PHRASES = ['67', '6-7', '6 7'];
const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;
let screenShareTimer = null;
let screenStream = null;

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
      if (manual) alert(`☁️ Cloud Sync Complete! Archived ${archivedCount} older messages safely.`);
      scheduleRefresh(true);
    });
  });
}

function removeFriendAndRecords(targetCode, alsoBlock = false) {
  const code = targetCode.trim().toUpperCase();
  getState(['pulse_friends', 'pulse_history', 'pulse_requests', 'pulse_outbox', 'pulse_pending_inbox', 'pulse_blocked'], (res) => {
    const friends = (res.pulse_friends || []).filter(f => f.code !== code);
    const requests = (res.pulse_requests || []).filter(r => r.code !== code);
    const outbox = (res.pulse_outbox || []).filter(o => o.targetCode !== code);
    const pending = (res.pulse_pending_inbox || []).filter(p => p.senderCode !== code);
    const blocked = res.pulse_blocked || [];
    const history = res.pulse_history || {};
    delete history[code];

    if (alsoBlock && !blocked.includes(code)) blocked.push(code);

    if (liveConns[code]) {
      try { liveConns[code].close(); } catch (e) {}
      delete liveConns[code];
    }

    if (activeTarget && activeTarget.id === code) activeTarget = null;

    setState({
      pulse_friends: friends,
      pulse_history: history,
      pulse_requests: requests,
      pulse_outbox: outbox,
      pulse_pending_inbox: pending,
      pulse_blocked: blocked
    }, () => scheduleRefresh(true));
  });
}

// --- Pulse Pro Subscription & Included Boosts ---
function checkProAccess(cb) {
  getState(['pulse_pro_permanent', 'pulse_pro_sub', 'pulse_trial_start', 'pulse_boost_allocations'], (res) => {
    const allocations = res.pulse_boost_allocations || {};
    const usedBoosts = Object.values(allocations).reduce((a, b) => a + b, 0);

    if (res.pulse_pro_permanent) {
      cb({
        hasPro: true,
        plan: 'Lifetime Gift Pro',
        statusText: 'Pulse Pro Active (Lifetime Gift Code)',
        renewalText: 'Never expires • 2 Group Boosts included',
        isTrial: false,
        totalBoosts: 2,
        availableBoosts: Math.max(0, 2 - usedBoosts)
      });
      return;
    }

    const sub = res.pulse_pro_sub;
    if (sub && sub.active && sub.expiresAt > Date.now()) {
      const renewDate = new Date(sub.expiresAt).toLocaleDateString();
      cb({
        hasPro: true,
        plan: sub.plan,
        statusText: `Pulse Pro ${sub.plan === 'yearly' ? 'Yearly' : 'Monthly'} Subscription Active`,
        renewalText: `Next renewal: ${renewDate} • 2 Group Boosts included`,
        isTrial: false,
        totalBoosts: 2,
        availableBoosts: Math.max(0, 2 - usedBoosts)
      });
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
      cb({
        hasPro: true,
        plan: 'trial',
        statusText: `3-Day Free Trial Active (${hoursLeft} hours remaining)`,
        renewalText: 'Subscribe to Monthly or Yearly to keep Pro & 2 Group Boosts',
        isTrial: true,
        totalBoosts: 2,
        availableBoosts: Math.max(0, 2 - usedBoosts)
      });
    } else {
      cb({
        hasPro: false,
        plan: 'free',
        statusText: 'Free Tier — Subscribe to Pulse Pro or redeem a Gift Code',
        renewalText: 'No active subscription',
        isTrial: false,
        totalBoosts: 0,
        availableBoosts: 0
      });
    }
  });
}

function updateProUI() {
  checkProAccess(({ hasPro, plan, statusText, renewalText, isTrial, totalBoosts, availableBoosts }) => {
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
    const renewEl = document.getElementById('proRenewalDateText');
    const pillEl = document.getElementById('proStatusPill');
    const boostInvEl = document.getElementById('userBoostInventoryText');
    const cancelRow = document.getElementById('cancelSubRow');

    if (descEl) descEl.textContent = statusText;
    if (renewEl) renewEl.textContent = renewalText;
    if (pillEl) pillEl.textContent = hasPro ? (isTrial ? '3-DAY TRIAL' : 'PULSE PRO') : 'FREE TIER';
    if (boostInvEl) boostInvEl.textContent = `${availableBoosts} / ${totalBoosts} Group Boosts Available`;
    if (cancelRow) cancelRow.style.display = (plan === 'monthly' || plan === 'yearly') ? 'flex' : 'none';

    document.getElementById('planMonthlyCard')?.classList.toggle('selected', plan === 'monthly');
    document.getElementById('planYearlyCard')?.classList.toggle('selected', plan === 'yearly');

    document.querySelectorAll('.pro-gate').forEach(gate => {
      gate.style.display = hasPro ? 'none' : 'flex';
    });

    renderSoundboardSettings(hasPro);
    renderCallSoundboard(hasPro);
  });
}

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

      if (isLocked) {
        row.innerHTML = `
          <div><strong>Slot ${i + 1} (Pulse Pro Exclusive)</strong><div style="font-size:0.78rem; color:#fbbf24;">Requires Pulse Pro Subscription</div></div>
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
        if (file.size > 1500000) return alert('Please keep sound files under 1.5 MB.');
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

// --- Group Boosts & Level Helper ---
function getGroupBoostLevel(boostCount) {
  if (boostCount >= 14) return { level: 3, nextGoal: 14, audio: '384 kbps', upload: '100 MB', stream: '1080p 60fps' };
  if (boostCount >= 7) return { level: 2, nextGoal: 14, audio: '256 kbps', upload: '50 MB', stream: '1080p 60fps' };
  if (boostCount >= 2) return { level: 1, nextGoal: 7, audio: '128 kbps', upload: '10 MB', stream: '720p 60fps' };
  return { level: 0, nextGoal: 2, audio: '96 kbps', upload: '10 MB', stream: '720p 30fps' };
}

function addAuditEntry(group, text) {
  if (!group.auditLog) group.auditLog = [];
  group.auditLog.unshift({ time: Date.now(), actor: myCode, text });
  if (group.auditLog.length > 50) group.auditLog.pop();
}

function boostActiveGroup(delta) {
  if (!activeTarget || activeTarget.type !== 'group') return;
  checkProAccess(({ hasPro, availableBoosts }) => {
    if (!hasPro) {
      alert('⭐ Subscribe to Pulse Pro (or activate the 3-day trial) to get 2 Group Boosts!');
      return;
    }
    getState(['pulse_groups', 'pulse_boost_allocations'], (res) => {
      const groups = res.pulse_groups || [];
      const allocations = res.pulse_boost_allocations || {};
      const grp = groups.find(g => g.id === activeTarget.id);
      if (!grp) return;

      const currentUserAlloc = allocations[grp.id] || 0;
      if (delta > 0) {
        if (availableBoosts <= 0) return alert('You have used all 2 of your included Group Boosts! Remove a boost from another group or upgrade.');
        allocations[grp.id] = currentUserAlloc + 1;
        grp.boosts = (grp.boosts || 0) + 1;
        addAuditEntry(grp, `boosted the server (+1 Boost → ${grp.boosts} total)`);
      } else {
        if (currentUserAlloc <= 0) return alert('You have no active boosts on this server to remove.');
        allocations[grp.id] = currentUserAlloc - 1;
        grp.boosts = Math.max(0, (grp.boosts || 0) - 1);
        addAuditEntry(grp, `removed a server boost (-1 Boost)`);
      }

      setState({ pulse_groups: groups, pulse_boost_allocations: allocations }, () => {
        (grp.members || []).forEach(mc => {
          if (mc !== myCode) sendPayloadToCode(mc, { type: 'GROUP_INVITE_SYNC', group: grp });
        });
        updateProUI();
        if (document.getElementById('groupSettingsOverlay')?.style.display === 'flex') openGroupSettingsDrawer();
        scheduleRefresh(true);
      });
    });
  });
}

// --- Text-to-Speech Helper ---
function speakText(text) {
  if (!('speechSynthesis' in window)) return;
  getState(['pulse_settings'], (res) => {
    const s = res.pulse_settings || {};
    if (s.allowTts === false) return;
    const utter = new SpeechSynthesisUtterance(text);
    utter.rate = parseFloat(s.ttsRate || '1.0');
    window.speechSynthesis.speak(utter);
  });
}

// --- Easter Eggs Engine ---
function initEasterEggs() {
  const konami = ['ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight', 'b', 'a'];
  let konamiIdx = 0;
  document.addEventListener('keydown', (e) => {
    if (e.key.toLowerCase() === konami[konamiIdx].toLowerCase()) {
      konamiIdx++;
      if (konamiIdx === konami.length) {
        konamiIdx = 0;
        updateSetting('theme', 'matrix');
        alert('🕶️ EASTER EGG UNLOCKED: Matrix Hacker Theme Activated!');
      }
    } else {
      konamiIdx = 0;
    }
  });

  const brand = document.getElementById('brandLogo');
  if (brand) {
    brand.onclick = () => {
      logoClickCount++;
      if (logoClickCount === 7) {
        logoClickCount = 0;
        alert('🎉 SECRET FOUND! You discovered the Pulse v11.0 Developer Easter Egg! Try /party, /flip, /matrix, or /tts in chat!');
      }
    };
  }

  const hr = new Date().getHours();
  if (hr >= 0 && hr <= 3 && document.getElementById('owlBanner')) {
    document.getElementById('owlBanner').textContent = '🦉 Night Owl Mode Active';
  }
}

// --- Initialization & Fast Cross-Tab Sync ---
function scheduleRefresh(force = false) {
  if (renderTimer) cancelAnimationFrame(renderTimer);
  renderTimer = requestAnimationFrame(() => refreshAllViews(force));
}

document.addEventListener('DOMContentLoaded', () => {
  loadSettingsAndTheme();
  updateProUI();
  initPeerNetwork();
  bindUIEvents();
  initEasterEggs();
  deliverPendingInbox();
  checkWeeklyScreenQuota();
  populateMicrophones();
  scheduleRefresh(true);

  // Clean heartbeat: check dead connections every 12s & flush outbox every 1.5s
  setInterval(() => {
    if (peer && peer.disconnected && !peer.destroyed) {
      try { peer.reconnect(); } catch (e) {}
    }
    connectToAllFriends();
  }, 12000);
  setInterval(flushOfflineQueue, 1500);

  syncChannel.onmessage = () => {
    loadSettingsAndTheme();
    updateProUI();
    scheduleRefresh(true);
  };

  if (!IS_WEB_HOSTED && chrome?.storage?.onChanged) {
    chrome.storage.onChanged.addListener((changes) => {
      if (changes.pulse_settings) loadSettingsAndTheme();
      if (changes.pulse_pro_permanent || changes.pulse_pro_sub || changes.pulse_trial_start || changes.pulse_boost_allocations) updateProUI();
      if (changes.pulse_pending_inbox) deliverPendingInbox();
      if (changes.pulse_friends || changes.pulse_groups || changes.pulse_requests || changes.pulse_history) {
        scheduleRefresh(true);
        flushOfflineQueue();
      }
    });
  } else {
    setInterval(() => {
      deliverPendingInbox();
      scheduleRefresh(false);
    }, 3000);
  }
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
      if (document.getElementById('screenTimeLeft')) document.getElementById('screenTimeLeft').textContent = `${mins}:${secs}`;
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

// --- Low-Latency P2P Engine (STUN + TURN Relay + Single-Tunnel Deduplication) ---
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
          {
            urls: 'turn:openrelay.metered.ca:80',
            username: 'openrelayproject',
            credential: 'openrelayproject'
          },
          {
            urls: 'turn:openrelay.metered.ca:443',
            username: 'openrelayproject',
            credential: 'openrelayproject'
          }
        ],
        iceCandidatePoolSize: 2
      }
    });

    peer.on('open', () => {
      if (document.getElementById('meshStatusText')) {
        document.getElementById('meshStatusText').textContent = `🟢 Connected (${isStreamer ? 'Streamer Mode' : myCode})`;
      }
      connectToAllFriends();
      flushOfflineQueue();
    });

    peer.on('disconnected', () => {
      if (document.getElementById('meshStatusText')) {
        document.getElementById('meshStatusText').textContent = `🟡 Reconnecting (${myCode})...`;
      }
      setTimeout(() => {
        if (peer && peer.disconnected && !peer.destroyed) {
          try { peer.reconnect(); } catch (e) {}
        }
      }, 1000);
    });

    peer.on('connection', (conn) => handleIncomingConnection(conn));

    peer.on('error', (err) => {
      if (err.type === 'peer-unavailable' && err.message) {
        // Fallback to legacy v9.1 or background peer ID if primary workspace ID isn't open
        const match = err.message.match(/pulse-ws-([A-Z0-9]{4})/);
        if (match && match[1]) {
          const targetCode = match[1];
          delete connectingLocks[targetCode];
          connectFallbackPrefixes(targetCode);
        }
      }
    });

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
        if (IS_POPUP) {
          openWorkspaceTab();
        } else {
          document.getElementById('callerNameTitle').textContent = `Call from ${callerCode}`;
          document.getElementById('callModal').style.display = 'flex';
        }
      });
    });
  });
}

function openWorkspaceTab() {
  if (!IS_WEB_HOSTED && chrome?.runtime?.sendMessage) {
    chrome.runtime.sendMessage({ type: 'OPEN_WORKSPACE' });
  } else if (IS_WEB_HOSTED && EXT_ID && chrome?.runtime?.sendMessage) {
    try {
      chrome.runtime.sendMessage(EXT_ID, { type: 'OPEN_WORKSPACE' }, () => {
        if (chrome.runtime.lastError) window.open(window.location.href, '_blank');
      });
    } catch (e) {
      window.open(window.location.href, '_blank');
    }
  } else {
    window.open(window.location.href, '_blank');
  }
}

function connectToAllFriends() {
  if (!peer || !peer.open) return;
  getState(['pulse_friends'], (res) => {
    (res.pulse_friends || []).forEach(f => connectToCode(f.code));
  });
}

// Opens ONE clean primary Workspace tunnel per friend (eliminates 3x offer collisions)
function connectToCode(targetCode) {
  if (!peer || !peer.open || !targetCode || targetCode === myCode) return;
  const code = targetCode.trim().toUpperCase();

  if (liveConns[code] && liveConns[code].open) return;
  if (connectingLocks[code] && Date.now() - connectingLocks[code] < 6000) return;

  connectingLocks[code] = Date.now();
  try {
    const conn = peer.connect(`pulse-ws-${code}`, { reliable: true });
    if (conn) handleIncomingConnection(conn);
  } catch (e) {}
}

// Only dialed if `pulse-ws-CODE` is offline (supports background worker & v9.1 friends)
function connectFallbackPrefixes(code) {
  if (!peer || !peer.open || (liveConns[code] && liveConns[code].open)) return;
  ['pulse-bg-', 'pulse-'].forEach(prefix => {
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
    // Keep the newest active connection for this user
    if (liveConns[senderCode] && liveConns[senderCode] !== conn && liveConns[senderCode].open) {
      try { conn.close(); } catch (e) {}
      return;
    }
    liveConns[senderCode] = conn;
    flushOfflineQueue();
    scheduleRefresh(true);
  });

  conn.on('data', (payload) => {
    if (!payload) return;

    getState(['pulse_blocked'], (blkRes) => {
      if ((blkRes.pulse_blocked || []).includes(senderCode)) return;

      if (payload.type === 'TYPING') {
        if (activeTarget && activeTarget.id === senderCode && document.getElementById('typingIndicator')) {
          document.getElementById('typingIndicator').textContent = `${senderCode} ${payload.customText || 'is typing...'}`;
          clearTimeout(typingTimeout);
          typingTimeout = setTimeout(() => { document.getElementById('typingIndicator').textContent = ''; }, 2500);
        }
        return;
      }

      if (payload.type === 'REACTION') {
        applyMessageReaction(payload.chatId, payload.msgId, payload.emoji);
        return;
      }

      if (payload.type === 'GROUP_INVITE_SYNC') {
        getState(['pulse_groups'], (gRes) => {
          const groups = gRes.pulse_groups || [];
          const existingIdx = groups.findIndex(g => g.id === payload.group.id);
          if (existingIdx >= 0) groups[existingIdx] = payload.group;
          else groups.push(payload.group);
          setState({ pulse_groups: groups }, () => scheduleRefresh(true));
        });
        return;
      }

      if (payload.type === 'GROUP_MSG') {
        getState(['pulse_groups'], (gRes) => {
          const groups = gRes.pulse_groups || [];
          if (!groups.some(g => g.id === payload.groupId)) {
            groups.push({ id: payload.groupId, name: payload.groupName, members: payload.members || [myCode, senderCode], admin: senderCode });
            setState({ pulse_groups: groups });
          }
        });
        saveMessageToHistory(payload.groupId, {
          id: payload.msgId,
          sender: payload.senderName || senderCode,
          guildTag: payload.guildTag || '',
          text: payload.text,
          time: Date.now(),
          self: false
        });
        notifyIfNotViewing(payload.groupId, `${payload.groupName} (${senderCode})`, payload.text, payload.msgId);
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
              guildTag: payload.guildTag || '',
              text: payload.text,
              time: Date.now(),
              self: false
            });
            if (payload.tts) speakText(`${senderCode} says ${payload.text}`);
            if (conn.open) conn.send({ type: 'READ_ACK', msgId: payload.msgId });
            notifyIfNotViewing(senderCode, senderCode, payload.text, payload.msgId);
          }
        });
      }

      if (payload.type === 'READ_ACK') {
        markMessageRead(senderCode, payload.msgId);
      }
    });
  });

  conn.on('close', () => {
    if (liveConns[senderCode] === conn) delete liveConns[senderCode];
    delete connectingLocks[senderCode];
    scheduleRefresh(true);
  });

  conn.on('error', () => {
    if (liveConns[senderCode] === conn) delete liveConns[senderCode];
    delete connectingLocks[senderCode];
  });
}

function deliverPendingInbox() {
  getState(['pulse_pending_inbox', 'pulse_friends', 'pulse_history', 'pulse_requests', 'pulse_blocked'], (res) => {
    const pending = res.pulse_pending_inbox || [];
    if (pending.length === 0) return;

    const friends = res.pulse_friends || [];
    const history = res.pulse_history || {};
    const requests = res.pulse_requests || [];
    const blocked = res.pulse_blocked || [];

    pending.forEach(item => {
      if (blocked.includes(item.senderCode)) return;
      if (!friends.some(f => f.code === item.senderCode)) {
        requests.push({ type: 'message', code: item.senderCode, text: item.text });
      } else {
        if (!history[item.senderCode]) history[item.senderCode] = [];
        if (!history[item.senderCode].some(m => m.id === item.msgId)) {
          history[item.senderCode].push({ id: item.msgId, sender: item.senderCode, text: item.text, time: item.time, self: false });
        }
      }
    });

    setState({ pulse_pending_inbox: [], pulse_history: history, pulse_requests: requests }, () => scheduleRefresh(true));
  });
}

function sendPayloadToCode(targetCode, payload) {
  const code = targetCode.trim().toUpperCase();
  const conn = liveConns[code];
  let sent = false;

  if (conn && conn.open) {
    try {
      conn.send(payload);
      sent = true;
    } catch (e) {
      delete liveConns[code];
    }
  }

  if (!sent && payload.type !== 'TYPING') {
    getState(['pulse_outbox'], (res) => {
      const outbox = res.pulse_outbox || [];
      if (!outbox.some(item => item.payload?.msgId === payload.msgId)) {
        outbox.push({ targetCode: code, payload });
        setState({ pulse_outbox: outbox });
      }
    });
    connectToCode(code);
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
    if (remaining.length !== outbox.length) {
      setState({ pulse_outbox: remaining });
    }
  });
}

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

function applyMessageReaction(chatId, msgId, emoji) {
  getState(['pulse_history'], (res) => {
    const history = res.pulse_history || {};
    if (!history[chatId]) return;
    const msg = history[chatId].find(m => m.id === msgId);
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
    if (history[chatId]) {
      const msg = history[chatId].find(m => m.id === msgId);
      if (msg && msg.status !== 'Read') msg.status = 'Sent';
      setState({ pulse_history: history }, () => scheduleRefresh(true));
    }
  });
}

function markMessageRead(chatId, msgId) {
  getState(['pulse_history'], (res) => {
    const history = res.pulse_history || {};
    if (history[chatId]) {
      const msg = history[chatId].find(m => m.id === msgId);
      if (msg) msg.status = 'Read';
      setState({ pulse_history: history }, () => scheduleRefresh(true));
    }
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

function notifyIfNotViewing(chatId, title, text, msgId) {
  const isViewing = document.hasFocus() && activeTarget && activeTarget.id === chatId;
  if (!isViewing && !IS_POPUP) {
    playSound(chimeAudio);
    const msgData = {
      type: 'NEW_MESSAGE_NOTIFICATION',
      senderCode: chatId,
      senderName: title,
      text: text,
      msgId
    };
    if (!IS_WEB_HOSTED && chrome?.runtime?.sendMessage) {
      chrome.runtime.sendMessage(msgData);
    } else if (IS_WEB_HOSTED && EXT_ID && chrome?.runtime?.sendMessage) {
      chrome.runtime.sendMessage(EXT_ID, msgData);
    }
  }
}

// --- One-Click Group Member Adder ---
function openGroupMemberAdder() {
  if (!activeTarget || activeTarget.type !== 'group') return;
  getState(['pulse_friends', 'pulse_groups'], (res) => {
    const friends = res.pulse_friends || [];
    const groups = res.pulse_groups || [];
    const currentGroup = groups.find(g => g.id === activeTarget.id);
    if (!currentGroup) return;

    const list = document.getElementById('groupFriendPickerList');
    if (!list) return;
    list.innerHTML = '';

    if (friends.length === 0) {
      list.innerHTML = `<div style="color:var(--muted); font-size:0.82rem;">Add friends first before adding them to a group!</div>`;
    } else {
      friends.forEach(f => {
        const alreadyIn = (currentGroup.members || []).includes(f.code);
        const row = document.createElement('div');
        row.className = 'list-card';
        row.innerHTML = `
          <div><strong>${f.name}</strong> <span style="font-size:0.72rem; color:var(--muted);">(${f.code})</span></div>
          <button class="${alreadyIn ? 'btn-sec' : 'btn-success'}" ${alreadyIn ? 'disabled' : ''}>
            ${alreadyIn ? '✓ Added' : '+ Add'}
          </button>
        `;
        if (!alreadyIn) {
          row.querySelector('button').onclick = () => {
            currentGroup.members.push(f.code);
            activeTarget.members = currentGroup.members;
            addAuditEntry(currentGroup, `added member ${f.code}`);
            setState({ pulse_groups: groups }, () => {
              currentGroup.members.forEach(mc => {
                if (mc !== myCode) sendPayloadToCode(mc, { type: 'GROUP_INVITE_SYNC', group: currentGroup });
              });
              openGroupMemberAdder();
              scheduleRefresh(true);
            });
          };
        }
        list.appendChild(row);
      });
    }

    const modal = document.getElementById('groupMemberModal');
    if (modal) modal.style.display = 'flex';
  });
}

// --- Full Group / Server Settings Drawer ---
function openGroupSettingsDrawer() {
  if (!activeTarget || activeTarget.type !== 'group') return;
  getState(['pulse_groups', 'pulse_history'], (res) => {
    const groups = res.pulse_groups || [];
    const history = res.pulse_history || {};
    const grp = groups.find(g => g.id === activeTarget.id);
    if (!grp) return;

    const boosts = grp.boosts || 0;
    const bInfo = getGroupBoostLevel(boosts);
    document.getElementById('grpDrawerTitle').textContent = `${grp.name.toUpperCase()} — SERVER SETTINGS`;
    document.getElementById('grpBoostSummaryTitle').textContent = `Server Level ${bInfo.level} (${boosts} Boosts)`;

    checkProAccess(({ availableBoosts }) => {
      document.getElementById('grpAvailableBoostsText').textContent = `You have ${availableBoosts} available Pulse Pro boost(s) to allocate.`;
    });

    document.getElementById('grpEditName').value = grp.name || '';
    document.getElementById('grpEditIcon').value = grp.icon || '#';
    document.getElementById('grpEditTag').value = grp.tag || '';
    document.getElementById('grpEditDesc').value = grp.description || '';
    document.getElementById('grpEditBanner').value = grp.bannerColor || '#5865f2';
    document.getElementById('grpShowBoostBar').checked = grp.showBoostBar !== false;
    document.getElementById('grpPerkTagToggle').checked = !!grp.perkTagEnabled;
    document.getElementById('grpPerkHoloToggle').checked = !!grp.perkHoloEnabled;

    const rolesList = document.getElementById('grpRolesList');
    rolesList.innerHTML = '';
    (grp.roles || []).forEach((role, rIdx) => {
      const rRow = document.createElement('div');
      rRow.className = 'setting-row';
      rRow.innerHTML = `
        <span style="color:${role.color}; font-weight:800;">● ${role.name}</span>
        <button class="btn-danger" style="padding:3px 8px; font-size:0.75rem;" data-del-role="${rIdx}">Delete</button>
      `;
      rRow.querySelector('[data-del-role]').onclick = () => {
        grp.roles.splice(rIdx, 1);
        addAuditEntry(grp, `deleted role ${role.name}`);
        setState({ pulse_groups: groups }, openGroupSettingsDrawer);
      };
      rolesList.appendChild(rRow);
    });

    const emojiList = document.getElementById('grpEmojiList');
    emojiList.innerHTML = '';
    (grp.emojis || []).forEach((em, eIdx) => {
      const pill = document.createElement('span');
      pill.style.cssText = 'background:var(--bg-card); border:1px solid var(--border); padding:4px 8px; border-radius:8px; font-size:0.8rem; cursor:pointer;';
      pill.textContent = `${em.char} ${em.code} ✕`;
      pill.onclick = () => {
        grp.emojis.splice(eIdx, 1);
        setState({ pulse_groups: groups }, openGroupSettingsDrawer);
      };
      emojiList.appendChild(pill);
    });

    document.getElementById('grpAutoModWords').value = (grp.autoModWords || []).join(', ');
    document.getElementById('grpRulesScreen').checked = !!grp.rulesScreening;
    document.getElementById('grpRulesText').value = grp.rulesText || '';

    const auditBox = document.getElementById('grpAuditLogBox');
    const logs = grp.auditLog || [];
    auditBox.innerHTML = logs.length === 0
      ? '<div>No administrative changes recorded yet.</div>'
      : logs.map(l => `<div style="padding:4px 0; border-bottom:1px solid var(--border);"><strong>${l.actor}</strong> ${l.text} <span style="opacity:0.6;">(${new Date(l.time).toLocaleTimeString()})</span></div>`).join('');

    document.getElementById('insMemberCount').textContent = (grp.members || []).length;
    document.getElementById('insMsgCount').textContent = (history[grp.id] || []).length;
    document.getElementById('insBoostCount').textContent = boosts;

    document.getElementById('grpJoinCodeDisplay').textContent = grp.id;
    const memberList = document.getElementById('grpMemberManageList');
    memberList.innerHTML = '';
    (grp.members || []).forEach(mc => {
      const mRow = document.createElement('div');
      mRow.className = 'setting-row';
      mRow.innerHTML = `
        <span><strong>${mc}</strong> ${mc === grp.admin ? '<span class="pro-badge">OWNER</span>' : ''}</span>
        ${mc !== myCode ? `
          <div style="display:flex; gap:6px;">
            <button class="btn-sec" data-kick-member="${mc}" style="padding:4px 8px; font-size:0.75rem;">Kick</button>
            <button class="btn-danger" data-ban-member="${mc}" style="padding:4px 8px; font-size:0.75rem;">Ban</button>
          </div>
        ` : '<span style="font-size:0.75rem; color:var(--muted);">You</span>'}
      `;
      mRow.querySelector('[data-kick-member]')?.addEventListener('click', () => {
        grp.members = grp.members.filter(m => m !== mc);
        addAuditEntry(grp, `kicked member ${mc}`);
        setState({ pulse_groups: groups }, () => { openGroupSettingsDrawer(); scheduleRefresh(true); });
      });
      mRow.querySelector('[data-ban-member]')?.addEventListener('click', () => {
        grp.members = grp.members.filter(m => m !== mc);
        if (!grp.banned) grp.banned = [];
        if (!grp.banned.includes(mc)) grp.banned.push(mc);
        addAuditEntry(grp, `banned member ${mc}`);
        setState({ pulse_groups: groups }, () => { openGroupSettingsDrawer(); scheduleRefresh(true); });
      });
      memberList.appendChild(mRow);
    });

    const bannedList = document.getElementById('grpBannedList');
    const banned = grp.banned || [];
    bannedList.innerHTML = banned.length === 0
      ? '<div style="font-size:0.8rem; color:var(--muted);">No banned users.</div>'
      : banned.map(bc => `<div class="setting-row"><span>${bc}</span><button class="btn-sec" data-unban="${bc}" style="padding:3px 8px; font-size:0.75rem;">Revoke Ban</button></div>`).join('');
    bannedList.querySelectorAll('[data-unban]').forEach(btn => {
      btn.onclick = () => {
        grp.banned = grp.banned.filter(b => b !== btn.dataset.unban);
        addAuditEntry(grp, `unbanned ${btn.dataset.unban}`);
        setState({ pulse_groups: groups }, openGroupSettingsDrawer);
      };
    });

    document.getElementById('groupSettingsOverlay').style.display = 'flex';
  });
}

// --- Rendering Views (With Diff Guard to Prevent UI Lag) ---
function refreshAllViews(force = false) {
  getState(['pulse_friends', 'pulse_groups', 'pulse_requests', 'pulse_history', 'pulse_settings'], (res) => {
    const friends = res.pulse_friends || [];
    const groups = res.pulse_groups || [];
    const requests = res.pulse_requests || [];
    const history = res.pulse_history || {};
    const settings = res.pulse_settings || {};

    const onlineCodes = Object.keys(liveConns).filter(k => liveConns[k]?.open).join(',');
    const activeMsgs = activeTarget ? (history[activeTarget.id] || []) : [];
    const lastMsg = activeMsgs[activeMsgs.length - 1];
    const sig = `${activeTarget?.id}|${friends.length}|${groups.length}|${requests.length}|${activeMsgs.length}|${lastMsg?.id}|${lastMsg?.status}|${onlineCodes}`;

    if (!force && sig === lastRenderSignature) return;
    lastRenderSignature = sig;

    if (IS_POPUP) {
      renderList('friendsList', friends, 'dm', settings);
      renderList('groupsList', groups, 'group', settings);
      renderRequestsList('requestsList', requests);
      renderActiveChat(history, settings, groups);
      return;
    }

    const badge = document.getElementById('reqBadge');
    if (badge) {
      badge.textContent = requests.length;
      badge.style.display = requests.length > 0 ? 'inline-block' : 'none';
    }

    const mode = document.getElementById('railGroups')?.classList.contains('active') ? 'group' :
                 document.getElementById('railRequests')?.classList.contains('active') ? 'req' : 'dm';
    if (mode === 'req') renderRequestsList('sidebarList', requests);
    else if (mode === 'group') renderList('sidebarList', groups, 'group', settings);
    else renderList('sidebarList', friends, 'dm', settings);

    renderActiveChat(history, settings, groups);
  });
}

function renderList(containerId, items, type, settings) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = '';

  if (items.length === 0) {
    container.innerHTML = `<div style="color:var(--muted); text-align:center; padding:10px; font-size:0.78rem;">No ${type === 'dm' ? 'friends' : 'groups'} yet.</div>`;
    return;
  }

  items.forEach(item => {
    const id = type === 'dm' ? item.code : item.id;
    const isOnline = type === 'dm' && !!liveConns[id]?.open;
    const el = document.createElement('div');
    el.className = `list-card ${activeTarget && activeTarget.id === id ? 'active' : ''}`;
    const displayId = settings.streamerMode ? '••••' : id;
    const boostCount = item.boosts || 0;

    el.innerHTML = `
      <div style="flex:1; overflow:hidden;">
        <div style="font-weight:700; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
          ${type === 'group' ? (item.icon || '#') + ' ' : ''}${item.name}
          ${type === 'group' && boostCount > 0 ? `<span class="boost-tag">🚀 ${boostCount}</span>` : ''}
        </div>
        <div style="font-size:0.68rem; color:var(--muted);">${type === 'dm' ? displayId : `${(item.members || []).length} members`}</div>
      </div>
      <div style="display:flex; align-items:center; gap:6px;">
        ${type === 'dm' ? `<span style="color:${isOnline ? '#10b981' : '#64748b'}; font-size:0.75rem;">●</span>` : ''}
        ${type === 'dm' ? `<button data-remove-friend="${id}" title="Remove Friend" style="background:rgba(239,68,68,0.15); color:#ef4444; border:1px solid rgba(239,68,68,0.35); border-radius:6px; padding:2px 7px; font-size:0.75rem; font-weight:800; cursor:pointer;">✕</button>` : ''}
      </div>
    `;
    el.onclick = (e) => {
      if (e.target.closest('[data-remove-friend]')) return;
      activeTarget = { type, id, name: item.name, members: item.members, admin: item.admin, icon: item.icon };
      if (type === 'dm') connectToCode(id);
      if (IS_POPUP && document.getElementById('tabChat')) {
        document.getElementById('tabChat').click();
      }
      scheduleRefresh(true);
    };
    const remBtn = el.querySelector('[data-remove-friend]');
    if (remBtn) {
      remBtn.onclick = (e) => {
        e.stopPropagation();
        if (confirm(`Remove ${item.name} and delete all chat records?`)) {
          removeFriendAndRecords(id, false);
        }
      };
    }
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
    el.style.alignItems = 'flex-start';
    el.style.gap = '6px';
    el.innerHTML = `
      <div><strong>${req.code}</strong> ${req.text ? `<div style="font-size:0.75rem; color:var(--muted);">"${req.text}"</div>` : ''}</div>
      <div style="display:flex; gap:6px; width:100%;">
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

function formatMessageText(rawText, settings, groupObj) {
  let out = rawText.replace(/</g, '&lt;').replace(/>/g, '&gt;');
  if (settings.autoEmoji !== false) {
    out = out.replace(/:\)/g, '😊').replace(/:\(/g, '😢').replace(/<3/g, '❤️').replace(/:D/g, '😄');
  }
  if (groupObj && Array.isArray(groupObj.emojis)) {
    groupObj.emojis.forEach(em => {
      if (em.code && em.char) out = out.split(em.code).join(em.char);
    });
  }
  if (settings.spoilerMode !== 'always') {
    out = out.replace(/\|\|(.+?)\|\|/g, '<span class="spoiler-box" onclick="this.classList.toggle(\'revealed\')">$1</span>');
  } else {
    out = out.replace(/\|\|(.+?)\|\|/g, '<span>$1</span>');
  }
  return out;
}

function renderActiveChat(history, settings, groups = []) {
  const titleEl = document.getElementById('activeChatTitle') || document.getElementById('popupChatTitle');
  const box = document.getElementById('messagesBox') || document.getElementById('popupMessagesBox');
  if (!titleEl || !box) return;

  const callBtn = document.getElementById('wsCallBtn') || document.getElementById('popupCallBtn');
  const addMemberBtn = document.getElementById('addGroupMemberBtn');
  const grpSetBtn = document.getElementById('groupSettingsBtn');
  const headerBoostBtn = document.getElementById('headerBoostBtn');
  const levelBadge = document.getElementById('headerBoostLevelBadge');
  const boostStrip = document.getElementById('groupBoostBarStrip');

  if (!activeTarget) {
    titleEl.textContent = 'Select a Friend or Group';
    if (callBtn) callBtn.style.display = 'none';
    if (addMemberBtn) addMemberBtn.style.display = 'none';
    if (grpSetBtn) grpSetBtn.style.display = 'none';
    if (headerBoostBtn) headerBoostBtn.style.display = 'none';
    if (levelBadge) levelBadge.style.display = 'none';
    if (boostStrip) boostStrip.style.display = 'none';
    box.innerHTML = `
      <div class="empty-welcome">
        <div style="font-size:2rem;">⚡</div>
        <strong>Welcome to Pulse Chat v11.0</strong>
        <p style="font-size:0.82rem; color:var(--muted);">Select a friend or group on the left, or open ⚙️ User Settings to manage your Pulse Pro Subscription & 2 Group Boosts.</p>
      </div>
    `;
    return;
  }

  const currentGroup = activeTarget.type === 'group' ? groups.find(g => g.id === activeTarget.id) : null;
  titleEl.textContent = `${activeTarget.type === 'group' ? ((currentGroup?.icon || activeTarget.icon || '#') + ' ') : ''}${currentGroup?.name || activeTarget.name}`;

  if (callBtn) callBtn.style.display = activeTarget.type === 'dm' ? 'inline-block' : 'none';
  if (addMemberBtn) addMemberBtn.style.display = activeTarget.type === 'group' ? 'inline-block' : 'none';
  if (grpSetBtn) grpSetBtn.style.display = activeTarget.type === 'group' ? 'inline-block' : 'none';
  if (headerBoostBtn) headerBoostBtn.style.display = activeTarget.type === 'group' ? 'inline-block' : 'none';

  if (currentGroup && levelBadge && boostStrip) {
    const boosts = currentGroup.boosts || 0;
    const bInfo = getGroupBoostLevel(boosts);
    levelBadge.style.display = 'inline-block';
    levelBadge.textContent = `LEVEL ${bInfo.level}`;
    if (currentGroup.showBoostBar !== false) {
      boostStrip.style.display = 'flex';
      document.getElementById('boostBarLabel').textContent = `🚀 Group Boosts: ${boosts} / ${bInfo.nextGoal} for Level ${Math.min(3, bInfo.level + 1)}`;
      document.getElementById('boostBarFill').style.width = `${Math.min(100, (boosts / bInfo.nextGoal) * 100)}%`;
      document.getElementById('boostPerksSummary').textContent = `${bInfo.audio} Audio • ${bInfo.upload} Uploads • ${bInfo.stream}`;
    } else {
      boostStrip.style.display = 'none';
    }
  } else {
    if (levelBadge) levelBadge.style.display = 'none';
    if (boostStrip) boostStrip.style.display = 'none';
  }

  const limit = parseInt(settings.renderLimit || '150', 10);
  const msgs = (history[activeTarget.id] || []).slice(-limit);
  box.innerHTML = '';

  if (msgs.length === 0) {
    box.innerHTML = `
      <div class="empty-welcome">
        <strong>Start of ${currentGroup?.name || activeTarget.name}</strong>
        <p style="font-size:0.8rem; color:var(--muted);">End-to-end peer synced. Try <code>||spoiler||</code> or <code>/tts hello</code>!</p>
      </div>
    `;
    return;
  }

  const frag = document.createDocumentFragment();
  msgs.forEach(m => {
    const div = document.createElement('div');
    div.className = `message ${m.self ? 'sent' : 'received'}`;
    const timeStr = new Date(m.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const statusHtml = (m.self && m.status) ? `<span>${m.status === 'Queued' ? '🕒' : m.status === 'Read' ? '✓✓' : '✓'}</span>` : '';
    const tagPill = m.guildTag ? `<span class="guild-tag-pill">${m.guildTag}</span>` : '';
    const senderLabel = (!m.self && activeTarget.type === 'group') ? `<div style="font-size:0.7rem; font-weight:800; color:var(--accent); margin-bottom:2px;">${m.sender}${tagPill}</div>` : '';
    const devCopyBtn = settings.devMode ? `<button class="btn-sec" style="padding:1px 5px; font-size:0.65rem;" onclick="navigator.clipboard.writeText('${m.id}')">ID</button>` : '';

    let reactHtml = '';
    if (m.reactions && settings.showReactions !== false) {
      reactHtml = `<div style="display:flex; gap:4px; margin-top:4px;">` + Object.entries(m.reactions).map(([em, cnt]) => `<span style="background:rgba(0,0,0,0.25); border-radius:10px; padding:1px 6px; font-size:0.7rem;">${em} ${cnt}</span>`).join('') + `</div>`;
    }

    div.innerHTML = `${senderLabel}<div>${formatMessageText(m.text || '', settings, currentGroup)}</div>${reactHtml}<div class="msg-meta"><span>${timeStr}</span>${devCopyBtn}${statusHtml}</div>`;
    div.ondblclick = () => {
      if (settings.showReactions === false) return;
      applyMessageReaction(activeTarget.id, m.id, '🔥');
      if (activeTarget.type === 'dm') sendPayloadToCode(activeTarget.id, { type: 'REACTION', chatId: myCode, msgId: m.id, emoji: '🔥' });
    };
    frag.appendChild(div);
  });
  box.appendChild(frag);
  box.scrollTop = box.scrollHeight;
}

// --- Sending Messages + Group AutoMod + Restricted Phrases + TTS ---
function handleSendMessage(customInputId) {
  const input = document.getElementById(customInputId || 'msgInput') || document.getElementById('popupMsgInput') || document.querySelector('textarea, input[type="text"]');
  let text = input ? input.value.trim() : '';
  if (!text) return;

  if (text.toLowerCase() === '/flip') { document.body.classList.toggle('flip-mode'); input.value = ''; return; }
  if (text.toLowerCase() === '/matrix') { updateSetting('theme', 'matrix'); input.value = ''; return; }
  if (text.toLowerCase() === '/party') {
    input.value = '';
    const colors = ['cyber-dark', 'emerald', 'purple', 'crimson', 'sunset', 'pro-obsidian'];
    let i = 0;
    const partyTimer = setInterval(() => {
      document.documentElement.setAttribute('data-theme', colors[i % colors.length]);
      i++;
      if (i > 12) { clearInterval(partyTimer); loadSettingsAndTheme(); }
    }, 180);
    return;
  }

  let isTts = false;
  if (text.toLowerCase().startsWith('/tts ')) {
    isTts = true;
    text = text.slice(5).trim();
    speakText(text);
  }

  if (!activeTarget || !text) return;

  const matchedBan = BANNED_PHRASES.find(phrase => text.includes(phrase));
  if (matchedBan) {
    input.value = '';
    const warnUrl = getAssetUrl(`warning.html?term=${encodeURIComponent(matchedBan)}`);
    if (!IS_WEB_HOSTED && chrome?.tabs?.create) chrome.tabs.create({ url: warnUrl });
    else window.open(warnUrl, '_blank');
    return;
  }

  getState(['pulse_settings', 'pulse_groups'], (res) => {
    const settings = res.pulse_settings || {};
    const groups = res.pulse_groups || [];
    const guildTag = (settings.equippedTag || '').toUpperCase();

    if (activeTarget.type === 'group') {
      const grp = groups.find(g => g.id === activeTarget.id);
      if (grp && Array.isArray(grp.autoModWords)) {
        const hit = grp.autoModWords.find(w => w && text.toLowerCase().includes(w.toLowerCase()));
        if (hit) {
          alert(`🛡️ AutoMod blocked your message because it matched the server's restricted keyword: "${hit}"`);
          return;
        }
      }
    }

    const msgId = 'msg-' + Date.now() + '-' + Math.random().toString(36).substring(2, 5);
    const msgObj = { id: msgId, sender: myCode, guildTag, text, time: Date.now(), self: true, status: 'Sent' };

    if (activeTarget.type === 'dm') {
      const sent = sendPayloadToCode(activeTarget.id, { type: 'DM', msgId, text, guildTag, tts: isTts });
      msgObj.status = sent ? 'Sent' : 'Queued';
      saveMessageToHistory(activeTarget.id, msgObj);
    } else if (activeTarget.type === 'group') {
      msgObj.sender = 'You';
      saveMessageToHistory(activeTarget.id, msgObj);
      (activeTarget.members || []).forEach(mc => {
        if (mc !== myCode) {
          sendPayloadToCode(mc, {
            type: 'GROUP_MSG',
            msgId,
            groupId: activeTarget.id,
            groupName: activeTarget.name,
            members: activeTarget.members,
            senderName: myCode,
            guildTag,
            text
          });
        }
      });
    }

    input.value = '';
  });
}

function loadSettingsAndTheme() {
  getState(['pulse_settings'], (res) => {
    const s = res.pulse_settings || {};
    document.documentElement.setAttribute('data-theme', s.theme || 'discord-dark');
    document.documentElement.style.setProperty('--ui-saturation', `${s.saturation || 100}%`);
    document.body.style.fontFamily = s.fontFamily || 'system-ui, sans-serif';
    document.body.style.setProperty('--font-size', s.fontSize || '15px');
    document.body.style.setProperty('--msg-gap', s.msgGap || '10px');

    document.body.classList.toggle('no-animations', !!s.noAnimations);
    document.body.classList.toggle('high-contrast', !!s.highContrast);
    document.body.classList.toggle('compact-mode', s.msgDensity === 'compact');

    if (document.getElementById('footerDisplayName')) document.getElementById('footerDisplayName').textContent = s.displayName || 'User';
    if (document.getElementById('footerAvatar')) document.getElementById('footerAvatar').textContent = s.avatarEmoji || '👤';
    if (document.getElementById('footerCustomActivity')) document.getElementById('footerCustomActivity').textContent = s.customActivity || 'Ready to chat';

    const tagEl = document.getElementById('footerGuildTag');
    if (tagEl) {
      tagEl.textContent = (s.equippedTag || '').toUpperCase();
      tagEl.style.display = s.equippedTag ? 'inline-block' : 'none';
    }

    const hypeBadge = document.getElementById('footerHypeBadge');
    if (hypeBadge) {
      hypeBadge.textContent = s.hypeSquad || '';
      hypeBadge.style.display = s.hypeSquad ? 'inline-block' : 'none';
    }

    const sendBtn = document.getElementById('sendBtn');
    if (sendBtn) sendBtn.style.display = s.showSendBtn === false ? 'none' : 'inline-block';

    const setVal = (id, val) => { const el = document.getElementById(id); if (el && val !== undefined) el.value = val; };
    const setChk = (id, val) => { const el = document.getElementById(id); if (el) el.checked = !!val; };

    setVal('themeSelect', s.theme || 'discord-dark');
    setVal('setDisplayName', s.displayName || '');
    setVal('setUsername', s.username || '');
    setVal('setCustomActivity', s.customActivity || '');
    setVal('setAvatarEmoji', s.avatarEmoji || '😎');
    setVal('setEquippedTag', s.equippedTag || '');
    setVal('setPronouns', s.pronouns || '');
    setVal('setBio', s.bio || '');
    setVal('setCustomTyping', s.customTyping || '');
    setVal('setDmFilter', s.dmFilter || 'requests');
    setVal('setMsgDensity', s.msgDensity || 'cozy');
    setVal('setFontFamily', s.fontFamily || 'system-ui');
    setVal('setFontSize', s.fontSize || '15px');
    setVal('setMsgGap', s.msgGap || '10px');
    setVal('setSaturation', s.saturation || 100);
    setVal('setTtsRate', s.ttsRate || 1.0);
    setVal('setSpoilerMode', s.spoilerMode || 'click');

    setChk('setHighContrast', s.highContrast);
    setChk('setNoAnimations', s.noAnimations);
    setChk('setShowSendBtn', s.showSendBtn !== false);
    setChk('setAllowTts', s.allowTts !== false);
    setChk('setShowReactions', s.showReactions !== false);
    setChk('setAutoEmoji', s.autoEmoji !== false);
    setChk('setStreamerMode', s.streamerMode);
    setChk('setDevMode', s.devMode);
  });
}

function updateSetting(key, val) {
  getState(['pulse_settings'], (res) => {
    const s = res.pulse_settings || {};
    s[key] = val;
    setState({ pulse_settings: s }, () => {
      loadSettingsAndTheme();
      scheduleRefresh(true);
    });
  });
}

function bindUIEvents() {
  document.getElementById('openWorkspaceBtn')?.addEventListener('click', openWorkspaceTab);
  document.getElementById('copyCodeBtn')?.addEventListener('click', () => { navigator.clipboard.writeText(myCode); alert('Copied: ' + myCode); });
  document.getElementById('archiveBtn')?.addEventListener('click', () => archiveOldHistory(true));
  document.getElementById('sendBtn')?.addEventListener('click', () => handleSendMessage('msgInput'));
  document.getElementById('popupSendBtn')?.addEventListener('click', () => handleSendMessage('popupMsgInput'));

  document.querySelectorAll('button').forEach(btn => {
    const label = btn.textContent.trim();
    if (label === '+ Add' && !btn.onclick) btn.addEventListener('click', promptAddFriend);
    if (label === '+ Group' && !btn.onclick) btn.addEventListener('click', promptCreateGroup);
    if (label === 'Copy' && !btn.onclick) btn.addEventListener('click', () => { navigator.clipboard.writeText(myCode); alert('Copied: ' + myCode); });
    if (label === '☁️' && !btn.onclick) btn.addEventListener('click', () => archiveOldHistory(true));
    if (label === 'Send' && !btn.onclick) btn.addEventListener('click', () => handleSendMessage());
    if ((label.includes('Full') || label.includes('Workspace')) && !btn.onclick) btn.addEventListener('click', openWorkspaceTab);
    if (label === '⚙️' && !btn.onclick) btn.addEventListener('click', () => {
      const overlay = document.getElementById('settingsOverlay');
      if (overlay) { overlay.style.display = 'flex'; updateProUI(); }
      else openWorkspaceTab();
    });
  });

  if (IS_POPUP) {
    document.getElementById('addFriendBtn')?.addEventListener('click', promptAddFriend);
    document.getElementById('createGroupBtn')?.addEventListener('click', promptCreateGroup);
    document.getElementById('popupCallBtn')?.addEventListener('click', openWorkspaceTab);
    const popInp = document.getElementById('popupMsgInput') || document.getElementById('msgInput');
    if (popInp) {
      popInp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSendMessage(popInp.id); }
      });
    }
    return;
  }

  document.getElementById('addGroupMemberBtn')?.addEventListener('click', openGroupMemberAdder);
  document.getElementById('groupSettingsBtn')?.addEventListener('click', openGroupSettingsDrawer);
  document.getElementById('headerBoostBtn')?.addEventListener('click', () => boostActiveGroup(1));
  document.getElementById('boostThisGroupBtn')?.addEventListener('click', () => boostActiveGroup(1));
  document.getElementById('unboostThisGroupBtn')?.addEventListener('click', () => boostActiveGroup(-1));
  document.getElementById('closeGroupMemberModal')?.addEventListener('click', () => { document.getElementById('groupMemberModal').style.display = 'none'; });
  document.getElementById('closeGroupSettingsBtn')?.addEventListener('click', () => { document.getElementById('groupSettingsOverlay').style.display = 'none'; });

  document.querySelectorAll('.grp-tab').forEach(tab => {
    tab.onclick = () => {
      document.querySelectorAll('.grp-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.grp-section').forEach(s => s.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById(`gsec-${tab.dataset.gsec}`).classList.add('active');
    };
  });

  document.getElementById('saveGrpProfileBtn')?.addEventListener('click', () => {
    if (!activeTarget || activeTarget.type !== 'group') return;
    getState(['pulse_groups'], (res) => {
      const groups = res.pulse_groups || [];
      const grp = groups.find(g => g.id === activeTarget.id);
      if (!grp) return;
      grp.name = document.getElementById('grpEditName').value.trim() || grp.name;
      grp.icon = document.getElementById('grpEditIcon').value.trim() || '#';
      grp.tag = document.getElementById('grpEditTag').value.trim().toUpperCase();
      grp.description = document.getElementById('grpEditDesc').value.trim();
      grp.bannerColor = document.getElementById('grpEditBanner').value;
      grp.showBoostBar = document.getElementById('grpShowBoostBar').checked;
      grp.perkTagEnabled = document.getElementById('grpPerkTagToggle').checked;
      grp.perkHoloEnabled = document.getElementById('grpPerkHoloToggle').checked;
      activeTarget.name = grp.name;
      activeTarget.icon = grp.icon;
      addAuditEntry(grp, 'updated Server Profile settings');
      setState({ pulse_groups: groups }, () => { alert('✅ Server Profile Saved!'); scheduleRefresh(true); });
    });
  });

  document.getElementById('addRoleBtn')?.addEventListener('click', () => {
    if (!activeTarget || activeTarget.type !== 'group') return;
    const rName = document.getElementById('newRoleName').value.trim();
    const rColor = document.getElementById('newRoleColor').value;
    if (!rName) return;
    getState(['pulse_groups'], (res) => {
      const groups = res.pulse_groups || [];
      const grp = groups.find(g => g.id === activeTarget.id);
      if (!grp) return;
      if (!grp.roles) grp.roles = [];
      grp.roles.push({ name: rName, color: rColor });
      addAuditEntry(grp, `created role "${rName}"`);
      document.getElementById('newRoleName').value = '';
      setState({ pulse_groups: groups }, openGroupSettingsDrawer);
    });
  });

  document.getElementById('addGrpEmojiBtn')?.addEventListener('click', () => {
    if (!activeTarget || activeTarget.type !== 'group') return;
    const code = document.getElementById('grpEmojiCode').value.trim();
    const char = document.getElementById('grpEmojiChar').value.trim();
    if (!code || !char) return;
    getState(['pulse_groups'], (res) => {
      const groups = res.pulse_groups || [];
      const grp = groups.find(g => g.id === activeTarget.id);
      if (!grp) return;
      if (!grp.emojis) grp.emojis = [];
      grp.emojis.push({ code: code.startsWith(':') ? code : `:${code}:`, char });
      addAuditEntry(grp, `added custom emoji ${char}`);
      document.getElementById('grpEmojiCode').value = '';
      document.getElementById('grpEmojiChar').value = '';
      setState({ pulse_groups: groups }, openGroupSettingsDrawer);
    });
  });

  document.getElementById('saveAutoModBtn')?.addEventListener('click', () => {
    if (!activeTarget || activeTarget.type !== 'group') return;
    getState(['pulse_groups'], (res) => {
      const groups = res.pulse_groups || [];
      const grp = groups.find(g => g.id === activeTarget.id);
      if (!grp) return;
      grp.autoModWords = document.getElementById('grpAutoModWords').value.split(',').map(w => w.trim()).filter(Boolean);
      grp.rulesScreening = document.getElementById('grpRulesScreen').checked;
      grp.rulesText = document.getElementById('grpRulesText').value.trim();
      addAuditEntry(grp, 'updated AutoMod & Safety rules');
      setState({ pulse_groups: groups }, () => { alert('🛡️ Safety & AutoMod Rules Saved!'); openGroupSettingsDrawer(); });
    });
  });

  document.getElementById('copyVanityBtn')?.addEventListener('click', () => {
    const slug = document.getElementById('grpVanitySlug').value.trim() || activeTarget?.id;
    navigator.clipboard.writeText(`https://iliketrains1382.github.io/pulse-chat/index.html?invite=${encodeURIComponent(slug)}`);
    alert('🔗 Custom Invite Link Copied!');
  });

  document.getElementById('copyServerTemplateBtn')?.addEventListener('click', () => {
    getState(['pulse_groups'], (res) => {
      const grp = (res.pulse_groups || []).find(g => g.id === activeTarget?.id);
      if (grp) {
        navigator.clipboard.writeText(JSON.stringify({ name: grp.name, roles: grp.roles, autoModWords: grp.autoModWords }, null, 2));
        alert('📋 Server Template JSON copied to clipboard!');
      }
    });
  });

  document.getElementById('copyGrpJoinCodeBtn')?.addEventListener('click', () => {
    if (activeTarget) { navigator.clipboard.writeText(activeTarget.id); alert('Copied Group Invite ID: ' + activeTarget.id); }
  });

  document.getElementById('deleteGroupServerBtn')?.addEventListener('click', () => {
    if (!activeTarget || activeTarget.type !== 'group') return;
    const confirmName = prompt(`Type "${activeTarget.name}" to permanently delete this server:`);
    if (confirmName !== activeTarget.name) return;
    getState(['pulse_groups'], (res) => {
      const groups = (res.pulse_groups || []).filter(g => g.id !== activeTarget.id);
      activeTarget = null;
      document.getElementById('groupSettingsOverlay').style.display = 'none';
      setState({ pulse_groups: groups }, () => scheduleRefresh(true));
    });
  });

  document.getElementById('subMonthlyBtn')?.addEventListener('click', () => {
    setState({ pulse_pro_sub: { active: true, plan: 'monthly', expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000 } }, () => {
      alert('⭐ Subscribed to Pulse Pro Monthly! 2 Group Boosts added to your account.');
      updateProUI();
    });
  });

  document.getElementById('subYearlyBtn')?.addEventListener('click', () => {
    setState({ pulse_pro_sub: { active: true, plan: 'yearly', expiresAt: Date.now() + 365 * 24 * 60 * 60 * 1000 } }, () => {
      alert('⭐ Subscribed to Pulse Pro Yearly! 2 Group Boosts added to your account.');
      updateProUI();
    });
  });

  document.getElementById('cancelSubBtn')?.addEventListener('click', () => {
    if (confirm('Cancel your Pulse Pro subscription?')) {
      setState({ pulse_pro_sub: { active: false, plan: 'free', expiresAt: 0 } }, () => {
        updateProUI();
      });
    }
  });

  if (document.getElementById('runArchiveNowBtn')) document.getElementById('runArchiveNowBtn').onclick = () => archiveOldHistory(true);
  if (document.getElementById('railFriends')) document.getElementById('railFriends').onclick = (e) => setActiveRail(e.currentTarget, 'DIRECT MESSAGES', '+ Add', promptAddFriend);
  if (document.getElementById('railGroups')) document.getElementById('railGroups').onclick = (e) => setActiveRail(e.currentTarget, 'GROUP SERVERS', '+ Group', promptCreateGroup);
  if (document.getElementById('railRequests')) document.getElementById('railRequests').onclick = (e) => setActiveRail(e.currentTarget, 'REQUESTS', '', null);
  if (document.getElementById('railSettings')) document.getElementById('railSettings').onclick = () => { document.getElementById('settingsOverlay').style.display = 'flex'; updateProUI(); };
  if (document.getElementById('closeSettingsBtn')) document.getElementById('closeSettingsBtn').onclick = () => { document.getElementById('settingsOverlay').style.display = 'none'; };
  if (document.getElementById('sidebarActionBtn')) document.getElementById('sidebarActionBtn').onclick = promptAddFriend;

  document.querySelectorAll('.settings-tab').forEach(tab => {
    tab.onclick = () => {
      document.querySelectorAll('.settings-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.settings-section').forEach(s => s.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById(`sec-${tab.dataset.sec}`).classList.add('active');
    };
  });

  if (document.getElementById('redeemCodeBtn')) {
    document.getElementById('redeemCodeBtn').onclick = () => {
      const code = document.getElementById('giftCodeInput').value.trim().toUpperCase();
      if (VALID_GIFT_CODES.includes(code)) {
        setState({ pulse_pro_permanent: true }, () => {
          alert('🎉 Gift Card Redeemed! Lifetime Pulse Pro & 2 Group Boosts unlocked!');
          updateProUI();
        });
      } else if (code.startsWith('PASS-')) {
        setState({ pulse_trial_start: Date.now() }, () => {
          alert('🎟️ 3-Day Friend Pass Activated! Pulse Pro & 2 Group Boosts unlocked for 72 hours.');
          updateProUI();
        });
      } else {
        alert('Invalid Gift Card or Pass Code. Please check the code and try again.');
      }
    };
  }

  if (document.getElementById('genFriendPassBtn')) {
    document.getElementById('genFriendPassBtn').onclick = () => {
      const pass = 'PASS-' + Math.random().toString(36).substring(2, 8).toUpperCase();
      navigator.clipboard.writeText(pass);
      alert(`🎟️ Generated & Copied 3-Day Friend Pass: ${pass}`);
    };
  }

  if (document.getElementById('exportDataPackageBtn')) {
    document.getElementById('exportDataPackageBtn').onclick = () => {
      getState(['pulse_settings', 'pulse_friends', 'pulse_groups', 'pulse_history'], (res) => {
        const blob = new Blob([JSON.stringify(res, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `pulse-chat-data-package-${Date.now()}.json`;
        a.click();
      });
    };
  }

  document.querySelectorAll('[data-hype]').forEach(btn => {
    btn.onclick = () => updateSetting('hypeSquad', btn.dataset.hype);
  });

  if (document.getElementById('previewTtsBtn')) {
    document.getElementById('previewTtsBtn').onclick = () => speakText('Pulse Chat Text to Speech is active and ready!');
  }

  const bindVal = (id, key) => { const el = document.getElementById(id); if (el) el.onchange = (e) => updateSetting(key, e.target.value); };
  const bindChk = (id, key) => { const el = document.getElementById(id); if (el) el.onchange = (e) => updateSetting(key, e.target.checked); };

  bindVal('setDisplayName', 'displayName');
  bindVal('setUsername', 'username');
  bindVal('setCustomActivity', 'customActivity');
  bindVal('setAvatarEmoji', 'avatarEmoji');
  bindVal('setEquippedTag', 'equippedTag');
  bindVal('setPronouns', 'pronouns');
  bindVal('setBio', 'bio');
  bindVal('setCustomTyping', 'customTyping');
  bindVal('setDmFilter', 'dmFilter');
  bindVal('themeSelect', 'theme');
  bindVal('setMsgDensity', 'msgDensity');
  bindVal('setFontFamily', 'fontFamily');
  bindVal('setFontSize', 'fontSize');
  bindVal('setMsgGap', 'msgGap');
  bindVal('setSaturation', 'saturation');
  bindVal('setTtsRate', 'ttsRate');
  bindVal('setSpoilerMode', 'spoilerMode');
  bindVal('setRenderLimit', 'renderLimit');
  bindVal('micDeviceSelect', 'micDeviceId');

  bindChk('setHighContrast', 'highContrast');
  bindChk('setNoAnimations', 'noAnimations');
  bindChk('setShowSendBtn', 'showSendBtn');
  bindChk('setAllowTts', 'allowTts');
  bindChk('setShowReactions', 'showReactions');
  bindChk('setAutoEmoji', 'autoEmoji');
  bindChk('setStreamerMode', 'streamerMode');
  bindChk('setDevMode', 'devMode');
  bindChk('setEcho', 'echo');
  bindChk('setNoise', 'noise');
  bindChk('setAgc', 'agc');

  if (document.getElementById('applyRecoverCodeBtn')) {
    document.getElementById('applyRecoverCodeBtn').onclick = () => {
      const c = document.getElementById('recoverCodeInput').value.trim().toUpperCase();
      if (c.length === 4) setState({ pulse_my_code: c }, () => { initPeerNetwork(); alert('Code restored!'); });
    };
  }

  if (document.getElementById('logoutSessionBtn')) {
    document.getElementById('logoutSessionBtn').onclick = () => {
      if (confirm('Clear local session and reload?')) {
        localStorage.clear();
        window.location.reload();
      }
    };
  }

  if (document.getElementById('testMicBtn')) {
    document.getElementById('testMicBtn').onclick = () => {
      const status = document.getElementById('micTestStatus');
      status.textContent = 'Requesting microphone access...';
      getMediaStreamWithFallback((stream) => {
        status.textContent = '✅ Microphone working! Audio stream active.';
        status.style.color = '#10b981';
        stream.getTracks().forEach(t => t.stop());
      });
    };
  }

  if (document.getElementById('wsCallBtn')) {
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
  }

  if (document.getElementById('acceptCallBtn')) {
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
  }

  if (document.getElementById('declineCallBtn')) document.getElementById('declineCallBtn').onclick = () => { stopCallAudio(); document.getElementById('callModal').style.display = 'none'; if (currentCall) currentCall.close(); };
  if (document.getElementById('endCallBtn')) document.getElementById('endCallBtn').onclick = endActiveCall;
  if (document.getElementById('shareScreenBtn')) document.getElementById('shareScreenBtn').onclick = toggleScreenShare;

  if (document.getElementById('muteMicBtn')) {
    document.getElementById('muteMicBtn').onclick = (e) => {
      isMuted = !isMuted;
      if (localStream) localStream.getAudioTracks().forEach(t => t.enabled = !isMuted);
      e.target.textContent = isMuted ? '🔇 Unmute' : '🎙️ Mute';
    };
  }

  if (document.getElementById('quickJoinBtn')) document.getElementById('quickJoinBtn').onclick = promptAddFriend;
  if (document.getElementById('msgInput')) {
    document.getElementById('msgInput').onkeydown = (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSendMessage(); }
    };
  }
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
  scheduleRefresh(true);
}

function addFriendByCode(code, name) {
  const cleanCode = code.trim().toUpperCase();
  getState(['pulse_friends', 'pulse_blocked'], (res) => {
    const friends = res.pulse_friends || [];
    const blocked = (res.pulse_blocked || []).filter(b => b !== cleanCode);
    if (!friends.some(f => f.code === cleanCode)) {
      friends.push({ code: cleanCode, name });
      setState({ pulse_friends: friends, pulse_blocked: blocked }, () => { connectToCode(cleanCode); scheduleRefresh(true); });
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
  getState(['pulse_groups'], (res) => {
    const groupName = prompt('Enter New Group Server Name:');
    if (!groupName) return;
    const newGroup = {
      id: 'grp-' + Date.now(),
      name: groupName.trim(),
      members: [myCode],
      admin: myCode,
      boosts: 0,
      roles: [{ name: 'Admin', color: '#f59e0b' }],
      auditLog: [{ time: Date.now(), actor: myCode, text: 'created the server' }]
    };
    const groups = res.pulse_groups || [];
    groups.push(newGroup);
    activeTarget = { type: 'group', id: newGroup.id, name: newGroup.name, members: newGroup.members, admin: myCode };
    setState({ pulse_groups: groups }, () => {
      scheduleRefresh(true);
      openGroupMemberAdder();
    });
  });
}