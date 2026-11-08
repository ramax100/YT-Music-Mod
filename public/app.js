/* ============================================================
   Rich Music — SPA frontend
   Streams via the official YouTube IFrame player, metadata via
   the local proxy to YouTube Music, synced lyrics via LRCLIB.
   ============================================================ */

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const icon = (id, cls = 'ic') => `<svg class="${cls}"><use href="#${id}"/></svg>`;

const api = async (path) => {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`${path} -> ${r.status}`);
  return r.json();
};

const fmtTime = (s) => {
  s = Math.max(0, Math.floor(s || 0));
  const m = Math.floor(s / 60), sec = s % 60;
  return `${m}:${String(sec).padStart(2, '0')}`;
};

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add('hidden'), 2200);
}

function hueFrom(str) {
  let h = 0;
  const s = String(str || 'home');
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return Math.abs(h) % 360;
}
function applyTint(key) {
  document.documentElement.style.setProperty('--tint', hueFrom(key));
  const main = $('#main');
  if (main) main.style.setProperty('--tint', hueFrom(key));
}
function currentTheme() {
  return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
}
function updateThemeIcon() {
  const use = $('#theme-ic use');
  if (use) use.setAttribute('href', currentTheme() === 'light' ? '#i-moon' : '#i-sun');
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', currentTheme() === 'light' ? '#ebebeb' : '#000000');
}
function toggleTheme() {
  const next = currentTheme() === 'light' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', next);
  store.set('theme', next);
  updateThemeIcon();
}
function openNowPlaying() {
  $('#nowplaying').classList.remove('hidden');
  document.body.classList.add('np-open');
}
function closeNowPlaying() {
  Player.pending = null;
  $('#nowplaying').classList.add('hidden');
  document.body.classList.remove('np-open');
  renderNowPlaying();
  renderPlayButtons();
  updateLikeButtons();
}
function focusedSong() { return Player.pending || Player.current; }
function isPreviewing() {
  return !!(Player.pending && (!Player.current || Player.pending.videoId !== Player.current.videoId));
}

/* ================= local library (localStorage) ================= */
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem('smw_' + k)) ?? d; } catch { return d; } },
  set(k, v) { localStorage.setItem('smw_' + k, JSON.stringify(v)); },
};
const Library = {
  get favorites() { return store.get('fav', []); },
  isFav(id) { return this.favorites.some((s) => s.videoId === id); },
  toggleFav(song) {
    let f = this.favorites;
    if (this.isFav(song.videoId)) { f = f.filter((s) => s.videoId !== song.videoId); toast('Removed from favorites'); }
    else { f.unshift(song); toast('Added to favorites'); }
    store.set('fav', f);
    updateLikeButtons();
    renderSidebarLibrary();
  },
  get playlists() { return store.get('pls', []); },
  createPlaylist(name) {
    const pls = this.playlists;
    const pl = { id: 'local_' + Date.now(), name, tracks: [] };
    pls.unshift(pl); store.set('pls', pls); renderSidebarLibrary(); return pl;
  },
  addToPlaylist(pid, song) {
    const pls = this.playlists;
    const pl = pls.find((p) => p.id === pid);
    if (!pl) return;
    if (!pl.tracks.some((t) => t.videoId === song.videoId)) pl.tracks.push(song);
    store.set('pls', pls);
  },
  removeFromPlaylist(pid, vid) {
    const pls = this.playlists;
    const pl = pls.find((p) => p.id === pid);
    if (!pl) return;
    pl.tracks = pl.tracks.filter((t) => t.videoId !== vid);
    store.set('pls', pls);
  },
  deletePlaylist(pid) { store.set('pls', this.playlists.filter((p) => p.id !== pid)); renderSidebarLibrary(); },
  renamePlaylist(pid, name) {
    const n = String(name || '').trim();
    if (!n) return;
    const pls = this.playlists;
    const pl = pls.find((p) => p.id === pid);
    if (!pl) return;
    pl.name = n;
    store.set('pls', pls);
    renderSidebarLibrary();
  },
  moveInPlaylist(pid, from, dir) {
    const pls = this.playlists;
    const pl = pls.find((p) => p.id === pid);
    if (!pl) return false;
    const to = from + dir;
    if (to < 0 || to >= pl.tracks.length) return false;
    const [item] = pl.tracks.splice(from, 1);
    pl.tracks.splice(to, 0, item);
    store.set('pls', pls);
    return true;
  },
  get saved() { return store.get('sav', []); },
  isSaved(browseId) { return this.saved.some((s) => s.browseId === browseId); },
  toggleSaved(item) {
    let sv = this.saved;
    if (this.isSaved(item.browseId)) { sv = sv.filter((s) => s.browseId !== item.browseId); toast('Removed from library'); }
    else { sv.unshift(item); toast('Saved to library'); }
    store.set('sav', sv);
    renderSidebarLibrary();
  },
  get history() { return store.get('hist', []); },
  pushHistory(song) {
    let h = this.history.filter((s) => s.videoId !== song.videoId);
    h.unshift({ ...song, playedAt: Date.now() });
    store.set('hist', h.slice(0, 100));
    // play stats (local scrobble)
    const st = store.get('stats', {});
    const k = song.videoId;
    if (!st[k]) st[k] = { title: song.title, artist: song.artist || '', thumbnail: song.thumbnail, plays: 0, secs: 0, last: 0 };
    st[k].plays++; st[k].last = Date.now();
    st[k].title = song.title; st[k].thumbnail = song.thumbnail;
    store.set('stats', st);
  },
  get stats() { return store.get('stats', {}); },
  addListenTime(videoId, secs) {
    const st = store.get('stats', {});
    if (st[videoId]) { st[videoId].secs += secs; store.set('stats', st); }
  },
};

/* ================= player state ================= */
const Player = {
  yt: null,
  ready: false,
  queue: [],
  index: -1,
  shuffle: false,
  repeat: 0, // 0 none, 1 all, 2 one
  lyrics: { synced: null, plain: null, source: null, lines: [] },
  lyricsBrowseId: null,
  relatedBrowseId: null,
  sleepTimer: null,
  speed: 1,
  sbSegments: [],
  sbEnabled: store.get('sb_on', true),
  autoplay: store.get('autoplay', true), // when on, a radio queue is built after the current song
  hq: store.get('yt_hq', false), // false = YouTube Music audio, true = YouTube max quality
  quality: 'hd720',
  muted: store.get('muted', false),
  preMuteVol: store.get('vol', 100), // volume to restore after unmute
  cued: false,
  wantPlay: false, // true while the user intends playback; false after an explicit user pause
  bgResumeTries: 0, // how many times we tried to resume after a browser-forced pause in background
  bgForced: false, // last pause was forced by the browser when the page went to the background
  hiddenAt: 0, // timestamp the page last became hidden
  context: '', // human label of where the queue came from (e.g. "Liked Songs")
  pending: null, // song shown in Now Playing while previous track keeps playing
  loadId: 0,
  get current() { return this.queue[this.index] || null; },
};
/* background playback tuning (used by onStateChange and tryBackgroundResume) */
const BG_RESUME_MAX = 6; // resume attempts per background session
const BG_FORCED_WINDOW = 5000; // a pause within this many ms of hiding counts as browser-forced

/* Playback uses the official YouTube IFrame.
   Default: YouTube Music audio version (official audio / ATV) at hd720.
   Quality ON: YouTube max (1080p–4K) for the highest audio bitrate. */
const QUALITY_RANK = ['highres', 'hd2160', 'hd1440', 'hd1080', 'hd720', 'large', 'medium', 'small', 'tiny'];
const qualityRank = (q) => { const i = QUALITY_RANK.indexOf(q); return i < 0 ? 99 : i; };
function bestQuality() {
  if (!Player.yt || !Player.ready || !Player.yt.getAvailableQualityLevels) return 'highres';
  const levels = Player.yt.getAvailableQualityLevels() || [];
  return QUALITY_RANK.find((q) => levels.includes(q)) || levels[0] || 'highres';
}
function suggestedQuality() { return Player.hq ? 'highres' : 'hd720'; }
function applyPlaybackQuality() {
  if (!Player.yt || !Player.ready) return;
  if (Player.hq) {
    const best = bestQuality();
    Player.quality = best;
    try { Player.yt.setSize(1920, 1080); } catch {}
    try { Player.yt.setPlaybackQuality(best); } catch {}
    try { Player.yt.setPlaybackQualityRange(best, best); } catch {}
  } else {
    Player.quality = 'hd720';
    try { Player.yt.setSize(720, 720); } catch {}
    try { Player.yt.setPlaybackQuality('hd720'); } catch {}
    try { Player.yt.setPlaybackQualityRange('hd720', 'hd720'); } catch {}
  }
}
function updateQualityButton() {
  const btn = $('#np-quality');
  if (!btn) return;
  btn.classList.toggle('on', !!Player.hq);
  const span = btn.querySelector('span');
  if (span) span.textContent = Player.hq ? 'Max' : 'Quality';
  btn.title = Player.hq
    ? 'YouTube max quality — tap for YouTube Music audio'
    : 'YouTube Music audio — tap for YouTube max quality';
  document.body.classList.toggle('hq-audio', !!Player.hq);
  syncNpMore();
}
function toggleQuality() {
  Player.hq = !Player.hq;
  store.set('yt_hq', Player.hq);
  updateQualityButton();
  toast(Player.hq ? 'YouTube max quality' : 'YouTube Music audio');
  if (Player.cued || !Player.yt || !Player.ready || !Player.current) {
    applyPlaybackQuality();
    return;
  }
  const t = (Player.yt.getCurrentTime && Player.yt.getCurrentTime()) || 0;
  Player.yt.loadVideoById({
    videoId: Player.current.videoId,
    startSeconds: t,
    suggestedQuality: suggestedQuality(),
  });
  applyPlaybackQuality();
  setTimeout(applyPlaybackQuality, 400);
  setTimeout(applyPlaybackQuality, 1600);
}

window.onYouTubeIframeAPIReady = () => {
  Player.yt = new YT.Player('yt-player', {
    height: '720', width: '720',
    host: 'https://www.youtube.com',
    playerVars: {
      playsinline: 1,
      controls: 0,
      disablekb: 1,
      origin: location.origin,
      modestbranding: 1,
      rel: 0,
      iv_load_policy: 3,
      fs: 0,
      vq: 'hd720',
    },
    events: {
      onReady: () => {
        Player.ready = true;
        applyVolumeUI(); // apply saved volume, honoring mute state
        applyPlaybackQuality();
        try {
          const iframe = Player.yt.getIframe && Player.yt.getIframe();
          if (iframe) iframe.setAttribute('allow', 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share');
        } catch {}
      },
      onStateChange: (e) => {
        if (e.data === YT.PlayerState.ENDED) {
          try {
            const vid = Player.yt.getVideoData && Player.yt.getVideoData().video_id;
            if (vid && Player.current && vid !== Player.current.videoId) return;
          } catch {}
          nextTrack(true);
        }
        if (e.data === YT.PlayerState.PLAYING) {
          setTimeout(maybeRetryLyrics, 600);
          applyPlaybackQuality();
          setTimeout(applyPlaybackQuality, 500);
          setTimeout(applyPlaybackQuality, 2000);
        }
        if (e.data === YT.PlayerState.BUFFERING) applyPlaybackQuality();
        document.body.classList.toggle('paused', e.data !== YT.PlayerState.PLAYING);
        // 1) classify the pause before anything reads wantPlay
        if (e.data === YT.PlayerState.PLAYING) {
          Player.bgResumeTries = 0;
          Player.bgForced = false;
        } else if (e.data === YT.PlayerState.PAUSED && Player.wantPlay) {
          if (document.hidden && Date.now() - Player.hiddenAt < BG_FORCED_WINDOW) {
            // paused right as the page went to the background: browser-forced, resume it
            Player.bgForced = true;
          } else {
            // any other pause we didn't initiate (headphones unplugged, phone call,
            // OS media control) — respect it and stop trying to resume
            Player.wantPlay = false;
            Player.bgForced = false;
          }
        }
        // 2) keep the lock screen / notification in sync
        if ('mediaSession' in navigator) {
          try {
            if (e.data === YT.PlayerState.PLAYING) navigator.mediaSession.playbackState = 'playing';
            else if (e.data === YT.PlayerState.PAUSED && !Player.bgForced) navigator.mediaSession.playbackState = 'paused';
          } catch {}
        }
        if (e.data === YT.PlayerState.PLAYING) updateMediaPosition(true);
        // 3) resume a browser-forced pause
        if (Player.bgForced) tryBackgroundResume();
        renderPlayButtons();
      },
      onPlaybackQualityChange: (e) => {
        if (!Player.hq) return;
        const best = bestQuality();
        if (e.data && qualityRank(e.data) > qualityRank(best)) applyPlaybackQuality();
      },
      onError: () => { toast('Track unavailable, skipping…'); setTimeout(() => nextTrack(true), 800); },
    },
  });
};
(() => { const s = document.createElement('script'); s.src = 'https://www.youtube.com/iframe_api'; document.head.appendChild(s); })();

function playSong(song, queue = null, index = null, context = '') {
  if (!song || !song.videoId) return;
  song = normalizeSong(song);
  Player.cued = false;
  Player.pending = null;
  Player.context = context || '';
  if (queue) {
    Player.queue = queue.map((q) => ({ ...normalizeSong(q), _user: false }));
    let idx = index ?? queue.findIndex((q) => q.videoId === song.videoId);
    if (!Number.isFinite(idx) || idx < 0) idx = 0;
    Player.index = idx;
  } else { Player.queue = [{ ...song, _user: false }]; Player.index = 0; }
  startCurrent();
  if (!queue || queue.length <= 1) fetchQueue(song); // build radio queue
}

function userQueueCount() {
  return Player.queue.filter((q, i) => i > Player.index && q._user).length;
}
function alreadyQueued(videoId) {
  return Player.queue.some((q, i) => i > Player.index && q._user && q.videoId === videoId);
}
function queueSong(song, playNext = false) {
  if (!song || !song.videoId) return;
  const s = { ...normalizeSong(song), _user: true };
  if (!Player.current) { playSong(s); return; }
  if (!playNext && alreadyQueued(song.videoId)) {
    toast('Already in your queue');
    renderQueue();
    return;
  }
  if (playNext) {
    Player.queue.splice(Player.index + 1, 0, s);
    toast('Playing next');
  } else {
    let i = Player.index + 1;
    while (i < Player.queue.length && Player.queue[i]._user) i++;
    Player.queue.splice(i, 0, s);
    toast('Added to your queue');
  }
  renderQueue();
}
function removeQueued(i) {
  if (i === Player.index || i < 0 || i >= Player.queue.length) return;
  if (i < Player.index) Player.index--;
  Player.queue.splice(i, 1);
  renderQueue();
}
function clearUserQueue() {
  Player.queue = Player.queue.filter((q, i) => i <= Player.index || !q._user);
  renderQueue();
  toast('Queue cleared');
}
function slimSong(s) {
  if (!s || !s.videoId) return null;
  return {
    videoId: s.videoId,
    title: s.title || '',
    artist: s.artist || s.subtitle || '',
    thumbnail: s.thumbnail || '',
    duration: s.duration || '',
    playlistId: s.playlistId || '',
    _user: !!s._user,
  };
}
function persistQueue() {
  try {
    if (!Player.queue.length) {
      localStorage.removeItem('smw_qstate');
      return;
    }
    const q = Player.queue.map(slimSong).filter(Boolean).slice(0, 80);
    store.set('qstate', {
      queue: q,
      index: Math.min(Math.max(0, Player.index), q.length - 1),
      shuffle: !!Player.shuffle,
      repeat: Player.repeat || 0,
      speed: Player.speed || 1,
      context: Player.context || '',
    });
  } catch {}
}
function restoreQueue() {
  const st = store.get('qstate', null);
  if (!st || !Array.isArray(st.queue) || !st.queue.length) return false;
  Player.queue = st.queue.map((s) => ({ ...normalizeSong(s), _user: !!s._user }));
  Player.index = Math.min(Math.max(0, Number(st.index) || 0), Player.queue.length - 1);
  Player.shuffle = !!st.shuffle;
  Player.repeat = (st.repeat === 1 || st.repeat === 2) ? st.repeat : 0;
  if (typeof st.speed === 'number' && st.speed > 0) Player.speed = st.speed;
  Player.context = typeof st.context === 'string' ? st.context : '';
  Player.cued = true;
  Player.pending = null;
  const s = Player.current;
  if (!s) return false;
  const loadId = ++Player.loadId;
  const tryCue = () => {
    if (loadId !== Player.loadId) return;
    if (!Player.ready) return setTimeout(tryCue, 300);
    try {
      Player.yt.cueVideoById({ videoId: s.videoId, suggestedQuality: suggestedQuality() });
      Player.yt.setPlaybackRate(Player.speed);
    } catch {}
  };
  tryCue();
  renderNowPlaying();
  renderQueue();
  updateLikeButtons();
  renderPlayButtons();
  $('#miniplayer').classList.remove('hidden');
  document.body.classList.add('has-player', 'paused');
  document.title = `${s.title} • Rich Music`;
  applyTint(s.videoId || s.title);
  const shOn = Player.shuffle;
  $('#mini-shuffle') && $('#mini-shuffle').classList.toggle('on', shOn);
  $('#np-shuffle') && $('#np-shuffle').classList.toggle('on', shOn);
  const on = Player.repeat > 0;
  const ic = icon(Player.repeat === 2 ? 'i-repeat-1' : 'i-repeat');
  [$('#mini-repeat'), $('#np-repeat')].forEach((b) => {
    if (!b) return;
    b.classList.toggle('on', on);
    b.innerHTML = ic;
  });
  const sp = $('#np-speed span');
  if (sp) sp.textContent = Player.speed + '×';
  return true;
}
function moveQueued(i, dir) {
  const to = i + dir;
  if (!Number.isFinite(i) || i <= Player.index || to <= Player.index) return;
  if (to >= Player.queue.length) return;
  if (!Player.queue[i] || !Player.queue[i]._user) return;
  if (!Player.queue[to] || !Player.queue[to]._user) return;
  const [item] = Player.queue.splice(i, 1);
  Player.queue.splice(to, 0, item);
  renderQueue();
}

function startCurrent() {
  Player.cued = false;
  Player.pending = null;
  const s = Player.current;
  if (!s) return;
  const loadId = ++Player.loadId;
  const tryPlay = () => {
    if (loadId !== Player.loadId) return;
    if (!Player.ready) return setTimeout(tryPlay, 300);
    Player.wantPlay = true;
    Player.bgResumeTries = 0;
    Player.yt.loadVideoById({ videoId: s.videoId, suggestedQuality: suggestedQuality() });
    Player.yt.setPlaybackRate(Player.speed);
    Player.yt.playVideo();
    applyPlaybackQuality();
    setTimeout(applyPlaybackQuality, 400);
    setTimeout(applyPlaybackQuality, 1600);
  };
  tryPlay();
  Library.pushHistory(s);
  Player.lyrics = { synced: null, plain: null, source: null, lines: [] };
  Player._lyricsRetried = false;
  Player._lyricsDur = 0;
  lastLyricIdx = -1;
  syncFloatLyric('');
  renderNowPlaying();
  renderQueue();
  updateLikeButtons();
  $('#miniplayer').classList.remove('hidden');
  document.body.classList.add('has-player');
  document.title = `${s.title} • Rich Music`;
  applyTint(s.videoId || s.title);
  if ('mediaSession' in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: s.title, artist: s.artist || '',
      artwork: s.thumbnail ? [{ src: s.thumbnail, sizes: '544x544' }] : [],
    });
    const setHandler = (action, fn) => {
      try { navigator.mediaSession.setActionHandler(action, fn); } catch {} // unsupported action
    };
    setHandler('previoustrack', prevTrack);
    setHandler('nexttrack', () => nextTrack(false));
    setHandler('play', userPlay);
    setHandler('pause', userPause);
    setHandler('stop', userPause);
    setHandler('seekto', (d) => {
      if (!Player.yt || !Player.ready || d == null || !Number.isFinite(d.seekTime)) return;
      Player.yt.seekTo(d.seekTime, true);
      updateMediaPosition(true);
    });
    setHandler('seekbackward', (d) => {
      if (!Player.yt || !Player.ready) return;
      const t = (Player.yt.getCurrentTime() || 0) - ((d && d.seekOffset) || 10);
      Player.yt.seekTo(Math.max(0, t), true);
      updateMediaPosition(true);
    });
    setHandler('seekforward', (d) => {
      if (!Player.yt || !Player.ready) return;
      const dur = Player.yt.getDuration() || 0;
      const t = (Player.yt.getCurrentTime() || 0) + ((d && d.seekOffset) || 10);
      Player.yt.seekTo(dur ? Math.min(dur - 1, t) : t, true);
      updateMediaPosition(true);
    });
  }
  loadLyrics(s);
  loadSponsorBlock(s.videoId);
  // refresh related tab lazily
  Player.relatedBrowseId = null; // stale — belongs to the previous song until fetchQueue returns
  Player.lyricsBrowseId = null;
  $('#related-list').innerHTML = '<div class="loading-note">Loading…</div>';
  Player._relatedLoaded = false;
  // if the Related tab is currently open, reload it right away for the new song
  // (small delay so fetchQueue for the new song has started first)
  if ($('#np-related').classList.contains('active') && !$('#nowplaying').classList.contains('hidden')) {
    setTimeout(() => loadRelated(true), 150);
  }
}

