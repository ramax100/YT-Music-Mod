/* Rich Music - backend proxy for YouTube Music InnerTube API + LRCLIB lyrics */
const express = require('express');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const YTM = 'https://music.youtube.com/youtubei/v1';
const CONTEXT = {
  client: {
    clientName: 'WEB_REMIX',
    clientVersion: '1.20240101.00.00',
    hl: 'id',
    gl: 'ID',
  },
};
const HEADERS = {
  'Content-Type': 'application/json',
  Origin: 'https://music.youtube.com',
  Referer: 'https://music.youtube.com/',
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
};

async function yt(endpoint, body = {}, query = '') {
  const res = await fetch(`${YTM}/${endpoint}?prettyPrint=false${query}`, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify({ context: CONTEXT, ...body }),
  });
  if (!res.ok) throw new Error(`YTM ${endpoint} -> ${res.status}`);
  return res.json();
}

/* ---------------- deep helpers ---------------- */
function findAll(obj, key, out = []) {
  if (!obj || typeof obj !== 'object') return out;
  if (Array.isArray(obj)) {
    for (const v of obj) findAll(v, key, out);
    return out;
  }
  for (const k of Object.keys(obj)) {
    if (k === key) out.push(obj[k]);
    findAll(obj[k], key, out);
  }
  return out;
}
const findFirst = (obj, key) => findAll(obj, key)[0];

const text = (o) =>
  o && o.runs ? o.runs.map((r) => r.text).join('') : (o && o.simpleText) || '';

function normalizeDuration(s) {
  const t = String(s || '').trim();
  if (/^\d{1,2}(\.\d{2}){1,2}$/.test(t)) return t.replace(/\./g, ':');
  return t;
}

function runsInfo(o) {
  // extract artists/albums with browseIds from runs
  const out = [];
  if (!o || !o.runs) return out;
  for (const r of o.runs) {
    const be = r.navigationEndpoint && r.navigationEndpoint.browseEndpoint;
    if (be) out.push({ name: r.text, browseId: be.browseId });
  }
  return out;
}

function thumbs(o) {
  const t = findAll(o, 'thumbnails')
    .flat()
    .filter((x) => x && x.url);
  if (!t.length) return null;
  const best = t.reduce((a, b) => ((b.width || 0) >= (a.width || 0) ? b : a));
  return upscale(best.url);
}
function upscale(url) {
  if (!url) return url;
  if (url.includes('googleusercontent.com')) return url.replace(/=w\d+-h\d+.*$/, '=w544-h544-l90-rj');
  return url;
}

function endpointInfo(nav) {
  if (!nav) return {};
  const we = nav.watchEndpoint;
  const be = nav.browseEndpoint;
  const wpe = nav.watchPlaylistEndpoint;
  if (we) return { videoId: we.videoId, playlistId: we.playlistId };
  if (wpe) return { playlistId: wpe.playlistId, watchPlaylist: true };
  if (be) {
    const id = be.browseId;
    let type = 'browse';
    if (id.startsWith('MPRE')) type = 'album';
    else if (id.startsWith('UC') || id.startsWith('MPLA')) type = 'artist';
    else if (id.startsWith('VL') || id.startsWith('PL') || id.startsWith('RDCLAK')) type = 'playlist';
    return { browseId: id, browseType: type };
  }
  return {};
}

/* ---------------- item parsers ---------------- */
function parseTwoRow(r) {
  const nav = r.navigationEndpoint || {};
  let info = endpointInfo(nav);
  // title may browse to album/playlist even if overlay is a watchEndpoint
  if (!info.browseId && r.title && r.title.runs) {
    const tNav = r.title.runs[0] && r.title.runs[0].navigationEndpoint;
    const extra = endpointInfo(tNav || {});
    if (extra.browseId) info = { ...info, ...extra };
  }
  let type = 'song';
  if (info.browseType === 'album' || info.browseType === 'playlist' || info.browseType === 'artist') type = info.browseType;
  else if (info.videoId) type = 'song';
  else if (info.playlistId || info.watchPlaylist) type = 'playlist';
  const item = {
    type,
    title: text(r.title),
    subtitle: text(r.subtitle),
    thumbnail: thumbs(r.thumbnailRenderer),
    artists: runsInfo(r.subtitle),
    ...info,
  };
  // circle thumbnails => artist
  if (r.thumbnailRenderer && findFirst(r, 'musicThumbnailRenderer')) {
    const style = findFirst(r, 'musicThumbnailRenderer').thumbnailCrop;
    if (style === 'MUSIC_THUMBNAIL_CROP_CIRCLE') item.type = 'artist';
  }
  return item;
}

