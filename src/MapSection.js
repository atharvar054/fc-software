import React, { useState, useEffect, useRef, useCallback } from 'react';
import { GoogleMap, useJsApiLoader, Marker, InfoWindow, Polyline } from '@react-google-maps/api';
import { collection, query, orderBy, onSnapshot } from 'firebase/firestore';
import { getDownloadURL, ref } from 'firebase/storage';
import { db, storage } from './firebaseConfig';
import { resolveAlertLocation } from './locationConfig';

// ─── Constants ───────────────────────────────────────────────────────────────
const MUMBAI_CENTER = { lat: 19.0450, lng: 72.8850 };
const DEFAULT_MAP_CONTAINER_STYLE = { width: '100%', height: '460px', borderRadius: '12px', overflow: 'hidden' };
const LIBRARIES = ['geometry'];

const ROUTE_PALETTE = ['#f97316', '#22c55e', '#a855f7', '#f59e0b', '#ef4444'];
const ALT_ROUTE_COLORS = ['#f97316', '#22c55e', '#eab308', '#ef4444'];

// ─── Map style (Strava dark) ─────────────────────────────────────────────────
const MAP_STYLE = [
  { elementType: 'geometry', stylers: [{ color: '#1a1a2e' }] },
  { elementType: 'labels.text.fill', stylers: [{ color: '#8ec3b0' }] },
  { elementType: 'labels.text.stroke', stylers: [{ color: '#1a1a2e' }] },
  { featureType: 'administrative', elementType: 'geometry', stylers: [{ color: '#2d2d44' }] },
  { featureType: 'administrative.locality', elementType: 'labels.text.fill', stylers: [{ color: '#c9d2d3' }] },
  { featureType: 'poi', elementType: 'labels.text.fill', stylers: [{ color: '#6b9a76' }] },
  { featureType: 'poi.park', elementType: 'geometry', stylers: [{ color: '#263c3f' }] },
  { featureType: 'poi.park', elementType: 'labels.text.fill', stylers: [{ color: '#6b9a76' }] },
  { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#2c2c54' }] },
  { featureType: 'road', elementType: 'geometry.stroke', stylers: [{ color: '#212a37' }] },
  { featureType: 'road', elementType: 'labels.text.fill', stylers: [{ color: '#9ca5b3' }] },
  { featureType: 'road.highway', elementType: 'geometry', stylers: [{ color: '#40407a' }] },
  { featureType: 'road.highway', elementType: 'geometry.stroke', stylers: [{ color: '#1f2835' }] },
  { featureType: 'road.highway', elementType: 'labels.text.fill', stylers: [{ color: '#f3d19c' }] },
  { featureType: 'transit', elementType: 'geometry', stylers: [{ color: '#2f3948' }] },
  { featureType: 'transit.station', elementType: 'labels.text.fill', stylers: [{ color: '#d59563' }] },
  { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#0e1626' }] },
  { featureType: 'water', elementType: 'labels.text.fill', stylers: [{ color: '#515c6d' }] },
  { featureType: 'water', elementType: 'labels.text.stroke', stylers: [{ color: '#17263c' }] },
];

const MAP_OPTIONS = {
  styles: MAP_STYLE,
  disableDefaultUI: true,
  zoomControl: true,
  zoomControlOptions: { position: 9 },
  clickableIcons: false,
  minZoom: 10,
  maxZoom: 20,
  scrollwheel: true,
  gestureHandling: 'greedy',
};

// ─── Helpers ─────────────────────────────────────────────────────────────────
function formatDistance(km) {
  if (!km || km === 0) return '—';
  return km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(2)} km`;
}

function tagColor(tag) {
  switch ((tag || '').toLowerCase()) {
    case 'criminal': return '#ef4444';
    case 'wanted':   return '#f97316';
    case 'missing':  return '#3b82f6';
    default:         return '#64748b';
  }
}

async function fetchOsrmRoadPath(points) {
  if (!Array.isArray(points) || points.length < 2) return [];

  let mergedPath = [];
  for (let i = 0; i < points.length - 1; i++) {
    const start = points[i];
    const end = points[i + 1];
    const url = `https://router.project-osrm.org/route/v1/driving/${start.lng},${start.lat};${end.lng},${end.lat}?overview=full&geometries=geojson`;
    const resp = await fetch(url);

    if (!resp.ok) throw new Error(`OSRM request failed (${resp.status})`);

    const data = await resp.json();
    const coords = data?.routes?.[0]?.geometry?.coordinates;
    if (!Array.isArray(coords) || coords.length < 2) {
      throw new Error('OSRM returned empty route geometry');
    }

    const segment = coords.map(([lng, lat]) => ({ lat, lng }));
    if (i > 0) segment.shift();
    mergedPath = mergedPath.concat(segment);
  }

  return mergedPath;
}

