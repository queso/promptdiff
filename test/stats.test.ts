import { expect, test } from "bun:test";
import { fisherExactTwoTailedP } from "../src/engine/stats";

test("fisherExactTwoTailedP matches exact enumeration on eval-sized tables", () => {
  // 0/3 vs 3/3: hypergeometric probs are 1/20, 9/20, 9/20, 1/20 → two-tailed
  // p = 0.1. Even a perfect 3-run separation is thin evidence — the honest
  // number the issue asks the summary to carry.
  expect(fisherExactTwoTailedP(0, 3, 3, 3)).toBeCloseTo(0.1, 10);
  // 1/3 vs 2/3: the observed table is the most probable one → p = 1.
  expect(fisherExactTwoTailedP(1, 3, 2, 3)).toBeCloseTo(1, 10);
  // 0/5 vs 5/5: 2/252 → clears 0.05.
  expect(fisherExactTwoTailedP(0, 5, 5, 5)).toBeCloseTo(2 / 252, 10);
  // No delta → p = 1 regardless of n.
  expect(fisherExactTwoTailedP(4, 8, 4, 8)).toBeCloseTo(1, 10);
  // Symmetry in the arms.
  expect(fisherExactTwoTailedP(2, 3, 1, 3)).toBeCloseTo(fisherExactTwoTailedP(1, 3, 2, 3), 12);
});