function parseListItem(r) {
  const cols = (r.flexColumns || []).map((c) =>
    c.musicResponsiveListItemFlexColumnRenderer ? c.musicResponsiveListItemFlexColumnRenderer.text : null
  );
  const title = cols[0] ? text(cols[0]) : '';
  const subtitle = cols
    .slice(1)
    .map((c) => text(c))
    .filter(Boolean)
    .join(' • ');
  let videoId = null;
  if (r.playlistItemData) videoId = r.playlistItemData.videoId;
  if (!videoId && cols[0] && cols[0].runs) {
    const we = cols[0].runs[0] && cols[0].runs[0].navigationEndpoint && cols[0].runs[0].navigationEndpoint.watchEndpoint;
    if (we) videoId = we.videoId;
  }
  if (!videoId) {
    const we = findFirst(r.overlay || {}, 'watchEndpoint');
    if (we) videoId = we.videoId;
  }
  const navInfo = endpointInfo(r.navigationEndpoint);
  const artists = [];
  const albums = [];
  for (const c of cols.slice(1)) {
    for (const e of runsInfo(c)) {
      if (e.browseId.startsWith('MPRE')) albums.push(e);
      else artists.push(e);
    }
  }
  let type = videoId ? 'song' : navInfo.browseType || 'song';
  const item = {
    type,
    title,
    subtitle,
    videoId,
    thumbnail: thumbs(r.thumbnail),
    artists,
    album: albums[0] || null,
    ...navInfo,
  };
  // duration from fixed column
  const fixed = findFirst(r, 'musicResponsiveListItemFixedColumnRenderer');
  if (fixed) item.duration = normalizeDuration(text(fixed.text));
  return item;
}

function parseSections(contents) {
  const sections = [];
  for (const s of contents || []) {
    const car = s.musicCarouselShelfRenderer;
    const shelf = s.musicShelfRenderer;
    if (car) {
      const header = findFirst(car.header || {}, 'title');
      const items = (car.contents || [])
        .map((c) =>
          c.musicTwoRowItemRenderer
            ? parseTwoRow(c.musicTwoRowItemRenderer)
            : c.musicResponsiveListItemRenderer
            ? parseListItem(c.musicResponsiveListItemRenderer)
            : null
        )
        .filter((x) => x && x.title);
      if (items.length) sections.push({ title: text(header), items });
    } else if (shelf) {
      const items = (shelf.contents || [])
        .map((c) => (c.musicResponsiveListItemRenderer ? parseListItem(c.musicResponsiveListItemRenderer) : null))
        .filter((x) => x && x.title);
      if (items.length) sections.push({ title: text(shelf.title), items, list: true });
    }
  }
  return sections;
}

/* ---------------- continuation helpers ----------------
   Works with both the modern InnerTube format (continuationItemRenderer ->
   continuationEndpoint.continuationCommand.token, response carries an
   appendContinuationItemsAction/continuationItems) and the legacy
   nextContinuationData / sectionListContinuation format. */
function continuationCommandToken(item) {
  return item
    && item.continuationEndpoint
    && item.continuationEndpoint.continuationCommand
    && item.continuationEndpoint.continuationCommand.token;
}
function continuationToken(d) {
  // modern: prefer the continuation that belongs to the sectionList (loads the
  // next page of shelves) over one nested inside a single shelf.
  const sl = findFirst(d, 'sectionListRenderer');
  if (sl && Array.isArray(sl.contents)) {
    for (const item of sl.contents) {
      const cir = item && item.continuationItemRenderer;
      const t = continuationCommandToken(cir);
      if (t) return t;
    }
  }
  for (const item of findAll(d, 'continuationItemRenderer')) {
    const t = continuationCommandToken(item);
    if (t) return t;
  }
  // legacy
  const legacy = findFirst(d, 'nextContinuationData');
  if (legacy && legacy.continuation) return legacy.continuation;
  return null;
}
function continuationContents(d) {
  // modern: appendContinuationItemsAction.continuationItems (or any continuationItems)
  const append = findFirst(d, 'appendContinuationItemsAction');
  if (append && Array.isArray(append.continuationItems)) return append.continuationItems;
  // legacy: sectionListContinuation.contents
  const legacy = findFirst(d, 'sectionListContinuation');
  if (legacy && Array.isArray(legacy.contents)) return legacy.contents;
  // fallback: any continuationItems array present
  const anyItems = findFirst(d, 'continuationItems');
  if (Array.isArray(anyItems)) return anyItems;
  return [];
}

