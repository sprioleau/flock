"use client";

import { useEffect, useRef } from 'react';

/*
  Standalone Interactive Vector Line Grid Component
  Automatically synchronized with your playground settings.
  All properties are exposed as top-level variables for easy customization.

  This renders as a full-bleed BACKGROUND LAYER: it fills its nearest
  positioned ancestor, paints underneath the page's content, and is
  `pointer-events: none` so every click, focus and text selection lands on the
  UI in front of it. Pointer tracking therefore cannot live on this element —
  see the listener setup in the effect below for why.
*/
/*
  The two mode knobs are written `"x" as Mode` rather than `: Mode = "x"`.
  With a plain annotation TypeScript still narrows a never-reassigned const to
  its initializer's literal type, which makes every other branch of the
  switches below provably unreachable and a compile error — the exact opposite
  of what a hand-editable knob needs. Asserting the wider type keeps all the
  modes live so switching one is a one-word edit.
*/
type DistortionMode = 'pointer' | 'pull' | 'push' | 'vortex' | 'ripple';
type AngleAtRestMode = 'horizontal' | 'vertical' | 'diagonal' | 'wave';

export const InteractiveLineGrid = () => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const pointerRef = useRef({ x: -1000, y: -1000, isActive: false, isDirect: false });

  /*
    ==========================================
    1. GRID GEOMETRY & SIZING
    ==========================================
  */
  const GRID_SPACING = 32;              /* Distance between grid lines (px) */
  const LINE_LENGTH = 14;               /* Base length of each vector line (px) */
  const LINE_WIDTH = 1.5;                 /* Stroke thickness (px) */

  /*
    ==========================================
    2. INTERACTION & PHYSICS
    ==========================================
  */
  const INFLUENCE_RADIUS = 220;         /* Radius of pointer magnetic field (px) */
  const SMOOTHING = 0.12;               /* Interpolation fluidity (0.01 = viscous, 0.5 = snappy) */
  const DISTORTION_MODE = "pointer" as DistortionMode;       /* 'pointer' | 'pull' | 'push' | 'vortex' | 'ripple' */

  /*
    ==========================================
    3. ORIENTATION & MOTION
    ==========================================
  */
  const ANGLE_AT_REST = 0;            /* Base resting angle in radians (0°) */
  const ANGLE_AT_REST_MODE = "diagonal" as AngleAtRestMode;   /* 'horizontal' | 'vertical' | 'diagonal' | 'wave' */
  const IS_AMBIENT_MOTION_ENABLED = true; /* Floating ambient pointer demo when idle */

  /*
    ==========================================
    4. APPEARANCE, COLOR & OPACITY
    ==========================================
  */
  const BASE_OPACITY = 0.15;                     /* Alpha transparency when line is at rest */
  const TARGET_OPACITY = 0.6;                    /* Alpha transparency when line is active near cursor */
  const OPACITY_RANGE = TARGET_OPACITY - BASE_OPACITY; /* Dynamic opacity boost amount (0.65) */
  const BACKGROUND_COLOR = "transparent";           /* Container & canvas background color */
  const COLOR_BY_PROXIMITY = true;           /* Smoothly shift color by proximity */
  const SHOW_DEBUG_CURSOR = false;            /* Display radius ring indicator */

  useEffect(() => {
    /*
      ==========================================
      4. APPEARANCE, COLOR & OPACITY
      ==========================================
    */
    const STROKE_COLOR_REST = [128, 128, 128];       /* RGB color array at rest */
    const STROKE_COLOR_ACTIVE = [80, 80, 80];     /* RGB color array when pointer is near */

    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animId: number;
    let time = 0;
    let idleTime = 0;
    const smoothPointer = { x: -1000, y: -1000 };
    let points: Array<{
      x: number;
      y: number;
      baseX: number;
      baseY: number;
      angle: number;
      restAngle: number;
      scale: number;
      opacity: number;
    }> = [];

    const calculateRestAngle = (x: number, y: number) => {
      switch (ANGLE_AT_REST_MODE) {
        case 'vertical':
          return Math.PI / 2;
        case 'diagonal':
          return Math.PI / 4;
        case 'wave':
          return Math.sin(x * 0.015 + y * 0.015) * (Math.PI / 3);
        case 'horizontal':
        default:
          return ANGLE_AT_REST;
      }
    };

    const getStrokeColor = (proximity: number) => {
      if (!COLOR_BY_PROXIMITY) {
        return `rgb(${STROKE_COLOR_REST[0]}, ${STROKE_COLOR_REST[1]}, ${STROKE_COLOR_REST[2]})`;
      }
      const r = Math.round(STROKE_COLOR_REST[0] + (STROKE_COLOR_ACTIVE[0] - STROKE_COLOR_REST[0]) * proximity);
      const g = Math.round(STROKE_COLOR_REST[1] + (STROKE_COLOR_ACTIVE[1] - STROKE_COLOR_REST[1]) * proximity);
      const b = Math.round(STROKE_COLOR_REST[2] + (STROKE_COLOR_ACTIVE[2] - STROKE_COLOR_REST[2]) * proximity);
      return `rgb(${r}, ${g}, ${b})`;
    };

    const setupGrid = () => {
      const rect = container.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      ctx.scale(dpr, dpr);

      const spacing = Math.max(12, GRID_SPACING);
      const cols = Math.floor(rect.width / spacing);
      const rows = Math.floor(rect.height / spacing);
      const offsetX = (rect.width - cols * spacing) / 2 + spacing / 2;
      const offsetY = (rect.height - rows * spacing) / 2 + spacing / 2;

      points = [];
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const x = offsetX + c * spacing;
          const y = offsetY + r * spacing;
          const restAngle = calculateRestAngle(x, y);

          points.push({
            x,
            y,
            baseX: x,
            baseY: y,
            angle: restAngle,
            restAngle,
            scale: 1,
            opacity: BASE_OPACITY,
          });
        }
      }
    };

    setupGrid();
    const resizeObserver = new ResizeObserver(setupGrid);
    resizeObserver.observe(container);

    /*
      Pointer tracking is listened for on `window`, not on this component's own
      element, and that is the whole trick to this layer.

      The grid has to be behind the login card AND stay alive while the pointer
      is over that card. As a React `onPointerMove` prop on the container those
      two are mutually exclusive: to stop the full-size layer from swallowing
      clicks it needs `pointer-events: none`, and an element that ignores
      pointer events is also never the target of one, so the handler goes
      silent and the grid freezes. Anything in front of it (the card, the
      heading, the buttons) would block the events even without that.

      `window` sits above every one of those, so the coordinates arrive no
      matter what the pointer is over; they get projected into the container's
      local space with the same getBoundingClientRect() maths the element
      handler used.
    */
    const handleWindowPointerMove = (event: PointerEvent) => {
      const rect = container.getBoundingClientRect();
      pointerRef.current = {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
        isActive: true,
        isDirect: true,
      };
    };

    /*
      Fires only when the pointer leaves the document itself — moving between
      elements inside the page does not reach here — so this is the honest
      "the pointer is gone" signal that hands the grid back to ambient motion.
    */
    const handleDocumentPointerLeave = () => {
      pointerRef.current.isActive = false;
      pointerRef.current.isDirect = false;
    };

    window.addEventListener('pointermove', handleWindowPointerMove, { passive: true });
    document.documentElement.addEventListener('pointerleave', handleDocumentPointerLeave);

    /*
      Animation Loop
    */
    const render = () => {
      const rect = container.getBoundingClientRect();
      const width = rect.width;
      const height = rect.height;

      time += 0.016;

      /*
        Idle Ambient Motion demo when pointer is inactive
      */
      if (!pointerRef.current.isDirect && IS_AMBIENT_MOTION_ENABLED) {
        idleTime += 0.012;
        const cx = width / 2;
        const cy = height / 2;
        const radiusX = Math.min(width * 0.35, 280);
        const radiusY = Math.min(height * 0.3, 200);

        pointerRef.current.x = cx + Math.sin(idleTime) * radiusX;
        pointerRef.current.y = cy + Math.sin(idleTime * 0.7) * radiusY;
        pointerRef.current.isActive = true;
      }

      /*
        Smooth pointer lerp
      */
      if (pointerRef.current.isActive) {
        if (smoothPointer.x === -1000) {
          smoothPointer.x = pointerRef.current.x;
          smoothPointer.y = pointerRef.current.y;
        } else {
          smoothPointer.x += (pointerRef.current.x - smoothPointer.x) * 0.2;
          smoothPointer.y += (pointerRef.current.y - smoothPointer.y) * 0.2;
        }
      } else {
        smoothPointer.x += (-1000 - smoothPointer.x) * 0.1;
        smoothPointer.y += (-1000 - smoothPointer.y) * 0.1;
      }

      const px = smoothPointer.x;
      const py = smoothPointer.y;

      ctx.clearRect(0, 0, width, height);

      const radius = Math.max(10, INFLUENCE_RADIUS);
      const radiusSq = radius * radius;
      const smoothingFactor = Math.min(0.5, Math.max(0.01, SMOOTHING));

      ctx.lineCap = 'round';
      ctx.lineWidth = LINE_WIDTH;

      for (let i = 0; i < points.length; i++) {
        const pt = points[i];
        pt.restAngle = calculateRestAngle(pt.baseX, pt.baseY);

        const dx = px - pt.baseX;
        const dy = py - pt.baseY;
        const distSq = dx * dx + dy * dy;

        let targetAngle = pt.restAngle;
        let targetScale = 1;
        let targetOpacity = BASE_OPACITY;
        let proximityFactor = 0;
        let targetX = pt.baseX;
        let targetY = pt.baseY;

        if (distSq < radiusSq && pointerRef.current.isActive) {
          const dist = Math.sqrt(distSq);
          const normDist = dist / radius;
          proximityFactor = Math.cos(normDist * Math.PI * 0.5);

          let calculatedAngle = Math.atan2(dy, dx);

          switch (DISTORTION_MODE) {
            case 'push':
              calculatedAngle += Math.PI;
              break;
            case 'vortex':
              calculatedAngle += Math.PI / 2 + (1 - normDist) * 0.5;
              break;
            case 'ripple':
              calculatedAngle = pt.restAngle + Math.sin(dist * 0.04 - time * 4) * Math.PI * proximityFactor;
              break;
            case 'pull':
              targetX = pt.baseX + (dx / dist) * proximityFactor * (radius * 0.15);
              targetY = pt.baseY + (dy / dist) * proximityFactor * (radius * 0.15);
              break;
            case 'pointer':
            default:
              break;
          }

          targetAngle = pt.restAngle + (calculatedAngle - pt.restAngle) * proximityFactor;
          targetScale = 1 + proximityFactor * 0.6;
          targetOpacity = BASE_OPACITY + proximityFactor * OPACITY_RANGE;
        }

        pt.x += (targetX - pt.x) * smoothingFactor;
        pt.y += (targetY - pt.y) * smoothingFactor;

        let angleDiff = (targetAngle - pt.angle) % (Math.PI * 2);
        if (angleDiff < -Math.PI) angleDiff += Math.PI * 2;
        if (angleDiff > Math.PI) angleDiff -= Math.PI * 2;

        pt.angle += angleDiff * smoothingFactor;
        pt.scale += (targetScale - pt.scale) * smoothingFactor;
        pt.opacity += (targetOpacity - pt.opacity) * smoothingFactor;

        ctx.strokeStyle = getStrokeColor(proximityFactor);
        ctx.globalAlpha = Math.min(1, Math.max(0.05, pt.opacity));

        const halfLen = (LINE_LENGTH * pt.scale) / 2;
        const cosA = Math.cos(pt.angle);
        const sinA = Math.sin(pt.angle);

        ctx.beginPath();
        ctx.moveTo(pt.x - halfLen * cosA, pt.y - halfLen * sinA);
        ctx.lineTo(pt.x + halfLen * cosA, pt.y + halfLen * sinA);
        ctx.stroke();
      }

      ctx.globalAlpha = 1.0;

      /*
        Draw optional debug radius indicator
      */
      if (SHOW_DEBUG_CURSOR && pointerRef.current.isActive) {
        ctx.beginPath();
        ctx.arc(px, py, radius, 0, Math.PI * 2);
        ctx.strokeStyle = "rgba(26, 26, 26, 0.15)";
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
        ctx.stroke();
        ctx.setLineDash([]);

        ctx.beginPath();
        ctx.arc(px, py, 3, 0, Math.PI * 2);
        ctx.fillStyle = getStrokeColor(1);
        ctx.fill();
      }

      animId = requestAnimationFrame(render);
    };

    render();

    return () => {
      cancelAnimationFrame(animId);
      resizeObserver.disconnect();
      window.removeEventListener('pointermove', handleWindowPointerMove);
      document.documentElement.removeEventListener('pointerleave', handleDocumentPointerLeave);
    };
  }, [
    COLOR_BY_PROXIMITY,
    IS_AMBIENT_MOTION_ENABLED,
    OPACITY_RANGE,
    SHOW_DEBUG_CURSOR
  ]);

  return (
    <div
      ref={containerRef}
      style={{ backgroundColor: BACKGROUND_COLOR }}
      /*
        `absolute inset-0` because this is a backdrop, not a block in the flow:
        left in the flow it stacks above the page content and pushes it down.
        `z-0` against the content's `z-10` states the paint order outright
        instead of leaving it to DOM order, and `pointer-events-none` keeps the
        layer out of hit-testing entirely — the effect above is what keeps it
        responsive without it.
      */
      className="pointer-events-none absolute inset-0 z-0 overflow-hidden select-none"
      aria-hidden
    >
      <canvas ref={canvasRef} className="block w-full h-full" />
    </div>
  );
};
