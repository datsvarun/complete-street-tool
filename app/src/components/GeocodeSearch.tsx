import { useRef, useState } from 'react';
import { useCst } from '../store';

interface NominatimHit {
  display_name: string;
  lat: string;
  lon: string;
}

// Nominatim geocoding (search on Enter — usage policy asks for ≤1 req/s,
// so no as-you-type autocomplete). Picking a result recenters the view and
// pre-fills the OSM import coordinates.
export function GeocodeSearch() {
  const goTo = useCst((s) => s.goTo);
  const [q, setQ] = useState('');
  const [results, setResults] = useState<NominatimHit[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const boxRef = useRef<HTMLDivElement>(null);

  const search = async () => {
    const query = q.trim();
    if (!query || busy) return;
    setBusy(true);
    setError('');
    try {
      const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&q=${encodeURIComponent(query)}`;
      const res = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`Nominatim returned ${res.status}`);
      const hits = (await res.json()) as NominatimHit[];
      setResults(hits);
    } catch (err) {
      setError((err as Error).message);
      setResults(null);
    } finally {
      setBusy(false);
    }
  };

  const pick = (h: NominatimHit) => {
    const shortLabel = h.display_name.split(',').slice(0, 2).join(',');
    goTo({ lat: parseFloat(h.lat), lon: parseFloat(h.lon) }, shortLabel);
    setResults(null);
    setQ(shortLabel);
  };

  return (
    <div className="geocode" ref={boxRef} onBlur={(e) => {
      if (!boxRef.current?.contains(e.relatedTarget as Node)) setResults(null);
    }}>
      <input
        value={q}
        placeholder="Search place (Nominatim)…"
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') search();
          if (e.key === 'Escape') setResults(null);
        }}
      />
      <button onClick={search} disabled={busy} title="Search">
        {busy ? '…' : '🔍'}
      </button>
      {(results || error) && (
        <div className="geocode-results">
          {error && <div className="geocode-error">{error}</div>}
          {results?.length === 0 && <div className="geocode-error">No results</div>}
          {results?.map((h, i) => (
            <button key={i} onClick={() => pick(h)}>
              {h.display_name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