async function fetchQueue(song) {
  const vid = song && song.videoId;
  const loadId = Player.loadId;
  Player._queueFetching = true;
  try {
    const d = await api(`/api/next?videoId=${encodeURIComponent(song.videoId)}${song.playlistId ? `&playlistId=${encodeURIComponent(song.playlistId)}` : ''}`);
    if (Player.cued || loadId !== Player.loadId) return;
    if (!vid || !Player.current || Player.current.videoId !== vid) return;
    Player.lyricsBrowseId = d.lyricsBrowseId;
    Player.relatedBrowseId = d.relatedBrowseId;
    // Autoplay off: skip building the radio queue (lyrics/related still load above).
    if (Player.autoplay && d.queue && d.queue.length > 1) {
      const current = Player.current;
      const userUpcoming = Player.queue.filter((q, i) => i > Player.index && q._user);
      const radio = d.queue
        .filter((q) => q.videoId && q.videoId !== (current && current.videoId))
        .filter((q) => !userUpcoming.some((u) => u.videoId === q.videoId))
        .map((q) => ({ ...normalizeSong(q), artist: q.artist, _user: false }));
      Player.queue = [current, ...userUpcoming, ...radio].filter(Boolean);
      Player.index = 0;
      renderQueue();
    }
    if (!Player.lyrics.synced && !Player.lyrics.plain) loadLyrics(Player.current, { silent: true });
  } catch (e) { console.warn('queue fail', e); }
  finally {
    if (loadId === Player.loadId) Player._queueFetching = false;
  }
}

function nextTrack(auto) {
  if (Player.cued) {
    if (auto) return;
    togglePlay();
    return;
  }
  if (Player.repeat === 2 && auto) { Player.yt.seekTo(0); Player.yt.playVideo(); return; }
  if (!Player.queue.length) return;
  let ni;
  if (Player.shuffle) {
    const userNext = Player.queue.findIndex((q, i) => i > Player.index && q._user);
    if (userNext >= 0) ni = userNext;
    else {
      const others = Player.queue.map((_, i) => i).filter((i) => i !== Player.index);
      if (!others.length) {
        if (Player.repeat === 1) ni = Player.index;
        else return;
      } else ni = others[Math.floor(Math.random() * others.length)];
    }
  } else ni = Player.index + 1;
  if (ni >= Player.queue.length) {
    if (Player.repeat === 1) ni = 0;
    else return;
  }
  Player.index = ni;
  startCurrent();
}
function prevTrack() {
  if (Player.cued) { togglePlay(); return; }
  if (Player.yt && Player.yt.getCurrentTime && Player.yt.getCurrentTime() > 4) { Player.yt.seekTo(0); return; }
  if (Player.index > 0) { Player.index--; startCurrent(); }
  else if (Player.yt) Player.yt.seekTo(0);
}
/* Explicit user play/pause. wantPlay separates a pause the user asked for
   from a pause the browser forces when the page goes to the background. */
function userPlay() {
  if (!Player.yt || !Player.ready) return;
  Player.wantPlay = true;
  Player.bgResumeTries = 0;
  try { Player.yt.playVideo(); } catch {}
}
function userPause() {
  Player.wantPlay = false;
  if (Player.yt && Player.ready) { try { Player.yt.pauseVideo(); } catch {} }
}
function togglePlay() {
  if (!Player.current) return;
  if (Player.cued) {
    const s = Player.current;
    const hasRadio = Player.queue.some((q, i) => i > Player.index && !q._user);
    startCurrent();
    if (!hasRadio) fetchQueue(s);
    return;
  }
  if (!Player.yt || !Player.ready) return;
  const st = Player.yt.getPlayerState();
  if (st === YT.PlayerState.PLAYING) userPause();
  else userPlay();
}
function playPendingSong() {
  const s = Player.pending;
  if (!s || !s.videoId) return togglePlay();
  Player.pending = null;
  Player.context = ''; // picked a standalone song — no collection context
  const userUpcoming = Player.queue.filter((q, i) => i > Player.index && q._user);
  Player.queue = [{ ...normalizeSong(s), _user: false }, ...userUpcoming];
  Player.index = 0;
  startCurrent();
  fetchQueue(s);
}
function toggleNowPlayingPlay() {
  if (isPreviewing()) {
    playPendingSong();
    return;
  }
  togglePlay();
}

/* progress loop */
let _lastTick = null;
setInterval(() => {
  if (!Player.yt || !Player.ready || !Player.current || !Player.yt.getDuration) return;
  const cur = Player.yt.getCurrentTime() || 0;
  // local scrobble: accumulate listen time while playing
  const playing = Player.yt.getPlayerState && Player.yt.getPlayerState() === YT.PlayerState.PLAYING;
  const now = Date.now();
  if (playing && _lastTick) Library.addListenTime(Player.current.videoId, Math.min(2, (now - _lastTick) / 1000));
  _lastTick = now;
  // SponsorBlock auto-skip
  if (playing && Player.sbEnabled && Player.sbSegments.length) {
    const seg = Player.sbSegments.find((g) => cur >= g.start && cur < g.end - 0.3);
    if (seg) {
      Player.yt.seekTo(seg.end, true);
      toast(`⏩ Skipped ${seg.category.replace('_', ' ')} (SponsorBlock)`);
    }
  }
  const dur = Player.yt.getDuration() || 0;
  const pct = dur ? (cur / dur) * 100 : 0;
  $('#mini-progress-fill').style.width = pct + '%';
  const knob = $('.pb-knob');
  if (knob) knob.style.left = pct + '%';
  $('#mini-cur').textContent = fmtTime(cur);
  $('#mini-dur').textContent = fmtTime(dur);
  if (!isPreviewing() && !seekDragging) {
    $('#np-range').value = dur ? Math.round((cur / dur) * 1000) : 0;
    $('#np-cur').textContent = fmtTime(cur);
    $('#np-dur').textContent = fmtTime(dur);
  }
  if (!isPreviewing()) updateLyricHighlight(cur);
  syncFloatProgress(pct);
  if (Player.floatOn) drawPipFrame(pct);
  updateMediaPosition(false);
}, 400);

/* Lock-screen / notification progress bar (Media Session position state). */
let _lastPosSync = 0;
function updateMediaPosition(force) {
  if (!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return;
  if (!Player.yt || !Player.ready || !Player.yt.getDuration) return;
  const now = Date.now();
  if (!force && now - _lastPosSync < 5000) return; // browsers extrapolate between syncs
  const dur = Player.yt.getDuration() || 0;
  if (!(dur > 0)) return;
  const pos = Math.min(dur, Math.max(0, Player.yt.getCurrentTime() || 0));
  try {
    navigator.mediaSession.setPositionState({ duration: dur, position: pos, playbackRate: Player.speed || 1 });
    _lastPosSync = now;
  } catch {}
}

function renderPlayButtons() {
  const actuallyPlaying = Player.yt && Player.ready && Player.yt.getPlayerState && Player.yt.getPlayerState() === YT.PlayerState.PLAYING;
  const preview = isPreviewing();
  $('#mini-play').innerHTML = icon(actuallyPlaying ? 'i-pause' : 'i-play');
  $('#np-play').innerHTML = icon(!preview && actuallyPlaying ? 'i-pause' : 'i-play');
  const pn = $('#np-playnext');
  const qa = $('#np-queueadd');
  if (pn) pn.classList.toggle('hidden', !preview);
  if (qa) qa.classList.toggle('hidden', !preview);
  syncFloatWidget();
}

/* ================= SponsorBlock / votes / speed / video ================= */
async function loadSponsorBlock(videoId) {
  Player.sbSegments = [];
  try {
    const d = await api(`/api/sponsorblock?videoId=${encodeURIComponent(videoId)}`);
    Player.sbSegments = d.segments || [];
    if (Player.sbSegments.length && Player.sbEnabled) toast(`SponsorBlock: ${Player.sbSegments.length} segment(s) will be skipped`);
  } catch {}
}
const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
function cycleSpeed() {
  const i = SPEEDS.indexOf(Player.speed);
  Player.speed = SPEEDS[(i + 1) % SPEEDS.length];
  if (Player.yt && Player.ready) Player.yt.setPlaybackRate(Player.speed);
  $('#np-speed span').textContent = Player.speed + '×';
  persistQueue();
  toast(`Speed: ${Player.speed}×`);
}
function toggleSB() {
  Player.sbEnabled = !Player.sbEnabled;
  store.set('sb_on', Player.sbEnabled);
  $('#np-sb').classList.toggle('on', Player.sbEnabled);
  syncNpMore();
  toast(Player.sbEnabled ? 'SponsorBlock on' : 'SponsorBlock off');
}
function toggleAutoplay() {
  Player.autoplay = !Player.autoplay;
  store.set('autoplay', Player.autoplay);
  if (Player.autoplay) {
    // turning on: build a radio queue for the current song if there's none yet
    const hasRadio = Player.queue.some((q, i) => i > Player.index && !q._user);
    if (Player.current && !hasRadio && !Player.cued) fetchQueue(Player.current);
  } else {
    // turning off: drop upcoming radio tracks, keep the user's manual queue
    const kept = Player.queue.filter((q, i) => i <= Player.index || q._user);
    Player.index = kept.indexOf(Player.current);
    if (Player.index < 0) Player.index = 0;
    Player.queue = kept;
    renderQueue();
  }
  syncNpMore();
  toast(Player.autoplay ? 'Autoplay on' : 'Autoplay off');
}

/* ================= lyrics ================= */
let lyricsReqId = 0; // guard against out-of-order responses on fast skips
async function loadLyrics(song, { silent = false } = {}) {
  if (!song) return;
  const myReq = ++lyricsReqId;
  const durationSec = (() => {
    if (Player.yt && Player.ready && Player.yt.getDuration) return Math.round(Player.yt.getDuration() || 0);
    return 0;
  })();
  Player._lyricsDur = durationSec;
  const artist = [song.artist, song.artists && song.artists[0] && song.artists[0].name, song.subtitle]
    .map((x) => String(x || '').split('•')[0].replace(/\s*-\s*topic$/i, '').trim())
    .find((x) => x && !looksLikePlays(x)) || '';
  const title = displayTitle(song.title) || song.title;
  if (!silent && !Player.lyrics.synced && !Player.lyrics.plain) {
    $('#lyrics-container').innerHTML = '<div class="lyrics-empty">Looking for lyrics…</div>';
  }
  try {
    const d = await api(`/api/lyrics?title=${encodeURIComponent(title)}&artist=${encodeURIComponent(artist)}&duration=${durationSec}&browseId=${encodeURIComponent(Player.lyricsBrowseId || '')}`);
    if (myReq !== lyricsReqId) return; // a newer request superseded us
    // never downgrade: keep existing synced lyrics if the retry found less
    if (Player.lyrics.synced && !d.synced) return;
    Player.lyrics = { ...d, lines: d.synced ? parseLRC(d.synced) : [] };
  } catch {
    if (myReq !== lyricsReqId) return;
    if (!Player.lyrics.synced && !Player.lyrics.plain) Player.lyrics = { synced: null, plain: null, source: null, lines: [] };
  }
  renderLyrics();
}
/* retry once the real duration is known (player loaded after first attempt),
   or when the first attempt found nothing */
function maybeRetryLyrics() {
  const s = Player.current;
  if (!s || !Player.yt || !Player.ready || !Player.yt.getDuration) return;
  const dur = Math.round(Player.yt.getDuration() || 0);
  if (!dur) return;
  const noLyrics = !Player.lyrics.synced && !Player.lyrics.plain;
  const durChanged = Math.abs(dur - (Player._lyricsDur || 0)) > 2;
  if ((noLyrics || (durChanged && !Player.lyrics.synced)) && !Player._lyricsRetried) {
    Player._lyricsRetried = true;
    loadLyrics(s, { silent: true });
  }
}
function parseLRC(lrc) {
  const lines = [];
  for (const raw of String(lrc || '').split('\n')) {
    const m = raw.match(/\[(\d+):(\d+)(?:[.:](\d+))?\](.*)/);
    if (!m) continue;
    const frac = m[3] ? Number(`0.${m[3]}`) : 0;
    lines.push({ t: parseInt(m[1], 10) * 60 + parseInt(m[2], 10) + frac, text: (m[4] || '').trim() });
  }
  return lines.sort((a, b) => a.t - b.t);
}
function renderLyrics() {
  const c = $('#lyrics-container');
  const src = $('#lyrics-source');
  const L = Player.lyrics;
  if (L.lines.length) {
    c.innerHTML = L.lines.map((l, i) => `<div class="lyric-line" data-i="${i}" data-t="${l.t}">${esc(l.text) || '♪'}</div>`).join('');
    $$('.lyric-line', c).forEach((el) => el.addEventListener('click', () => { Player.yt.seekTo(parseFloat(el.dataset.t)); userPlay(); }));
  } else if (L.plain) {
    c.innerHTML = `<div class="lyric-plain">${esc(L.plain)}</div>`;
  } else {
    c.innerHTML = `<div class="lyrics-empty">No lyrics found for this track<br><br>
      <button class="pill-btn" id="lyrics-retry">${icon('i-repeat')}<span>Try again</span></button></div>`;
    const rb = $('#lyrics-retry', c);
    if (rb) rb.addEventListener('click', () => {
      Player._lyricsRetried = false;
      loadLyrics(Player.current);
    });
  }
  src.textContent = L.source ? `Lyrics provided by ${L.source}` : '';
  lastLyricIdx = -1;
  if (L.lines.length) {
    $('#np-lyric-preview').textContent = '';
    syncFloatLyric('');
  } else if (L.plain) {
    const first = String(L.plain).split('\n').map((x) => x.trim()).find(Boolean) || '';
    $('#np-lyric-preview').textContent = first;
    syncFloatLyric(first);
  } else {
    $('#np-lyric-preview').textContent = '';
    syncFloatLyric('');
  }
}
let lastLyricIdx = -1;
function updateLyricHighlight(cur) {
  const L = Player.lyrics;
  if (!L.lines.length) return;
  let idx = -1;
  for (let i = 0; i < L.lines.length; i++) { if (cur >= L.lines[i].t - 0.2) idx = i; else break; }
  if (idx === lastLyricIdx) return;
  lastLyricIdx = idx;
  const c = $('#lyrics-container');
  $$('.lyric-line', c).forEach((el, i) => {
    el.classList.toggle('active', i === idx);
    el.classList.toggle('past', i < idx);
  });
  const active = c.querySelector('.lyric-line.active');
  if (active && $('#np-lyrics').classList.contains('active')) active.scrollIntoView({ block: 'center', behavior: 'smooth' });
  const line = idx >= 0 ? L.lines[idx].text : '';
  $('#np-lyric-preview').textContent = line;
  syncFloatLyric(line);
}

/* ================= now playing UI ================= */
function renderNowPlaying() {
  const mini = Player.current;
  const np = Player.pending || Player.current;
  if (mini) {
    $('#mini-art').src = mini.thumbnail || '';
    const mt = $('#mini-title');
    const ma = $('#mini-artist');
    const title = displayTitle(mini.title) || mini.title || '';
    mt.textContent = title;
    mt.title = title;
    const artist = mini.artist || mini.subtitle || '';
    ma.textContent = artist;
    ma.title = artist;
    ma.classList.toggle('linkish', !!(songArtistBrowseId(mini) || artist.trim()));
  }
  if (!np) return;
  $('#np-art').src = safeCover(np.thumbnail) || COVER_PH;
  $('#np-title').textContent = np.title;
  const artEl = $('#np-artist');
  artEl.textContent = np.artist || np.subtitle || '';
  artEl.classList.toggle('linkish', !!(songArtistBrowseId(np) || (np.artist || '').trim()));
  $('#np-bg').style.backgroundImage = np.thumbnail ? `url("${np.thumbnail}")` : 'none';
  syncFloatWidget();
}
function updateLikeButtons() {
  const mini = Player.current;
  const np = Player.pending || Player.current;
  const miniLiked = mini && Library.isFav(mini.videoId);
  const npLiked = np && Library.isFav(np.videoId);
  $('#mini-like').innerHTML = icon(miniLiked ? 'i-heart-f' : 'i-heart-o');
  $('#mini-like').classList.toggle('liked', !!miniLiked);
  $('#np-like').innerHTML = icon(npLiked ? 'i-heart-f' : 'i-heart-o') + `<span>${npLiked ? 'Favorited' : 'Favorite'}</span>`;
  $('#np-like').classList.toggle('liked', !!npLiked);
  renderSidebarLibrary();
}
function renderSideQueue() {
  const el = $('#side-queue');
  const clr = $('#side-q-clear');
  if (!el) return;
  const n = userQueueCount();
  if (clr) clr.classList.toggle('hidden', n === 0);
  if (!Player.current) {
    el.innerHTML = '<div class="sq-empty">Play a song, then tap the queue icon to add tracks here.</div>';
    return;
  }
  const upcoming = [];
  Player.queue.forEach((q, i) => { if (i > Player.index) upcoming.push({ q, i }); });
  const user = upcoming.filter((x) => x.q._user);
  const now = Player.current;
  let html = `<div class="sq-sec">Now playing</div>
    <button type="button" class="sq-row now" data-qi="${Player.index}">
      ${coverHTML(now.thumbnail, 'sq')}
      <span class="sq-meta"><span class="sq-t">${esc(now.title)}</span><br><span class="sq-s">${esc(now.artist || now.subtitle || '')}</span></span>
    </button>`;
  if (user.length) {
    html += `<div class="sq-sec">Your queue · ${user.length}</div>`;
    html += user.map(({ q, i }, n) => `<button type="button" class="sq-row" data-qi="${i}">
      <span class="sq-n">${n + 1}</span>
      ${coverHTML(q.thumbnail, 'sq')}
      <span class="sq-meta"><span class="sq-t">${esc(q.title)}</span><br><span class="sq-s">${esc(q.artist || q.subtitle || '')}</span></span>
    </button>`).join('');
  } else {
    html += `<div class="sq-empty">Your queue is empty. Tap ${icon('i-queue')} on a song.</div>`;
  }
  el.innerHTML = html;
  $$('.sq-row', el).forEach((b) => b.addEventListener('click', () => {
    const idx = Number(b.dataset.qi);
    if (!Number.isFinite(idx) || idx < 0) return;
    if (idx === Player.index) {
      openNowPlaying();
      switchNPTab('player');
      return;
    }
    Player.index = idx;
    startCurrent();
  }));
}
function updateQueueTab() {
  const n = userQueueCount();
  $$('.np-tab').forEach((t) => {
    if (t.dataset.nptab !== 'queue') return;
    const ic = t.querySelector('svg');
    t.innerHTML = (ic ? ic.outerHTML : icon('i-queue')) + (n ? `Queue · ${n}` : 'Queue');
  });
  [$('#mini-queue'), $('#mini-queue-m')].forEach((b) => {
    if (!b) return;
    b.classList.toggle('has-q', n > 0);
    b.title = n ? `Queue · ${n}` : 'Queue';
  });
}
function renderQueue() {
  updateQueueTab();
  renderSideQueue();
  persistQueue();
  const el = $('#queue-list');
  if (!el) return;
  if (!Player.queue.length) {
    el.innerHTML = `<div class="q-empty">
      <div class="q-empty-title">Queue is empty</div>
      <div class="q-empty-s">Tap the queue icon on any song to add it here. Songs you add play before radio.</div>
    </div>`;
    persistQueue();
    return;
  }
  const upcoming = [];
  Player.queue.forEach((q, i) => { if (i > Player.index) upcoming.push({ q, i }); });
  const user = upcoming.filter((x) => x.q._user);
  const radio = upcoming.filter((x) => !x.q._user);
  const now = Player.current;
  let html = '';
  if (Player.context) {
    html += `<div class="q-context">Playing from <b>${esc(Player.context)}</b></div>`;
  }
  html += `<div class="q-note">${Player.autoplay ? 'Your queue plays first. Radio fills in after.' : 'Your queue plays first. Autoplay is off, so playback stops when it ends.'}</div>`;
  if (now) {
    html += `<div class="q-head">Now playing</div>${trackRowHTML({ ...now, qi: Player.index }, true)}`;
  }
  if (user.length) {
    html += `<div class="q-head q-head-row"><span>Your queue · ${user.length}</span><button type="button" class="q-clear" id="q-clear">Clear</button></div>`;
    html += user.map(({ q, i }, n) => {
      const up = n === 0 ? ' disabled' : '';
      const dn = n === user.length - 1 ? ' disabled' : '';
      return trackRowHTML({ ...q, qi: i, qn: n + 1 }, false,
        `<button class="tbtn btn-qup" data-qi="${i}" title="Move up"${up}>${icon('i-chev-up')}</button>` +
        `<button class="tbtn btn-qdn" data-qi="${i}" title="Move down"${dn}>${icon('i-chev-down')}</button>` +
        `<button class="tbtn btn-qrm" data-qi="${i}" title="Remove from queue">${icon('i-x')}</button>`);
    }).join('');
  } else {
    html += `<div class="q-head">Your queue</div><div class="q-hint">Nothing queued yet — tap the queue icon on a song, or Play next on Now Playing.</div>`;
  }
  if (radio.length) {
    html += `<div class="q-head">From radio · ${radio.length}</div>`;
    html += radio.map(({ q, i }) => trackRowHTML({ ...q, qi: i, qRadio: true }, false)).join('');
  }
  el.innerHTML = html;
  $$('.track', el).forEach((row) => {
    let it;
    try { it = JSON.parse(row.dataset.item); } catch { return; }
    row.addEventListener('click', (e) => {
      if (e.target.closest('.tbtn')) return;
      const idx = Number(row.dataset.qi);
      if (Number.isFinite(idx) && idx >= 0) { Player.index = idx; startCurrent(); }
    });
    const favBtn = $('.btn-fav', row);
    if (favBtn) favBtn.addEventListener('click', (e) => { e.stopPropagation(); Library.toggleFav(songFromItem(it)); favBtn.innerHTML = icon(Library.isFav(it.videoId) ? 'i-heart-f' : 'i-heart-o'); });
    const addBtn = $('.btn-addpl', row);
    if (addBtn) addBtn.addEventListener('click', (e) => { e.stopPropagation(); openAddToPlaylist(songFromItem(it)); });
    const qBtn = $('.btn-queue', row);
    if (qBtn) qBtn.addEventListener('click', (e) => { e.stopPropagation(); queueSong(songFromItem(it)); });
    const dlBtn = $('.btn-dl', row);
    if (dlBtn) dlBtn.addEventListener('click', (e) => { e.stopPropagation(); downloadSong(songFromItem(it)); });
    const moreBtn = $('.btn-more', row);
    if (moreBtn) moreBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const qi = Number(row.dataset.qi);
      openSongMenu(songFromItem(it), { qi: Number.isFinite(qi) ? qi : undefined });
    });
  });
  $$('.btn-qrm', el).forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); removeQueued(Number(b.dataset.qi)); }));
  $$('.btn-qup', el).forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); moveQueued(Number(b.dataset.qi), -1); }));
  $$('.btn-qdn', el).forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); moveQueued(Number(b.dataset.qi), 1); }));
  if (window.matchMedia('(min-width: 861px)').matches) {
    $$('.track.q-user', el).forEach((row) => {
      row.draggable = true;
      row.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/plain', row.dataset.qi);
        e.dataTransfer.effectAllowed = 'move';
        row.classList.add('dragging');
      });
      row.addEventListener('dragend', () => row.classList.remove('dragging'));
      row.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; row.classList.add('drag-over'); });
      row.addEventListener('dragleave', () => row.classList.remove('drag-over'));
      row.addEventListener('drop', (e) => {
        e.preventDefault();
        row.classList.remove('drag-over');
        const from = Number(e.dataTransfer.getData('text/plain'));
        const to = Number(row.dataset.qi);
        if (!Number.isFinite(from) || !Number.isFinite(to) || from === to) return;
        if (from <= Player.index || to <= Player.index) return;
        if (!Player.queue[from] || !Player.queue[from]._user || !Player.queue[to] || !Player.queue[to]._user) return;
        const [item] = Player.queue.splice(from, 1);
        Player.queue.splice(to, 0, item);
        renderQueue();
      });
    });
  }
  const clr = $('#q-clear', el);
  if (clr) clr.addEventListener('click', clearUserQueue);
  persistQueue();
}
async function loadRelated(force = false) {
  const el = $('#related-list');
  if (!el) return;
  const song = Player.current;
  if (!song) { el.innerHTML = '<div class="loading-note">Play a song first</div>'; return; }
  if (Player._relatedLoaded && !force) return;
  Player._relatedLoaded = true;
  el.innerHTML = '<div class="loading-note">Loading…</div>';

  const vid = song.videoId;
  const sameSong = () => Player.current && Player.current.videoId === vid;

  for (let i = 0; i < 16 && !Player.relatedBrowseId && sameSong(); i++) {
    await new Promise((r) => setTimeout(r, 300));
    if (!Player._queueFetching && i >= 3 && !Player.relatedBrowseId) break;
  }
  if (!sameSong()) { Player._relatedLoaded = false; return; }

  const renderFail = () => {
    Player._relatedLoaded = false;
    el.innerHTML = `<div class="loading-note">Couldn't load related content<br><br>
      <button class="pill-btn" id="related-retry">${icon('i-repeat')}<span>Try again</span></button></div>`;
    const rb = $('#related-retry', el);
    if (rb) rb.addEventListener('click', () => loadRelated(true));
  };

  const paint = (html) => {
    if (!sameSong()) { Player._relatedLoaded = false; return false; }
    el.innerHTML = html;
    bindItems(el);
    return true;
  };

  if (Player.relatedBrowseId) {
    try {
      const d = await api(`/api/related?browseId=${encodeURIComponent(Player.relatedBrowseId)}`);
      if (d.sections && d.sections.length) {
        paint(relatedSectionsHTML(d.sections));
        return;
      }
    } catch {}
  }
  if (!sameSong()) { Player._relatedLoaded = false; return; }

  try {
    const d = await api(`/api/next?videoId=${encodeURIComponent(vid)}`);
    if (!sameSong()) { Player._relatedLoaded = false; return; }
    if (d.relatedBrowseId) Player.relatedBrowseId = d.relatedBrowseId;
    if (Player.relatedBrowseId) {
      try {
        const rel = await api(`/api/related?browseId=${encodeURIComponent(Player.relatedBrowseId)}`);
        if (rel.sections && rel.sections.length) {
          paint(relatedSectionsHTML(rel.sections));
          return;
        }
      } catch {}
    }
    const items = (d.queue || [])
      .filter((q) => q.videoId && q.videoId !== vid)
      .slice(0, 25)
      .map((q) => ({ type: 'song', videoId: q.videoId, title: q.title, subtitle: q.artist, thumbnail: q.thumbnail, duration: q.duration, artists: q.artists }));
    if (items.length) {
      paint(shelfHTML({ title: 'Similar songs', items, list: true }));
      return;
    }
  } catch {}
  if (sameSong()) renderFail();
}

