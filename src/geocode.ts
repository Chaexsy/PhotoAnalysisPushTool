import { config } from './config.js';
import { logger } from './logger.js';

const cache = new Map<string, string | null>();
const keyFor = (lat: number, lon: number) => `${lat.toFixed(4)},${lon.toFixed(4)}`;

export async function reverseGeocode(latitude: number | null, longitude: number | null): Promise<string | null> {
  if (!config.GEOCODE_ENABLED || latitude === null || longitude === null) return null;
  const key = keyFor(latitude, longitude);
  if (cache.has(key)) return cache.get(key) ?? null;
  try {
    const url = new URL('https://nominatim.openstreetmap.org/reverse');
    url.searchParams.set('format', 'jsonv2'); url.searchParams.set('lat', String(latitude)); url.searchParams.set('lon', String(longitude));
    url.searchParams.set('zoom', '18'); url.searchParams.set('accept-language', 'zh-CN');
    const response = await fetch(url, { headers: { 'User-Agent': config.GEOCODE_USER_AGENT, Accept: 'application/json' } });
    if (!response.ok) throw new Error(`geocoder HTTP ${response.status}`);
    const body = await response.json() as { display_name?: string; address?: Record<string, string> };
    const address = body.address ?? {};
    const parts = [address.country, address.state, address.city ?? address.town ?? address.county, address.city_district ?? address.suburb, address.road].filter(Boolean);
    const name = parts.length ? [...new Set(parts)].join(' · ') : body.display_name ?? null;
    cache.set(key, name); return name;
  } catch (error) {
    logger.warn({ error, latitude, longitude }, 'reverse geocoding failed'); cache.set(key, null); return null;
  }
}
