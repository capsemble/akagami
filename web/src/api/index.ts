import { liveApi } from './live';
import { mockApi } from './mock';
import type { ApiClient } from './types';

export const API_MODE = (import.meta.env.VITE_API ?? 'mock') as 'mock' | 'live';

export const api: ApiClient = API_MODE === 'live' ? liveApi : mockApi;

export type { ApiClient, AdaptRequest, NpcTurnRequest } from './types';