/* ================= download (via converter service, direct save) ================= */
const activeDownloads = new Set();
function downloadFilename(song) {
  const t = displayTitle(song && song.title) || 'track';
  const a = String((song && song.artist) || '').split(',')[0].trim();
  const raw = (a ? `${a} - ${t}` : t).replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim();
  return `${raw.slice(0, 80) || 'track'}.mp3`;
}
function clickDownload(href, name) {
  const aEl = document.createElement('a');
  aEl.href = href;
  aEl.download = name || '';
  aEl.target = '_blank';
  aEl.rel = 'noopener noreferrer';
  document.body.appendChild(aEl);
  aEl.click();
  aEl.remove();
}
async function downloadSong(song) {
  if (!song || !song.videoId) return;
  if (activeDownloads.has(song.videoId)) { toast('Already downloading this song…'); return; }
  activeDownloads.add(song.videoId);
  toast(`Preparing "${song.title}" (320kbps MP3)…`);
  try {
    const st = await api(`/api/download-start?videoId=${encodeURIComponent(song.videoId)}`);
    if (!st.progressUrl) throw new Error('no progress url');
    let url = null;
    let lastProg = -1;
    for (let i = 0; i < 60; i++) {
      if (i) await new Promise((r) => setTimeout(r, 2500));
      try {
        const p = await api(`/api/download-progress?progressUrl=${encodeURIComponent(st.progressUrl)}`);
        if (p.done && p.url) { url = p.url; break; }
        // loader.to reports progress on a 0–1000 scale (1000 = done).
        const raw = Number(p.progress) || 0;
        const pct = Math.min(99, Math.max(0, Math.round(raw / 10)));
        if (pct !== lastProg) {
          lastProg = pct;
          toast(pct <= 5 && p.text ? String(p.text) : `Converting "${song.title}"… ${pct}%`);
        }
      } catch {}
    }
    if (!url) throw new Error('timeout');
    toast(`Downloading "${song.title}"…`);
    const name = downloadFilename(song);
    try {
      const r = await fetch(url, { mode: 'cors' });
      if (!r.ok) throw new Error('fetch');
      const blob = await r.blob();
      const obj = URL.createObjectURL(blob);
      clickDownload(obj, name);
      setTimeout(() => URL.revokeObjectURL(obj), 8000);
    } catch {
      clickDownload(url, name);
    }
    toast('Download started');
  } catch (e) {
    toast('Download failed — try again later');
  } finally {
    activeDownloads.delete(song.videoId);
  }
}

/* ================= rendering helpers ================= */
function looksLikePlays(s) {
  return /pemutaran|plays|ditonton|views|x ditonton/i.test(String(s || ''));
}
function normalizeDuration(s) {
  const t = String(s || '').trim();
  if (/^\d{1,2}(\.\d{2}){1,2}$/.test(t)) return t.replace(/\./g, ':');
  return t;
}
function displayTitle(t) {
  const raw = String(t || '').trim();
  if (!raw) return '';
  const cleaned = raw
    .replace(/\s*[\(\[]\s*official\s*(hd\s*)?(4k\s*)?(music\s*)?(lyric(s)?\s*)?(audio|video|visualizer|mv)[^\)\]]*[\)\]]/gi, '')
    .replace(/\s*[\(\[]\s*(official\s*)?(hd\s*)?(music\s*)?(lyric(s)?\s*)?(audio|video|visualizer|mv)[^\)\]]*[\)\]]/gi, '')
    .replace(/\s*[\(\[]\s*(official\s*)?(4k|hd|hq|8d(?:\s*audio)?|1080p|720p)\s*[\)\]]/gi, '')
    .replace(/\s*-\s*(official|lyric(s)?|audio|video|visualizer|topic).*$/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return cleaned || raw;
}
function normalizeSong(s) {
  if (!s) return s;
  return { ...s, title: displayTitle(s.title) };
}
function songFromItem(it) {
  const artists = it.artists || [];
  const artistBrowseId = it.artistBrowseId || (artists[0] && artists[0].browseId) || '';
  const fromArr = artists.map((a) => a.name).filter(Boolean).join(', ');
  const artist = fromArr || it.artist || (looksLikePlays(it.subtitle) ? '' : (it.subtitle || ''));
  return normalizeSong({
    videoId: it.videoId, title: it.title,
    artist,
    artistBrowseId,
    thumbnail: it.thumbnail, duration: normalizeDuration(it.duration), playlistId: it.playlistId,
  });
}
const COVER_PH = 'data:image/svg+xml,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80"><rect width="80" height="80" fill="#242424"/><path fill="#6a6a6a" d="M32 24v26.6a7 7 0 1 0 4 6.4V32h14V24H32z"/></svg>'
);
function safeCover(src) {
  const u = String(src || '').trim();
  if (!u || u === 'undefined' || u === 'null' || u === 'about:blank') return '';
  return u;
}
function coverHTML(src, kind = '') {
  const u = safeCover(src);
  if (!u) return `<div class="art-ph${kind ? ' art-ph-' + kind : ''}">${icon('i-note')}</div>`;
  return `<img loading="lazy" src="${esc(u)}" alt="">`;
}
function cardHTML(it) {
  const cls = it.type === 'artist' ? 'card artist' : 'card';
  return `<div class="${cls}" data-item='${esc(JSON.stringify(it))}'>
    <div class="art">${coverHTML(it.thumbnail)}<div class="play-ov">${icon('i-play')}</div></div>
    <div class="t">${esc(it.title)}</div><div class="s">${esc(it.subtitle || '')}</div>
  </div>`;
}
function trackRowHTML(it, playing = false, extraBtn = '') {
  const qi = it.qi != null ? ` data-qi="${it.qi}"` : '';
  const pl = it.plId ? ` data-pl="${esc(it.plId)}" data-pi="${it.plIndex}"` : '';
  const qn = it.qn ? `<span class="q-num">${it.qn}</span>` : '';
  const tn = it.tn != null ? `<span class="t-num">${it.tn}</span>` : '';
  const cls = `track${playing ? ' playing' : ''}${it.qRadio ? ' q-radio' : ''}${it.qn ? ' q-user' : ''}${it.plId ? ' pl-track' : ''}`;
  return `<div class="${cls}"${qi}${pl} data-item='${esc(JSON.stringify(it))}'>
    <span class="eq" aria-hidden="true"><i></i><i></i><i></i></span>
    ${tn}${qn}
    ${coverHTML(it.thumbnail, 'track')}
    <div class="tmeta"><div class="tt">${esc(displayTitle(it.title))}</div><div class="ts">${esc(it.artist || it.subtitle || '')}</div></div>
    ${it.duration ? `<span class="tdur">${esc(it.duration)}</span>` : ''}
    <button class="tbtn btn-fav" title="Favorite">${icon(Library.isFav(it.videoId) ? 'i-heart-f' : 'i-heart-o')}</button>
    <button class="tbtn btn-queue" title="Add to queue">${icon('i-queue')}</button>
    <button class="tbtn btn-addpl" title="Add to playlist">${icon('i-plus')}</button>
    <button class="tbtn btn-dl" title="Download">${icon('i-download')}</button>
    <button class="tbtn btn-more" title="More">${icon('i-more')}</button>
    ${extraBtn}
  </div>`;
}
function trackHeadHTML() {
  return `<div class="track-head" aria-hidden="true"><span class="th-n">#</span><span class="th-t">Title</span><span class="th-d">Time</span></div>`;
}
function quickCardHTML(it) {
  return `<button class="quick-card" data-item='${esc(JSON.stringify(it))}'>
    ${coverHTML(it.thumbnail, 'quick')}
    <span class="qc-t">${esc(it.title)}</span>
    <span class="play-ov">${icon('i-play')}</span>
  </button>`;
}
function carouselHTML(inner) {
  return `<div class="carousel-wrap">
    <button type="button" class="car-btn car-prev" aria-label="Scroll left">${icon('i-back')}</button>
    <div class="carousel">${inner}</div>
    <button type="button" class="car-btn car-next" aria-label="Scroll right">${icon('i-fwd')}</button>
  </div>`;
}
function emptyHTML(title, sub, opts = {}) {
  const ic = opts.ic || 'i-note';
  const cta = opts.label
    ? `<button type="button" class="pill-btn primary empty-cta"${opts.go ? ` data-go="${esc(opts.go)}"` : ''}${opts.act ? ` data-act="${esc(opts.act)}"` : ''}>${opts.label}</button>`
    : '';
  return `<div class="empty-block">
    <div class="empty-ic">${icon(ic)}</div>
    <div class="empty-title">${title}</div>
    <div class="empty-s">${sub}</div>
    ${cta}
  </div>`;
}
function likedCardHTML() {
  const n = Library.favorites.length;
  return `<div class="card liked-card" data-nav="#/library/favorites">
    <div class="art liked-cover">${icon('i-heart-f', 'ic liked-heart')}<div class="play-ov">${icon('i-play')}</div></div>
    <div class="t">Liked Songs</div>
    <div class="s">${n} song${n === 1 ? '' : 's'}</div>
  </div>`;
}
function shelfHTML(sec) {
  if (sec.list) {
    return `<div class="shelf"><div class="shelf-title">${esc(sec.title)}</div>
      <div class="track-list">${sec.items.map((i) => (i.videoId ? trackRowHTML(i) : cardHTML(i))).join('')}</div></div>`;
  }
  return `<div class="shelf"><div class="shelf-title">${esc(sec.title)}</div>
    ${carouselHTML(sec.items.map(cardHTML).join(''))}</div>`;
}
function bindCarousels(root) {
  $$('.carousel-wrap', root).forEach((wrap) => {
    const sc = $('.carousel', wrap);
    const prev = $('.car-prev', wrap);
    const next = $('.car-next', wrap);
    if (!sc || !prev || !next) return;
    const step = () => Math.max(200, Math.floor(sc.clientWidth * 0.82));
    const sync = () => {
      const max = sc.scrollWidth - sc.clientWidth - 6;
      prev.classList.toggle('off', sc.scrollLeft <= 6);
      next.classList.toggle('off', sc.scrollLeft >= max);
    };
    prev.addEventListener('click', (e) => { e.stopPropagation(); sc.scrollBy({ left: -step(), behavior: 'smooth' }); });
    next.addEventListener('click', (e) => { e.stopPropagation(); sc.scrollBy({ left: step(), behavior: 'smooth' }); });
    sc.addEventListener('scroll', sync, { passive: true });
    requestAnimationFrame(sync);
  });
}
function bindEmptyCtas(root) {
  $$('.empty-cta', root).forEach((b) => {
    b.addEventListener('click', () => {
      if (b.dataset.act === 'newpl') openCreatePlaylist();
      else if (b.dataset.act === 'reload') location.reload();
      else if (b.dataset.go) go(b.dataset.go);
    });
  });
}
function bindItems(root) {
  $$('.card, .quick-card, .sr-top', root).forEach((el) => {
    el.addEventListener('click', () => {
      try { openItem(JSON.parse(el.dataset.item)); } catch {}
    });
  });
  $$('.track', root).forEach((el) => {
    let it;
    try { it = JSON.parse(el.dataset.item); } catch { return; }
    el.addEventListener('click', (e) => {
      if (e.target.closest('.tbtn')) return;
      if (it.browseId && (it.type === 'album' || it.type === 'playlist' || it.type === 'artist')) openItem(it);
      else if (it.videoId) openSongNowPlaying(songFromItem(it));
      else openItem(it);
    });
    const favBtn = $('.btn-fav', el);
    if (favBtn) favBtn.addEventListener('click', (e) => { e.stopPropagation(); Library.toggleFav(songFromItem(it)); favBtn.innerHTML = icon(Library.isFav(it.videoId) ? 'i-heart-f' : 'i-heart-o'); });
    const addBtn = $('.btn-addpl', el);
    if (addBtn) addBtn.addEventListener('click', (e) => { e.stopPropagation(); openAddToPlaylist(songFromItem(it)); });
    const qBtn = $('.btn-queue', el);
    if (qBtn) qBtn.addEventListener('click', (e) => { e.stopPropagation(); queueSong(songFromItem(it)); });
    const dlBtn = $('.btn-dl', el);
    if (dlBtn) dlBtn.addEventListener('click', (e) => { e.stopPropagation(); downloadSong(songFromItem(it)); });
    const moreBtn = $('.btn-more', el);
    if (moreBtn) moreBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openSongMenu(songFromItem(it), {
        plId: it.plId || el.dataset.pl,
        plIndex: it.plIndex != null ? it.plIndex : (el.dataset.pi !== undefined && el.dataset.pi !== '' ? Number(el.dataset.pi) : undefined),
      });
    });
  });
  bindCarousels(root);
  bindEmptyCtas(root);
}
function openItem(it) {
  if (!it) return;
  const kind = it.browseType || it.type;
  const isPage = it.browseId && (kind === 'album' || kind === 'playlist' || kind === 'artist' || kind === 'browse');
  if (isPage) {
    closeNowPlaying();
    if (kind === 'artist') return go(`#/artist/${it.browseId}`);
    if (kind === 'album') return go(`#/album/${it.browseId}`);
    return go(`#/playlist/${it.browseId}${it.params ? '?params=' + encodeURIComponent(it.params) : ''}`);
  }
  if (it.watchPlaylist && it.playlistId) {
    closeNowPlaying();
    return go(`#/playlist/${String(it.playlistId).startsWith('VL') ? it.playlistId : 'VL' + it.playlistId}`);
  }
  if (it.videoId) return openSongNowPlaying(songFromItem(it));
  if (it.playlistId) {
    closeNowPlaying();
    return go(`#/playlist/${String(it.playlistId).startsWith('VL') ? it.playlistId : 'VL' + it.playlistId}`);
  }
}
function songDurLabel(s) {
  return (s && s.duration) ? String(s.duration) : '0:00';
}
function resetNpSeek(s) {
  const dur = songDurLabel(s);
  const range = $('#np-range'); if (range) range.value = 0;
  const nc = $('#np-cur'); if (nc) nc.textContent = '0:00';
  const nd = $('#np-dur'); if (nd) nd.textContent = dur;
  const lp = $('#np-lyric-preview'); if (lp) lp.textContent = '';
}
function previewSong(song) {
  if (!song || !song.videoId) return;
  Player.pending = song;
  renderNowPlaying();
  updateLikeButtons();
  renderPlayButtons();
  resetNpSeek(song);
  // keep Related for the song that's actually playing
}
function openSongNowPlaying(song) {
  if (!song || !song.videoId) return;
  const same = Player.current && Player.current.videoId === song.videoId;
  if (!Player.current) {
    playSong(song);
  } else if (!same) {
    previewSong(song);
  } else {
    Player.pending = null;
    renderNowPlaying();
    updateLikeButtons();
    renderPlayButtons();
  }
  openNowPlaying();
  switchNPTab('player');
}

