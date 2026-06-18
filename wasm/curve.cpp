// The compute core: cubic Bézier -> block rasterization, compiled to WASM.
//
// This is a LINE-FOR-LINE port of src/core/blocks.ts. The two must stay in
// lockstep: the differential test (Vitest) feeds both the same curves and
// asserts identical block sets. That only holds because IEEE-754 binary64 math
// is bit-identical across JS and WASM *when the operations and their order
// match*. So every arithmetic expression here mirrors the TS exactly:
//   • squared-distance compare (no hypot)
//   • explicit Bézier multiplication (no pow)
//   • same summation order; same int<->double casts written out deliberately
// If you change the algorithm, change blocks.ts in the same commit.
//
// No DOM, no state, no I/O — pure computation (CLAUDE.md architecture).

#include <cstdint>
#include <cmath>
#include <unordered_set>

// --- helpers (file-local; not part of the C ABI) --------------------------

// Euclidean distance via sqrt(dx²+dy²) — matches JS Math.sqrt and C++ std::sqrt.
static double dist(double ax, double ay, double bx, double by) {
  double dx = bx - ax;
  double dy = by - ay;
  return std::sqrt(dx * dx + dy * dy);
}

// Stamp every grid cell whose center (x+0.5, y+0.5) is within r of the line
// segment A->B (a "capsule"). Mirrors blocks.ts stampCapsule op-for-op:
// squared distances, fixed projection/clamp/dot-product order.
static void stamp_capsule(double ax, double ay, double bx, double by,
                          double r, double r2, std::unordered_set<int64_t>& cells) {
  int minX = (int)std::floor((ax < bx ? ax : bx) - r);
  int maxX = (int)std::ceil((ax > bx ? ax : bx) + r);
  int minY = (int)std::floor((ay < by ? ay : by) - r);
  int maxY = (int)std::ceil((ay > by ? ay : by) + r);

  double abx = bx - ax;
  double aby = by - ay;
  double abLen2 = abx * abx + aby * aby;

  for (int x = minX; x <= maxX; x++) {
    for (int y = minY; y <= maxY; y++) {
      double cxp = x + 0.5;
      double cyp = y + 0.5;
      double apx = cxp - ax;
      double apy = cyp - ay;
      double tt = abLen2 > 0 ? (apx * abx + apy * aby) / abLen2 : 0.0;
      if (tt < 0) tt = 0;
      else if (tt > 1) tt = 1;
      double qx = ax + tt * abx;
      double qy = ay + tt * aby;
      double dx = cxp - qx;
      double dy = cyp - qy;
      if (dx * dx + dy * dy <= r2) {
        int64_t key = ((int64_t)x << 32) ^ (uint32_t)y;
        cells.insert(key);
      }
    }
  }
}

// Rasterize one segment [seg, seg+1] into `cells`, deduped by a packed 64-bit
// key (SPEC: key = ((int64_t)x << 32) ^ (uint32_t)y). The set across segments
// gives the whole-track union for free.
static void rasterize_segment(const double* points, int seg, double width,
                              std::unordered_set<int64_t>& cells) {
  // 6 doubles per control point: [pos.x, pos.y, in.x, in.y, out.x, out.y].
  const double* p0 = points + (long)seg * 6;
  const double* p1 = points + (long)(seg + 1) * 6;

  // Absolute Bézier control points. Tangents are RELATIVE offsets from pos:
  // c1 uses p0.out (indices 4,5), c2 uses p1.in (indices 2,3).
  double c0x = p0[0], c0y = p0[1];
  double c1x = p0[0] + p0[4], c1y = p0[1] + p0[5];
  double c2x = p1[0] + p1[2], c2y = p1[1] + p1[3];
  double c3x = p1[0], c3y = p1[1];

  // Step count from the control-polygon chord length (fixed summation order).
  double chordLength = dist(c0x, c0y, c1x, c1y) + dist(c1x, c1y, c2x, c2y) + dist(c2x, c2y, c3x, c3y);
  int half = (int)std::floor(chordLength / 2.0);
  int steps = half > 20 ? half : 20;

  double r = width / 2.0;
  double r2 = r * r;

  // Walk the curve as a polyline and stamp the capsule between consecutive
  // samples (distance-to-segment, not per-sample disks) so the strip edges have
  // no inter-sample holes. B(0) == c0 exactly, so seed prev from c0.
  double prevX = c0x;
  double prevY = c0y;
  for (int i = 1; i <= steps; i++) {
    double t = (double)i / (double)steps; // cast both: C++ int/int would truncate
    double u = 1.0 - t;

    // B(t) = u³·c0 + 3u²t·c1 + 3ut²·c2 + t³·c3, expanded (no pow).
    double b0 = u * u * u;
    double b1 = 3 * u * u * t;
    double b2 = 3 * u * t * t;
    double b3 = t * t * t;
    double px = b0 * c0x + b1 * c1x + b2 * c2x + b3 * c3x;
    double py = b0 * c0y + b1 * c1y + b2 * c2y + b3 * c3y;

    stamp_capsule(prevX, prevY, px, py, r, r2, cells);
    prevX = px;
    prevY = py;
  }
}

// Flatten the deduped set into the caller's out_blocks as [x0,y0,x1,y1,...].
// Returns pair count, or -1 if the buffer can't hold them all.
static int emit(const std::unordered_set<int64_t>& cells, int* out_blocks, int max_pairs) {
  int n = (int)cells.size();
  if (n > max_pairs) return -1;
  int idx = 0;
  for (int64_t key : cells) {
    out_blocks[idx++] = (int)(key >> 32);          // high 32 bits = x
    out_blocks[idx++] = (int)(int32_t)(uint32_t)key; // low 32 bits = y
  }
  return n;
}

// --- C ABI (Emscripten exports; see SPEC "C API") -------------------------

extern "C" {

int compute_blocks(const double* points, int n_points, double width,
                   int* out_blocks, int max_pairs) {
  std::unordered_set<int64_t> cells;
  for (int seg = 0; seg < n_points - 1; seg++) {
    rasterize_segment(points, seg, width, cells);
  }
  return emit(cells, out_blocks, max_pairs);
}

int compute_segment_blocks(const double* points, int n_points, double width,
                           int seg_index, int* out_blocks, int max_pairs) {
  (void)n_points; // segment math only needs seg_index and seg_index+1
  std::unordered_set<int64_t> cells;
  rasterize_segment(points, seg_index, width, cells);
  return emit(cells, out_blocks, max_pairs);
}
}
