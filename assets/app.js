/* ICRS 2026 planner
   Static, no build, no backend. Picks live in localStorage, namespaced per
   profile, and never leave the device. */
'use strict';

var DATA = null;
var TALKS = [];              // flat: {talk, session}
var BY_SID = new Map();
var ABSTRACTS = null;        // sid -> text; lazily fetched (~3.9 MB)
var ABSTRACTS_STATE = 'idle'; // idle | loading | ready | failed
var OPEN_SID = null;         // talk currently shown in the detail dialog
var PICKS = new Set();
var NOTES = {};              // sid -> { text, revisit, contact }
var PROFILE = '';
var VIEW = 'programme';
var DAY = null;
var RENDER_CAP = 600;

var LS_PROFILES = 'icrs2026.profiles';
var LS_CURRENT = 'icrs2026.current';
var LS_PICKS = 'icrs2026.picks.';
var LS_NOTES = 'icrs2026.notes.';
var LS_HELP = 'icrs2026.helpSeen';
var LS_SYNC_ROOM = 'icrs2026.syncRoom';
var LS_SYNC_AT = 'icrs2026.syncAt';
var CROSS_DEVICE_SYNC = /orlando-code\.github\.io$/i.test(location.hostname);
var SYNC_URL = (window.ICRS_SYNC_URL || '').replace(/\/$/, '');
var CLOUD_SYNC = CROSS_DEVICE_SYNC && !!SYNC_URL;
var SYNC_WORDS = ['coral', 'reef', 'tide', 'kelp', 'shell', 'wave', 'fin', 'bay', 'manta', 'nemo'];
var cloudPushTimer = null;
var cloudPullTimer = null;
var cloudBusy = false;
var syncCloudReady = false;
var syncLocalDirty = false;
var NOTE_MAX = 4000;
var NOTE_TAGS = [
  { id: 'revisit', label: 'Revisit' },
  { id: 'contact', label: 'Contact' }
];
var $ = function (s) { return document.querySelector(s); };
var el = function (s) { return document.getElementById(s); };

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
function mins(t) { var p = String(t).split(':'); return +p[0] * 60 + +p[1]; }
function hhmm(t) {
  var p = String(t).split(':'), h = +p[0], m = p[1];
  var ap = h >= 12 ? 'pm' : 'am', h12 = h % 12 || 12;
  return h12 + (m === '00' ? '' : ':' + m) + ap;
}
function toast(msg) {
  var t = el('toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(function () { t.classList.remove('show'); }, 2600);
}
function initials(name) {
  var p = name.trim().split(/\s+/).filter(Boolean);
  if (!p.length) return '?';
  return (p[0][0] + (p.length > 1 ? p[p.length - 1][0] : '')).toUpperCase();
}

/* ---------- abstracts (lazy) ----------
   3.9 MB of text, so it is deliberately NOT part of the first paint or the
   service worker precache. It is fetched once in the background after the
   programme renders; the SW then runtime-caches it for offline use. */
function loadAbstracts() {
  if (ABSTRACTS_STATE === 'loading' || ABSTRACTS_STATE === 'ready') return Promise.resolve(ABSTRACTS);
  ABSTRACTS_STATE = 'loading';
  return fetch('data/abstracts.json')
    .then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .then(function (j) {
      ABSTRACTS = j;
      ABSTRACTS_STATE = 'ready';
      if (OPEN_SID) fillAbstract(OPEN_SID);   // dialog opened before it landed
      return j;
    })
    .catch(function () {
      ABSTRACTS_STATE = 'failed';
      if (OPEN_SID) fillAbstract(OPEN_SID);
      return null;
    });
}

/* Abstracts are author-submitted text. Escape everything first, then re-enable
   ONLY italics: authors wrap species names in <i>…</i> (and a few write the
   malformed <i>X<i>). Treating markers as alternating open/close handles both
   without ever trusting the source markup. */
function abstractHTML(txt) {
  // Split the RAW text on italic tags first, then escape each piece: no source
  // markup ever reaches the DOM, and alternating segments become emphasis.
  var parts = String(txt == null ? '' : txt).split(/<\s*\/?\s*i\s*>/i);
  var out = esc(parts[0]);
  for (var i = 1; i < parts.length; i++) out += (i % 2 ? '<em>' : '</em>') + esc(parts[i]);
  if ((parts.length - 1) % 2) out += '</em>';        // unbalanced <i>X<i> -> close it
  return out.split(/\n{2,}/).map(function (para) {
    return '<p>' + para.replace(/\n/g, '<br>') + '</p>';
  }).join('');
}

/* ---------- storage ---------- */
function readJSON(k, dflt) {
  try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : dflt; }
  catch (e) { return dflt; }
}
function writeJSON(k, v) {
  try { localStorage.setItem(k, JSON.stringify(v)); }
  catch (e) { toast('Could not save — browser storage is full or blocked.'); }
}
function profiles() { return readJSON(LS_PROFILES, []); }
function saveProfiles(list) { writeJSON(LS_PROFILES, list); }
function loadPicks(name) { return new Set(readJSON(LS_PICKS + name, [])); }
function savePicks() {
  if (!PROFILE) return;
  writeJSON(LS_PICKS + PROFILE, Array.from(PICKS));
  markSyncDirty();
}
function loadNotes(name) {
  var raw = readJSON(LS_NOTES + name, {});
  var out = {};
  Object.keys(raw).forEach(function (sid) {
    var n = raw[sid];
    if (!n || typeof n !== 'object') return;
    out[sid] = {
      text: String(n.text || '').slice(0, NOTE_MAX),
      revisit: !!n.revisit,
      contact: !!n.contact
    };
    if (!out[sid].text && !out[sid].revisit && !out[sid].contact) delete out[sid];
  });
  return out;
}
function saveNotes() {
  if (!PROFILE) return;
  var out = {};
  Object.keys(NOTES).forEach(function (sid) {
    var n = NOTES[sid];
    if (!n) return;
    if (n.text || n.revisit || n.contact) out[sid] = n;
  });
  writeJSON(LS_NOTES + PROFILE, out);
  markSyncDirty();
}
function getNote(sid) {
  var n = NOTES[sid];
  if (!n) return { text: '', revisit: false, contact: false };
  return { text: n.text || '', revisit: !!n.revisit, contact: !!n.contact };
}
function hasNote(sid) {
  var n = getNote(sid);
  return !!(n.text || n.revisit || n.contact);
}
function noteFiltersActive() {
  return el('onlyNotes').checked || el('onlyRevisit').checked || el('onlyContact').checked;
}
function matchesNoteFilters(sid, f) {
  if (!f.notes && !f.revisit && !f.contact) return true;
  var n = getNote(sid);
  if (f.notes && n.text) return true;
  if (f.revisit && n.revisit) return true;
  if (f.contact && n.contact) return true;
  return false;
}
function noteFilterEmptyHTML(f) {
  var nf = { notes: f.notes, revisit: f.revisit, contact: f.contact };
  var global = 0;
  TALKS.forEach(function (r) {
    if (matchesNoteFilters(r.talk.sid, nf)) global++;
  });

  if (global === 0) {
    if (f.revisit && f.contact) {
      return '<div class="empty"><h3>No tagged talks yet</h3>' +
        '<p>Open a talk and tap <b>Revisit</b> or <b>Contact</b>, or turn off the filters.</p></div>';
    }
    if (f.revisit) {
      return '<div class="empty"><h3>No talks to revisit</h3>' +
        '<p>Open a talk and tap <b>Revisit</b>, or turn off this filter.</p></div>';
    }
    if (f.contact) {
      return '<div class="empty"><h3>No contacts yet</h3>' +
        '<p>Open a talk and tap <b>Contact</b>, or turn off this filter.</p></div>';
    }
    if (f.notes) {
      return '<div class="empty"><h3>No notes yet</h3>' +
        '<p>Open a talk and write a note, or turn off <b>Notes</b>.</p></div>';
    }
  }

  if (f.revisit && f.contact) {
    return '<div class="empty"><h3>No tagged talks here</h3>' +
      '<p>None of your <b>Revisit</b> or <b>Contact</b> talks match this day or filter.</p></div>';
  }
  if (f.revisit) {
    return '<div class="empty"><h3>No revisits here</h3>' +
      '<p>None of your <b>Revisit</b> talks match this day or filter.</p></div>';
  }
  if (f.contact) {
    return '<div class="empty"><h3>No contacts here</h3>' +
      '<p>None of your <b>Contact</b> talks match this day or filter.</p></div>';
  }
  if (f.notes) {
    return '<div class="empty"><h3>No notes here</h3>' +
      '<p>None of your noted talks match this day or filter.</p></div>';
  }
  return '<div class="empty"><h3>No talks match</h3><p>Try a different day or filter.</p></div>';
}
function programmeEmptyHTML(f) {
  if (f.mine && PICKS.size === 0) {
    return '<div class="empty"><h3>No talks picked yet</h3>' +
      '<p>Open <b>Programme</b> and tap the star next to any talk to build your schedule.</p></div>';
  }
  if (f.notes || f.revisit || f.contact) return noteFilterEmptyHTML(f);
  if (f.mine) {
    return '<div class="empty"><h3>No picks match</h3>' +
      '<p>None of your picks match this day or filter. Try another day or turn off <b>My picks</b>.</p></div>';
  }
  return '<div class="empty"><h3>No talks match</h3><p>Try a different day, room, or search term.</p></div>';
}
function noteBadgesHTML(sid) {
  var n = getNote(sid);
  var bits = [];
  if (n.revisit) bits.push('<span class="note-tag revisit">revisit</span>');
  if (n.contact) bits.push('<span class="note-tag contact">contact</span>');
  if (n.text) bits.push('<span class="note-tag has-note" title="Has personal notes">note</span>');
  return bits.length ? '<div class="note-badges">' + bits.join('') + '</div>' : '';
}
function patchNoteBadges(sid) {
  var html = noteBadgesHTML(sid);
  Array.prototype.forEach.call(document.querySelectorAll('[data-talk="' + sid + '"]'), function (row) {
    var box = row.querySelector('.note-badges');
    if (html) {
      if (box) box.outerHTML = html;
      else {
        var host = row.querySelector('.t-body') || row.querySelector('.m-body');
        if (host) host.insertAdjacentHTML('beforeend', html);
      }
    } else if (box) box.remove();
  });
}
function setProfile(name) {
  PROFILE = name;
  try { localStorage.setItem(LS_CURRENT, name); } catch (e) {}
  PICKS = loadPicks(name);
  NOTES = loadNotes(name);
  el('profileName').textContent = name;
  el('profileInitials').textContent = initials(name);
  updateCount();
}

