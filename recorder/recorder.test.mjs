import assert from "node:assert/strict";
import test from "node:test";
import { fingerprintMatch } from "./recorder.mjs";

test("match fingerprint is independent of object key order", () => {
  const first = { Time: "2026-09-19 18:42", Opponent: "Ryu", Result: "WIN" };
  const second = { Result: "WIN", Opponent: "Ryu", Time: "2026-09-19 18:42" };
  assert.equal(fingerprintMatch(first), fingerprintMatch(second));
});

test("different matches have different fingerprints", () => {
  const first = { Time: "2026-09-19 18:42", Opponent: "Ryu", Result: "WIN" };
  const second = { Time: "2026-09-19 18:47", Opponent: "Ryu", Result: "LOSE" };
  assert.notEqual(fingerprintMatch(first), fingerprintMatch(second));
});
