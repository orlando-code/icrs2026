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
var LS_PICKS_META = 'icrs2026.picksMeta.';
var LS_HELP = 'icrs2026.helpSeen';
// View-only preferences. Deliberately separate keys from picks/notes so that
// changing how the programme is displayed can never touch saved data.
var LS_SORT = 'icrs2026.sort';
var LS_COLLAPSED = 'icrs2026.collapsed';
var LS_PROG_LAYOUT = 'icrs2026.progLayout';
var LS_NOTICE = 'icrs2026.noticeSeen';
var LS_HIDE_PAST = 'icrs2026.hidePast';
var SS_DAY_PINNED = 'icrs2026.dayPinned';
var SITE_MODE = window.ICRS_SITE_MODE || (/nirivas\.github\.io$/i.test(location.hostname) ? 'nico' : 'public');
var STAGING_SITE = SITE_MODE === 'staging';
var PERSONAL_SITE = SITE_MODE === 'personal';
var NZ_OFFSET = 12;          // Auckland is UTC+12 (NZST) for 19-24 July 2026
var SORT = 'time';
var upNextTimer = null;
var UP_NEXT_MINS = 30;
var PAST_HIDE_BUFFER = 20;
/* Explicit user collapse choices only: { id: true|false }. An id that is absent
   means "use the default for this group" -- which lets poster blocks start
   collapsed while ordinary sessions start open, without the two states fighting. */
var COLLAPSED = {};
var STORAGE_OK = true;
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
      if (OPEN_SID) fillAbstract(OPEN_SID);
      if (el('q') && el('q').value.trim()) render();
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
  if (typeof markSyncDirty === 'function') markSyncDirty();
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
  /* Merge into existing storage so a partial in-memory NOTES object can never
     drop entries that were not loaded this session. */
  var out = readJSON(LS_NOTES + PROFILE, {});
  Object.keys(NOTES).forEach(function (sid) {
    var n = NOTES[sid];
    if (!n) return;
    if (n.text || n.revisit || n.contact) out[sid] = n;
    else delete out[sid];
  });
  writeJSON(LS_NOTES + PROFILE, out);
  if (typeof markSyncDirty === 'function') markSyncDirty();
}
function markSyncDirty() {}
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
  if (f.hidePast) {
    return '<div class="empty"><h3>All talks finished</h3>' +
    '<p>Every talk on this day meeting your filter criteria has ended (with a ' + PAST_HIDE_BUFFER + '-minute buffer). Turn off <b>Hide finished talks</b> to see them.</p></div>';
  }
  if (f.notes || f.revisit || f.contact) return noteFilterEmptyHTML(f);
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

function abstractSearchText(sid) {
  if (ABSTRACTS_STATE !== 'ready' || !ABSTRACTS) return '';
  var txt = ABSTRACTS[sid];
  if (!txt) return '';
  return String(txt).replace(/<\s*\/?\s*i\s*>/gi, ' ');
}

