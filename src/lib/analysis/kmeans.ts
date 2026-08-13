/** Deterministic PRNG (mulberry32) so clustering results are reproducible in tests, not just "close enough". */
function mulberry32(seed: number) {
  let a = seed;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Z-score standardization per dimension. Essential before k-means here:
 * raw features mix wildly different scales (sessionDurationMs in the
 * tens of thousands vs clickCount in single digits) - without this, one
 * high-magnitude dimension would dominate the Euclidean distance and
 * the others would be noise.
 */
export function standardize(vectors: number[][]): { standardized: number[][]; means: number[]; stdevs: number[] } {
  const dims = vectors[0]?.length ?? 0;
  const n = vectors.length;
  const means = new Array(dims).fill(0);
  const stdevs = new Array(dims).fill(0);

  for (const v of vectors) {
    for (let d = 0; d < dims; d++) means[d] += v[d];
  }
  for (let d = 0; d < dims; d++) means[d] /= n;

  for (const v of vectors) {
    for (let d = 0; d < dims; d++) stdevs[d] += (v[d] - means[d]) ** 2;
  }
  for (let d = 0; d < dims; d++) stdevs[d] = Math.sqrt(stdevs[d] / n) || 1; // avoid div-by-zero for constant dimensions

  const standardized = vectors.map((v) => v.map((val, d) => (val - means[d]) / stdevs[d]));
  return { standardized, means, stdevs };
}

function euclideanDistanceSq(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += (a[i] - b[i]) ** 2;
  return sum;
}

/** k-means++ initialization - spreads initial centroids out instead of picking k random points, which materially improves cluster quality and convergence speed. */
function initCentroids(vectors: number[][], k: number, rng: () => number): number[][] {
  const centroids: number[][] = [vectors[Math.floor(rng() * vectors.length)]];

  while (centroids.length < k) {
    const distances = vectors.map((v) => Math.min(...centroids.map((c) => euclideanDistanceSq(v, c))));
    const total = distances.reduce((a, b) => a + b, 0);
    if (total === 0) {
      // All remaining points are identical to an existing centroid - just pick arbitrarily.
      centroids.push(vectors[Math.floor(rng() * vectors.length)]);
      continue;
    }
    let threshold = rng() * total;
    let chosen = vectors[0];
    for (let i = 0; i < vectors.length; i++) {
      threshold -= distances[i];
      if (threshold <= 0) {
        chosen = vectors[i];
        break;
      }
    }
    centroids.push(chosen);
  }
  return centroids;
}

export interface KMeansResult {
  assignments: number[]; // cluster index per input vector, same order as input
  centroids: number[][];
  iterations: number;
}

export function kmeans(vectors: number[][], k: number, opts: { maxIterations?: number; seed?: number } = {}): KMeansResult {
  if (vectors.length === 0) return { assignments: [], centroids: [], iterations: 0 };
  const effectiveK = Math.min(k, vectors.length);
  const rng = mulberry32(opts.seed ?? 42);
  const maxIterations = opts.maxIterations ?? 100;

  let centroids = initCentroids(vectors, effectiveK, rng);
  let assignments = new Array(vectors.length).fill(-1);
  let iterations = 0;

  for (let iter = 0; iter < maxIterations; iter++) {
    iterations = iter + 1;
    let changed = false;

    const newAssignments = vectors.map((v) => {
      let best = 0;
      let bestDist = Infinity;
      for (let c = 0; c < centroids.length; c++) {
        const d = euclideanDistanceSq(v, centroids[c]);
        if (d < bestDist) {
          bestDist = d;
          best = c;
        }
      }
      return best;
    });

    for (let i = 0; i < newAssignments.length; i++) {
      if (newAssignments[i] !== assignments[i]) changed = true;
    }
    assignments = newAssignments;
    if (!changed && iter > 0) break;

    const dims = vectors[0].length;
    const sums = Array.from({ length: centroids.length }, () => new Array(dims).fill(0));
    const counts = new Array(centroids.length).fill(0);
    for (let i = 0; i < vectors.length; i++) {
      const c = assignments[i];
      counts[c] += 1;
      for (let d = 0; d < dims; d++) sums[c][d] += vectors[i][d];
    }
    centroids = centroids.map((old, c) => (counts[c] > 0 ? sums[c].map((s) => s / counts[c]) : old));
  }

  return { assignments, centroids, iterations };
}
