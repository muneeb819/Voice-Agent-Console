/* MMA Digital Labs — Voice Agent Console
   Sign in / Create account controller (Node Backend + Iframe CHIPS/Bearer Handoff + Static Cloud Mode). */
(function () {
  'use strict';

  var AUTH_TOKEN_KEY = 'vac_auth_token';
  var CLOUD_USERS_KEY = 'vac_cloud_users_v1';
  var CLOUD_SESSION_KEY = 'vac_cloud_session_v1';

  var rawPath = String(location.pathname || '/');
  var isStaticHtmlPath = /\.html$/i.test(rawPath);
  var staticDemoReady = false;
  var basePrefix = rawPath.replace(/\/(login(?:\.html)?|signup(?:\.html)?)$/i, '');
  if (basePrefix === '/') basePrefix = '';

  function apiPath(rel) {
    return (basePrefix || '') + rel;
  }

  // Browser sessions are cookie-only. Clear credentials written by older versions.
  function saveAuthToken() { clearAuthToken(); }

  function readAuthToken() {
    try {
      return sessionStorage.getItem(AUTH_TOKEN_KEY) || localStorage.getItem(AUTH_TOKEN_KEY) || '';
    } catch (e) {
      return '';
    }
  }

  function clearAuthToken() {
    try { sessionStorage.removeItem(AUTH_TOKEN_KEY); } catch (e) {}
    try { localStorage.removeItem(AUTH_TOKEN_KEY); } catch (e) {}
  }

  function markStaticDemo() {
    staticDemoReady = true;
    var note = document.getElementById('auth-security-note');
    if (note) note.textContent = 'Static demo only: accounts are stored in this browser and do not secure a server. Do not use a real password.';
  }

  async function sha256Hex(input) {
    if (window.crypto && window.crypto.subtle && window.TextEncoder) {
      var bytes = new TextEncoder().encode(input);
      var digest = await window.crypto.subtle.digest('SHA-256', bytes);
      return Array.prototype.map.call(new Uint8Array(digest), function (b) {
        return ('00' + b.toString(16)).slice(-2);
      }).join('');
    }
    // Deterministic fallback hash if non-secure context lacks WebCrypto
    var h = 2166136261;
    for (var i = 0; i < input.length; i++) {
      h ^= input.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(16);
  }

  function readCloudUsers() {
    try {
      var parsed = JSON.parse(localStorage.getItem(CLOUD_USERS_KEY) || '[]');
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      return [];
    }
  }

  function writeCloudUsers(users) {
    try { localStorage.setItem(CLOUD_USERS_KEY, JSON.stringify(users)); } catch (e) {}
  }

  function writeCloudSession(user) {
    try {
      localStorage.setItem(CLOUD_SESSION_KEY, JSON.stringify({
        user: user,
        signedInAt: new Date().toISOString()
      }));
    } catch (e) {}
  }

  function readCloudSession() {
    try {
      var parsed = JSON.parse(localStorage.getItem(CLOUD_SESSION_KEY) || 'null');
      return parsed && parsed.user ? parsed : null;
    } catch (e) {
      return null;
    }
  }

  try {
    var savedApp = JSON.parse(localStorage.getItem('vac_appearance_v2') || localStorage.getItem('vac_appearance_v1') || '{}');
    if (savedApp && savedApp.theme) {
      document.documentElement.dataset.theme = savedApp.theme;
    }
  } catch (e) {}

  // ---------------------------------------------------------------- Active Playing Soundwave Engine
  (function initPlayingLogoSoundwaves() {
    var plaque = document.getElementById('login-brand-plaque');
    if (!plaque) return;
    var bars = Array.prototype.slice.call(plaque.querySelectorAll('.eq-bar'));
    if (!bars.length) return;

    plaque.classList.add('raf-driven');

    // Envelope weights shaped like a live vocal spectrum (tapered outer edges, rich mid-formants)
    var envelopeByCh = [0.46, 0.64, 0.86, 0.68, 0.92, 1.00, 0.76, 0.94, 0.62, 0.84, 0.96, 0.58];
    var barMeta = bars.map(function (el, idx) {
      var ch = Number(el.getAttribute('data-ch') || idx % 12);
      var isRight = el.getAttribute('data-side') === 'R';
      return {
        el: el,
        ch: ch,
        distFromM: 11 - ch,
        stereoOffset: isRight ? 0.52 : 0.0,
        env: envelopeByCh[ch] || 0.75,
        freqA: 5.4 + (ch % 5) * 0.85,
        freqB: 8.9 + ((ch * 3) % 7) * 0.62
      };
    });

    var hoverBoost = 0;
    var typingBoost = 0;
    plaque.addEventListener('mouseenter', function () { hoverBoost = 1; });
    plaque.addEventListener('mouseleave', function () { hoverBoost = 0; });
    document.addEventListener('input', function () { typingBoost = 1; }, { passive: true });

    var currentEnergy = 0;
    function tick(nowMs) {
      if (!document.hidden) {
        var t = nowMs * 0.001;
        typingBoost *= 0.94;
        var targetEnergy = Math.max(hoverBoost * 0.28, typingBoost * 0.34);
        currentEnergy += (targetEnergy - currentEnergy) * 0.12;

        // Natural AI speech cadence (active playing syllables + brief vocal phrasing)
        var speechCadence =
          0.68 +
          0.22 * Math.sin(t * 2.7) +
          0.14 * Math.sin(t * 6.1 + 0.8) +
          currentEnergy;

        for (var i = 0; i < barMeta.length; i++) {
          var b = barMeta[i];
          var travelPhase = b.distFromM * 0.38 + b.stereoOffset;
          var w1 = Math.sin(t * b.freqA - travelPhase);
          var w2 = Math.sin(t * b.freqB + travelPhase * 0.7);
          var w3 = Math.cos(t * 3.6 - b.ch * 0.55);
          var norm = 0.5 + 0.26 * w1 + 0.15 * w2 + 0.09 * w3; // ~[0.0 .. 1.0]
          var amp = Math.max(0.14, Math.min(1.06, norm * b.env * speechCadence * 1.38));
          var h = 10 + amp * 76; // 10px min .. 86px peak centered at y = 105
          var y = 105 - h * 0.5;
          var op = 0.68 + amp * 0.32;
          b.el.setAttribute('y', y.toFixed(1));
          b.el.setAttribute('height', h.toFixed(1));
          b.el.setAttribute('opacity', Math.min(1, op).toFixed(2));
        }
      }
      window.requestAnimationFrame(tick);
    }

    window.requestAnimationFrame(tick);
  })();

  var loader = document.getElementById('loader');
  var loaderText = document.getElementById('loader-text');
  var progressBar = document.getElementById('progress-bar');
  var tabs = Array.prototype.slice.call(document.querySelectorAll('.tab'));
  var panes = {
    signin: document.getElementById('signin-form'),
    signup: document.getElementById('signup-form'),
    admin: document.getElementById('admin-form')
  };

  function setMode(mode) {
    if (!panes[mode]) mode = 'signin';
    tabs.forEach(function (t) {
      var on = t.dataset.mode === mode;
      t.classList.toggle('active', on);
      t.setAttribute('aria-selected', on ? 'true' : 'false');
      t.tabIndex = on ? 0 : -1;
    });
    Object.keys(panes).forEach(function (k) {
      panes[k].hidden = k !== mode;
    });
    // Clear stale errors so a pane never reopens with an old message.
    Array.prototype.forEach.call(document.querySelectorAll('.msg'), function (el) {
      el.textContent = '';
      el.classList.remove('ok');
    });
    Array.prototype.forEach.call(document.querySelectorAll('input.invalid'), function (el) {
      el.classList.remove('invalid');
      el.removeAttribute('aria-invalid');
    });
    var first = panes[mode].querySelector('input');
    if (first && window.matchMedia('(min-width: 720px)').matches) first.focus();
    try {
      var nextParam = new URLSearchParams(location.search).get('next');
      if (isStaticHtmlPath) {
        var qsParts = [];
        if (mode === 'signup') qsParts.push('mode=signup');
        if (nextParam) qsParts.push('next=' + encodeURIComponent(nextParam));
        history.replaceState(null, '', location.pathname + (qsParts.length ? '?' + qsParts.join('&') : ''));
      } else {
        var suffix = nextParam ? '?next=' + encodeURIComponent(nextParam) : '';
        history.replaceState(null, '', apiPath(mode === 'signup' ? '/signup' : '/login') + suffix);
      }
    } catch (e) { /* ignore */ }
  }

  tabs.forEach(function (t) {
    t.addEventListener('click', function () { setMode(t.dataset.mode); });
    t.addEventListener('keydown', function (ev) {
      if (ev.key === 'ArrowRight' || ev.key === 'ArrowLeft') {
        var signupTab = document.getElementById('tab-signup');
        if (signupTab && signupTab.hidden) return;
        ev.preventDefault();
        setMode(t.dataset.mode === 'signin' ? 'signup' : 'signin');
      }
    });
  });

  // Show / hide password
  Array.prototype.forEach.call(document.querySelectorAll('.reveal'), function (btn) {
    btn.addEventListener('click', function () {
      var input = document.getElementById(btn.dataset.target);
      if (!input) return;
      var show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      btn.textContent = show ? 'Hide' : 'Show';
      btn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    });
  });

  // Password strength meter
  var pw = document.getElementById('signup-password');
  var meter = document.getElementById('pw-meter');
  if (pw && meter) {
    pw.addEventListener('input', function () {
      var v = pw.value;
      var score = 0;
      if (v.length >= 8) score++;
      if (v.length >= 12) score++;
      if (/[A-Z]/.test(v) && /[a-z]/.test(v)) score++;
      if (/[0-9]/.test(v)) score++;
      if (/[^A-Za-z0-9]/.test(v)) score++;
      meter.style.width = Math.min(100, score * 20) + '%';
    });
  }

  function showLoader(text) {
    if (loaderText) loaderText.textContent = text || 'CONNECTING TO MODEL...';
    if (progressBar) progressBar.style.width = '0%';
    loader.hidden = false;
    window.setTimeout(function () { if (progressBar) progressBar.style.width = '80%'; }, 40);
  }

  function finishLoader() {
    if (progressBar) progressBar.style.width = '100%';
    window.setTimeout(function () { loader.hidden = true; }, 260);
  }

  function setMsg(el, text, ok) {
    el.textContent = text || '';
    el.classList.toggle('ok', Boolean(ok));
  }

  function markInvalid(input, invalid) {
    if (!input) return;
    input.classList.toggle('invalid', Boolean(invalid));
    if (invalid) input.setAttribute('aria-invalid', 'true');
    else input.removeAttribute('aria-invalid');
  }

  async function postJson(relUrl, body) {
    var headers = { 'Content-Type': 'application/json' };
    var res = await fetch(apiPath(relUrl), {
      method: 'POST',
      headers: headers,
      credentials: 'same-origin',
      body: JSON.stringify(body)
    });
    var ct = String(res.headers.get('content-type') || '').toLowerCase();
    var isJson = ct.indexOf('application/json') !== -1;
    var data = {};
    if (isJson) {
      try { data = await res.json(); } catch (e) { /* ignore */ }
    }
    return {
      res: res,
      data: data,
      isStaticHost: staticDemoReady && (res.status === 404 || res.status === 405 || (res.ok && !isJson))
    };
  }

  function goHome() {
    var next = new URLSearchParams(location.search).get('next');
    var defaultHome = (basePrefix || '') + '/';
    var target = next && next.charAt(0) === '/' && next.charAt(1) !== '/' ? next : defaultHome;
    clearAuthToken();
    location.replace(target);
  }

  // ---------------------------------------------------------------- sign in
  var signinForm = panes.signin;
  signinForm.addEventListener('submit', async function (ev) {
    ev.preventDefault();
    var msg = document.getElementById('signin-msg');
    var email = document.getElementById('signin-email');
    var password = document.getElementById('signin-password');
    var submit = document.getElementById('signin-submit');

    setMsg(msg, '');
    markInvalid(email, false);
    markInvalid(password, false);

    var emailVal = email.value.trim();
    var pwVal = password.value;

    if (!emailVal || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(emailVal)) {
      markInvalid(email, true);
      setMsg(msg, 'Enter a valid email address.');
      email.focus();
      return;
    }
    if (!pwVal) {
      markInvalid(password, true);
      setMsg(msg, 'Enter your password.');
      password.focus();
      return;
    }

    submit.disabled = true;
    showLoader('AUTHENTICATING...');
    try {
      var out = await postJson('/api/auth/login', { email: emailVal, password: pwVal });
      if (out.isStaticHost) {
        // Static Cloud Mode (GitHub Pages / Static CDN)
        var users = readCloudUsers();
        var emailLower = emailVal.toLowerCase();
        var matched = null;
        for (var i = 0; i < users.length; i++) {
          if (users[i].email === emailLower) { matched = users[i]; break; }
        }
        if (!matched) {
          finishLoader();
          setMsg(msg, 'No account found for this email in this browser yet — click "Create Account" above to register.');
          markInvalid(email, true);
          return;
        }
        var checkHash = await sha256Hex(matched.salt + ':' + pwVal);
        if (checkHash !== matched.passwordHash) {
          finishLoader();
          setMsg(msg, 'Invalid email or password.');
          markInvalid(password, true);
          password.select();
          return;
        }
        writeCloudSession({ id: matched.id, fullName: matched.fullName, email: matched.email });
        if (progressBar) progressBar.style.width = '100%';
        if (loaderText) loaderText.textContent = 'ACCESS GRANTED';
        window.setTimeout(function () { goHome(''); }, 320);
        return;
      }

      if (!out.res.ok || !out.data.ok) {
        finishLoader();
        setMsg(msg, out.data.error || 'Sign in failed.');
        markInvalid(password, true);
        password.select();
        return;
      }
      if (progressBar) progressBar.style.width = '100%';
      if (loaderText) loaderText.textContent = 'ACCESS GRANTED';
      window.setTimeout(function () { goHome(); }, 320);
    } catch (err) {
      finishLoader();
      setMsg(msg, 'Network error. Check your connection and try again.');
    } finally {
      submit.disabled = false;
    }
  });

  // Admin password fallback (server operator)
  var adminToggle = document.getElementById('admin-toggle');
  var adminBack = document.getElementById('admin-back');
  if (adminToggle) adminToggle.addEventListener('click', function () { setMode('admin'); });
  if (adminBack) adminBack.addEventListener('click', function () { setMode('signin'); });

  var adminForm = panes.admin;
  if (adminForm) {
    adminForm.addEventListener('submit', async function (ev) {
      ev.preventDefault();
      var msg = document.getElementById('admin-msg');
      var input = document.getElementById('admin-password');
      var submit = document.getElementById('admin-submit');

      setMsg(msg, '');
      markInvalid(input, false);
      if (!input.value) {
        markInvalid(input, true);
        setMsg(msg, 'Enter the admin password.');
        input.focus();
        return;
      }

      submit.disabled = true;
      showLoader('AUTHENTICATING...');
      try {
        var out = await postJson('/api/auth/login', { password: input.value });
        if (!out.res.ok || !out.data.ok) {
          finishLoader();
          setMsg(msg, out.data.error || 'Invalid admin password.');
          markInvalid(input, true);
          input.select();
          return;
        }
          if (progressBar) progressBar.style.width = '100%';
        if (loaderText) loaderText.textContent = 'ACCESS GRANTED';
        window.setTimeout(function () { goHome(out.data.token || ''); }, 320);
      } catch (err) {
        finishLoader();
        setMsg(msg, 'Network error. Check your connection and try again.');
      } finally {
        submit.disabled = false;
      }
    });
  }

  // ---------------------------------------------------------------- sign up
  var signupForm = panes.signup;
  signupForm.addEventListener('submit', async function (ev) {
    ev.preventDefault();
    var msg = document.getElementById('signup-msg');
    var name = document.getElementById('signup-name');
    var email = document.getElementById('signup-email');
    var password = document.getElementById('signup-password');
    var submit = document.getElementById('signup-submit');

    setMsg(msg, '');
    [name, email, password].forEach(function (i) { markInvalid(i, false); });

    var nameVal = name.value.replace(/\s+/g, ' ').trim();
    var emailVal = email.value.trim();
    var pwVal = password.value;

    if (nameVal.length < 2) {
      markInvalid(name, true); setMsg(msg, 'Please enter your full name.'); name.focus(); return;
    }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(emailVal)) {
      markInvalid(email, true); setMsg(msg, 'Enter a valid email address.'); email.focus(); return;
    }
    if (pwVal.length < 8) {
      markInvalid(password, true); setMsg(msg, 'Password must be at least 8 characters.'); password.focus(); return;
    }

    submit.disabled = true;
    showLoader('CREATING SECURE PROFILE...');
    try {
      var out = await postJson('/api/auth/signup', {
        fullName: nameVal,
        email: emailVal,
        password: pwVal
      });
      if (out.isStaticHost) {
        // Static Cloud Mode (GitHub Pages / Static CDN)
        var users = readCloudUsers();
        var emailLower = emailVal.toLowerCase();
        for (var i = 0; i < users.length; i++) {
          if (users[i].email === emailLower) {
            finishLoader();
            setMsg(msg, 'An account with this email already exists — switch to Sign In above.');
            markInvalid(email, true);
            email.focus();
            return;
          }
        }
        var salt = Math.random().toString(36).slice(2) + Date.now().toString(36);
        var pwHash = await sha256Hex(salt + ':' + pwVal);
        var newUser = {
          id: 'usr_' + Date.now().toString(36),
          fullName: nameVal,
          email: emailLower,
          salt: salt,
          passwordHash: pwHash,
          createdAt: new Date().toISOString()
        };
        users.push(newUser);
        writeCloudUsers(users);
        writeCloudSession({ id: newUser.id, fullName: newUser.fullName, email: newUser.email });
        if (progressBar) progressBar.style.width = '100%';
        if (loaderText) loaderText.textContent = 'ACCOUNT READY';
        window.setTimeout(function () { goHome(''); }, 360);
        return;
      }

      if (!out.res.ok || !out.data.ok) {
        finishLoader();
        setMsg(msg, out.data.error || 'Could not create the account.');
        var field = out.data.field;
        if (field === 'email') { markInvalid(email, true); email.focus(); }
        if (field === 'fullName') { markInvalid(name, true); name.focus(); }
        if (field === 'password') { markInvalid(password, true); password.focus(); }
        return;
      }
      if (out.data.token) saveAuthToken(out.data.token);
      if (progressBar) progressBar.style.width = '100%';
      if (loaderText) loaderText.textContent = 'ACCOUNT READY';
      window.setTimeout(function () { goHome(out.data.token || ''); }, 360);
    } catch (err) {
      finishLoader();
      setMsg(msg, 'Network error. Check your connection and try again.');
    } finally {
      submit.disabled = false;
    }
  });

  // ------------------------------------------------------------ entry point
  function showAuthServiceError() {
    var mode = !panes.signup.hidden ? 'signup' : !panes.admin.hidden ? 'admin' : 'signin';
    setMsg(document.getElementById(mode + '-msg'), 'Authentication service is unavailable. Retry when the server is reachable.');
  }

  (async function init() {
    var modeParam = new URLSearchParams(location.search).get('mode');
    if (/\/signup(?:\.html)?$/i.test(rawPath) || modeParam === 'signup') {
      setMode('signup');
    }
    try {
      clearAuthToken();
      var res = await fetch(apiPath('/api/auth/status'), {
        credentials: 'same-origin'
      });
      var ct = String(res.headers.get('content-type') || '').toLowerCase();
      if (res.ok && ct.indexOf('application/json') !== -1) {
        var data = await res.json();
        if (data.authenticated) {
          if (data.signupOpen && /\/signup$/i.test(rawPath)) {
            setMode('signup');
            return;
          }
          goHome();
          return;
        }
        if (adminToggle && data.adminPasswordConfigured === false) {
          adminToggle.style.display = 'none';
        }
        var signupTab = document.getElementById('tab-signup');
        if (data.signupOpen === false && signupTab) {
          signupTab.hidden = true;
          signupTab.style.display = 'none';
          if (!panes.signup.hidden) setMode('signin');
        } else if (data.signupOpen && data.hasUsers === false && !/\/login$/i.test(rawPath)) {
          setMode('signup');
        }
        return;
      }
      if (!isStaticHtmlPath) {
        showAuthServiceError();
        return;
      }
      // Static Cloud Mode (GitHub Pages): this is a local simulation, not auth.
      markStaticDemo();
      if (adminToggle) adminToggle.style.display = 'none';
      var cloudSess = readCloudSession();
      if (cloudSess && cloudSess.user) {
        goHome('');
        return;
      }
      if (readCloudUsers().length === 0 && modeParam !== 'signin') {
        setMode('signup');
      }
    } catch (e) {
      if (isStaticHtmlPath) {
        markStaticDemo();
        if (adminToggle) adminToggle.style.display = 'none';
        if (readCloudUsers().length === 0) setMode('signup');
      } else {
        showAuthServiceError();
      }
    }
  })();
})();
