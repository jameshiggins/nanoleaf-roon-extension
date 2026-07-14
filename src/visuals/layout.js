'use strict';

/**
 * Normalize the Nanoleaf panel layout for the visualizers:
 * positions mapped into [0,1] on both axes (nx: 0 = leftmost, ny: 0 = bottom),
 * panels ordered left→right.
 */
function prepareLayout(positionData) {
  const panels = positionData.filter((p) => p.panelId !== 0); // 0 = controller pseudo-panel
  if (panels.length === 0) return [];
  const xs = panels.map((p) => p.x);
  const ys = panels.map((p) => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const spanX = maxX - minX || 1;
  const spanY = maxY - minY || 1;
  return panels
    .map((p) => ({
      id: p.panelId,
      nx: (p.x - minX) / spanX,
      ny: (p.y - minY) / spanY,
    }))
    .sort((a, b) => a.nx - b.nx || a.ny - b.ny);
}

module.exports = { prepareLayout };
