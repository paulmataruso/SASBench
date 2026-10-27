import type { Route } from '../http.ts';
import { systemRoutes } from './system.ts';
import { tokenRoutes } from './tokens.ts';
import { userRoutes } from './users.ts';
import { settingsRoutes } from './settings.ts';
import { cbsdRoutes } from './cbsds.ts';
import { grantRoutes } from './grants.ts';
import { sasRoutes } from './sas.ts';
import { registryRoutes } from './registry.ts';
import { spectrumRoutes } from './spectrum.ts';
import { faultRoutes } from './faults.ts';
import { logRoutes } from './logs.ts';
import { operationRoutes } from './operations.ts';
import { harnessRoutes } from './harness.ts';
import { certRoutes } from './certs.ts';
import { mapRoutes } from './map.ts';
import { terrainRoutes } from './terrain.ts';
import { configRoutes } from './config.ts';
import { dataRoutes } from './data.ts';

// Every /api/v1 route, in documentation order (tags appear in the order of their first route).

export const ROUTES: Route[] = [
  ...systemRoutes, ...tokenRoutes, ...userRoutes, ...settingsRoutes, ...cbsdRoutes, ...grantRoutes, ...sasRoutes, ...registryRoutes,
  ...spectrumRoutes, ...faultRoutes, ...logRoutes, ...operationRoutes, ...harnessRoutes, ...certRoutes, ...mapRoutes,
  ...terrainRoutes, ...configRoutes, ...dataRoutes,
];
