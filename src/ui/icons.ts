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

const appliedIconMarkup = new WeakMap<SVGSVGElement, string>()

export const applySvgIconMarkup = (svg: SVGSVGElement, markup: string) => {
  if (
    appliedIconMarkup.get(svg) === markup &&
    svg.getAttribute("viewBox") === "0 0 16 16" &&
    svg.getAttribute("fill") === "currentColor" &&
    svg.childNodes.length > 0
  ) {
    return
  }
  svg.setAttribute("viewBox", "0 0 16 16")
  svg.setAttribute("fill", "currentColor")
  svg.innerHTML = markup
  appliedIconMarkup.set(svg, markup)
}

export const applyEnhanceIcon = (svg: SVGSVGElement) => {
  const icons = typeof Spicetify !== "undefined" ? Spicetify.SVGIcons : undefined
  const markup = icons?.enhance ?? icons?.shuffle ?? ""
  if (!markup) return
  applySvgIconMarkup(svg, markup)
}

export const applyRefreshIcon = (svg: SVGSVGElement) => {
  applySvgIconMarkup(svg, RESHUFFLE_ICON_MARKUP)
}

export const PLAYLIST_ADD_ICON_MARKUP =
  '<path d="M1 3.75A.75.75 0 0 1 1.75 3h10.5a.75.75 0 0 1 0 1.5H1.75A.75.75 0 0 1 1 3.75zm0 4A.75.75 0 0 1 1.75 7h7.5a.75.75 0 0 1 0 1.5h-7.5A.75.75 0 0 1 1 7.75zm0 4a.75.75 0 0 1 .75-.75h4.5a.75.75 0 0 1 0 1.5h-4.5a.75.75 0 0 1-.75-.75zM12.75 8a.75.75 0 0 1 .75.75v2h2a.75.75 0 0 1 0 1.5h-2v2a.75.75 0 0 1-1.5 0v-2h-2a.75.75 0 0 1 0-1.5h2v-2a.75.75 0 0 1 .75-.75z"/>'

export const CHECK_ICON_MARKUP =
  '<path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.75.75 0 0 1 1.06-1.06L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0z"/>'

export const applyPlaylistAddIcon = (svg: SVGSVGElement) => {
  const icons = typeof Spicetify !== "undefined" ? Spicetify.SVGIcons : undefined
  const markup = icons?.addToPlaylist ?? icons?.playlist ?? PLAYLIST_ADD_ICON_MARKUP
  applySvgIconMarkup(svg, markup)
}

export const applyCheckIcon = (svg: SVGSVGElement) => {
  const icons = typeof Spicetify !== "undefined" ? Spicetify.SVGIcons : undefined
  const markup = icons?.check ?? CHECK_ICON_MARKUP
  applySvgIconMarkup(svg, markup)
}
