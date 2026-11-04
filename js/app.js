/* TVFlix - written in plain ES5 so it runs on Tizen 3.0 (2017 Samsung TVs). */
(function () {
  var ARCHIVE = 'https://archive.org';
  var ROW_HEIGHT = 420;
  var CARD_STEP = 254; /* card width + margin */

  var rows = [];            /* [{title, items:[{title, description, poster, id, video}]}] */
  var focus = { r: 0, c: 0 };
  var view = 'home';        /* home | detail | trailer | player */
  var current = null;
  var msgTimer = null;

  var $ = function (id) { return document.getElementById(id); };
  var rowsInner = $('rows-inner');
  var video = $('video');

  /* ---------- helpers ---------- */
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

  /* ---------- TMDB: nicer posters, descriptions and ratings ---------- */
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

  /* ---------- loading the catalog ---------- */
  function loadCatalog() {
    setStatus('Loading...');
    get('catalog.json', function (err, cat) {
      if (err) { setStatus('Could not read catalog.json'); return; }
      var pending = cat.rows.length;
      var results = new Array(cat.rows.length);
      var done = function () {
        pending--;
        if (pending > 0) { return; }
        rows = [];
        for (var i = 0; i < results.length; i++) {
          if (results[i] && results[i].items.length) { rows.push(results[i]); }
        }
        setStatus(rows.length ? '' : 'Nothing to show - check your internet connection');
        render();
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
                title: clean(d.title),
                description: clean(d.description),
                year: d.year ? String(d.year).substring(0, 4) : '',
                poster: ARCHIVE + '/services/img/' + d.identifier
              };
            }).filter(function (it) {
              return !cat.hide || !cat.hide.length || !hide.test(it.title + ' ' + it.description);
            });
            enrich(list, function (items) {
              results[i] = { title: row.title, items: items };
              done();
            });
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
          var items = (row.items || []).filter(function (it) { return it.video; });
          enrich(items.filter(function (it) { return !it.poster; }), function () {
            results[i] = { title: row.title, items: items };
            done();
          });
        }
      });
    });
  }

  /* ---------- rendering ---------- */
  function render() {
    rowsInner.innerHTML = '';
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
        if (it.poster) { card.style.backgroundImage = 'url(' + it.poster + ')'; }
        var cap = document.createElement('div');
        cap.className = 'cap';
        cap.textContent = it.title;
        card.appendChild(cap);
        if (it.id || it.video) {
          var badge = document.createElement('div');
          badge.className = 'badge';
          badge.textContent = '▶ FREE';
          card.appendChild(badge);
        }
        track.appendChild(card);
      });
      wrap.appendChild(track);
      rowEl.appendChild(t);
      rowEl.appendChild(wrap);
      rowsInner.appendChild(rowEl);
    });
    focus = { r: 0, c: 0 };
    updateFocus();
  }

  function updateFocus() {
    var rowEls = rowsInner.children;
    for (var r = 0; r < rowEls.length; r++) {
      var track = rowEls[r].querySelector('.track');
      var cards = track.children;
      var c = (r === focus.r) ? focus.c : 0;
      for (var k = 0; k < cards.length; k++) {
        cards[k].className = 'card' + (r === focus.r && k === focus.c ? ' focus' : '');
      }
      var off = Math.max(0, c - 3) * CARD_STEP;
      track.style.webkitTransform = track.style.transform = 'translateX(-' + off + 'px)';
    }
    var vOff = Math.max(0, focus.r - 1) * ROW_HEIGHT;
    rowsInner.style.webkitTransform = rowsInner.style.transform = 'translateY(-' + vOff + 'px)';
  }

  /* ---------- detail ---------- */
  var detailBtn = 0;        /* index into the visible detail buttons */

  function canPlay(it) { return !!(it && (it.id || it.video)); }

  function visibleButtons() {
    var list = [];
    if (canPlay(current)) { list.push({ el: $('detail-play'), act: 'play' }); }
    if (current && current.trailer) { list.push({ el: $('detail-trailer'), act: 'trailer' }); }
    return list;
  }

  function updateButtons() {
    var list = visibleButtons();
    $('detail-play').className = 'btn hidden';
    $('detail-trailer').className = 'btn hidden';
    if (detailBtn >= list.length) { detailBtn = 0; }
    list.forEach(function (b, i) { b.el.className = 'btn' + (i === detailBtn ? ' focus' : ''); });
  }

  /* the "where to watch" block: free copy note + provider logos grouped by Stream / Rent / Buy */
  function renderWhere(item) {
    var box = $('detail-where');
    box.innerHTML = '';
    if (!item || !item.tmdbId) { return; }
    function line(cls, text) {
      var d = document.createElement('div');
      d.className = cls;
      d.textContent = text;
      box.appendChild(d);
    }
    if (item.loading) { line('where-note', 'Checking where to watch...'); return; }
    if (!item.whereData) { return; }
    if (item.id) { line('where-free', '▶ A free public-domain copy is available - press Play.'); }
    var groups = item.whereData.groups;
    if (!groups.length) {
      line('where-note', 'Not listed on any streaming service in ' + COUNTRY + '.');
    }
    groups.forEach(function (g) {
      var wrap = document.createElement('div');
      wrap.className = 'where-group';
      var label = document.createElement('span');
      label.className = 'where-label';
      label.textContent = g.label;
      wrap.appendChild(label);
      g.providers.forEach(function (p) {
        var chip = document.createElement('span');
        chip.className = 'chip';
        if (p.logo) {
          var img = document.createElement('img');
          img.src = TMDB_LOGO + p.logo;
          img.alt = '';
          chip.appendChild(img);
        }
        chip.appendChild(document.createTextNode(p.name));
        wrap.appendChild(chip);
      });
      box.appendChild(wrap);
    });
  }

  function openDetail() {
    current = rows[focus.r].items[focus.c];
    $('detail-title').textContent = current.title;
    $('detail-desc').textContent = (current.meta ? current.meta + '  —  ' : '') +
      (current.description || 'No description available.');
    $('detail-poster').style.backgroundImage = current.poster ? 'url(' + current.poster + ')' : 'none';
    detailBtn = 0;
    renderWhere(current);
    updateButtons();
    $('detail').className = '';
    view = 'detail';
    if (current.tmdbId && !current.checked) { current.checked = true; lookupAvailability(current); }
  }

  /* streaming availability + trailer (official TMDB endpoints), plus a free public-domain copy if one exists */
  function lookupAvailability(item) {
    var pending = item.kind === 'movie' ? 3 : 2;
    var groups = [];
    item.loading = true;
    renderWhere(item);

    function fin() {
      pending--;
      if (pending > 0) { return; }
      item.loading = false;
      item.whereData = { groups: groups };
      if (current === item) { renderWhere(item); updateButtons(); }
    }

    var base = TMDB_API + '/' + item.kind + '/' + item.tmdbId;

    get(base + '/watch/providers?api_key=' + TMDB_KEY, function (e, d) {
      var r = d && d.results && d.results[COUNTRY];
      if (r) {
        [['flatrate', 'Stream on'], ['free', 'Free on'], ['ads', 'Free with ads on'],
         ['rent', 'Rent on'], ['buy', 'Buy on']].forEach(function (g) {
          if (r[g[0]] && r[g[0]].length) {
            groups.push({
              label: g[1],
              providers: r[g[0]].map(function (p) { return { name: p.provider_name, logo: p.logo_path }; })
            });
          }
        });
      }
      fin();
    });

    get(base + '/videos?api_key=' + TMDB_KEY, function (e, d) {
      var best = null;
      if (!e && d && d.results) {
        d.results.forEach(function (v) {
          if (v.site !== 'YouTube' || v.type !== 'Trailer') { return; }
          if (!best || (v.official && !best.official)) { best = v; }
        });
      }
      if (best) { item.trailer = best.key; }
      fin();
    });

    if (item.kind === 'movie') {
      var y = parseInt(item.year, 10);
      var q = 'title:(' + item.title.replace(/["()\[\]:]/g, ' ') + ') AND mediatype:movies' +
        (y ? ' AND year:[' + (y - 1) + ' TO ' + (y + 1) + ']' : '');
      get(ARCHIVE + '/advancedsearch.php?q=' + encodeURIComponent(q) +
        '&fl[]=identifier&fl[]=title&rows=10&sort[]=downloads+desc&output=json', function (e, d) {
        if (!e && d && d.response) {
          for (var i = 0; i < d.response.docs.length; i++) {
            if (norm(clean(d.response.docs[i].title)) === norm(item.title)) { item.id = d.response.docs[i].identifier; break; }
          }
        }
        fin();
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

  function closeDetail() { $('detail').className = 'hidden'; view = 'home'; }

  /* ---------- player ---------- */
  function showMsg(t, keep) {
    var m = $('player-msg');
    m.textContent = t || '';
    clearTimeout(msgTimer);
    if (t && !keep) { msgTimer = setTimeout(function () { m.textContent = ''; }, 2000); }
  }

  function resolveVideo(item, cb) {
    if (item.video) { cb(null, item.video); return; }
    get(ARCHIVE + '/metadata/' + encodeURIComponent(item.id), function (err, meta) {
      if (err || !meta || !meta.files) { cb(err || new Error('no files')); return; }
      var best = null;
      meta.files.forEach(function (f) {
        var isMp4 = /\.mp4$/i.test(f.name);
        if (!isMp4) { return; }
        if (/h\.?264/i.test(f.format || '')) { if (!best || !best.pref) { best = { f: f, pref: true }; } }
        else if (!best) { best = { f: f, pref: false }; }
      });
      if (!best) { cb(new Error('no playable mp4')); return; }
      cb(null, ARCHIVE + '/download/' + encodeURIComponent(item.id) + '/' +
        best.f.name.split('/').map(encodeURIComponent).join('/'));
    });
  }

  function play() {
    $('player').className = '';
    view = 'player';
    showMsg('Loading...', true);
    resolveVideo(current, function (err, url) {
      if (err) { showMsg('Could not find a playable video for this title.', true); return; }
      video.src = url;
      video.play();
    });
  }

  function stop() {
    try { video.pause(); } catch (e) {}
    video.removeAttribute('src');
    video.load();
    $('player').className = 'hidden';
    $('detail').className = '';
    view = 'detail';
  }

  video.addEventListener('playing', function () { showMsg(''); });
  video.addEventListener('waiting', function () { showMsg('Buffering...', true); });
  video.addEventListener('error', function () { showMsg('Playback error. Try another title.', true); });
  video.addEventListener('ended', stop);
  video.addEventListener('timeupdate', function () {
    if (video.duration) {
      $('player-progress').style.width = (video.currentTime / video.duration * 100) + '%';
    }
  });

  /* ---------- remote control ---------- */
  var KEY = { LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40, ENTER: 13, BACK: 10009, ESC: 27, BKSP: 8,
              PLAY: 415, PAUSE: 19, PLAYPAUSE: 10252, STOP: 413, FF: 417, RW: 412 };

  function isBack(k) { return k === KEY.BACK || k === KEY.ESC || k === KEY.BKSP; }

  document.addEventListener('keydown', function (e) {
    var k = e.keyCode;

    if (view === 'player') {
      if (isBack(k) || k === KEY.STOP) { stop(); }
      else if (k === KEY.ENTER || k === KEY.PLAYPAUSE) {
        if (video.paused) { video.play(); showMsg('Play'); } else { video.pause(); showMsg('Paused', true); }
      }
      else if (k === KEY.PLAY) { video.play(); showMsg(''); }
      else if (k === KEY.PAUSE) { video.pause(); showMsg('Paused', true); }
      else if (k === KEY.RIGHT || k === KEY.FF) { video.currentTime += 30; showMsg('+30s'); }
      else if (k === KEY.LEFT || k === KEY.RW) { video.currentTime -= 15; showMsg('-15s'); }
      e.preventDefault();
      return;
    }

    if (view === 'trailer') {
      if (isBack(k) || k === KEY.STOP) { closeTrailer(); e.preventDefault(); }
      return;
    }

    if (view === 'detail') {
      var btns = visibleButtons();
      if (isBack(k)) { closeDetail(); }
      else if (k === KEY.LEFT && detailBtn > 0) { detailBtn--; updateButtons(); }
      else if (k === KEY.RIGHT && detailBtn < btns.length - 1) { detailBtn++; updateButtons(); }
      else if (k === KEY.ENTER && btns[detailBtn]) {
        if (btns[detailBtn].act === 'play') { play(); } else { openTrailer(); }
      }
      e.preventDefault();
      return;
    }

    /* home */
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
      if (window.tizen && tizen.application) { tizen.application.getCurrentApplication().exit(); }
    }
    updateFocus();
    e.preventDefault();
  });

  /* register remote keys on Tizen */
  try {
    if (window.tizen && tizen.tvinputdevice) {
      ['MediaPlay', 'MediaPause', 'MediaPlayPause', 'MediaStop', 'MediaFastForward', 'MediaRewind']
        .forEach(function (n) { try { tizen.tvinputdevice.registerKey(n); } catch (e) {} });
    }
  } catch (e) {}

  loadCatalog();
})();
