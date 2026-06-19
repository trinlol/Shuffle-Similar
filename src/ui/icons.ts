/**
 * Reshuffle icon - a clean circular-arrows glyph that matches Spotify's
 * 16×16 control style.  Two curved arrows forming a loop, conveying
 * "refresh / reshuffle" without looking like a browser reload button.
 */
export const RESHUFFLE_ICON_MARKUP = [
  // Upper-right arrow (clockwise arc with arrowhead)
  `<path d="M13.5 8A5.5 5.5 0 0 0 8 2.5V1l-2.5 2L8 5V3.5A4.5 4.5 0 0 1 12.5 8h1z"/>`,
  // Lower-left arrow (counter-clockwise arc with arrowhead)
  `<path d="M2.5 8A5.5 5.5 0 0 0 8 13.5V15l2.5-2L8 11v1.5A4.5 4.5 0 0 1 3.5 8h-1z"/>`,
].join("")

export const applySvgIconMarkup = (svg: SVGSVGElement, markup: string) => {
  svg.setAttribute("viewBox", "0 0 16 16")
  svg.setAttribute("fill", "currentColor")
  svg.innerHTML = markup
}

export const applyEnhanceIcon = (svg: SVGSVGElement) => {
  const markup = Spicetify.SVGIcons?.enhance ?? Spicetify.SVGIcons?.shuffle ?? ""
  if (!markup) return
  applySvgIconMarkup(svg, markup)
}

export const applyRefreshIcon = (svg: SVGSVGElement) => {
  applySvgIconMarkup(svg, RESHUFFLE_ICON_MARKUP)
}
