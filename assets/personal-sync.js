/* Orlando personal site only — cross-device sync. Never loaded on Nico live or staging. */
(function () {
  if (typeof PERSONAL_SITE === 'undefined' || !PERSONAL_SITE) return;

  var SYNC_URL = (window.ICRS_SYNC_URL || '').replace(/\/$/, '');
  var CLOUD_SYNC = !!SYNC_URL;
  var LS_SYNC_ROOM = 'icrs2026.syncRoom';
  var LS_SYNC_AT = 'icrs2026.syncAt';
  var SYNC_WORDS = ['coral', 'reef', 'tide', 'kelp', 'shell', 'wave', 'fin', 'bay', 'manta', 'nemo'];
  var cloudPushTimer = null;
  var cloudPullTimer = null;
  var cloudBusy = false;
  var syncCloudReady = false;
  var syncLocalDirty = false;

function backupStats(data) {
  if (!data || !Array.isArray(data.profiles)) return { picks: 0, notes: 0 };
  var picks = 0, notes = 0;
  data.profiles.forEach(function (p) {
    picks += (data.picks[p] || []).length;
    Object.keys(data.notes[p] || {}).forEach(function (sid) {
      var n = data.notes[p][sid];
      if (n && (n.text || n.revisit || n.contact)) notes++;
    });
  });
  return { picks: picks, notes: notes };
}
function syncRoom() {
  try { return (localStorage.getItem(LS_SYNC_ROOM) || '').toLowerCase().trim(); } catch (e) { return ''; }
}
function syncAt() {
  try { return parseInt(localStorage.getItem(LS_SYNC_AT) || '0', 10) || 0; } catch (e) { return 0; }
}
function setSyncAt(at) {
  try { localStorage.setItem(LS_SYNC_AT, String(at)); } catch (e) {}
}
function genSyncCode() {
  var pick = function () { return SYNC_WORDS[Math.floor(Math.random() * SYNC_WORDS.length)]; };
  return pick() + '-' + pick() + '-' + String(Math.floor(Math.random() * 9000) + 1000);
}
function normalizeSyncCode(raw) {
  return String(raw || '').toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').slice(0, 32);
}
function setSyncRoom(code, opts) {
  opts = opts || {};
  var room = normalizeSyncCode(code);
  if (!room) return false;
  try { localStorage.setItem(LS_SYNC_ROOM, room); } catch (e) { return false; }
  syncCloudReady = false;
  syncLocalDirty = false;
  if (el('syncCodeInput')) el('syncCodeInput').value = room;
  updateCloudSyncUI();
  if (!opts.quiet) toast('Sync code set — loading from cloud…');
  pullCloudSync(true);
  return true;
}
function fetchCloudRoom(room) {
  return fetch(SYNC_URL + '/' + encodeURIComponent(room), { cache: 'no-store' })
    .then(function (r) {
      if (r.status === 404) return null;
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
}
function upgradeSyncData(data, remoteAt) {
  if (!data) return null;
  if (data.v === 2) return data;
  if (data.v !== 1 || data.app !== 'icrs2026' || !Array.isArray(data.profiles)) return null;
  var at = remoteAt || 0;
  var picksMeta = {}, notes = {};
  data.profiles.forEach(function (p) {
    picksMeta[p] = {};
    (data.picks[p] || []).forEach(function (sid) {
      picksMeta[p][sid] = { on: true, at: at };
    });
    notes[p] = {};
    Object.keys(data.notes[p] || {}).forEach(function (sid) {
      var n = data.notes[p][sid];
      notes[p][sid] = {
        text: n.text || '',
        revisit: !!n.revisit,
        contact: !!n.contact,
        at: n.at || at
      };
    });
  });
  return {
    v: 2,
    app: 'icrs2026',
    current: data.current,
    profiles: data.profiles.slice(),
    picks: data.picks,
    picksMeta: picksMeta,
    notes: notes
  };
}
function mergePickMeta(localMeta, remoteMeta, remotePicks) {
  localMeta = localMeta || {};
  remoteMeta = remoteMeta || {};
  if (!Object.keys(remoteMeta).length && remotePicks && remotePicks.length) {
    remotePicks.forEach(function (sid) { remoteMeta[sid] = { on: true, at: 0 }; });
  }
  var merged = {}, sids = {}, pickList = [];
  Object.keys(localMeta).forEach(function (sid) { sids[sid] = 1; });
  Object.keys(remoteMeta).forEach(function (sid) { sids[sid] = 1; });
  Object.keys(sids).forEach(function (sid) {
    var l = localMeta[sid];
    var r = remoteMeta[sid];
    var winner;
    if (!l) winner = r;
    else if (!r) winner = l;
    else winner = l.at >= r.at ? l : r;
    if (!winner) return;
    merged[sid] = winner;
    if (winner.on) pickList.push(sid);
  });
  return { meta: merged, picks: pickList };
}
function mergeNoteMaps(localNotes, remoteNotes) {
  localNotes = localNotes || {};
  remoteNotes = remoteNotes || {};
  var merged = {}, sids = {};
  Object.keys(localNotes).forEach(function (sid) { sids[sid] = 1; });
  Object.keys(remoteNotes).forEach(function (sid) { sids[sid] = 1; });
  Object.keys(sids).forEach(function (sid) {
    var l = localNotes[sid] || {};
    var r = remoteNotes[sid] || {};
    var lAt = parseInt(l.at, 10) || 0;
    var rAt = parseInt(r.at, 10) || 0;
    var w = lAt >= rAt ? l : r;
    if (!w) return;
    var n = {
      text: String(w.text || '').slice(0, NOTE_MAX),
      revisit: !!w.revisit,
      contact: !!w.contact,
      at: Math.max(lAt, rAt) || Date.now()
    };
    if (n.text || n.revisit || n.contact) merged[sid] = n;
    else merged[sid] = { text: '', revisit: false, contact: false, at: n.at };
  });
  return merged;
}
function buildSyncPayload() {
  var profs = profiles();
  var picks = {}, picksMeta = {}, notes = {};
  profs.forEach(function (n) {
    picks[n] = readJSON(LS_PICKS + n, []);
    picksMeta[n] = readJSON(LS_PICKS_META + n, {});
    notes[n] = readJSON(LS_NOTES + n, {});
  });
  return {
    v: 2,
    app: 'icrs2026',
    current: PROFILE,
    profiles: profs,
    picks: picks,
    picksMeta: picksMeta,
    notes: notes
  };
}
function mergeSyncPayload(remote, opts) {
  opts = opts || {};
  if (!remote) return false;
  var data = upgradeSyncData(remote.data || remote, remote.at);
  if (!data) return false;

  cloudBusy = true;
  var localProfs = profiles();
  var allProfs = localProfs.slice();
  data.profiles.forEach(function (p) {
    if (allProfs.indexOf(p) === -1) allProfs.push(p);
  });
  saveProfiles(allProfs);

  allProfs.forEach(function (name) {
    var picksMerged = mergePickMeta(
      readJSON(LS_PICKS_META + name, {}),
      data.picksMeta[name] || {},
      data.picks[name] || []
    );
    writeJSON(LS_PICKS_META + name, picksMerged.meta);
    writeJSON(LS_PICKS + name, picksMerged.picks);
    writeJSON(LS_NOTES + name, mergeNoteMaps(readJSON(LS_NOTES + name, {}), data.notes[name] || {}));
  });

  if (data.current) {
    try { localStorage.setItem(LS_CURRENT, data.current); } catch (e) {}
  }
  var who = PROFILE && allProfs.indexOf(PROFILE) !== -1 ? PROFILE : '';
  if (!who && data.current && allProfs.indexOf(data.current) !== -1) who = data.current;
  else if (!who && allProfs.length) who = allProfs[0];
  if (who) setProfile(who);
  else updateCount();
  render();
  setSyncAt(Math.max(syncAt(), remote.at || 0));
  syncLocalDirty = false;
  cloudBusy = false;
  syncCloudReady = true;
  updateCloudSyncUI();
  if (opts.toast) toast('Synced — newest change on each item wins.');
  return true;
}
function cloudPayload() {
  return { at: Date.now(), data: buildSyncPayload() };
}
function scheduleCloudPush() {
  if (!CLOUD_SYNC || !syncRoom() || cloudBusy || !syncCloudReady) return;
  clearTimeout(cloudPushTimer);
  cloudPushTimer = setTimeout(pushCloudSync, 1500);
}
function pushCloudSync() {
  var room = syncRoom();
  if (!room || !CLOUD_SYNC || cloudBusy || !syncCloudReady || !syncLocalDirty) return;
  updateCloudSyncStatus('saving');
  fetchCloudRoom(room)
    .then(function (remote) {
      if (remote) mergeSyncPayload(remote, { silent: true });
      var payload = cloudPayload();
      return fetch(SYNC_URL + '/' + encodeURIComponent(room), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      }).then(function (r) {
        if (r.ok) {
          setSyncAt(payload.at);
          syncLocalDirty = false;
          updateCloudSyncUI();
        } else updateCloudSyncStatus('error');
      });
    })
    .catch(function () { updateCloudSyncStatus('offline'); });
}
function pullCloudSync(force) {
  var room = syncRoom();
  if (!room || !CLOUD_SYNC) return Promise.resolve(false);
  if (!force && cloudBusy) return Promise.resolve(false);
  updateCloudSyncStatus('pulling');
  return fetchCloudRoom(room)
    .then(function (remote) {
      if (!remote) {
        syncCloudReady = true;
        if (force && syncLocalDirty) scheduleCloudPush();
        updateCloudSyncUI();
        return false;
      }
      var applied = mergeSyncPayload(remote, { toast: force });
      if (!applied) updateCloudSyncUI();
      return applied;
    })
    .catch(function () {
      updateCloudSyncStatus('offline');
      return false;
    });
}
function startCloudSyncLoop() {
  if (!CLOUD_SYNC) return;
  clearInterval(cloudPullTimer);
  cloudPullTimer = setInterval(function () {
    if (document.visibilityState === 'visible' && syncRoom()) pullCloudSync(false);
  }, 25000);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && syncRoom()) pullCloudSync(false);
  });
}
function updateCloudSyncStatus(state) {
  var elStatus = el('cloudSyncStatus');
  if (!elStatus) return;
  elStatus.dataset.state = state || '';
  updateCloudSyncUI();
}
function updateCloudSyncUI() {
  var panel = el('cloudSyncPanel');
  var note = el('mineNote');
  var elStatus = el('cloudSyncStatus');
  if (!CLOUD_SYNC) {
    if (panel) panel.hidden = true;
    if (note) {
      note.innerHTML = STAGING_SITE
        ? 'Picks and notes are stored in this browser only. Clearing site data removes them.'
        : 'Picks and notes are stored in this browser only. Clearing site data removes them. Use <b>Backup</b> / <b>Restore</b> to move them between devices.';
    }
    return;
  }
  if (panel) panel.hidden = false;
  if (note) {
    note.innerHTML = 'Picks and notes sync across devices with the same code. Each star or note keeps its own timestamp — <b>the newest change wins</b>, on any device.';
  }
  var input = el('syncCodeInput');
  if (input && document.activeElement !== input) input.value = syncRoom();
  var hint = el('cloudSyncHint');
  if (hint) {
    hint.textContent = SYNC_URL
      ? 'Enter the same code on each device. Conflicts resolve by most recently edited pick or note — not by device.'
      : 'Cloud sync needs a one-time worker deploy (see worker/deploy.sh), then set your worker URL in assets/sync-config.js.';
  }
  if (elStatus) {
    var state = elStatus.dataset.state || (syncRoom() ? 'synced' : '');
    var labels = {
      synced: 'Up to date',
      saving: 'Saving…',
      pulling: 'Checking…',
      offline: 'Offline',
      error: 'Sync error'
    };
    var s = backupStats(buildBackup());
    var extra = (s.picks || s.notes) ? ' · ' + s.picks + '★ ' + s.notes + ' notes' : '';
    elStatus.textContent = (labels[state] || '') + extra;
  }
}
function copySyncCode() {
  var code = syncRoom();
  if (!code) { toast('Enter or generate a sync code first.'); return; }
  copyText(code, 'Sync code copied — paste it on your other device.');
}

  window.markSyncDirty = function () {
    syncLocalDirty = true;
    scheduleCloudPush();
  };

  if (el('syncCodeInput')) {
    el('syncCodeInput').addEventListener('change', function () {
      var code = normalizeSyncCode(el('syncCodeInput').value);
      if (code) setSyncRoom(code);
    });
  }
  if (el('btnSyncGen')) {
    el('btnSyncGen').addEventListener('click', function () {
      if (syncRoom() && !confirm('Create a new sync code? Other devices will keep the old code until you update them.')) return;
      setSyncRoom(genSyncCode());
      markSyncDirty();
    });
  }
  if (el('btnSyncCopy')) el('btnSyncCopy').addEventListener('click', copySyncCode);
  if (el('btnSyncNow')) el('btnSyncNow').addEventListener('click', function () {
    if (!syncRoom()) { toast('Enter or generate a sync code first.'); return; }
    pullCloudSync(true);
  });

  updateCloudSyncUI();
  startCloudSyncLoop();
  if (syncRoom()) pullCloudSync(true);

  window.addEventListener('pageshow', function () {
    if (syncRoom() && DATA) pullCloudSync(false);
  });
})();
