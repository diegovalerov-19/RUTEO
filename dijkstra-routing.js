(function exposeDijkstraRouting(global) {
  "use strict";

  const MAX_REQUIRED_STOPS = 12;
  const MAX_EDGES = 5000;
  const MAX_STATES = 200000;

  function validateEdge(edge, index) {
    const from = String(edge?.from ?? "").trim();
    const to = String(edge?.to ?? "").trim();
    const weight = edge?.weight;
    if (!from || !to || from.length > 80 || to.length > 80 || typeof weight !== "number" || !Number.isFinite(weight) || weight < 0) {
      throw new Error(`Conexión ${index + 1}: usa nombres de 1 a 80 caracteres y un costo numérico no negativo.`);
    }
    return { from, to, weight };
  }

  class MinHeap {
    constructor() {
      this.items = [];
    }

    push(item) {
      this.items.push(item);
      let index = this.items.length - 1;
      while (index > 0) {
        const parent = Math.floor((index - 1) / 2);
        if (this.items[parent].cost <= item.cost) break;
        this.items[index] = this.items[parent];
        index = parent;
      }
      this.items[index] = item;
    }

    pop() {
      if (!this.items.length) return null;
      const first = this.items[0];
      const last = this.items.pop();
      if (this.items.length) {
        let index = 0;
        while (true) {
          const left = index * 2 + 1;
          const right = left + 1;
          if (left >= this.items.length) break;
          const child = right < this.items.length && this.items[right].cost < this.items[left].cost ? right : left;
          if (this.items[child].cost >= last.cost) break;
          this.items[index] = this.items[child];
          index = child;
        }
        this.items[index] = last;
      }
      return first;
    }

    get size() {
      return this.items.length;
    }
  }

  function splitEdgeLine(line) {
    const value = line.trim();
    if (!value || value.startsWith("#")) return null;
    const delimiter = value.includes(";") ? ";" : value.includes(",") ? "," : null;
    if (!delimiter) throw new Error(`Formato no válido: “${value}”. Usa Origen; Destino; Costo.`);
    const parts = value.split(delimiter).map(part => part.trim());
    if (parts.length !== 3) throw new Error(`La conexión “${value}” debe tener exactamente tres valores.`);
    const numericValue = delimiter === ";" ? parts[2].replace(",", ".") : parts[2];
    const weight = Number(numericValue);
    if (!parts[0] || !parts[1] || !/^\d+(?:\.\d+)?$/.test(numericValue) || !Number.isFinite(weight) || weight < 0) {
      throw new Error(`La conexión “${value}” contiene un punto vacío o un costo inválido.`);
    }
    return { from: parts[0], to: parts[1], weight };
  }

  function parseEdges(text) {
    const source = String(text || "");
    if (source.length > 500000) throw new Error("La red es demasiado extensa. Reduce el número de conexiones.");
    const edges = source.split(/\r?\n/).map(splitEdgeLine).filter(Boolean);
    if (!edges.length) throw new Error("Agrega al menos una conexión a la red.");
    if (edges.length > MAX_EDGES) throw new Error(`Se admiten hasta ${MAX_EDGES} conexiones por cálculo.`);
    return edges;
  }

  function normalizeRequiredStops(value) {
    const values = Array.isArray(value) ? value : String(value || "").split(/[;,\n]/);
    const seen = new Set();
    return values.map(stop => String(stop).trim()).filter(stop => {
      const key = stop.toLocaleLowerCase("es");
      if (!stop || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function buildGraph(edges, directed) {
    const names = [];
    const byKey = new Map();
    const graph = [];
    const ensureNode = name => {
      const key = name.toLocaleLowerCase("es");
      if (byKey.has(key)) return byKey.get(key);
      const index = names.length;
      names.push(name);
      byKey.set(key, index);
      graph.push([]);
      return index;
    };

    edges.forEach(edge => {
      const from = ensureNode(edge.from);
      const to = ensureNode(edge.to);
      graph[from].push({ to, weight: edge.weight });
      if (!directed) graph[to].push({ to: from, weight: edge.weight });
    });
    return { names, byKey, graph };
  }

  function solve(options) {
    const inputEdges = Array.isArray(options?.edges) ? options.edges : parseEdges(options?.edges);
    if (!inputEdges.length || inputEdges.length > MAX_EDGES) throw new Error(`Escribe entre 1 y ${MAX_EDGES} conexiones.`);
    const edges = inputEdges.map(validateEdge);
    const startName = String(options?.start || "").trim();
    const endName = String(options?.end || "").trim();
    if (!startName || !endName) throw new Error("Escribe el origen y el destino final.");

    const requiredNames = normalizeRequiredStops(options?.requiredStops);
    if (requiredNames.length > MAX_REQUIRED_STOPS) {
      throw new Error(`Puedes optimizar hasta ${MAX_REQUIRED_STOPS} paradas obligatorias a la vez.`);
    }

    const { names, byKey, graph } = buildGraph(edges, Boolean(options?.directed));
    if (names.length * 2 ** requiredNames.length > MAX_STATES) {
      throw new Error("La combinación de red y paradas es demasiado grande para este dispositivo. Reduce las paradas o divide la red; no se devolverá una aproximación como si fuera óptima.");
    }
    const nodeIndex = name => byKey.get(name.toLocaleLowerCase("es"));
    const start = nodeIndex(startName);
    const end = nodeIndex(endName);
    if (start === undefined) throw new Error(`El origen “${startName}” no aparece en la red.`);
    if (end === undefined) throw new Error(`El destino “${endName}” no aparece en la red.`);

    const required = requiredNames.map(name => {
      const index = nodeIndex(name);
      if (index === undefined) throw new Error(`La parada obligatoria “${name}” no aparece en la red.`);
      return index;
    });
    const requiredBitByNode = new Map();
    required.forEach((node, bit) => requiredBitByNode.set(node, (requiredBitByNode.get(node) || 0) | (1 << bit)));
    const fullMask = (1 << required.length) - 1;
    const startMask = requiredBitByNode.get(start) || 0;
    const keyFor = (node, mask) => `${node}|${mask}`;
    const startKey = keyFor(start, startMask);
    const distances = new Map([[startKey, 0]]);
    const parents = new Map();
    const queue = new MinHeap();
    queue.push({ node: start, mask: startMask, cost: 0 });
    let finalState = null;

    // Dijkstra on (node, visited-stop mask) considers every stop order, including
    // mandatory stops crossed between two others. Repeated streets remain legal.
    while (queue.size) {
      const current = queue.pop();
      const currentKey = keyFor(current.node, current.mask);
      if (current.cost !== distances.get(currentKey)) continue;
      if (current.node === end && current.mask === fullMask) {
        finalState = current;
        break;
      }
      graph[current.node].forEach(edge => {
        const nextMask = current.mask | (requiredBitByNode.get(edge.to) || 0);
        const nextCost = current.cost + edge.weight;
        if (!Number.isFinite(nextCost)) throw new Error("Los costos de la red son demasiado grandes para calcularlos.");
        const nextKey = keyFor(edge.to, nextMask);
        if (nextCost >= (distances.get(nextKey) ?? Infinity)) return;
        distances.set(nextKey, nextCost);
        parents.set(nextKey, { previousKey: currentKey, weight: edge.weight });
        queue.push({ node: edge.to, mask: nextMask, cost: nextCost });
      });
    }

    if (!finalState) throw new Error("No existe una ruta que conecte el origen, todas las paradas obligatorias y el destino.");

    const pathIndexes = [];
    const segmentWeights = [];
    let cursor = keyFor(finalState.node, finalState.mask);
    while (cursor) {
      pathIndexes.push(Number(cursor.split("|")[0]));
      const parent = parents.get(cursor);
      if (!parent) break;
      segmentWeights.push(parent.weight);
      cursor = parent.previousKey;
    }
    pathIndexes.reverse();
    segmentWeights.reverse();
    const path = pathIndexes.map(index => names[index]);
    const segments = segmentWeights.map((weight, index) => ({ from: path[index], to: path[index + 1], weight }));
    const pendingRequired = new Set(required);
    const stopOrder = [];
    pathIndexes.forEach(index => {
      if (!pendingRequired.has(index)) return;
      pendingRequired.delete(index);
      stopOrder.push(names[index]);
    });

    return { path, segments, total: finalState.cost, stopOrder };
  }


  const api = { MAX_REQUIRED_STOPS, parseEdges, normalizeRequiredStops, solve };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  global.DijkstraRouting = api;
})(typeof globalThis !== "undefined" ? globalThis : this);

