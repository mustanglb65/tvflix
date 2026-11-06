/* TVFlix - written in plain ES5 so it runs on Tizen 3.0 (2017 Samsung TVs). */
(function () {
  var ARCHIVE = 'https://archive.org';
  var ROW_HEIGHT = 420;
  var CARD_STEP = 254; /* card width + margin */

  var rows = [];
  var focus = { r: 0, c: 0 };
  var view = 'home';
  var current = null;
  var msgTimer = null;

  var $ = function (id) { return document.getElementById(id); };
  var rowsInner = $('rows-inner');
  var vidcoreFrame = $('vidcore-frame');

  function get(url, cb) {
    var x = new XMLHttpRequest();
    x.open('GET', url, true);
    x.onreadystatechange = function () {
      if (x.readyState !== 4) { return; }
      if (x.status === 200 || (x.status === 0 && x.responseText)) {
        try { cb(null, JSON.parse(x.responseText)); } catch (e) { cb(e); }
      } else { cb(new Error('HTTP ' + x.status)); }
    };
    x.send();
  }

  function clean(s) {
    if (!s) { return ''; }
    if (s instanceof Array) { s = s.join(' '); }
    return String(s).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function setStatus(t) { $('status').textContent = t || ''; }

  var TMDB_KEY = (window.TVFLIX_CONFIG || {}).tmdbKey;
  var COUNTRY = (window.TVFLIX_CONFIG || {}).country || 'US';
  var TMDB_API = 'https://api.themoviedb.org/3';
  var TMDB_IMG = 'https://image.tmdb.org/t/p/w342';
  var TMDB_LOGO = 'https://image.tmdb.org/t/p/w92';

  function norm(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }

  function enrichOne(item, cb) {
    var year = item.year || (item.title.match(/\b(18|19|20)\d\d\b/) || [])[0];
    var name = item.title.replace(/\(.*?\)|\[.*?\]/g, ' ').replace(/\b(18|19|20)\d\d\b/g, ' ')
      .replace(/full movie|full film|hd|remastered|restored/ig, ' ').replace(/[_\-:]+/g, ' ')
      .replace(/\s+/g, ' ').trim();
    if (!name) { cb(); return; }
    var url = 'https://api.themoviedb.org/3/search/movie?api_key=' + TMDB_KEY +
      '&query=' + encodeURIComponent(name) + (year ? '&year=' + year : '');
    get(url, function (err, data) {
      var hit = null;
      if (!err && data && data.results) {
        for (var i = 0; i < data.results.length; i++) {
          var a = norm(data.results[i].title), b = norm(name);
          var sameName = a && (a === b || (a.length > 5 && b.indexOf(a) === 0) || (b.length > 5 && a.indexOf(b) === 0));
          var ry = parseInt((data.results[i].release_date || '').substring(0, 4), 10);
          var sameYear = !year || !ry || Math.abs(ry - parseInt(year, 10)) <= 1;
          if (sameName && sameYear) { hit = data.results[i]; break; }
        }
      }
      if (hit) {
        if (hit.poster_path) { item.poster = 'https://image.tmdb.org/t/p/w342' + hit.poster_path; }
        if (hit.overview) { item.description = hit.overview; }
        var bits = [];
        if (hit.release_date) { bits.push(hit.release_date.substring(0, 4)); }
        if (hit.vote_average) { bits.push('★ ' + hit.vote_average.toFixed(1)); }
        item.meta = bits.join('  ·  ');
      }
      cb();
    });
  }

  function enrich(items, done) {
    if (!TMDB_KEY || !items.length) { done(items); return; }
    var next = 0, finished = 0, WORKERS = 4;
    function work() {
      if (next >= items.length) { return; }
      var it = items[next++];
      enrichOne(it, function () {
        finished++;
        if (finished === items.length) { done(items); } else { work(); }
      });
    }
    for (var w = 0; w < WORKERS && w < items.length; w++) { work(); }
  }

  function loadCatalog() {
    setStatus('Loading...');
    get('catalog.json', function (err, cat) {
      if (err) { setStatus('Could not read catalog.json'); return; }
      var pending = cat.rows.length;
      var results = new Array(cat.rows.length);
      var shown = false, timer = null;

      /* Build the row list from whatever has arrived so far, in catalog order. */
      var assemble = function () {
        var list = [], seenArchive = {};
        for (var i = 0; i < results.length; i++) {
          if (!results[i]) { continue; }
          /* Internet Archive rows overlap a lot: show each film only once, in the first row it appears. */
          var items = results[i].items.filter(function (it) {
            if (!it.archive) { return true; }
            var keys = [it.id, 't:' + norm(it.title)];
            if (seenArchive[keys[0]] || seenArchive[keys[1]]) { return false; }
            seenArchive[keys[0]] = seenArchive[keys[1]] = true;
            return true;
          });
          if (items.length) { list.push({ title: results[i].title, items: items }); }
        }
        return withContinue(list);
      };

      var show = function () {
        timer = null;
        var list = assemble();
        if (homeRows) { homeRows = list; return; } /* user is looking at search results */
        rows = list;
        if (!list.length) {
          if (pending <= 0) { setStatus('Nothing to show - check your internet connection'); }
          return;
        }
        setStatus(pending > 0 ? 'Loading more...' : '');
        render(shown);
        shown = true;
      };

      /* Show rows as soon as they arrive instead of waiting for the slowest one. */
      var done = function () {
        pending--;
        if (pending <= 0) { clearTimeout(timer); show(); }
        else if (!shown) { show(); }
        else if (!timer) { timer = setTimeout(show, 600); }
      };
      cat.rows.forEach(function (row, i) {
        if (row.source === 'archive') {
          var q = '/advancedsearch.php?q=' + encodeURIComponent(row.query) +
            '&fl[]=identifier&fl[]=title&fl[]=description&fl[]=year&rows=' + (row.limit || 25) +
            '&sort[]=downloads+desc&output=json';
          get(ARCHIVE + q, function (e, data) {
            if (e || !data || !data.response) { done(); return; }
            var hide = new RegExp('\\b(' + (cat.hide || []).join('|') + ')', 'i');
            var list = data.response.docs.map(function (d) {
              return {
                id: d.identifier,
                archive: true,
                title: clean(d.title),
                description: clean(d.description),
                year: d.year ? String(d.year).substring(0, 4) : '',
                poster: ARCHIVE + '/services/img/' + d.identifier
              };
            }).filter(function (it) {
              return !cat.hide || !cat.hide.length || !hide.test(it.title + ' ' + it.description);
            });
            /* No per-film TMDB lookups here (hundreds of requests choke a slow TV connection):
               a film is looked up once, when you open it. */
            results[i] = { title: row.title, items: list };
            done();
          });
        } else if (row.source === 'tmdb') {
          if (!TMDB_KEY) { done(); return; }
          var kind = row.type === 'tv' ? 'tv' : 'movie';
          var turl = TMDB_API + row.path + (row.path.indexOf('?') > -1 ? '&' : '?') +
            'api_key=' + TMDB_KEY + '&language=en-US&include_adult=false';
          get(turl, function (e, data) {
            if (e || !data || !data.results) { done(); return; }
            var hideT = (cat.hide && cat.hide.length) ? new RegExp('\\b(' + cat.hide.join('|') + ')', 'i') : null;
            var list = data.results.filter(function (m) { return m.poster_path && !m.adult; }).map(function (m) {
              var date = m.release_date || m.first_air_date || '';
              var bits = [];
              if (date) { bits.push(date.substring(0, 4)); }
              if (m.vote_average) { bits.push('★ ' + m.vote_average.toFixed(1)); }
              bits.push(kind === 'tv' ? 'TV Series' : 'Film');
              return {
                tmdbId: m.id, kind: kind, title: m.title || m.name, year: date.substring(0, 4),
                description: m.overview, poster: TMDB_IMG + m.poster_path, meta: bits.join('  ·  ')
              };
            }).filter(function (it) { return !hideT || !hideT.test(it.title + ' ' + it.description); });
            results[i] = { title: row.title, items: list };
            done();
          });
        } else {
          var items = (row.items || []).filter(function (it) {
            it.eps = localEps(it);
            return it.eps.length > 0;
          });
          items.forEach(function (it) {
            for (var q = 0; q < libraryItems.length; q++) { if (itemKey(libraryItems[q]) === itemKey(it)) { return; } }
            libraryItems.push(it);
          });
          enrich(items.filter(function (it) { return !it.poster; }), function () {
            results[i] = { title: row.title, items: items };
            done();
          });
        }
      });
    });
  }

  function render(keepFocus) {
    rowsInner.innerHTML = '';
    lastFocusEl = null;
    rows.forEach(function (row, r) {
      var rowEl = document.createElement('div');
      rowEl.className = 'row';
      var t = document.createElement('div');
      t.className = 'row-title';
      t.textContent = row.title;
      var wrap = document.createElement('div');
      wrap.className = 'track-wrap';
      var track = document.createElement('div');
      track.className = 'track';
      row.items.forEach(function (it, c) {
        var card = document.createElement('div');
        card.className = 'card';
        /* posters load lazily (only for cards near the screen) - see updateFocus */
        if (it.poster) { card.setAttribute('data-poster', it.poster); }
        var cap = document.createElement('div');
        cap.className = 'cap';
        cap.textContent = it.title;
        card.appendChild(cap);
        
        var badge = document.createElement('div');
        badge.className = 'badge';
        badge.textContent = it.contLabel || '▶ STREAM';
        card.appendChild(badge);

        /* mouse: click a card to open it */
        card.onclick = function () { focus.r = r; focus.c = c; updateFocus(); openDetail(); };
        track.appendChild(card);
      });
      wrap.appendChild(track);
      /* mouse: arrows to scroll a row sideways (only shown when a mouse is being used) */
      [['left', -5, '‹'], ['right', 5, '›']].forEach(function (a) {
        var ar = document.createElement('div');
        ar.className = 'arrow ' + a[0];
        ar.textContent = a[2];
        ar.onclick = function () {
          var cur = (focus.r === r) ? focus.c : 0;
          focus.r = r;
          focus.c = Math.max(0, Math.min(row.items.length - 1, cur + a[1]));
          updateFocus();
        };
        wrap.appendChild(ar);
      });
      rowEl.appendChild(t);
      rowEl.appendChild(wrap);
      rowsInner.appendChild(rowEl);
    });
    $('homeback').className = 'sbtn mouseonly' + (homeRows ? '' : ' hidden');
    if (keepFocus) {
      /* rows were added while browsing: stay where the user is */
      focus.r = Math.min(focus.r, rows.length - 1);
      if (focus.r >= 0) { focus.c = Math.min(focus.c, rows[focus.r].items.length - 1); }
    } else {
      focus = { r: 0, c: 0 };
    }
    updateFocus();
  }

  var homeRows = null; /* the normal catalog, saved while search results are shown */

  function openSearch() {
    var inp = $('search-input');
    inp.value = '';
    searchCancelled = false;
    $('search').className = '';
    view = 'search';
    setTimeout(function () { inp.focus(); }, 50);
  }

  var searchCancelled = false;

  /* Samsung's on-screen keyboard: "Done" = 65376, "Cancel" = 65385 (it does not send Enter). */
  (function () {
    var inp = $('search-input');
    var go = function (e) {
      if (view !== 'search') { return; }
      var k = e.keyCode;
      if (k === 13 || k === 65376) {
        e.stopPropagation(); e.preventDefault();
        doSearch(inp.value);
      }
    };
    inp.addEventListener('keydown', go);
    inp.addEventListener('keyup', go);
    /* fires when the keyboard closes after typing, whichever key closed it */
    inp.addEventListener('change', function () {
      if (view === 'search' && !searchCancelled && inp.value.replace(/\s/g, '')) { doSearch(inp.value); }
    });
  })();

  function closeSearch() {
    searchCancelled = true;
    $('search-input').blur();
    $('search').className = 'hidden';
    view = 'home';
  }

  function leaveResults() {
    if (!homeRows) { return false; }
    rows = withContinue(homeRows);
    homeRows = null;
    setStatus('');
    render();
    return true;
  }

  function doSearch(raw) {
    var q = String(raw || '').replace(/[^\w\s'&\-]/g, ' ').replace(/\s+/g, ' ').trim();
    closeSearch();
    if (!q) { return; }
    setStatus('Searching...');
    var out = [null, null], pending = 2;
    var hideRe = null;
    var finish = function () {
      if (--pending > 0) { return; }
      var found = [];
      if (out[0] && out[0].length) { found.push({ title: 'Results for "' + q + '"', items: out[0] }); }
      if (out[1] && out[1].length) { found.push({ title: 'Free to Watch: "' + q + '"', items: out[1] }); }
      if (!found.length) { setStatus('No results for "' + q + '"'); return; }
      if (!homeRows) { homeRows = rows; }
      rows = found;
      setStatus('Search: ' + q + '  (Back to return)');
      render();
    };
    get('catalog.json', function (e0, cat) {
      var hide = (!e0 && cat && cat.hide) || [];
      if (hide.length) { hideRe = new RegExp('\\b(' + hide.join('|') + ')', 'i'); }
      var bad = function (it) { return hideRe && hideRe.test(it.title + ' ' + (it.description || '')); };

      if (!TMDB_KEY) { out[0] = []; finish(); } else {
        get(TMDB_API + '/search/multi?api_key=' + TMDB_KEY + '&include_adult=false&language=en-US&query=' +
          encodeURIComponent(q), function (e, data) {
          var list = [];
          if (!e && data && data.results) {
            data.results.forEach(function (m) {
              if ((m.media_type !== 'movie' && m.media_type !== 'tv') || !m.poster_path) { return; }
              var kind = m.media_type;
              var date = m.release_date || m.first_air_date || '';
              var bits = [];
              if (date) { bits.push(date.substring(0, 4)); }
              if (m.vote_average) { bits.push('★ ' + m.vote_average.toFixed(1)); }
              bits.push(kind === 'tv' ? 'TV Series' : 'Film');
              var it = { tmdbId: m.id, kind: kind, title: m.title || m.name, year: date.substring(0, 4),
                description: m.overview, poster: TMDB_IMG + m.poster_path, meta: bits.join('  ·  ') };
              if (!bad(it)) { list.push(it); }
            });
          }
          out[0] = list;
          finish();
        });
      }

      var aq = '/advancedsearch.php?q=' + encodeURIComponent('title:(' + q + ') AND mediatype:movies AND ' +
        '(collection:feature_films OR collection:Film_Noir OR collection:SciFi_Horror OR collection:classic_tv OR ' +
        'collection:animationandcartoons OR collection:silent_films)') +
        '&fl[]=identifier&fl[]=title&fl[]=description&fl[]=year&rows=30&sort[]=downloads+desc&output=json';
      get(ARCHIVE + aq, function (e, data) {
        var list = [], seen = {};
        if (!e && data && data.response) {
          data.response.docs.forEach(function (d) {
            var it = { id: d.identifier, archive: true, title: clean(d.title), description: clean(d.description),
              year: d.year ? String(d.year).substring(0, 4) : '', poster: ARCHIVE + '/services/img/' + d.identifier };
            var k = norm(it.title);
            if (seen[k] || bad(it)) { return; }
            seen[k] = true;
            list.push(it);
          });
        }
        out[1] = list;
        finish();
      });
    });
  }

  var lastFocusEl = null;

  function updateFocus() {
    $('searchbtn').className = 'sbtn' + (focus.r === -1 ? ' focus' : '');
    var rowEls = rowsInner.children;
    for (var r = 0; r < rowEls.length; r++) {
      var track = rowEls[r].querySelector('.track');
      var cards = track.children;
      var c = (r === focus.r) ? focus.c : 0;
      var off = Math.max(0, c - 3) * CARD_STEP;
      if (track._off !== off) {
        track._off = off;
        track.style.webkitTransform = track.style.transform = 'translateX(-' + off + 'px)';
      }
      /* load posters only for rows near the screen and cards near the visible part of the row */
      if (Math.abs(r - Math.max(focus.r, 0)) <= 1) {
        for (var k = Math.max(0, c - 1); k < Math.min(cards.length, c + 8); k++) {
          var cd = cards[k];
          if (!cd._loaded) {
            cd._loaded = true;
            var pu = cd.getAttribute('data-poster');
            if (pu) { cd.style.backgroundImage = 'url(' + pu + ')'; }
          }
        }
      }
    }
    /* only touch the previously and newly focused cards (not every card) */
    if (lastFocusEl) { lastFocusEl.className = 'card'; lastFocusEl = null; }
    if (focus.r >= 0 && rowEls[focus.r]) {
      var fc = rowEls[focus.r].querySelector('.track').children[focus.c];
      if (fc) { fc.className = 'card focus'; lastFocusEl = fc; }
    }
    var vOff = Math.max(0, focus.r - 1) * ROW_HEIGHT;
    rowsInner.style.webkitTransform = rowsInner.style.transform = 'translateY(-' + vOff + 'px)';
  }

  var detailBtn = 0;
  var detailZone = 0;   /* 0 = Play/Trailer buttons, 1 = season row, 2 = episode list */
  var detailSeason = 1, epIdx = 0, epTop = 0;
  var playing = null;   /* { item, ep } while a video is playing */
  var lastSave = 0;

  /* ---- watched / resume progress (kept on this device) ---- */
  var store = {};
  try { store = JSON.parse(localStorage.getItem('tvflix.progress') || '{}') || {}; } catch (e) { store = {}; }
  function saveStore() { try { localStorage.setItem('tvflix.progress', JSON.stringify(store)); } catch (e) {} }
  function itemKey(it) { return it.archive ? 'a:' + it.id : it.tmdbId ? 't:' + it.tmdbId : 'l:' + it.title; }
  function getProg(it, epKey) { var r = store[itemKey(it)]; return (r && r.eps && r.eps[epKey]) || null; }
  function setProg(it, epKey, pos, dur, done) {
    var k = itemKey(it);
    var r = store[k] || (store[k] = { eps: {} });
    var old = r.eps[epKey];
    r.last = epKey;
    r.ts = Date.now();
    r.finished = false;
    /* remember enough about Internet Archive items to show them in "Continue Watching" next time */
    if (it.archive) { r.snap = { id: it.id, archive: true, title: it.title, poster: it.poster, year: it.year, description: it.description }; }
    var ep0 = null;
    if (it.eps) { for (var q = 0; q < it.eps.length; q++) { if (it.eps[q].key === epKey) { ep0 = it.eps[q]; break; } } }
    var pct = dur > 0 ? Math.round(pos / dur * 100) : 0;
    r.label = (ep0 && it.eps.length > 1 ? epLabel(ep0) + ' · ' : '') + pct + '%';
    r.eps[epKey] = { pos: Math.floor(pos || 0), dur: Math.floor(dur || 0),
      done: !!(done || (old && old.done) || (dur > 0 && pos / dur > 0.92)) };
  }
  function saveProgress(force) {
    if (!playing || !vid.getAttribute('src')) { return; }
    var d = vid.duration, t = vid.currentTime;
    if (!(d > 0) || t < 5) { return; }
    if (t / d > 0.97 || vid.ended) { return; }   /* the end of an episode is handled by onended */
    if (!force && Date.now() - lastSave < 5000) { return; }
    lastSave = Date.now();
    setProg(playing.item, playing.ep.key, t, d);
    saveStore();
  }

  /* ---- episodes: My Library series / multi-file Archive items ---- */
  function localEps(it) {
    var eps = [];
    if (it.seasons) {
      it.seasons.forEach(function (s, si) {
        var sn = s.number || si + 1;
        (s.episodes || []).forEach(function (e, ei) {
          if (!e.video) { return; }
          var n = e.number || ei + 1;
          eps.push({ key: 's' + sn + 'e' + n, season: sn, num: n, title: e.title || ('Episode ' + n), url: e.video });
        });
      });
    } else if (it.video) {
      eps.push({ key: 'main', season: 1, num: 1, title: it.title, url: it.video });
    }
    return eps;
  }

  function buildEpisodes(it, files) {
    var groups = {}, keys = [];
    files.forEach(function (f) {
      if (!/\.(mp4|m4v)$/i.test(f.name)) { return; }
      if ((parseInt(f.size, 10) || 0) < 2 * 1048576) { return; }
      var key = f.original || f.name;
      var g = groups[key];
      if (!g) { g = groups[key] = { key: key, files: [], title: f.title }; keys.push(key); }
      g.files.push(f);                       /* all versions of this episode; the quality setting picks one at play time */
      if (!g.title && f.title) { g.title = f.title; }
    });
    keys.sort(function (a, b) { return a.localeCompare(b, undefined, { numeric: true }); });
    if (!keys.length) { return []; }   /* one file = a single film (still gets resume/watched) */
    return keys.map(function (k, i) {
      var g = groups[k];
      /* nice title: drop the folder, the extension and the "Show - S01E02 -" prefix */
      var name = (g.title || k).replace(/^.*\//, '').replace(/\.[a-z0-9]{2,4}$/i, '').replace(/[_]+/g, ' ');
      var tail = name.replace(/^.*?\bs\d{1,2}\s*e\d{1,3}\b[\s\-–:.]*/i, '');
      if (tail && tail !== name) { name = tail; }
      name = name.replace(/\s+/g, ' ').trim() || k;
      var m = k.match(/s(\d{1,2})\s*[ex_.\- ]?\s*e?(\d{1,3})/i) || k.match(/\b(\d{1,2})x(\d{2,3})\b/i);
      return { key: k, season: m ? parseInt(m[1], 10) : 1, num: m ? parseInt(m[2], 10) : i + 1, title: name,
        cands: g.files, archiveId: it.id };
    });
  }

  /* ---- "Continue Watching" row: everything you started and haven't finished ---- */
  var libraryItems = [];   /* My Library items (rebuilt from catalog.json every start) */
  var contCache = {};      /* keeps loaded episode lists for items shown in the row */
  var contSig = '';

  function continueRow() {
    var found = [];
    for (var k in store) {
      if (!store.hasOwnProperty(k)) { continue; }
      var r = store[k];
      if (!r || !r.last || r.finished) { continue; }
      var base = null;
      if (k.indexOf('a:') === 0 && r.snap) {
        /* a private copy, so loaded episode lists never leak into what is saved */
        if (!contCache[k]) { contCache[k] = {}; for (var sp in r.snap) { contCache[k][sp] = r.snap[sp]; } }
        base = contCache[k];
      }
      else if (k.indexOf('l:') === 0) {
        for (var i = 0; i < libraryItems.length; i++) { if (itemKey(libraryItems[i]) === k) { base = libraryItems[i]; break; } }
      }
      if (!base) { continue; }
      var c = {};
      for (var p in base) { if (base.hasOwnProperty(p)) { c[p] = base[p]; } }   /* copy: the label is for this row only */
      c.contLabel = r.label || 'Continue';
      found.push({ it: c, ts: r.ts || 0, base: base, k: k });
    }
    found.sort(function (a, b) { return b.ts - a.ts; });
    found = found.slice(0, 15);
    return found.length ? { title: 'Continue Watching', cont: true, items: found.map(function (f) { return f.it; }) } : null;
  }

  function contSignature(cr) {
    return cr ? cr.items.map(function (i) { return itemKey(i) + '|' + i.contLabel; }).join(';') : '';
  }

  function withContinue(list) {
    var cr = continueRow();
    contSig = contSignature(cr);
    var rest = list.filter(function (r) { return !r.cont; });
    return cr ? [cr].concat(rest) : rest;
  }

  /* after leaving a film/episode: update the row (and keep the user's place) only if it changed */
  function refreshContinue() {
    if (homeRows) { return; }
    var cr = continueRow();
    if (contSignature(cr) === contSig) { return; }
    var had = rows.length && rows[0].cont;
    rows = withContinue(rows);
    var delta = (cr ? 1 : 0) - (had ? 1 : 0);
    if (focus.r >= 0) { focus.r = Math.max(0, focus.r + delta); }
    render(true);
  }

  function epsOf(it) { return (it && it.eps && it.eps.length > 1) ? it.eps : null; }
  function seasonList(it) {
    var seen = {}, l = [];
    it.eps.forEach(function (e) { if (!seen[e.season]) { seen[e.season] = 1; l.push(e.season); } });
    return l.sort(function (a, b) { return a - b; });
  }
  function epsInSeason(it, s) { return it.eps.filter(function (e) { return e.season === s; }); }
  function epLabel(e) { return 'S' + e.season + ' E' + e.num; }

  function resumeEpisode(it) {
    var all = it.eps;
    if (!all || !all.length) { return null; }
    var r = store[itemKey(it)];
    if (r && r.last) {
      for (var i = 0; i < all.length; i++) {
        if (all[i].key === r.last) {
          var p = r.eps[r.last];
          return (p && p.done && i + 1 < all.length) ? all[i + 1] : all[i];
        }
      }
    }
    return all[0];
  }

  function renderEpisodes() {
    var box = $('eps');
    var all = epsOf(current);
    if (!all) { box.className = 'hidden'; updateButtons(); return; }
    box.className = '';
    var seasons = seasonList(current);
    var sbox = $('eps-seasons');
    sbox.innerHTML = '';
    seasons.forEach(function (s) {
      var d = document.createElement('span');
      d.className = 'chip2' + (s === detailSeason ? ' sel' : '') + (detailZone === 1 && s === detailSeason ? ' focus' : '');
      d.textContent = 'Season ' + s;
      d.onclick = function () { detailSeason = s; epIdx = 0; epTop = 0; detailZone = 1; renderEpisodes(); };
      sbox.appendChild(d);
    });
    var list = epsInSeason(current, detailSeason);
    if (epIdx >= list.length) { epIdx = Math.max(0, list.length - 1); }
    if (epIdx < epTop) { epTop = epIdx; }
    if (epIdx >= epTop + 5) { epTop = epIdx - 4; }
    var lbox = $('eps-list');
    lbox.innerHTML = '';
    for (var i = epTop; i < Math.min(list.length, epTop + 5); i++) {
      (function (i) {
        var ep = list[i], p = getProg(current, ep.key);
        var row = document.createElement('div');
        row.className = 'ep' + (detailZone === 2 && i === epIdx ? ' focus' : '');
        var left = document.createElement('span');
        left.className = 'ep-title';
        left.textContent = 'E' + ep.num + '   ' + ep.title;
        var right = document.createElement('span');
        right.className = 'ep-state';
        right.textContent = (p && p.done) ? '✓ Watched' : (p && p.pos > 10 && p.dur ? Math.round(p.pos / p.dur * 100) + '%' : '');
        row.appendChild(left);
        row.appendChild(right);
        row.onclick = function () { epIdx = i; detailZone = 2; renderEpisodes(); playEpisode(ep); };
        lbox.appendChild(row);
      })(i);
    }
    $('eps-more').textContent = list.length + ' episodes' + (epTop > 0 ? '  ▲' : '') +
      (epTop + 5 < list.length ? '  ▼' : '');
    updateButtons();
  }

  function setupEps() {
    var all = epsOf(current);
    if (all) {
      var r = resumeEpisode(current);
      detailSeason = r.season;
      var list = epsInSeason(current, detailSeason);
      epIdx = Math.max(0, list.indexOf(r));
      epTop = 0;
    }
    detailZone = 0;
    renderEpisodes();
  }

  function loadArchiveEps(it) {
    if (it.eps) { return; }
    if (it._epsLoading) { return; }
    it._epsLoading = true;
    get(ARCHIVE + '/metadata/' + encodeURIComponent(it.id), function (err, meta) {
      it._epsLoading = false;
      if (err || !meta || !meta.files) { return; }
      it.eps = buildEpisodes(it, meta.files);
      if (current === it && view === 'detail') { setupEps(); }
    });
  }

  function visibleButtons() {
    var list = [];
    if (current) { list.push({ el: $('detail-play'), act: 'play' }); }
    if (current && current.trailer) { list.push({ el: $('detail-trailer'), act: 'trailer' }); }
    if (current && current.archive) { list.push({ el: $('detail-quality'), act: 'quality' }); }
    return list;
  }

  function updateButtons() {
    var list = visibleButtons();
    $('detail-play').className = 'btn hidden';
    $('detail-trailer').className = 'btn hidden';
    $('detail-quality').className = 'btn hidden';
    $('detail-quality').textContent = 'Quality: ' + (quality === 'low' ? 'Low (faster)' : 'High');
    if (detailBtn >= list.length) { detailBtn = 0; }
    list.forEach(function (b, i) { b.el.className = 'btn' + (i === detailBtn && detailZone === 0 ? ' focus' : ''); });
    /* the Play button says what it will play: Play / Continue S1 E3 / Resume 12:03 */
    var lab = '▶ Play';
    if (current && current.eps && current.eps.length) {
      var re = resumeEpisode(current), p = re && getProg(current, re.key);
      var partial = p && !p.done && p.pos > 10;
      if (current.eps.length > 1) { lab = (partial ? '▶ Continue ' : '▶ Play ') + epLabel(re); }
      else if (partial) { lab = '▶ Resume ' + fmt(p.pos); }
    }
    $('detail-play').textContent = lab;
  }

  function renderWhere(item) {
    var box = $('detail-where');
    box.innerHTML = '';
    if (!item) { return; }
    var d = document.createElement('div');
    d.className = 'where-free';
    d.textContent = item.archive ? '▶ From the Internet Archive - press Play'
      : item.video ? '▶ From your library - press Play'
      : '▶ Ready to stream instantly via VidCore Player (Press Play)';
    box.appendChild(d);
  }

  function openDetail() {
    current = rows[focus.r].items[focus.c];
    $('detail-title').textContent = current.title;
    $('detail-desc').textContent = (current.meta ? current.meta + '  —  ' : '') +
      (current.description || 'No description available.');
    $('detail-poster').style.backgroundImage = current.poster ? 'url(' + current.poster + ')' : 'none';
    detailBtn = 0;
    detailZone = 0;
    renderWhere(current);
    $('detail').className = '';
    view = 'detail';
    setupEps();                                   /* episode picker for series (hidden for single films) */
    if (current.archive) { loadArchiveEps(current); }

    /* free films: fetch the nicer poster/description from TMDB once, only for the film you opened */
    if (current.archive && !current.enriched && TMDB_KEY) {
      current.enriched = true;
      var opened = current;
      enrichOne(opened, function () {
        if (view === 'detail' && current === opened) {
          $('detail-desc').textContent = (opened.meta ? opened.meta + '  —  ' : '') +
            (opened.description || 'No description available.');
          $('detail-poster').style.backgroundImage = opened.poster ? 'url(' + opened.poster + ')' : 'none';
        }
      });
    }

    if (current.tmdbId && !current.checked) {
      current.checked = true;
      var base = TMDB_API + '/' + current.kind + '/' + current.tmdbId;
      get(base + '/videos?api_key=' + TMDB_KEY, function (e, d) {
        var best = null;
        if (!e && d && d.results) {
          d.results.forEach(function (v) {
            if (v.site !== 'YouTube' || v.type !== 'Trailer') { return; }
            if (!best || (v.official && !best.official)) { best = v; }
          });
        }
        if (best) { current.trailer = best.key; }
        updateButtons();
      });
    }
  }

  function openTrailer() {
    $('trailer-frame').src = 'https://www.youtube.com/embed/' + encodeURIComponent(current.trailer) +
      '?autoplay=1&rel=0&modestbranding=1';
    $('trailer').className = '';
    view = 'trailer';
  }

  function closeTrailer() {
    $('trailer-frame').src = 'about:blank';
    $('trailer').className = 'hidden';
    view = 'detail';
    try { window.focus(); } catch (e) {}
  }

  function closeDetail() { $('detail').className = 'hidden'; view = 'home'; refreshContinue(); }

  function showMsg(t, keep) {
    var m = $('player-msg');
    m.textContent = t || '';
    clearTimeout(msgTimer);
    if (t && !keep) { msgTimer = setTimeout(function () { m.textContent = ''; }, 2000); }
  }

  /* Free Internet Archive films: play the video file directly in a plain <video> element.
     (archive.org's embed page needs a modern browser and hangs on older TVs.) */
  var vid = $('vid');
  var playToken = 0;
  var loadTimer = null;

  /* Video quality for Internet Archive films. "Low" uses the small 512Kb version when a film has one:
     it starts much sooner on a slow connection or an old TV. Old Tizen TVs (3.0 / 4.0) default to Low. */
  var QUALITY_ORDER = {
    low:  ['512Kb MPEG4', 'h.264', 'MPEG4', 'h.264 HD'],
    high: ['h.264', 'MPEG4', 'h.264 HD', '512Kb MPEG4']
  };
  var quality = 'high';
  (function () {
    var m = (navigator.userAgent || '').match(/Tizen[ \/](\d+)/);
    if (m && parseInt(m[1], 10) <= 4) { quality = 'low'; }
    try { var q = localStorage.getItem('tvflix.quality'); if (q === 'low' || q === 'high') { quality = q; } } catch (e) {}
  })();

  function chooseFile(files) {
    var order = QUALITY_ORDER[quality], mp4 = /\.(mp4|m4v)$/i, i, j;
    for (i = 0; i < order.length; i++) {
      for (j = 0; j < files.length; j++) {
        if (files[j].format === order[i] && mp4.test(files[j].name)) { return files[j]; }
      }
    }
    var best = null;   /* no known format: take the smallest mp4 */
    for (j = 0; j < files.length; j++) {
      if (!mp4.test(files[j].name)) { continue; }
      if (!best || (parseInt(files[j].size, 10) || 0) < (parseInt(best.size, 10) || 0)) { best = files[j]; }
    }
    return best;
  }
  function pickArchiveFile(files) { return chooseFile(files); }

  function toggleQuality() {
    quality = (quality === 'low') ? 'high' : 'low';
    try { localStorage.setItem('tvflix.quality', quality); } catch (e) {}
    updateButtons();
  }

  /* ---- screen modes for the video player: Fit / Fill / Stretch / Zoom ---- */
  var ASPECTS = ['Fit', 'Fill', 'Stretch', 'Zoom'];
  var aspect = 0;
  try { aspect = parseInt(localStorage.getItem('tvflix.aspect'), 10) || 0; } catch (e) {}
  if (aspect < 0 || aspect >= ASPECTS.length) { aspect = 0; }

  function applyAspect() { vid.setAttribute('data-aspect', ASPECTS[aspect].toLowerCase()); updateBar(); }

  function cycleAspect() {
    aspect = (aspect + 1) % ASPECTS.length;
    try { localStorage.setItem('tvflix.aspect', String(aspect)); } catch (e) {}
    applyAspect();
    showMsg('Screen: ' + ASPECTS[aspect]);
  }

  /* ---- control bar (time, progress, buttons) ---- */
  var barTimer = null;

  function fmt(t) {
    t = Math.max(0, Math.floor(t || 0));
    var h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
    return (h ? h + ':' + (m < 10 ? '0' : '') : '') + m + ':' + (s < 10 ? '0' : '') + s;
  }

  function updateBar() {
    $('vtime').textContent = fmt(vid.currentTime) + ' / ' + fmt(vid.duration);
    $('vprog-fill').style.width = (vid.duration ? (vid.currentTime / vid.duration * 100) : 0) + '%';
    $('v-pp').textContent = vid.paused ? '▶ Play' : '❚❚ Pause';
    $('v-asp').textContent = 'Screen: ' + ASPECTS[aspect];
  }

  function showBar() {
    $('vbar').className = '';
    clearTimeout(barTimer);
    barTimer = setTimeout(function () { if (!vid.paused) { $('vbar').className = 'hidden'; } }, 4000);
  }

  vid.addEventListener('timeupdate', function () { updateBar(); saveProgress(false); });
  vid.addEventListener('pause', function () { updateBar(); showBar(); saveProgress(true); });
  vid.addEventListener('play', function () { updateBar(); showBar(); });

  function toggleFullscreen() {
    var d = document, el = d.documentElement;
    try {
      if (d.fullscreenElement || d.webkitFullscreenElement) { (d.exitFullscreen || d.webkitExitFullscreen).call(d); }
      else { (el.requestFullscreen || el.webkitRequestFullscreen).call(el); }
    } catch (e) {}
  }

  function playEpisode(ep) {
    var item = current;
    $('player').className = '';
    view = 'player';
    playing = { item: item, ep: ep };
    var token = ++playToken;
    vid.className = 'hidden';
    var p = getProg(item, ep.key);
    var start = (p && !p.done) ? p.pos : 0;
    var url = ep.url, size = ep.size || 0;
    if (ep.cands) {                                     /* Internet Archive: choose the version by quality */
      var f = chooseFile(ep.cands);
      if (f) {
        url = ARCHIVE + '/download/' + encodeURIComponent(ep.archiveId) + '/' + encodeURIComponent(f.name);
        size = parseInt(f.size, 10) || 0;
      }
    }
    if (!url) { showMsg('This episode has no video link. Press Back.', true); return; }
    playVideo(url, size, token, start);
  }

  function playVideo(url, sizeBytes, token, startPos) {
    vid.onloadedmetadata = function () {
      if (token === playToken && startPos > 10 && vid.duration && startPos < vid.duration - 30) {
        try { vid.currentTime = startPos; showMsg('Resuming at ' + fmt(startPos)); } catch (e) {}
      }
    };
    /* when an episode ends: mark it watched and roll on to the next one */
    vid.onended = function () {
      if (token !== playToken || !playing) { return; }
      var item = playing.item, ep = playing.ep;
      setProg(item, ep.key, vid.duration, vid.duration, true);
      saveStore();
      var list = item.eps || [], next = null;
      for (var i = 0; i < list.length; i++) { if (list[i].key === ep.key) { next = list[i + 1] || null; break; } }
      var rec = store[itemKey(item)];
      if (rec) { rec.finished = !next; rec.label = next ? 'Up next · ' + epLabel(next) : ''; saveStore(); }
      if (next) {
        showMsg('Next: ' + epLabel(next) + '  ' + next.title, true);
        setTimeout(function () {
          if (view === 'player' && token === playToken) {
            detailSeason = next.season;
            epIdx = Math.max(0, epsInSeason(item, next.season).indexOf(next));
            playEpisode(next);
          }
        }, 2000);
      } else { stop(); }
    };
    vid.onerror = function () {
      if (token !== playToken) { return; }
      clearInterval(loadTimer);
      var code = vid.error ? vid.error.code : '?';
      showMsg('This video could not be played (error ' + code + '). ' +
        (code === 4 || code === 3 ? 'Try Quality: Low on the film page. ' : 'Check the connection. ') + 'Press Back.', true);
    };
    vid.onplaying = function () { if (token === playToken) { clearInterval(loadTimer); showMsg(''); } };
    vid.onwaiting = function () { if (token === playToken) { showMsg('Buffering...', true); } };
    vid.oncanplay = function () { if (token === playToken && !vid.paused) { showMsg(''); } };
    vid.src = url;
    vid.className = '';
    applyAspect();
    showBar();
    var sizeTxt = sizeBytes ? ' (' + Math.round(sizeBytes / 1048576) + ' MB, ' + quality + ' quality)' : '';
    showMsg('Loading' + sizeTxt + '...', true);
    /* live "Loading 12s - buffered 3%" so a slow start is visible, not a frozen screen */
    var t0 = Date.now();
    clearInterval(loadTimer);
    loadTimer = setInterval(function () {
      if (token !== playToken) { clearInterval(loadTimer); return; }
      if (vid.readyState >= 3) { clearInterval(loadTimer); showMsg(''); return; }   /* ready (playing or waiting for OK) */
      var s = Math.round((Date.now() - t0) / 1000), b = '';
      try {
        if (vid.buffered.length && vid.duration) {
          b = ' - buffered ' + Math.round(vid.buffered.end(vid.buffered.length - 1) / vid.duration * 100) + '%';
        }
      } catch (e) {}
      showMsg('Loading' + sizeTxt + ' ' + s + 's' + b + (s > 30 ? ' - slow? try Quality: Low on the film page' : ''), true);
    }, 1000);
    var p = vid.play();
    if (p && p.catch) { p.catch(function () {}); }
  }

  function playArchive(item) {
    var token = ++playToken;
    vid.className = 'hidden';
    showMsg('Loading film...', true);
    get(ARCHIVE + '/metadata/' + encodeURIComponent(item.id), function (err, meta) {
      if (token !== playToken || view !== 'player') { return; }
      var f = (!err && meta && meta.files) ? pickArchiveFile(meta.files) : null;
      if (!f) { showMsg('No playable video file found for this film. Press Back.', true); return; }
      playVideo(ARCHIVE + '/download/' + encodeURIComponent(item.id) + '/' + encodeURIComponent(f.name),
        parseInt(f.size, 10) || 0, token);
    });
  }

  function stopVideo() {
    clearInterval(loadTimer);
    playToken++;
    try { vid.pause(); } catch (e) {}
    vid.removeAttribute('src');
    vid.onerror = vid.onplaying = vid.onwaiting = vid.oncanplay = vid.onloadedmetadata = vid.onended = null;
    try { vid.load(); } catch (e) {}
    vid.className = 'hidden';
    $('vbar').className = 'hidden';
  }

  function videoActive() { return vid.className.indexOf('hidden') < 0 && !!vid.getAttribute('src'); }

  function togglePause() {
    if (vid.paused) { var p = vid.play(); if (p && p.catch) { p.catch(function () {}); } showMsg('Play'); }
    else { vid.pause(); showMsg('Paused'); }
  }
  function seekBy(s) {
    vid.currentTime = Math.max(0, Math.min(vid.duration || 1e9, vid.currentTime + s));
    showMsg((s > 0 ? '+' : '') + s + 's');
  }

  function videoKey(k) {
    if (!videoActive()) { return false; }
    showBar();
    if (k === KEY.ENTER || k === KEY.PLAYPAUSE || k === 32) { togglePause(); }
    else if (k === KEY.PLAY) { if (vid.paused) { togglePause(); } }
    else if (k === KEY.PAUSE) { if (!vid.paused) { togglePause(); } }
    else if (k === KEY.RIGHT || k === KEY.FF) { seekBy(30); }
    else if (k === KEY.LEFT || k === KEY.RW) { seekBy(-10); }
    else if (k === KEY.UP || k === 65 || k === 405) { cycleAspect(); }  /* Up, A, or the remote's yellow button */
    else if (k === KEY.DOWN) { /* just shows the bar */ }
    else if (k === 70) { toggleFullscreen(); }
    else { return false; }
    return true;
  }

  function play() {
    $('player').className = '';
    view = 'player';
    if (current.eps && current.eps.length) { playEpisode(resumeEpisode(current)); return; }
    if (current.archive) { playArchive(current); return; }
    if (current.video) { playVideo(current.video, 0, ++playToken); return; }
    var type = (current.kind === 'tv') ? 'tv' : 'movie';
    var movieId = current.tmdbId || current.id || '';

    var url = 'https://vidcore.io/' + type + '/' + encodeURIComponent(movieId);
    if (type === 'tv') {
      url += '/1/1';
    }
    url += '?autoPlay=true';

    vidcoreFrame.src = url;
    showMsg('Loading VidCore Stream...', true);
  }

  function stop() {
    saveProgress(true);
    playing = null;
    stopVideo();
    vidcoreFrame.src = 'about:blank';
    $('player').className = 'hidden';
    $('detail').className = '';
    view = 'detail';
    detailZone = 0;
    renderEpisodes();   /* refresh the watched marks and the Play button label */
  }

  var KEY = { LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40, ENTER: 13, BACK: 10009, ESC: 27, BKSP: 8,
              PLAY: 415, PAUSE: 19, PLAYPAUSE: 10252, STOP: 413, FF: 417, RW: 412 };

  function isBack(k) { return k === KEY.BACK || k === KEY.ESC || k === KEY.BKSP; }

  var noopEv = { preventDefault: function () {}, stopPropagation: function () {} };
  function fireKey(k) { handleKey(k, noopEv); }
  document.addEventListener('keydown', function (e) {
    document.body.className = document.body.className.replace(/\s*\bmouse\b/, '');
    handleKey(e.keyCode, e);
  });

  function handleKey(k, e) {
    /* F = browser fullscreen on a PC (not while typing in the search box) */
    if (k === 70 && view !== 'search') { toggleFullscreen(); return; }

    if (view === 'player') {
      if (isBack(k) || k === KEY.STOP) { stop(); e.preventDefault(); }
      else if (videoKey(k)) { e.preventDefault(); }
      return;
    }

    if (view === 'trailer') {
      if (isBack(k) || k === KEY.STOP) { closeTrailer(); e.preventDefault(); }
      return;
    }

    if (view === 'detail') {
      var btns = visibleButtons();
      var multi = !!epsOf(current);
      var nSeasons = multi ? seasonList(current).length : 0;
      if (isBack(k)) { closeDetail(); }
      else if (detailZone === 0) {
        if (k === KEY.LEFT && detailBtn > 0) { detailBtn--; updateButtons(); }
        else if (k === KEY.RIGHT && detailBtn < btns.length - 1) { detailBtn++; updateButtons(); }
        else if (k === KEY.DOWN && multi) { detailZone = nSeasons > 1 ? 1 : 2; renderEpisodes(); }
        else if (k === KEY.ENTER && btns[detailBtn]) {
          var act = btns[detailBtn].act;
          if (act === 'play') { play(); } else if (act === 'quality') { toggleQuality(); } else { openTrailer(); }
        }
      } else if (detailZone === 1) {
        var sl = seasonList(current), si = sl.indexOf(detailSeason);
        if (k === KEY.LEFT && si > 0) { detailSeason = sl[si - 1]; epIdx = 0; epTop = 0; renderEpisodes(); }
        else if (k === KEY.RIGHT && si < sl.length - 1) { detailSeason = sl[si + 1]; epIdx = 0; epTop = 0; renderEpisodes(); }
        else if (k === KEY.UP) { detailZone = 0; renderEpisodes(); }
        else if (k === KEY.DOWN || k === KEY.ENTER) { detailZone = 2; renderEpisodes(); }
      } else {
        var elist = epsInSeason(current, detailSeason);
        if (k === KEY.UP) { if (epIdx > 0) { epIdx--; } else { detailZone = nSeasons > 1 ? 1 : 0; } renderEpisodes(); }
        else if (k === KEY.DOWN && epIdx < elist.length - 1) { epIdx++; renderEpisodes(); }
        else if (k === KEY.ENTER && elist[epIdx]) { playEpisode(elist[epIdx]); }
      }
      e.preventDefault();
      return;
    }

    if (view === 'search') {
      /* let the on-screen keyboard / input handle typing; only Enter and Back are ours */
      if (k === KEY.ENTER || k === 65376) { doSearch($('search-input').value); e.preventDefault(); }
      else if (k === KEY.BACK || k === KEY.ESC || k === 65385) { closeSearch(); e.preventDefault(); }
      return;
    }

    if (focus.r === -1) {
      if (k === KEY.DOWN && rows.length) { focus.r = 0; }
      else if (k === KEY.ENTER) { openSearch(); e.preventDefault(); return; }
      else if (isBack(k)) { if (!leaveResults() && window.tizen && tizen.application) { tizen.application.getCurrentApplication().exit(); } focus.r = Math.max(focus.r, 0); }
      updateFocus();
      e.preventDefault();
      return;
    }
    if (k === KEY.UP && focus.r === 0) { focus.r = -1; updateFocus(); e.preventDefault(); return; }

    if (!rows.length) { return; }
    if (k === KEY.RIGHT && focus.c < rows[focus.r].items.length - 1) { focus.c++; }
    else if (k === KEY.LEFT && focus.c > 0) { focus.c--; }
    else if (k === KEY.DOWN && focus.r < rows.length - 1) {
      focus.r++; focus.c = Math.min(focus.c, rows[focus.r].items.length - 1);
    }
    else if (k === KEY.UP && focus.r > 0) {
      focus.r--; focus.c = Math.min(focus.c, rows[focus.r].items.length - 1);
    }
    else if (k === KEY.ENTER) { openDetail(); }
    else if (isBack(k)) {
      if (leaveResults()) { e.preventDefault(); return; }
      if (window.tizen && tizen.application) { tizen.application.getCurrentApplication().exit(); }
    }
    updateFocus();
    e.preventDefault();
  }

  /* ---- PC support: scale the 1920x1080 layout to any window, and mouse controls ---- */
  var appEl = $('app');
  function fit() {
    var w = window.innerWidth, h = window.innerHeight;
    if (!w || !h) { return; } /* window hidden or not laid out yet */
    var s = Math.min(w / 1920, h / 1080);
    var x = (w - 1920 * s) / 2, y = (h - 1080 * s) / 2;
    /* On a 1920x1080 TV no scaling is needed: skip the transform entirely, because a transform
       forces the whole screen into a GPU layer, which is slow on old TVs. */
    var t = (Math.abs(s - 1) < 0.001 && Math.abs(x) < 1 && Math.abs(y) < 1) ? '' :
      'translate(' + x + 'px,' + y + 'px) scale(' + s + ')';
    appEl.style.webkitTransform = appEl.style.transform = t;
  }
  window.addEventListener('resize', fit);
  window.addEventListener('load', fit);
  fit();

  document.addEventListener('mousemove', function () {
    if (document.body.className.indexOf('mouse') < 0) { document.body.className += ' mouse'; }
    if (view === 'player' && videoActive()) { showBar(); }
  });

  var wheelAt = 0;
  $('rows').addEventListener('wheel', function (e) {
    if (view !== 'home') { return; }
    var now = Date.now();
    if (now - wheelAt < 140) { e.preventDefault(); return; }
    wheelAt = now;
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) { fireKey(e.deltaX > 0 ? KEY.RIGHT : KEY.LEFT); }
    else if (e.deltaY !== 0) { fireKey(e.deltaY > 0 ? KEY.DOWN : KEY.UP); }
    e.preventDefault();
  });

  var goBack = function () { fireKey(KEY.ESC); };
  ['back-detail', 'back-search', 'back-player', 'back-trailer'].forEach(function (id) { $(id).onclick = goBack; });
  $('homeback').onclick = function () { leaveResults(); };
  $('searchbtn').onclick = function () { focus.r = -1; updateFocus(); openSearch(); };
  $('detail-play').onclick = function () { detailBtn = 0; detailZone = 0; updateButtons(); play(); };
  $('detail-trailer').onclick = function () { detailBtn = 1; updateButtons(); openTrailer(); };
  $('detail-quality').onclick = function () { toggleQuality(); };
  $('vid').onclick = function () { fireKey(KEY.ENTER); };
  $('v-rw').onclick = function () { seekBy(-10); showBar(); };
  $('v-ff').onclick = function () { seekBy(30); showBar(); };
  $('v-pp').onclick = function () { togglePause(); showBar(); };
  $('v-asp').onclick = function () { cycleAspect(); showBar(); };
  $('v-fs').onclick = function () { toggleFullscreen(); };
  $('vprog').onclick = function (e) {
    var r = this.getBoundingClientRect();
    if (vid.duration && r.width) { vid.currentTime = vid.duration * Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)); showBar(); }
  };

  try {
    if (window.tizen && tizen.tvinputdevice) {
      ['MediaPlay', 'MediaPause', 'MediaPlayPause', 'MediaStop', 'MediaFastForward', 'MediaRewind', 'ColorF2Yellow']
        .forEach(function (n) { try { tizen.tvinputdevice.registerKey(n); } catch (e) {} });
    }
  } catch (e) {}

  loadCatalog();
})();