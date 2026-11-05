/*
 * Pixel Toolbox — "latest call wins" for overlapping async work.
 *
 * Used when the user can start the same slow job again before the first
 * one has finished (for example choosing two files quickly): only the
 * result of the most recent call may be used.
 *
 * MIT License. Copyright (c) 2026 YunaWorks.
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    (root.PixelToolbox = root.PixelToolbox || {}).takeLatest = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /**
   * Wraps an async function. Each call resolves to
   *   { stale: false, value }  when no newer call was made while it ran, or
   *   { stale: true }          when a newer call was made (its result is dropped).
   * Errors are passed on only for the most recent call; errors of outdated
   * calls are dropped as well.
   */
  function takeLatest(task) {
    let latest = 0;
    return async function () {
      const ticket = ++latest;
      let value;
      try {
        value = await task.apply(this, arguments);
      } catch (err) {
        if (ticket !== latest) return { stale: true };
        throw err;
      }
      return ticket === latest ? { stale: false, value: value } : { stale: true };
    };
  }

  return takeLatest;
});
