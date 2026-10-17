'use strict';

// Synthetic calibration inputs for constraint tests, never application defaults.
const timings = require('../cast-timings.js');
const form = (abilityId, label, frames, hold = false) => ({
  id: `${abilityId}-${label}`, abilityId, label, hold, swapFrames: frames,
  lockMs: Math.ceil(frames / 60 * 1000), followFrames: {}, source: 'test-fixture',
  basis: 'synthetic-test-input', fps: 60, locallyMeasured: false
});
timings.characters['10000052'] = [form('skill', 'Press', 36), form('burst', 'Burst', 111)];
timings.characters['10000025'] = [form('skill', 'Press', 77), form('burst', 'Burst', 40)];
timings.characters['10000032'] = [
  form('skill', 'Press', 50), form('skill', 'Hold Lv. 1', 95, true),
  form('skill', 'Hold Lv. 2', 337, true), form('burst', 'Burst', 51)
];
