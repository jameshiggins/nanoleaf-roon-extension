'use strict';

/**
 * Shuffle bag: draws every item in random order before any repeats, and never
 * returns the same item twice in a row (when it has more than one). Used to
 * rotate visualizers and palettes so consecutive tracks always look different.
 */
class ShuffleBag {
  /**
   * @param {Array<*>} items
   * @param {{ rng?: () => number }} [opts]
   */
  constructor(items, opts = {}) {
    if (!Array.isArray(items) || items.length === 0) {
      throw new Error('ShuffleBag needs at least one item');
    }
    this.items = [...items];
    this.rng = opts.rng ?? Math.random;
    this.bag = [];
    this.last = null;
  }

  next() {
    if (this.bag.length === 0) this._refill();
    if (this.items.length > 1 && this.bag[this.bag.length - 1] === this.last) {
      const swap = Math.floor(this.rng() * (this.bag.length - 1));
      [this.bag[swap], this.bag[this.bag.length - 1]] = [this.bag[this.bag.length - 1], this.bag[swap]];
    }
    this.last = this.bag.pop();
    return this.last;
  }

  _refill() {
    this.bag = [...this.items];
    for (let i = this.bag.length - 1; i > 0; i--) {
      const j = Math.floor(this.rng() * (i + 1));
      [this.bag[i], this.bag[j]] = [this.bag[j], this.bag[i]];
    }
  }
}

/**
 * Apply include/exclude filters (case-insensitive, deduped) to candidate names.
 * `include` non-empty → exactly those that exist; else all minus `exclude`.
 */
function filterNames(available, { include = [], exclude = [] } = {}) {
  const lower = (s) => s.toLowerCase();
  const byLower = new Map(available.map((n) => [lower(n), n]));
  let names;
  if (include.length > 0) {
    names = include.map((n) => byLower.get(lower(n))).filter(Boolean);
  } else {
    const excluded = new Set(exclude.map(lower));
    names = available.filter((n) => !excluded.has(lower(n)));
  }
  return [...new Set(names)];
}

module.exports = { ShuffleBag, filterNames };