// ─── SVG marker icons ────────────────────────────────────────────────────────
function makePinIcon(color, isStart, isEnd) {
  if (isStart) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 22 22">
      <circle cx="11" cy="11" r="9" fill="#22c55e" stroke="#fff" stroke-width="2.5"/>
    </svg>`;
    return { url: `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`, scaledSize: { width: 22, height: 22 }, anchor: { x: 11, y: 11 } };
  }
  if (isEnd) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">
      <circle cx="12" cy="12" r="10" fill="#fff" stroke="#1e293b" stroke-width="2"/>
      <clipPath id="c"><circle cx="12" cy="12" r="8"/></clipPath>
      <g clip-path="url(#c)">
        <rect x="4" y="4" width="4" height="4" fill="#1e293b"/>
        <rect x="12" y="4" width="4" height="4" fill="#1e293b"/>
        <rect x="8" y="8" width="4" height="4" fill="#1e293b"/>
        <rect x="16" y="8" width="4" height="4" fill="#1e293b"/>
        <rect x="4" y="12" width="4" height="4" fill="#1e293b"/>
        <rect x="12" y="12" width="4" height="4" fill="#1e293b"/>
        <rect x="8" y="16" width="4" height="4" fill="#1e293b"/>
        <rect x="16" y="16" width="4" height="4" fill="#1e293b"/>
      </g>
    </svg>`;
    return { url: `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`, scaledSize: { width: 24, height: 24 }, anchor: { x: 12, y: 12 } };
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="36" viewBox="0 0 28 36">
    <path d="M14 0C6.27 0 0 6.27 0 14c0 9.625 14 22 14 22S28 23.625 28 14C28 6.27 21.73 0 14 0z" fill="${color}" stroke="#fff" stroke-width="1.5"/>
    <circle cx="14" cy="13" r="5" fill="#fff"/>
  </svg>`;
  return { url: `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`, scaledSize: { width: 28, height: 36 }, anchor: { x: 14, y: 36 } };
}

// ─── Returns the most-recent alert at a given location ───────────────────────
// Matches by locationName string (if present) OR by coordinates within ~50 m.
function latestAlertAt(refAlert, allAlerts) {
  const peers = allAlerts.filter((a) => {
    if (refAlert.locationName && a.locationName)
      return a.locationName === refAlert.locationName;
    return (
      Math.abs(a.location.lat - refAlert.location.lat) < 0.0005 &&
      Math.abs(a.location.lng - refAlert.location.lng) < 0.0005
    );
  });
  return (
    peers.sort((a, b) => (b.alertTime || '').localeCompare(a.alertTime || ''))[0]
    || refAlert
  );
}

// ─── Component ───────────────────────────────────────────────────────────────
export default function MapSection({ mapContainerStyle = DEFAULT_MAP_CONTAINER_STYLE }) {
  const { isLoaded, loadError } = useJsApiLoader({
    googleMapsApiKey: process.env.REACT_APP_GOOGLE_MAPS_API_KEY || '',
    libraries: LIBRARIES,
  });

  const [alerts, setAlerts]                 = useState([]);
  const [loading, setLoading]               = useState(true);
  const [usingDemo, setUsingDemo]           = useState(false);
  const [selectedAlert, setSelectedAlert]   = useState(null);
  const [alertImageUrl, setAlertImageUrl]   = useState(null);
  const [imageLoading, setImageLoading]     = useState(false);
  const [activePersonId, setActivePersonId] = useState('all');
  const [showLastFiveOnly, setShowLastFiveOnly] = useState(false);
  const [isMapReady, setIsMapReady]         = useState(false);
  const [routedPersonIds, setRoutedPersonIds] = useState([]);
  const [osrmPathsByPerson, setOsrmPathsByPerson] = useState({});
  const [altRoutes, setAltRoutes] = useState([]);

  // routeStats[pid] = { distanceKm, durationMin }
  const [routeStats, setRouteStats]   = useState({});

  const [toastAlert, setToastAlert]   = useState(null);  // new-alert toast

  const mapRef = useRef(null);
  const directionsServiceRef = useRef(null);   // single DirectionsService instance
  const renderersRef = useRef({});              // pid → DirectionsRenderer
  const lastBoundsKeyRef = useRef('');          // prevent fitBounds on every render
  const isInitialLoadRef = useRef(true);        // true until first snapshot completes
  const knownAlertIdsRef = useRef(new Set());   // IDs already seen — skip on first load
  const toastTimerRef    = useRef(null);        // auto-dismiss timer

  // ── Fetch alerts from Firestore ──────────────────────────────────────────
  useEffect(() => {
    setLoading(true);
    const q = query(collection(db, 'alerts'), orderBy('alertTime', 'asc'));

    const unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        console.log(`[Firestore] snapshot received — ${snapshot.size} document(s)`);
        const rows = [];
        snapshot.forEach((docSnap) => {
          const d   = docSnap.data();
          const resolvedLocation = resolveAlertLocation({
            personID: d.personID,
            location: d.location,
            locationName: d.locationName,
          });
          if (!resolvedLocation.location) return;

          let alertTime = d.alertTime;
          if (alertTime && typeof alertTime.toDate === 'function') {
            const dt = alertTime.toDate();
            alertTime = dt.toISOString().replace('T', ' ').slice(0, 19);
          } else if (alertTime instanceof Date) {
            alertTime = alertTime.toISOString().replace('T', ' ').slice(0, 19);
          }

          rows.push({
            alertDocId:   docSnap.id,
            alertID:      d.alertID,
            personID:     d.personID,
            personName:   d.personName || d.personID,
            tag:          d.tag || 'Unknown',
            alertTime,
            location:     resolvedLocation.location,
            locationName: resolvedLocation.locationName,
          });
        });
        console.log(`[Firestore] ${rows.length} valid alert(s) loaded`);

        // Detect genuinely new alerts (skip on first load)
        if (!isInitialLoadRef.current) {
          const newest = rows
            .filter((r) => !knownAlertIdsRef.current.has(r.alertDocId))
            .sort((a, b) => (b.alertTime || '').localeCompare(a.alertTime || ''))[0];
          if (newest) {
            clearTimeout(toastTimerRef.current);
            setToastAlert(newest);
            toastTimerRef.current = setTimeout(() => setToastAlert(null), 8000);
          }
        }
        rows.forEach((r) => knownAlertIdsRef.current.add(r.alertDocId));
        isInitialLoadRef.current = false;

        setAlerts(rows);
        setUsingDemo(rows.length === 0);
        setLoading(false);
      },
      (err) => {
        console.error('[Firestore] read error:', err.code, err.message);
        setAlerts([]);
        setUsingDemo(false);
        setLoading(false);
      }
    );
    return () => unsubscribe();
  }, []);

  // ── DirectionsRenderer approach ─────────────────────────────────────────────
  // For each person, we use DirectionsService to fetch the route and
  // DirectionsRenderer to draw it directly on the map — no manual Polylines.
  // DirectionsRenderer handles road-snapped rendering natively.
  useEffect(() => {
    if (!isLoaded || !isMapReady || alerts.length === 0 || !mapRef.current) return;

    const baseAlerts = activePersonId === 'all'
      ? alerts
      : alerts.filter((a) => a.personID === activePersonId);

    const sortedBaseAlerts = [...baseAlerts].sort((a, b) =>
      (a.alertTime || '').localeCompare(b.alertTime || '')
    );

    const routeInputAlerts = showLastFiveOnly
      ? sortedBaseAlerts.slice(-5)
      : sortedBaseAlerts;

    if (routeInputAlerts.length < 1) {
      Object.values(renderersRef.current).forEach((r) => r.setMap(null));
      renderersRef.current = {};
      setRoutedPersonIds([]);
      return;
    }

    // Initialize DirectionsService once
    if (!directionsServiceRef.current) {
      directionsServiceRef.current = new window.google.maps.DirectionsService();
    }
    const ds = directionsServiceRef.current;

    // Clear old renderers
    Object.values(renderersRef.current).forEach((r) => r.setMap(null));
    renderersRef.current = {};
    setRoutedPersonIds([]);

    const pids = [...new Set(routeInputAlerts.map((a) => a.personID))];
    const palette = ROUTE_PALETTE;

    (async () => {
      for (let pi = 0; pi < pids.length; pi++) {
        const pid = pids[pi];
        const personPoints = routeInputAlerts
          .filter((a) => a.personID === pid)
          .sort((a, b) => (a.alertTime || '').localeCompare(b.alertTime || ''))
          .map((a) => a.location);

        if (personPoints.length < 1) continue;

        // Build route from sequential alert coordinates only.
        const pts = personPoints;
        if (pts.length < 2) continue;

        const color = palette[pi % palette.length];

        // Build origin, destination, and waypoints
        const origin      = pts[0];
        const destination  = pts[pts.length - 1];
        const waypoints    = pts.slice(1, -1).map((p) => ({ location: p, stopover: true }));

        try {
          const result = await new Promise((resolve, reject) => {
            ds.route(
              {
                origin,
                destination,
                waypoints,
                travelMode: window.google.maps.TravelMode.DRIVING,
                optimizeWaypoints: false,
              },
              (response, status) => {
                if (status === window.google.maps.DirectionsStatus.OK) {
                  resolve(response);
                } else {
                  reject(status);
                }
              }
            );
          });

          // Create DirectionsRenderer — draws the route on the map
          const renderer = new window.google.maps.DirectionsRenderer({
            map: mapRef.current,
            directions: result,
            suppressMarkers: true,       // we draw our own markers
            preserveViewport: true,       // don't re-center the map
            polylineOptions: {
              strokeColor: color,
              strokeOpacity: 0.95,
              strokeWeight: 5,
              zIndex: 3,
              icons: [
                {
                  icon: {
                    path: window.google.maps.SymbolPath.CIRCLE,
                    fillColor: color,
                    fillOpacity: 1,
                    strokeOpacity: 0,
                    scale: 3,
                  },
                  offset: '0',
                  repeat: '14px',
                },
              ],
            },
          });
          renderersRef.current[pid] = renderer;
          setRoutedPersonIds((prev) => (prev.includes(pid) ? prev : [...prev, pid]));

          // Extract stats from legs
          let totalDist = 0;
          let totalDur  = 0;
          for (const leg of result.routes[0].legs) {
            totalDist += (leg.distance?.value || 0) / 1000;
            totalDur  += (leg.duration?.value  || 0) / 60;
          }
          setRouteStats((prev) => ({ ...prev, [pid]: { distanceKm: totalDist, durationMin: totalDur } }));
          console.log(`[DirectionsRenderer] ${pid}: rendered on map, ${totalDist.toFixed(2)} km`);

        } catch (status) {
          // Handle specific error statuses
          switch (status) {
            case 'ZERO_RESULTS':
              console.error(`[DirectionsRenderer] ${pid}: No route found between points`);
              break;
            case 'NOT_FOUND':
              console.error(`[DirectionsRenderer] ${pid}: One or more locations could not be geocoded`);
              break;
            case 'OVER_QUERY_LIMIT':
              console.error(`[DirectionsRenderer] ${pid}: Too many requests — try again later`);
              break;
            case 'REQUEST_DENIED':
              console.error(`[DirectionsRenderer] ${pid}: Directions API not enabled or key invalid`);
              break;
            default:
              console.error(`[DirectionsRenderer] ${pid}: Failed with status: ${status}`);
          }
        }
      }
    })();

    // Cleanup: remove all renderers when effect re-runs or unmounts
    return () => {
      Object.values(renderersRef.current).forEach((r) => r.setMap(null));
      renderersRef.current = {};
      setRoutedPersonIds([]);
    };
  }, [isLoaded, isMapReady, alerts, activePersonId, showLastFiveOnly]);

  // Build fallback road paths via OSRM so route still follows roads when
  // Google Directions is unavailable (e.g. API restrictions).
  useEffect(() => {
    if (alerts.length === 0) {
      setOsrmPathsByPerson({});
      return;
    }

    const baseAlerts = activePersonId === 'all'
      ? alerts
      : alerts.filter((a) => a.personID === activePersonId);

    const sortedBaseAlerts = [...baseAlerts].sort((a, b) =>
      (a.alertTime || '').localeCompare(b.alertTime || '')
    );

    const routeInputAlerts = showLastFiveOnly
      ? sortedBaseAlerts.slice(-5)
      : sortedBaseAlerts;

    let cancelled = false;

    (async () => {
      const pids = [...new Set(routeInputAlerts.map((a) => a.personID))];
      const nextPaths = {};

      for (const pid of pids) {
        const personPoints = routeInputAlerts
          .filter((a) => a.personID === pid)
          .sort((a, b) => (a.alertTime || '').localeCompare(b.alertTime || ''))
          .map((a) => a.location);

        if (personPoints.length < 1) continue;

        const pts = personPoints;
        if (pts.length < 2) continue;

        try {
          nextPaths[pid] = await fetchOsrmRoadPath(pts);
        } catch (err) {
          console.warn(`[OSRM fallback] ${pid}:`, err);
          nextPaths[pid] = [];
        }
      }

      if (!cancelled) setOsrmPathsByPerson(nextPaths);
    })();

    return () => {
      cancelled = true;
    };
  }, [alerts, activePersonId, showLastFiveOnly]);

  // ── Show/hide DirectionsRenderers based on active person filter ──────────
  useEffect(() => {
    Object.entries(renderersRef.current).forEach(([pid, renderer]) => {
      if (activePersonId === 'all' || activePersonId === pid) {
        renderer.setMap(mapRef.current);
      } else {
        renderer.setMap(null);
      }
    });
  }, [activePersonId]);

  // ── Fetch alert image when pin clicked ────────────────────────────────────
  useEffect(() => {
    if (!selectedAlert) { setAlertImageUrl(null); return; }
    setImageLoading(true);
    setAlertImageUrl(null);
    // Try root path first (P002_20260403_HHMMSS.jpg), then Alerts/ subfolder
    getDownloadURL(ref(storage, `${selectedAlert.alertDocId}.jpg`))
      .catch(() => getDownloadURL(ref(storage, `Alerts/${selectedAlert.alertDocId}.jpg`)))
      .then(setAlertImageUrl)
      .catch(() => setAlertImageUrl(null))
      .finally(() => setImageLoading(false));
  }, [selectedAlert, usingDemo]);

  // ── Derived values ────────────────────────────────────────────────────────
  const personIds = ['all', ...Array.from(new Set(alerts.map((a) => a.personID)))];

  const filteredAlerts = activePersonId === 'all'
    ? alerts
    : alerts.filter((a) => a.personID === activePersonId);

  const sortedFiltered = [...filteredAlerts].sort((a, b) =>
    (a.alertTime || '').localeCompare(b.alertTime || '')
  );

  const visibleAlerts = showLastFiveOnly
    ? sortedFiltered.slice(-5)
    : sortedFiltered;

  const visiblePids = activePersonId === 'all'
    ? [...new Set(visibleAlerts.map((a) => a.personID))]
    : [activePersonId];

  const totalDistanceKm = visiblePids.reduce(
    (sum, pid) => sum + (routeStats[pid]?.distanceKm || 0), 0
  );

  const personColors = {};
  [...new Set(alerts.map((a) => a.personID))].forEach((pid, i) => {
    const palette = ROUTE_PALETTE;
    personColors[pid] = palette[i % palette.length];
  });

  const fallbackPolylines = [...new Set(visibleAlerts.map((a) => a.personID))]
    .map((pid) => {
      const osrmPath = osrmPathsByPerson[pid] || [];
      return {
        pid,
        path: osrmPath,
        color: personColors[pid] || '#FF4500',
      };
    })
    .filter((route) => route.path.length >= 2 && !routedPersonIds.includes(route.pid));

  // Fit map bounds
  const onMapLoad = useCallback((map) => {
    mapRef.current = map;
    setIsMapReady(true);
  }, []);
  useEffect(() => {
    if (!isMapReady || !mapRef.current || visibleAlerts.length === 0) return;
    const key = visibleAlerts.map((a) => a.alertDocId).join(',') + '|' + activePersonId;
    if (key === lastBoundsKeyRef.current) return;
    lastBoundsKeyRef.current = key;
    const bounds = new window.google.maps.LatLngBounds();
    visibleAlerts.forEach((a) => bounds.extend(a.location));
    mapRef.current.fitBounds(bounds, 80);
  }, [isMapReady, visibleAlerts, activePersonId]);

  useEffect(() => {
    if (!selectedAlert) return;
    const exists = visibleAlerts.some((a) => a.alertDocId === selectedAlert.alertDocId);
    if (!exists) setSelectedAlert(null);
  }, [selectedAlert, visibleAlerts]);

  // Draw alternative road routes from first visible alert to latest visible alert.
  useEffect(() => {
    if (!isLoaded || !isMapReady || visibleAlerts.length === 0) {
      setAltRoutes([]);
      return;
    }

    const sorted = [...visibleAlerts].sort((a, b) =>
      (a.alertTime || '').localeCompare(b.alertTime || '')
    );
    const origin = sorted[0]?.location;
    const destination = sorted[sorted.length - 1]?.location;
    if (!origin || !destination) {
      setAltRoutes([]);
      return;
    }
    if (
      origin.lat === destination.lat &&
      origin.lng === destination.lng
    ) {
      setAltRoutes([]);
      return;
    }

    if (!directionsServiceRef.current) {
      directionsServiceRef.current = new window.google.maps.DirectionsService();
    }

    let cancelled = false;
    directionsServiceRef.current.route(
      {
        origin,
        destination,
        travelMode: window.google.maps.TravelMode.DRIVING,
        provideRouteAlternatives: true,
        optimizeWaypoints: false,
      },
      (response, status) => {
        if (cancelled) return;
        if (status !== window.google.maps.DirectionsStatus.OK || !response?.routes) {
          setAltRoutes([]);
          return;
        }

        const nextAltRoutes = response.routes.slice(0, 4).map((route, idx) => ({
          id: `${route.summary || 'route'}-${idx}`,
          path: route.overview_path.map((p) => ({ lat: p.lat(), lng: p.lng() })),
          color: ALT_ROUTE_COLORS[idx % ALT_ROUTE_COLORS.length],
        }));
        setAltRoutes(nextAltRoutes);
      }
    );

    return () => {
      cancelled = true;
    };
  }, [isLoaded, isMapReady, visibleAlerts]);

  // ── Render ────────────────────────────────────────────────────────────────
  if (loadError) {
    return <div className="map-error-state"><p>Failed to load Google Maps — check your API key.</p></div>;
  }
  if (!isLoaded || loading) {
    return (
      <div className="map-loading-container">
        <div className="loading-spinner" />
        <p>{!isLoaded ? 'Loading map...' : 'Fetching tracking data...'}</p>
      </div>
    );
  }

  return (
    <section className="map-section">
      {/* Header */}
      <div className="map-section-header">
        <div>
          <h3 className="section-title" style={{ margin: 0 }}>Live Tracking Map</h3>
          <p className="map-subtitle">Mumbai — road-traced detection trail</p>
        </div>
        {usingDemo && (
          <span className="map-demo-badge">No alerts in Firebase yet</span>
        )}
      </div>

      {/* Person filter tabs */}
      <div className="map-person-tabs">
        {personIds.map((pid) => {
          const label = pid === 'all'
            ? 'All Persons'
            : (alerts.find((a) => a.personID === pid)?.personName || pid);
          const color = pid === 'all' ? '#64748b' : personColors[pid];
          return (
            <button
              key={pid}
              className={`map-person-tab ${activePersonId === pid ? 'active' : ''}`}
              style={{ '--tab-color': color }}
              onClick={() => { setActivePersonId(pid); setSelectedAlert(null); }}
            >
              {pid !== 'all' && <span className="tab-dot" style={{ background: color }} />}
              {label}
            </button>
          );
        })}
      </div>

      <label className="map-last5-toggle">
        <input
          type="checkbox"
          checked={showLastFiveOnly}
          onChange={(e) => {
            setShowLastFiveOnly(e.target.checked);
            setSelectedAlert(null);
          }}
        />
        Show only last 5 pins
      </label>

      {/* Stats bar */}
      <div className="map-stats-bar">
        <div className="map-stat">
          <span className="map-stat-icon">📍</span>
          <div>
            <p className="map-stat-value">{visibleAlerts.length}</p>
            <p className="map-stat-label">Detections</p>
          </div>
        </div>
        {/* <div className="map-stat">
          <span className="map-stat-icon">📏</span>
          <div>
            <p className="map-stat-value">
              {visiblePids.some((pid) => routeStats[pid])
                ? formatDistance(totalDistanceKm)
                : <span style={{ fontSize: '0.75rem', color: '#64748b' }}>Tracing...</span>}
            </p>
            <p className="map-stat-label">Road Distance</p>
          </div>
        </div> */}
        <div className="map-stat">
          <span className="map-stat-icon">👥</span>
          <div>
            <p className="map-stat-value">{personIds.length - 1}</p>
            <p className="map-stat-label">Tracked Persons</p>
          </div>
        </div>
        <div className="map-stat">
          <span className="map-stat-icon">🕒</span>
          <div>
            <p className="map-stat-value">
              {visibleAlerts.length > 0
                ? (visibleAlerts[visibleAlerts.length - 1].alertTime || '—').split(' ')[1]?.slice(0, 5) || '—'
                : '—'}
            </p>
            <p className="map-stat-label">Last Seen</p>
          </div>
        </div>
      </div>

      {/* Map */}
      <div className="map-wrapper">
        <GoogleMap
          mapContainerStyle={mapContainerStyle}
          center={MUMBAI_CENTER}
          zoom={12}
          options={MAP_OPTIONS}
          onLoad={onMapLoad}
          onClick={() => setSelectedAlert(null)}
        >
          {/* Routes are rendered by DirectionsRenderer (imperative, attached to map) */}

          {/* Alternative routes (non-blue) to requested target point */}
          {altRoutes.map((route, idx) => (
            <Polyline
              key={`alt-route-${route.id}`}
              path={route.path}
              options={{
                strokeColor: route.color,
                strokeOpacity: idx === 0 ? 0.95 : 0.78,
                strokeWeight: idx === 0 ? 6 : 4,
                zIndex: idx === 0 ? 6 : 5,
              }}
            />
          ))}

          {/* Fallback path: keep route visible while Directions is loading/fails */}
          {fallbackPolylines.map((route) => (
            <Polyline
              key={`fallback-${route.pid}`}
              path={route.path}
              options={{
                strokeColor: route.color,
                strokeOpacity: 0.95,
                strokeWeight: 5,
                zIndex: 2,
                icons: [
                  {
                    icon: {
                      path: window.google.maps.SymbolPath.CIRCLE,
                      fillColor: route.color,
                      fillOpacity: 1,
                      strokeOpacity: 0,
                      scale: 3,
                    },
                    offset: '0',
                    repeat: '14px',
                  },
                ],
              }}
            />
          ))}

          {/* Detection markers — custom pins at each alert location */}
          {visibleAlerts.map((alert) => {
            const color   = personColors[alert.personID] || '#FF4500';
            const pts     = visibleAlerts.filter((a) => a.personID === alert.personID);
            const isFirst = pts.length > 0 && pts[0].alertDocId === alert.alertDocId;
            const isLast  = pts.length > 1 && pts[pts.length - 1].alertDocId === alert.alertDocId;
            return (
              <Marker
                key={alert.alertDocId}
                position={alert.location}
                icon={makePinIcon(color, isFirst, isLast)}
                zIndex={selectedAlert?.alertDocId === alert.alertDocId ? 10 : (isFirst || isLast ? 5 : 2)}
                onClick={() => setSelectedAlert(latestAlertAt(alert, alerts))}
              />
            );
          })}

          {/* Info window popup when a pin is clicked */}
          {selectedAlert && (
            <InfoWindow
              position={selectedAlert.location}
              onCloseClick={() => setSelectedAlert(null)}
              options={{ pixelOffset: { width: 0, height: -38 } }}
            >
              <div className="map-info-window">
                <div className="map-info-img-wrap">
                  {imageLoading ? (
                    <div className="map-info-img-placeholder"><div className="loading-spinner small" /></div>
                  ) : alertImageUrl ? (
                    <img src={alertImageUrl} alt={selectedAlert.personName} className="map-info-img" />
                  ) : (
                    <div className="map-info-img-placeholder">
                      <svg fill="#94a3b8" height="32" width="32" viewBox="0 0 256 256">
                        <path d="M128,80a48,48,0,1,0,48,48A48.05,48.05,0,0,0,128,80Zm0,80a32,32,0,1,1,32-32A32,32,0,0,1,128,160Z"/>
                      </svg>
                    </div>
                  )}
                </div>
                <div className="map-info-body">
                  <div className="map-info-name-row">
                    <span className="map-info-name">{selectedAlert.personName}</span>
                    <span className="map-info-tag" style={{ background: tagColor(selectedAlert.tag) }}>
                      {selectedAlert.tag}
                    </span>
                  </div>
                  <p className="map-info-id">ID: {selectedAlert.personID}</p>
                  <div className="map-info-rows">
                    <div className="map-info-row">
                      <span className="map-info-label">🕒 Detected</span>
                      <span className="map-info-val">{selectedAlert.alertTime || '—'}</span>
                    </div>
                    <div className="map-info-row">
                      <span className="map-info-label">📍 Location</span>
                      <span className="map-info-val">
                        {selectedAlert.locationName
                          ? selectedAlert.locationName
                          : `${selectedAlert.location.lat.toFixed(4)}, ${selectedAlert.location.lng.toFixed(4)}`}
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            </InfoWindow>
          )}
        </GoogleMap>

        {/* Legend overlay */}
        {activePersonId === 'all' && (
          <div className="map-legend">
            {[...new Set(alerts.map((a) => a.personID))].map((pid) => (
              <div key={pid} className="map-legend-item" onClick={() => setActivePersonId(pid)}>
                <span className="map-legend-dot" style={{ background: personColors[pid] }} />
                <span>{alerts.find((a) => a.personID === pid)?.personName || pid}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── New-alert toast (bottom-right) ─────────────────────────────── */}
      {toastAlert && (
        <div className="alert-toast">
          <div className="alert-toast-icon">
            <svg viewBox="0 0 24 24" fill="none" width="22" height="22">
              <path d="M12 2L2 20h20L12 2z" fill="#ef4444" opacity="0.15" stroke="#ef4444" strokeWidth="1.8" strokeLinejoin="round"/>
              <path d="M12 9v5" stroke="#ef4444" strokeWidth="2" strokeLinecap="round"/>
              <circle cx="12" cy="17" r="1" fill="#ef4444"/>
            </svg>
          </div>
          <div className="alert-toast-body">
            <p className="alert-toast-title">High Priority Alert</p>
            <p className="alert-toast-msg">
              Person of interest <strong>{toastAlert.personName}</strong> detected at{' '}
              {toastAlert.locationName
                ? toastAlert.locationName
                : `${toastAlert.location.lat.toFixed(6)}, ${toastAlert.location.lng.toFixed(6)}`}.{' '}
              Immediate action required.
            </p>
            <div className="alert-toast-actions">
              <button
                className="alert-toast-btn primary"
                onClick={() => { setSelectedAlert(toastAlert); setToastAlert(null); }}
              >
                View Details
              </button>
              <button
                className="alert-toast-btn secondary"
                onClick={() => setToastAlert(null)}
              >
                Dismiss
              </button>
            </div>
          </div>
          <button className="alert-toast-close" onClick={() => setToastAlert(null)}>✕</button>
        </div>
      )}
    </section>
  );
}
