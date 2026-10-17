/* No third-party measurement dataset is bundled. Calibrations are saved in projects. */
(function(root) {
  'use strict';
  const timings = {version: 1, fps: 60, locallyMeasured: false, characters: {}};
  if (typeof module === 'object' && module.exports) module.exports = timings;
  else root.CombatCastTimings = timings;
})(globalThis);
