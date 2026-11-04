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
      var done = function () {
        pending--;
        if (pending > 0) { return; }
        rows = [];
        var seenArchive = {};
        for (var i = 0; i < results.length; i++) {
          if (!results[i]) { continue; }
          /* Internet Archive rows overlap a lot: show each film only once, in the first row it appears. */
          results[i].items = results[i].items.filter(function (it) {
            if (!it.archive) { return true; }
            var keys = [it.id, 't:' + norm(it.title)];
            if (seenArchive[keys[0]] || seenArchive[keys[1]]) { return false; }
            seenArchive[keys[0]] = seenArchive[keys[1]] = true;
            return true;
          });
          if (results[i].items.length) { rows.push(results[i]); }
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
                archive: true,
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
        
        var badge = document.createElement('div');
        badge.className = 'badge';
        badge.textContent = '▶ STREAM';
        card.appendChild(badge);
        
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

  var homeRows = null; /* the normal catalog, saved while search results are shown */

  function openSearch() {
    var inp = $('search-input');
    inp.value = '';
    $('search').className = '';
    view = 'search';
    setTimeout(function () { inp.focus(); }, 50);
  }

  function closeSearch() {
    $('search-input').blur();
    $('search').className = 'hidden';
    view = 'home';
  }

  function leaveResults() {
    if (!homeRows) { return false; }
    rows = homeRows;
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

  function updateFocus() {
    $('searchbtn').className = 'sbtn' + (focus.r === -1 ? ' focus' : '');
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

  var detailBtn = 0;

  function visibleButtons() {
    var list = [];
    if (current) { list.push({ el: $('detail-play'), act: 'play' }); }
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

  function renderWhere(item) {
    var box = $('detail-where');
    box.innerHTML = '';
    if (!item) { return; }
    var d = document.createElement('div');
    d.className = 'where-free';
    d.textContent = '▶ Ready to stream instantly via VidCore Player (Press Play)';
    box.appendChild(d);
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

  function closeDetail() { $('detail').className = 'hidden'; view = 'home'; }

  function showMsg(t, keep) {
    var m = $('player-msg');
    m.textContent = t || '';
    clearTimeout(msgTimer);
    if (t && !keep) { msgTimer = setTimeout(function () { m.textContent = ''; }, 2000); }
  }

  function play() {
    $('player').className = '';
    view = 'player';
    if (current.archive) {
      /* Free Internet Archive films play in archive.org's own player. */
      vidcoreFrame.src = ARCHIVE + '/embed/' + encodeURIComponent(current.id);
      showMsg('Loading film...', true);
      return;
    }
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
    vidcoreFrame.src = 'about:blank';
    $('player').className = 'hidden';
    $('detail').className = '';
    view = 'detail';
  }

  var KEY = { LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40, ENTER: 13, BACK: 10009, ESC: 27, BKSP: 8,
              PLAY: 415, PAUSE: 19, PLAYPAUSE: 10252, STOP: 413, FF: 417, RW: 412 };

  function isBack(k) { return k === KEY.BACK || k === KEY.ESC || k === KEY.BKSP; }

  document.addEventListener('keydown', function (e) {
    var k = e.keyCode;

    if (view === 'player') {
      if (isBack(k) || k === KEY.STOP) { stop(); e.preventDefault(); }
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

    if (view === 'search') {
      /* let the on-screen keyboard / input handle typing; only Enter and Back are ours */
      if (k === KEY.ENTER) { doSearch($('search-input').value); e.preventDefault(); }
      else if (k === KEY.BACK || k === KEY.ESC) { closeSearch(); e.preventDefault(); }
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
  });

  try {
    if (window.tizen && tizen.tvinputdevice) {
      ['MediaPlay', 'MediaPause', 'MediaPlayPause', 'MediaStop', 'MediaFastForward', 'MediaRewind']
        .forEach(function (n) { try { tizen.tvinputdevice.registerKey(n); } catch (e) {} });
    }
  } catch (e) {}

  loadCatalog();
})();