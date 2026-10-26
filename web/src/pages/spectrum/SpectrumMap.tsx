import { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import { Maximize2 } from 'lucide-react';
import { navigate } from '../../lib/router';
import { cbsdLabel, patchIndex, range } from '../../lib/format';
import { Button } from '../../components/ui';
import { activeRanges, areaOf, cssRgb, useThemeVersion, type SpectrumData } from './shared';

// Leaflet map: CBSDs in their patch colour, protection areas (active stronger), PPA polygons.
// Tiles come from OpenStreetMap; without internet the vectors still render on a blank ground.

interface Layers {
  cbsds: boolean;
  active: boolean;
  inactive: boolean;
  ppas: boolean;
}

export function SpectrumMap({ data, followed }: { data: SpectrumData; followed: string | null }) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const groups = useRef<Record<keyof Layers, L.FeatureGroup> | null>(null);
  const fitted = useRef(false);
  const [tiles, setTiles] = useState<'loading' | 'ok' | 'failed'>('loading');
  const [show, setShow] = useState<Layers>({ cbsds: true, active: true, inactive: false, ppas: true });
  const theme = useThemeVersion();

  useEffect(() => {
    if (!el.current || map.current) return;
    const m = L.map(el.current, { preferCanvas: true, worldCopyJump: true, zoomControl: true, attributionControl: true }).setView([39.5, -98.35], 4);
    const tl = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 18,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    });
    let ok = false;
    tl.on('tileload', () => {
      ok = true;
      setTiles('ok');
    });
    tl.on('tileerror', () => {
      if (!ok) setTiles('failed');
    });
    tl.addTo(m);
    groups.current = { cbsds: L.featureGroup(), active: L.featureGroup(), inactive: L.featureGroup(), ppas: L.featureGroup() };
    map.current = m;
    const ro = new ResizeObserver(() => m.invalidateSize());
    ro.observe(el.current);
    return () => {
      ro.disconnect();
      m.remove();
      map.current = null;
      groups.current = null;
    };
  }, []);

  // Rebuild vector layers whenever data, theme or the followed CBSD changes.
  useEffect(() => {
    const m = map.current;
    const g = groups.current;
    if (!m || !g) return;
    for (const fg of Object.values(g)) fg.clearLayers();

    const inactiveStyle: L.PathOptions = { color: cssRgb('ink-3', 0.7), weight: 1, dashArray: '4 3', fillColor: cssRgb('ink-3'), fillOpacity: 0.04 };
    for (const p of data.protections) {
      const tone = p.action === 'terminate' ? 'bad' : 'warn';
      const style: L.PathOptions = p.active
        ? { color: cssRgb(tone), weight: 1.5, fillColor: cssRgb(tone), fillOpacity: 0.16 }
        : inactiveStyle;
      const target = p.active ? g.active : g.inactive;
      const popup = popupEl([
        [p.name, true],
        [`${p.kind} · ${p.active ? `active (${p.action})` : 'inactive'}`],
        [`${(p.active ? activeRanges(p) : [[p.low, p.high]]).map(([l, h]) => range(l, h)).join(', ')} MHz`],
        p.radiusKm ? [`radius ${p.radiusKm} km`] : null,
      ]);
      if (p.geometry) {
        try {
          L.geoJSON(p.geometry, { style: () => style, interactive: true }).bindPopup(popup).addTo(target);
        } catch { /* malformed geometry */ }
      } else if (areaOf(p) === 'circle') {
        L.circle([p.latitude!, p.longitude!], { ...style, radius: p.radiusKm! * 1000 }).bindPopup(popup).addTo(target);
      }
    }

    for (const p of data.ppas) {
      if (!p.geometry) continue;
      try {
        L.geoJSON(p.geometry, { style: () => ({ color: cssRgb('sel'), weight: 1.5, fillColor: cssRgb('sel'), fillOpacity: 0.12 }) })
          .bindPopup(popupEl([[p.name, true], [`PAL ${p.channels.map((c) => range(c.low, c.high)).join(', ')} MHz`], [`${p.members.length} member CBSD(s)`]]))
          .addTo(g.ppas);
      } catch { /* malformed geometry */ }
    }

    const grantsBy = new Map<string, number>();
    for (const gr of data.grants) grantsBy.set(gr.cbsdId, (grantsBy.get(gr.cbsdId) ?? 0) + 1);
    for (const c of data.cbsds) {
      if (c.lat == null || c.lon == null) continue;
      const color = cssRgb(`p${patchIndex(c.cbsdId)}`);
      const isF = followed === c.cbsdId;
      if (isF) L.circleMarker([c.lat, c.lon], { radius: 13, color: cssRgb('sel'), weight: 2, fill: false, interactive: false }).addTo(g.cbsds);
      L.circleMarker([c.lat, c.lon], { radius: isF ? 8 : 6, color: cssRgb('panel'), weight: 1.5, fillColor: color, fillOpacity: 1 })
        .bindTooltip(cbsdLabel(c.cbsdId), { direction: 'top', offset: [0, -6] })
        .bindPopup(popupEl([
          [cbsdLabel(c.cbsdId), true],
          [`FCC ID ${c.fccId} · serial ${c.serial}`],
          [`Category ${c.category ?? '?'} · ${c.indoor ? 'indoor' : 'outdoor'} · ${grantsBy.get(c.cbsdId) ?? 0} live grant(s)`],
          [`${c.lat.toFixed(5)}, ${c.lon.toFixed(5)}`],
        ], `/cbsds/${encodeURIComponent(c.cbsdId)}`))
        .addTo(g.cbsds);
    }
  }, [data, theme, followed]);

  // Layer visibility
  useEffect(() => {
    const m = map.current;
    const g = groups.current;
    if (!m || !g) return;
    // Order: inactive below active below PPAs below CBSDs.
    for (const k of ['inactive', 'active', 'ppas', 'cbsds'] as const) {
      g[k].remove();
      if (show[k]) g[k].addTo(m);
    }
    // First time there is something to show, zoom to it (bounds need the layers on the map).
    if (!fitted.current) {
      const b = L.latLngBounds([]);
      for (const k of ['cbsds', 'active', 'ppas'] as const) if (show[k] && g[k].getLayers().length) b.extend(g[k].getBounds());
      if (b.isValid()) {
        m.fitBounds(b, { padding: [28, 28], maxZoom: 12 });
        fitted.current = true;
      }
    }
  }, [show, data, theme, followed]);

  const fit = () => {
    const m = map.current;
    const g = groups.current;
    if (!m || !g) return;
    const b = L.latLngBounds([]);
    for (const k of Object.keys(show) as Array<keyof Layers>) if (show[k] && g[k].getLayers().length) b.extend(g[k].getBounds());
    if (b.isValid()) m.fitBounds(b, { padding: [28, 28], maxZoom: 12 });
    else m.setView([39.5, -98.35], 4);
  };

  const noLoc = data.cbsds.filter((c) => c.lat == null || c.lon == null).length;
  const bandWide = data.protections.filter((p) => p.active && areaOf(p) === 'band-wide').length;

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-line px-3 py-2 text-sm text-ink-2">
        {([
          ['cbsds', 'CBSDs'],
          ['active', 'Active protections'],
          ['inactive', 'Inactive protections'],
          ['ppas', 'PPAs'],
        ] as Array<[keyof Layers, string]>).map(([k, l]) => (
          <label key={k} className="flex cursor-pointer items-center gap-1.5">
            <input type="checkbox" className="accent-[rgb(var(--sel))]" checked={show[k]} onChange={(e) => setShow((s) => ({ ...s, [k]: e.target.checked }))} />
            {l}
          </label>
        ))}
        <Button size="sm" variant="ghost" icon={Maximize2} className="ml-auto" onClick={fit}>Fit</Button>
      </div>
      <div className="relative min-h-[380px] flex-1">
        <div ref={el} className="absolute inset-0" />
        {tiles === 'failed' && (
          <div className="pointer-events-none absolute left-1/2 top-3 z-[500] -translate-x-1/2 rounded border border-line bg-panel/95 px-2.5 py-1 text-xs text-ink-2 shadow-panel">
            Map tiles need internet access; positions and areas are still drawn.
          </div>
        )}
      </div>
      {(noLoc > 0 || bandWide > 0) && (
        <div className="border-t border-line px-3 py-1.5 text-xs text-ink-3">
          {noLoc > 0 && <span>{noLoc} registered CBSD{noLoc > 1 ? 's have' : ' has'} no location. </span>}
          {bandWide > 0 && <span>{bandWide} active protection{bandWide > 1 ? 's are' : ' is'} band-wide (affects every CBSD, not drawn).</span>}
        </div>
      )}
    </div>
  );
}

/** Popup content built as DOM (no HTML injection from record names). */
function popupEl(lines: Array<[string, boolean?] | null>, href?: string): HTMLElement {
  const div = document.createElement('div');
  for (const l of lines) {
    if (!l) continue;
    const p = document.createElement('div');
    p.textContent = l[0];
    if (l[1]) p.style.fontWeight = '600';
    div.appendChild(p);
  }
  if (href) {
    const a = document.createElement('a');
    a.href = href;
    a.textContent = 'Open CBSD';
    a.style.display = 'inline-block';
    a.style.marginTop = '4px';
    a.style.color = 'rgb(var(--sel-ink))';
    a.addEventListener('click', (e) => {
      e.preventDefault();
      navigate(href);
    });
    div.appendChild(a);
  }
  return div;
}