/* ---------- data ---------- */
function flatten() {
  TALKS = []; BY_SID = new Map();
  DATA.sessions.forEach(function (s) {
    s.talks.forEach(function (t) {
      var rec = { talk: t, session: s };
      TALKS.push(rec);
      BY_SID.set(t.sid, rec);
    });
  });
}

function roomLabel(id) {
  var r = DATA.rooms.find(function (x) { return x.id === id; });
  return r ? r.label : (id || '');
}
function roomLevel(id) {
  var r = DATA.rooms.find(function (x) { return x.id === id; });
  return r && r.level ? r.level : '';
}

/* ---------- filters ---------- */
function currentFilters() {
  return {
    q: el('q').value.trim().toLowerCase(),
    room: el('fRoom').value,
    theme: el('fTheme').value,
    mine: el('onlyMine').checked,
    notes: el('onlyNotes').checked,
    revisit: el('onlyRevisit').checked,
    contact: el('onlyContact').checked
  };
}
function matches(rec, f) {
  var s = rec.session, t = rec.talk;
  if (f.room && s.room !== f.room) return false;
  if (f.theme && String(s.theme) !== f.theme) return false;
  if (f.mine && !PICKS.has(t.sid)) return false;
  if (!matchesNoteFilters(t.sid, f)) return false;
  if (f.q) {
    var note = getNote(t.sid);
    var hay = (t.title + ' ' + t.presenter + ' ' + (t.affiliation || '') + ' ' +
               (t.authors || []).join(' ') + ' ' + s.title + ' ' + (s.code || '') +
               ' ' + note.text).toLowerCase();
    if (hay.indexOf(f.q) === -1) return false;
  }
  return true;
}
function hi(text, q) {
  var e = esc(text);
  if (!q) return e;
  var i = e.toLowerCase().indexOf(esc(q).toLowerCase());
  if (i === -1) return e;
  return e.slice(0, i) + '<mark>' + e.slice(i, i + q.length) + '</mark>' + e.slice(i + q.length);
}