/* ---------- filters ---------- */
function currentFilters() {
  return {
    q: el('q').value.trim().toLowerCase(),
    room: el('fRoom').value,
    theme: el('fTheme').value,
    notes: el('onlyNotes').checked,
    revisit: el('onlyRevisit').checked,
    contact: el('onlyContact').checked,
    hidePast: hidePastOn()
  };
}
function matches(rec, f) {
  var s = rec.session, t = rec.talk;
  if (f.hidePast && talkEndedWithBuffer(s.date, t.end)) return false;
  if (f.room && s.room !== f.room) return false;
  if (f.theme && String(s.theme) !== f.theme) return false;
  if (!matchesNoteFilters(t.sid, f)) return false;
  if (f.q) {
    var note = getNote(t.sid);
    var hay = (t.title + ' ' + t.presenter + ' ' + (t.affiliation || '') + ' ' +
               (t.authors || []).join(' ') + ' ' + s.title + ' ' + (s.code || '') +
               ' ' + note.text + ' ' + abstractSearchText(t.sid)).toLowerCase();
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

function programmeEvents(f) {
  var plain = !f.q && !f.room && !f.theme && !f.notes && !f.revisit && !f.contact;
  if (!plain) return [];
  return DATA.events.filter(function (e) {
    return DAY === 'all' || e.date === DAY;
  });
}

/* ---------- sort + collapse (view-only preferences) ----------
   These describe how sessions are grouped on screen. They never read or write
   picks/notes; the only persisted state is the mode and the collapsed id list. */
var SORTS = {
  /* Time is talk-level, not session-level: every talk starting at 10:15 is
     listed back to back regardless of room, which is what you want when you are
     deciding where to be right now. The other modes stay session-carded. */
  time: { flat: true, bands: true },
  room: {
    key: function (s) { return 'room:' + (s.room || 'zz'); },
    head: function (s) {
      return s.room ? esc(roomLabel(s.room)) + (roomLevel(s.room) ? ' &middot; ' + esc(roomLevel(s.room)) : '')
                    : 'Other venues';
    },
    within: function (a, b) {
      return (a.s.date).localeCompare(b.s.date) || mins(a.s.start) - mins(b.s.start);
    },
    bands: false
  },
  session: {
    key: function (s) { return 'sess:' + (s.code || 'zz'); },
    head: function (s) { return s.code ? 'Session ' + esc(s.code) : esc(s.title); },
    within: function (a, b) { return String(a.s.room).localeCompare(String(b.s.room)); },
    bands: false
  },
  topic: {
    key: function (s) { return 'topic:' + (s.theme || 'zz'); },
    head: function (s) {
      return s.theme ? '#' + s.theme + ' ' + esc(s.title) : esc(s.title);
    },
    within: function (a, b) {
      return (a.s.date).localeCompare(b.s.date) || mins(a.s.start) - mins(b.s.start);
    },
    bands: false
  }
};
function sortMode() { return SORTS[SORT] ? SORT : 'time'; }

function programmeLayout() {
  try { return localStorage.getItem(LS_PROG_LAYOUT) === 'time' ? 'time' : 'session'; } catch (e) { return 'session'; }
}
function setProgrammeLayout(layout) {
  try { localStorage.setItem(LS_PROG_LAYOUT, layout === 'time' ? 'time' : 'session'); } catch (e) {}
  updateProgLayoutUI();
  render();
}
function updateProgLayoutUI() {
  var wrap = el('progLayoutWrap');
  if (!wrap) return;
  var layout = programmeLayout();
  wrap.querySelectorAll('.prog-layout-btn').forEach(function (btn) {
    var on = btn.dataset.layout === layout;
    btn.classList.toggle('is-on', on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
}

function loadViewPrefs() {
  try {
    var s = localStorage.getItem(LS_SORT);
    if (s && SORTS[s]) SORT = s;
  } catch (e) {}
  // Older versions stored an array of collapsed ids; migrate so anyone who had
  // sessions folded keeps them folded.
  var raw = readJSON(LS_COLLAPSED, {});
  COLLAPSED = {};
  if (Array.isArray(raw)) raw.forEach(function (id) { COLLAPSED[id] = true; });
  else if (raw && typeof raw === 'object') {
    Object.keys(raw).forEach(function (id) { COLLAPSED[id] = !!raw[id]; });
  }
}
function saveCollapsed() { writeJSON(LS_COLLAPSED, COLLAPSED); }

/* A group is collapsed if the user said so; otherwise fall back to its default.
   Poster blocks default to collapsed -- 279 posters at one time would otherwise
   bury the rest of the evening. */
function isCollapsed(id, dflt) {
  if (Object.prototype.hasOwnProperty.call(COLLAPSED, id)) return COLLAPSED[id];
  return !!dflt;
}
function setCollapsed(id, val) { COLLAPSED[id] = !!val; }

function setSort(mode) {
  SORT = SORTS[mode] ? mode : 'time';
  try { localStorage.setItem(LS_SORT, SORT); } catch (e) {}
  render();
}
function toggleCollapse(id, dflt) {
  setCollapsed(id, !isCollapsed(id, dflt));
  saveCollapsed();
  render();
}
/* "Collapse all" applies to what is currently on screen, so it is predictable:
   if anything visible is expanded, collapse those; otherwise expand them. */
function collapseAll() {
  var nodes = document.querySelectorAll('[data-group]');
  if (!nodes.length) return;
  var anyOpen = Array.prototype.some.call(nodes, function (n) {
    return n.dataset.collapsed !== '1';
  });
  Array.prototype.forEach.call(nodes, function (n) { setCollapsed(n.dataset.group, anyOpen); });
  saveCollapsed();
  render();
}
function syncCollapseBtn() {
  var nodes = document.querySelectorAll('[data-group]');
  var anyOpen = Array.prototype.some.call(nodes, function (n) {
    return n.dataset.collapsed !== '1';
  });
  var b = el('btnCollapse');
  b.textContent = anyOpen ? 'Collapse all' : 'Expand all';
  b.setAttribute('aria-pressed', String(!anyOpen));
  b.hidden = !nodes.length;
}

/* ---------- render: programme ---------- */
function renderProgramme() {
  if (programmeLayout() === 'time') {
    renderProgrammeByTime();
    return;
  }
  var f = currentFilters();
  var recs = TALKS.filter(function (r) {
    if (DAY !== 'all' && r.session.date !== DAY) return false;
    return matches(r, f);
  });

  // Venue-wide items (registration, teas, lunches, socials) are context, not
  // choices — always show unless other filters are active (not hide-finished).
  var evts = programmeEvents(f);

  if (!recs.length && (f.notes || f.revisit || f.contact || !evts.length)) {
    el('content').innerHTML = programmeEmptyHTML(f);
    return;
  }

  var mode = sortMode(), SORTER = SORTS[mode];
  if (SORTER.flat) { renderFlatTime(recs, evts, f); return; }

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

  // bucket sessions by the active sort key, preserving first-seen order
  var blocks = new Map();
  groups.forEach(function (g) {
    var k = SORTER.key(g.s);
    if (!blocks.has(k)) blocks.set(k, []);
    blocks.get(k).push(g);
  });
  blocks.forEach(function (gs) { gs.sort(SORTER.within); });

  var entries = [];
  blocks.forEach(function (gs) {
    entries.push({ type: 'block', date: gs[0].s.date, start: gs[0].s.start, gs: gs });
  });
  // Venue bands are chronological context, so they only make sense in time order.
  if (SORTER.bands) {
    evts.forEach(function (e) {
      entries.push({ type: 'event', date: e.date, start: e.start || '00:00', e: e });
    });
    entries.sort(function (a, b) {
      return a.date.localeCompare(b.date) || mins(a.start) - mins(b.start);
    });
  }

  var shown = 0, capped = false, html = [];
  entries.forEach(function (en) {
    if (capped) return;
    if (en.type === 'event') { html.push(bandHTML(en.e)); return; }
    var gs = en.gs, s0 = gs[0].s;
    var n = gs.reduce(function (a, g) { return a + g.talks.length; }, 0);
    html.push('<section class="block"><div class="block-head">' +
      '<span class="block-time">' + SORTER.head(s0) + '</span>' +
      '<span class="block-line"></span><span class="block-n">' + n + ' talk' + (n === 1 ? '' : 's') + '</span>' +
      '</div><div class="grid">');
    gs.forEach(function (g) {
      if (capped) return;
      html.push(cardHTML(g, f));
      // collapsed cards render no rows, so they cost nothing against the cap
      if (!isCollapsed(g.s.id, false)) {
        shown += g.talks.length;
        if (shown >= RENDER_CAP) capped = true;
      }
    });
    html.push('</div></section>');
  });

  if (capped) {
    html.push('<div class="note">Showing the first ' + shown + ' of ' + recs.length +
      ' matching talks. Narrow the search, or collapse sections, to see the rest.</div>');
  }
  el('content').innerHTML = html.join('');
  syncCollapseBtn();
}

function renderProgrammeByTime() {
  var f = currentFilters();
  var recs = TALKS.filter(function (r) {
    if (DAY !== 'all' && r.session.date !== DAY) return false;
    return matches(r, f);
  }).sort(function (a, b) {
    return a.session.date.localeCompare(b.session.date) ||
      mins(a.talk.start) - mins(b.talk.start) ||
      mins(a.talk.end) - mins(b.talk.end) ||
      String(a.session.room).localeCompare(String(b.session.room)) ||
      a.talk.title.localeCompare(b.talk.title);
  });
  var evts = programmeEvents(f);

  if (!recs.length && (f.notes || f.revisit || f.contact || !evts.length)) {
    el('content').innerHTML = programmeEmptyHTML(f);
    return;
  }

  var entries = [];
  recs.forEach(function (r) {
    entries.push({ type: 'talk', date: r.session.date, start: r.talk.start, r: r });
  });
  evts.forEach(function (e) {
    entries.push({ type: 'event', date: e.date, start: e.start || '00:00', e: e });
  });
  entries.sort(function (a, b) {
    return a.date.localeCompare(b.date) || mins(a.start) - mins(b.start);
  });

  var shown = 0, capped = false, html = ['<div class="time-list">'];
  var lastSlot = '';
  entries.forEach(function (en) {
    if (capped) return;
    if (en.type === 'event') {
      html.push(bandHTML(en.e));
      return;
    }
    var slot = en.date + ' ' + en.r.talk.start;
    if (slot !== lastSlot) {
      lastSlot = slot;
      var dayPrefix = DAY === 'all' ? dayShort(en.date) + ' &middot; ' : '';
      html.push('<div class="time-slot-head">' + dayPrefix + hhmm(en.r.talk.start) + '</div>');
    }
    html.push(talkRowHTML(en.r.talk, en.r.session, f, true));
    shown++;
    if (shown >= RENDER_CAP) capped = true;
  });
  html.push('</div>');

  if (capped) {
    html.push('<div class="note">Showing the first ' + shown + ' of ' + recs.length +
      ' matching talks. Narrow the search, room, or day to see the rest.</div>');
  }
  el('content').innerHTML = html.join('');
}

/* Time view: one group per distinct talk start time, so every talk beginning at
   10:15 sits back to back regardless of room. Poster sessions are hundreds of
   items at a single time, so they get their own clearly-labelled group that
   starts collapsed. */
function renderFlatTime(recs, evts, f) {
  var buckets = new Map();
  recs.forEach(function (r) {
    var k = 't:' + r.session.date + ' ' + r.talk.start +
            (r.session.kind === 'poster' ? ' p:' + r.session.id : '');
    if (!buckets.has(k)) {
      buckets.set(k, { id: k, date: r.session.date, start: r.talk.start,
                       poster: r.session.kind === 'poster', session: r.session, rows: [] });
    }
    buckets.get(k).rows.push(r);
  });

  var entries = [];
  buckets.forEach(function (b) {
    b.rows.sort(function (x, y) {
      return String(x.session.room).localeCompare(String(y.session.room)) ||
             x.talk.title.localeCompare(y.talk.title);
    });
    entries.push({ type: 'group', date: b.date, start: b.start, g: b });
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
    var g = en.g;
    var open = !isCollapsed(g.id, g.poster);   // posters default to collapsed
    var n = g.rows.length;
    var picked = 0, noted = 0;
    g.rows.forEach(function (r) {
      if (PICKS.has(r.talk.sid)) picked++;
      if (hasNote(r.talk.sid)) noted++;
    });
    var word = g.poster ? (n === 1 ? 'poster' : 'posters') : (n === 1 ? 'talk' : 'talks');
    var extra = [];
    if (picked) extra.push('<b class="sum-pick">' + picked + ' picked</b>');
    if (noted) extra.push('<b class="sum-note">' + noted + ' noted</b>');

    html.push('<section class="tgroup' + (g.poster ? ' is-poster' : '') + '" data-group="' + esc(g.id) + '"' +
      (open ? '' : ' data-collapsed="1"') + '>' +
      '<div class="tgroup-head" data-collapse="' + esc(g.id) + '" data-default="' + (g.poster ? '1' : '') + '" ' +
      'role="button" tabindex="0" aria-expanded="' + open + '" aria-label="' +
      (open ? 'Collapse' : 'Expand') + ' ' + hhmm(g.start) + '">' +
      '<span class="tgroup-time">' + (DAY === 'all' ? dayShort(g.date) + ' &middot; ' : '') + hhmm(g.start) + '</span>' +
      (g.poster ? '<span class="tgroup-tag">' + esc(g.session.title) + '</span>' : '') +
      '<span class="block-line"></span>' +
      '<span class="tgroup-n">' + n + ' ' + word + (extra.length ? ' &middot; ' + extra.join(' &middot; ') : '') + '</span>' +
      '<span class="chev" aria-hidden="true"><svg viewBox="0 0 24 24" width="16" height="16">' +
      '<path fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" d="M6 9l6 6 6-6"/></svg></span>' +
      '</div>');
    if (open) {
      html.push('<div class="tgroup-rows">');
      g.rows.forEach(function (r) {
        if (capped) return;
        html.push(talkRowHTML(r.talk, r.session, f, true));
        shown++;
        if (shown >= RENDER_CAP) capped = true;
      });
      html.push('</div>');
    }
    html.push('</section>');
  });

  if (capped) {
    html.push('<div class="note">Showing the first ' + shown + ' of ' + recs.length +
      ' matching talks. Narrow the search, or collapse sections, to see the rest.</div>');
  }
  el('content').innerHTML = html.join('');
  syncCollapseBtn();
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
function venueSlotEnded(date, endTime, now) {
  now = now || venueNow();
  if (date < now.date) return true;
  if (date > now.date) return false;
  return mins(endTime) <= now.mins;
}
function talkEndedWithBuffer(date, endTime, now) {
  if (!endTime) return false;
  now = now || venueNow();
  if (date < now.date) return true;
  if (date > now.date) return false;
  return mins(endTime) + PAST_HIDE_BUFFER <= now.mins;
}

function cardHTML(g, f) {
  var s = g.s;
  var talks = g.talks.slice().sort(function (a, b) { return mins(a.start) - mins(b.start); });
  var allPast = talks.length
    ? talks.every(function (t) { return venueSlotEnded(s.date, t.end); })
    : venueSlotEnded(s.date, s.end);
  var past = allPast;
  var code = s.code ? s.code : (s.kind === 'poster' ? 'POSTER' : s.kind === 'plenary' ? 'PLENARY' : 'EVENT');
  var themeTag = s.theme ? '#' + s.theme : '';
  var open = !isCollapsed(s.id, false);

  // When collapsed, surface what's inside so picks and notes are never hidden.
  var picked = 0, noted = 0;
  g.talks.forEach(function (t) {
    if (PICKS.has(t.sid)) picked++;
    if (hasNote(t.sid)) noted++;
  });
  var summary = [g.talks.length + ' talk' + (g.talks.length === 1 ? '' : 's')];
  if (picked) summary.push('<b class="sum-pick">' + picked + ' picked</b>');
  if (noted) summary.push('<b class="sum-note">' + noted + ' noted</b>');

  var out = ['<article class="card' + (past ? ' is-past' : '') + '" data-kind="' + s.kind + '" data-sess="' + esc(s.id) + '"' +
    ' data-group="' + esc(s.id) + '"' + (open ? '' : ' data-collapsed="1"') + '>' +
    '<div class="card-head' + (allPast ? ' is-past' : '') + '" data-collapse="' + esc(s.id) + '" role="button" tabindex="0" ' +
    'aria-expanded="' + open + '" aria-label="' + (open ? 'Collapse' : 'Expand') + ' session">' +
    '<span class="code">' + esc(code) + '</span><div style="min-width:0">' +
    '<h3 class="card-title">' + hi(s.title, f.q) + '</h3><div class="card-meta">' +
    (s.room ? '<span class="room">' + esc(roomLabel(s.room)) + (roomLevel(s.room) ? ' &middot; ' + esc(roomLevel(s.room)) : '') + '</span>' : '') +
    (themeTag ? '<span>' + themeTag + '</span>' : '') +
    '<span class="card-sum">' + summary.join(' &middot; ') + '</span>' +
    '</div></div>' +
    '<span class="chev" aria-hidden="true"><svg viewBox="0 0 24 24" width="16" height="16">' +
    '<path fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" d="M6 9l6 6 6-6"/></svg></span>' +
    '</div>'];
  if (!open) { out.push('</article>'); return out.join(''); }
  g.talks.forEach(function (t) { out.push(talkRowHTML(t, s, f, false)); });
  out.push('</article>');
  return out.join('');
}

/* One row renderer for both views. The flat time list has no session card above
   it, so it opts into showing the room + session code on the row itself. */
function talkRowHTML(t, s, f, withWhere) {
  var on = PICKS.has(t.sid);
  var past = venueSlotEnded(s.date, t.end);
  var where = '';
  if (withWhere) {
    var bits = [];
    if (s.room) {
      bits.push('<span class="row-room">' + esc(roomLabel(s.room)) +
        (roomLevel(s.room) ? ' &middot; ' + esc(roomLevel(s.room)) : '') + '</span>');
    }
    if (s.code) bits.push('<span class="row-sess">' + esc(s.code) + (s.theme ? ' &middot; #' + s.theme : '') + '</span>');
    else if (s.kind === 'poster') bits.push('<span class="row-sess">Poster</span>');
    where = bits.length ? '<div class="t-where">' + bits.join('') + '</div>' : '';
  }
  return '<div class="talk' + (withWhere ? ' time-row' : '') + (on ? ' is-on' : '') + (past ? ' is-past' : '') + '" data-talk="' + t.sid +
    '" tabindex="0" role="button" aria-label="Open details">' +
    '<span class="t-time">' + hhmm(t.start) + '</span>' +
    '<div class="t-body"><div class="t-title">' + hi(t.title, f.q) + '</div>' +
    '<div class="t-who">' + hi((t.honorific ? t.honorific + ' ' : '') + t.presenter, f.q) +
    (t.affiliation ? ' <span class="aff">&middot; ' + hi(t.affiliation, f.q) + '</span>' : '') +
    '</div>' + where + noteBadgesHTML(t.sid) + '</div>' +
    '<button class="star" data-sid="' + t.sid + '" aria-pressed="' + on + '" ' +
    'aria-label="' + (on ? 'Remove from' : 'Add to') + ' my schedule" title="' + (on ? 'Remove from' : 'Add to') + ' my schedule">' +
    starSVG(on) + '</button></div>';
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

function pickMineScrollTarget() {
  var now = venueNow();
  var list = myPicks();
  if (hidePastOn()) {
    list = list.filter(function (r) {
      return !talkEndedWithBuffer(r.session.date, r.talk.end, now);
    });
  }
  if (!list.length) return null;
  var today = list.filter(function (r) { return r.session.date === now.date; });
  if (today.length) {
    var next = today.find(function (r) {
      return !venueSlotEnded(r.session.date, r.talk.end, now);
    });
    return (next || today[today.length - 1]).talk.sid;
  }
  var future = list.find(function (r) { return r.session.date >= now.date; });
  if (future) return future.talk.sid;
  return list[list.length - 1].talk.sid;
}
function scrollMineToCurrent() {
  var sid = pickMineScrollTarget();
  if (!sid) return;
  requestAnimationFrame(function () {
    var row = document.querySelector('.mine-row[data-talk="' + sid + '"]');
    if (row) row.scrollIntoView({ block: 'center', behavior: 'smooth' });
  });
}

function renderMine() {
  var all = myPicks();
  if (!all.length) {
    el('content').innerHTML = '<div class="empty"><h3>No talks picked yet</h3>' +
      '<p>Open <b>Programme</b> and tap the star next to any talk to build your schedule.</p></div>';
    return;
  }
  var list = all;
  if (hidePastOn()) {
    list = all.filter(function (r) {
      return !talkEndedWithBuffer(r.session.date, r.talk.end);
    });
  }
  if (!list.length) {
    el('content').innerHTML = '<div class="empty"><h3>All finished</h3>' +
      '<p>Every picked talk has ended (with a ' + PAST_HIDE_BUFFER + '-minute buffer). Turn off <b>Hide finished talks</b> to see them.</p></div>';
    return;
  }
  var clash = findClashes(list);
  var html = [];
  if (clash.size) {
    html.push('<div class="note"><b>' + clash.size + ' of your ' + list.length +
      ' visible picks overlap.</b> They are marked below — you cannot attend both.</div>');
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
    var past = venueSlotEnded(r.session.date, r.talk.end);
    html.push('<div class="mine-row' + (past ? ' is-past' : '') + (c ? ' clash' : '') + '" data-talk="' + r.talk.sid +
      '" tabindex="0" role="button" aria-label="Open details">' +
      '<span class="m-time">' + hhmm(r.talk.start) + '–' + hhmm(r.talk.end) + '</span>' +
      '<div class="m-body"><div class="m-title">' + esc(r.talk.title) + '</div>' +
      '<div class="m-meta">' + esc(roomLabel(r.session.room)) +
      (roomLevel(r.session.room) ? ' &middot; ' + esc(roomLevel(r.session.room)) : '') +
      (r.session.code ? ' &middot; ' + esc(r.session.code) : '') +
      ' &middot; ' + esc((r.talk.honorific ? r.talk.honorific + ' ' : '') + r.talk.presenter) + '</div>' +
      (c ? '<div class="clash-tag">⚠ Overlaps ' + esc(c[0].talk.title.length > 40 ? c[0].talk.title.slice(0, 40) + '...' : c[0].talk.title) +
           (c.length > 1 ? ' +' + (c.length - 1) + ' more' : '') + '</div>' : '') +
      noteBadgesHTML(r.talk.sid) +
      '</div>' +
      '<button class="star" data-sid="' + r.talk.sid + '" aria-pressed="true" aria-label="Remove from my schedule">' +
      starSVG(true) + '</button></div>');
    prev = r;
  });
  el('content').innerHTML = html.join('');
}

/* ---------- render: up next ---------- */
function venueNow() {
  var parts = {};
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Pacific/Auckland',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(new Date()).forEach(function (p) {
    if (p.type !== 'literal') parts[p.type] = p.value;
  });
  return {
    date: parts.year + '-' + parts.month + '-' + parts.day,
    mins: parseInt(parts.hour, 10) * 60 + parseInt(parts.minute, 10)
  };
}
function upNextPicks(windowMins) {
  var now = venueNow();
  return myPicks().filter(function (r) {
    if (r.session.date !== now.date) return false;
    var ts = mins(r.talk.start);
    var te = mins(r.talk.end);
    if (te <= now.mins) return false;
    if (ts <= now.mins && now.mins < te) return true;
    return ts > now.mins && ts <= now.mins + windowMins;
  });
}
function upNextStatus(r, now) {
  var ts = mins(r.talk.start);
  var te = mins(r.talk.end);
  if (ts <= now.mins && now.mins < te) return { label: 'Now', live: true };
  var until = ts - now.mins;
  if (until <= 1) return { label: 'in 1 min', live: false };
  return { label: 'in ' + until + ' min', live: false };
}
function renderUpNext() {
  var now = venueNow();
  var day = DATA.days.find(function (x) { return x.date === now.date; });
  if (!day) {
    el('content').innerHTML = '<div class="empty"><h3>Nothing on today</h3>' +
      '<p>This tab tracks your picks for <b>today</b> (Auckland time). The symposium runs 19&ndash;24 July.</p></div>';
    return;
  }
  if (!PICKS.size) {
    el('content').innerHTML = '<div class="empty"><h3>No talks picked yet</h3>' +
      '<p>Star talks in <b>Programme</b> or <b>My schedule</b> to see what&rsquo;s up next here.</p></div>';
    return;
  }
  var list = upNextPicks(UP_NEXT_MINS);
  var clock = hhmm(String(Math.floor(now.mins / 60)).padStart(2, '0') + ':' +
    String(now.mins % 60).padStart(2, '0'));
  var html = [
    '<p class="upnext-lead">Auckland <b>' + esc(clock) + '</b> &middot; ' + esc(day.label) +
      ' &middot; starred talks in the next ' + UP_NEXT_MINS + ' minutes</p>'
  ];
  if (!list.length) {
    html.push('<div class="empty"><h3>Clear for the next ' + UP_NEXT_MINS + ' minutes</h3>' +
      '<p>None of your picks start soon. Check <b>My schedule</b> for the full day.</p></div>');
    el('content').innerHTML = html.join('');
    return;
  }
  var clash = findClashes(list);
  list.forEach(function (r) {
    var st = upNextStatus(r, now);
    var c = clash.get(r.talk.sid);
    html.push('<div class="mine-row upnext-row' + (st.live ? ' is-live' : '') + (c ? ' clash' : '') +
      '" data-talk="' + r.talk.sid + '" tabindex="0" role="button" aria-label="Open details">' +
      '<span class="m-time">' + hhmm(r.talk.start) + '–' + hhmm(r.talk.end) + '</span>' +
      '<div class="m-body"><div class="m-title">' + esc(r.talk.title) + '</div>' +
      '<div class="m-meta">' + esc(roomLabel(r.session.room)) +
      (roomLevel(r.session.room) ? ' &middot; ' + esc(roomLevel(r.session.room)) : '') +
      ' &middot; ' + esc((r.talk.honorific ? r.talk.honorific + ' ' : '') + r.talk.presenter) + '</div>' +
      '<span class="upnext-when' + (st.live ? ' is-live' : '') + '">' + esc(st.label) + '</span>' +
      (c ? '<div class="clash-tag">⚠ Overlaps another pick</div>' : '') +
      noteBadgesHTML(r.talk.sid) +
      '</div>' +
      '<button class="star" data-sid="' + r.talk.sid + '" aria-pressed="true" aria-label="Remove from my schedule">' +
      starSVG(true) + '</button></div>');
  });
  el('content').innerHTML = html.join('');
}
function stopUpNextTimer() {
  if (upNextTimer) { clearInterval(upNextTimer); upNextTimer = null; }
}
function startUpNextTimer() {
  stopUpNextTimer();
  if (VIEW !== 'upnext') return;
  upNextTimer = setInterval(function () {
    if (VIEW === 'upnext') renderUpNext();
  }, 30000);
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
    '<div class="note-actions"><button type="button" id="noteDone" class="btn note-done">Done</button></div>' +
    '<p class="note-hint"><b>Notes stay on this device.</b> They are lost if you clear browser data. Use <b>Notes (.md)</b> or <b>Backup</b> in My schedule to keep a copy.</p>' +
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
function finishNoteEntry() {
  saveOpenNote();
  var ta = el('noteText');
  if (ta) ta.blur();
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

/* Calendar export. Times in the programme are venue-local (Auckland, UTC+12 in
   July); .ics carries UTC, so they are converted here rather than trusting the
   viewer's timezone. */
function icsTime(date, t) {
  var dp = date.split('-').map(Number), tp = t.split(':').map(Number);
  var ms = Date.UTC(dp[0], dp[1] - 1, dp[2], tp[0] - NZ_OFFSET, tp[1]);
  var d = new Date(ms);
  var p = function (n) { return String(n).padStart(2, '0'); };
  return d.getUTCFullYear() + p(d.getUTCMonth() + 1) + p(d.getUTCDate()) + 'T' +
         p(d.getUTCHours()) + p(d.getUTCMinutes()) + '00Z';
}
function icsEsc(s) {
  return String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/;/g, '\\;')
    .replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}
function fold(line) {
  var out = [], s = line;
  while (s.length > 73) { out.push(s.slice(0, 73)); s = ' ' + s.slice(73); }
  out.push(s);
  return out.join('\r\n');
}
function buildICS() {
  var list = myPicks();
  if (!list.length) { toast('Pick some talks first.'); return null; }
  var stamp = icsTime('2026-07-15', '12:00');
  var L = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//ICRS 2026 Planner//EN',
           'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
           'X-WR-CALNAME:' + icsEsc('ICRS 2026 — ' + PROFILE)];
  list.forEach(function (r) {
    var loc = roomLabel(r.session.room) + (roomLevel(r.session.room) ? ', ' + roomLevel(r.session.room) : '') +
              ', NZICC Auckland';
    var note = getNote(r.talk.sid);
    var desc = (r.talk.honorific ? r.talk.honorific + ' ' : '') + r.talk.presenter +
      (r.talk.affiliation ? ' (' + r.talk.affiliation + ')' : '') +
      (r.session.code ? '\nSession ' + r.session.code + ' — ' + r.session.title : '') +
      ((r.talk.authors && r.talk.authors.length > 1) ? '\nAuthors: ' + r.talk.authors.join(', ') : '') +
      (note.text ? '\n\nMy notes: ' + note.text : '');
    L.push('BEGIN:VEVENT');
    L.push('UID:' + r.talk.id + '@icrs2026-planner');
    L.push('DTSTAMP:' + stamp);
    L.push('DTSTART:' + icsTime(r.session.date, r.talk.start));
    L.push('DTEND:' + icsTime(r.session.date, r.talk.end));
    L.push(fold('SUMMARY:' + icsEsc(r.talk.title)));
    L.push(fold('LOCATION:' + icsEsc(loc)));
    L.push(fold('DESCRIPTION:' + icsEsc(desc)));
    L.push('END:VEVENT');
  });
  L.push('END:VCALENDAR');
  return L.join('\r\n');
}
function downloadICS() {
  var txt = buildICS();
  if (!txt) return;
  downloadBlob('icrs2026-' + profileSlug() + '.ics', txt, 'text/calendar;charset=utf-8');
  toast('Calendar file downloaded (' + PICKS.size + ' talks).');
}

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
function restoreBackup(data) {
  if (!data || data.v !== 1 || data.app !== 'icrs2026' || !Array.isArray(data.profiles)) {
    toast('That file is not a valid ICRS backup.');
    return;
  }
  var n = data.profiles.length;
  if (!n) { toast('Backup has no profiles.'); return; }
  if (!confirm('Restore picks and notes for ' + n + ' profile' + (n === 1 ? '' : 's') +
      ' from this backup? Existing data for those names will be replaced.')) return;

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
  if (typeof markSyncDirty === 'function') markSyncDirty();
  toast('Restored ' + n + ' profile' + (n === 1 ? '' : 's') + '.');
}
function pickRestoreFile() {
  el('restoreFile').click();
}

/* ---------- site link (Share tab) ---------- */
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
  el('content').innerHTML =
    '<div class="qr-panel">' +
      '<p class="qr-lead">Scan this code to open the ICRS 2026 planner on another phone or laptop.</p>' +
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
  // first-timers see the guide once, right after naming themselves
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

/* ---------- storage notice ----------
   Two different situations, deliberately handled differently:
   - storage works: a one-time, dismissible heads-up about private browsing.
   - storage is blocked: a permanent warning, because nothing can be saved at
     all -- including the "dismissed" flag, so a one-time banner would be a lie. */
function probeStorage() {
  try {
    localStorage.setItem('icrs2026.probe', '1');
    localStorage.removeItem('icrs2026.probe');
    return true;
  } catch (e) { return false; }
}
function showNotice() {
  var box = el('notice');
  box.style.display = '';   // clear any inline hide from a previous dismissal
  if (!STORAGE_OK) {
    el('noticeMain').innerHTML = '<b>This browser is blocking storage.</b> Picks and notes cannot be ' +
      'saved right now — they will vanish when you close this tab. Leaving private/incognito mode, ' +
      'or allowing site data for this page, fixes it.';
    box.classList.add('is-hard');
    el('noticeClose').hidden = true;
    box.hidden = false;
    return;
  }
  var seen;
  try { seen = localStorage.getItem(LS_NOTICE); } catch (e) {}
  if (seen) return;
  box.hidden = false;
}
function dismissNotice() {
  var box = el('notice');
  box.hidden = true;
  // Belt and braces: an inline style beats any class rule, so dismissing works
  // even if a stale cached stylesheet is in play -- which is exactly the case on
  // a home-screen install still serving the previous version's CSS.
  box.style.display = 'none';
  try { localStorage.setItem(LS_NOTICE, '1'); } catch (e) {}
}
function updatePersonalUI() {
  document.documentElement.classList.toggle('site-personal', PERSONAL_SITE);
  document.documentElement.classList.toggle('site-staging', STAGING_SITE);
  if (PERSONAL_SITE) {
    var theme = document.querySelector('meta[name="theme-color"]');
    if (theme) theme.content = '#3d2067';
  }
  var banner = el('stagingBanner');
  if (banner) banner.hidden = !STAGING_SITE;
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
  else if (VIEW === 'upnext') renderUpNext();
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
  if (VIEW === 'mine' || VIEW === 'upnext' || (VIEW === 'programme' && programmeLayout() === 'time')) {
    render(); return;
  }

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

function pinnedDay() {
  try { return sessionStorage.getItem(SS_DAY_PINNED) || ''; } catch (e) { return ''; }
}
function hidePastOn() {
  var a = el('hidePast'), b = el('hidePastMine');
  return !!(a && a.checked) || !!(b && b.checked);
}
function syncHidePast(from) {
  var on = from ? from.checked : hidePastOn();
  var a = el('hidePast'), b = el('hidePastMine');
  if (a && a !== from) a.checked = on;
  if (b && b !== from) b.checked = on;
  try { localStorage.setItem(LS_HIDE_PAST, on ? '1' : '0'); } catch (e) {}
}
function restoreHidePast() {
  var on = false;
  try { on = localStorage.getItem(LS_HIDE_PAST) === '1'; } catch (e) {}
  syncHidePast({ checked: on });
}
function saveHidePast(from) {
  syncHidePast(from);
}
function applyInitialDay() {
  var pinned = pinnedDay();
  setDay(pinned || pickInitialDay());
}

function setDay(d, opts) {
  opts = opts || {};
  DAY = d;
  if (opts.user) {
    try { sessionStorage.setItem(SS_DAY_PINNED, d); } catch (e) {}
  }
  Array.prototype.forEach.call(document.querySelectorAll('.day-tab'), function (b) {
    b.classList.toggle('is-on', b.dataset.day === d);
  });
  render();
}
function setView(v) {
  var was = VIEW;
  VIEW = v;
  Array.prototype.forEach.call(document.querySelectorAll('.view-tab'), function (b) {
    var on = b.dataset.view === v;
    b.classList.toggle('is-on', on);
    b.setAttribute('aria-selected', on);
  });
  el('programmeControls').hidden = v !== 'programme';
  el('mineControls').hidden = v !== 'mine';
  if (v === 'upnext') startUpNextTimer();
  else stopUpNextTimer();
  window.scrollTo(0, 0);
  render();
  if (v === 'mine' && was !== 'mine') scrollMineToCurrent();
}

function wire() {
  document.addEventListener('click', function (e) {
    // star first: tapping it must never also open the detail dialog
    var star = e.target.closest('.star');
    if (star) { e.stopPropagation(); toggle(star.dataset.sid); return; }
    var row = e.target.closest('[data-talk]');
    if (row) { openTalk(row.dataset.talk); return; }
    // collapse toggle sits on the card head, above the talk rows
    var ch = e.target.closest('[data-collapse]');
    if (ch) { toggleCollapse(ch.dataset.collapse, ch.dataset.default === '1'); return; }
    var scrollHead = e.target.closest('.block-head, .card-head, .time-slot-head, .brand');
    if (scrollHead) {
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    var tab = e.target.closest('.day-tab');
    if (tab) { setDay(tab.dataset.day, { user: true }); return; }
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
    var ch = e.target.closest && e.target.closest('[data-collapse]');
    if (ch) { e.preventDefault(); toggleCollapse(ch.dataset.collapse, ch.dataset.default === '1'); return; }
    var scrollHead = e.target.closest && e.target.closest('.block-head, .card-head, .time-slot-head, .brand');
    if (scrollHead) { e.preventDefault(); window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
    var row = e.target.closest && e.target.closest('[data-talk]');
    if (row && !e.target.closest('.star')) { e.preventDefault(); openTalk(row.dataset.talk); }
  });
  el('fSort').addEventListener('change', function () { setSort(el('fSort').value); });
  var progLayout = el('progLayoutWrap');
  if (progLayout) {
    progLayout.addEventListener('click', function (e) {
      var btn = e.target.closest('.prog-layout-btn');
      if (btn) setProgrammeLayout(btn.dataset.layout);
    });
  }
  el('btnCollapse').addEventListener('click', collapseAll);
  el('noticeClose').addEventListener('click', dismissNotice);
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
    if (tagBtn) { ev.preventDefault(); toggleNoteTag(tagBtn); return; }
    if (ev.target.closest('#noteDone')) {
      ev.preventDefault();
      finishNoteEntry();
    }
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
    if (el('q').value.trim() && ABSTRACTS_STATE === 'idle') loadAbstracts();
    clearTimeout(t); t = setTimeout(render, 160);
  });
  el('qClear').addEventListener('click', function () {
    el('q').value = ''; el('qClear').hidden = true; render(); el('q').focus();
  });
  el('fRoom').addEventListener('change', render);
  el('fTheme').addEventListener('change', render);
  el('onlyNotes').addEventListener('change', render);
  el('onlyRevisit').addEventListener('change', render);
  el('onlyContact').addEventListener('change', render);
  restoreHidePast();
  function onHidePastChange(ev) {
    saveHidePast(ev.target);
    render();
  }
  if (el('hidePast')) el('hidePast').addEventListener('change', onHidePastChange);
  if (el('hidePastMine')) el('hidePastMine').addEventListener('change', onHidePastChange);
  el('btnIcs').addEventListener('click', downloadICS);
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
  var today = venueNow().date;
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
      STORAGE_OK = probeStorage();
      loadViewPrefs();
      buildFilters();
      updateProgLayoutUI();
      el('fSort').value = sortMode();
      wire();
      showNotice();
      updatePersonalUI();
      restoreHidePast();

      var list = profiles();
      var cur = '';
      try { cur = localStorage.getItem(LS_CURRENT) || ''; } catch (e) {}
      if (cur && list.indexOf(cur) !== -1) setProfile(cur);
      else if (list.length) setProfile(list[0]);

      applyInitialDay();
      setView('programme');
      if (!PROFILE) openProfile(true);
      // if a profile already exists (returning user), show the guide once.
      // New users get it after entering their name instead.
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

/* Updating an installed (home-screen) app is the awkward case: it serves from
   cache and has no address bar to force a reload, so a fix can sit unused for
   several launches. The worker calls skipWaiting/claim, and when it takes over
   we reload once so the new CSS/JS actually apply on this launch rather than the
   next one. Picks and notes live in localStorage, so a reload costs nothing. */
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  var swReloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', function () {
    if (swReloading) return;
    swReloading = true;
    // only reload for a genuine version swap, not the very first install
    if (navigator.serviceWorker.controller) location.reload();
  });
  window.addEventListener('load', function () {
    navigator.serviceWorker.register('sw.js').then(function (reg) {
      reg.update();                      // check for a new version on every launch
      setInterval(function () { reg.update(); }, 60 * 60 * 1000);
    }).catch(function () {});
  });
}
window.addEventListener('pageshow', function () {
  if (DATA && VIEW === 'programme' && !pinnedDay()) {
    var d = pickInitialDay();
    if (d !== DAY) setDay(d);
  }
});
el('content').innerHTML = '<div class="loading">Loading the programme…</div>';
boot();
