/* Shared UI layer: colour theme and toasts.
 *
 * Loaded synchronously from <head>, before the body is parsed, so the stored
 * theme is on <html> before the first paint. Deferring this instead would show
 * a white flash to every dark-mode visitor on every page load.
 *
 * The page's CSP allows scripts from 'self' only, so this cannot be inlined.
 */
(function () {
  'use strict';

  var STORAGE_KEY = 'reviewqr-theme';
  var root = document.documentElement;

  // Private browsing and blocked site data both make localStorage throw on
  // access, not just on write, so every touch of it is wrapped.
  function stored() {
    try {
      return localStorage.getItem(STORAGE_KEY);
    } catch (error) {
      return null;
    }
  }

  function remember(value) {
    try {
      localStorage.setItem(STORAGE_KEY, value);
    } catch (error) {
      /* A theme that does not persist is still a theme that works. */
    }
  }

  // No data-theme at all means "follow the system", which is the default and
  // the only state where the OS switching to dark is picked up live.
  var saved = stored();
  if (saved === 'dark' || saved === 'light') root.setAttribute('data-theme', saved);

  function current() {
    var explicit = root.getAttribute('data-theme');
    if (explicit) return explicit;
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light';
  }

  function paintToggle(button) {
    var dark = current() === 'dark';
    button.innerHTML =
      '<span class="icon" aria-hidden="true">' + (dark ? '☀' : '☾') + '</span>' +
      '<span>' + (dark ? 'Light' : 'Dark') + '</span>';
    // The button is a switch, so it announces what it will do and what it is.
    button.setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme');
    button.setAttribute('aria-pressed', dark ? 'true' : 'false');
  }

  function wireToggle() {
    var button = document.querySelector('[data-theme-toggle]');
    if (!button) return;
    paintToggle(button);
    button.addEventListener('click', function () {
      var next = current() === 'dark' ? 'light' : 'dark';
      root.setAttribute('data-theme', next);
      remember(next);
      paintToggle(button);
    });
  }

  /* ------------------------------------------------------------------ toasts */

  function container() {
    var node = document.querySelector('.toasts');
    if (!node) {
      node = document.createElement('div');
      node.className = 'toasts';
      // polite rather than assertive: a confirmation should not interrupt a
      // screen reader mid-sentence.
      node.setAttribute('aria-live', 'polite');
      document.body.appendChild(node);
    }
    return node;
  }

  // toast('Saved') or toast('Could not save', 'error').
  window.toast = function (message, kind) {
    if (!message) return;
    var node = document.createElement('div');
    node.className = 'toast' + (kind === 'error' ? ' error' : '');
    node.textContent = message;
    container().appendChild(node);

    // Errors sit longer: they are more likely to need reading twice.
    var life = kind === 'error' ? 6000 : 3500;
    setTimeout(function () {
      node.classList.add('leaving');
      setTimeout(function () {
        if (node.parentNode) node.parentNode.removeChild(node);
      }, 200);
    }, life);
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wireToggle);
  } else {
    wireToggle();
  }
})();
