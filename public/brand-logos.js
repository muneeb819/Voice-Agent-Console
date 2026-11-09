/* MMA Digital Labs — theme-bound transparent logo assets.
   The eight operator-supplied banners are the source of truth. Each theme maps
   to one banner; the two light themes reuse the closest supplied banner until
   additional artwork is provided. The full banner is a transparent WebP cut; no decorative wave/sheen overlays are rendered. */
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

  function fullHtml(themeId, opts) {
    const options = opts || {};
    const asset = assetFor(themeId);
    const alt = options.alt || 'MMA Digital Labs — Voice Agent Bots Console';
    const lazy = options.lazy ? ' loading="lazy"' : '';
    return '<img class="mma-logo-art" src="' + asset.full + '" alt="' + alt + '" draggable="false"' + lazy + ' />';
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

  return { ASSETS, THEME_LOGO_MAP, assetFor, fullHtml, iconHtml, applyTo };
});
