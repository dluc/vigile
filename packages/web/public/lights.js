/**
 * The moving background of the board: six soft lights that sweep slowly across the window, each with a faint
 * beam from the top edge. The drawing is the "Disco" wallpaper of opencode-conversation-wallpaper (MIT, by the
 * same author), in the colours of its "Aurora" wallpaper, at 0.7 times its speed. Sweeps are slow and the light
 * is constant: nothing flashes.
 */

/** Aurora's teal, cyan and violet. On a light page they are drawn darker, so that they show at all. */
const COLOURS = {
  dark: ["71, 233, 167", "63, 206, 214", "129, 123, 236", "79, 221, 175"],
  light: ["22, 150, 104", "20, 132, 142", "92, 84, 200", "28, 142, 110"],
};
/** How fast time passes for the lights, against the wallpaper they come from. Fixed: there is no setting for it. */
export const LIGHTS_SPEED = 0.7;
/** Frames a second, at most. The board's own work comes first. */
const FRAMES = 24;

/**
 * Draws the lights on `canvas`. `appearance` says whether the page is "light" or "dark" just now. Returns
 * `start` and `stop`. While it runs, the canvas says how far it is in `data-time`, in seconds of its own time,
 * and how many frames it has drawn in `data-frames`.
 */
export function lights(canvas, appearance) {
  const ctx = canvas.getContext("2d");
  let width = 0;
  let height = 0;
  let time = 0;
  let previous = 0;
  let frame = 0;
  let frames = 0;

  const fit = () => {
    const ratio = Math.min(devicePixelRatio || 1, 2);
    width = canvas.clientWidth;
    height = canvas.clientHeight;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    ctx?.setTransform(ratio, 0, 0, ratio, 0, 0);
  };

  const paint = () => {
    if (!ctx || !width || !height) return;
    const hues = COLOURS[appearance()] ?? COLOURS.dark;
    ctx.clearRect(0, 0, width, height);
    ctx.save();
    for (let i = 0; i < 6; i++) {
      const hue = hues[i % 4];
      const x = width * (0.5 + Math.sin(time * 0.16 + i * 1.7) * 0.47);
      const y = height * (0.5 + Math.cos(time * 0.12 + i * 2.1) * 0.4);
      const radius = Math.max(width, height) * 0.28;
      const glow = ctx.createRadialGradient(x, y, 0, x, y, radius);
      glow.addColorStop(0, `rgba(${hue}, 0.5)`);
      glow.addColorStop(0.45, `rgba(${hue}, 0.23)`);
      glow.addColorStop(1, `rgba(${hue}, 0)`);
      ctx.fillStyle = glow;
      ctx.globalAlpha = 0.65 + Math.sin(time * 0.2 + i) * 0.08;
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fill();
      const beam = ctx.createLinearGradient(x - radius * 0.4, y, x + radius * 0.4, y);
      beam.addColorStop(0, `rgba(${hue}, 0)`);
      beam.addColorStop(0.5, `rgba(${hue}, 0.16)`);
      beam.addColorStop(1, `rgba(${hue}, 0)`);
      ctx.fillStyle = beam;
      ctx.beginPath();
      ctx.moveTo(width * (i / 5), -height * 0.1);
      ctx.lineTo(x - radius * 0.4, y);
      ctx.lineTo(x + radius * 0.4, y);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
    canvas.dataset.time = time.toFixed(3);
    canvas.dataset.frames = String(++frames);
  };

  const tick = (now) => {
    if (!previous || now - previous >= 1000 / FRAMES) {
      // A long gap, such as a tab that was out of sight, does not make the lights jump.
      time += (previous ? Math.min(0.1, (now - previous) / 1000) : 0) * LIGHTS_SPEED;
      paint();
      previous = now;
    }
    frame = requestAnimationFrame(tick);
  };
  const refit = () => {
    fit();
    paint();
  };

  return {
    /** Draws the lights as they are at one moment of their own time, whether or not they are running. */
    at(moment) {
      time = moment;
      refit();
    },
    start() {
      if (frame) return;
      refit();
      addEventListener("resize", refit);
      previous = 0;
      frame = requestAnimationFrame(tick);
    },
    stop() {
      cancelAnimationFrame(frame);
      frame = 0;
      removeEventListener("resize", refit);
    },
  };
}
