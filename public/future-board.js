/* ============================================================================
   MMA DIGITAL LABS — SCHEMATIC TELEMETRY  (build nova-3.2)
   ----------------------------------------------------------------------------
   Builds the eight numbered readout panels, the scored dial rings and the two
   bar traces, and keeps them fed from /api/telemetry/overview.

   Honesty rules
   -------------
   · Every number is a measured value from the telemetry payload. Nothing is
     synthesised, and a missing field renders as "—", never as zero.
   · The dial is lit from the readiness score app.js already printed on screen;
     this module never computes a second score.
   · Samples older than the stale threshold are labelled stale, the offline
     state says so in the ticker, and pause stops the polling outright.
   · The bar traces plot only samples taken in this page session, and the label
     says "this session" so they cannot be mistaken for lifetime analytics.

   Safety
   ------
   · Never throws into the host app; if the dashboard is not mounted the module
     does nothing.
   · Values are written with textContent only — no HTML interpolation.
   ============================================================================ */
(function (root) {
  'use strict';
  if (!root || !root.document) return;

  var POLL_MS = 5000;
  var MAX_SAMPLES = 36;
  var STALE_MS = 16000;
  var API_URL = '/api/telemetry/overview';

  // 270-degree gauge: 51 ticks every 2 points, five printed scale numbers.
  var GAUGE_START = 225;   // bottom-left, clockwise, gap at the bottom
  var GAUGE_SWEEP = 270;
  var GAUGE_TICKS = 51;
  var GAUGE_STEP = GAUGE_SWEEP / (GAUGE_TICKS - 1);
  var GAUGE_SCALE = [0, 25, 50, 75, 100];

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
    status: 'connecting',
    visible: true,
  };

  var PANELS = [
    { n: 1, side: 'l', key: 'active', label: 'Active bridge calls', sub: 'bridge listener' },
    { n: 2, side: 'l', key: 'ttfb', label: 'Avg TTFB', sub: 'p95 latency', meter: true },
    { n: 3, side: 'l', key: 'xfer', label: 'Transfer rate', sub: 'closer transfers', meter: true },
    { n: 4, side: 'l', key: 'dnc', label: 'DNC blocked', sub: 'suppressed outcomes' },
    { n: 5, side: 'r', key: 'calls', label: 'Retained calls', sub: 'bridge / browser', meter: true },
    { n: 6, side: 'r', key: 'uptime', label: 'Server uptime', sub: 'process uptime' },
    { n: 7, side: 'r', key: 'qa', label: 'QA checks passed', sub: 'configuration tests', meter: true },
    { n: 8, side: 'r', key: 'rss', label: 'Server RSS', sub: 'heap / rss', meter: true }
  ];

  // ---------------------------------------------------------------- helpers

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function byId(id) {
    return root.document.getElementById(id);
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

  function setText(id, text) {
    var node = byId(id);
    if (node && node.textContent !== text) node.textContent = text;
  }

  function setMeter(key, ratio) {
    var node = byId('bp-m-' + key);
    if (!node) return;
    var r = Math.max(0, Math.min(1, num(ratio) || 0));
    node.style.transform = 'scaleX(' + r.toFixed(3) + ')';
  }

  /** The readiness score exactly as app.js printed it. */
  function readinessScore() {
    var node = root.document.querySelector('#cmd-deck .cmd-score-main strong');
    if (!node) return null;
    var value = parseInt(String(node.textContent).replace(/[^0-9-]/g, ''), 10);
    if (!isFinite(value)) return null;
    return Math.max(0, Math.min(100, value));
  }

  // ------------------------------------------------------------- dial build

  function injectDial() {
    var main = root.document.querySelector('#cmd-deck .cmd-score-main');
    if (!main) return null;

    // Tag the "/100" label. Without this, any generic span rule would also
    // apply to the gauge spans and collapse their layout box.
    var spans = main.querySelectorAll(':scope > span');
    for (var i = 0; i < spans.length; i += 1) {
      if (!spans[i].className) spans[i].className = 'bp-denom';
    }

    if (!main.querySelector('.bp-gauge-fill')) {
      main.appendChild(el('span', 'bp-gauge-track')).setAttribute('aria-hidden', 'true');
      main.appendChild(el('span', 'bp-gauge-fill')).setAttribute('aria-hidden', 'true');

      var head = el('span', 'bp-gauge-head');
      head.setAttribute('aria-hidden', 'true');
      main.appendChild(head);

      var ticks = el('span', 'bp-gauge-ticks');
      ticks.setAttribute('aria-hidden', 'true');
      for (var t = 0; t < GAUGE_TICKS; t += 1) {
        var tick = document.createElement('i');
        tick.style.setProperty('--a', (GAUGE_START + t * GAUGE_STEP).toFixed(3) + 'deg');
        if (t % 5 === 0) tick.className = 'major';
        ticks.appendChild(tick);
      }
      main.appendChild(ticks);

      var scale = el('span', 'bp-gauge-scale');
      scale.setAttribute('aria-hidden', 'true');
      GAUGE_SCALE.forEach(function (value, index) {
        var mark = document.createElement('b');
        mark.textContent = String(value);
        mark.style.setProperty(
          '--a',
          (GAUGE_START + index * (GAUGE_SWEEP / (GAUGE_SCALE.length - 1))).toFixed(3) + 'deg'
        );
        scale.appendChild(mark);
      });
      main.appendChild(scale);

      var label = el('span', 'bp-dial-label', 'Readiness index');
      label.setAttribute('aria-hidden', 'true');
      main.insertBefore(label, main.firstChild);
    }

    return main;
  }

  /**
   * Drives the gauge from the score printed on screen.
   *
   * `--bp-value` is a registered custom property, so the arc stop, the head
   * marker and the lit ticks all follow one number. The first write starts at
   * zero and the second lets the transition sweep to the real score.
   */
  function syncDial() {
    var main = injectDial();
    if (!main) return;
    var score = readinessScore();
    if (score === null) return;

    var ticks = main.querySelector('.bp-gauge-ticks');
    if (ticks) {
      for (var i = 0; i < ticks.children.length; i += 1) {
        ticks.children[i].classList.toggle('on', i * 2 <= score);
      }
    }

    var current = main.style.getPropertyValue('--bp-value');
    if (current === '') {
      main.style.setProperty('--bp-value', '0');
      root.requestAnimationFrame(function () {
        root.requestAnimationFrame(function () {
          main.style.setProperty('--bp-value', String(score));
        });
      });
    } else if (Number(current) !== score) {
      main.style.setProperty('--bp-value', String(score));
    }

    main.style.setProperty('--hud-score', String(score));
    var card = main.closest('.cmd-score-card');
    if (card) card.style.setProperty('--hud-score', String(score));
  }

  // ------------------------------------------------------------ panel build

  function buildPanel(def) {
    var panel = el('article', 'bp-panel');
    panel.setAttribute('data-bp', String(def.n));
    panel.setAttribute('data-bp-panel', def.key);
    panel.setAttribute('data-side', def.side);
    panel.setAttribute('aria-label', 'Readout ' + def.n + ': ' + def.label);

    panel.appendChild(el('span', 'bp-id', (def.n < 10 ? '0' : '') + def.n));
    panel.appendChild(el('span', 'bp-label', def.label));

    var value = el('span', 'bp-value', '—');
    value.id = 'bp-v-' + def.key;
    panel.appendChild(value);

    var sub = el('span', 'bp-sub', '—');
    sub.id = 'bp-s-' + def.key;
    panel.appendChild(sub);

    if (def.meter) {
      var meter = el('span', 'bp-meter');
      var fill = document.createElement('i');
      fill.id = 'bp-m-' + def.key;
      meter.appendChild(fill);
      panel.appendChild(meter);
    }

    return panel;
  }

  function buildChart(key, title) {
    var chart = el('div', 'bp-chart');
    var head = el('div', 'bp-chart-head');
    head.appendChild(el('span', null, title));
    var val = el('span', 'bp-chart-val', 'collecting…');
    val.id = 'bp-chart-' + key + '-val';
    head.appendChild(val);
    chart.appendChild(head);
    var bars = el('div', 'bp-bars');
    bars.id = 'bp-bars-' + key;
    bars.setAttribute('role', 'img');
    bars.setAttribute('aria-label', title + ', samples taken in this page session');
    chart.appendChild(bars);
    return chart;
  }

  function buildStrip() {
    var strip = el('section', 'bp-strip');
    strip.setAttribute('aria-label', 'Session traces and live status');

    var head = el('div', 'bp-strip-head');
    head.appendChild(el('span', 'bp-strip-title', 'Session traces'));

    var source = el('span', 'bp-source', 'GET ' + API_URL + ' · ' + Math.round(POLL_MS / 1000) + 's');
    head.appendChild(source);

    var status = el('span', 'bp-status', 'connecting');
    status.id = 'bp-status';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    head.appendChild(status);

    var pause = el('button', 'bp-strip-btn', 'Pause');
    pause.type = 'button';
    pause.id = 'bp-pause';
    pause.setAttribute('aria-pressed', 'false');
    head.appendChild(pause);

    pause.addEventListener('click', function () {
      state.paused = !state.paused;
      pause.textContent = state.paused ? 'Resume' : 'Pause';
      pause.setAttribute('aria-pressed', state.paused ? 'true' : 'false');
      if (state.paused) {
        if (state.timer) root.clearTimeout(state.timer);
        state.timer = null;
        setStatus('paused', 'paused');
      } else {
        poll();
        schedule();
      }
    });

    strip.appendChild(head);

    var charts = el('div', 'bp-charts');
    charts.appendChild(buildChart('ttfb', 'TTFB · this session'));
    charts.appendChild(buildChart('calls', 'Call throughput · this session'));
    strip.appendChild(charts);

    var ticker = el('div', 'bp-ticker');
    ticker.appendChild(el('span', 'bp-ticker-tag', 'Signal'));
    var line = el('span', 'bp-ticker-line', 'Waiting for the first telemetry sample.');
    line.id = 'bp-ticker-line';
    ticker.appendChild(line);
    strip.appendChild(ticker);

    return strip;
  }

  // ------------------------------------------------------------------ state

  function setStatus(kind, text) {
    state.status = kind;
    var node = byId('bp-status');
    if (!node) return;
    node.textContent = text;
    node.classList.toggle('is-live', kind === 'live');
    node.classList.toggle('is-stale', kind === 'stale');
    node.classList.toggle('is-offline', kind === 'offline');
    node.classList.toggle('is-paused', kind === 'paused');
  }

  function drawBars(key, values, zeroBase) {
    var box = byId('bp-bars-' + key);
    if (!box) return;
    while (box.firstChild) box.removeChild(box.firstChild);

    var points = values.filter(function (v) { return num(v) !== null; });
    if (!points.length) {
      box.setAttribute('data-empty', '1');
      return;
    }
    box.removeAttribute('data-empty');

    var max = Math.max.apply(null, points);
    if (zeroBase) max = Math.max(max, 1);
    var min = zeroBase ? 0 : Math.min.apply(null, points);
    var span = max - min || 1;

    values.forEach(function (v, i) {
      var bar = document.createElement('i');
      var n = num(v);
      if (n === null) {
        bar.style.height = '0%';
      } else {
        var pct = 8 + ((n - min) / span) * 92;
        bar.style.height = Math.max(3, Math.min(100, pct)).toFixed(1) + '%';
      }
      if (i === values.length - 1) bar.className = 'hot';
      box.appendChild(bar);
    });
  }

  // ----------------------------------------------------------------- render

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
    var heap = num(runtime.heapMb);
    var qaPassed = num(inventory.qaPassed);
    var qaTotal = num(inventory.qaTotal);
    var listening = runtime.audioSocketListening === true;
    var retention = num(traffic.retentionLimits && traffic.retentionLimits.bridgeCalls);

    // 01 active bridge calls
    setText('bp-v-active', fmtInt(active));
    setText('bp-s-active', listening ? 'listener online' : 'listener offline');

    // 02 avg ttfb (meter is the 1 s budget, a real threshold)
    setText('bp-v-ttfb', fmtMs(ttfb));
    setText('bp-s-ttfb', p95 !== null && p95 > 0 ? 'p95 ' + fmtMs(p95) : 'p95 not reported');
    setMeter('ttfb', ttfb ? Math.min(1, ttfb / 1000) : 0);

    // 03 transfer rate
    setText('bp-v-xfer', fmtPct(xferRate));
    setText('bp-s-xfer', xferCount !== null ? fmtInt(xferCount) + ' closer transfers' : 'no transfer data');
    setMeter('xfer', xferRate ? xferRate / 100 : 0);

    // 04 dnc blocked
    setText('bp-v-dnc', fmtInt(dnc));
    setText('bp-s-dnc', 'suppressed outcomes');

    // 05 retained calls
    setText('bp-v-calls', fmtInt(calls));
    setText('bp-s-calls',
      (bridgeCalls === null ? '—' : fmtInt(bridgeCalls)) + ' bridge · ' +
      (simCalls === null ? '—' : fmtInt(simCalls)) + ' browser');
    setMeter('calls', retention && bridgeCalls ? Math.min(1, bridgeCalls / retention) : 0);

    // 06 uptime
    setText('bp-v-uptime', fmtDuration(uptime));
    setText('bp-s-uptime', 'process uptime');

    // 07 QA checks
    setText('bp-v-qa', qaTotal !== null && qaTotal > 0
      ? fmtInt(qaPassed) + '/' + fmtInt(qaTotal)
      : '—');
    setText('bp-s-qa', 'configuration tests');
    setMeter('qa', qaTotal ? (qaPassed || 0) / qaTotal : 0);

    // 08 server rss
    setText('bp-v-rss', rss === null ? '—' : fmtInt(rss) + ' MB');
    setText('bp-s-rss', heap === null ? 'heap not reported' : 'heap ' + fmtInt(heap) + ' MB');
    setMeter('rss', rss && heap ? Math.min(1, heap / rss) : 0);

    // Session traces
    drawBars('ttfb', state.samples.map(function (s) { return s.ttfb; }), false);
    drawBars('calls', state.samples.map(function (s) { return s.callDelta; }), true);

    var ttfbValues = state.samples
      .map(function (s) { return s.ttfb; })
      .filter(function (v) { return num(v) !== null; });
    if (ttfbValues.length) {
      var sum = ttfbValues.reduce(function (a, b) { return a + b; }, 0);
      setText('bp-chart-ttfb-val', 'mean ' + fmtMs(sum / ttfbValues.length));
    } else {
      setText('bp-chart-ttfb-val', 'collecting…');
    }

    var deltas = state.samples.map(function (s) { return s.callDelta; });
    if (deltas.length) {
      var added = deltas.reduce(function (a, b) { return a + (num(b) || 0); }, 0);
      setText('bp-chart-calls-val', (added > 0 ? '+' : '') + fmtInt(added) + ' calls');
    } else {
      setText('bp-chart-calls-val', 'collecting…');
    }

    // Ticker
    var line = byId('bp-ticker-line');
    if (line) {
      var domScore = readinessScore();
      line.textContent = '';
      line.appendChild(el('b', null, fmtInt(active) + ' active'));
      line.appendChild(root.document.createTextNode(
        ' · ' + fmtMs(ttfb) + ' TTFB · ' + fmtPct(xferRate) + ' transfer · ' +
        fmtInt(calls) + ' retained calls · readiness ' +
        (domScore === null ? '—' : domScore + '/100') +
        ' · sample ' + timeLabel(sample.at)
      ));
    }
  }

  // ---------------------------------------------------------------- polling

  function poll() {
    if (state.inFlight || state.paused) return;
    state.inFlight = true;

    var started = Date.now();
    root.fetch(API_URL + '?t=' + started, {
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
      var delta = callsTotal === null || state.prev === null ? 0 : Math.max(0, callsTotal - state.prev);
      state.samples.push({ at: Date.now(), ttfb: num(traffic.avgTtfbMs), callDelta: delta });
      if (state.samples.length > MAX_SAMPLES) state.samples.shift();
      state.prev = callsTotal;

      state.offline = false;
      state.lastFetchAt = Date.now();
      state.lastError = '';
      setStatus('live', 'live');
      render({ telemetry: telemetry, at: state.lastFetchAt });
    }).catch(function (err) {
      state.offline = true;
      state.lastError = (err && err.message) || 'unreachable';
      setStatus('offline', 'telemetry offline');
      var line = byId('bp-ticker-line');
      if (line) {
        line.textContent = 'No server telemetry: ' + state.lastError +
          '. No call figures are invented; the panels keep their last measured values.';
      }
    }).then(function () {
      state.inFlight = false;
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

  // -------------------------------------------------------------- mounting

  function mountPanels() {
    var shell = root.document.querySelector('#cmd-deck .cmd-deck-shell');
    if (!shell) return;

    var anchor = shell.querySelector('.readiness-issues');
    var mounted = shell.querySelector('[data-bp-panel]');

    if (!mounted) {
      var frag = root.document.createDocumentFragment();
      PANELS.forEach(function (def) { frag.appendChild(buildPanel(def)); });
      frag.appendChild(buildStrip());
      if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(frag, anchor);
      else shell.appendChild(frag);
    }

    injectDial();
    syncDial();

    if (!state.paused && !state.timer) {
      poll();
      schedule();
    }
  }

  function observeDeck() {
    if (state.observer) return;
    var target = root.document.getElementById('m') || root.document.body;
    state.observer = new MutationObserver(function () {
      if (!root.document.querySelector('#cmd-deck .cmd-deck-shell')) return;
      if (!root.document.querySelector('#cmd-deck [data-bp-panel]')) mountPanels();
      else syncDial();
    });
    state.observer.observe(target, { childList: true, subtree: true });
  }

  function boot() {
    observeDeck();
    mountPanels();

    root.document.addEventListener('visibilitychange', function () {
      state.visible = root.document.visibilityState !== 'hidden';
      if (state.visible) poll();
    });

    // The deck's own Sync button refreshes the panels too.
    root.document.addEventListener('click', function (event) {
      var btn = event.target && event.target.closest ? event.target.closest('#btn-cmd-refresh') : null;
      if (!btn) return;
      if (state.timer) root.clearTimeout(state.timer);
      state.timer = null;
      poll();
      schedule();
    }, true);

    root.addEventListener('beforeunload', function () {
      if (state.timer) root.clearTimeout(state.timer);
      if (state.observer) state.observer.disconnect();
    });
  }

  if (root.document.readyState === 'loading') {
    root.document.addEventListener('DOMContentLoaded', boot, { once: true });
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