/* ================= router / views ================= */
const NAV = [
  { id: 'home', label: 'Home', icon: 'i-home-o', iconActive: 'i-home', hash: '#/home' },
  { id: 'search', label: 'Search', icon: 'i-search', iconActive: 'i-search', hash: '#/search' },
  { id: 'charts', label: 'Charts', icon: 'i-chart', iconActive: 'i-chart', hash: '#/charts' },
  { id: 'library', label: 'Your Library', icon: 'i-library', iconActive: 'i-library', hash: '#/library' },
];
function renderNav() {
  const html = NAV.map((n) => `<button class="nav-item" data-id="${n.id}" data-ic="${n.icon}" data-ica="${n.iconActive}" onclick="location.hash='${n.hash}'"><svg class="ic"><use href="#${n.icon}"/></svg><span>${n.label}</span></button>`).join('');
  // desktop sidebar: only Home + Search (Spotify layout); library lives in its own box
  $('#nav-desktop').innerHTML = NAV.filter((n) => ['home', 'search', 'charts'].includes(n.id))
    .map((n) => `<button class="nav-item" data-id="${n.id}" data-ic="${n.icon}" data-ica="${n.iconActive}" onclick="location.hash='${n.hash}'"><svg class="ic"><use href="#${n.icon}"/></svg><span>${n.label}</span></button>`).join('');
  $('#nav-mobile').innerHTML = html;
  renderSidebarLibrary();
}
function setActiveNav(id) {
  $$('.nav-item').forEach((el) => {
    const active = el.dataset.id === id;
    el.classList.toggle('active', active);
    const use = el.querySelector('use');
    if (use) use.setAttribute('href', '#' + (active ? el.dataset.ica : el.dataset.ic));
  });
}

/* ---- Your Library sidebar (Spotify left rail) ---- */
const LIB_FILTERS = [
  ['all', 'All'],
  ['playlist', 'Playlists'],
  ['artist', 'Artists'],
  ['album', 'Albums'],
];
function libFilter() { return store.get('lib_filter', 'all'); }
function libSort() { return store.get('lib_sort', 'recents'); } // 'recents' | 'az'
/* Build a unified, filterable, sortable list of everything in the library rail. */
function collectLibraryRows() {
  const rows = [];
  const favs = Library.favorites;
  if (favs.length) {
    rows.push({
      kind: 'playlist', name: 'Liked Songs', _order: Infinity, // Liked Songs pinned to top on Recents
      html: `<button class="lib-row" data-nav="#/library/favorites">
        <span class="lib-ph liked-ph">${icon('i-heart-f')}</span>
        <span class="lr-meta"><span class="lr-t">Liked Songs</span><br><span class="lr-s">Playlist · ${favs.length} songs</span></span>
      </button>`,
    });
  }
  Library.playlists.forEach((p, i) => rows.push({
    kind: 'playlist', name: p.name, _order: Library.playlists.length - i,
    html: `<button class="lib-row" data-nav="#/localpl/${p.id}">
      ${coverHTML(p.tracks[0] && p.tracks[0].thumbnail, 'lib')}
      <span class="lr-meta"><span class="lr-t">${esc(p.name)}</span><br><span class="lr-s">Playlist · ${p.tracks.length} songs</span></span>
    </button>`,
  }));
  Library.saved.forEach((it, i) => rows.push({
    kind: it.type === 'artist' ? 'artist' : it.type === 'album' ? 'album' : 'playlist',
    name: it.title || '', _order: Library.saved.length - i,
    html: `<button class="lib-row ${it.type === 'artist' ? 'round' : ''}" data-item='${esc(JSON.stringify(it))}'>
      ${coverHTML(it.thumbnail, 'lib')}
      <span class="lr-meta"><span class="lr-t">${esc(it.title)}</span><br><span class="lr-s">${it.type === 'artist' ? 'Artist' : it.type === 'album' ? 'Album' : 'Playlist'}</span></span>
    </button>`,
  }));
  return rows;
}
function renderSidebarLibrary() {
  const el = $('#lib-list');
  if (!el) return;
  const filter = libFilter();
  const sort = libSort();
  let rows = collectLibraryRows();
  const total = rows.length;
  if (filter !== 'all') rows = rows.filter((r) => r.kind === filter);
  if (sort === 'az') rows.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  else rows.sort((a, b) => b._order - a._order); // recents: newest first, Liked Songs pinned

  // controls: filter chips + sort toggle (only when there is something to show)
  let controls = '';
  if (total) {
    controls = `<div class="lib-controls">
      <div class="lib-chips">${LIB_FILTERS.map(([id, label]) =>
        `<button type="button" class="lib-chip ${filter === id ? 'active' : ''}" data-lf="${id}">${label}</button>`).join('')}</div>
      <button type="button" class="lib-sort" id="lib-sort" title="Sort">${sort === 'az' ? 'A–Z' : 'Recents'}</button>
    </div>`;
  }

  let listHtml = rows.map((r) => r.html).join('');
  if (!total) {
    listHtml = `<div class="lib-empty"><b>Your library is empty</b><br>Like songs, save albums & artists, or open Library to create a playlist</div>`;
  } else if (!rows.length) {
    const label = (LIB_FILTERS.find(([id]) => id === filter) || [, 'items'])[1].toLowerCase();
    listHtml = `<div class="lib-empty">No ${label} in your library yet.</div>`;
  }
  el.innerHTML = controls + `<div class="lib-scroll">${listHtml}</div>`;

  $$('[data-lf]', el).forEach((b) => b.addEventListener('click', () => {
    store.set('lib_filter', b.dataset.lf === libFilter() && b.dataset.lf !== 'all' ? 'all' : b.dataset.lf);
    renderSidebarLibrary();
  }));
  const sortBtn = $('#lib-sort', el);
  if (sortBtn) sortBtn.addEventListener('click', () => {
    store.set('lib_sort', libSort() === 'az' ? 'recents' : 'az');
    renderSidebarLibrary();
  });
  $$('[data-nav]', el).forEach((b) => b.addEventListener('click', () => go(b.dataset.nav)));
  $$('[data-item]', el).forEach((b) => b.addEventListener('click', () => {
    try { openItem(JSON.parse(b.dataset.item)); } catch {}
  }));
}
const go = (hash) => { location.hash = hash; };

async function route() {
  const hash = location.hash || '#/home';
  const [path, qs] = hash.slice(2).split('?');
  const parts = path.split('/');
  const view = $('#view');
  const params = new URLSearchParams(qs || '');
  window.scrollTo(0, 0);
  $('#main').scrollTop = 0;
  view.classList.remove('view-enter');
  void view.offsetWidth;
  applyTint(parts[0] || 'home');

  try {
    if (parts[0] === '' || parts[0] === 'home') { setActiveNav('home'); await viewHome(view); }
    else if (parts[0] === 'search') { setActiveNav('search'); await viewSearch(view, decodeURIComponent(parts[1] || ''), params.get('filter')); }
    else if (parts[0] === 'charts') { setActiveNav('charts'); await viewCharts(view); }
    else if (parts[0] === 'stats') { setActiveNav('library'); viewStats(view); }
    else if (parts[0] === 'moods') { setActiveNav('moods'); await viewMoods(view); }
    else if (parts[0] === 'library') { setActiveNav('library'); viewLibrary(view, parts[1] || 'playlists'); }
    else if (parts[0] === 'album' || parts[0] === 'playlist' || parts[0] === 'artist' || parts[0] === 'browse') {
      setActiveNav('');
      await viewBrowse(view, parts[1], parts[0], params.get('params'));
    }
    else if (parts[0] === 'localpl') { setActiveNav('library'); viewLocalPlaylist(view, parts[1]); }
    else if (parts[0] === 'song' && parts[1]) { setActiveNav('home'); await viewHome(view); openSharedSong(parts[1]); }
    else {
      view.innerHTML = emptyHTML('Page not found', 'That link does not exist or the page was removed.', { label: 'Go home', go: '#/home', ic: 'i-search' });
      bindEmptyCtas(view);
    }
  } catch (e) {
    view.innerHTML = emptyHTML('Failed to load', esc(e.message || 'Something went wrong.'), { label: 'Retry', act: 'reload', ic: 'i-note' });
    bindEmptyCtas(view);
  }
  view.classList.add('view-enter');
}
window.addEventListener('hashchange', route);

const skeletonHTML = `<div class="page-title">&nbsp;</div>` + Array(3).fill(`
  <div class="shelf"><div class="skeleton" style="width:180px;height:22px;margin-bottom:12px"></div>
  <div class="carousel">${Array(6).fill('<div><div class="skeleton" style="width:160px;height:160px"></div></div>').join('')}</div></div>`).join('');

/* ---- Home ---- */
async function viewHome(view) {
  view.innerHTML = skeletonHTML;
  const now = new Date();
  const h = now.getHours();
  const greet = h < 11 ? 'Good morning' : h < 16 ? 'Good afternoon' : 'Good evening';
  applyTint(greet);
  const d = await api('/api/home');
  const hist = Library.history.slice(0, 16);
  const favs = Library.favorites.slice(0, 12);
  const pls = Library.playlists.filter((p) => p.tracks && p.tracks.length);
  const saved = Library.saved.slice(0, 12);
  const dateLine = now.toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long' });
  let html = `<div class="hello-row"><div><div class="greeting">${esc(dateLine)}</div><h1 class="page-title">${greet}</h1></div></div>`;
  if (hist.length) {
    html += `<div class="shelf-title">Recently played</div><div class="quick-grid">${hist.slice(0, 8).map((s) => quickCardHTML({ ...s, type: 'song', subtitle: s.artist })).join('')}</div>`;
  }
  html += `<div id="mix-slot"></div>`;
  if (hist.length > 8) {
    html += `<div class="shelf"><div class="shelf-title">Jump back in</div>${carouselHTML(hist
      .slice(8).map((s) => cardHTML({ ...s, type: 'song', subtitle: s.artist })).join(''))}</div>`;
  }
  if (favs.length) {
    html += `<div class="shelf"><div class="shelf-title">Liked songs</div>
      ${carouselHTML(favs.map((s) => cardHTML({ ...s, type: 'song', subtitle: s.artist })).join(''))}</div>`;
  }
  if (pls.length) {
    html += `<div class="shelf"><div class="shelf-title">Your playlists</div>
      ${carouselHTML(pls.map((p) => `<div class="card" data-pl="${esc(p.id)}">
        <div class="art">${coverHTML(p.tracks[0] && p.tracks[0].thumbnail)}<div class="play-ov">${icon('i-play')}</div></div>
        <div class="t">${esc(p.name)}</div><div class="s">${p.tracks.length} songs</div>
      </div>`).join(''))}</div>`;
  }
  if (saved.length) {
    html += `<div class="shelf"><div class="shelf-title">Saved</div>
      ${carouselHTML(saved.map(cardHTML).join(''))}</div>`;
  }
  html += d.sections.map(shelfHTML).join('');
  view.innerHTML = html;
  bindItems(view);
  $$('[data-pl]', view).forEach((el) => el.addEventListener('click', () => go(`#/localpl/${el.dataset.pl}`)));
  loadMixForYou();
}

/* "Mix for you" — personalized-feel shelf built from your listening history (no account needed) */
async function loadMixForYou() {
  const hist = Library.history;
  const seeds = [...Library.favorites, ...hist].filter((s) => s.videoId);
  if (!seeds.length) return;
  const slot = $('#mix-slot');
  if (!slot) return;
  try {
    const seed = seeds[Math.floor(Math.random() * Math.min(5, seeds.length))];
    const d = await api(`/api/next?videoId=${encodeURIComponent(seed.videoId)}`);
    const items = (d.queue || []).slice(1, 13).map((q) => ({
      type: 'song', videoId: q.videoId, title: q.title, subtitle: q.artist, thumbnail: q.thumbnail,
    }));
    if (!items.length) return;
    slot.innerHTML = shelfHTML({ title: `Mix for you · based on “${seed.title}”`, items });
    bindItems(slot);
  } catch {}
}

