import assert from "node:assert/strict";
import test from "node:test";
import { synthesizePaImpulse } from "../src/pa-audio";

const RATE = 48000;

/** Single-bin DFT magnitude, enough to compare narrow bands. */
function binEnergy(signal: Float32Array, sampleRate: number, hz: number) {
  const omega = (2 * Math.PI * hz) / sampleRate;
  let real = 0,
    imaginary = 0;
  for (let i = 0; i < signal.length; i++) {
    real += signal[i]! * Math.cos(omega * i);
    imaginary -= signal[i]! * Math.sin(omega * i);
  }
  return real * real + imaginary * imaginary;
}

test("synthesizePaImpulse is a deterministic cabinet-length response", () => {
  const impulse = synthesizePaImpulse(RATE);
  assert.ok(impulse instanceof Float32Array);
  assert.equal(impulse.length, Math.round(RATE * 0.42));
  const again = synthesizePaImpulse(RATE);
  assert.deepEqual([...impulse], [...again]);
  assert.ok(impulse.some((sample) => Math.abs(sample) > 0.01));
  assert.ok(
    [...impulse].every(
      (sample) => Number.isFinite(sample) && Math.abs(sample) <= 1,
    ),
  );
});

test("synthesizePaImpulse concentrates energy in the 300-3400 Hz band", () => {
  const impulse = synthesizePaImpulse(RATE);
  const band = binEnergy(impulse, RATE, 1000),
    low = binEnergy(impulse, RATE, 60),
    high = binEnergy(impulse, RATE, 8000);
  assert.ok(
    band > low * 5,
    `expected 1 kHz energy ${band} to dominate 60 Hz ${low}`,
  );
  assert.ok(
    band > high * 2,
    `expected 1 kHz energy ${band} to dominate 8 kHz ${high}`,
  );
});