/* ---------- render: programme ---------- */
function renderProgramme() {
  var f = currentFilters();
  var recs = TALKS.filter(function (r) {
    if (DAY !== 'all' && r.session.date !== DAY) return false;
    return matches(r, f);
  });

  // Venue-wide items (registration, teas, lunches, socials) are context, not
  // choices, so they only show when the user is not narrowing the list down.
  var plain = !f.q && !f.room && !f.theme && !f.mine && !f.notes && !f.revisit && !f.contact;
  var evts = plain ? DATA.events.filter(function (e) {
    return DAY === 'all' || e.date === DAY;
  }) : [];

  if (!recs.length && (f.mine || f.notes || f.revisit || f.contact || !evts.length)) {
    el('content').innerHTML = programmeEmptyHTML(f);
    return;
  }

  // group by session, keep sessions ordered by (date, start, room)
  var map = new Map();
  recs.forEach(function (r) {
    var k = r.session.id;
    if (!map.has(k)) map.set(k, { s: r.session, talks: [] });
    map.get(k).talks.push(r.talk);
  });
  var groups = Array.from(map.values()).sort(function (a, b) {
    return (a.s.date + a.s.start).localeCompare(b.s.date + b.s.start) ||
           mins(a.s.start) - mins(b.s.start) ||
           String(a.s.room).localeCompare(String(b.s.room));
  });

  // group sessions into time blocks
  var blocks = new Map();
  groups.forEach(function (g) {
    var k = g.s.date + ' ' + g.s.start + '-' + g.s.end;
    if (!blocks.has(k)) blocks.set(k, []);
    blocks.get(k).push(g);
  });

  // interleave session blocks and venue bands in true chronological order
  var entries = [];
  blocks.forEach(function (gs) {
    entries.push({ type: 'block', date: gs[0].s.date, start: gs[0].s.start, gs: gs });
  });
  evts.forEach(function (e) {
    entries.push({ type: 'event', date: e.date, start: e.start || '00:00', e: e });
  });
  entries.sort(function (a, b) {
    return a.date.localeCompare(b.date) || mins(a.start) - mins(b.start);
  });

  var shown = 0, capped = false, html = [];
  entries.forEach(function (en) {
    if (capped) return;
    if (en.type === 'event') { html.push(bandHTML(en.e)); return; }
    var gs = en.gs, s0 = gs[0].s;
    var n = gs.reduce(function (a, g) { return a + g.talks.length; }, 0);
    var dayLabel = DAY === 'all' ? (dayShort(s0.date) + ' &middot; ') : '';
    html.push('<section class="block"><div class="block-head">' +
      '<span class="block-time">' + dayLabel + hhmm(s0.start) + ' – ' + hhmm(s0.end) + '</span>' +
      '<span class="block-line"></span><span class="block-n">' + n + ' talk' + (n === 1 ? '' : 's') + '</span>' +
      '</div><div class="grid">');
    gs.forEach(function (g) {
      if (capped) return;
      html.push(cardHTML(g, f));
      shown += g.talks.length;
      if (shown >= RENDER_CAP) capped = true;
    });
    html.push('</div></section>');
  });

  if (capped) {
    html.push('<div class="note">Showing the first ' + shown + ' of ' + recs.length +
      ' matching talks. Narrow the search, room, or day to see the rest.</div>');
  }
  el('content').innerHTML = html.join('');
}

function bandHTML(e) {
  var when = e.start ? hhmm(e.start) + (e.end ? ' – ' + hhmm(e.end) : '') : '';
  var loc = (e.location || '').replace(/\s*\|\s*/g, ' · ').replace(/ · NZICC$/, '');
  var k = /tea|lunch/i.test(e.title) ? 'break' :
          /function|welcome|dinner|social|party/i.test(e.title) ? 'social' : 'info';
  return '<div class="band" data-b="' + k + '">' +
    '<span class="band-time">' + esc(when) + '</span>' +
    '<span class="band-title">' + esc(e.title) + '</span>' +
    (loc ? '<span class="band-loc">' + esc(loc) + '</span>' : '') + '</div>';
}

function dayShort(date) {
  var d = DATA.days.find(function (x) { return x.date === date; });
  return d ? d.label.slice(0, 3) + ' ' + (+date.slice(8, 10)) : date;
}

function cardHTML(g, f) {
  var s = g.s;
  var code = s.code ? s.code : (s.kind === 'poster' ? 'POSTER' : s.kind === 'plenary' ? 'PLENARY' : 'EVENT');
  var themeTag = s.theme ? '#' + s.theme : '';
  var out = ['<article class="card" data-kind="' + s.kind + '"><div class="card-head">' +
    '<span class="code">' + esc(code) + '</span><div style="min-width:0">' +
    '<h3 class="card-title">' + hi(s.title, f.q) + '</h3><div class="card-meta">' +
    (s.room ? '<span class="room">' + esc(roomLabel(s.room)) + (roomLevel(s.room) ? ' &middot; ' + esc(roomLevel(s.room)) : '') + '</span>' : '') +
    (themeTag ? '<span>' + themeTag + '</span>' : '') +
    '</div></div></div>'];
  g.talks.forEach(function (t) {
    var on = PICKS.has(t.sid);
    out.push('<div class="talk' + (on ? ' is-on' : '') + '" data-talk="' + t.sid +
      '" tabindex="0" role="button" aria-label="Open details">' +
      '<span class="t-time">' + hhmm(t.start) + '</span>' +
      '<div class="t-body"><div class="t-title">' + hi(t.title, f.q) + '</div>' +
      '<div class="t-who">' + hi((t.honorific ? t.honorific + ' ' : '') + t.presenter, f.q) +
      (t.affiliation ? ' <span class="aff">&middot; ' + hi(t.affiliation, f.q) + '</span>' : '') +
      '</div>' + noteBadgesHTML(t.sid) + '</div>' +
      '<button class="star" data-sid="' + t.sid + '" aria-pressed="' + on + '" ' +
      'aria-label="' + (on ? 'Remove from' : 'Add to') + ' my schedule" title="' + (on ? 'Remove from' : 'Add to') + ' my schedule">' +
      starSVG(on) + '</button></div>');
  });
  out.push('</article>');
  return out.join('');
}
function starSVG(on) {
  return '<svg viewBox="0 0 24 24" width="19" height="19">' +
    '<path d="M12 3.6l2.5 5.1 5.6.8-4 3.9 1 5.6-5.1-2.7-5.1 2.7 1-5.6-4-3.9 5.6-.8z" ' +
    'fill="' + (on ? 'currentColor' : 'none') + '" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>';
}

/* ---------- render: my schedule ---------- */
function myPicks() {
  var out = [];
  PICKS.forEach(function (sid) {
    var r = BY_SID.get(sid);
    if (r) out.push(r);
  });
  out.sort(function (a, b) {
    return (a.session.date).localeCompare(b.session.date) ||
           mins(a.talk.start) - mins(b.talk.start);
  });
  return out;
}
function notedTalks() {
  var out = [];
  Object.keys(NOTES).forEach(function (sid) {
    if (!hasNote(sid)) return;
    var r = BY_SID.get(sid);
    if (r) out.push(r);
  });
  out.sort(function (a, b) {
    return (a.session.date).localeCompare(b.session.date) ||
           mins(a.talk.start) - mins(b.talk.start);
  });
  return out;
}
function profileSlug() {
  return (PROFILE.toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'profile');
}
function downloadBlob(filename, content, type) {
  var blob = new Blob([content], { type: type });
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
}

/* Two picks clash when they overlap in time on the same day. With 14 rooms in
   parallel this is easy to do by accident, so it is surfaced per row. */
function findClashes(list) {
  var clash = new Map();
  for (var i = 0; i < list.length; i++) {
    for (var j = i + 1; j < list.length; j++) {
      var a = list[i], b = list[j];
      if (a.session.date !== b.session.date) continue;
      if (mins(a.talk.start) < mins(b.talk.end) && mins(b.talk.start) < mins(a.talk.end)) {
        if (!clash.has(a.talk.sid)) clash.set(a.talk.sid, []);
        if (!clash.has(b.talk.sid)) clash.set(b.talk.sid, []);
        clash.get(a.talk.sid).push(b);
        clash.get(b.talk.sid).push(a);
      }
    }
  }
  return clash;
}

