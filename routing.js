// A* pathfinding over a live OpenStreetMap road-network graph.
//
// The graph is built on demand from the Overpass API for a bounding box
// around the requested start/end points (no pre-built database), then A*
// finds the least-cost path. Edge cost is road length scaled by a
// per-edge "congestion" factor combined with the caller-supplied traffic
// density, so a higher traffic density setting makes congestion-prone
// roads more expensive without ever making the heuristic inadmissible
// (cost is always >= the raw geometric distance).

const { queryOverpass } = require('./overpass');

const EARTH_RADIUS_KM = 6371;

const DRIVABLE_HIGHWAYS = new Set([
    'motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified',
    'residential', 'service', 'living_street',
    'motorway_link', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link'
]);

function toRad(deg) {
    return deg * (Math.PI / 180);
}

function haversineKm(a, b) {
    const dLat = toRad(b.lat - a.lat);
    const dLon = toRad(b.lon - a.lon);
    const lat1 = toRad(a.lat);
    const lat2 = toRad(b.lat);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
    return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
}

// Deterministic pseudo-random value in [0, 1) derived from an OSM way id,
// used as that road's fixed propensity to be congested.
function congestionSeedForWay(wayId) {
    const n = Math.abs(Math.sin(wayId * 12.9898) * 43758.5453);
    return n - Math.floor(n);
}

function buildGraphFromOverpassElements(elements) {
    const nodes = new Map(); // id -> { lat, lon }
    const ways = [];

    for (const el of elements) {
        if (el.type === 'node') {
            nodes.set(el.id, { lat: el.lat, lon: el.lon });
        } else if (el.type === 'way' && el.tags && DRIVABLE_HIGHWAYS.has(el.tags.highway)) {
            ways.push(el);
        }
    }

    const graph = new Map(); // nodeId -> [{ to, distKm, congestionSeed }]
    const addEdge = (from, to, distKm, congestionSeed) => {
        if (!graph.has(from)) graph.set(from, []);
        graph.get(from).push({ to, distKm, congestionSeed });
    };

    for (const way of ways) {
        const oneway = way.tags.oneway === 'yes' || way.tags.oneway === '1' || way.tags.oneway === 'true';
        const ids = way.nodes || [];
        const congestionSeed = congestionSeedForWay(way.id);

        for (let i = 0; i < ids.length - 1; i++) {
            const a = nodes.get(ids[i]);
            const b = nodes.get(ids[i + 1]);
            if (!a || !b) continue;
            const distKm = haversineKm(a, b);
            addEdge(ids[i], ids[i + 1], distKm, congestionSeed);
            if (!oneway) addEdge(ids[i + 1], ids[i], distKm, congestionSeed);
        }
    }

    return { nodes, graph };
}

async function fetchRoadGraph(bbox, fetchImpl = fetch) {
    // This pulls every drivable way (plus every node they reference) in the
    // bounding box -- much heavier than the simple point-radius hospital
    // search, which is why the query itself asks Overpass for a 25s budget
    // ([timeout:25]). The client has to allow at least that long too, or
    // it aborts the connection before the server's own timeout would even
    // fire -- which is exactly what was happening with the 8s default
    // tuned for the lightweight hospital lookup.
    const query = `[out:json][timeout:25];way["highway"](${bbox.south},${bbox.west},${bbox.north},${bbox.east});(._;>;);out body;`;
    const data = await queryOverpass(query, { fetchImpl, timeoutMs: 28000 });
    return buildGraphFromOverpassElements(data.elements || []);
}

function nearestNode(nodes, point) {
    let best = null;
    let bestDist = Infinity;
    for (const [id, coord] of nodes) {
        const d = haversineKm(coord, point);
        if (d < bestDist) {
            bestDist = d;
            best = id;
        }
    }
    return best;
}

// Simple binary min-heap keyed by priority, used as A*'s open set.
class MinHeap {
    constructor() {
        this.items = [];
    }

    isEmpty() {
        return this.items.length === 0;
    }

    push(value, priority) {
        this.items.push({ value, priority });
        let i = this.items.length - 1;
        while (i > 0) {
            const parent = (i - 1) >> 1;
            if (this.items[parent].priority <= this.items[i].priority) break;
            [this.items[parent], this.items[i]] = [this.items[i], this.items[parent]];
            i = parent;
        }
    }

