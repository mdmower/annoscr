import cairo from 'gi://cairo?version=1.0';

export interface PenStyle {
  color: [number, number, number, number];
  width: number;
}

export interface Action {
  draw(cr: any, scale: number): void;
}

export const DEFAULT_PEN_STYLE: PenStyle = {
  color: [0.85, 0.18, 0.18, 1.0],
  width: 4,
};

export class PenAction implements Action {
  readonly points: Array<[number, number]> = [];
  readonly style: PenStyle;

  constructor(style: PenStyle) {
    this.style = style;
  }

  addPoint(x: number, y: number): void {
    this.points.push([x, y]);
  }

  pointCount(): number {
    return this.points.length;
  }

  draw(cr: any, _scale: number): void {
    if (this.points.length < 2) return;

    const [r, g, b, a] = this.style.color;
    cr.setSourceRGBA(r, g, b, a);
    cr.setLineWidth(this.style.width);
    cr.setLineCap(cairo.LineCap.ROUND);
    cr.setLineJoin(cairo.LineJoin.ROUND);

    buildSmoothPath(cr, this.points);
    cr.stroke();
  }
}

// Connects each adjacent pair of points with a quadratic that passes through
// their midpoint, using the raw sample as the control. Smooths sparse pointer
// samples into a continuous curve without losing fidelity.
function buildSmoothPath(cr: any, pts: Array<[number, number]>): void {
  if (pts.length === 2) {
    cr.moveTo(pts[0][0], pts[0][1]);
    cr.lineTo(pts[1][0], pts[1][1]);
    return;
  }

  cr.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length - 1; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[i + 1];
    const mx = (x1 + x2) * 0.5;
    const my = (y1 + y2) * 0.5;
    cr.curveTo(x1, y1, x1, y1, mx, my);
  }
  const last = pts[pts.length - 1];
  cr.lineTo(last[0], last[1]);
}