function renderMine() {
  var list = myPicks();
  if (!list.length) {
    el('content').innerHTML = '<div class="empty"><h3>No talks picked yet</h3>' +
      '<p>Open <b>Programme</b> and tap the star next to any talk to build your schedule.</p></div>';
    return;
  }
  var clash = findClashes(list);
  var html = [];
  if (clash.size) {
    html.push('<div class="note"><b>' + clash.size + ' of your ' + list.length +
      ' picks overlap.</b> They are marked below — you cannot attend both.</div>');
  }
  var lastDay = null, prev = null;
  list.forEach(function (r) {
    if (r.session.date !== lastDay) {
      lastDay = r.session.date; prev = null;
      var d = DATA.days.find(function (x) { return x.date === lastDay; });
      var n = list.filter(function (x) { return x.session.date === lastDay; }).length;
      html.push('<h2 class="day-head">' + esc(d ? d.label + ', ' + d.date.slice(8) + ' July' : lastDay) +
        ' <span class="pill">' + n + ' talk' + (n === 1 ? '' : 's') + '</span></h2>');
    } else if (prev) {
      var gap = mins(r.talk.start) - mins(prev.talk.end);
      if (gap >= 20) html.push('<p class="gap-note">' + gap + ' min gap</p>');
    }
    var c = clash.get(r.talk.sid);
    html.push('<div class="mine-row' + (c ? ' clash' : '') + '" data-talk="' + r.talk.sid +
      '" tabindex="0" role="button" aria-label="Open details">' +
      '<span class="m-time">' + hhmm(r.talk.start) + '–' + hhmm(r.talk.end) + '</span>' +
      '<div class="m-body"><div class="m-title">' + esc(r.talk.title) + '</div>' +
      '<div class="m-meta">' + esc(roomLabel(r.session.room)) +
      (roomLevel(r.session.room) ? ' &middot; ' + esc(roomLevel(r.session.room)) : '') +
      (r.session.code ? ' &middot; ' + esc(r.session.code) : '') +
      ' &middot; ' + esc((r.talk.honorific ? r.talk.honorific + ' ' : '') + r.talk.presenter) + '</div>' +
      (c ? '<div class="clash-tag">⚠ Overlaps ' + esc(c[0].talk.title.slice(0, 40)) +
           (c.length > 1 ? ' +' + (c.length - 1) + ' more' : '') + '</div>' : '') +
      noteBadgesHTML(r.talk.sid) +
      '</div>' +
      '<button class="star" data-sid="' + r.talk.sid + '" aria-pressed="true" aria-label="Remove from my schedule">' +
      starSVG(true) + '</button></div>');
    prev = r;
  });
  el('content').innerHTML = html.join('');
}

/* ---------- talk detail ---------- */
function dayLabelOf(date) {
  var d = DATA.days.find(function (x) { return x.date === date; });
  return d ? d.label + ', ' + (+date.slice(8, 10)) + ' July' : date;
}

function openTalk(sid) {
  var rec = BY_SID.get(sid);
  if (!rec) return;
  OPEN_SID = sid;
  var t = rec.talk, s = rec.session;

  el('talkTitle').innerHTML = esc(t.title);

  // room + session are the facts you want at a glance when deciding where to go
  var facts = [];
  if (s.room) {
    facts.push('<span class="fact fact-room">' + esc(roomLabel(s.room)) +
      (roomLevel(s.room) ? ' <i>· ' + esc(roomLevel(s.room)) + '</i>' : '') + '</span>');
  }
  if (s.code) {
    facts.push('<span class="fact">Session ' + esc(s.code) +
      (s.theme ? ' · #' + s.theme : '') + '</span>');
  } else if (s.kind !== 'session') {
    facts.push('<span class="fact">' + esc(s.kind) + '</span>');
  }
  facts.push('<span class="fact">' + esc(dayLabelOf(s.date)) + ' · ' +
    hhmm(t.start) + '–' + hhmm(t.end) + '</span>');
  el('talkFacts').innerHTML = facts.join('');

  var body = [];
  if (s.code) {
    body.push('<div class="dl"><dt>Session</dt><dd>' + esc(s.code) +
      (s.theme ? ' · #' + s.theme : '') + ' — ' + esc(s.title) + '</dd></div>');
  }
  if (s.location) {
    body.push('<div class="dl"><dt>Where</dt><dd>' +
      esc(s.location.replace(/\s*\|\s*/g, ' · ')) + '</dd></div>');
  }
  var who = (t.honorific ? t.honorific + ' ' : '') + t.presenter;
  var extra = [t.position, t.affiliation].filter(Boolean).join(', ');
  body.push('<div class="dl"><dt>Presenter</dt><dd><b>' + esc(who) + '</b>' +
    (extra ? '<br><span class="muted">' + esc(extra) + '</span>' : '') + '</dd></div>');
  if (t.authors && t.authors.length > 1) {
    body.push('<div class="dl"><dt>Authors</dt><dd class="muted">' +
      esc(t.authors.join(', ')) + '</dd></div>');
  }
  body.push('<div class="my-notes" id="noteWrap">' +
    '<h3>My notes</h3>' +
    '<div class="note-tags" role="group" aria-label="Note tags">' +
    NOTE_TAGS.map(function (t) {
      return '<button type="button" class="note-tag-btn" data-tag="' + t.id + '" aria-pressed="false">' +
        esc(t.label) + '</button>';
    }).join('') +
    '</div>' +
    '<textarea id="noteText" rows="4" maxlength="' + NOTE_MAX + '" ' +
    'placeholder="Your thoughts on this talk..."></textarea>' +
    '<p class="note-hint"><b>Notes stay on this device.</b> They are lost if you clear browser data and are not sent via share links. Use <b>Notes (.md)</b> or <b>Backup</b> in My schedule to keep a copy.</p>' +
    '</div>');
  body.push('<div id="absWrap" class="abstract"><h3>Abstract</h3><div id="absText"></div></div>');
  el('talkBody').innerHTML = body.join('');

  var dlg = el('talkDlg');
  if (!dlg.open) dlg.showModal();       // open before filling: fillAbstract checks .open
  syncTalkStar();
  fillAbstract(sid);
  fillNoteFields(sid);
  if (ABSTRACTS_STATE === 'idle') loadAbstracts();
  el('talkBody').scrollTop = 0;
}

/* Closing is explicit rather than relying on the dialog 'close'/'cancel' events:
   some engines (including Electron shells) never fire them, which would leave
   OPEN_SID pointing at a talk that is no longer on screen. */
function closeTalk() {
  saveOpenNote();
  OPEN_SID = null;
  var dlg = el('talkDlg');
  if (dlg.open) dlg.close();
}

function fillNoteFields(sid) {
  var ta = el('noteText');
  if (!ta) return;
  var n = getNote(sid);
  ta.value = n.text;
  Array.prototype.forEach.call(document.querySelectorAll('.note-tag-btn'), function (btn) {
    var on = !!n[btn.dataset.tag];
    btn.classList.toggle('is-on', on);
    btn.setAttribute('aria-pressed', String(on));
  });
}

