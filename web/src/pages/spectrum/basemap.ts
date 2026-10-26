import L from 'leaflet';
import { cssRgb } from './shared';

// Built-in offline basemap: Natural Earth vector layers (public domain) bundled with the UI and
// drawn on a canvas in the theme's colours. Needs no tile server and no internet access. It also
// sits under raster tiles, so areas or zooms a tile source does not cover still show a map.

type LayerName = 'land50' | 'land10' | 'borders' | 'states' | 'lakes' | 'roads' | 'urban' | 'places';
interface BasemapData {
  source: string;
  layers: Record<LayerName, GeoJSON.FeatureCollection>;
}
interface Place {
  name: string;
  minZoom: number;
  pop: number;
  at: L.LatLng;
}

let dataP: Promise<BasemapData> | null = null;
function loadData(): Promise<BasemapData> {
  dataP ??= fetch('/basemap/north-america.json')
    .then((r) => {
      if (!r.ok) throw new Error(`basemap: HTTP ${r.status}`);
      return r.json() as Promise<BasemapData>;
    })
    .catch((e) => {
      dataP = null;
      throw e;
    });
  return dataP;
}

export const BASEMAP_ATTRIBUTION = 'Basemap <a href="https://www.naturalearthdata.com" target="_blank" rel="noreferrer">Natural Earth</a>';
const MAX_LABELS = 140;

export class Basemap {
  private map: L.Map;
  private renderer: L.Canvas;
  private layers: Partial<Record<'land50' | 'land10' | 'borders' | 'states' | 'lakes' | 'major' | 'minor' | 'urban', L.GeoJSON>> = {};
  private labels = L.layerGroup();
  private places: Place[] = [];
  private disposed = false;
  private showLabels: (map: L.Map) => boolean;
  private onView = () => this.update();

  /** `showLabels` decides per view whether place names are drawn (raster tiles bring their own). */
  constructor(map: L.Map, onError?: (e: Error) => void, showLabels: (map: L.Map) => boolean = () => true) {
    this.map = map;
    this.showLabels = showLabels;
    if (!map.getPane('basemap')) {
      // Below tiles (200) and overlays (400); labels above tiles, below overlays.
      map.createPane('basemap').style.zIndex = '150';
      map.createPane('basemapLabels').style.zIndex = '350';
      map.getPane('basemap')!.style.pointerEvents = 'none';
      map.getPane('basemapLabels')!.style.pointerEvents = 'none';
    }
    this.renderer = L.canvas({ pane: 'basemap', padding: 0.3 });
    map.getContainer().classList.add('map-builtin');
    map.attributionControl.addAttribution(BASEMAP_ATTRIBUTION);
    loadData()
      .then((d) => {
        if (!this.disposed) this.build(d);
      })
      .catch((e) => onError?.(e));
  }

  /** Re-applies theme colours (call after a light/dark switch). */
  restyle() {
    const st = this.styles();
    for (const [k, layer] of Object.entries(this.layers)) layer?.setStyle(st[k as keyof typeof st]);
  }

  /** Re-evaluates visibility, e.g. after `showLabels` would now answer differently. */
  refresh() {
    if (this.places.length) this.update();
  }

  dispose() {
    this.disposed = true;
    this.map.off('zoomend moveend', this.onView);
    for (const layer of Object.values(this.layers)) layer?.remove();
    this.labels.remove();
    this.renderer.remove();
    this.map.attributionControl.removeAttribution(BASEMAP_ATTRIBUTION);
    this.map.getContainer().classList.remove('map-builtin');
  }

  private styles(): Record<'land50' | 'land10' | 'borders' | 'states' | 'lakes' | 'major' | 'minor' | 'urban', L.PathOptions> {
    const land = { stroke: true, color: cssRgb('info', 0.35), weight: 0.6, fill: true, fillColor: cssRgb('panel'), fillOpacity: 1 };
    return {
      land50: land,
      land10: land,
      lakes: { stroke: true, color: cssRgb('info', 0.3), weight: 0.5, fill: true, fillColor: cssRgb('info-soft'), fillOpacity: 1 },
      urban: { stroke: false, fill: true, fillColor: cssRgb('ink-3'), fillOpacity: 0.1 },
      states: { color: cssRgb('line-strong'), weight: 0.8, fill: false },
      borders: { color: cssRgb('ink-3', 0.75), weight: 1.2, fill: false },
      major: { color: cssRgb('warn', 0.5), weight: 1.1, fill: false },
      minor: { color: cssRgb('ink-3', 0.35), weight: 0.7, fill: false },
    };
  }

  private build(d: BasemapData) {
    const st = this.styles();
    const geo = (fc: GeoJSON.FeatureCollection, style: L.PathOptions, filter?: (f: GeoJSON.Feature) => boolean) =>
      L.geoJSON(fc, { pane: 'basemap', renderer: this.renderer, interactive: false, style: () => style, filter } as L.GeoJSONOptions);
    this.layers = {
      land50: geo(d.layers.land50, st.land50),
      land10: geo(d.layers.land10, st.land10),
      lakes: geo(d.layers.lakes, st.lakes),
      urban: geo(d.layers.urban, st.urban),
      states: geo(d.layers.states, st.states),
      borders: geo(d.layers.borders, st.borders),
      minor: geo(d.layers.roads, st.minor, (f) => f.properties?.m === 0),
      major: geo(d.layers.roads, st.major, (f) => f.properties?.m === 1),
    };
    this.places = d.layers.places.features
      .filter((f) => f.geometry.type === 'Point')
      .map((f) => {
        const [lon, lat] = (f.geometry as GeoJSON.Point).coordinates;
        return { name: String(f.properties?.name ?? ''), minZoom: Number(f.properties?.z ?? 8), pop: Number(f.properties?.p ?? 0), at: L.latLng(lat, lon) };
      })
      .sort((a, b) => b.pop - a.pop);
    this.labels.addTo(this.map);
    this.map.on('zoomend moveend', this.onView);
    this.update();
  }

  /** Zoom-dependent detail: coarse world land when zoomed out, detail and labels when zoomed in. */
  private update() {
    const z = this.map.getZoom();
    const visible: Record<string, boolean> = {
      land50: z < 5, land10: z >= 4, lakes: z >= 4, urban: z >= 6, states: z >= 3, borders: true, major: z >= 5, minor: z >= 7,
    };
    // Add in drawing order so lines sit on top of fills.
    for (const k of ['land50', 'land10', 'urban', 'lakes', 'states', 'borders', 'minor', 'major'] as const) {
      const layer = this.layers[k];
      if (!layer) continue;
      if (visible[k] && !this.map.hasLayer(layer)) layer.addTo(this.map);
      if (!visible[k] && this.map.hasLayer(layer)) layer.remove();
    }
    for (const k of ['urban', 'lakes', 'states', 'borders', 'minor', 'major'] as const) this.layers[k]?.bringToFront();

    this.labels.clearLayers();
    if (!this.showLabels(this.map)) return;
    const view = this.map.getBounds().pad(0.1);
    let n = 0;
    for (const p of this.places) {
      if (n >= MAX_LABELS) break;
      if (p.minZoom > z + 1 || !view.contains(p.at)) continue;
      const el = document.createElement('span');
      el.textContent = p.name;
      L.marker(p.at, {
        pane: 'basemapLabels', interactive: false, keyboard: false,
        icon: L.divIcon({ className: 'map-place', html: el, iconSize: undefined }),
      }).addTo(this.labels);
      n++;
    }
  }
}
