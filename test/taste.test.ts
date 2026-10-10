import { test } from "node:test";
import assert from "node:assert/strict";
import { Affinity, TasteModel, centroidScore, wilsonLowerBound } from "../src/taste/taste.ts";
import { dot, fromBlob, kmeans, mean, normalize, toBlob } from "../src/taste/vectors.ts";

const unit = (...xs: number[]): Float32Array => normalize(xs);

test("normalize makes unit vectors and truncates to the requested dimensions", () => {
  const v = normalize([3, 4]);
  assert.ok(Math.abs(dot(v, v) - 1) < 1e-6);
  const cut = normalize([3, 4, 12], 2);
  assert.equal(cut.length, 2);
  assert.ok(Math.abs(dot(cut, cut) - 1) < 1e-6);
});

test("blob round trip keeps the vector", () => {
  const v = unit(1, 2, 3, 4);
  const back = fromBlob(toBlob(v));
  assert.deepEqual(Array.from(back), Array.from(v));
});

test("kmeans separates two obvious clusters", () => {
  const a = [unit(1, 0.05, 0), unit(1, -0.05, 0), unit(1, 0, 0.05)];
  const b = [unit(0, 1, 0.05), unit(0.05, 1, 0), unit(0, 1, -0.05)];
  const centers = kmeans([...a, ...b], 2);
  assert.equal(centers.length, 2);
  const sims = centers.map((c) => [dot(c, unit(1, 0, 0)), dot(c, unit(0, 1, 0))]);
  assert.ok(sims.some(([x]) => (x as number) > 0.95));
  assert.ok(sims.some(([, y]) => (y as number) > 0.95));
});

test("multi-prototype affinity ranks a member of a minority cluster above an unrelated item, where a single centroid blurs", () => {
  const lean = [unit(1, 0, 0), unit(1, 0.02, 0), unit(1, 0, 0.02), unit(0.98, 0.05, 0), unit(0.99, 0, 0.05), unit(1, 0.04, 0.01)];
  const minority = [unit(0, 1, 0), unit(0.02, 1, 0)];
  const affinity = new Affinity([...lean, ...minority]);
  const probe = unit(0, 0.97, 0.1);
  const other = unit(0, 0.1, 1);
  assert.ok(affinity.score(probe) > affinity.score(other) + 0.3);
  const centroid = centroidScore([...lean, ...minority]);
  assert.ok(affinity.score(probe) - affinity.score(other) > centroid(probe) - centroid(other));
});

test("taste model is not ready without likes and uses dislikes only from three examples", () => {
  assert.equal(new TasteModel([]).score(unit(1, 0)).ready, false);
  const liked = [unit(1, 0.1), unit(1, -0.1)];
  const few = new TasteModel(liked, [unit(0, 1), unit(0.1, 1)]);
  assert.equal(few.disliked, null);
  const enough = new TasteModel(liked, [unit(0, 1), unit(0.1, 1), unit(-0.1, 1)]);
  assert.ok(enough.disliked);
  const probe = unit(0.1, 1);
  assert.ok(enough.score(probe).score < few.score(probe).score);
});

test("mean of vectors is unit length", () => {
  const m = mean([unit(1, 0), unit(0, 1)]);
  assert.ok(Math.abs(dot(m, m) - 1) < 1e-6);
});

test("Wilson lower bound rewards evidence, not just the rate", () => {
  assert.ok(wilsonLowerBound(9, 10) < wilsonLowerBound(90, 100));
  assert.equal(wilsonLowerBound(0, 0), 0);
  assert.ok(wilsonLowerBound(10, 10) < 1);
});