/* ---- Search ---- */
const SEARCH_TYPE_LABEL = { song: 'Songs', video: 'Videos', album: 'Albums', artist: 'Artists', playlist: 'Playlists', browse: 'More' };
function pushRecentSearch(q) {
  q = String(q || '').trim();
  if (!q) return;
  const list = [q, ...store.get('srec', []).filter((x) => String(x).toLowerCase() !== q.toLowerCase())].slice(0, 8);
  store.set('srec', list);
}
function removeRecentSearch(q) {
  store.set('srec', store.get('srec', []).filter((x) => x !== q));
}
function isSearchCard(it) {
  const t = it.type || it.browseType;
  return t === 'album' || t === 'playlist' || t === 'artist' || t === 'browse' || (!!it.browseId && !it.videoId);
}
function moodCardHTML(c, i) {
  const raw = String(c.color || '').trim();
  const color = /^#?[0-9a-fA-F]{3,8}$/.test(raw) ? (raw[0] === '#' ? raw : '#' + raw) : MOOD_COLORS[i % MOOD_COLORS.length];
  return `<button type="button" class="mood-card" style="--mc:${esc(color)}" data-b="${esc(c.browseId)}" data-p="${esc(c.params || '')}">${esc(c.title)}</button>`;
}
function bindMoods(root) {
  $$('.mood-card', root).forEach((el) => el.addEventListener('click', () => {
    go(`#/browse/${el.dataset.b}${el.dataset.p ? '?params=' + encodeURIComponent(el.dataset.p) : ''}`);
  }));
}
function topResultHTML(it) {
  const kind = it.type === 'artist' ? 'artist' : '';
  const cta = it.videoId ? 'Play' : 'Open';
  const ic = it.videoId ? 'i-play' : (it.type === 'artist' ? 'i-search' : 'i-fwd');
  return `<button type="button" class="sr-top ${kind}" data-item='${esc(JSON.stringify(it))}'>
    ${coverHTML(it.thumbnail, 'sr')}
    <div class="sr-meta">
      <div class="sr-kicker">Top result</div>
      <div class="sr-title">${esc(displayTitle(it.title) || it.title)}</div>
      <div class="sr-sub">${esc(it.subtitle || it.artist || '')}</div>
      <span class="pill-btn primary">${icon(ic)}<span>${cta}</span></span>
    </div>
  </button>`;
}
function searchResultsHTML(sections) {
  if (!sections || !sections.length) {
    return emptyHTML('No results', 'Try a different spelling or another artist, song, or playlist.', { ic: 'i-search' });
  }
  let html = '';
  const leftover = [];
  for (const sec of sections) {
    if (/^top result$/i.test(sec.title || '') && sec.items && sec.items[0]) {
      html += topResultHTML(sec.items[0]);
      continue;
    }
    leftover.push(...(sec.items || []));
  }
  if (sections.length === 1 && leftover.length && !/^top result$/i.test(sections[0].title || '')) {
    const allCard = leftover.every(isSearchCard);
    const allRow = leftover.every((i) => !isSearchCard(i));
    if (allCard || allRow) {
      html += allRow
        ? `<div class="shelf"><div class="shelf-title">${esc(sections[0].title || 'Songs')}</div><div class="track-list">${leftover.map((i) => trackRowHTML(i)).join('')}</div></div>`
        : `<div class="shelf"><div class="shelf-title">${esc(sections[0].title || 'Results')}</div>${carouselHTML(leftover.map(cardHTML).join(''))}</div>`;
      return html;
    }
  }
  const groups = { song: [], video: [], album: [], artist: [], playlist: [], browse: [] };
  leftover.forEach((it) => {
    let t = it.type || (it.videoId ? 'song' : 'browse');
    if (!groups[t]) t = it.videoId ? 'song' : 'browse';
    groups[t].push(it);
  });
  ['song', 'video', 'album', 'artist', 'playlist', 'browse'].forEach((t) => {
    const items = groups[t];
    if (!items.length) return;
    const title = SEARCH_TYPE_LABEL[t];
    html += (t === 'song' || t === 'video')
      ? `<div class="shelf"><div class="shelf-title">${title}</div><div class="track-list">${items.map((i) => trackRowHTML(i)).join('')}</div></div>`
      : `<div class="shelf"><div class="shelf-title">${title}</div>${carouselHTML(items.map(cardHTML).join(''))}</div>`;
  });
  return html || emptyHTML('No results', 'Try a different spelling or another artist, song, or playlist.', { ic: 'i-search' });
}
function relatedSectionsHTML(sections) {
  return (sections || []).map((sec) => {
    const items = sec.items || [];
    if (!items.length) return '';
    const allSongs = items.every((i) => i.videoId && !isSearchCard(i));
    if (allSongs) {
      return `<div class="shelf"><div class="shelf-title">${esc(sec.title || 'Songs')}</div>
        <div class="track-list">${items.slice(0, 16).map((i) => trackRowHTML(i)).join('')}</div></div>`;
    }
    return `<div class="shelf"><div class="shelf-title">${esc(sec.title || 'More')}</div>${carouselHTML(items.map(cardHTML).join(''))}</div>`;
  }).join('');
}
function recentSearchHTML() {
  const rec = store.get('srec', []).filter(Boolean).slice(0, 8);
  if (!rec.length) return '';
  return `<div class="shelf-title recent-head"><span>Recent searches</span>
    <button type="button" class="q-clear" id="srec-clear">Clear</button></div>
    <div class="recent-row">${rec.map((qq) => `<span class="recent-chip">
      <button type="button" class="recent-go" data-q="${esc(qq)}">${icon('i-clock')}<span>${esc(qq)}</span></button>
      <button type="button" class="recent-x" data-rm="${esc(qq)}" title="Remove">${icon('i-x')}</button>
    </span>`).join('')}</div>`;
}
function bindSearchChrome(view, q, filter) {
  const input = $('#search-input');
  const bar = $('.search-bar', view);
  const clearBtn = $('#search-clear');
  const syncClear = () => bar && bar.classList.toggle('has-q', !!(input && input.value.trim()));
  syncClear();
  if (clearBtn) clearBtn.addEventListener('click', () => go('#/search'));
  if (!q && input && window.innerWidth > 860) {
    input.focus();
    input.setSelectionRange((input.value || '').length, (input.value || '').length);
  }
  let sugT;
  if (input) {
    input.addEventListener('input', () => {
      syncClear();
      clearTimeout(sugT);
      const v = input.value.trim();
      if (!v) { $('#suggest').innerHTML = ''; return; }
      sugT = setTimeout(async () => {
        try {
          const d = await api(`/api/suggest?q=${encodeURIComponent(v)}`);
          $('#suggest').innerHTML = (d.suggestions || []).slice(0, 6).map((s) => `<button type="button">${icon('i-search')}<span>${esc(s)}</span></button>`).join('');
          $$('#suggest button').forEach((b) => b.addEventListener('click', () => {
            const term = b.querySelector('span') ? b.querySelector('span').textContent : b.textContent;
            pushRecentSearch(term);
            go(`#/search/${encodeURIComponent(term)}`);
          }));
        } catch {}
      }, 220);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { $('#suggest').innerHTML = ''; input.blur(); return; }
      if (e.key === 'Enter' && input.value.trim()) {
        pushRecentSearch(input.value.trim());
        go(`#/search/${encodeURIComponent(input.value.trim())}${filter && filter !== 'all' ? '?filter=' + filter : ''}`);
      }
    });
  }
  $$('.search-chips .chip', view).forEach((c) => c.addEventListener('click', () => {
    const f = c.dataset.f;
    const term = (input && input.value.trim()) || q;
    if (!term) return;
    go(`#/search/${encodeURIComponent(term)}${f !== 'all' ? '?filter=' + f : ''}`);
  }));
  $$('.recent-go', view).forEach((b) => b.addEventListener('click', () => go(`#/search/${encodeURIComponent(b.dataset.q)}`)));
  $$('.recent-x', view).forEach((b) => b.addEventListener('click', (e) => {
    e.stopPropagation();
    removeRecentSearch(b.dataset.rm);
    const chip = b.closest('.recent-chip');
    if (chip) chip.remove();
    if (!$('.recent-chip', view)) {
      const head = $('.recent-head', view);
      const row = $('.recent-row', view);
      if (head) head.remove();
      if (row) row.remove();
    }
  }));
  const clr = $('#srec-clear');
  if (clr) clr.addEventListener('click', () => { store.set('srec', []); viewSearch(view, '', filter); });
}
async function viewSearch(view, q = '', filter = null) {
  const filters = ['all', 'songs', 'videos', 'albums', 'artists', 'playlists'];
  const hist = !q ? Library.history.slice(0, 6) : [];
  view.innerHTML = `
    ${q ? '' : '<div class="page-title">Search</div>'}
    <div class="search-bar${q ? ' has-q' : ''}">${icon('i-search', 'ic search-ic')}<input id="search-input" placeholder="What do you want to play?" value="${esc(q)}" autocomplete="off" spellcheck="false"><button type="button" class="search-clear" id="search-clear" title="Clear">${icon('i-x')}</button></div>
    <div class="suggest" id="suggest"></div>
    ${q ? `<div class="search-chips">${filters.map((f) => `<button type="button" class="chip ${((filter || 'all') === f) ? 'active' : ''}" data-f="${f}">${f[0].toUpperCase() + f.slice(1)}</button>`).join('')}</div>` : recentSearchHTML()}
    <div id="search-results">${q
      ? '<div class="loading-note">Searching…</div>'
      : `${hist.length ? `<div class="shelf"><div class="shelf-title">Recently played</div><div class="track-list">${hist.map((s) => trackRowHTML({ ...s, subtitle: s.artist })).join('')}</div></div>` : ''}<div id="browse-all"><div class="shelf-title">Browse all</div><div class="mood-grid" id="browse-grid"><div class="loading-note">Loading…</div></div></div>`}</div>`;
  bindSearchChrome(view, q, filter);
  if (!q) bindItems($('#search-results'));
  if (!q) {
    try {
      const d = await api('/api/moods');
      const grid = $('#browse-grid');
      if (grid) {
        grid.innerHTML = (d.categories || []).map(moodCardHTML).join('');
        bindMoods(grid);
      }
    } catch {
      const grid = $('#browse-grid');
      if (grid) grid.innerHTML = emptyHTML('Could not load moods', 'Check your connection and try again.', { label: 'Retry', go: '#/search', ic: 'i-search' });
    }
    return;
  }
  try {
    const d = await api(`/api/search?q=${encodeURIComponent(q)}${filter && filter !== 'all' ? '&filter=' + filter : ''}`);
    pushRecentSearch(q);
    $('#suggest').innerHTML = '';
    const res = $('#search-results');
    res.innerHTML = searchResultsHTML(d.sections || []);
    bindItems(res);
  } catch (e) {
    const res = $('#search-results');
    if (res) res.innerHTML = emptyHTML('Search failed', esc(e.message || 'Try again in a moment.'), { label: 'Retry', go: `#/search/${encodeURIComponent(q)}`, ic: 'i-search' });
  }
}

/* ---- Charts ---- */
async function viewCharts(view) {
  view.innerHTML = skeletonHTML;
  const d = await api('/api/charts');
  const dateLine = new Date().toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long' });
  const secs = d.sections || [];
  let body = '';
  secs.forEach((sec, i) => {
    const items = sec.items || [];
    if (i === 0 && items.length && items.length <= 6 && items.every(isSearchCard)) {
      body += `<div class="shelf"><div class="shelf-title">${esc(sec.title)}</div><div class="chart-grid">${items.map(cardHTML).join('')}</div></div>`;
    } else {
      body += shelfHTML(sec);
    }
  });
  view.innerHTML = `<div class="hello-row"><div><div class="greeting">${esc(dateLine)}</div><h1 class="page-title">Charts</h1></div></div>`
    + (body || emptyHTML('No charts right now', 'Try again in a moment.', { label: 'Retry', go: '#/charts', ic: 'i-chart' }));
  bindItems(view);
}

/* Spotify browse-tile palette (fallback when YT colors are missing) */
const MOOD_COLORS = ['#1db954','#e13300','#7358ff','#e8115b','#148a08','#dc148c','#bc5900','#8d67ab','#e91429','#1e3264','#537aa1','#af2896','#477d95','#ba5d07','#0d73ec','#8c1932'];

/* ---- Moods ---- */
async function viewMoods(view) {
  view.innerHTML = `<div class="page-title">Moods & genres</div><div class="loading-note">Loading…</div>`;
  const d = await api('/api/moods');
  view.innerHTML = `<div class="page-title">Moods & genres</div>
    <div class="mood-grid">${d.categories.map(moodCardHTML).join('')}</div>`;
  bindMoods(view);
}

/* ---- Stats (local scrobble) ---- */
function viewStats(view) {
  const st = Library.stats;
  const rows = Object.entries(st).map(([videoId, v]) => ({ videoId, ...v }));
  const totalPlays = rows.reduce((a, r) => a + r.plays, 0);
  const totalMin = Math.round(rows.reduce((a, r) => a + r.secs, 0) / 60);
  // top artists
  const byArtist = {};
  rows.forEach((r) => {
    const a = (r.artist || 'Unknown').split(',')[0].trim() || 'Unknown';
    byArtist[a] = (byArtist[a] || 0) + r.plays;
  });
  const topArtists = Object.entries(byArtist).sort((x, y) => y[1] - x[1]).slice(0, 10);
  const topSongs = [...rows].sort((x, y) => y.plays - x.plays).slice(0, 20);
  const maxA = topArtists[0] ? topArtists[0][1] : 1;
  view.innerHTML = `<div class="hello-row"><div>
      <div class="greeting">This device only</div>
      <h1 class="page-title">Listening stats</h1>
    </div></div>
    <div class="stats-cards">
      <div class="stat-card"><div class="stat-num">${totalPlays}</div><div class="stat-lbl">Total plays</div></div>
      <div class="stat-card"><div class="stat-num">${totalMin}</div><div class="stat-lbl">Minutes listened</div></div>
      <div class="stat-card"><div class="stat-num">${rows.length}</div><div class="stat-lbl">Unique songs</div></div>
      <div class="stat-card"><div class="stat-num">${Object.keys(byArtist).length}</div><div class="stat-lbl">Artists</div></div>
    </div>
    ${topArtists.length ? `<div class="shelf"><div class="shelf-title">Top artists</div>
      ${topArtists.map(([a, n], i) => `<div class="stat-bar-row"><span class="sb-rank">${i + 1}</span><span class="sb-name">${esc(a)}</span><div class="sb-bar"><div style="width:${(n / maxA) * 100}%"></div></div><span class="sb-n">${n}</span></div>`).join('')}</div>` : ''}
    ${topSongs.length ? `<div class="shelf"><div class="shelf-title">Most played</div>${trackHeadHTML()}<div class="track-list">
      ${topSongs.map((r, i) => trackRowHTML({ videoId: r.videoId, title: r.title, subtitle: `${r.artist} · ${r.plays} plays · ${Math.round(r.secs / 60)} min`, thumbnail: r.thumbnail, tn: i + 1 })).join('')}</div></div>` : ''}
    ${!rows.length ? emptyHTML('No stats yet', 'Play some music — totals build up as you listen.', { label: 'Browse home', go: '#/home', ic: 'i-chart' }) : ''}`;
  bindItems(view);
}

/* ---- Library ---- */
function viewLibrary(view, tab) {
  const tabs = [['playlists', 'Playlists'], ['favorites', 'Favorites'], ['saved', 'Saved'], ['history', 'History'], ['stats', 'Stats']];
  if (tab === 'stats') { go('#/stats'); return; }
  let body = '';
  if (tab === 'favorites') {
    const f = Library.favorites;
    body = f.length
      ? `<div class="lib-actions"><button class="pill-btn primary" id="fav-play">${icon('i-play')}<span>Play all</span></button> <button class="pill-btn" id="fav-shuffle">${icon('i-shuffle')}<span>Shuffle</span></button></div>
         ${trackHeadHTML()}<div class="track-list">${f.map((s, i) => trackRowHTML({ ...s, subtitle: s.artist, tn: i + 1 })).join('')}</div>`
      : emptyHTML('No liked songs yet', 'Tap the heart on any song to save it here.', { label: 'Find songs', go: '#/search', ic: 'i-heart-o' });
  } else if (tab === 'history') {
    const h = Library.history;
    body = h.length
      ? `${trackHeadHTML()}<div class="track-list">${h.map((s, i) => trackRowHTML({ ...s, subtitle: s.artist, tn: i + 1 })).join('')}</div>`
      : emptyHTML('Nothing played yet', 'Songs you play will show up here.', { label: 'Browse home', go: '#/home', ic: 'i-clock' });
  } else if (tab === 'saved') {
    const sv = Library.saved;
    body = sv.length
      ? `<div class="lib-grid">${sv.map(cardHTML).join('')}</div>`
      : emptyHTML('Nothing saved yet', 'Open any album, playlist or artist and tap Save.', { label: 'Browse moods', go: '#/moods', ic: 'i-save' });
  } else {
    const pls = Library.playlists;
    body = `<div class="lib-actions">
        <button class="pill-btn primary" id="btn-newpl">${icon('i-plus')}<span>New playlist</span></button>
        <button class="pill-btn" id="btn-import">${icon('i-download')}<span>Import from YT Music</span></button>
        <button class="pill-btn" id="btn-backup">${icon('i-download')}<span>Backup</span></button>
        <button class="pill-btn" id="btn-restore">${icon('i-upload')}<span>Restore</span></button>
      </div>`;
    const cards = (Library.favorites.length ? likedCardHTML() : '') + pls.map((p) => `<div class="card" data-pl="${p.id}"><div class="art">${coverHTML(p.tracks[0] && p.tracks[0].thumbnail)}<div class="play-ov">${icon('i-play')}</div></div><div class="t">${esc(p.name)}</div><div class="s">${p.tracks.length} songs</div></div>`).join('');
    body += cards
      ? `<div class="lib-grid">${cards}</div>`
      : emptyHTML('No playlists yet', 'Use New playlist above, or import one from YouTube Music.', { ic: 'i-note' });
  }
  view.innerHTML = `<div class="page-title">Library</div>
    <div class="chip-row">${tabs.map(([id, l]) => `<button class="chip ${tab === id ? 'active' : ''}" onclick="location.hash='#/library/${id}'">${l}</button>`).join('')}</div>${body}`;
  bindItems(view);
  const np = $('#btn-newpl');
  if (np) np.addEventListener('click', openCreatePlaylist);
  const im = $('#btn-import');
  if (im) im.addEventListener('click', openImportForm);
  const bk = $('#btn-backup');
  if (bk) bk.addEventListener('click', openBackupForm);
  const rs = $('#btn-restore');
  if (rs) rs.addEventListener('click', openRestoreForm);
  const fp = $('#fav-play');
  if (fp) fp.addEventListener('click', () => { const q = [...Library.favorites]; playSong(q[0], q, 0, 'Liked Songs'); });
  const fsh = $('#fav-shuffle');
  if (fsh) fsh.addEventListener('click', () => { const q = [...Library.favorites].sort(() => Math.random() - 0.5); playSong(q[0], q, 0, 'Liked Songs'); });
  $$('[data-pl]', view).forEach((el) => el.addEventListener('click', () => go(`#/localpl/${el.dataset.pl}`)));
  $$('[data-nav]', view).forEach((el) => el.addEventListener('click', () => go(el.dataset.nav)));
}

/* ---- import a public YT Music playlist/album into local library ---- */
function openImportForm() {
  const modal = $('#modal');
  const body = $('#modal-body');
  const actions = $('.modal-actions');
  $('#modal-title').textContent = 'Import from YouTube Music';
  if (actions) actions.classList.add('hidden');
  body.innerHTML = `<form class="pl-form" id="im-form" autocomplete="off">
      <div class="pl-form-cover im" aria-hidden="true">${icon('i-download')}</div>
      <label class="pl-form-label" for="im-form-url">Link</label>
      <input id="im-form-url" class="pl-form-input" type="text" inputmode="url" placeholder="https://music.youtube.com/playlist?list=…" />
      <div class="pl-form-hint">Paste a public YouTube Music playlist, album, artist, or song link.</div>
      <div class="pl-form-actions">
        <button type="button" class="pill-btn" id="im-form-cancel">Cancel</button>
        <button type="submit" class="pill-btn primary" id="im-form-go">${icon('i-download')}<span>Import</span></button>
      </div>
    </form>`;
  const input = $('#im-form-url');
  const goBtn = $('#im-form-go');
  const submit = async () => {
    const url = (input && input.value || '').trim();
    if (!url) {
      if (input) { input.focus(); input.classList.add('shake'); setTimeout(() => input.classList.remove('shake'), 400); }
      return;
    }
    if (goBtn) { goBtn.disabled = true; goBtn.innerHTML = icon('i-download') + '<span>Importing…</span>'; }
    try {
      await importFromLink(url);
      closeModal();
    } catch (e) {
      toast('Import failed: ' + (e.message || 'try again'));
      if (goBtn) { goBtn.disabled = false; goBtn.innerHTML = icon('i-download') + '<span>Import</span>'; }
    }
  };
  $('#im-form').addEventListener('submit', (e) => { e.preventDefault(); submit(); });
  $('#im-form-cancel').addEventListener('click', closeModal);
  modal.classList.remove('hidden');
  setTimeout(() => input && input.focus(), 50);
}
async function importFromLink(url) {
  if (!url) return;
  toast('Resolving link…');
  const r = await api(`/api/resolve?url=${encodeURIComponent(url)}`);
  if (r.kind === 'song') {
    let song = { videoId: r.videoId, title: 'Loading…', playlistId: r.playlistId };
    try {
      const n = await api(`/api/next?videoId=${encodeURIComponent(r.videoId)}`);
      const hit = (n.queue || []).find((q) => q.videoId === r.videoId) || (n.queue || [])[0];
      if (hit) song = songFromItem(hit);
    } catch {}
    openSongNowPlaying(song);
    return;
  }
  if (r.kind === 'artist') { go(`#/artist/${r.id}`); return; }
  const d = await api(`/api/browse?id=${encodeURIComponent(r.id)}`);
  if (!d.tracks.length) { toast('No tracks found (playlist may be private)'); return; }
  const name = (d.header && d.header.title) || 'Imported playlist';
  const pl = Library.createPlaylist(name);
  d.tracks.forEach((t) => Library.addToPlaylist(pl.id, songFromItem(t)));
  toast(`Imported "${name}" (${d.tracks.length} songs)`);
  if ((location.hash || '').startsWith('#/library')) route();
  else go('#/library');
}

