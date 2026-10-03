// The CSP build ships no types of its own; it is the same API as the package's main entry.
declare module 'maplibre-gl/dist/maplibre-gl-csp.js' {
  import * as maplibregl from 'maplibre-gl';
  export default maplibregl;
}
