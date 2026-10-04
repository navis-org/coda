/**
 * A colour as somebody else's file spells it, read into the `#rrggbb` Coda draws with.
 *
 * Coda's own colour columns take hex only (`literalColor` in `ui/encoding.ts`), deliberately: a
 * column of cell types read as colours is a mistake, and guessing a hue from the text would hide
 * it. A file *written by another tool* is different — BigClust's `color` column holds whatever
 * Python's `cmap.Color` accepted, which is CSS names (`orange`), hex, and RGB(A) tuples in 0–1 or
 * 0–255 — so a reader of one converts at its own edge, as each source converts ids at its own.
 *
 * Headless, so the 148 CSS names are a table rather than a canvas `fillStyle` round trip. The
 * table is CSS Color 4's named colours, generated from matplotlib's `CSS4_COLORS` rather than
 * typed.
 */

import type { CellValue } from '../core/values'

// prettier-ignore
const NAMED = new Map(
  (
    'aliceblue:f0f8ff antiquewhite:faebd7 aqua:00ffff aquamarine:7fffd4 azure:f0ffff beige:f5f5dc ' +
    'bisque:ffe4c4 black:000000 blanchedalmond:ffebcd blue:0000ff blueviolet:8a2be2 brown:a52a2a ' +
    'burlywood:deb887 cadetblue:5f9ea0 chartreuse:7fff00 chocolate:d2691e coral:ff7f50 ' +
    'cornflowerblue:6495ed cornsilk:fff8dc crimson:dc143c cyan:00ffff darkblue:00008b ' +
    'darkcyan:008b8b darkgoldenrod:b8860b darkgray:a9a9a9 darkgreen:006400 darkgrey:a9a9a9 ' +
    'darkkhaki:bdb76b darkmagenta:8b008b darkolivegreen:556b2f darkorange:ff8c00 ' +
    'darkorchid:9932cc darkred:8b0000 darksalmon:e9967a darkseagreen:8fbc8f darkslateblue:483d8b ' +
    'darkslategray:2f4f4f darkslategrey:2f4f4f darkturquoise:00ced1 darkviolet:9400d3 ' +
    'deeppink:ff1493 deepskyblue:00bfff dimgray:696969 dimgrey:696969 dodgerblue:1e90ff ' +
    'firebrick:b22222 floralwhite:fffaf0 forestgreen:228b22 fuchsia:ff00ff gainsboro:dcdcdc ' +
    'ghostwhite:f8f8ff gold:ffd700 goldenrod:daa520 gray:808080 green:008000 greenyellow:adff2f ' +
    'grey:808080 honeydew:f0fff0 hotpink:ff69b4 indianred:cd5c5c indigo:4b0082 ivory:fffff0 ' +
    'khaki:f0e68c lavender:e6e6fa lavenderblush:fff0f5 lawngreen:7cfc00 lemonchiffon:fffacd ' +
    'lightblue:add8e6 lightcoral:f08080 lightcyan:e0ffff lightgoldenrodyellow:fafad2 ' +
    'lightgray:d3d3d3 lightgreen:90ee90 lightgrey:d3d3d3 lightpink:ffb6c1 lightsalmon:ffa07a ' +
    'lightseagreen:20b2aa lightskyblue:87cefa lightslategray:778899 lightslategrey:778899 ' +
    'lightsteelblue:b0c4de lightyellow:ffffe0 lime:00ff00 limegreen:32cd32 linen:faf0e6 ' +
    'magenta:ff00ff maroon:800000 mediumaquamarine:66cdaa mediumblue:0000cd mediumorchid:ba55d3 ' +
    'mediumpurple:9370db mediumseagreen:3cb371 mediumslateblue:7b68ee mediumspringgreen:00fa9a ' +
    'mediumturquoise:48d1cc mediumvioletred:c71585 midnightblue:191970 mintcream:f5fffa ' +
    'mistyrose:ffe4e1 moccasin:ffe4b5 navajowhite:ffdead navy:000080 oldlace:fdf5e6 olive:808000 ' +
    'olivedrab:6b8e23 orange:ffa500 orangered:ff4500 orchid:da70d6 palegoldenrod:eee8aa ' +
    'palegreen:98fb98 paleturquoise:afeeee palevioletred:db7093 papayawhip:ffefd5 ' +
    'peachpuff:ffdab9 peru:cd853f pink:ffc0cb plum:dda0dd powderblue:b0e0e6 purple:800080 ' +
    'rebeccapurple:663399 red:ff0000 rosybrown:bc8f8f royalblue:4169e1 saddlebrown:8b4513 ' +
    'salmon:fa8072 sandybrown:f4a460 seagreen:2e8b57 seashell:fff5ee sienna:a0522d silver:c0c0c0 ' +
    'skyblue:87ceeb slateblue:6a5acd slategray:708090 slategrey:708090 snow:fffafa ' +
    'springgreen:00ff7f steelblue:4682b4 tan:d2b48c teal:008080 thistle:d8bfd8 tomato:ff6347 ' +
    'turquoise:40e0d0 violet:ee82ee wheat:f5deb3 white:ffffff whitesmoke:f5f5f5 yellow:ffff00 ' +
    'yellowgreen:9acd32'
  )
    .split(' ')
    .map((pair) => pair.split(':') as [string, string]),
)

const HEX = /^#?([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i

/**
 * `#rrggbb` for a CSS name, a hex string (with or without `#`, alpha dropped) or an RGB(A) list —
 * 0–1 when every channel is, 0–255 otherwise. Undefined for anything else, a null included.
 */
export function foreignColor(
  value: CellValue | readonly unknown[] | undefined,
): string | undefined {
  if (Array.isArray(value)) return rgbHex(value)
  if (typeof value !== 'string') return undefined
  const text = value.trim().toLowerCase()
  const named = NAMED.get(text.replace(/\s+/g, ''))
  if (named) return `#${named}`
  const hex = HEX.exec(text)?.[1]
  if (!hex) return undefined
  const full = hex.length === 3 ? [...hex].map((d) => d + d).join('') : hex.slice(0, 6)
  return `#${full}`
}

function rgbHex(channels: readonly unknown[]): string | undefined {
  const rgb = channels.slice(0, 3)
  if (rgb.length < 3 || !rgb.every((v) => typeof v === 'number' && Number.isFinite(v))) {
    return undefined
  }
  const values = rgb as number[]
  const scale = values.every((v) => v <= 1) ? 255 : 1
  return `#${values
    .map((v) =>
      Math.round(Math.min(255, Math.max(0, v * scale)))
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`
}
