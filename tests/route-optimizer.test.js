const assert = require("node:assert/strict");
const RouteOptimizer = require("../route-optimizer.js");

function candidate(nodes, weights, coordinates = [[0, 0], [1, 1]]) {
  const total = weights.reduce((sum, value) => sum + value, 0);
  return {
    weight: total,
    distance: total * 10,
    duration: total,
    geometry: { coordinates },
    legs: [{ annotation: { nodes, weight: weights, duration: weights, distance: weights.map(value => value * 10) } }]
  };
}

assert.equal(RouteOptimizer.edgeKey(20, 10), RouteOptimizer.edgeKey(10, 20));

const usedEdges = new Map([[RouteOptimizer.edgeKey(1, 2), 1]]);
const repeatedShort = candidate([1, 2], [10]);
const alternativeNew = candidate([3, 4], [20]);
let selected = RouteOptimizer.chooseCandidate([repeatedShort, alternativeNew], usedEdges, 5);
assert.equal(selected.route, alternativeNew, "Debe preferir una alternativa nueva frente a una repetida penalizada.");

const alternativeTooLong = candidate([5, 6], [60]);
selected = RouteOptimizer.chooseCandidate([repeatedShort, alternativeTooLong], usedEdges, 5);
assert.equal(selected.route, repeatedShort, "Debe aceptar el tramo repetido cuando la alternativa resulta más costosa.");
assert.equal(selected.cost, 50);

selected = RouteOptimizer.chooseCandidate([repeatedShort], usedEdges, 5);
assert.equal(selected.route, repeatedShort, "Un callejón sin salida siempre debe conservar una ruta válida de retorno.");

const requestedCoordinates = [];
const requestedUrls = [];
const requestedSignals = [];
const firstLeg = candidate([10, 11], [4], [[0, 0], [1, 1]]);
const secondLegRepeated = candidate([11, 10], [4], [[1, 1], [2, 2]]);
const fetchFn = async (url, options = {}) => {
  requestedUrls.push(url);
  requestedSignals.push(options.signal);
  requestedCoordinates.push(decodeURIComponent(url).match(/driving\/([^?]+)/)[1]);
  return {
    ok: true,
    json: async () => ({ code: "Ok", routes: requestedCoordinates.length === 1 ? [firstLeg] : [secondLegRepeated] })
  };
};

(async () => {
  const controller = new AbortController();
  const result = await RouteOptimizer.calculateRoute([
    { lat: 0, lng: 0 },
    { lat: 1, lng: 1 },
    { lat: 2, lng: 2 }
  ], { fetchFn, penaltyFactor: 5, alternatives: 3, signal: controller.signal });

  assert.deepEqual(requestedCoordinates, ["0,0;1,1", "1,1;2,2"], "Debe respetar el orden origen → punto obligatorio → destino.");
  assert.equal(result.legs.length, 2);
  assert.equal(result.points.length, 3);
  assert.equal(result.optimization.repeatedEdgeTraversals, 1);
  assert.equal(result.optimization.penaltyFactor, 5);
  assert.ok(requestedSignals.every(signal => signal === controller.signal), "La cancelación se propaga a cada consulta vial.");
  assert.ok(requestedUrls.every(url => new URL(url).searchParams.get("continue_straight") === "false"), "Se permite volver por un callejón sin salida.");
  assert.ok(requestedUrls.every(url => new URL(url).searchParams.get("radiuses") === "100;100"), "Cada punto debe quedar cerca de una vía real.");
  console.log("route-optimizer: 8 escenarios aprobados");
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