/* ---------------- routes ---------------- */
const cache = new Map();
function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < ttlMs) return Promise.resolve(hit.v);
  return fn().then((v) => {
    cache.set(key, { v, t: Date.now() });
    return v;
  });
}

app.get('/api/home', async (req, res) => {
  try {
    const data = await cached('home_ID', 10 * 60 * 1000, async () => {
      let d = await yt('browse', { browseId: 'FEmusic_home' });
      let sections = [];
      let sl = findFirst(d, 'sectionListRenderer');
      if (sl) sections = parseSections(sl.contents);
      // fetch a few continuations for more shelves.
      // The token must be sent in the POST body (`{ continuation: <token> }`),
      // not the query string. Support both the modern InnerTube format
      // (continuationItemRenderer -> continuationEndpoint.continuationCommand.token
      // with an appendContinuationItemsAction response) and the legacy
      // nextContinuationData / sectionListContinuation format.
      let token = continuationToken(d) ||
        (sl && sl.continuations && sl.continuations[0] && sl.continuations[0].nextContinuationData
          && sl.continuations[0].nextContinuationData.continuation);
      let n = 0;
      while (token && n < 3) {
        const d2 = await yt('browse', { continuation: token });
        const added = continuationContents(d2);
        if (!added.length) break;
        sections = sections.concat(parseSections(added));
        token = continuationToken(d2);
        n++;
      }
      return { sections };
    });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/charts', async (req, res) => {
  try {
    const data = await cached('charts', 30 * 60 * 1000, async () => {
      const d = await yt('browse', { browseId: 'FEmusic_charts' });
      const sl = findFirst(d, 'sectionListRenderer');
      return { sections: sl ? parseSections(sl.contents) : [] };
    });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* SponsorBlock segments (skip non-music parts) */
app.get('/api/sponsorblock', async (req, res) => {
  try {
    const vid = String(req.query.videoId || '');
    const cats = encodeURIComponent(JSON.stringify(['sponsor', 'selfpromo', 'interaction', 'intro', 'outro', 'music_offtopic']));
    const r = await fetch(`https://sponsor.ajay.app/api/skipSegments?videoID=${encodeURIComponent(vid)}&categories=${cats}`);
    if (r.status === 404) return res.json({ segments: [] });
    if (!r.ok) return res.json({ segments: [] });
    const arr = await r.json();
    res.json({
      segments: arr
        .filter((s) => s.actionType === 'skip')
        .map((s) => ({ category: s.category, start: s.segment[0], end: s.segment[1] })),
    });
  } catch {
    res.json({ segments: [] });
  }
});

app.get('/api/moods', async (req, res) => {
  try {
    const data = await cached('moods', 60 * 60 * 1000, async () => {
      const d = await yt('browse', { browseId: 'FEmusic_moods_and_genres' });
      const cats = findAll(d, 'musicNavigationButtonRenderer').map((b) => ({
        title: text(b.buttonText),
        color: b.solid ? '#' + (b.solid.leftStripeColor >>> 0).toString(16).padStart(8, '0').slice(2) : null,
        browseId: b.clickCommand && b.clickCommand.browseEndpoint && b.clickCommand.browseEndpoint.browseId,
        params: b.clickCommand && b.clickCommand.browseEndpoint && b.clickCommand.browseEndpoint.params,
      }));
      return { categories: cats.filter((c) => c.browseId) };
    });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const SEARCH_PARAMS = {
  songs: 'EgWKAQIIAWoMEA4QChADEAQQCRAF',
  videos: 'EgWKAQIQAWoMEA4QChADEAQQCRAF',
  albums: 'EgWKAQIYAWoMEA4QChADEAQQCRAF',
  artists: 'EgWKAQIgAWoMEA4QChADEAQQCRAF',
  playlists: 'EgeKAQQoAEABagwQDhAKEAMQBBAJEAU=',
};

app.get('/api/search', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (!q) return res.json({ sections: [] });
    const filter = req.query.filter;
    const body = { query: q };
    if (filter && SEARCH_PARAMS[filter]) body.params = SEARCH_PARAMS[filter];
    const d = await yt('search', body);
    const sections = [];
    const shelves = findAll(d, 'musicShelfRenderer');
    for (const shelf of shelves) {
      const items = (shelf.contents || [])
        .map((c) => (c.musicResponsiveListItemRenderer ? parseListItem(c.musicResponsiveListItemRenderer) : null))
        .filter((x) => x && x.title);
      if (items.length) sections.push({ title: text(shelf.title), items });
    }
    // Newer general-search layout: flat itemSectionRenderers, one item each
    if (!sections.length) {
      const flat = [];
      const seen = new Set();
      for (const sec of findAll(d, 'itemSectionRenderer')) {
        for (const c of sec.contents || []) {
          if (!c.musicResponsiveListItemRenderer) continue;
          const it = parseListItem(c.musicResponsiveListItemRenderer);
          const key = it.videoId || it.browseId || it.title;
          if (it.title && !seen.has(key)) { seen.add(key); flat.push(it); }
        }
      }
      if (flat.length) sections.push({ title: 'Results', items: flat });
    }
    const top = findFirst(d, 'musicCardShelfRenderer');
    if (top) {
      const info = endpointInfo(findFirst(top.title || {}, 'navigationEndpoint') || (top.title.runs && top.title.runs[0].navigationEndpoint));
      sections.unshift({
        title: 'Top result',
        items: [
          {
            type: info.videoId ? 'song' : info.browseType || 'song',
            title: text(top.title),
            subtitle: text(top.subtitle),
            thumbnail: thumbs(top.thumbnail),
            ...info,
          },
        ],
      });
    }
    res.json({ sections });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/suggest', async (req, res) => {
  try {
    const d = await yt('music/get_search_suggestions', { input: req.query.q || '' });
    const sugg = findAll(d, 'searchSuggestionRenderer').map((s) => text(s.suggestion));
    res.json({ suggestions: sugg });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* queue / radio for a song */
app.get('/api/next', async (req, res) => {
  try {
    const body = { isAudioOnly: true, tunerSettingValue: 'AUTOMIX_SETTING_NORMAL' };
    if (req.query.videoId) {
      body.videoId = req.query.videoId;
      body.playlistId = req.query.playlistId || `RDAMVM${req.query.videoId}`;
      body.watchEndpointMusicSupportedConfigs = {
        watchEndpointMusicConfig: { musicVideoType: 'MUSIC_VIDEO_TYPE_ATV' },
      };
    } else if (req.query.playlistId) {
      body.playlistId = req.query.playlistId;
    }
    if (req.query.params) body.params = req.query.params;
    const d = await yt('next', body);
    const panels = findAll(d, 'playlistPanelVideoRenderer');
    const queue = panels.map((p) => ({
      videoId: p.videoId,
      title: displayTitle(text(p.title)),
      artist: text(p.shortBylineText || p.longBylineText),
      artists: runsInfo(p.longBylineText),
      duration: text(p.lengthText),
      thumbnail: thumbs(p.thumbnail),
      selected: !!p.selected,
    }));
    // lyrics + related browse ids from tabs
    let lyricsBrowseId = null;
    let relatedBrowseId = null;
    for (const tab of findAll(d, 'tabRenderer')) {
      const id = tab.endpoint && tab.endpoint.browseEndpoint && tab.endpoint.browseEndpoint.browseId;
      if (!id) continue;
      if (id.startsWith('MPLYt')) lyricsBrowseId = id;
      if (id.startsWith('MPTRt')) relatedBrowseId = id;
    }
    res.json({ queue, lyricsBrowseId, relatedBrowseId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/related', async (req, res) => {
  try {
    const d = await yt('browse', { browseId: req.query.browseId });
    const sl = findFirst(d, 'sectionListRenderer');
    let sections = sl ? parseSections(sl.contents) : [];
    // some related pages use grids instead of carousels/shelves
    for (const g of findAll(d, 'gridRenderer')) {
      const items = (g.items || [])
        .map((c) => {
          if (c.musicTwoRowItemRenderer) return parseTwoRow(c.musicTwoRowItemRenderer);
          if (c.musicResponsiveListItemRenderer) return parseListItem(c.musicResponsiveListItemRenderer);
          return null;
        })
        .filter((x) => x && x.title);
      if (items.length) sections.push({ title: text(findFirst(g.header || {}, 'title') || {}), items });
    }
    // dedupe empty-title dupes & drop empty sections
    sections = sections.filter((x) => x.items && x.items.length);
    res.json({ sections });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* album / playlist / artist / mood pages */
async function browsePage(rawId, params) {
  let id = rawId || '';
  if (/^(PL|RDCLAK|VLPL|OLAK)/.test(id) && !id.startsWith('VL')) id = 'VL' + id;
  const body = { browseId: id };
  if (params) body.params = params;
  const d = await yt('browse', body);

    // header
    let header = null;
    const hResp =
      findFirst(d, 'musicResponsiveHeaderRenderer') ||
      findFirst(d, 'musicDetailHeaderRenderer') ||
      findFirst(d, 'musicImmersiveHeaderRenderer') ||
      findFirst(d, 'musicVisualHeaderRenderer') ||
      findFirst(d, 'musicEditablePlaylistDetailHeaderRenderer');
    if (hResp) {
      header = {
        title: text(hResp.title),
        subtitle: [text(hResp.subtitle), text(hResp.secondSubtitle)].filter(Boolean).join(' • '),
        description: text(hResp.description) || text(findFirst(hResp, 'description') || {}),
        thumbnail: thumbs(hResp.thumbnail || hResp.foregroundThumbnail || {}),
        artists: runsInfo(hResp.subtitle).concat(runsInfo(hResp.straplineTextOne)),
        strapline: text(hResp.straplineTextOne),
      };
      if (!header.thumbnail) header.thumbnail = thumbs(hResp);
    }

    // shuffle/radio playlist ids
    let playlistId = null;
    const wpe = findFirst(d, 'watchPlaylistEndpoint');
    if (wpe) playlistId = wpe.playlistId;

    // track list (musicShelfRenderer or playlistShelfRenderer contents)
    let tracks = [];
    const shelves = findAll(d, 'musicShelfRenderer').concat(findAll(d, 'musicPlaylistShelfRenderer'));
    for (const shelf of shelves) {
      const items = (shelf.contents || [])
        .map((c) => (c.musicResponsiveListItemRenderer ? parseListItem(c.musicResponsiveListItemRenderer) : null))
        .filter((x) => x && x.title);
      if (items.length && items.filter((i) => i.videoId).length >= items.length / 2 && !tracks.length) {
        tracks = items;
      }
    }

    // other sections (carousels: related albums, artist albums etc.)
    let sections = [];
    const sl = findFirst(d, 'sectionListRenderer');
    if (sl) sections = parseSections(sl.contents).filter((s) => !s.list || !tracks.length);
    // for artist pages the first musicShelf (songs) is in sections too; dedupe
    if (tracks.length) sections = sections.filter((s) => !(s.list && s.items[0] && s.items[0].videoId === tracks[0].videoId));

    // grid (mood/genre pages)
    const grids = findAll(d, 'gridRenderer');
    for (const g of grids) {
      const items = (g.items || [])
        .map((c) => (c.musicTwoRowItemRenderer ? parseTwoRow(c.musicTwoRowItemRenderer) : null))
        .filter(Boolean);
      if (items.length) sections.push({ title: text(findFirst(g.header || {}, 'title') || {}), items });
    }

    // fallback thumbnail from first track
    if (header && !header.thumbnail && tracks[0]) header.thumbnail = tracks[0].thumbnail;
    // album pages often omit per-track artist; copy from header
    if (header && tracks.length) {
      const ha = (header.artists && header.artists[0]) || (header.strapline ? { name: header.strapline } : null);
      if (ha && ha.name) {
        tracks = tracks.map((t) => {
          if (t.artist || (t.artists && t.artists.length)) return t;
          return { ...t, artist: ha.name, artists: t.artists && t.artists.length ? t.artists : [ha], artistBrowseId: ha.browseId || t.artistBrowseId };
        });
      }
    }

  return { header, tracks, sections, playlistId };
}

app.get('/api/browse', async (req, res) => {
  try {
    res.json(await browsePage(req.query.id, req.query.params));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ---------------- music download via third-party converter (loader.to) ----------------
   Highest quality MP3 (320kbps). Our server orchestrates the conversion job:
   start -> poll progress -> hand the final direct file URL to the browser.
   The user never sees or visits the third-party site — the file just downloads. */
const LOADER_API = 'https://loader.to/ajax/download.php';
const DL_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

/* start a conversion job: returns { jobId, progressUrl } */
app.get('/api/download-start', async (req, res) => {
  const videoId = String(req.query.videoId || '');
  if (!/^[\w-]{6,20}$/.test(videoId)) return res.status(400).json({ error: 'bad id' });
  try {
    const u = `${LOADER_API}?format=mp3&url=${encodeURIComponent('https://www.youtube.com/watch?v=' + videoId)}`;
    const r = await fetch(u, { headers: { 'User-Agent': DL_UA, Referer: 'https://loader.to/' } });
    if (!r.ok) throw new Error(`start -> ${r.status}`);
    const d = await r.json();
    if (!d.success || !d.id) throw new Error('converter refused this song');
    res.json({ jobId: d.id, progressUrl: d.progress_url, title: d.title || null });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

/* poll job progress: returns { progress (0-1000), done, url } */
app.get('/api/download-progress', async (req, res) => {
  const purl = String(req.query.progressUrl || '');
  try {
    const pu = new URL(purl);
    // Only poll over HTTPS and only on the converter's known domain family.
    // loader.to rotates the progress host (e.g. p.savenow.to, *.oceansaver.in),
    // so we allow-list the whole family rather than a single host — but keep it
    // a strict allow-list to avoid turning this into an open SSRF proxy.
    const PROGRESS_HOSTS = ['loader.to', 'savenow.to', 'affadaffa.com', 'oceansaver.in'];
    const host = pu.hostname;
    const okHost = pu.protocol === 'https:'
      && PROGRESS_HOSTS.some((h) => host === h || host.endsWith('.' + h));
    if (!okHost) {
      return res.status(400).json({ error: 'bad progress url' });
    }
    const r = await fetch(purl, { headers: { 'User-Agent': DL_UA } });
    if (!r.ok) throw new Error(`progress -> ${r.status}`);
    const d = await r.json();
    res.json({
      progress: d.progress || 0,
      done: !!d.success && !!d.download_url,
      url: d.download_url || null,
      text: d.text || '',
    });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

/* resolve a YT Music / YouTube URL (playlist, album, artist, song) into an app route */
app.get('/api/resolve', async (req, res) => {
  try {
    const raw = String(req.query.url || '').trim();
    let u;
    try { u = new URL(raw.includes('://') ? raw : 'https://' + raw); } catch { return res.status(400).json({ error: 'Invalid URL' }); }
    const list = u.searchParams.get('list');
    const v = u.searchParams.get('v');
    const m = u.pathname.match(/\/(playlist|channel|browse|watch)\/?([^/]*)?/);
    if (list && !v) return res.json({ kind: 'playlist', id: list });
    if (v) return res.json({ kind: 'song', videoId: v, playlistId: list || null });
    if (m && m[1] === 'channel' && m[2]) return res.json({ kind: 'artist', id: m[2] });
    if (m && m[1] === 'browse' && m[2]) return res.json({ kind: m[2].startsWith('MPRE') ? 'album' : 'playlist', id: m[2] });
    return res.status(400).json({ error: 'Could not recognize this link. Paste a YouTube Music playlist/album/song link.' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ---------------- lyrics: multi-strategy matcher ----------------
   LRCLIB (synced) -> LRCLIB fuzzy -> YouTube Music (plain)
   -> NetEase (synced/plain) -> lyrics.ovh (plain). */

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
function cleanTitle(t) {
  return String(t || '')
    .replace(/\((feat|ft|with|prod)[^)]*\)/gi, '')
    .replace(/\[(feat|ft|with|prod)[^\]]*\]/gi, '')
    .replace(/\((official|lyric|lyrics|audio|video|visualizer|music video|mv|hd|4k|remaster(ed)?( \d{4})?|live|acoustic|explicit|clean)[^)]*\)/gi, '')
    .replace(/\[[^\]]*(official|lyric|audio|video|remaster|visualizer|live|mv)[^\]]*\]/gi, '')
    .replace(/[\(\[]\s*(4k|hd|hq|8d( audio)?|1080p|720p)\s*[\)\]]/gi, '')
    .replace(/\s*-\s*(official|lyric|lyrics|audio|video|visualizer|topic).*/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}
function primaryArtist(a) {
  return String(a || '')
    .split(/\s*[,&•·]\s*|\s+(?:feat\.?|ft\.?|with|x|vs\.?)\s+/i)[0]
    .replace(/\s*-\s*topic$/i, '')
    .trim();
}
function norm(x) {
  return String(x || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]+/g, ' ').trim();
}
function simScore(a, b) {
  a = norm(a); b = norm(b);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.85;
  const aw = new Set(a.split(' ')), bw = new Set(b.split(' '));
  let hit = 0;
  for (const w of aw) if (bw.has(w)) hit++;
  return hit / Math.max(aw.size, bw.size);
}
async function fetchTimeout(url, opts = {}, ms = 4500) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ac.signal });
  } finally { clearTimeout(t); }
}

async function lyricsOvh(title, artist) {
  if (!title || !artist) return null;
  try {
    const r = await fetchTimeout(`https://api.lyrics.ovh/v1/${encodeURIComponent(artist)}/${encodeURIComponent(title)}`);
    if (!r.ok) return null;
    const j = await r.json();
    const lyr = String(j.lyrics || '').replace(/\r\n/g, '\n').trim();
    return lyr.length > 24 ? lyr : null;
  } catch { return null; }
}

async function neteaseLyrics(title, artist) {
  try {
    const q = `${title} ${artist}`.trim();
    if (!q) return null;
    const r = await fetchTimeout(
      `https://music.163.com/api/search/get/web?s=${encodeURIComponent(q)}&type=1&limit=8`,
      { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://music.163.com/' } }
    );
    if (!r.ok) return null;
    const j = await r.json();
    const songs = (((j.result || {}).songs) || []);
    let best = null, bestScore = 0;
    for (const song of songs) {
      const an = (song.artists || []).map((a) => a.name).join(' ');
      const score = simScore(song.name, title) * 2 + simScore(an, artist);
      if (score > bestScore) { bestScore = score; best = song; }
    }
    if (!best || bestScore < 1.4) return null;
    const lr = await fetchTimeout(
      `https://music.163.com/api/song/lyric?id=${best.id}&lv=1&kv=1&tv=-1`,
      { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://music.163.com/' } }
    );
    if (!lr.ok) return null;
    const L = await lr.json();
    const synced = (L.lrc && L.lrc.lyric) || '';
    const hasTime = /\[[0-9]+:[0-9]/.test(synced);
    if (hasTime && synced.length > 40) {
      const plain = synced.replace(/\[[^\]]+\]/g, '').replace(/\n{3,}/g, '\n\n').trim();
      return { synced, plain: plain || null };
    }
    const plain = synced.replace(/\[[^\]]+\]/g, '').trim();
    if (plain.length > 24) return { synced: null, plain };
    return null;
  } catch { return null; }
}

async function lrclibGet(title, artist, duration) {
  try {
    const u = `https://lrclib.net/api/get?track_name=${encodeURIComponent(title)}&artist_name=${encodeURIComponent(artist)}${duration ? `&duration=${Math.round(duration)}` : ''}`;
    const r = await fetchTimeout(u, { headers: { 'User-Agent': 'RichMusic/1.0' } }, 4000);
    if (!r.ok) return null;
    const j = await r.json();
    if (j.instrumental) return null;
    return (j.syncedLyrics || j.plainLyrics) ? j : null;
  } catch { return null; }
}
async function lrclibSearch(params) {
  try {
    const qs = new URLSearchParams(params).toString();
    const r = await fetchTimeout(`https://lrclib.net/api/search?${qs}`, { headers: { 'User-Agent': 'RichMusic/1.0' } }, 4000);
    if (!r.ok) return [];
    return await r.json();
  } catch { return []; }
}
function pickBest(cands, title, artist, duration) {
  const dur = Number(duration) || 0;
  let best = null, bestScore = 0;
  for (const c of cands) {
    if (!c || c.instrumental || (!c.syncedLyrics && !c.plainLyrics)) continue;
    const tScore = simScore(c.trackName || c.name, title);
    let score = tScore * 2 + simScore(c.artistName, artist);
    if (dur && c.duration) {
      const diff = Math.abs(c.duration - dur);
      if (diff <= 2) score += 1.2;
      else if (diff <= 5) score += 0.6;
      else if (diff > 20) score -= 1;
    }
    if (c.syncedLyrics) score += 0.8;
    if (score > bestScore) { bestScore = score; best = c; }
  }
  if (!best) return null;
  if (bestScore >= 1.4) return best;
  if (simScore(best.trackName || best.name, title) >= 0.85 && bestScore >= 0.95) return best;
  return null;
}

async function textylLyrics(title, artist) {
  const q = `${artist || ''} ${title || ''}`.trim();
  if (!q) return null;
  try {
    const r = await fetchTimeout(`https://api.textyl.co/api/lyrics?q=${encodeURIComponent(q)}`);
    if (!r.ok) return null;
    const arr = await r.json();
    if (!Array.isArray(arr) || arr.length < 4) return null;
    const synced = arr.map((x) => {
      const sec = Number(x.seconds) || 0;
      const m = Math.floor(sec / 60);
      const s = (sec % 60).toFixed(2).padStart(5, '0');
      return `[${m}:${s}]${x.lyrics || ''}`;
    }).join('\n');
    return synced.length > 40 ? synced : null;
  } catch { return null; }
}

function extractYtmLyrics(d) {
  for (const shelf of findAll(d, 'musicDescriptionShelfRenderer')) {
    const lyr = text(shelf.description);
    if (lyr && lyr.length > 20) return lyr;
  }
  for (const block of findAll(d, 'formattedDescription')) {
    const lyr = text(block);
    if (lyr && lyr.length > 40 && lyr.split('\n').length > 4) return lyr;
  }
  return null;
}

app.get('/api/lyrics', async (req, res) => {
  const { title = '', artist = '', duration = 0, browseId = '' } = req.query;
  try {
    const ct = cleanTitle(title);
    const pa = primaryArtist(artist);
    let tUse = ct || title;
    let aUse = pa || artist;
    const dash = String(tUse).match(/^(.{2,48}?)\s*[-–—]\s+(.+)$/);
    if (dash && (!aUse || simScore(dash[1], aUse) >= 0.45)) {
      aUse = aUse || dash[1];
      tUse = dash[2];
    }

    let synced = null, plain = null, source = null;

    // 1) YouTube Music lyrics for this exact video (plain, but correct)
    if (browseId) {
      try {
        const body = {
          context: { client: { ...CONTEXT.client, hl: 'id', gl: 'ID' } },
          browseId,
        };
        const r = await fetchTimeout(`${YTM}/browse?prettyPrint=false`, {
          method: 'POST',
          headers: HEADERS,
          body: JSON.stringify(body),
        }, 4500);
        if (r.ok) {
          const d = await r.json();
          const lyr = extractYtmLyrics(d);
          if (lyr) { plain = lyr; source = 'YouTube Music'; }
        }
      } catch {}
    }

    // 2) LRCLIB exact (synced preferred) — parallel
    const exactHits = await Promise.all([
      lrclibGet(tUse, aUse, duration),
      lrclibGet(tUse, aUse, 0),
      title && title !== tUse ? lrclibGet(cleanTitle(title), pa, 0) : null,
    ]);
    for (const hit of exactHits) {
      if (!hit) continue;
      synced = synced || hit.syncedLyrics || null;
      plain = plain || hit.plainLyrics || null;
      source = synced ? 'LRCLIB' : (source || 'LRCLIB');
      if (synced) break;
    }

    // 3) Fuzzy LRCLIB + other catalogs in parallel when still no synced
    if (!synced) {
      const [s1, s2, s3, ne, ovh, tx] = await Promise.all([
        lrclibSearch({ track_name: tUse, artist_name: aUse }),
        lrclibSearch({ q: `${tUse} ${aUse}`.trim() }),
        lrclibSearch({ track_name: tUse }),
        neteaseLyrics(tUse, aUse),
        plain ? null : lyricsOvh(tUse, aUse),
        textylLyrics(tUse, aUse),
      ]);
      const best = pickBest([].concat(s1 || [], s2 || [], s3 || []), tUse, aUse, duration);
      if (best) {
        synced = best.syncedLyrics || synced;
        plain = plain || best.plainLyrics;
        source = best.syncedLyrics ? 'LRCLIB' : (source || 'LRCLIB');
      }
      if (!synced && ne && ne.synced) {
        synced = ne.synced;
        plain = plain || ne.plain;
        source = 'NetEase';
      } else if (!plain && ne && ne.plain) {
        plain = ne.plain;
        source = source || 'NetEase';
      }
      if (!synced && tx) {
        synced = tx;
        source = 'Textyl';
      }
      if (!synced && !plain && ovh) {
        plain = ovh;
        source = 'lyrics.ovh';
      }
    }

    res.json({ synced: synced || null, plain: plain || null, source });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


/* album-art proxy so the PiP canvas is not CORS-tainted */
app.get('/api/thumb', async (req, res) => {
  try {
    const raw = String(req.query.url || '');
    const u = new URL(raw);
    const host = u.hostname;
    const ok =
      host.endsWith('ytimg.com') ||
      host.endsWith('ggpht.com') ||
      host.endsWith('googleusercontent.com');
    if (!ok) return res.status(400).end();
    const r = await fetch(raw, {
      headers: { 'User-Agent': 'Mozilla/5.0 RichMusicThumb/1.0', Accept: 'image/*' },
    });
    if (!r.ok) return res.status(502).end();
    res.setHeader('Content-Type', r.headers.get('content-type') || 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(Buffer.from(await r.arrayBuffer()));
  } catch {
    res.status(500).end();
  }
});

app.use((req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT, '0.0.0.0', () => console.log(`Rich Music running on :${PORT}`));
}
module.exports = app;
