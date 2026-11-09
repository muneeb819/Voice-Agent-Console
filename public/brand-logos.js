/* MMA Digital Labs — theme-bound transparent logo assets.
   The eight operator-supplied banners are the source of truth. Each theme maps
   to one banner; the two light themes reuse the closest supplied banner until
   additional artwork is provided. The full banner is a transparent WebP cut.
   The waveform baked into the artwork is masked out and replaced with live
   CSS-animated bars in the same windows, so the logo moves without a canvas,
   requestAnimationFrame loop, or audio analyser. The motion is a decorative
   CSS loop, not a measurement of microphone or provider audio. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.VACBrandLogos = api;
})(typeof window === 'undefined' ? null : window, function () {
  'use strict';

  const ASSETS = {
    'mma-cyan-signal': {
      full: './assets/brand/mma-cyan-signal.webp',
      icon: './assets/brand/mma-cyan-signal-icon.jpg',
      label: 'MMA Cyan Signal',
    },
    'mma-blue-ultraviolet': {
      full: './assets/brand/mma-blue-ultraviolet.webp',
      icon: './assets/brand/mma-blue-ultraviolet-icon.jpg',
      label: 'MMA Blue Ultraviolet',
    },
    'mma-cyan-field': {
      full: './assets/brand/mma-cyan-field.webp',
      icon: './assets/brand/mma-cyan-field-icon.jpg',
      label: 'MMA Cyan Field',
    },
    'mma-gold-ember': {
      full: './assets/brand/mma-gold-ember.webp',
      icon: './assets/brand/mma-gold-ember-icon.jpg',
      label: 'MMA Gold Ember',
    },
    'mma-ice-obsidian': {
      full: './assets/brand/mma-ice-obsidian.webp',
      icon: './assets/brand/mma-ice-obsidian-icon.jpg',
      label: 'MMA Ice Obsidian',
    },
    'mma-cyan-emerald': {
      full: './assets/brand/mma-cyan-emerald.webp',
      icon: './assets/brand/mma-cyan-emerald-icon.jpg',
      label: 'MMA Cyan Emerald',
    },
    'mma-cyan-aurora': {
      full: './assets/brand/mma-cyan-aurora.webp',
      icon: './assets/brand/mma-cyan-aurora-icon.jpg',
      label: 'MMA Cyan Aurora',
    },
    'mma-gold-crimson': {
      full: './assets/brand/mma-gold-crimson.webp',
      icon: './assets/brand/mma-gold-crimson-icon.jpg',
      label: 'MMA Gold Crimson',
    },
  };

  const THEME_LOGO_MAP = {
    cyan_signal: 'mma-cyan-signal',
    ultraviolet: 'mma-blue-ultraviolet',
    aurora_field: 'mma-cyan-field',
    ember_pulse: 'mma-gold-ember',
    obsidian: 'mma-ice-obsidian',
    emerald: 'mma-cyan-emerald',
    aurora: 'mma-cyan-aurora',
    crimson: 'mma-gold-crimson',
    pearl: 'mma-ice-obsidian',
    sakura: 'mma-gold-crimson',
  };

  function assetFor(themeId) {
    const key = THEME_LOGO_MAP[themeId] || THEME_LOGO_MAP.cyan_signal;
    return ASSETS[key] || ASSETS['mma-cyan-signal'];
  }

  // Bar count matches the density of the waveform in the supplied artwork.
  const WAVE_BARS = 24;

  /**
   * Builds one flank of live bars. Heights follow a sine envelope so the group
   * tapers at both ends like the original art. Durations and delays are derived
   * deterministically from the index, so the two flanks stay in sync across
   * renders and the motion never looks like a single uniform sweep.
   */
  function waveBars() {
    let html = '';
    for (let i = 0; i < WAVE_BARS; i += 1) {
      const t = (i + 0.5) / WAVE_BARS;
      const envelope = Math.pow(Math.sin(Math.PI * t), 0.5);
      const height = 20 + 80 * envelope * (0.35 + 0.65 * Math.abs(Math.sin(i * 1.9 + 0.4)));
      const duration = (1.05 + ((i * 37) % 11) / 10).toFixed(2);
      const delay = (-((i * 53) % 17) / 10).toFixed(2);
      html += '<i style="height:' + height.toFixed(1) + '%;animation-duration:' + duration + 's;animation-delay:' + delay + 's"></i>';
    }
    return html;
  }

  function waveHtml() {
    const bars = waveBars();
    return (
      '<span class="mma-wave mma-wave-l" aria-hidden="true">' + bars + '</span>' +
      '<span class="mma-wave mma-wave-r" aria-hidden="true">' + bars + '</span>'
    );
  }

  function fullHtml(themeId, opts) {
    const options = opts || {};
    const asset = assetFor(themeId);
    const alt = options.alt || 'MMA Digital Labs — Voice Agent Bots Console';
    const lazy = options.lazy ? ' loading="lazy"' : '';
    const waves = options.waves === false ? '' : waveHtml();
    return '<img class="mma-logo-art" src="' + asset.full + '" alt="' + alt + '" draggable="false"' + lazy + ' />' + waves;
  }

  function iconHtml(themeId, opts) {
    const options = opts || {};
    const asset = assetFor(themeId);
    const alt = options.alt || '';
    return (
      '<span class="mma-brand-icon">' +
      '<img class="mma-icon-art" src="' + asset.icon + '" alt="' + alt + '" draggable="false" />' +
      '</span>'
    );
  }

  function applyTo(el, themeId, variant) {
    if (!el) return;
    el.dataset.brandTheme = themeId || 'cyan_signal';
    el.innerHTML = variant === 'icon' ? iconHtml(themeId) : fullHtml(themeId);
  }

  /**
   * Sets decorative wave energy from real call state. This only changes CSS
   * custom properties; it never starts a timer or animation loop.
   */
  function setEnergy(el, level) {
    if (!el) return;
    if (level) el.dataset.energy = level;
    else delete el.dataset.energy;
  }

  return { ASSETS, THEME_LOGO_MAP, assetFor, fullHtml, iconHtml, applyTo, setEnergy, WAVE_BARS };
});
