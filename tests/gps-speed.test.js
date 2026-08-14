const assert = require("node:assert/strict");
const GpsSpeed = require("../gps-speed.js");

const normal = GpsSpeed.create();
GpsSpeed.record(normal, 18, { timestamp: 1000, accuracyMeters: 8 });
GpsSpeed.record(normal, 24, { timestamp: 2000, accuracyMeters: 8 });
GpsSpeed.record(normal, 30, { timestamp: 3000, accuracyMeters: 8 });
assert.equal(GpsSpeed.average(normal), 24);
assert.equal(GpsSpeed.loseSignal(normal, { timestamp: 4000 }), 24);
assert.equal(normal.currentSpeedKmh, 24);

const movingRecovery = GpsSpeed.record(normal, 48, { timestamp: 5000, accuracyMeters: 12 });
assert.equal(movingRecovery.speedKmh, 30);
assert.equal(movingRecovery.signal, "recovering");

const stopped = GpsSpeed.create({ recentSpeedsKmh: [20, 25, 30], currentSpeedKmh: 30 });
GpsSpeed.loseSignal(stopped);
GpsSpeed.stop(stopped, { duringSignalLoss: true });
assert.equal(stopped.currentSpeedKmh, 0);
assert.equal(GpsSpeed.average(stopped), 0);
assert.equal(stopped.signal, "lost");

const alreadyStopped = GpsSpeed.create({ recentSpeedsKmh: [24, 18, 0], currentSpeedKmh: 0 });
GpsSpeed.loseSignal(alreadyStopped);
assert.equal(alreadyStopped.currentSpeedKmh, 0);
assert.equal(GpsSpeed.average(alreadyStopped), 0);

const firstRecovery = GpsSpeed.record(stopped, 40, { timestamp: 6000, accuracyMeters: 10 });
const secondRecovery = GpsSpeed.record(stopped, 40, { timestamp: 7000, accuracyMeters: 10 });
assert.equal(firstRecovery.speedKmh, 10);
assert.equal(secondRecovery.speedKmh, 22);
assert.ok(secondRecovery.speedKmh < 40);

const spikeState = GpsSpeed.create({ recentSpeedsKmh: [28, 30, 32], currentSpeedKmh: 32 });
const spike = GpsSpeed.record(spikeState, 280, { timestamp: 8000, accuracyMeters: 55 });
assert.equal(spike.spikeRejected, true);
assert.equal(spike.speedKmh, 30);

console.log("gps-speed: 6 escenarios aprobados");