function readNoteFromDialog() {
  var ta = el('noteText');
  if (!ta) return { text: '', revisit: false, contact: false };
  var n = { text: ta.value.trim().slice(0, NOTE_MAX), revisit: false, contact: false };
  Array.prototype.forEach.call(document.querySelectorAll('.note-tag-btn.is-on'), function (btn) {
    n[btn.dataset.tag] = true;
  });
  return n;
}

function noteFilterMatchChanged(sid, had) {
  return noteFiltersActive() && had !== matchesNoteFilters(sid, currentFilters());
}
function saveOpenNote() {
  if (!OPEN_SID) return;
  var sid = OPEN_SID;
  var had = matchesNoteFilters(sid, currentFilters());
  var n = readNoteFromDialog();
  if (n.text || n.revisit || n.contact) NOTES[sid] = n;
  else delete NOTES[sid];
  saveNotes();
  patchNoteBadges(sid);
  if (noteFilterMatchChanged(sid, had)) render();
}

function toggleNoteTag(btn) {
  if (!OPEN_SID) return;
  var tag = btn.dataset.tag;
  var had = matchesNoteFilters(OPEN_SID, currentFilters());
  var n = readNoteFromDialog();
  n[tag] = !n[tag];
  if (n.text || n.revisit || n.contact) NOTES[OPEN_SID] = n;
  else delete NOTES[OPEN_SID];
  saveNotes();
  btn.classList.toggle('is-on', n[tag]);
  btn.setAttribute('aria-pressed', String(n[tag]));
  patchNoteBadges(OPEN_SID);
  if (noteFilterMatchChanged(OPEN_SID, had)) render();
}

function fillAbstract(sid) {
  var box = el('absText');
  if (!box || OPEN_SID !== sid || !el('talkDlg').open) return;
  var t = (BY_SID.get(sid) || {}).talk;
  if (t && !t.hasAbstract) {
    box.innerHTML = '<p class="muted">No abstract was published for this item.</p>';
    return;
  }
  if (ABSTRACTS_STATE === 'ready') {
    var txt = ABSTRACTS[sid];
    box.innerHTML = txt ? abstractHTML(txt)
      : '<p class="muted">No abstract was published for this item.</p>';
  } else if (ABSTRACTS_STATE === 'failed') {
    box.innerHTML = '<p class="muted">Abstract could not be loaded. Check your connection and reopen this talk.</p>';
  } else {
    box.innerHTML = '<p class="muted">Loading abstract…</p>';
  }
}

function syncTalkStar() {
  var on = PICKS.has(OPEN_SID);
  var b = el('talkStar');
  b.setAttribute('aria-pressed', String(on));
  b.classList.toggle('btn-primary', !on);
  b.innerHTML = starSVG(on) + '<span>' + (on ? 'In my schedule' : 'Add to my schedule') + '</span>';
}

/* ---------- export & backup ---------- */
function buildNotesMarkdown() {
  var list = notedTalks();
  if (!list.length) return null;
  var lines = [
    '# ICRS 2026 notes — ' + PROFILE,
    '',
    'Exported ' + new Date().toISOString().slice(0, 10) + '.',
    ''
  ];
  list.forEach(function (r) {
    var t = r.talk, s = r.session, note = getNote(t.sid);
    var tags = [];
    if (note.revisit) tags.push('revisit');
    if (note.contact) tags.push('contact');
    lines.push('## ' + dayLabelOf(s.date) + ' · ' + hhmm(t.start) + '–' + hhmm(t.end) +
      ' · ' + roomLabel(s.room));
    lines.push('');
    lines.push('**' + t.title + '**');
    lines.push('');
    lines.push((t.honorific ? t.honorific + ' ' : '') + t.presenter +
      (s.code ? ' · ' + s.code : ''));
    if (tags.length) lines.push('', 'Tags: ' + tags.join(', '));
    if (note.text) lines.push('', note.text);
    lines.push('', '---', '');
  });
  return lines.join('\n');
}
function downloadNotesMd() {
  var txt = buildNotesMarkdown();
  if (!txt) { toast('No notes to export yet.'); return; }
  downloadBlob('icrs2026-' + profileSlug() + '-notes.md', txt, 'text/markdown;charset=utf-8');
  toast('Notes exported (' + notedTalks().length + ' talks).');
}

function buildBackup() {
  var profs = profiles();
  var picks = {}, notes = {};
  profs.forEach(function (n) {
    picks[n] = readJSON(LS_PICKS + n, []);
    notes[n] = readJSON(LS_NOTES + n, {});
  });
  return {
    v: 1,
    app: 'icrs2026',
    exported: new Date().toISOString().slice(0, 10),
    current: PROFILE,
    profiles: profs,
    picks: picks,
    notes: notes
  };
}
function downloadBackup() {
  var profs = profiles();
  if (!profs.length) { toast('Create a profile first.'); return; }
  downloadBlob('icrs2026-backup.json', JSON.stringify(buildBackup(), null, 2), 'application/json');
  toast('Backup saved (' + profs.length + ' profile' + (profs.length === 1 ? '' : 's') + ').');
}
function applyBackup(data, opts) {
  opts = opts || {};
  if (!data || data.v !== 1 || data.app !== 'icrs2026' || !Array.isArray(data.profiles)) {
    if (!opts.silent) toast('That file is not a valid ICRS backup.');
    return false;
  }
  var n = data.profiles.length;
  if (!n) {
    if (!opts.silent) toast('Backup has no profiles.');
    return false;
  }
  var list = profiles();
  data.profiles.forEach(function (name) {
    if (list.indexOf(name) === -1) list.push(name);
    writeJSON(LS_PICKS + name, data.picks[name] || []);
    writeJSON(LS_NOTES + name, data.notes[name] || {});
  });
  saveProfiles(list);
  if (data.current && list.indexOf(data.current) !== -1) setProfile(data.current);
  else if (PROFILE && list.indexOf(PROFILE) !== -1) setProfile(PROFILE);
  else setProfile(list[0]);
  updateCount();
  render();
  if (!opts.silent) {
    toast('Restored ' + n + ' profile' + (n === 1 ? '' : 's') + '.');
  }
  return true;
}
function restoreBackup(data) {
  if (!data || data.v !== 1 || data.app !== 'icrs2026' || !Array.isArray(data.profiles)) {
    toast('That file is not a valid ICRS backup.');
    return;
  }
  var n = data.profiles.length;
  if (!n) { toast('Backup has no profiles.'); return; }
  if (!confirm('Restore picks and notes for ' + n + ' profile' + (n === 1 ? '' : 's') +
      ' from this backup? Existing data for those names will be replaced.')) return;
  applyBackup(data);
  markSyncDirty();
}
function pickRestoreFile() {
  el('restoreFile').click();
}

