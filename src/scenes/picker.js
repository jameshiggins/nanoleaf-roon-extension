'use strict';

/**
 * Shuffle-bag scene picker: cycles through every scene in random order before
 * any repeats, and never hands out the same scene twice in a row (when it has
 * more than one to choose from).
 */
class ScenePicker {
  /**
   * @param {string[]} scenes  effect names to rotate through
   * @param {{ rng?: () => number }} [opts]  rng injectable for deterministic tests
   */
  constructor(scenes, opts = {}) {
    if (!Array.isArray(scenes) || scenes.length === 0) {
      throw new Error('ScenePicker needs at least one scene');
    }
    this.scenes = [...scenes];
    this.rng = opts.rng ?? Math.random;
    this.bag = [];
    this.last = null;
  }

  /** @returns {string} the next scene name */
  next() {
    if (this.bag.length === 0) this._refill();
    // avoid an immediate repeat across bag boundaries
    if (this.scenes.length > 1 && this.bag[this.bag.length - 1] === this.last) {
      const swap = Math.floor(this.rng() * (this.bag.length - 1));
      [this.bag[swap], this.bag[this.bag.length - 1]] = [this.bag[this.bag.length - 1], this.bag[swap]];
    }
    this.last = this.bag.pop();
    return this.last;
  }

  _refill() {
    this.bag = [...this.scenes];
    for (let i = this.bag.length - 1; i > 0; i--) {
      const j = Math.floor(this.rng() * (i + 1));
      [this.bag[i], this.bag[j]] = [this.bag[j], this.bag[i]];
    }
  }
}

/**
 * Apply include/exclude filters from config to a list of candidate effect names.
 * `include` non-empty → exactly those (that exist); otherwise all minus `exclude`.
 * Matching is case-insensitive on the full name.
 */
function filterScenes(available, { include = [], exclude = [] } = {}) {
  const lower = (s) => s.toLowerCase();
  const availByLower = new Map(available.map((n) => [lower(n), n]));
  let names;
  if (include.length > 0) {
    names = include.map((n) => availByLower.get(lower(n))).filter(Boolean);
  } else {
    const excluded = new Set(exclude.map(lower));
    names = available.filter((n) => !excluded.has(lower(n)));
  }
  return [...new Set(names)]; // duplicates would defeat the picker's no-repeat guarantee
}

module.exports = { ScenePicker, filterScenes };
