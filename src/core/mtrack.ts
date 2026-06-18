// .mtrack file format I/O. The on-disk format is JSON with SNAKE_CASE keys and
// [x, y] arrays, and must stay byte-compatible with files saved by the original
// Python app (SPEC "File Format"). The in-memory state uses camelCase objects
// ({x, y}), so we map field names HERE, at the boundary — never JSON.stringify
// the state shape directly (CLAUDE rule 5), or we'd emit camelCase and silently
// break compatibility.

import type { ControlPoint } from './state'

// The on-disk shape (one control point).
interface MtrackPoint {
  pos: [number, number]
  in_tangent: [number, number]
  out_tangent: [number, number]
  mirrored: boolean
}
interface MtrackFile {
  control_points: MtrackPoint[]
}

/** Serialize the in-memory control points to the .mtrack JSON string. */
export function toMtrack(points: ControlPoint[]): string {
  const file: MtrackFile = {
    control_points: points.map((p) => ({
      pos: [p.pos.x, p.pos.y],
      in_tangent: [p.inTangent.x, p.inTangent.y],
      out_tangent: [p.outTangent.x, p.outTangent.y],
      mirrored: p.mirrored,
    })),
  }
  return JSON.stringify(file, null, 2)
}

/** A finite [x, y] pair, the on-disk vector shape. */
function isPair(v: unknown): v is [number, number] {
  return Array.isArray(v) && v.length === 2 && Number.isFinite(v[0]) && Number.isFinite(v[1])
}

/**
 * Parse a .mtrack JSON string into in-memory control points, mapping snake_case
 * [x, y] back to camelCase {x, y}. Throws a descriptive Error on anything that
 * isn't a valid .mtrack (the file comes from disk — it's untrusted).
 */
export function fromMtrack(text: string): ControlPoint[] {
  const data: unknown = JSON.parse(text) // throws on malformed JSON
  const cps = (data as { control_points?: unknown })?.control_points
  if (!Array.isArray(cps)) {
    throw new Error('Not a .mtrack file (missing "control_points").')
  }
  return cps.map((raw, i) => {
    const c = raw as Record<string, unknown>
    if (
      !isPair(c.pos) ||
      !isPair(c.in_tangent) ||
      !isPair(c.out_tangent) ||
      typeof c.mirrored !== 'boolean'
    ) {
      throw new Error(`Invalid control point at index ${i}.`)
    }
    return {
      pos: { x: c.pos[0], y: c.pos[1] },
      inTangent: { x: c.in_tangent[0], y: c.in_tangent[1] },
      outTangent: { x: c.out_tangent[0], y: c.out_tangent[1] },
      mirrored: c.mirrored,
    }
  })
}

/**
 * Open the OS file picker and resolve with the parsed control points, or null if
 * the picker is dismissed without a file. Rejects if the chosen file can't be
 * read or parsed. Uses a throwaway <input> so there's no hidden element in the
 * React tree (and Ctrl+O can call it without touching React).
 */
export function openMtrackDialog(): Promise<ControlPoint[] | null> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.mtrack,application/json'
    input.onchange = () => {
      const file = input.files?.[0]
      if (!file) {
        resolve(null)
        return
      }
      const reader = new FileReader()
      reader.onload = () => {
        try {
          resolve(fromMtrack(String(reader.result)))
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)))
        }
      }
      reader.onerror = () => reject(reader.error ?? new Error('Could not read file.'))
      reader.readAsText(file)
    }
    input.click()
  })
}

/** Trigger a browser download of the current track as a .mtrack file. */
export function downloadMtrack(points: ControlPoint[], filename = 'track.mtrack'): void {
  const blob = new Blob([toMtrack(points)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}
