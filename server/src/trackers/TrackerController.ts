import type { FastifyRequest } from 'fastify';
import { requireActor } from '../../framework/core/actor.js';
import type { TrackerService } from './TrackerService.js';

export type TrackerProfileQuerystring = Readonly<{ refresh?: 'true' | 'false' }>;

export class TrackerController {
  constructor(private readonly trackers: TrackerService) {}

  status = async (request: FastifyRequest) => this.trackers.status(requireActor(request.actor));

  profile = async (request: FastifyRequest<{ Querystring: TrackerProfileQuerystring }>) =>
    this.trackers.currentProfile(requireActor(request.actor), request.query.refresh === 'true');

  push = async (request: FastifyRequest) => this.trackers.push(requireActor(request.actor));
}
