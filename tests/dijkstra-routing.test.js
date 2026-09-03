const assert = require("node:assert/strict");
const DijkstraRouting = require("../dijkstra-routing.js");

const exampleEdges = DijkstraRouting.parseEdges(`
A; B; 5
A; C; 2
C; B; 1
B; D; 4
`);
const example = DijkstraRouting.solve({ edges: exampleEdges, start: "A", end: "D", requiredStops: "B" });
assert.deepEqual(example.path, ["A", "C", "B", "D"]);
assert.equal(example.total, 7);
assert.deepEqual(example.stopOrder, ["B"]);

const unordered = DijkstraRouting.solve({
  edges: DijkstraRouting.parseEdges("S; A; 1\nS; B; 5\nA; B; 1\nA; T; 10\nB; T; 1"),
  start: "S",
  end: "T",
  requiredStops: "B, A"
});
assert.deepEqual(unordered.path, ["S", "A", "B", "T"], "Debe optimizar el orden de las paradas obligatorias.");
assert.deepEqual(unordered.stopOrder, ["A", "B"]);
assert.equal(unordered.total, 3);

const directed = DijkstraRouting.solve({
  edges: DijkstraRouting.parseEdges("A; B; 1\nB; C; 1\nC; A; 10"),
  start: "A",
  end: "C",
  directed: true
});
assert.deepEqual(directed.path, ["A", "B", "C"]);
assert.equal(directed.total, 2);

const deadEnd = DijkstraRouting.solve({
  edges: DijkstraRouting.parseEdges("A; B; 1\nB; C; 1\nA; D; 1"),
  start: "A",
  end: "D",
  requiredStops: "C"
});
assert.deepEqual(deadEnd.path, ["A", "B", "C", "B", "A", "D"], "Debe poder regresar desde una parada en un callejón sin salida.");
assert.equal(deadEnd.total, 5);

assert.equal(DijkstraRouting.parseEdges("A; B; 5,5")[0].weight, 5.5, "Debe admitir coma decimal cuando se usa punto y coma como separador.");

assert.throws(() => DijkstraRouting.solve({
  edges: DijkstraRouting.parseEdges("A; B; 1\nC; D; 1"),
  start: "A",
  end: "D",
  requiredStops: "B"
}), /No existe una ruta/);
assert.throws(() => DijkstraRouting.parseEdges("A; B; -1"), /costo inválido/);
assert.throws(() => DijkstraRouting.solve({ edges: exampleEdges, start: "X", end: "D" }), /no aparece en la red/);

console.log("dijkstra-routing: 8 escenarios aprobados");

