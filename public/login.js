/* MMA Digital Labs — Voice Agent Console
   Sign in / Create account controller. No secrets are stored client-side. */
(function () {
  'use strict';

  try {
    var savedApp = JSON.parse(localStorage.getItem('vac_appearance_v2') || localStorage.getItem('vac_appearance_v1') || '{}');
    if (savedApp && savedApp.theme) {
      document.documentElement.dataset.theme = savedApp.theme;
    }
  } catch (e) {}

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
      // Keep ?next= so a deep link survives a tab switch.
      var nextParam = new URLSearchParams(location.search).get('next');
      var suffix = nextParam ? '?next=' + encodeURIComponent(nextParam) : '';
      history.replaceState(null, '', (mode === 'signup' ? '/signup' : '/login') + suffix);
    } catch (e) { /* ignore */ }
  }

  tabs.forEach(function (t) {
    t.addEventListener('click', function () { setMode(t.dataset.mode); });
    t.addEventListener('keydown', function (ev) {
      if (ev.key === 'ArrowRight' || ev.key === 'ArrowLeft') {
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
    // Animate to 80%, then hold until the request resolves.
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

  async function postJson(url, body) {
    var res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body)
    });
    var data = {};
    try { data = await res.json(); } catch (e) { /* ignore */ }
    return { res: res, data: data };
  }

  function goHome() {
    var next = new URLSearchParams(location.search).get('next');
    var target = next && next.charAt(0) === '/' && next.charAt(1) !== '/' ? next : '/';
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
      if (!out.res.ok || !out.data.ok) {
        finishLoader();
        setMsg(msg, out.data.error || 'Sign in failed.');
        markInvalid(password, true);
        password.select();
        return;
      }
      if (progressBar) progressBar.style.width = '100%';
      if (loaderText) loaderText.textContent = 'ACCESS GRANTED';
      window.setTimeout(goHome, 380);
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
        window.setTimeout(goHome, 380);
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
      if (!out.res.ok || !out.data.ok) {
        finishLoader();
        setMsg(msg, out.data.error || 'Could not create the account.');
        var field = out.data.field;
        if (field === 'email') { markInvalid(email, true); email.focus(); }
        if (field === 'fullName') { markInvalid(name, true); name.focus(); }
        if (field === 'password') { markInvalid(password, true); password.focus(); }
        return;
      }
      if (progressBar) progressBar.style.width = '100%';
      if (loaderText) loaderText.textContent = 'ACCOUNT READY';
      window.setTimeout(goHome, 420);
    } catch (err) {
      finishLoader();
      setMsg(msg, 'Network error. Check your connection and try again.');
    } finally {
      submit.disabled = false;
    }
  });

  // ------------------------------------------------------------ entry point
  (async function init() {
    if (location.pathname === '/signup') setMode('signup');
    try {
      var res = await fetch('/api/auth/status', { credentials: 'same-origin' });
      if (res.ok) {
        var data = await res.json();
        if (data.authenticated) { goHome(); return; }
        if (adminToggle && data.adminPasswordConfigured === false) {
          adminToggle.style.display = 'none';
        }
        if (data.hasUsers === false && location.pathname !== '/login') {
          setMode('signup');
        }
      }
    } catch (e) { /* offline: leave the form usable */ }
  })();
})();
