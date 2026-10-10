/** Small vector toolkit for unit-length embeddings. Brute-force cosine is enough at this scale. */

export function dot(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < n; i++) sum += (a[i] as number) * (b[i] as number);
  return sum;
}

/** Returns a unit-length copy, truncated to `dims` first when given (Matryoshka-style models). */
export function normalize(v: ArrayLike<number>, dims?: number): Float32Array {
  const length = dims === undefined ? v.length : Math.min(dims, v.length);
  const out = new Float32Array(length);
  let norm = 0;
  for (let i = 0; i < length; i++) {
    const x = v[i] as number;
    out[i] = x;
    norm += x * x;
  }
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < length; i++) out[i] = (out[i] as number) / norm;
  return out;
}

export function mean(vectors: Float32Array[]): Float32Array {
  const first = vectors[0];
  if (!first) return new Float32Array(0);
  const sum = new Float32Array(first.length);
  for (const v of vectors) for (let i = 0; i < sum.length; i++) sum[i] = (sum[i] as number) + (v[i] as number);
  return normalize(sum);
}

/** Deterministic k-means (farthest-point seeding) returning unit-length centroids. */
export function kmeans(vectors: Float32Array[], k: number, iterations = 12): Float32Array[] {
  const first = vectors[0];
  if (!first) return [];
  const want = Math.min(k, vectors.length);
  const seeds: Float32Array[] = [first];
  while (seeds.length < want) {
    let best = vectors[0] as Float32Array;
    let bestSimilarity = Infinity;
    for (const v of vectors) {
      let nearest = -Infinity;
      for (const s of seeds) nearest = Math.max(nearest, dot(v, s));
      if (nearest < bestSimilarity) {
        bestSimilarity = nearest;
        best = v;
      }
    }
    seeds.push(best);
  }
  let centers = seeds;
  for (let round = 0; round < iterations; round++) {
    const groups: Float32Array[][] = centers.map(() => []);
    for (const v of vectors) {
      let bestIndex = 0;
      let bestSimilarity = -Infinity;
      centers.forEach((c, i) => {
        const s = dot(v, c);
        if (s > bestSimilarity) {
          bestSimilarity = s;
          bestIndex = i;
        }
      });
      (groups[bestIndex] as Float32Array[]).push(v);
    }
    centers = groups.map((g, i) => (g.length ? mean(g) : (centers[i] as Float32Array)));
  }
  return centers;
}

export function toBlob(v: Float32Array): Uint8Array {
  return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
}

export function fromBlob(blob: Uint8Array): Float32Array {
  const copy = new Uint8Array(blob.byteLength);
  copy.set(blob);
  return new Float32Array(copy.buffer);
}