/* ---- backup / restore whole local library as a JSON file ---- */
function backupLibrary() {
  const data = {
    app: 'rich-music',
    version: 2,
    exportedAt: new Date().toISOString(),
    favorites: Library.favorites,
    playlists: Library.playlists,
    history: Library.history,
    saved: Library.saved,
    stats: Library.stats,
    settings: {
      theme: store.get('theme', 'dark'),
      vol: store.get('vol', 100),
      sb_on: store.get('sb_on', true),
      yt_hq: store.get('yt_hq', false),
    },
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `rich-music-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
  toast('Backup downloaded');
}
function restoreLibrary() {
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = 'application/json,.json';
  inp.onchange = () => {
    const f = inp.files[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const d = JSON.parse(reader.result);
        if (!d || (d.app !== 'rich-music' && d.app !== 'smw')) throw new Error('Not a Rich Music backup');
        const hasLib = Array.isArray(d.favorites) || Array.isArray(d.playlists) || Array.isArray(d.saved) || Array.isArray(d.history);
        if (!hasLib) throw new Error('Backup file is empty or invalid');
        if (Array.isArray(d.favorites)) store.set('fav', d.favorites);
        if (Array.isArray(d.playlists)) store.set('pls', d.playlists);
        if (Array.isArray(d.history)) store.set('hist', d.history);
        if (Array.isArray(d.saved)) store.set('sav', d.saved);
        if (d.stats && typeof d.stats === 'object' && !Array.isArray(d.stats)) store.set('stats', d.stats);
        if (d.settings && typeof d.settings === 'object') {
          if (d.settings.theme === 'light' || d.settings.theme === 'dark') {
            store.set('theme', d.settings.theme);
            document.documentElement.setAttribute('data-theme', d.settings.theme);
            updateThemeIcon();
          }
          if (typeof d.settings.vol === 'number') {
            store.set('vol', d.settings.vol);
            if (d.settings.vol > 0) { Player.muted = false; store.set('muted', false); }
            applyVolumeUI();
          }
          if (typeof d.settings.sb_on === 'boolean') {
            store.set('sb_on', d.settings.sb_on);
            Player.sbEnabled = d.settings.sb_on;
            $('#np-sb').classList.toggle('on', Player.sbEnabled);
          }
          if (typeof d.settings.yt_hq === 'boolean') {
            store.set('yt_hq', d.settings.yt_hq);
            Player.hq = d.settings.yt_hq;
            updateQualityButton();
          }
        }
        renderSidebarLibrary();
        toast('Library restored');
        closeModal();
        route();
      } catch (e) { toast('Restore failed: ' + e.message); }
    };
    reader.onerror = () => toast('Restore failed: could not read file');
    reader.readAsText(f);
  };
  inp.click();
}
function viewLocalPlaylist(view, pid) {
  const pl = Library.playlists.find((p) => p.id === pid);
  if (!pl) {
    view.innerHTML = emptyHTML('Playlist not found', 'It may have been deleted.', { label: 'Your Library', go: '#/library', ic: 'i-library' });
    bindEmptyCtas(view);
    return;
  }
  const rows = pl.tracks.map((s, i) => {
    const up = i === 0 ? ' disabled' : '';
    const dn = i === pl.tracks.length - 1 ? ' disabled' : '';
    return trackRowHTML({ ...s, subtitle: s.artist, plId: pid, plIndex: i, tn: i + 1 }, false,
      `<button class="tbtn btn-qup" data-i="${i}" title="Move up"${up}>${icon('i-chev-up')}</button>` +
      `<button class="tbtn btn-qdn" data-i="${i}" title="Move down"${dn}>${icon('i-chev-down')}</button>` +
      `<button class="tbtn btn-rm" data-vid="${esc(s.videoId)}" title="Remove">${icon('i-x')}</button>`);
  }).join('');
  const cover = safeCover(pl.tracks[0] && pl.tracks[0].thumbnail)
    ? `<img src="${esc(pl.tracks[0].thumbnail)}" alt="">`
    : `<div class="detail-ph">${icon('i-note')}</div>`;
  view.innerHTML = `<div class="detail-head">
      ${cover}
      <div class="detail-info"><div class="detail-kicker">Playlist</div><h1>${esc(pl.name)}</h1><div class="sub">${pl.tracks.length} song${pl.tracks.length === 1 ? '' : 's'} · Local playlist</div>
      <div class="detail-actions">
        <button class="pill-btn primary" id="pl-play">${icon('i-play')}<span>Play</span></button>
        <button class="pill-btn" id="pl-shuffle">${icon('i-shuffle')}<span>Shuffle</span></button>
        <button class="pill-btn" id="pl-rename">${icon('i-note')}<span>Rename</span></button>
        <button class="pill-btn" id="pl-del">${icon('i-trash')}<span>Delete</span></button>
      </div></div></div>
    ${rows ? trackHeadHTML() + `<div class="track-list">${rows}</div>` : emptyHTML('This playlist is empty', 'Open any song and tap Playlist to add it here.', { label: 'Find songs', go: '#/search', ic: 'i-note' })}`;
  bindItems(view);
  $$('.btn-rm', view).forEach((b) => b.addEventListener('click', (e) => {
    e.stopPropagation();
    Library.removeFromPlaylist(pid, b.dataset.vid);
    route();
  }));
  $$('.btn-qup', view).forEach((b) => b.addEventListener('click', (e) => {
    e.stopPropagation();
    if (Library.moveInPlaylist(pid, Number(b.dataset.i), -1)) route();
  }));
  $$('.btn-qdn', view).forEach((b) => b.addEventListener('click', (e) => {
    e.stopPropagation();
    if (Library.moveInPlaylist(pid, Number(b.dataset.i), 1)) route();
  }));
  if (window.matchMedia('(min-width: 861px)').matches) {
    $$('.track', view).forEach((row) => {
      row.draggable = true;
      row.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/plain', row.dataset.pi);
        e.dataTransfer.effectAllowed = 'move';
        row.classList.add('dragging');
      });
      row.addEventListener('dragend', () => row.classList.remove('dragging'));
      row.addEventListener('dragover', (e) => { e.preventDefault(); row.classList.add('drag-over'); });
      row.addEventListener('dragleave', () => row.classList.remove('drag-over'));
      row.addEventListener('drop', (e) => {
        e.preventDefault();
        row.classList.remove('drag-over');
        const from = Number(e.dataTransfer.getData('text/plain'));
        const to = Number(row.dataset.pi);
        if (!Number.isFinite(from) || !Number.isFinite(to) || from === to) return;
        const pls = Library.playlists;
        const cur = pls.find((p) => p.id === pid);
        if (!cur) return;
        const [item] = cur.tracks.splice(from, 1);
        cur.tracks.splice(to, 0, item);
        store.set('pls', pls);
        route();
      });
    });
  }
  $('#pl-play').addEventListener('click', () => pl.tracks.length && playSong(pl.tracks[0], [...pl.tracks], 0, pl.name));
  $('#pl-shuffle').addEventListener('click', () => {
    if (!pl.tracks.length) return;
    const q = [...pl.tracks].sort(() => Math.random() - 0.5);
    playSong(q[0], q, 0, pl.name);
  });
  $('#pl-rename').addEventListener('click', () => openRenamePlaylist(pid));
  $('#pl-del').addEventListener('click', () => openDeletePlaylist(pid));
}

/* ---- Browse (album / playlist / artist / mood) ---- */
async function viewBrowse(view, id, kind, extraParams) {
  view.innerHTML = skeletonHTML;
  const d = await api(`/api/browse?id=${encodeURIComponent(id)}${extraParams ? '&params=' + encodeURIComponent(extraParams) : ''}`);
  applyTint(id || kind);
  const h = d.header || { title: '', subtitle: '' };
  const kick = kind === 'artist' ? 'Artist' : kind === 'album' ? 'Album' : kind === 'playlist' ? 'Playlist' : 'Collection';
  let html = '';
  if (h.title) {
    html += `<div class="detail-head ${kind === 'artist' ? 'artist' : ''}">
      ${safeCover(h.thumbnail) ? `<img src="${esc(h.thumbnail)}" alt="">` : `<div class="detail-ph">${icon('i-note')}</div>`}
      <div class="detail-info"><div class="detail-kicker">${kick}</div><h1>${esc(h.title)}</h1>
        <div class="sub">${esc([h.strapline, h.subtitle].filter(Boolean).join(' • '))}${h.description ? `<br><span style="font-size:12.5px">${esc(h.description.slice(0, 260))}${h.description.length > 260 ? '…' : ''}</span>` : ''}</div>
        <div class="detail-actions">
          ${d.tracks.length ? `<button class="pill-btn primary" id="br-play">${icon('i-play')}<span>Play</span></button><button class="pill-btn" id="br-shuffle">${icon('i-shuffle')}<span>Shuffle</span></button>` : ''}
          <button class="pill-btn" id="br-save">${icon(Library.isSaved(id) ? 'i-save-f' : 'i-save')}<span>${Library.isSaved(id) ? 'Saved' : 'Save'}</span></button>
        </div>
      </div></div>`;
  }
  if (d.tracks.length) {
    const headerArtist = (h.artists && h.artists[0] && h.artists[0].name) || h.strapline || '';
    const headerArtistId = (h.artists && h.artists[0] && h.artists[0].browseId) || '';
    html += `${trackHeadHTML()}<div class="track-list">${d.tracks.map((t, i) => {
      const fromArr = (t.artists || []).map((a) => a.name).filter(Boolean).join(', ');
      const artist = t.artist || fromArr || headerArtist;
      return trackRowHTML({
        ...t,
        tn: i + 1,
        artist,
        subtitle: artist || t.subtitle,
        artistBrowseId: t.artistBrowseId || (t.artists && t.artists[0] && t.artists[0].browseId) || headerArtistId,
        duration: normalizeDuration(t.duration),
      });
    }).join('')}</div>`;
  }
  html += (d.sections || []).map(shelfHTML).join('');
  view.innerHTML = html || emptyHTML('Nothing here', 'This page has no songs or related albums yet.', { label: 'Go home', go: '#/home', ic: 'i-note' });
  bindItems(view);
  const toSongs = () => d.tracks.map((t) => ({ ...songFromItem(t), thumbnail: t.thumbnail || h.thumbnail }));
  const bp = $('#br-play');
  if (bp) bp.addEventListener('click', () => { const q = toSongs(); playSong(q[0], q, 0, h.title || ''); });
  const bs = $('#br-shuffle');
  if (bs) bs.addEventListener('click', () => { const q = toSongs().sort(() => Math.random() - 0.5); playSong(q[0], q, 0, h.title || ''); });
  const bsv = $('#br-save');
  if (bsv) bsv.addEventListener('click', () => {
    Library.toggleSaved({
      type: kind === 'artist' ? 'artist' : kind === 'album' ? 'album' : 'playlist',
      browseType: kind, browseId: id,
      title: h.title, subtitle: h.subtitle || '', thumbnail: h.thumbnail,
    });
    bsv.innerHTML = icon(Library.isSaved(id) ? 'i-save-f' : 'i-save') + `<span>${Library.isSaved(id) ? 'Saved' : 'Save'}</span>`;
  });
  // playing track highlight handled implicitly on rerender
}

/* ================= song overflow menu ================= */
function openSongMenu(song, opts = {}) {
  if (!song || !song.videoId) return;
  const modal = $('#modal');
  const body = $('#modal-body');
  const actions = $('.modal-actions');
  if (actions) actions.classList.remove('hidden');
  $('#modal-title').textContent = displayTitle(song.title) || 'Song';
  const liked = Library.isFav(song.videoId);
  const qi = opts.qi;
  const inUserQ = Number.isFinite(qi) && qi > Player.index && Player.queue[qi] && Player.queue[qi]._user;
  const isFirst = inUserQ && (qi === Player.index + 1 || !(Player.queue[qi - 1] && Player.queue[qi - 1]._user));
  const isLast = inUserQ && !(Player.queue[qi + 1] && Player.queue[qi + 1]._user);
  const inPl = !!(opts.plId && Number.isFinite(opts.plIndex));
  const pl = inPl ? Library.playlists.find((p) => p.id === opts.plId) : null;
  const isPlFirst = inPl && opts.plIndex === 0;
  const isPlLast = inPl && pl && opts.plIndex === pl.tracks.length - 1;
  const row = (act, ic, label, disabled) =>
    `<button type="button" class="modal-row${disabled ? ' disabled' : ''}" data-act="${act}"${disabled ? ' disabled' : ''}>${icon(ic)}<span>${label}</span></button>`;
  body.innerHTML = `<div class="sm-head">
      ${coverHTML(song.thumbnail, 'sm')}
      <div class="sm-meta"><div class="sm-t">${esc(displayTitle(song.title))}</div><div class="sm-s">${esc(song.artist || song.subtitle || '')}</div></div>
    </div>
    ${row('next', 'i-next', 'Play next')}
    ${row('queue', 'i-queue', 'Add to queue')}
    ${row('fav', liked ? 'i-heart-f' : 'i-heart-o', liked ? 'Favorited' : 'Favorite')}
    ${row('pl', 'i-plus', 'Add to playlist')}
    ${row('dl', 'i-download', 'Download')}
    ${row('share', 'i-share', 'Share')}
    ${row('artist', 'i-search', 'Go to artist')}
    ${inUserQ ? `${row('up', 'i-chev-up', 'Move up', isFirst)}${row('dn', 'i-chev-down', 'Move down', isLast)}${row('rm', 'i-x', 'Remove from queue')}` : ''}
    ${inPl ? `${row('plup', 'i-chev-up', 'Move up', isPlFirst)}${row('pldn', 'i-chev-down', 'Move down', isPlLast)}${row('plrm', 'i-x', 'Remove from playlist')}` : ''}`;
  $$('[data-act]', body).forEach((b) => b.addEventListener('click', () => {
    if (b.disabled) return;
    const a = b.dataset.act;
    if (a === 'next') queueSong(song, true);
    else if (a === 'queue') queueSong(song, false);
    else if (a === 'fav') Library.toggleFav(song);
    else if (a === 'pl') { openAddToPlaylist(song); return; }
    else if (a === 'dl') downloadSong(song);
    else if (a === 'share') { shareSong(song); }
    else if (a === 'artist') { goToArtist(song); }
    else if (a === 'up') moveQueued(qi, -1);
    else if (a === 'dn') moveQueued(qi, 1);
    else if (a === 'rm') removeQueued(qi);
    else if (a === 'plup') { if (Library.moveInPlaylist(opts.plId, opts.plIndex, -1)) route(); }
    else if (a === 'pldn') { if (Library.moveInPlaylist(opts.plId, opts.plIndex, 1)) route(); }
    else if (a === 'plrm') { Library.removeFromPlaylist(opts.plId, song.videoId); route(); }
    closeModal();
  }));
  modal.classList.remove('hidden');
}

function openNowPlayingMore() {
  const song = focusedSong();
  if (!song) return;
  const modal = $('#modal');
  const body = $('#modal-body');
  const actions = $('.modal-actions');
  if (actions) actions.classList.remove('hidden');
  $('#modal-title').textContent = displayTitle(song.title) || 'More';
  const row = (act, ic, label, on) =>
    `<button type="button" class="modal-row${on ? ' on' : ''}" data-npact="${act}">${icon(ic)}<span>${label}</span></button>`;
  body.innerHTML = `
    ${row('dl', 'i-download', 'Download')}
    ${row('share', 'i-share', 'Share')}
    ${row('artist', 'i-search', 'Go to artist')}
    ${row('autoplay', 'i-radio', Player.autoplay ? 'Autoplay on' : 'Autoplay off', Player.autoplay)}
    ${row('speed', 'i-clock', `Speed · ${Player.speed}×`)}
    ${row('float', 'i-pip', Player.floatOn ? 'Widget on' : 'Widget')}
    ${row('quality', 'i-expand', Player.hq ? 'Quality · Max' : 'Quality · YouTube Music')}
    ${row('sb', 'i-next', Player.sbEnabled ? 'SponsorBlock on' : 'SponsorBlock')}`;
  $$('[data-npact]', body).forEach((b) => b.addEventListener('click', () => {
    const a = b.dataset.npact;
    if (a === 'dl') downloadSong(song);
    else if (a === 'share') shareSong(song);
    else if (a === 'artist') goToArtist(song);
    else if (a === 'autoplay') toggleAutoplay();
    else if (a === 'speed') cycleSpeed();
    else if (a === 'float') toggleFloatWidget();
    else if (a === 'quality') toggleQuality();
    else if (a === 'sb') toggleSB();
    closeModal();
  }));
  modal.classList.remove('hidden');
}
function syncNpMore() {
  const btn = $('#np-more');
  if (btn) btn.classList.toggle('has-on', !!(Player.floatOn || Player.sbEnabled || Player.hq || !Player.autoplay));
}
function closeModal() {
  const modal = $('#modal');
  if (modal) modal.classList.add('hidden');
  const actions = $('.modal-actions');
  if (actions) actions.classList.remove('hidden');
}
function songArtistBrowseId(s) {
  if (!s) return '';
  if (s.artistBrowseId) return s.artistBrowseId;
  const a = s.artists && s.artists[0];
  return (a && a.browseId) || '';
}
function goToArtist(song) {
  const s = song || focusedSong();
  if (!s) return;
  const id = songArtistBrowseId(s);
  closeNowPlaying();
  if (id) go(`#/artist/${id}`);
  else if (s.artist) go(`#/search/${encodeURIComponent(String(s.artist).split(',')[0].trim())}`);
}
async function openSharedSong(videoId) {
  if (!videoId) return;
  let song = { videoId, title: 'Song' };
  try {
    const d = await api(`/api/next?videoId=${encodeURIComponent(videoId)}`);
    const hit = (d.queue || []).find((q) => q.videoId === videoId) || (d.queue || [])[0];
    if (hit) song = songFromItem(hit);
  } catch {}
  openSongNowPlaying(song);
}
async function shareSong(song) {
  const s = song || focusedSong();
  if (!s || !s.videoId) return;
  const url = `${location.origin}${location.pathname}#/song/${s.videoId}`;
  const title = displayTitle(s.title) || s.title || 'Song';
  const text = s.artist ? `${title} — ${s.artist}` : title;
  if (navigator.share) {
    try {
      await navigator.share({ title, text, url });
      return;
    } catch (e) {
      if (e && e.name === 'AbortError') return;
    }
  }
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) await navigator.clipboard.writeText(url);
    else {
      const ta = document.createElement('textarea');
      ta.value = url; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
    }
    toast('Link copied');
  } catch {
    toast(url);
  }
}
function openSleepTimer() {
  const modal = $('#modal');
  const body = $('#modal-body');
  const actions = $('.modal-actions');
  $('#modal-title').textContent = 'Sleep timer';
  if (actions) actions.classList.add('hidden');
  const active = !!Player.sleepTimer;
  body.innerHTML = `<form class="pl-form" id="sl-form">
      <div class="pl-form-cover" aria-hidden="true">${icon('i-clock')}</div>
      <div class="pl-form-hint">${active ? 'A timer is already running. Pick a new time to replace it.' : 'Pause playback after the selected time.'}</div>
      <div class="pl-presets" id="sl-presets">
        ${[15, 30, 45, 60].map((m) => `<button type="button" class="chip" data-m="${m}">${m} min</button>`).join('')}
      </div>
      <label class="pl-form-label" for="sl-mins">Custom (minutes)</label>
      <input id="sl-mins" class="pl-form-input" type="number" min="0" max="240" placeholder="e.g. 20" />
      <div class="pl-form-actions">
        <button type="button" class="pill-btn" id="sl-cancel-timer">${active ? 'Cancel timer' : 'Close'}</button>
        <button type="submit" class="pill-btn primary">Start</button>
      </div>
    </form>`;
  const input = $('#sl-mins');
  const start = (m) => {
    clearTimeout(Player.sleepTimer);
    Player.sleepTimer = null;
    $('#np-sleep') && $('#np-sleep').classList.remove('on');
    if (m > 0) {
      Player.sleepTimer = setTimeout(() => {
        userPause(); // counts as a deliberate pause, so background resume won't restart it
        Player.sleepTimer = null;
        $('#np-sleep') && $('#np-sleep').classList.remove('on');
        toast('Sleep timer: paused');
      }, m * 60000);
      $('#np-sleep') && $('#np-sleep').classList.add('on');
      toast(`Sleeping in ${m} min`);
    } else toast('Sleep timer cancelled');
    closeModal();
  };
  $$('#sl-presets .chip').forEach((c) => c.addEventListener('click', () => start(Number(c.dataset.m))));
  $('#sl-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const m = Number(input.value);
    if (!Number.isFinite(m) || m < 0) { input.classList.add('shake'); setTimeout(() => input.classList.remove('shake'), 400); return; }
    start(m);
  });
  $('#sl-cancel-timer').addEventListener('click', () => {
    if (Player.sleepTimer) start(0);
    else closeModal();
  });
  modal.classList.remove('hidden');
  setTimeout(() => input && input.focus(), 50);
}
function openBackupForm() {
  const modal = $('#modal');
  const body = $('#modal-body');
  const actions = $('.modal-actions');
  $('#modal-title').textContent = 'Backup library';
  if (actions) actions.classList.add('hidden');
  body.innerHTML = `<div class="pl-form">
      <div class="pl-form-cover" aria-hidden="true">${icon('i-download')}</div>
      <div class="pl-form-hint">Download a JSON file of your playlists, favorites, history, and settings. Keep it somewhere safe.</div>
      <div class="pl-form-actions">
        <button type="button" class="pill-btn" id="bk-close">Cancel</button>
        <button type="button" class="pill-btn primary" id="bk-go">${icon('i-download')}<span>Download backup</span></button>
      </div>
    </div>`;
  $('#bk-close').addEventListener('click', closeModal);
  $('#bk-go').addEventListener('click', () => { backupLibrary(); closeModal(); });
  modal.classList.remove('hidden');
}
function openRestoreForm() {
  const modal = $('#modal');
  const body = $('#modal-body');
  const actions = $('.modal-actions');
  $('#modal-title').textContent = 'Restore library';
  if (actions) actions.classList.add('hidden');
  body.innerHTML = `<div class="pl-form">
      <div class="pl-form-cover im" aria-hidden="true">${icon('i-upload')}</div>
      <div class="pl-form-hint">This replaces your current library with the backup file. Playlists and favorites on this device will be overwritten.</div>
      <div class="pl-form-actions">
        <button type="button" class="pill-btn" id="rs-close">Cancel</button>
        <button type="button" class="pill-btn primary" id="rs-go">${icon('i-upload')}<span>Choose file</span></button>
      </div>
    </div>`;
  $('#rs-close').addEventListener('click', closeModal);
  $('#rs-go').addEventListener('click', () => restoreLibrary());
  modal.classList.remove('hidden');
}
function openCreatePlaylist() {
  const modal = $('#modal');
  const body = $('#modal-body');
  const actions = $('.modal-actions');
  $('#modal-title').textContent = 'Create playlist';
  if (actions) actions.classList.add('hidden');
  body.innerHTML = `<form class="pl-form" id="pl-form" autocomplete="off">
      <div class="pl-form-cover" aria-hidden="true">${icon('i-note')}</div>
      <label class="pl-form-label" for="pl-form-name">Playlist name</label>
      <input id="pl-form-name" class="pl-form-input" type="text" maxlength="80" placeholder="My playlist" />
      <div class="pl-form-hint">Give it a name — you can add songs anytime.</div>
      <div class="pl-form-actions">
        <button type="button" class="pill-btn" id="pl-form-cancel">Cancel</button>
        <button type="submit" class="pill-btn primary" id="pl-form-create">${icon('i-plus')}<span>Create</span></button>
      </div>
    </form>`;
  const input = $('#pl-form-name');
  const submit = () => {
    const name = (input && input.value || '').trim();
    if (!name) {
      if (input) { input.focus(); input.classList.add('shake'); setTimeout(() => input.classList.remove('shake'), 400); }
      return;
    }
    Library.createPlaylist(name);
    closeModal();
    toast(`Created “${name}”`);
    if ((location.hash || '').startsWith('#/library')) route();
    else go('#/library');
  };
  $('#pl-form').addEventListener('submit', (e) => { e.preventDefault(); submit(); });
  $('#pl-form-cancel').addEventListener('click', closeModal);
  modal.classList.remove('hidden');
  setTimeout(() => input && input.focus(), 50);
}
function openRenamePlaylist(pid) {
  const pl = Library.playlists.find((p) => p.id === pid);
  if (!pl) return;
  const modal = $('#modal');
  const body = $('#modal-body');
  const actions = $('.modal-actions');
  $('#modal-title').textContent = 'Rename playlist';
  if (actions) actions.classList.add('hidden');
  body.innerHTML = `<form class="pl-form" id="rn-form" autocomplete="off">
      <div class="pl-form-cover" aria-hidden="true">${icon('i-note')}</div>
      <label class="pl-form-label" for="rn-name">Playlist name</label>
      <input id="rn-name" class="pl-form-input" type="text" maxlength="80" value="${esc(pl.name)}" />
      <div class="pl-form-actions">
        <button type="button" class="pill-btn" id="rn-cancel">Cancel</button>
        <button type="submit" class="pill-btn primary">Save</button>
      </div>
    </form>`;
  const input = $('#rn-name');
  $('#rn-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = (input.value || '').trim();
    if (!name) { input.classList.add('shake'); setTimeout(() => input.classList.remove('shake'), 400); return; }
    Library.renamePlaylist(pid, name);
    closeModal();
    toast('Playlist renamed');
    route();
  });
  $('#rn-cancel').addEventListener('click', closeModal);
  modal.classList.remove('hidden');
  setTimeout(() => { if (input) { input.focus(); input.select(); } }, 50);
}
function openDeletePlaylist(pid) {
  const pl = Library.playlists.find((p) => p.id === pid);
  if (!pl) return;
  const modal = $('#modal');
  const body = $('#modal-body');
  const actions = $('.modal-actions');
  $('#modal-title').textContent = 'Delete playlist';
  if (actions) actions.classList.add('hidden');
  body.innerHTML = `<div class="pl-form">
      <div class="pl-form-cover im" aria-hidden="true">${icon('i-trash')}</div>
      <div class="pl-form-hint">Delete “${esc(pl.name)}”? This can’t be undone. The songs themselves stay in YouTube Music.</div>
      <div class="pl-form-actions">
        <button type="button" class="pill-btn" id="dlpl-cancel">Cancel</button>
        <button type="button" class="pill-btn primary" id="dlpl-go">${icon('i-trash')}<span>Delete</span></button>
      </div>
    </div>`;
  $('#dlpl-cancel').addEventListener('click', closeModal);
  $('#dlpl-go').addEventListener('click', () => {
    Library.deletePlaylist(pid);
    closeModal();
    toast('Playlist deleted');
    go('#/library');
  });
  modal.classList.remove('hidden');
}

