/**
 * geo.js — Geospatial utility functions
 */

'use strict';

/**
 * Calculate the great-circle distance between two points on the Earth's surface
 * using the Haversine formula.
 *
 * @param {number} lat1 Latitude of point 1
 * @param {number} lon1 Longitude of point 1
 * @param {number} lat2 Latitude of point 2
 * @param {number} lon2 Longitude of point 2
 * @returns {number} Distance in kilometers
 */
export function getHaversineDistanceKm(lat1, lon1, lat2, lon2) {
    if (lat1 === null || lon1 === null || lat2 === null || lon2 === null ||
        lat1 === undefined || lon1 === undefined || lat2 === undefined || lon2 === undefined) {
        return null;
    }
    const R = 6371; // Earth's radius in km
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

/**
 * Estimate the travel time (ETA) in minutes between two points.
 * Assumes average city travel speed of 30 km/h (2 minutes per km) + 3 mins buffer.
 *
 * @param {number} distanceKm Distance in kilometers
 * @param {number} [minMinutes=5] Minimum ETA to return
 * @returns {number} Estimated time in minutes
 */
export function estimateEtaMinutes(distanceKm, minMinutes = 5) {
    if (distanceKm === null || distanceKm === undefined) return null;
    // 30 km/h -> 2 minutes per km. Add 3 minutes buffer for traffic/finding address.
    const calculated = Math.round(distanceKm * 2) + 3;
    return Math.max(minMinutes, calculated);
}
