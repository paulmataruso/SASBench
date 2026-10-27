import { MAX_DOWNLOAD_TILES, tileCount } from '../../../map/tiles.ts';
import type { Route, V1Deps } from '../http.ts';
import { ApiError, SENT, accepted, badRequest, conflict, noContent, notFound, page } from '../http.ts';
import { S, ref } from '../schema.ts';
import { fileResp, noContentResp, ok, okRef, pageOf, pageQuery } from './common.ts';

// Map tiles: the effective map configuration, the offline tile store (MBTiles files and z/x/y
// directories) and the background download of a tile set for offline use.

const bounds = S.arr(S.num(), { minItems: 4, maxItems: 4, description: '[west, south, east, north] in degrees.' });

const mapOf = (d: V1Deps) => {
  const s = d.settings.get();
  return {
    source: s.mapSource, url: s.mapTileUrl, attribution: s.mapTileAttribution, maxZoom: s.mapTileMaxZoom, darken: s.mapDarkenTiles,
    local: s.mapSource === 'local' ? d.tiles.pick(s.mapLocalTiles) : null,
    store: { dir: d.tiles.dir, sets: d.tiles.list() }, download: d.tileDownloader.job, maxDownloadTiles: MAX_DOWNLOAD_TILES,
  };
};

function tileSet(d: V1Deps, id: string) {
  const t = d.tiles.list().find((x) => x.id === id);
  if (!t) throw notFound('Tile set');
  return t;
}

