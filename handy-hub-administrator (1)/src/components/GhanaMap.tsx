import React, { useEffect } from 'react';
import { MapContainer, TileLayer, useMap, Circle } from 'react-leaflet';
import L from 'leaflet';
import { MapPin } from 'lucide-react';

// Fix for default marker icon in Leaflet with React
import icon from 'leaflet/dist/images/marker-icon.png';
import iconShadow from 'leaflet/dist/images/marker-shadow.png';

let DefaultIcon = L.icon({
    iconUrl: icon,
    shadowUrl: iconShadow,
    iconSize: [25, 41],
    iconAnchor: [12, 41]
});

L.Marker.prototype.options.icon = DefaultIcon;

interface RegionData {
  artisans: number;
  active_jobs: number;
  revenue: number;
  growth: string;
}

interface GhanaMapProps {
  regionalData: { [key: string]: RegionData };
  onRegionClick?: (regionName: string) => void;
}

// Component to handle map bounds and locking
const MapBoundsHandler = () => {
  const map = useMap();
  
  useEffect(() => {
    // Ghana bounds
    const southWest = L.latLng(4.7, -3.5);
    const northEast = L.latLng(11.2, 1.5);
    const bounds = L.latLngBounds(southWest, northEast);
    
    map.setMaxBounds(bounds);
    map.on('drag', () => {
      map.panInsideBounds(bounds, { animate: false });
    });
  }, [map]);

  return null;
};

const GHANA_REGIONS_COORDS: { [key: string]: [number, number] } = {
  'Greater Accra': [5.6037, -0.1870],
  'Ashanti': [6.6666, -1.6163],
  'Western': [5.5500, -2.1500],
  'Eastern': [6.1000, -0.2600],
  'Central': [5.5000, -1.2000],
  'Volta': [6.5000, 0.4500],
  'Northern': [9.4000, -0.8500],
  'Upper East': [10.7800, -0.8500],
  'Upper West': [10.3500, -2.1500],
  'Bono': [7.5800, -2.5000],
  'Bono East': [7.7500, -1.0000],
  'Ahafo': [7.0000, -2.4000],
  'Savannah': [9.1000, -1.8000],
  'North East': [10.5000, -0.3500],
  'Oti': [8.0000, 0.3000],
  'Western North': [6.3000, -2.8000]
};

const GhanaMap: React.FC<GhanaMapProps> = ({ regionalData = {}, onRegionClick }) => {
  // Center of Ghana
  const center: [number, number] = [7.9465, -1.0232];
  const zoom = 7;

  return (
    <div className="relative w-full h-[600px] bg-bg-panel rounded-3xl border border-white/10 overflow-hidden">
      <div className="absolute top-6 left-6 z-[1000] pointer-events-none">
        <div className="bg-bg-panel/80 backdrop-blur-md p-4 rounded-2xl border border-white/10 shadow-2xl">
          <h3 className="text-lg font-bold text-white">Operational Regions</h3>
          <p className="text-xs text-white/40">Real-time geographic service coverage</p>
        </div>
      </div>

      <div className="absolute top-6 right-6 z-[1000] flex flex-col gap-2">
        <div className="flex items-center gap-2 px-3 py-1.5 bg-bg-panel/80 backdrop-blur-md border border-white/10 rounded-lg shadow-sm">
          <div className="w-2 h-2 rounded-full bg-accent-green shadow-[0_0_8px_rgba(34,197,94,0.5)]" />
          <span className="text-[10px] font-bold text-white/60 uppercase tracking-wider tracking-widest">Live Map Active</span>
        </div>
      </div>

      <MapContainer 
        center={center} 
        zoom={zoom} 
        scrollWheelZoom={true}
        className="w-full h-full z-0"
        minZoom={6}
        maxZoom={12}
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>'
          url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
        />
        <MapBoundsHandler />
        
        {/* Highlight active regions */}
        {Object.entries(regionalData).map(([regionName, data]) => {
          const coords = GHANA_REGIONS_COORDS[regionName];
          if (!coords) return null;

          return (
            <React.Fragment key={regionName}>
              <Circle 
                center={coords}
                radius={25000} // 25km radius
                pathOptions={{
                  fillColor: '#3b82f6',
                  fillOpacity: 0.2,
                  color: '#3b82f6',
                  weight: 1,
                  dashArray: '5, 5'
                }}
              />
              <Circle 
                center={coords}
                radius={5000} // 5km center dot
                pathOptions={{
                  fillColor: '#3b82f6',
                  fillOpacity: 0.8,
                  color: '#fff',
                  weight: 2
                }}
                eventHandlers={{
                  click: () => onRegionClick?.(regionName)
                }}
              />
            </React.Fragment>
          );
        })}
      </MapContainer>

      {/* Legend */}
      <div className="absolute bottom-6 left-6 right-6 flex items-center justify-between pointer-events-none z-[1000]">
        <div className="flex gap-4">
          <div className="flex items-center gap-2 bg-bg-panel/80 backdrop-blur-md px-3 py-1.5 rounded-lg border border-white/10">
            <div className="w-3 h-3 rounded-full bg-accent-blue shadow-[0_0_8px_rgba(59,130,246,0.5)]" />
            <span className="text-[10px] font-bold text-white/40 uppercase tracking-wider">Service Areas</span>
          </div>
        </div>
        <div className="bg-bg-panel/80 backdrop-blur-md px-3 py-1.5 rounded-lg border border-white/10">
          <p className="text-[10px] font-medium text-white/20 italic">Map locked to Ghana operational boundaries</p>
        </div>
      </div>
    </div>
  );
};

export default GhanaMap;
