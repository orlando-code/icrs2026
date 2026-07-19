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
var PROFILE = '';
var VIEW = 'programme';
var DAY = null;
var RENDER_CAP = 600;

var LS_PROFILES = 'icrs2026.profiles';
var LS_CURRENT = 'icrs2026.current';
var LS_PICKS = 'icrs2026.picks.';
var LS_HELP = 'icrs2026.helpSeen';
var NZ_OFFSET = 12;          // Auckland is UTC+12 (NZST) for 19-24 July 2026

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
}
function setProfile(name) {
  PROFILE = name;
  try { localStorage.setItem(LS_CURRENT, name); } catch (e) {}
  PICKS = loadPicks(name);
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
    mine: el('onlyMine').checked
  };
}
function matches(rec, f) {
  var s = rec.session, t = rec.talk;
  if (f.room && s.room !== f.room) return false;
  if (f.theme && String(s.theme) !== f.theme) return false;
  if (f.mine && !PICKS.has(t.sid)) return false;
  if (f.q) {
    var hay = (t.title + ' ' + t.presenter + ' ' + (t.affiliation || '') + ' ' +
               (t.authors || []).join(' ') + ' ' + s.title + ' ' + (s.code || '')).toLowerCase();
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
  var plain = !f.q && !f.room && !f.theme && !f.mine;
  var evts = plain ? DATA.events.filter(function (e) {
    return DAY === 'all' || e.date === DAY;
  }) : [];

  if (!recs.length && !evts.length) {
    el('content').innerHTML = '<div class="empty"><h3>No talks match</h3><p>Try a different day, room, or search term.</p></div>';
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
      '</div></div>' +
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
  body.push('<div id="absWrap" class="abstract"><h3>Abstract</h3><div id="absText"></div></div>');
  el('talkBody').innerHTML = body.join('');

  var dlg = el('talkDlg');
  if (!dlg.open) dlg.showModal();       // open before filling: fillAbstract checks .open
  syncTalkStar();
  fillAbstract(sid);
  if (ABSTRACTS_STATE === 'idle') loadAbstracts();
  el('talkBody').scrollTop = 0;
}

/* Closing is explicit rather than relying on the dialog 'close'/'cancel' events:
   some engines (including Electron shells) never fire them, which would leave
   OPEN_SID pointing at a talk that is no longer on screen. */
function closeTalk() {
  OPEN_SID = null;
  var dlg = el('talkDlg');
  if (dlg.open) dlg.close();
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

/* ---------- calendar ---------- */
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
    var desc = (r.talk.honorific ? r.talk.honorific + ' ' : '') + r.talk.presenter +
      (r.talk.affiliation ? ' (' + r.talk.affiliation + ')' : '') +
      (r.session.code ? '\nSession ' + r.session.code + ' — ' + r.session.title : '') +
      ((r.talk.authors && r.talk.authors.length > 1) ? '\nAuthors: ' + r.talk.authors.join(', ') : '');
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
  var blob = new Blob([txt], { type: 'text/calendar;charset=utf-8' });
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'icrs2026-' + (PROFILE.toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'schedule') + '.ics';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
  toast('Calendar file downloaded (' + PICKS.size + ' talks).');
}

/* ---------- share ---------- */
function shareURL() {
  var sids = myPicks().map(function (r) { return r.talk.sid; }).join('');
  return location.origin + location.pathname + '#n=' + encodeURIComponent(PROFILE) + '&s=' + sids;
}
function copyShare() {
  if (!PICKS.size) { toast('Pick some talks first.'); return; }
  copyText(shareURL(), 'Share link copied — open it on your phone.');
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
function importFromHash() {
  var h = location.hash || '';
  var ms = h.match(/[#&]s=([0-9a-fA-F]+)/);
  if (!ms) return false;
  var name = '';
  var mn = h.match(/[#&]n=([^&]*)/);
  if (mn) { try { name = decodeURIComponent(mn[1]); } catch (e) { name = ''; } }
  var sids = ms[1].match(/.{1,8}/g) || [];
  var valid = sids.filter(function (s) { return BY_SID.has(s); });
  history.replaceState(null, '', location.pathname + location.search);
  if (!valid.length) { toast('That share link had no talks we recognise.'); return false; }

  var who = (name || 'Shared schedule').slice(0, 40);
  var msg = 'Import ' + valid.length + ' talk' + (valid.length === 1 ? '' : 's') +
    ' from a shared schedule into the profile "' + who + '"?' +
    (valid.length < sids.length ? '\n\n(' + (sids.length - valid.length) +
      ' entr' + (sids.length - valid.length === 1 ? 'y is' : 'ies are') +
      ' not in the current programme and will be skipped.)' : '');
  if (!window.confirm(msg)) return false;

  var list = profiles();
  if (list.indexOf(who) === -1) { list.push(who); saveProfiles(list); }
  setProfile(who);
  PICKS = new Set(valid);
  savePicks();
  updateCount();
  toast('Imported ' + valid.length + ' talks into "' + who + '".');
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
    try { localStorage.removeItem(LS_PICKS + old); } catch (e) {}
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
  el('talkDlg').addEventListener('cancel', function () { OPEN_SID = null; });
  // click the backdrop to dismiss
  el('talkDlg').addEventListener('click', function (ev) {
    if (ev.target === el('talkDlg')) closeTalk();
  });
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
  el('btnIcs').addEventListener('click', downloadICS);
  el('btnShare').addEventListener('click', copyShare);
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
el('content').innerHTML = '<div class="loading">Loading the programme…</div>';
boot();
