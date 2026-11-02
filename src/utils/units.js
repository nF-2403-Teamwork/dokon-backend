// Single source of truth for valid product/sale-item units on the server.
// Mirrors client/src/data/units.js — keep both in sync when adding a unit.
const UNIT_VALUES = ['dona', 'kg', 'metr'];

// 'dona' is counted as whole pieces; 'kg' and 'metr' are sold by a
// continuous measure (weight/length), so quantities can be fractional.
const FRACTIONAL_UNITS = new Set(['kg', 'metr']);

function normalizeUnit(value, fallback = 'dona') {
  return UNIT_VALUES.includes(value) ? value : fallback;
}

function isFractionalUnit(unit) {
  return FRACTIONAL_UNITS.has(unit);
}

function unitLabel(unit) {
  return UNIT_VALUES.includes(unit) ? unit : 'dona';
}

module.exports = { UNIT_VALUES, normalizeUnit, isFractionalUnit, unitLabel };
