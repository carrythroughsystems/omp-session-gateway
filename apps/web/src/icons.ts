const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

const EYE = [
  "M2.5 10c1.9-3.1 4.4-4.6 7.5-4.6s5.6 1.5 7.5 4.6c-1.9 3.1-4.4 4.6-7.5 4.6S4.4 13.1 2.5 10Z",
  "M12.4 10a2.4 2.4 0 1 1-4.8 0 2.4 2.4 0 0 1 4.8 0Z",
] as const;

/**
 * The interface's icons: one 20px grid of round-capped strokes in the current text color
 * (`.icon` in styles.css). Controls draw these instead of text glyphs, which change shape with
 * the font that happens to answer for them.
 */
const ICONS = {
  check: ["M4 10l4 4 8-8"],
  "chevron-down": ["M5 7.5l5 5 5-5"],
  "chevron-left": ["M12.5 5l-5 5 5 5"],
  "chevron-right": ["M7.5 5l5 5-5 5"],
  expand: ["M12 3h5v5M17 3l-6 6M8 17H3v-5M3 17l6-6"],
  eye: EYE,
  "eye-off": [...EYE, "M4.5 15.5l11-11"],
  send: ["M17.5 2.5 2.5 8l6.5 3 3 6.5 5.5-15Z", "M9 11l8.5-8.5"],
} as const;

export type IconName = keyof typeof ICONS;

/** A decorative icon; `pathLength` is normalized so a stylesheet can draw any of them in. */
export function createIcon(name: IconName, className = "icon"): SVGSVGElement {
  const svg = document.createElementNS(SVG_NAMESPACE, "svg");
  svg.setAttribute("class", className);
  svg.setAttribute("viewBox", "0 0 20 20");
  svg.setAttribute("width", "20");
  svg.setAttribute("height", "20");
  svg.setAttribute("aria-hidden", "true");
  for (const data of ICONS[name]) {
    const path = document.createElementNS(SVG_NAMESPACE, "path");
    path.setAttribute("d", data);
    path.setAttribute("pathLength", "1");
    svg.append(path);
  }
  return svg;
}
