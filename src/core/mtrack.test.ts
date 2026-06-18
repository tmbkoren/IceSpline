// Guards the .mtrack serialization contract: snake_case keys, [x, y] arrays, and
// the `control_points` root — the format that must stay compatible with files
// saved by the original Python app. A camelCase regression here would silently
// break that compatibility, so we pin the exact shape.

import { describe, it, expect } from 'vitest'
import { toMtrack, fromMtrack } from './mtrack'
import type { ControlPoint } from './state'
// A genuine Python-saved file, imported as a raw string (Vite ?raw).
import sec1Raw from '../../docs/sec1.mtrack?raw'

describe('toMtrack', () => {
  it('maps in-memory points to snake_case control_points with [x, y] arrays', () => {
    const points: ControlPoint[] = [
      { pos: { x: 1, y: 2 }, inTangent: { x: -3, y: 4 }, outTangent: { x: 5, y: -6 }, mirrored: true },
    ]
    expect(JSON.parse(toMtrack(points))).toEqual({
      control_points: [
        { pos: [1, 2], in_tangent: [-3, 4], out_tangent: [5, -6], mirrored: true },
      ],
    })
  })

  it('serializes an empty track to an empty control_points array', () => {
    expect(JSON.parse(toMtrack([]))).toEqual({ control_points: [] })
  })
})

describe('fromMtrack', () => {
  it('parses a real file saved by the Python app (docs/sec1.mtrack)', () => {
    // The discriminating artifact: a genuine Python-produced .mtrack. If our key
    // names or [x,y] order were wrong, this would throw or mis-map.
    const points = fromMtrack(sec1Raw)
    expect(points).toHaveLength(13)
    expect(points[0]).toEqual({
      pos: { x: 564.7996031746036, y: 420.6250000000003 },
      inTangent: { x: -0.7031746031750004, y: 12.779761904761642 },
      outTangent: { x: 0.7031746031750004, y: -12.779761904761642 },
      mirrored: true,
    })
    // Round-trip is stable: export then re-import yields the same points.
    expect(fromMtrack(toMtrack(points))).toEqual(points)
  })

  it('rejects malformed input', () => {
    expect(() => fromMtrack('not json')).toThrow()
    expect(() => fromMtrack('{}')).toThrow(/control_points/)
    expect(() => fromMtrack('{"control_points":[{"pos":[1,2]}]}')).toThrow(/index 0/)
  })
})
