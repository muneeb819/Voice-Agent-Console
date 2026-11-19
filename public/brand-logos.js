/* MMA Digital Lab — one house identity.
   The operator-supplied crest is the only brand mark used by the console,
   the sign-in shell, the loader and the favicon. There is no per-theme logo
   set and no synthetic waveform overlay: the supplied artwork is shown as-is. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.VACBrandLogos = api;
})(typeof window === 'undefined' ? null : window, function () {
  'use strict';

  const ASSETS = {
    'mma-house': {
      full: './assets/brand/mma-atelier-logo.png',
      icon: './assets/brand/mma-atelier-icon.png',
      label: 'MMA Digital Lab',
    },
  };

  const THEME_LOGO_MAP = {
    atelier: 'mma-house',
    terracotta: 'mma-house',
    nocturne: 'mma-house',
    botanic: 'mma-house',
    chalk: 'mma-house',
    // Older saved preferences resolve to the same house mark.
    cyan_signal: 'mma-house',
    ultraviolet: 'mma-house',
    aurora_field: 'mma-house',
    ember_pulse: 'mma-house',
    obsidian: 'mma-house',
    emerald: 'mma-house',
    aurora: 'mma-house',
    crimson: 'mma-house',
    pearl: 'mma-house',
    sakura: 'mma-house',
  };

  function assetFor(themeId) {
    const key = THEME_LOGO_MAP[themeId] || 'mma-house';
    return ASSETS[key] || ASSETS['mma-house'];
  }

  function fullHtml(themeId, opts) {
    const options = opts || {};
    const asset = assetFor(themeId);
    const alt = options.alt == null ? 'MMA Digital Lab — Voice Agent Console' : options.alt;
    const lazy = options.lazy ? ' loading="lazy"' : '';
    return '<img class="mma-logo-art" src="' + asset.full + '" alt="' + alt + '" draggable="false" decoding="async"' + lazy + ' />';
  }

  function iconHtml(themeId, opts) {
    const options = opts || {};
    const asset = assetFor(themeId);
    const alt = options.alt || '';
    return '<img class="mma-icon-art" src="' + asset.icon + '" alt="' + alt + '" draggable="false" decoding="async" />';
  }

  function applyTo(el, themeId, variant) {
    if (!el) return;
    el.dataset.brandTheme = themeId || 'atelier';
    el.innerHTML = variant === 'icon' ? iconHtml(themeId) : fullHtml(themeId, { alt: '' });
  }

  /* Kept for callers that mirror live call state onto the mark. The house
     identity has no equaliser, so this only records the state for styling. */
  function setEnergy(el, level) {
    if (!el) return;
    if (level) el.dataset.energy = level;
    else delete el.dataset.energy;
  }

  return { ASSETS, THEME_LOGO_MAP, assetFor, fullHtml, iconHtml, applyTo, setEnergy };
});
