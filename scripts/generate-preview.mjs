import { writeFileSync } from "fs"
import { dirname, join } from "path"
import { fileURLToPath } from "url"
import { Resvg } from "@resvg/resvg-js"

const __dirname = dirname(fileURLToPath(import.meta.url))
const rootDir = join(__dirname, "..")

const enhancePath =
  "M11.777.972c-.364 1.054-1.195 2.322-2.798 2.83-.115.036-.115.36 0 .396 1.603.508 2.434 1.775 2.798 2.83.04.114.406.114.446 0 .364-1.055 1.195-2.322 2.798-2.83.115-.036.115-.36 0-.396-1.603-.508-2.434-1.776-2.798-2.83-.04-.114-.406-.114-.446 0zM5.295 4.5a.75.75 0 01.747.682c.06.65.334 1.68.954 2.572.606.87 1.527 1.596 2.927 1.75a.75.75 0 010 1.491c-1.4.154-2.321.88-2.927 1.751a5.683 5.683 0 00-.954 2.572.75.75 0 01-1.493 0 5.683 5.683 0 00-.954-2.572c-.606-.87-1.527-1.597-2.927-1.75a.75.75 0 010-1.492c1.4-.154 2.321-.88 2.927-1.75.62-.892.894-1.922.954-2.572a.75.75 0 01.746-.682z"

const glowFilters = (prefix) => `
    <filter id="${prefix}-glow-soft" x="-80%" y="-80%" width="260%" height="260%">
      <feGaussianBlur stdDeviation="14" result="blur"/>
      <feColorMatrix in="blur" type="matrix" values="0 0 0 0 0.11  0 0 0 0 0.73  0 0 0 0 0.33  0 0 0 0.6 0"/>
      <feMerge>
        <feMergeNode/>
        <feMergeNode in="SourceGraphic"/>
      </feMerge>
    </filter>
    <filter id="${prefix}-glow-strong" x="-100%" y="-100%" width="300%" height="300%">
      <feGaussianBlur stdDeviation="32" result="blur"/>
      <feColorMatrix in="blur" type="matrix" values="0 0 0 0 0.11  0 0 0 0 0.85  0 0 0 0 0.33  0 0 0 0.4 0"/>
      <feMerge>
        <feMergeNode/>
        <feMergeNode in="SourceGraphic"/>
      </feMerge>
    </filter>`

const iconLayers = (scale, offset, glowPrefix) => `
    <g filter="url(#${glowPrefix}-glow-strong)" opacity="0.9">
      <path d="${enhancePath}" fill="#1DB954" transform="translate(${offset} ${offset}) scale(${scale})"/>
    </g>
    <g filter="url(#${glowPrefix}-glow-soft)">
      <path d="${enhancePath}" fill="#1ED760" transform="translate(${offset} ${offset}) scale(${scale})"/>
    </g>
    <path d="${enhancePath}" fill="#1DB954" transform="translate(${offset} ${offset}) scale(${scale})"/>`

const previewIconSvg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024" fill="none">
  <defs>
    <radialGradient id="bg-icon" cx="50%" cy="48%" r="62%">
      <stop offset="0%" stop-color="#1a2e22"/>
      <stop offset="60%" stop-color="#0a0a0a"/>
      <stop offset="100%" stop-color="#000000"/>
    </radialGradient>
    ${glowFilters("icon")}
  </defs>

  <rect width="1024" height="1024" fill="url(#bg-icon)"/>

  <g transform="translate(512 512)">
    ${iconLayers(28, -224, "icon")}
  </g>
</svg>`

const previewBannerSvg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720" fill="none">
  <defs>
    <linearGradient id="bg-banner" x1="0" y1="360" x2="1280" y2="360" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#0a0a0a"/>
      <stop offset="45%" stop-color="#122018"/>
      <stop offset="100%" stop-color="#0a0a0a"/>
    </linearGradient>
    ${glowFilters("banner")}
  </defs>

  <rect width="1280" height="720" fill="url(#bg-banner)"/>

  <g transform="translate(340 360)">
    ${iconLayers(14, -112, "banner")}
  </g>

  <text x="500" y="332" fill="#B3B3B3" font-family="Segoe UI, Helvetica Neue, Arial, sans-serif" font-size="36" font-weight="500" letter-spacing="0.5">Spicetify</text>
  <text x="500" y="408" fill="#FFFFFF" font-family="Segoe UI, Helvetica Neue, Arial, sans-serif" font-size="72" font-weight="700" letter-spacing="-1">Better Shuffle</text>
</svg>`

const renderPng = (svg, width, outPath) => {
  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: width },
  })
  writeFileSync(outPath, resvg.render().asPng())
  console.log(`Wrote ${outPath}`)
}

writeFileSync(join(rootDir, "assets", "preview-icon-source.svg"), previewIconSvg, "utf8")
writeFileSync(join(rootDir, "assets", "preview-banner-source.svg"), previewBannerSvg, "utf8")

renderPng(previewIconSvg, 1024, join(rootDir, "preview-icon.png"))
renderPng(previewBannerSvg, 1280, join(rootDir, "preview-banner.png"))