/* ================= add-to-playlist modal ================= */
function openAddToPlaylist(song) {
  const modal = $('#modal');
  const body = $('#modal-body');
  const actions = $('.modal-actions');
  if (actions) actions.classList.remove('hidden');
  $('#modal-title').textContent = 'Add to playlist';
  const render = () => {
    const pls = Library.playlists;
    body.innerHTML = `<div class="q-modal-row">
        <button class="pill-btn" id="q-playnext">${icon('i-next')}<span>Play next</span></button>
        <button class="pill-btn" id="q-add">${icon('i-queue')}<span>Add to queue</span></button>
      </div>
      <input id="newpl-name" placeholder="New playlist name…">
      <button class="pill-btn primary" id="newpl-create" style="margin-bottom:12px">Create & add</button>
      ${pls.length ? `<div class="pl-list-label">Your playlists</div>` : ''}
      ${pls.map((p) => {
        const cover = p.tracks[0] && p.tracks[0].thumbnail;
        const n = p.tracks.length;
        return `<button type="button" class="modal-row pl-pick" data-id="${p.id}">
          ${cover ? `<img class="pl-pick-art" src="${esc(cover)}" alt="">` : `<span class="pl-pick-ph">${icon('i-note')}</span>`}
          <span class="pl-pick-meta"><span class="pl-pick-name">${esc(p.name)}</span><span class="pl-pick-count">${n} song${n === 1 ? '' : 's'}</span></span>
        </button>`;
      }).join('') || '<div class="empty-note">No playlists yet</div>'}`;
    $('#q-playnext').addEventListener('click', () => { queueSong(song, true); closeModal(); });
    $('#q-add').addEventListener('click', () => { queueSong(song, false); closeModal(); });
    $('#newpl-create').addEventListener('click', () => {
      const name = $('#newpl-name').value.trim();
      if (!name) return;
      const pl = Library.createPlaylist(name);
      Library.addToPlaylist(pl.id, song);
      toast(`Added to "${name}"`);
      modal.classList.add('hidden');
    });
    $$('.modal-row', body).forEach((r) => r.addEventListener('click', () => {
      Library.addToPlaylist(r.dataset.id, song);
      toast('Added to playlist');
      modal.classList.add('hidden');
    }));
  };
  render();
  modal.classList.remove('hidden');
}
$('#modal-cancel').addEventListener('click', closeModal);
$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });

/* ================= wire up controls ================= */
$('#mini-play').addEventListener('click', (e) => { e.stopPropagation(); togglePlay(); });
$('#mini-next').addEventListener('click', (e) => { e.stopPropagation(); nextTrack(false); });
$('#mini-prev').addEventListener('click', (e) => { e.stopPropagation(); prevTrack(); });
$('#mini-like').addEventListener('click', (e) => { e.stopPropagation(); if (Player.current) Library.toggleFav(Player.current); });
/* open Now Playing from art / title / expand button (Spotify behaviour) */
const openNP = (e) => {
  e.stopPropagation();
  Player.pending = null;
  renderNowPlaying();
  renderPlayButtons();
  updateLikeButtons();
  openNowPlaying();
};
$('#mini-art').addEventListener('click', openNP);
$('.mini-meta').addEventListener('click', openNP);
$('#mini-open').addEventListener('click', openNP);
const openQueue = (e) => { e.stopPropagation(); openNowPlaying(); switchNPTab('queue'); };
$('#mini-queue').addEventListener('click', openQueue);
$('#mini-queue-m').addEventListener('click', openQueue);
/* shuffle / repeat on the bar (synced with Now Playing buttons) */
$('#mini-shuffle').addEventListener('click', (e) => {
  e.stopPropagation();
  Player.shuffle = !Player.shuffle;
  $('#mini-shuffle').classList.toggle('on', Player.shuffle);
  $('#np-shuffle').classList.toggle('on', Player.shuffle);
  toast(Player.shuffle ? 'Shuffle on' : 'Shuffle off');
});
$('#mini-repeat').addEventListener('click', (e) => {
  e.stopPropagation();
  Player.repeat = (Player.repeat + 1) % 3;
  const on = Player.repeat > 0;
  const ic = icon(Player.repeat === 2 ? 'i-repeat-1' : 'i-repeat');
  $('#mini-repeat').classList.toggle('on', on); $('#mini-repeat').innerHTML = ic;
  $('#np-repeat').classList.toggle('on', on); $('#np-repeat').innerHTML = ic;
  persistQueue();
  toast(['Repeat off', 'Repeat all', 'Repeat one'][Player.repeat]);
});
/* ---- volume + mute (single source of truth) ---- */
function volumeIconId(vol, muted) {
  if (muted || vol <= 0) return 'i-volume-mute';
  if (vol < 50) return 'i-volume-low';
  return 'i-volume';
}
function applyVolumeUI() {
  const vol = Player.muted ? 0 : Number(store.get('vol', 100));
  if (Player.yt && Player.ready) { try { Player.yt.setVolume(vol); } catch {} }
  const mv = $('#mini-volume'); if (mv) mv.value = vol;
  const nv = $('#np-volume'); if (nv) nv.value = vol;
  const icId = volumeIconId(Number(store.get('vol', 100)), Player.muted);
  $$('#mini-mute use, #np-mute use').forEach((u) => u.setAttribute('href', '#' + icId));
  [$('#mini-mute'), $('#np-mute')].forEach((b) => {
    if (!b) return;
    b.classList.toggle('on', Player.muted);
    b.title = Player.muted ? 'Unmute (M)' : 'Mute (M)';
  });
}
function toggleMute() {
  if (!Player.muted) {
    // mute: remember current volume, then zero it
    Player.preMuteVol = Number(store.get('vol', 100)) || 0;
    Player.muted = true;
  } else {
    // unmute: if stored volume is 0, restore to the pre-mute level (or 100)
    Player.muted = false;
    if (Number(store.get('vol', 100)) <= 0) store.set('vol', Player.preMuteVol > 0 ? Player.preMuteVol : 100);
  }
  store.set('muted', Player.muted);
  applyVolumeUI();
  toast(Player.muted ? 'Muted' : 'Unmuted');
}
/* dragging either slider sets the real volume and clears mute */
function onVolumeInput(value) {
  const v = Math.max(0, Math.min(100, Number(value) || 0));
  store.set('vol', v);
  Player.muted = v <= 0;
  store.set('muted', Player.muted);
  if (v > 0) Player.preMuteVol = v;
  applyVolumeUI();
}
/* volume on the bar */
$('#mini-volume').addEventListener('input', (e) => onVolumeInput(e.target.value));
$('#mini-mute').addEventListener('click', (e) => { e.stopPropagation(); toggleMute(); });
/* click-to-seek on the bar */
$('#mini-bar').addEventListener('click', (e) => {
  if (Player.cued || !Player.yt || !Player.ready) return;
  const r = e.currentTarget.getBoundingClientRect();
  const frac = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  const dur = Player.yt.getDuration() || 0;
  if (dur) Player.yt.seekTo(frac * dur, true);
});
$('#np-close').addEventListener('click', closeNowPlaying);
$('#np-play').addEventListener('click', toggleNowPlayingPlay);
$('#np-next').addEventListener('click', () => nextTrack(false));
$('#np-prev').addEventListener('click', prevTrack);
$('#np-like').addEventListener('click', () => focusedSong() && Library.toggleFav(focusedSong()));
$('#np-playnext').addEventListener('click', () => {
  const s = focusedSong();
  if (!s) return;
  queueSong(s, true);
  Player.pending = null;
  renderNowPlaying();
  renderPlayButtons();
  updateLikeButtons();
  switchNPTab('queue');
});
$('#np-queueadd').addEventListener('click', () => {
  const s = focusedSong();
  if (!s) return;
  queueSong(s, false);
  Player.pending = null;
  renderNowPlaying();
  renderPlayButtons();
  updateLikeButtons();
  switchNPTab('queue');
});
$('#np-addpl').addEventListener('click', () => focusedSong() && openAddToPlaylist(focusedSong()));
$('#np-download').addEventListener('click', () => focusedSong() && downloadSong(focusedSong()));
$('#np-shuffle').addEventListener('click', function () {
  Player.shuffle = !Player.shuffle;
  this.classList.toggle('on', Player.shuffle);
  $('#mini-shuffle').classList.toggle('on', Player.shuffle);
  persistQueue();
  toast(Player.shuffle ? 'Shuffle on' : 'Shuffle off');
});
$('#np-repeat').addEventListener('click', function () {
  Player.repeat = (Player.repeat + 1) % 3;
  const on = Player.repeat > 0;
  const ic = icon(Player.repeat === 2 ? 'i-repeat-1' : 'i-repeat');
  this.classList.toggle('on', on); this.innerHTML = ic;
  $('#mini-repeat').classList.toggle('on', on); $('#mini-repeat').innerHTML = ic;
  persistQueue();
  toast(['Repeat off', 'Repeat all', 'Repeat one'][Player.repeat]);
});
$('#np-speed').addEventListener('click', cycleSpeed);
$('#np-float').addEventListener('click', toggleFloatWidget);
$('#mini-float').addEventListener('click', (e) => { e.stopPropagation(); toggleFloatWidget(); });
$('#np-quality').addEventListener('click', toggleQuality);
$('#np-sb').addEventListener('click', toggleSB);
$('#np-volume').addEventListener('input', (e) => onVolumeInput(e.target.value));
$('#np-mute').addEventListener('click', (e) => { e.stopPropagation(); toggleMute(); });
$('#np-lyric-preview').addEventListener('click', () => switchNPTab('lyrics'));
$('#np-sleep').addEventListener('click', openSleepTimer);
const npShare = $('#np-share');
if (npShare) npShare.addEventListener('click', () => shareSong(focusedSong()));
const npMore = $('#np-more');
if (npMore) npMore.addEventListener('click', openNowPlayingMore);
$('#np-artist').addEventListener('click', (e) => { e.stopPropagation(); goToArtist(focusedSong()); });

let seekDragging = false;
const range = $('#np-range');
range.addEventListener('input', () => { seekDragging = true; });
range.addEventListener('change', () => {
  seekDragging = false;
  if (isPreviewing() || !Player.yt || !Player.ready) return;
  const dur = Player.yt.getDuration() || 0;
  Player.yt.seekTo((range.value / 1000) * dur, true);
});

function switchNPTab(name) {
  $$('.np-tab').forEach((t) => t.classList.toggle('active', t.dataset.nptab === name));
  $$('.np-pane').forEach((p) => p.classList.toggle('active', p.id === 'np-' + name));
  if (name === 'related') loadRelated();
  if (name === 'lyrics') { lastLyricIdx = -2; }
  if (name === 'queue') renderQueue();
}
$$('.np-tab').forEach((t) => t.addEventListener('click', () => switchNPTab(t.dataset.nptab)));

/* ---- karaoke (big lyrics) mode ---- */
function applyKaraoke() {
  const on = !!store.get('karaoke', false);
  const pane = $('#np-lyrics');
  if (pane) pane.classList.toggle('karaoke', on);
  const btn = $('#lyrics-karaoke');
  if (btn) {
    btn.classList.toggle('on', on);
    btn.title = on ? 'Karaoke mode on — tap for normal lyrics' : 'Karaoke mode — bigger lyrics';
  }
}
function toggleKaraoke() {
  store.set('karaoke', !store.get('karaoke', false));
  applyKaraoke();
  lastLyricIdx = -2; // force re-highlight/scroll with the new sizing
  toast(store.get('karaoke', false) ? 'Karaoke mode on' : 'Karaoke mode off');
}
const karaokeBtn = $('#lyrics-karaoke');
if (karaokeBtn) karaokeBtn.addEventListener('click', toggleKaraoke);

document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
  if (e.code === 'ArrowRight' && e.shiftKey) nextTrack(false);
  if (e.code === 'ArrowLeft' && e.shiftKey) prevTrack();
  if (e.code === 'Escape') closeNowPlaying();
  if (e.code === 'KeyL') toggleTheme();
  if (e.code === 'KeyM') toggleMute();
  if (e.code === 'KeyP') { e.preventDefault(); toggleFloatWidget(); }
});

/* topbar back / forward (Spotify chrome) */
$('#nav-back').addEventListener('click', () => history.back());
$('#nav-fwd').addEventListener('click', () => history.forward());
$('#lib-new').addEventListener('click', () => go('#/library'));
$('#lib-title-btn').addEventListener('click', () => go('#/library'));
const sideQBtn = $('#side-queue-btn');
if (sideQBtn) sideQBtn.addEventListener('click', () => { openNowPlaying(); switchNPTab('queue'); });
const sideQClr = $('#side-q-clear');
if (sideQClr) sideQClr.addEventListener('click', (e) => { e.stopPropagation(); clearUserQueue(); });
$('#miniplayer').addEventListener('click', (e) => {
  if (e.target.closest('button, input, .pb-bar, .pb-seek')) return;
  Player.pending = null;
  renderNowPlaying();
  renderPlayButtons();
  updateLikeButtons();
  openNowPlaying();
});
(() => {
  const np = $('#nowplaying');
  let startY = 0;
  np.addEventListener('touchstart', (e) => { startY = e.changedTouches[0].clientY; }, { passive: true });
  np.addEventListener('touchend', (e) => {
    const dy = e.changedTouches[0].clientY - startY;
    if (dy > 90 && window.innerWidth < 1100) closeNowPlaying();
  }, { passive: true });
})();

