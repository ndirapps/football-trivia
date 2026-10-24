import type { CapacitorConfig } from "@capacitor/cli";

// The native shell around the same SPA the Worker serves.
//
// The bundle ships inside the app (webDir) rather than loading the live site:
// the app opens with no network, and a store build is a real app, not a browser
// pointed at a URL. Only the API goes over the network, to VITE_API_ORIGIN —
// see src/client/lib/origin.ts and `npm run app:build`.
const config: CapacitorConfig = {
  appId: "com.royasraf.footballiq",
  appName: "Football IQ",
  webDir: "dist/client",
  backgroundColor: "#0d1522",
  ios: {
    contentInset: "never",
  },
  android: {
    backgroundColor: "#0d1522",
  },
  plugins: {
    SplashScreen: {
      launchShowDuration: 0,
      backgroundColor: "#0d1522",
    },
  },
};

export default config;
