import { AudioLines } from 'lucide-react';
import { useResource } from '../lib/live';
import { useFollow } from '../lib/follow';
import { Link, navigate } from '../lib/router';
import { mhz } from '../lib/format';
import { Empty, ErrorNote, Module, PageHeader, SkeletonRows } from '../components/ui';
import { BandPlan } from './spectrum/BandPlan';
import { SpectrumMap, mapSourceLabel } from './spectrum/SpectrumMap';
import { ProtectionsModule } from './spectrum/Protections';
import { PpasModule } from './spectrum/Ppas';
import { IncumbentsModule } from './spectrum/Incumbents';
import type { SpectrumData } from './spectrum/shared';
import type { MapConfig } from '../lib/types';

// Spectrum: band plan, map, protections (DPAs and incumbents), PPAs.

export function SpectrumPage() {
  const res = useResource<SpectrumData>('/api/spectrum', ['spectrum', 'grants', 'cbsds', 'settings']);
  const mapCfg = useResource<MapConfig>('/api/map', ['map', 'settings']);
  const { followed } = useFollow();
  const d = res.data;
  const reload = res.reload;

  const authorizedMHz = d ? d.grants.filter((g) => g.state === 'AUTHORIZED' && !g.suspended).reduce((a, g) => a + (g.high - g.low), 0) / 1e6 : 0;
  const activeProt = d ? d.protections.filter((p) => p.active).length : 0;

  return (
    <>
      <PageHeader
        title="Spectrum"
        sub={d
          ? `${mhz(d.band.low)}–${mhz(d.band.high)} MHz · ${d.grants.length} live grant${d.grants.length === 1 ? '' : 's'} (${+authorizedMHz.toFixed(1)} MHz authorized) · ${activeProt} active protection${activeProt === 1 ? '' : 's'} · ${d.ppas.length} PPA${d.ppas.length === 1 ? '' : 's'}. Changes reach CBSDs on their next request.`
          : 'Band plan, incumbent protections and PPAs.'}
      />

      {res.error && !d ? <ErrorNote>Could not load spectrum data: {res.error}</ErrorNote>
        : !d ? (
          <Module title="Band plan"><SkeletonRows rows={6} cols={1} /></Module>
        ) : (
          <div className="space-y-4">
            <Module title="Band plan" meta="click a grant to open its CBSD">
              {d.band.high > d.band.low ? (
                <BandPlan data={d} followed={followed} onOpen={(id) => navigate(`/cbsds/${encodeURIComponent(id)}`)} />
              ) : (
                <Empty icon={AudioLines} title="Band not configured">Set the band edges in Settings.</Empty>
              )}
            </Module>

            <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
              <Module
                title="Map"
                bodyClass="p-0 min-h-[440px] flex flex-col"
                meta={mapCfg.data ? (
                  <Link to="/settings#map" className="hover:text-ink hover:underline" title="Change the base map in Settings → Map">{mapSourceLabel(mapCfg.data)}</Link>
                ) : null}
              >
                <SpectrumMap data={d} followed={followed} config={mapCfg.data} />
              </Module>
              <PpasModule data={d} reload={reload} />
            </div>

            <ProtectionsModule data={d} reload={reload} />
            <IncumbentsModule data={d} reload={reload} />
          </div>
        )}
    </>
  );
}
