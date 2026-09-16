// Shared helper for querying the OpenStreetMap Overpass API.
//
// A bare `fetch('https://overpass-api.de/api/interpreter', ...)` with no
// User-Agent header can get silently rejected or throttled -- Overpass's
// usage policy asks clients to identify themselves, and the public
// instance is a shared, occasionally-overloaded free service with no SLA.
// This tries a short list of independently-run Overpass mirrors in turn,
// with a sane timeout and a real User-Agent, so a single instance being
// down or slow doesn't take the feature down with it.
const OVERPASS_ENDPOINTS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://overpass.openstreetmap.fr/api/interpreter',
    'https://overpass.openstreetmap.ru/api/interpreter'
];

const USER_AGENT = 'AmbulancePatrolDrone/1.0 (IIITDM Kurnool research project; contact via GitHub repo)';

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function queryOverpassOnce(query, { fetchImpl, timeoutMs }) {
    const errors = [];
    for (const endpoint of OVERPASS_ENDPOINTS) {
        try {
            const res = await fetchImpl(endpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'User-Agent': USER_AGENT
                },
                body: 'data=' + encodeURIComponent(query),
                signal: AbortSignal.timeout(timeoutMs)
            });
            if (!res.ok) {
                errors.push(`${endpoint}: HTTP ${res.status}`);
                continue;
            }
            return { data: await res.json() };
        } catch (err) {
            // Keep the real underlying cause (e.g. DNS failure, connection
            // refused, timeout) visible in logs instead of just "fetch failed".
            const detail = err.cause ? `${err.message} (${err.cause.message || err.cause})` : err.message;
            errors.push(`${endpoint}: ${detail}`);
        }
    }
    return { errors };
}

async function queryOverpass(query, { fetchImpl = fetch, timeoutMs = 8000, retries = 1, retryDelayMs = 1500 } = {}) {
    let lastErrors = [];
    // A one-off blip (a mirror mid-restart, a transient rate limit) is
    // common enough on these free public instances that a single retry
    // pass after a short delay avoids surfacing a failure the caller would
    // have gotten a clean answer from moments later.
    for (let attempt = 0; attempt <= retries; attempt++) {
        if (attempt > 0) await sleep(retryDelayMs);
        const { data, errors } = await queryOverpassOnce(query, { fetchImpl, timeoutMs });
        if (data) return data;
        lastErrors = errors;
    }
    // Report every endpoint's failure, not just the last -- if they're all
    // failing the same way (e.g. every one is a connect-level timeout) that
    // itself is a useful diagnostic pointing at the network path out of the
    // server, not any particular Overpass instance being down.
    throw new Error(`All Overpass endpoints failed:\n${lastErrors.join('\n')}`);
}

module.exports = { queryOverpass, OVERPASS_ENDPOINTS };