    pop() {
        const top = this.items[0];
        const last = this.items.pop();
        if (this.items.length > 0) {
            this.items[0] = last;
            let i = 0;
            const n = this.items.length;
            while (true) {
                const left = 2 * i + 1;
                const right = 2 * i + 2;
                let smallest = i;
                if (left < n && this.items[left].priority < this.items[smallest].priority) smallest = left;
                if (right < n && this.items[right].priority < this.items[smallest].priority) smallest = right;
                if (smallest === i) break;
                [this.items[smallest], this.items[i]] = [this.items[i], this.items[smallest]];
                i = smallest;
            }
        }
        return top.value;
    }
}

// A* search. Edge cost = distKm * (1 + (trafficDensity/100) * congestionSeed * 2),
// which is always >= distKm, so the haversine-to-goal heuristic stays admissible.
function aStar(graphData, startId, goalId, trafficDensity = 0) {
    const { nodes, graph } = graphData;
    const goal = nodes.get(goalId);
    if (!nodes.has(startId) || !goal) return null;

    const heuristic = (id) => haversineKm(nodes.get(id), goal);

    const open = new MinHeap();
    open.push(startId, heuristic(startId));
    const gScore = new Map([[startId, 0]]);
    const cameFrom = new Map();
    const closed = new Set();

    while (!open.isEmpty()) {
        const current = open.pop();
        if (closed.has(current)) continue;
        if (current === goalId) {
            const path = [current];
            let node = current;
            while (cameFrom.has(node)) {
                node = cameFrom.get(node);
                path.unshift(node);
            }
            return path;
        }
        closed.add(current);

        const neighbors = graph.get(current) || [];
        for (const edge of neighbors) {
            if (closed.has(edge.to)) continue;
            const congestionMultiplier = 1 + (trafficDensity / 100) * edge.congestionSeed * 2;
            const tentativeG = gScore.get(current) + edge.distKm * congestionMultiplier;
            if (tentativeG < (gScore.has(edge.to) ? gScore.get(edge.to) : Infinity)) {
                cameFrom.set(edge.to, current);
                gScore.set(edge.to, tentativeG);
                open.push(edge.to, tentativeG + heuristic(edge.to));
            }
        }
    }

    return null;
}

async function computeRoute({ start, end, trafficDensity = 0 }, fetchImpl = fetch) {
    const pad = 0.03; // ~3km of padding around the start/end bounding box
    const bbox = {
        south: Math.min(start.lat, end.lat) - pad,
        north: Math.max(start.lat, end.lat) + pad,
        west: Math.min(start.lng, end.lng) - pad,
        east: Math.max(start.lng, end.lng) + pad
    };

    const graphData = await fetchRoadGraph(bbox, fetchImpl);
    if (graphData.nodes.size === 0) {
        throw new Error('No road network data available for this area.');
    }

    const startNode = nearestNode(graphData.nodes, { lat: start.lat, lon: start.lng });
    const endNode = nearestNode(graphData.nodes, { lat: end.lat, lon: end.lng });

    const pathNodeIds = aStar(graphData, startNode, endNode, trafficDensity);
    if (!pathNodeIds) {
        throw new Error('No drivable route found between these points.');
    }

    const path = pathNodeIds.map(id => {
        const n = graphData.nodes.get(id);
        return [n.lat, n.lon];
    });

    let distanceKm = 0;
    for (let i = 0; i < path.length - 1; i++) {
        distanceKm += haversineKm(
            { lat: path[i][0], lon: path[i][1] },
            { lat: path[i + 1][0], lon: path[i + 1][1] }
        );
    }

    const baseSpeedKmh = 40;
    const effectiveSpeedKmh = baseSpeedKmh / (1 + trafficDensity / 100);
    const etaMinutes = effectiveSpeedKmh > 0 ? (distanceKm / effectiveSpeedKmh) * 60 : 0;

    return { path, distanceKm, etaMinutes };
}

module.exports = {
    computeRoute,
    aStar,
    buildGraphFromOverpassElements,
    fetchRoadGraph,
    haversineKm,
    nearestNode,
    MinHeap
};
