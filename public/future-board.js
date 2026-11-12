/* ============================================================================
   MMA DIGITAL LABS — LIVE TELEMETRY PANELS   (build nova-3.1)
   ----------------------------------------------------------------------------
   Adds two real-time panels to the dashboard and lights the readiness dial.

   Honesty rules this module follows:
     · Every number comes from a real source: /api/telemetry/overview, or the
       browser's own frame timing. Nothing is synthesised to look busy.
     · When the server is unreachable (static demo, signed-out, tunnel down) the
       board says so and shows only measurements it can actually take.
     · Samples older than the stale threshold are labelled stale rather than
       continuing to pulse as if live.
     · The rolling charts plot only samples collected in this page session, and
       say so, so nobody mistakes them for lifetime analytics.
     · The dial ticks are lit from the score app.js already printed on screen,
       never from a second, independent calculation.

   Failure rules:
     · Never throws into the host app; all work is wrapped and the panels
       simply stay absent if the dashboard is not mounted.
     · Values are written with textContent/dataset only — no HTML interpolation
       of server strings.
   ============================================================================ */
(function (root) {
  'use strict';
  if (!root || !root.document) return;

  var POLL_MS = 5000;
  var MAX_SAMPLES = 36;
  var STALE_MS = 16000;
  var API_URL = '/api/telemetry/overview';
  var RING_TICKS = 44;

  var state = {
    timer: null,
    observer: null,
    inFlight: false,
    paused: false,
    offline: true,
    lastFetchAt: 0,
    lastError: '',
    samples: [],
    prev: null,
    fps: null,
    fpsUnavailable: false,
    board: null,
    aux: null,
    visible: true,
  };

  // ---------------------------------------------------------------- helpers

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function num(value) {
    var n = Number(value);
    return isFinite(n) ? n : null;
  }

  function fmtInt(value) {
    var n = num(value);
    if (n === null) return '—';
    return Math.round(n).toLocaleString('en-US');
  }

  function fmtMs(value) {
    var n = num(value);
    if (n === null || n <= 0) return '—';
    return n >= 1000 ? (n / 1000).toFixed(2) + ' s' : Math.round(n) + ' ms';
  }

  function fmtPct(value) {
    var n = num(value);
    if (n === null) return '—';
    return (Math.round(n * 10) / 10).toFixed(1) + '%';
  }

  function fmtDuration(seconds) {
    var s = num(seconds);
    if (s === null || s < 0) return '—';
    var d = Math.floor(s / 86400);
    var h = Math.floor((s % 86400) / 3600);
    var m = Math.floor((s % 3600) / 60);
    if (d > 0) return d + 'd ' + h + 'h';
    if (h > 0) return h + 'h ' + m + 'm';
    return m + 'm ' + Math.floor(s % 60) + 's';
  }

  function timeLabel(ts) {
    if (!ts) return '—';
    try {
      return new Date(ts).toLocaleTimeString([], { hour12: false });
    } catch (e) {
      return '—';
    }
  }

  function tickValue(node, text, changed) {
    if (!node) return;
    if (node.textContent === text) return;
    node.textContent = text;
    if (changed) {
      node.classList.remove('is-tick');
      void node.offsetWidth; // restart the animation on consecutive updates
      node.classList.add('is-tick');
    }
  }

  /** The readiness score as app.js printed it. Null when not on the dashboard. */
  function readinessScore() {
    var node = document.querySelector('#cmd-deck .cmd-score-main strong');
    if (!node) return null;
    var value = parseInt(String(node.textContent).replace(/[^0-9-]/g, ''), 10);
    if (!isFinite(value)) return null;
    return Math.max(0, Math.min(100, value));
  }

  // ------------------------------------------------------- dial + score sync

  /**
   * Lights the dial ticks for the score that is already on screen and mirrors
   * it into --hud-score for any CSS that wants it. Called on mount and on every
   * deck re-render, because app.js rewrites the dashboard markup.
   */
  function syncDial() {
    var ring = document.querySelector('#cmd-deck .fx-ring');
    if (!ring) {
      injectRing();
      ring = document.querySelector('#cmd-deck .fx-ring');
    }
    var score = readinessScore();
    if (score === null) return;
    var lit = Math.round((score / 100) * RING_TICKS);
    var ticks = ring ? ring.children : [];
    for (var i = 0; i < ticks.length; i += 1) {
      ticks[i].classList.toggle('on', i < lit);
    }
    var shell = document.querySelector('#cmd-deck .cmd-deck-shell');
    if (shell && shell.style) shell.style.setProperty('--hud-score', String(score));
  }

  function injectRing() {
    var main = document.querySelector('#cmd-deck .cmd-score-main');
    if (!main || main.querySelector('.fx-ring')) return;
    var ring = el('span', 'fx-ring');
    ring.setAttribute('aria-hidden', 'true');
    for (var i = 0; i < RING_TICKS; i += 1) {
      var tick = document.createElement('i');
      tick.style.setProperty('--a', (i * (360 / RING_TICKS)).toFixed(3) + 'deg');
      ring.appendChild(tick);
    }
    main.appendChild(ring);
  }

  // ------------------------------------------------------------- board build

  function tile(label, valueId, subId) {
    var box = el('div', 'fx-tile');
    box.appendChild(el('div', 'fx-tile-label', label));
    var value = el('div', 'fx-tile-value', '—');
    value.id = valueId;
    box.appendChild(value);
    var sub = el('div', 'fx-tile-sub', '—');
    sub.id = subId;
    box.appendChild(sub);
    return box;
  }

  function chart(id, title) {
    var box = el('div', 'fx-chart');
    var head = el('div', 'fx-chart-head');
    head.appendChild(el('div', 'fx-chart-title', title));
    var now = el('div', 'fx-chart-now', 'collecting…');
    now.id = id + '-now';
    head.appendChild(now);
    box.appendChild(head);
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'fx-spark');
    svg.setAttribute('viewBox', '0 0 100 40');
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', title + ' rolling session trend');
    svg.id = id;
    box.appendChild(svg);
    return box;
  }

  function rail(labelId, trackId) {
    var box = el('div', 'fx-rail');
    var lbl = el('div', 'fx-rail-lbl');
    var name = el('span', null, '—');
    name.id = labelId;
    var val = el('span', null, '—');
    val.id = labelId + '-val';
    lbl.appendChild(name);
    lbl.appendChild(val);
    box.appendChild(lbl);
    var track = el('div', 'fx-rail-track');
    var fill = el('span', 'fx-rail-fill');
    fill.id = trackId;
    fill.style.transform = 'scaleX(0)';
    track.appendChild(fill);
    box.appendChild(track);
    return box;
  }

  function boardHead(titleText, statusId) {
    var head = el('div', 'fx-board-head');
    var title = el('div', 'fx-board-title');
    title.appendChild(el('span', 'fx-live-dot'));
    title.appendChild(el('span', null, titleText));
    head.appendChild(title);

    var status = el('div', 'fx-board-meta');
    var statusText = el('span', null, 'connecting…');
    statusText.id = statusId;
    statusText.setAttribute('role', 'status');
    statusText.setAttribute('aria-live', 'polite');
    status.appendChild(statusText);

    var source = el('span', null, 'rolling session window');
    source.id = 'fx-board-source';
    status.appendChild(source);

    var updated = el('span', null, '—');
    updated.id = 'fx-board-updated';
    status.appendChild(updated);

    var pause = el('button', 'fx-board-btn', 'Pause');
    pause.type = 'button';
    pause.id = 'fx-board-pause';
    pause.setAttribute('aria-pressed', 'false');
    status.appendChild(pause);
    head.appendChild(status);

    pause.addEventListener('click', function () {
      state.paused = !state.paused;
      pause.textContent = state.paused ? 'Resume' : 'Pause';
      pause.setAttribute('aria-pressed', state.paused ? 'true' : 'false');
      if (!state.paused) {
        poll();
        schedule();
      } else {
        if (state.timer) root.clearTimeout(state.timer);
        state.timer = null;
        setStatus('paused', 'paused by operator');
      }
    });

    return head;
  }

  function buildBoard() {
    var board = el('section', 'fx-board is-offline');
    board.setAttribute('aria-label', 'Live performance telemetry');
    board.setAttribute('data-fx-board', '1');
    board.appendChild(boardHead('Live Performance', 'fx-board-status'));

    var grid = el('div', 'fx-board-grid');
    grid.appendChild(tile('Active bridge calls', 'fx-active', 'fx-active-sub'));
    grid.appendChild(tile('Avg TTFB', 'fx-ttfb', 'fx-ttfb-sub'));
    grid.appendChild(tile('Transfer rate', 'fx-xfer', 'fx-xfer-sub'));
    grid.appendChild(tile('DNC blocked', 'fx-dnc', 'fx-dnc-sub'));
    grid.appendChild(tile('Retained calls', 'fx-calls', 'fx-calls-sub'));
    grid.appendChild(tile('Server uptime', 'fx-uptime', 'fx-uptime-sub'));
    board.appendChild(grid);

    var charts = el('div', 'fx-charts');
    charts.appendChild(chart('fx-spark-ttfb', 'TTFB trend'));
    charts.appendChild(chart('fx-spark-calls', 'Call throughput'));
    board.appendChild(charts);

    return board;
  }

  function buildAux() {
    var aux = el('section', 'fx-aux is-offline');
    aux.setAttribute('aria-label', 'Signal detail and session ticker');
    aux.setAttribute('data-fx-aux', '1');
    aux.appendChild(boardHead('Signal Detail', 'fx-aux-status'));

    var rails = el('div', 'fx-rails');
    rails.appendChild(rail('fx-rail-ttfb', 'fx-fill-ttfb'));
    rails.appendChild(rail('fx-rail-budget', 'fx-fill-budget'));
    rails.appendChild(rail('fx-rail-heap', 'fx-fill-heap'));
    rails.appendChild(rail('fx-rail-retention', 'fx-fill-retention'));
    aux.appendChild(rails);

    var ticker = el('div', 'fx-ticker');
    ticker.appendChild(el('span', 'fx-ticker-tag', 'SIGNAL'));
    var line = el('div', 'fx-ticker-line', 'Waiting for the first telemetry sample.');
    line.id = 'fx-ticker-line';
    ticker.appendChild(line);
    aux.appendChild(ticker);

    return aux;
  }

  // ------------------------------------------------------------ status text

  function setStatus(kind, text) {
    [state.board, state.aux].forEach(function (panel) {
      if (!panel) return;
      panel.classList.toggle('is-offline', kind === 'offline');
      panel.classList.toggle('is-stale', kind === 'stale');
    });
    var status = document.getElementById('fx-board-status');
    if (status) status.textContent = text;
    var auxStatus = document.getElementById('fx-aux-status');
    if (auxStatus) auxStatus.textContent = text;
  }

  // ------------------------------------------------------------ sparkline draw

  function drawSpark(svg, values, opts) {
    if (!svg) return;
    var options = opts || {};
    while (svg.firstChild) svg.removeChild(svg.firstChild);

    for (var g = 1; g <= 3; g += 1) {
      var line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('class', 'fx-spark-grid');
      line.setAttribute('x1', '0');
      line.setAttribute('x2', '100');
      line.setAttribute('y1', String((40 / 4) * g));
      line.setAttribute('y2', String((40 / 4) * g));
      svg.appendChild(line);
    }

    var points = values.filter(function (v) { return num(v) !== null; });
    if (points.length < 2) {
      var hint = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      hint.setAttribute('x', '50');
      hint.setAttribute('y', '24');
      hint.setAttribute('text-anchor', 'middle');
      hint.setAttribute('fill', 'currentColor');
      hint.setAttribute('opacity', '0.35');
      hint.setAttribute('font-size', '5');
      hint.textContent = 'collecting samples…';
      svg.appendChild(hint);
      return;
    }

    var min = Math.min.apply(null, points);
    var max = Math.max.apply(null, points);
    if (options.zeroBase) min = 0;
    var span = max - min || 1;
    var stepX = 100 / Math.max(1, points.length - 1);

    var coords = points.map(function (v, i) {
      var x = i * stepX;
      var y = 37 - ((v - min) / span) * 34;
      return [x, Math.max(3, Math.min(37, y))];
    });

    var path = coords.map(function (p, i) {
      return (i ? 'L' : 'M') + p[0].toFixed(2) + ' ' + p[1].toFixed(2);
    }).join(' ');

    var area = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    area.setAttribute('class', 'fx-spark-area');
    area.setAttribute('d', path + ' L100 40 L0 40 Z');
    area.setAttribute('fill', 'var(--ac)');
    svg.appendChild(area);

    var stroke = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    stroke.setAttribute('class', 'fx-spark-line');
    stroke.setAttribute('d', path);
    svg.appendChild(stroke);

    var last = coords[coords.length - 1];
    var dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    dot.setAttribute('class', 'fx-spark-dot');
    dot.setAttribute('cx', last[0].toFixed(2));
    dot.setAttribute('cy', last[1].toFixed(2));
    dot.setAttribute('r', '1.6');
    svg.appendChild(dot);
  }

  // ------------------------------------------------------------- client perf

  /**
   * Measures real composed frame timing. requestAnimationFrame does not fire in
   * a hidden or throttled tab, so a watchdog marks the sample as unavailable
   * instead of leaving the rail on "sampling…" forever.
   */
  function sampleFrameBudget() {
    if (typeof root.requestAnimationFrame !== 'function') return;
    if (root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    var frames = 0;
    var start = 0;
    var done = false;
    state.fpsUnavailable = false;
    var watchdog = root.setTimeout(function () {
      if (done) return;
      done = true;
      state.fpsUnavailable = true;
      var budget = frameBudget();
      var fill = document.getElementById('fx-fill-budget');
      var val = document.getElementById('fx-rail-budget-val');
      if (fill) fill.style.transform = 'scaleX(0)';
      if (val) val.textContent = budget.text;
    }, 1400);
    function frame(now) {
      if (done) return;
      if (!start) start = now;
      frames += 1;
      if (now - start < 700) {
        root.requestAnimationFrame(frame);
      } else {
        done = true;
        root.clearTimeout(watchdog);
        var fps = (frames / (now - start)) * 1000;
        state.fps = Math.max(0, Math.min(240, fps));
      }
    }
    try {
      root.requestAnimationFrame(frame);
    } catch (e) {
      root.clearTimeout(watchdog);
      state.fpsUnavailable = true;
    }
  }

  // ------------------------------------------------------------------ render

  function render(sample) {
    var t = sample.telemetry || {};
    var traffic = t.traffic || {};
    var runtime = t.runtime || {};
    var inventory = t.inventory || {};

    var active = num(traffic.activeCalls);
    var ttfb = num(traffic.avgTtfbMs);
    var p95 = num(traffic.p95TtfbMs);
    var xferRate = num(traffic.transferRatePct);
    var xferCount = num(traffic.closerTransfers);
    var dnc = num(traffic.dncBlocked);
    var calls = num(traffic.totalCallsAllChannels);
    var bridgeCalls = num(traffic.totalBridgeCalls);
    var simCalls = num(traffic.totalSimulatorCalls);
    var uptime = num(runtime.uptimeSec);
    var rss = num(runtime.rssMb);
    var qaPassed = num(inventory.qaPassed);
    var qaTotal = num(inventory.qaTotal);
    var listening = runtime.audioSocketListening === true;

    tickValue(document.getElementById('fx-active'),
      active === null ? '—' : fmtInt(active), active !== null);
    tickValue(document.getElementById('fx-active-sub'),
      listening ? 'bridge listener online' : 'bridge listener offline', false);

    tickValue(document.getElementById('fx-ttfb'), fmtMs(ttfb), true);
    tickValue(document.getElementById('fx-ttfb-sub'),
      p95 !== null && p95 > 0 ? 'p95 ' + fmtMs(p95) : 'p95 not reported', false);

    tickValue(document.getElementById('fx-xfer'), fmtPct(xferRate), true);
    tickValue(document.getElementById('fx-xfer-sub'),
      xferCount !== null ? fmtInt(xferCount) + ' closer transfers' : 'no transfer data', false);

    tickValue(document.getElementById('fx-dnc'), fmtInt(dnc), true);
    tickValue(document.getElementById('fx-dnc-sub'), 'suppressed outcomes', false);

    tickValue(document.getElementById('fx-calls'), fmtInt(calls), true);
    tickValue(document.getElementById('fx-calls-sub'),
      (bridgeCalls === null ? '—' : fmtInt(bridgeCalls)) + ' bridge · ' +
      (simCalls === null ? '—' : fmtInt(simCalls)) + ' browser', false);

    tickValue(document.getElementById('fx-uptime'), fmtDuration(uptime), false);
    tickValue(document.getElementById('fx-uptime-sub'),
      qaTotal !== null ? 'QA ' + fmtInt(qaPassed) + '/' + fmtInt(qaTotal) + ' passed' : 'QA not reported', false);

    // ---- rolling charts (session window only)
    var ttfbHistory = state.samples.map(function (s) { return s.ttfb; });
    var callHistory = state.samples.map(function (s) { return s.callDelta; });
    drawSpark(document.getElementById('fx-spark-ttfb'), ttfbHistory, { zeroBase: false });
    drawSpark(document.getElementById('fx-spark-calls'), callHistory, { zeroBase: true });

    var ttfbNow = document.getElementById('fx-spark-ttfb-now');
    if (ttfbNow) {
      var recent = ttfbHistory.filter(function (v) { return num(v) !== null; });
      if (recent.length) {
        var sum = recent.reduce(function (a, b) { return a + b; }, 0);
        ttfbNow.textContent = 'mean ' + fmtMs(sum / recent.length);
      }
    }
    var callsNow = document.getElementById('fx-spark-calls-now');
    if (callsNow) {
      var deltas = callHistory.filter(function (v) { return num(v) !== null; });
      var added = deltas.reduce(function (a, b) { return a + b; }, 0);
      callsNow.textContent = (added > 0 ? '+' : '') + fmtInt(added) + ' calls';
    }

    // ---- rails
    function setRail(labelId, fillId, label, ratio, valueText) {
      var lbl = document.getElementById(labelId);
      var val = document.getElementById(labelId + '-val');
      var fill = document.getElementById(fillId);
      if (lbl) lbl.textContent = label;
      if (val) val.textContent = valueText;
      if (fill) fill.style.transform = 'scaleX(' + Math.max(0, Math.min(1, ratio || 0)).toFixed(3) + ')';
    }

    setRail('fx-rail-ttfb', 'fx-fill-ttfb', 'TTFB / 1 s budget',
      ttfb ? Math.min(1, ttfb / 1000) : 0, ttfb ? fmtMs(ttfb) : '—');
    var budget = frameBudget();
    setRail('fx-rail-budget', 'fx-fill-budget', 'Frame budget', budget.ratio, budget.text);
    setRail('fx-rail-heap', 'fx-fill-heap', 'Server RSS',
      rss ? Math.min(1, rss / 1024) : 0, rss ? rss + ' MB' : '—');
    var retention = num(traffic.retentionLimits && traffic.retentionLimits.bridgeCalls);
    setRail('fx-rail-retention', 'fx-fill-retention', 'Retained bridge history',
      retention && bridgeCalls ? Math.min(1, bridgeCalls / retention) : 0,
      retention ? fmtInt(bridgeCalls) + '/' + fmtInt(retention) : 'no cap reported');

    // ---- ticker (readiness is read from the number on screen, not recomputed)
    var line = document.getElementById('fx-ticker-line');
    if (line) {
      var domScore = readinessScore();
      line.textContent = '';
      line.appendChild(el('b', null, fmtInt(active) + ' active'));
      line.appendChild(document.createTextNode(
        ' · ' + fmtMs(ttfb) + ' TTFB · ' + fmtPct(xferRate) + ' transfer · ' +
        fmtInt(calls) + ' retained calls · readiness ' +
        (domScore === null ? '—' : domScore + '/100') +
        ' · sample ' + timeLabel(sample.at)
      ));
    }

    var updated = document.getElementById('fx-board-updated');
    if (updated) updated.textContent = 'sampled ' + timeLabel(sample.at);

    var source = document.getElementById('fx-board-source');
    if (source) source.textContent = 'GET ' + API_URL + ' · ' + Math.round(POLL_MS / 1000) + 's';
  }

  // ------------------------------------------------------------- frame budget

  /**
   * Client-side frame timing is the only figure these panels can produce
   * without the server. It is reported together with the reason it is
   * unavailable, so "not sampled" is never a silent gap.
   */
  function frameBudget() {
    if (state.fps !== null) {
      return { ratio: Math.min(1, state.fps / 60), text: Math.round(state.fps) + ' fps' };
    }
    if (root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      return { ratio: 0, text: 'off (reduced motion)' };
    }
    if (document.hidden) return { ratio: 0, text: 'paused (tab hidden)' };
    if (typeof root.requestAnimationFrame !== 'function') return { ratio: 0, text: 'not supported' };
    if (state.fpsUnavailable) return { ratio: 0, text: 'unavailable (no frames)' };
    return { ratio: 0, text: 'sampling…' };
  }

  // ---------------------------------------------------------------- fetching

  function poll() {
    if (state.inFlight || state.paused) return;
    state.inFlight = true;
    var started = Date.now();

    var url = API_URL + '?t=' + started;
    root.fetch(url, {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var ct = String(res.headers.get('content-type') || '').toLowerCase();
      if (ct.indexOf('application/json') === -1) throw new Error('non-JSON response');
      return res.json();
    }).then(function (data) {
      if (!data || !data.ok || !data.telemetry) throw new Error('telemetry payload missing');
      var telemetry = data.telemetry;
      var traffic = telemetry.traffic || {};
      var callsTotal = num(traffic.totalCallsAllChannels);
      var sample = { at: Date.now(), ttfb: num(traffic.avgTtfbMs) };
      // Record the throughput delta before overwriting state.prev.
      var delta = callsTotal === null || state.prev === null ? 0 : Math.max(0, callsTotal - state.prev);
      state.samples.push({ at: sample.at, ttfb: sample.ttfb, callDelta: delta });
      if (state.samples.length > MAX_SAMPLES) state.samples.shift();
      state.prev = callsTotal;

      state.offline = false;
      state.lastFetchAt = sample.at;
      state.lastError = '';
      setStatus('live', 'live');
      render({ telemetry: telemetry, at: sample.at });
      sampleFrameBudget();
    }).catch(function (err) {
      state.offline = true;
      state.lastError = (err && err.message) || 'unreachable';
      setStatus('offline', 'telemetry offline');
      var line = document.getElementById('fx-ticker-line');
      if (line) {
        line.textContent = 'No server telemetry: ' + state.lastError +
          '. Showing local frame timing only; no call figures are invented.';
      }
      var updated = document.getElementById('fx-board-updated');
      if (updated) updated.textContent = 'retrying…';
      var budget = frameBudget();
      var fill = document.getElementById('fx-fill-budget');
      var val = document.getElementById('fx-rail-budget-val');
      if (fill) fill.style.transform = 'scaleX(' + budget.ratio.toFixed(3) + ')';
      if (val) val.textContent = budget.text;
      sampleFrameBudget();
    }).then(function () {
      state.inFlight = false;
      // A sample that never lands must not keep pulsing as "live".
      if (!state.offline && Date.now() - state.lastFetchAt > STALE_MS) {
        setStatus('stale', 'stale sample');
      }
    });
  }

  function schedule() {
    if (state.timer) root.clearTimeout(state.timer);
    if (state.paused) return;
    state.timer = root.setTimeout(function () {
      if (state.visible) poll();
      schedule();
    }, POLL_MS);
  }

  // ------------------------------------------------------------- mounting

  function mountPanels() {
    var shell = document.querySelector('#cmd-deck .cmd-deck-shell');
    if (!shell) {
      state.board = null;
      state.aux = null;
      return;
    }

    var anchor = shell.querySelector('.readiness-issues');

    var board = shell.querySelector('[data-fx-board]');
    if (!board) {
      board = buildBoard();
      if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(board, anchor);
      else shell.appendChild(board);
    }

    var aux = shell.querySelector('[data-fx-aux]');
    if (!aux) {
      aux = buildAux();
      if (board.parentNode) board.parentNode.insertBefore(aux, board.nextSibling);
      else shell.appendChild(aux);
    }

    state.board = board;
    state.aux = aux;

    injectRing();
    syncDial();
  }

  /**
   * The dashboard is re-rendered by app.js on every state change (it rewrites
   * the deck's innerHTML), so the panels and the dial are re-attached whenever
   * they disappear. The observer is created once, in boot().
   */
  function observeDeck() {
    if (state.observer) return;
    var target = document.getElementById('m') || document.body;
    state.observer = new MutationObserver(function () {
      if (!document.querySelector('#cmd-deck .cmd-deck-shell')) {
        state.board = null;
        state.aux = null;
        return;
      }
      if (!document.querySelector('#cmd-deck [data-fx-board]')) mountPanels();
      else syncDial();
    });
    state.observer.observe(target, { childList: true, subtree: true });
  }

  function boot() {
    observeDeck();
    mountPanels();
    if (!state.timer && !state.paused) {
      poll();
      schedule();
    }

    document.addEventListener('visibilitychange', function () {
      state.visible = document.visibilityState !== 'hidden';
      if (state.visible) poll();
    });

    // The deck's own Sync button refreshes these panels too.
    document.addEventListener('click', function (event) {
      var btn = event.target && event.target.closest ? event.target.closest('#btn-cmd-refresh') : null;
      if (btn) {
        if (state.timer) root.clearTimeout(state.timer);
        state.timer = null;
        poll();
        schedule();
      }
    }, true);

    root.addEventListener('beforeunload', function () {
      if (state.timer) root.clearTimeout(state.timer);
      if (state.observer) state.observer.disconnect();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }

  root.VACFutureBoard = {
    refresh: poll,
    isOffline: function () { return state.offline; },
    samples: function () { return state.samples.slice(); },
    syncDial: syncDial,
    POLL_MS: POLL_MS,
  };
})(typeof window === 'undefined' ? null : window);