/* ================= floating widget / Picture-in-Picture ================= */
Player.pipWin = null;
Player.floatOn = false;

const FW_CSS = `
  :root { color-scheme: dark; }
  html, body { margin: 0; height: 100%; background: #121212; color: #fff;
    font-family: Figtree, Segoe UI, sans-serif; overflow: hidden; }
  html[data-theme="light"] { color-scheme: light; }
  html[data-theme="light"] body { background: #fff; color: #121212; }
  #float-widget {
    display: flex; align-items: center; gap: 10px; height: 100%;
    padding: 10px 12px; box-sizing: border-box;
    background: linear-gradient(135deg, #1a1a1a, #121212);
  }
  html[data-theme="light"] #float-widget { background: linear-gradient(135deg, #f4f4f4, #fff); }
  #fw-art { width: 72px; height: 72px; border-radius: 8px; object-fit: cover; background: #282828; flex-shrink: 0; }
  .fw-meta { min-width: 0; flex: 1; }
  #fw-title { font-size: 14px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  #fw-artist { font-size: 12px; opacity: .65; margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  #fw-lyric { margin-top: 5px; font-size: 12px; font-weight: 700; color: #1ed760; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; cursor: pointer; line-height: 1.3; }
  #fw-lyric:empty { display: none; }
  .fw-bar { margin-top: 8px; height: 4px; background: rgba(255,255,255,.22); border-radius: 99px; cursor: pointer; overflow: hidden; }
  html[data-theme="light"] .fw-bar { background: rgba(0,0,0,.18); }
  #fw-fill { height: 100%; width: 0; background: #1ed760; border-radius: 99px; }
  .fw-controls { display: flex; align-items: center; gap: 2px; }
  .fw-btn { width: 32px; height: 32px; border: none; background: none; color: inherit; border-radius: 50%;
    display: flex; align-items: center; justify-content: center; cursor: pointer; }
  .fw-btn:hover { background: rgba(255,255,255,.1); }
  .fw-play { width: 38px; height: 38px; background: #fff; color: #000; }
  html[data-theme="light"] .fw-play { background: #121212; color: #fff; }
  .fw-btn .ic { width: 16px; height: 16px; fill: currentColor; display: block; }
  .hidden { display: none !important; }
`;

function widgetDocs() {
  const docs = [document];
  if (Player.pipWin && !Player.pipWin.closed) docs.push(Player.pipWin.document);
  return docs;
}
function syncFloatWidget() {
  const s = Player.current;
  const playing = Player.yt && Player.ready && Player.yt.getPlayerState && Player.yt.getPlayerState() === YT.PlayerState.PLAYING;
  const ic = icon(playing ? 'i-pause' : 'i-play');
  for (const doc of widgetDocs()) {
    const art = doc.getElementById('fw-art');
    const title = doc.getElementById('fw-title');
    const artist = doc.getElementById('fw-artist');
    const play = doc.querySelector('[data-fw="play"]');
    if (art && s) art.src = safeCover(s.thumbnail) || COVER_PH;
    if (title) title.textContent = s ? s.title : '—';
    if (artist) artist.textContent = s ? (s.artist || s.subtitle || '') : '—';
    if (play) play.innerHTML = ic;
  }
  $('#mini-float')?.classList.toggle('on', Player.floatOn);
  $('#np-float')?.classList.toggle('on', Player.floatOn);
  syncNpMore();
  if (s && s.thumbnail) loadPipArt(s.thumbnail);
}
function syncFloatLyric(text) {
  const t = text || '';
  for (const doc of widgetDocs()) {
    const el = doc.getElementById('fw-lyric');
    if (el) el.textContent = t;
  }
}
function syncFloatProgress(pct) {
  for (const doc of widgetDocs()) {
    const fill = doc.getElementById('fw-fill');
    if (fill) fill.style.width = (pct || 0) + '%';
  }
}
function bindFloatWidget(rootDoc) {
  const root = rootDoc.getElementById('float-widget');
  if (!root || root._fwBound) return;
  root._fwBound = true;
  root.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-fw]');
    if (!btn) return;
    e.stopPropagation();
    const act = btn.dataset.fw;
    if (act === 'play') togglePlay();
    else if (act === 'prev') prevTrack();
    else if (act === 'next') nextTrack(false);
    else if (act === 'close') closeFloatWidget();
  });
  root.querySelector('#fw-bar')?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!Player.yt || !Player.ready) return;
    const r = e.currentTarget.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    const dur = Player.yt.getDuration() || 0;
    if (dur) Player.yt.seekTo(frac * dur, true);
  });
  root.querySelector('#fw-art')?.addEventListener('dblclick', () => {
    closeNowPlaying();
    openNowPlaying();
  });
  root.querySelector('#fw-lyric')?.addEventListener('click', (e) => {
    e.stopPropagation();
    openNowPlaying();
    switchNPTab('lyrics');
  });
}

function enableDrag(el) {
  if (el._fwDrag) return;
  el._fwDrag = true;
  const saved = store.get('fw_pos', null);
  if (saved && Number.isFinite(saved.l) && Number.isFinite(saved.t)) {
    el.style.left = saved.l + 'px';
    el.style.top = saved.t + 'px';
    el.style.right = 'auto';
    el.style.bottom = 'auto';
  } else {
    el.style.right = '16px';
    el.style.bottom = '24px';
    el.style.left = 'auto';
    el.style.top = 'auto';
  }
  let drag = null;
  const down = (e) => {
    if (e.target.closest('button, .fw-bar')) return;
    const r = el.getBoundingClientRect();
    const pt = e.touches ? e.touches[0] : e;
    drag = { dx: pt.clientX - r.left, dy: pt.clientY - r.top };
    el.classList.add('dragging');
  };
  const move = (e) => {
    if (!drag) return;
    const pt = e.touches ? e.touches[0] : e;
    const x = Math.max(8, Math.min(window.innerWidth - el.offsetWidth - 8, pt.clientX - drag.dx));
    const y = Math.max(8, Math.min(window.innerHeight - el.offsetHeight - 8, pt.clientY - drag.dy));
    el.style.left = x + 'px';
    el.style.top = y + 'px';
    el.style.right = 'auto';
    el.style.bottom = 'auto';
    if (e.cancelable) e.preventDefault();
  };
  const up = () => {
    if (!drag) return;
    drag = null;
    el.classList.remove('dragging');
    const r = el.getBoundingClientRect();
    store.set('fw_pos', { l: r.left, t: r.top });
  };
  el.addEventListener('pointerdown', down);
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  el.addEventListener('touchstart', down, { passive: true });
  window.addEventListener('touchmove', move, { passive: false });
  window.addEventListener('touchend', up);
}

async function openPipWidget() {
  if (!('documentPictureInPicture' in window)) return false;
  try {
    if (Player.pipWin && !Player.pipWin.closed) { Player.pipWin.close(); Player.pipWin = null; }
    const pip = await documentPictureInPicture.requestWindow({ width: 400, height: 120 });
    Player.pipWin = pip;
    pip.document.documentElement.setAttribute('data-theme', currentTheme());
    const st = pip.document.createElement('style');
    st.textContent = FW_CSS;
    pip.document.head.appendChild(st);
    const sprite = document.querySelector('body > svg');
    if (sprite) pip.document.body.appendChild(sprite.cloneNode(true));
    const widget = $('#float-widget').cloneNode(true);
    widget.id = 'float-widget';
    widget.classList.remove('hidden');
    widget.style.cssText = '';
    pip.document.body.appendChild(widget);
    bindFloatWidget(pip.document);
    syncFloatWidget();
    syncFloatLyric(currentLyricText());
    pip.addEventListener('pagehide', () => {
      Player.pipWin = null;
      if (Player.floatOn) {
        $('#float-widget').classList.remove('hidden');
        document.body.classList.add('float-mode');
      }
    });
    return true;
  } catch {
    return false;
  }
}


let pipArtImg = null;
let pipArtSrc = '';
function loadPipArt(url) {
  if (!url || url === pipArtSrc) return;
  pipArtSrc = url;
  const img = new Image();
  img.onload = () => { pipArtImg = img; drawPipFrame(); };
  img.onerror = () => { pipArtImg = null; };
  img.src = '/api/thumb?url=' + encodeURIComponent(url);
}
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
function currentLyricText() {
  const L = Player.lyrics;
  if (!L) return '';
  if (L.lines && L.lines.length) {
    let cur = 0;
    try { cur = (Player.yt && Player.yt.getCurrentTime && Player.yt.getCurrentTime()) || 0; } catch {}
    let idx = -1;
    for (let i = 0; i < L.lines.length; i++) {
      if (cur >= L.lines[i].t - 0.2) idx = i;
      else break;
    }
    return idx >= 0 ? (L.lines[idx].text || '') : '';
  }
  if (L.plain) return String(L.plain).split('\n').map((x) => x.trim()).find(Boolean) || '';
  return '';
}
function wrapCanvasText(ctx, text, maxWidth) {
  const raw = String(text || '').trim() || '♪';
  const words = raw.split(/\s+/);
  const out = [];
  let line = '';
  for (const w of words) {
    const t = line ? `${line} ${w}` : w;
    if (line && ctx.measureText(t).width > maxWidth) {
      out.push(line);
      line = w;
    } else line = t;
  }
  if (line) out.push(line);
  return out.slice(0, 4);
}
function currentLyricIndex() {
  const L = Player.lyrics;
  if (!L || !L.lines || !L.lines.length) return -1;
  let cur = 0;
  try { cur = (Player.yt && Player.yt.getCurrentTime && Player.yt.getCurrentTime()) || 0; } catch {}
  let idx = -1;
  for (let i = 0; i < L.lines.length; i++) {
    if (cur >= L.lines[i].t - 0.2) idx = i;
    else break;
  }
  return idx;
}
function pipLyricLines() {
  const L = Player.lyrics;
  if (L && L.lines && L.lines.length) return L.lines.map((l) => l.text || '♪');
  if (L && L.plain) return String(L.plain).split(/\n/).map((x) => x.trim()).filter(Boolean);
  return [];
}
function drawPipFrame() {
  const canvas = $('#pip-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  const s = Player.current;
  if (s && s.thumbnail) loadPipArt(s.thumbnail);
  ctx.fillStyle = '#070707';
  ctx.fillRect(0, 0, w, h);
  if (pipArtImg) {
    ctx.save();
    ctx.globalAlpha = 0.22;
    const scale = Math.max(w / pipArtImg.width, h / pipArtImg.height);
    const dw = pipArtImg.width * scale, dh = pipArtImg.height * scale;
    ctx.drawImage(pipArtImg, (w - dw) / 2, (h - dh) / 2, dw, dh);
    ctx.restore();
    ctx.fillStyle = 'rgba(0,0,0,0.62)';
    ctx.fillRect(0, 0, w, h);
  }
  const lines = pipLyricLines();
  const maxW = w - 48;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  if (!lines.length) {
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    ctx.font = '700 26px Figtree, Segoe UI, sans-serif';
    ctx.fillText('No lyrics', w / 2, h / 2, maxW);
    return;
  }
  let idx = currentLyricIndex();
  if (idx < 0) {
    try {
      const dur = Player.yt && Player.yt.getDuration && Player.yt.getDuration();
      const cur = Player.yt && Player.yt.getCurrentTime && Player.yt.getCurrentTime();
      idx = dur ? Math.min(lines.length - 1, Math.floor((cur / dur) * lines.length)) : 0;
    } catch { idx = 0; }
  }
  const from = Math.max(0, idx - 3);
  const to = Math.min(lines.length - 1, idx + 5);
  const blocks = [];
  for (let i = from; i <= to; i++) {
    const active = i === idx;
    ctx.font = active ? '800 30px Figtree, Segoe UI, sans-serif' : '600 20px Figtree, Segoe UI, sans-serif';
    const wrapped = wrapCanvasText(ctx, lines[i], maxW);
    const lh = active ? 38 : 28;
    blocks.push({ i, active, wrapped, lh, h: wrapped.length * lh });
  }
  const activeBlock = blocks.find((b) => b.active) || blocks[0];
  let yOff = 0;
  for (const b of blocks) {
    if (b.active) break;
    yOff += b.h + 12;
  }
  let y = h / 2 - yOff - (activeBlock.h / 2);
  for (const b of blocks) {
    ctx.font = b.active ? '800 30px Figtree, Segoe UI, sans-serif' : '600 20px Figtree, Segoe UI, sans-serif';
    ctx.fillStyle = b.active ? '#1ed760' : (b.i < idx ? 'rgba(255,255,255,0.40)' : 'rgba(255,255,255,0.26)');
    let ly = y + b.lh / 2;
    for (const t of b.wrapped) {
      ctx.fillText(t, w / 2, ly, maxW);
      ly += b.lh;
    }
    y += b.h + 12;
  }
}

async function startSystemPip() {
  const video = $('#pip-video');
  const canvas = $('#pip-canvas');
  if (!video || !canvas) return false;
  if (!document.pictureInPictureEnabled && !video.webkitSetPresentationMode) return false;
  try {
    drawPipFrame();
    if (!video.srcObject) video.srcObject = canvas.captureStream(15);
    video.muted = true;
    video.playsInline = true;
    await video.play();
    if (document.pictureInPictureElement) {
      await document.exitPictureInPicture();
    }
    if (video.requestPictureInPicture) {
      await video.requestPictureInPicture();
    } else if (video.webkitSetPresentationMode) {
      video.webkitSetPresentationMode('picture-in-picture');
    } else {
      return false;
    }
    video.onleavepictureinpicture = () => {
      if (Player.floatOn) {
        $('#float-widget').classList.remove('hidden');
        document.body.classList.add('float-mode');
      }
    };
    return true;
  } catch {
    return false;
  }
}

async function openFloatWidget() {
  if (!Player.current) { toast('Play a song first'); return; }
  Player.floatOn = true;
  closeNowPlaying();
  document.body.classList.add('float-mode');
  drawPipFrame();
  const sysOk = await startSystemPip();
  const docOk = sysOk ? false : await openPipWidget();
  const el = $('#float-widget');
  if (sysOk) {
    el.classList.add('hidden');
    toast('Widget di recent apps — buka aplikasi lain, musik tetap jalan');
  } else if (docOk) {
    el.classList.add('hidden');
    toast('Widget floating — stays on top');
  } else {
    el.classList.remove('hidden');
    enableDrag(el);
    bindFloatWidget(document);
    toast('Floating widget — drag to move');
  }
  syncFloatWidget();
}
function closeFloatWidget() {
  Player.floatOn = false;
  document.body.classList.remove('float-mode');
  $('#float-widget').classList.add('hidden');
  if (Player.pipWin && !Player.pipWin.closed) {
    try { Player.pipWin.close(); } catch {}
  }
  Player.pipWin = null;
  if (document.pictureInPictureElement) {
    document.exitPictureInPicture().catch(() => {});
  }
  const video = $('#pip-video');
  if (video && video.webkitSetPresentationMode && video.webkitPresentationMode === 'picture-in-picture') {
    try { video.webkitSetPresentationMode('inline'); } catch {}
  }
  syncFloatWidget();
}
function toggleFloatWidget() {
  if (Player.floatOn) closeFloatWidget();
  else openFloatWidget();
}

/* ---- background playback ----
   Some mobile browsers pause the YouTube iframe when the tab is hidden or the
   screen locks. If the user still wants playback (wantPlay) we resume it.
   A user pause (button, lock-screen pause, sleep timer) clears wantPlay, so we
   never fight the user. Retries are capped so a browser that blocks background
   media doesn't get hammered. */
function tryBackgroundResume() {
  if (!Player.wantPlay || Player.cued || !Player.yt || !Player.ready || !Player.current) return;
  const st = Player.yt.getPlayerState && Player.yt.getPlayerState();
  // PAUSED: only resume a browser-forced pause (see onStateChange).
  // UNSTARTED / CUED: the next track was loaded in the background but the
  // browser didn't let it start — kick it so the queue keeps going.
  const stalledNext = st === YT.PlayerState.UNSTARTED || st === YT.PlayerState.CUED;
  if (!(st === YT.PlayerState.PAUSED && Player.bgForced) && !stalledNext) return;
  if (Player.bgResumeTries >= BG_RESUME_MAX) return;
  Player.bgResumeTries++;
  try { Player.yt.playVideo(); } catch {}
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    Player.hiddenAt = Date.now();
    // going to background: keep lock-screen controls accurate
    updateMediaPosition(true);
    return;
  }
  // back in foreground: reset the retry budget and resume if the browser cut us off
  Player.bgResumeTries = 0;
  tryBackgroundResume();
});
setInterval(() => {
  if (document.hidden) tryBackgroundResume();
}, 1500);


/* cleanup: unregister any previously installed service worker */
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations().then((rs) => rs.forEach((r) => r.unregister())).catch(() => {});
  if (window.caches) caches.keys().then((ks) => ks.forEach((k) => k.startsWith('smw-') && caches.delete(k))).catch(() => {});
}

/* boot */
(() => {
  const splash = $('#splash');
  if (!splash) return;
  const hide = () => {
    if (splash.classList.contains('gone')) return;
    splash.classList.add('gone');
    setTimeout(() => splash.remove(), 700);
  };
  window.addEventListener('load', () => setTimeout(hide, 1500));
  setTimeout(hide, 2800);
})();
renderNav();
renderSideQueue();
updateThemeIcon();
$('#theme-toggle').addEventListener('click', toggleTheme);
$('#tb-search').addEventListener('click', () => go('#/search'));
$('#np-sb').classList.toggle('on', Player.sbEnabled);
updateQualityButton();
syncNpMore();
bindFloatWidget(document);
enableDrag($('#float-widget'));
const savedVol = store.get('vol', 100);
$('#mini-volume').value = savedVol;
$('#np-volume').value = savedVol;
applyVolumeUI(); // reflect saved volume + mute state on the controls at boot
applyKaraoke(); // restore karaoke (big lyrics) preference
document.addEventListener('error', (e) => {
  const el = e.target;
  if (!el || el.tagName !== 'IMG') return;
  if (el.classList.contains('logo-img') || el.closest('#splash')) return;
  if (el.id === 'mini-art' || el.id === 'np-art' || el.id === 'fw-art') {
    if (el.src && !el.src.startsWith('data:')) el.src = COVER_PH;
    return;
  }
  if (el.dataset.fb) return;
  el.dataset.fb = '1';
  const ph = document.createElement('div');
  ph.className = 'art-ph';
  if (el.classList.contains('pl-pick-art')) ph.classList.add('pl-pick-ph');
  if (el.closest('.track')) ph.classList.add('art-ph-track');
  else if (el.closest('.sq-row')) ph.classList.add('art-ph-sq');
  else if (el.closest('.quick-card')) ph.classList.add('art-ph-quick');
  else if (el.closest('.sr-top')) ph.classList.add('art-ph-sr');
  else if (el.closest('.lib-row')) ph.classList.add('art-ph-lib');
  else if (el.closest('.sm-head')) ph.classList.add('art-ph-sm');
  else if (el.closest('.detail-head')) ph.classList.add('detail-ph');
  ph.innerHTML = icon('i-note');
  el.replaceWith(ph);
}, true);
window.addEventListener('pagehide', persistQueue);
document.addEventListener('visibilitychange', () => { if (document.hidden) persistQueue(); });
restoreQueue();
route();
