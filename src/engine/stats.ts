/**
 * Two-tailed Fisher's exact test on a 2x2 pass/fail table. Exact enumeration
 * is cheap at eval-sized n and avoids normal-approximation lies at n=3, which
 * is exactly where the noise warning matters.
 */
export function fisherExactTwoTailedP(
  baselinePasses: number,
  baselineTotal: number,
  proposedPasses: number,
  proposedTotal: number,
): number {
  const passColumn = baselinePasses + proposedPasses;
  const n = baselineTotal + proposedTotal;
  const kMin = Math.max(0, passColumn - proposedTotal);
  const kMax = Math.min(baselineTotal, passColumn);

  const logTableProb = (k: number) =>
    logChoose(baselineTotal, k) + logChoose(proposedTotal, passColumn - k) - logChoose(n, passColumn);

  const observed = logTableProb(baselinePasses);
  let total = 0;
  for (let k = kMin; k <= kMax; k += 1) {
    const logP = logTableProb(k);
    // Two-tailed by summing every table at most as probable as the observed one.
    if (logP <= observed + 1e-9) total += Math.exp(logP);
  }
  return Math.min(1, total);
}

function logChoose(n: number, k: number): number {
  return logFactorial(n) - logFactorial(k) - logFactorial(n - k);
}

const logFactorialCache: number[] = [0];

function logFactorial(n: number): number {
  for (let i = logFactorialCache.length; i <= n; i += 1) {
    logFactorialCache[i] = logFactorialCache[i - 1] + Math.log(i);
  }
  return logFactorialCache[n];
}
