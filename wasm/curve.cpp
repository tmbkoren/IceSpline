#include <cstdint>

extern "C"
{

  // See SPEC "C API". Stubs return 0 blocks for now so the toolchain + loader
  // can be wired end-to-end before the algorithm lands (milestone 2).
  int compute_blocks(const double *points, int n_points, double width,
                     int *out_blocks, int max_pairs)
  {
    (void)points;
    (void)n_points;
    (void)width;
    (void)out_blocks;
    (void)max_pairs;
    return 0;
  }

  int compute_segment_blocks(const double *points, int n_points, double width,
                             int seg_index, int *out_blocks, int max_pairs)
  {
    (void)points;
    (void)n_points;
    (void)width;
    (void)seg_index;
    (void)out_blocks;
    (void)max_pairs;
    return 0;
  }
}