/* ---------- share & cloud sync (orlando-code site) ---------- */
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
function markSyncDirty() {
  syncLocalDirty = true;
  scheduleCloudPush();
}
function fetchCloudRoom(room) {
  return fetch(SYNC_URL + '/' + encodeURIComponent(room), { cache: 'no-store' })
    .then(function (r) {
      if (r.status === 404) return null;
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
}
function shouldApplyRemote(remote) {
  if (!remote || !remote.at || !remote.data) return false;
  if (remote.at > syncAt()) return true;
  var rs = backupStats(remote.data);
  var ls = backupStats(buildBackup());
  return rs.picks + rs.notes > ls.picks + ls.notes;
}
function applyRemote(remote, opts) {
  opts = opts || {};
  if (!remote || !remote.at || !remote.data) return false;
  if (!opts.force && !shouldApplyRemote(remote)) return false;
  cloudBusy = true;
  applyBackup(remote.data, { silent: true });
  setSyncAt(remote.at);
  syncLocalDirty = false;
  cloudBusy = false;
  syncCloudReady = true;
  updateCloudSyncUI();
  if (opts.toast) toast('Synced from cloud.');
  return true;
}
function cloudPayload() {
  return { at: Date.now(), data: buildBackup() };
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
      if (remote && shouldApplyRemote(remote)) {
        applyRemote(remote, { silent: true });
        return;
      }
      var payload = cloudPayload();
      if (remote && remote.at >= payload.at) payload.at = remote.at + 1;
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
      var applied = applyRemote(remote, { force: force, toast: force });
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
  if (!CROSS_DEVICE_SYNC) return;
  if (panel) panel.hidden = false;
  if (note) {
    note.innerHTML = 'Picks and notes are saved in this browser and <b>synced automatically</b> when you use the same sync code on another device. Clearing site data removes them locally — your cloud copy stays until you change the code.';
  }
  var input = el('syncCodeInput');
  if (input && document.activeElement !== input) input.value = syncRoom();
  var hint = el('cloudSyncHint');
  if (hint) {
    hint.textContent = SYNC_URL
      ? 'Enter the same code on each device (copy from your laptop). Tap Sync now if picks or notes look stale.'
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
function buildShareHash() {
  if (!PROFILE) return '';
  var parts = ['n=' + encodeURIComponent(PROFILE)];
  if (PICKS.size) parts.push('s=' + Array.from(PICKS).join(''));
  return parts.join('&');
}
function shareURL() {
  if (!PROFILE) return siteURL();
  var h = buildShareHash();
  return location.origin + location.pathname + (h ? '#' + h : '');
}
function copyShare() {
  if (!PROFILE) { toast('Set up a profile first.'); return; }
  if (!PICKS.size) { toast('Star a talk first.'); return; }
  copyText(shareURL(), 'Share link copied — open on your other device for starred talks.');
}
function siteURL() {
  return location.origin + location.pathname;
}
function copyText(url, okMsg) {
  var done = function () { toast(okMsg); };
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(url).then(done, function () { prompt('Copy this link:', url); });
  } else {
    prompt('Copy this link:', url);
  }
}
function copySiteLink() {
  copyText(siteURL(), 'Site link copied.');
}
function copySyncCode() {
  var code = syncRoom();
  if (!code) { toast('Enter or generate a sync code first.'); return; }
  copyText(code, 'Sync code copied — paste it on your other device.');
}
var QR_LOAD = null;
function loadQR() {
  if (typeof qrcode === 'function') return Promise.resolve();
  if (QR_LOAD) return QR_LOAD;
  QR_LOAD = new Promise(function (resolve, reject) {
    var s = document.createElement('script');
    s.src = 'assets/qrcode.js';
    s.onload = resolve;
    s.onerror = function () { QR_LOAD = null; reject(new Error('load failed')); };
    document.body.appendChild(s);
  });
  return QR_LOAD;
}
function renderShare() {
  var url = siteURL();
  var lead = 'Scan this code to open the ICRS 2026 planner on another phone or laptop.';
  el('content').innerHTML =
    '<div class="qr-panel">' +
      '<p class="qr-lead">' + lead + '</p>' +
      '<div class="qr-box" id="qrBox" aria-busy="true">Loading QR code…</div>' +
      '<p class="qr-url" id="qrUrl">' + esc(url) + '</p>' +
      '<button id="btnCopySite" class="btn" type="button">Copy link</button>' +
    '</div>';
  el('btnCopySite').addEventListener('click', copySiteLink);
  loadQR().then(function () {
    var qr = qrcode(0, 'M');
    qr.addData(url);
    qr.make();
    el('qrBox').innerHTML = qr.createSvgTag({
      cellSize: 8,
      margin: 2,
      alt: { text: 'QR code linking to ' + url }
    });
    el('qrBox').removeAttribute('aria-busy');
  }).catch(function () {
    el('qrBox').innerHTML = '<p class="qr-fail">Could not load the QR code. Use the link below instead.</p>';
    el('qrBox').removeAttribute('aria-busy');
  });
}
function importFromHash(opts) {
  opts = opts || {};
  var h = location.hash || '';
  if (!h || h.length < 3) return false;

  var ms = h.match(/[#&]s=([0-9a-fA-F]*)/);
  var mn = h.match(/[#&]n=([^&]*)/);
  if (!ms || !ms[1]) return false;

  var name = '';
  if (mn) { try { name = decodeURIComponent(mn[1]); } catch (e) { name = ''; } }
  var who = (name || PROFILE || 'Shared').slice(0, 40);
  var valid = (ms[1].match(/.{1,8}/g) || []).filter(function (s) { return BY_SID.has(s); });
  if (!valid.length) {
    toast('That link had no talks we recognise.');
    return false;
  }

  if (!opts.quiet) {
    var msg = 'Import ' + valid.length + ' talk' + (valid.length === 1 ? '' : 's') +
      ' into "' + who + '"?' +
      (valid.length < (ms[1].match(/.{1,8}/g) || []).length
        ? '\n\n(Some entries are not in the current programme and will be skipped.)' : '');
    if (!window.confirm(msg)) return false;
  }

  var list = profiles();
  if (list.indexOf(who) === -1) { list.push(who); saveProfiles(list); }
  if (who !== PROFILE) setProfile(who);
  PICKS = new Set(valid);
  writeJSON(LS_PICKS + PROFILE, Array.from(PICKS));
  updateCount();
  history.replaceState(null, '', location.pathname + location.search);
  markSyncDirty();

  if (!opts.quiet) {
    toast('Imported ' + valid.length + ' talk' + (valid.length === 1 ? '' : 's') + '.');
  }
  return true;
}

/* ---------- profile dialog ---------- */
function openProfile(first) {
  var dlg = el('profileDlg');
  el('dlgTitle').textContent = first ? "Who's planning?" : 'Your profile';
  el('nameInput').value = first ? '' : PROFILE;
  el('dlgCancel').style.display = first && !profiles().length ? 'none' : '';
  renderProfileList();
  dlg.showModal();
  setTimeout(function () { el('nameInput').focus(); }, 30);
}
function saveProfileFromInput() {
  var name = el('nameInput').value.trim().replace(/\s+/g, ' ').slice(0, 40);
  if (!name) { el('nameInput').focus(); toast('Enter a name to continue.'); return; }
  var list = profiles();
  if (PROFILE && PROFILE !== name && list.indexOf(PROFILE) !== -1) {
    // renaming the current profile carries its picks across
    var old = PROFILE;
    if (list.indexOf(name) === -1) list[list.indexOf(old)] = name;
    else list = list.filter(function (x) { return x !== old; });
    saveProfiles(list);
    writeJSON(LS_PICKS + name, Array.from(PICKS));
    writeJSON(LS_NOTES + name, NOTES);
    try { localStorage.removeItem(LS_PICKS + old); } catch (e) {}
    try { localStorage.removeItem(LS_NOTES + old); } catch (e) {}
  } else if (list.indexOf(name) === -1) {
    list.push(name);
    saveProfiles(list);
  }
  setProfile(name);
  el('profileDlg').close();
  render();
  markSyncDirty();
  setTimeout(maybeShowHelp, 80);
}

/* ---------- how-to guide ---------- */
function openHelp() {
  try { localStorage.setItem(LS_HELP, '1'); } catch (e) {}
  var dlg = el('helpDlg');
  if (!dlg.open) dlg.showModal();
}
function closeHelp() {
  var dlg = el('helpDlg');
  if (dlg.open) dlg.close();
}
function maybeShowHelp() {
  var seen;
  try { seen = localStorage.getItem(LS_HELP); } catch (e) {}
  if (!seen && !el('helpDlg').open && !el('profileDlg').open) openHelp();
}

function renderProfileList() {
  var list = profiles();
  var box = el('profileList');
  if (list.length < 1) { box.innerHTML = ''; return; }
  box.innerHTML = list.map(function (n) {
    var count = readJSON(LS_PICKS + n, []).length;
    return '<div class="profile-row' + (n === PROFILE ? ' is-on' : '') + '" data-name="' + esc(n) + '">' +
      '<span class="avatar">' + esc(initials(n)) + '</span>' +
      '<span class="n">' + esc(n) + '</span>' +
      '<span style="font-size:11px;color:var(--ink-3)">' + count + '</span>' +
      '<button type="button" class="del" data-del="' + esc(n) + '" aria-label="Delete profile ' + esc(n) + '">&times;</button></div>';
  }).join('');
}

/* ---------- misc ---------- */
function updateCount() {
  var c = el('pickCount');
  c.textContent = PICKS.size;
  c.setAttribute('data-zero', PICKS.size ? '0' : '1');
}
function render() {
  if (VIEW === 'mine') renderMine();
  else if (VIEW === 'share') renderShare();
  else renderProgramme();
}
function toggle(sid) {
  if (PICKS.has(sid)) PICKS.delete(sid); else PICKS.add(sid);
  savePicks();
  updateCount();

  // A full re-render of a day is ~600 rows; doing that on every star tap feels
  // sluggish on a phone. Patch the affected rows in place instead, and only
  // re-render when the toggle actually changes which rows belong on screen.
  if (VIEW === 'mine' || el('onlyMine').checked) { render(); return; }

  var on = PICKS.has(sid);
  var label = (on ? 'Remove from' : 'Add to') + ' my schedule';
  Array.prototype.forEach.call(document.querySelectorAll('.star[data-sid="' + sid + '"]'), function (btn) {
    btn.setAttribute('aria-pressed', String(on));
    btn.setAttribute('aria-label', label);
    btn.title = label;
    btn.innerHTML = starSVG(on);
    var row = btn.closest('.talk');
    if (row) row.classList.toggle('is-on', on);
  });
}

function buildFilters() {
  el('fRoom').innerHTML = '<option value="">All rooms</option>' +
    DATA.rooms.map(function (r) {
      return '<option value="' + esc(r.id) + '">' + esc(r.label) + (r.level ? ' (' + esc(r.level) + ')' : '') + '</option>';
    }).join('');

  var themes = new Map();
  DATA.sessions.forEach(function (s) {
    if (s.theme && !themes.has(s.theme)) themes.set(s.theme, s.title);
  });
  var arr = Array.from(themes.entries()).sort(function (a, b) { return a[1].localeCompare(b[1]); });
  el('fTheme').innerHTML = '<option value="">All themes</option>' +
    arr.map(function (t) {
      return '<option value="' + t[0] + '">#' + t[0] + ' ' + esc(t[1].slice(0, 62)) + (t[1].length > 62 ? '…' : '') + '</option>';
    }).join('');

  el('days').innerHTML = DATA.days.map(function (d) {
    var n = TALKS.filter(function (r) { return r.session.date === d.date; }).length;
    var ev = DATA.events.filter(function (e) { return e.date === d.date; }).length;
    var sub = n ? n + ' talks' : (ev ? ev + ' events' : '—');
    return '<button class="day-tab" data-day="' + d.date + '"><span>' + esc(d.label.slice(0, 3)) + ' ' +
      (+d.date.slice(8, 10)) + '</span><small>' + sub + '</small></button>';
  }).join('') + '<button class="day-tab" data-day="all"><span>All</span><small>' + TALKS.length + ' talks</small></button>';
}

function setDay(d) {
  DAY = d;
  Array.prototype.forEach.call(document.querySelectorAll('.day-tab'), function (b) {
    b.classList.toggle('is-on', b.dataset.day === d);
  });
  render();
}
function setView(v) {
  VIEW = v;
  Array.prototype.forEach.call(document.querySelectorAll('.view-tab'), function (b) {
    var on = b.dataset.view === v;
    b.classList.toggle('is-on', on);
    b.setAttribute('aria-selected', on);
  });
  el('programmeControls').hidden = v !== 'programme';
  el('mineControls').hidden = v !== 'mine';
  window.scrollTo(0, 0);
  render();
}

function wire() {
  document.addEventListener('click', function (e) {
    // star first: tapping it must never also open the detail dialog
    var star = e.target.closest('.star');
    if (star) { e.stopPropagation(); toggle(star.dataset.sid); return; }
    var row = e.target.closest('[data-talk]');
    if (row) { openTalk(row.dataset.talk); return; }
    var tab = e.target.closest('.day-tab');
    if (tab) { setDay(tab.dataset.day); return; }
    var vt = e.target.closest('.view-tab');
    if (vt) { setView(vt.dataset.view); return; }
    var del = e.target.closest('[data-del]');
    if (del) {
      e.preventDefault();
      var n = del.dataset.del;
      if (confirm('Delete profile "' + n + '" and its picks from this browser?')) {
        var list = profiles().filter(function (x) { return x !== n; });
        saveProfiles(list);
        try { localStorage.removeItem(LS_PICKS + n); } catch (err) {}
        try { localStorage.removeItem(LS_NOTES + n); } catch (err) {}
        if (n === PROFILE) {
          if (list.length) setProfile(list[0]);
          else { PROFILE = ''; PICKS = new Set(); el('profileDlg').close(); openProfile(true); return; }
        }
        renderProfileList(); render();
      }
      return;
    }
    var row = e.target.closest('.profile-row');
    if (row) { e.preventDefault(); setProfile(row.dataset.name); el('profileDlg').close(); render(); return; }
  });

  // keyboard: talk rows behave like buttons
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    var row = e.target.closest && e.target.closest('[data-talk]');
    if (row && !e.target.closest('.star')) { e.preventDefault(); openTalk(row.dataset.talk); }
  });
  // how-to guide
  el('helpBtn').addEventListener('click', openHelp);
  el('helpClose').addEventListener('click', closeHelp);
  el('helpDone').addEventListener('click', closeHelp);
  el('helpDlg').addEventListener('click', function (ev) {
    if (ev.target === el('helpDlg')) closeHelp();
  });

  el('talkClose').addEventListener('click', closeTalk);
  el('talkDlg').addEventListener('close', function () { OPEN_SID = null; });
  el('talkDlg').addEventListener('cancel', function () { saveOpenNote(); OPEN_SID = null; });
  // click the backdrop to dismiss
  el('talkDlg').addEventListener('click', function (ev) {
    if (ev.target === el('talkDlg')) closeTalk();
  });
  el('talkBody').addEventListener('click', function (ev) {
    var tagBtn = ev.target.closest('.note-tag-btn');
    if (tagBtn) { ev.preventDefault(); toggleNoteTag(tagBtn); }
  });
  var noteTimer;
  el('talkBody').addEventListener('input', function (ev) {
    if (ev.target.id !== 'noteText') return;
    clearTimeout(noteTimer);
    noteTimer = setTimeout(saveOpenNote, 400);
  });
  el('talkBody').addEventListener('blur', function (ev) {
    if (ev.target.id === 'noteText') saveOpenNote();
  }, true);
  el('talkStar').addEventListener('click', function () {
    if (!OPEN_SID) return;
    toggle(OPEN_SID);
    syncTalkStar();
  });

  el('profileBtn').addEventListener('click', function () { openProfile(false); });

  // Buttons are wired explicitly rather than relying on <form method="dialog">:
  // not every engine fires the dialog 'close' event on form submission, and a
  // silently dropped profile save is a bad first impression.
  el('dlgSave').addEventListener('click', saveProfileFromInput);
  el('dlgCancel').addEventListener('click', function () {
    el('profileDlg').close();
    if (!PROFILE) openProfile(true);
  });
  el('nameInput').addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter') { ev.preventDefault(); saveProfileFromInput(); }
  });
  el('profileDlg').addEventListener('cancel', function (ev) {
    if (!PROFILE) ev.preventDefault();   // Esc must not leave the app profile-less
  });

  var t;
  el('q').addEventListener('input', function () {
    el('qClear').hidden = !el('q').value;
    clearTimeout(t); t = setTimeout(render, 160);
  });
  el('qClear').addEventListener('click', function () {
    el('q').value = ''; el('qClear').hidden = true; render(); el('q').focus();
  });
  el('fRoom').addEventListener('change', render);
  el('fTheme').addEventListener('change', render);
  el('onlyMine').addEventListener('change', render);
  el('onlyNotes').addEventListener('change', render);
  el('onlyRevisit').addEventListener('change', render);
  el('onlyContact').addEventListener('change', render);
  el('btnShare').addEventListener('click', copyShare);
  if (el('syncCodeInput')) {
    el('syncCodeInput').addEventListener('change', function () {
      var code = normalizeSyncCode(el('syncCodeInput').value);
      if (code) setSyncRoom(code);
    });
    el('syncCodeInput').addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') { ev.preventDefault(); el('syncCodeInput').blur(); }
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
  el('btnNotesMd').addEventListener('click', downloadNotesMd);
  el('btnBackup').addEventListener('click', downloadBackup);
  el('btnRestore').addEventListener('click', pickRestoreFile);
  el('restoreFile').addEventListener('change', function () {
    var file = el('restoreFile').files[0];
    el('restoreFile').value = '';
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      try { restoreBackup(JSON.parse(reader.result)); }
      catch (e) { toast('Could not read that backup file.'); }
    };
    reader.readAsText(file);
  });
  el('btnClear').addEventListener('click', function () {
    if (!PICKS.size) { toast('Nothing to clear.'); return; }
    if (confirm('Remove all ' + PICKS.size + ' picks from "' + PROFILE + '"?')) {
      PICKS = new Set(); savePicks(); updateCount(); render(); toast('Picks cleared.');
    }
  });
}

function daysWithTalks() {
  var set = {};
  TALKS.forEach(function (r) { set[r.session.date] = 1; });
  return set;
}
/* Land on today during the symposium, otherwise on the next day that actually
   has talks. Sunday is registration + welcome only, so defaulting to it would
   show an empty programme. */
function pickInitialDay() {
  var today = new Date().toISOString().slice(0, 10);
  var has = daysWithTalks();
  if (has[today]) return today;
  var next = DATA.days.filter(function (x) { return x.date >= today && has[x.date]; })[0];
  if (next) return next.date;
  var past = DATA.days.filter(function (x) { return has[x.date]; });
  return past.length ? past[past.length - 1].date : DATA.days[0].date;
}

function boot() {
  fetch('data/programme.json', { cache: 'no-cache' })
    .then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .then(function (d) {
      DATA = d;
      flatten();
      el('capturedAt').textContent = d.meta.capturedAt;
      buildFilters();
      wire();

      var list = profiles();
      var cur = '';
      try { cur = localStorage.getItem(LS_CURRENT) || ''; } catch (e) {}
      if (cur && list.indexOf(cur) !== -1) setProfile(cur);
      else if (list.length) setProfile(list[0]);

      var imported = importFromHash();
      updateCloudSyncUI();
      startCloudSyncLoop();
      if (CLOUD_SYNC && syncRoom()) pullCloudSync(true);
      setDay(pickInitialDay());
      setView('programme');
      if (!PROFILE && !imported) openProfile(true);
      // if a profile already exists (returning user, or opened via a share link),
      // show the guide once. New users get it after entering their name instead.
      else maybeShowHelp();

      // Warm the abstracts once the programme is on screen, so opening a talk is
      // instant and everything is cached for offline use at the venue.
      var warm = function () { loadAbstracts(); };
      if (window.requestIdleCallback) requestIdleCallback(warm, { timeout: 4000 });
      else setTimeout(warm, 1200);
    })
    .catch(function (err) {
      el('content').innerHTML = '<div class="empty"><h3>Could not load the programme</h3>' +
        '<p>' + esc(err.message) + '</p><p>If you opened this file directly, run a local server ' +
        '(<code>python -m http.server</code>) — browsers block data files loaded from <code>file://</code>.</p></div>';
    });
}

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  window.addEventListener('load', function () {
    navigator.serviceWorker.register('sw.js').catch(function () {});
  });
}
window.addEventListener('pageshow', function () {
  if (CLOUD_SYNC && syncRoom() && DATA) pullCloudSync(false);
});
el('content').innerHTML = '<div class="loading">Loading the programme…</div>';
boot();
