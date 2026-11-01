'use strict';

/**
 * Normalize the Nanoleaf panel layout for the visualizers:
 * positions mapped into [0,1] on both axes (nx: 0 = leftmost, ny: 0 = bottom),
 * panels ordered left→right.
 *
 * `rotateDeg` is the wall-alignment rotation (the controller's globalOrientation,
 * sign-corrected, plus any user fine-tune). Raw positionData is in the
 * controller's mounting frame, so without it directional scenes sweep at an
 * angle on the real wall and the companion app's preview is rotated.
 * Empirically (user-calibrated against the physical wall) the layout must be
 * rotated by MINUS globalOrientation.
 *
 * Besides nx/ny, each panel carries what a faithful preview needs:
 *   mx/my — rotated millimeter coordinates (min-shifted to 0), true aspect
 *   o     — the panel's own rotation in the rotated frame (degrees)
 *   shape — the Nanoleaf shapeType code (0 = Aurora triangle, …)
 */
function prepareLayout(positionData, rotateDeg = 0) {
  const panels = positionData.filter((p) => p.panelId !== 0); // 0 = controller pseudo-panel
  if (panels.length === 0) return [];
  const rad = ((rotateDeg || 0) * Math.PI) / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  const pts = panels.map((p) => ({
    id: p.panelId,
    x: p.x * cos - p.y * sin,
    y: p.x * sin + p.y * cos,
    o: (((p.o || 0) + rotateDeg) % 360 + 360) % 360,
    shape: p.shapeType ?? null,
  }));
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  // An axis whose spread is only rotation floating-point dust (cos 90° ≠ exactly 0)
  // must collapse to 0, not be normalized back up to a full 0..1 spread.
  const eps = Math.max(maxX - minX, maxY - minY, 1) * 1e-9;
  const spanX = maxX - minX > eps ? maxX - minX : 1;
  const spanY = maxY - minY > eps ? maxY - minY : 1;
  return pts
    .map((p) => ({
      id: p.id,
      nx: (p.x - minX) / spanX,
      ny: (p.y - minY) / spanY,
      mx: p.x - minX,
      my: p.y - minY,
      o: p.o,
      shape: p.shape,
    }))
    .sort((a, b) => a.nx - b.nx || a.ny - b.ny);
}

module.exports = { prepareLayout };