export const mapRoutes: Route[] = [
  {
    method: 'GET', path: '/map', operationId: 'getMap', tag: 'Map', scope: 'read',
    summary: 'Map configuration',
    description: 'Where the console map takes its tiles from (settings mapSource, mapTileUrl, …), the tile set in use when the source is local, the offline tile store and the current download.',
    responses: okRef('Map configuration.', 'MapConfig'),
    handler: ({ d }) => mapOf(d),
  },
  {
    method: 'GET', path: '/map/tilesets', operationId: 'listTileSets', tag: 'Map', scope: 'read',
    summary: 'List offline tile sets', description: 'MBTiles files and z/x/y tile directories in the tile store directory.',
    query: pageQuery(),
    responses: ok('A page of tile sets.', pageOf('TileSet')),
    handler: ({ d, query }) => page(d.tiles.list(), query),
  },
  {
    method: 'POST', path: '/map/tilesets/rescan', operationId: 'rescanTileSets', tag: 'Map', scope: 'write',
    summary: 'Rescan the tile store', description: 'Picks up tile sets copied into the directory by hand.',
    responses: ok('Tile sets.', S.obj({ items: S.arr(ref('TileSet')) }, ['items'])),
    handler: ({ d }) => {
      const sets = d.tiles.rescan();
      d.bus.changed('map');
      return { items: sets };
    },
  },
  {
    method: 'GET', path: '/map/tilesets/{id}', operationId: 'getTileSet', tag: 'Map', scope: 'read',
    summary: 'Get a tile set', params: { id: { description: 'Tile set id (file or directory name).' } },
    responses: okRef('The tile set.', 'TileSet'),
    handler: ({ d, params }) => tileSet(d, params.id),
  },
  {
    method: 'DELETE', path: '/map/tilesets/{id}', operationId: 'deleteTileSet', tag: 'Map', scope: 'write',
    summary: 'Delete a tile set', description: 'Deletes the file or directory. 409 while it is being downloaded.',
    params: { id: { description: 'Tile set id.' } },
    responses: noContentResp('Deleted.'),
    handler: ({ d, params }) => {
      tileSet(d, params.id);
      const job = d.tileDownloader.job;
      if (job?.state === 'running' && job.file === params.id) throw conflict('That tile set is still downloading');
      d.tiles.remove(params.id);
      d.bus.event('info', 'map', `Deleted offline map ${params.id}`);
      d.bus.changed('map');
      return noContent();
    },
  },
  {
    method: 'GET', path: '/map/tilesets/{id}/tiles/{z}/{x}/{y}', operationId: 'getTile', tag: 'Map', scope: 'read',
    summary: 'Get one tile', description: 'The tile image (XYZ scheme, as Leaflet requests it). 404 when the set has no tile there.',
    params: {
      id: { description: 'Tile set id.' }, z: { description: 'Zoom.', schema: S.int({ minimum: 0, maximum: 24 }) },
      x: { description: 'Column.', schema: S.int({ minimum: 0 }) }, y: { description: 'Row (XYZ).', schema: S.int({ minimum: 0 }) },
    },
    responses: fileResp('Tile image.', 'image/png'),
    handler: (c) => {
      tileSet(c.d, c.params.id);
      const t = c.d.tiles.tile(c.params.id, Number(c.params.z), Number(c.params.x), Number(c.params.y));
      if (!t) throw new ApiError(404, 'not_found', 'No tile at that position');
      c.res.writeHead(200, { 'Content-Type': t.type, 'Content-Length': t.data.length, 'Cache-Control': 'public, max-age=86400' });
      c.res.end(c.head ? undefined : t.data);
      return SENT;
    },
  },
  {
    method: 'GET', path: '/map/download', operationId: 'getTileDownload', tag: 'Map', scope: 'read',
    summary: 'Current or last tile download', description: 'Null when no download has run since the SAS started.',
    responses: ok('The job.', S.obj({ job: S.nullable(ref('TileDownloadJob')) }, ['job'])),
    handler: ({ d }) => ({ job: d.tileDownloader.job }),
  },
  {
    method: 'GET', path: '/map/download/estimate', operationId: 'estimateTileDownload', tag: 'Map', scope: 'read',
    summary: 'Count the tiles a download would fetch',
    query: {
      bounds: { description: 'west,south,east,north', schema: bounds, required: true },
      minZoom: { description: 'Lowest zoom.', schema: S.int({ minimum: 0, maximum: 18 }), required: true },
      maxZoom: { description: 'Highest zoom.', schema: S.int({ minimum: 0, maximum: 18 }), required: true },
    },
    responses: ok('Tile count.', S.obj({ tiles: S.int(), limit: S.int(), allowed: S.bool() }, ['tiles', 'limit', 'allowed'])),
    handler: ({ query }) => {
      if (query.minZoom > query.maxZoom) throw badRequest('minZoom must not exceed maxZoom');
      // The same area rules as a download start, so an estimate never allows what a start refuses.
      const [w, s, e, n] = query.bounds;
      if (w >= e || s >= n || w < -180 || e > 180 || s < -85.06 || n > 85.06) {
        throw badRequest('Invalid bounds: give [west, south, east, north] with west < east, south < north, longitude within ±180 and latitude within ±85.06');
      }
      const tiles = tileCount(query.bounds, query.minZoom, query.maxZoom);
      return { tiles, limit: MAX_DOWNLOAD_TILES, allowed: tiles <= MAX_DOWNLOAD_TILES };
    },
  },
  {
    method: 'POST', path: '/map/download', operationId: 'startTileDownload', tag: 'Map', scope: 'write', errors: [409],
    summary: 'Download a tile set for offline use',
    description: `Fetches every tile of the area and zoom range from a z/x/y tile server into \`<name>.mbtiles\` in the tile store, in the background (202). At most ${MAX_DOWNLOAD_TILES.toLocaleString('en-US')} tiles; OpenStreetMap's servers are refused (their policy forbids bulk downloads). Poll GET /map/download or watch the \`changed\` stream for "map".`,
    body: {
      required: true,
      schema: S.obj({
        url: S.str({ minLength: 1, description: 'Tile URL template with {z}, {x} and {y} (or {-y}).' }), bounds,
        minZoom: S.int({ minimum: 0, maximum: 18 }), maxZoom: S.int({ minimum: 0, maximum: 18 }),
        name: S.str({ maxLength: 100, default: 'offline' }), attribution: S.str({ maxLength: 500, default: '' }),
      }, ['url', 'bounds', 'minZoom', 'maxZoom']),
      example: { url: 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}', bounds: [-98.6, 38.9, -98.3, 39.1], minZoom: 8, maxZoom: 12, name: 'kansas-lab', attribution: 'USGS The National Map' },
    },
    responses: { 202: { description: 'Started.', schema: ref('TileDownloadJob') } },
    handler: ({ d, body }) => {
      if (d.tileDownloader.job?.state === 'running') throw conflict('A download is already running');
      try {
        return accepted(d.tileDownloader.start({ url: body.url, bounds: body.bounds, minZoom: body.minZoom, maxZoom: body.maxZoom, name: body.name ?? '', attribution: body.attribution ?? '' }));
      } catch (e: any) {
        throw badRequest(e.message);
      }
    },
  },
  {
    method: 'DELETE', path: '/map/download', operationId: 'cancelTileDownload', tag: 'Map', scope: 'write',
    summary: 'Cancel the tile download', description: 'The partial file is discarded.',
    responses: ok('The job.', S.obj({ cancelled: S.bool(), job: S.nullable(ref('TileDownloadJob')) }, ['cancelled', 'job'])),
    handler: ({ d }) => {
      const running = d.tileDownloader.job?.state === 'running';
      d.tileDownloader.cancel();
      return { cancelled: running, job: d.tileDownloader.job };
    },
  },
];
