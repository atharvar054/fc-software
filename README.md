# FC Software - Face Recognition Monitoring Dashboard

A React + Firebase web app for managing persons of interest, viewing alerts, and live map tracking.

## What This App Does

- Adds person records with image + metadata.
- Reads alert images from Firebase Storage (`Alerts/`) and syncs them into Firestore (`alerts` collection).
- Shows a real-time alert popup when new alerts arrive in Firestore.
- Displays live tracking routes on Google Maps.
- Provides a dedicated **Maps** sidebar page with fullscreen mode.
- Supports manual location override (for route/pin testing) from a single config file.

## Core Features Implemented

1. Sidebar pages:
- Dashboard
- Add Person
- Image Gallery
- Maps (map-only page, with fullscreen)
- Alerts

2. Live map behavior:
- Alert markers are rendered from Firestore data.
- Route generation starts from VESIT origin and tracks alert points.
- Fallback route rendering available when needed.

3. Alert sync + real-time updates:
- App periodically syncs alert files from Storage to Firestore in background.
- Firestore listener shows popup for newly added alerts globally (not only on Alerts page).

4. Manual coordinate override:
- Centralized in `src/locationConfig.js`.
- Can target one person or all persons.
- Useful for testing custom pin locations and routes quickly.

## Tech Stack

- React (Create React App)
- Firebase Firestore
- Firebase Storage
- Google Maps (`@react-google-maps/api`)

## Project Structure (Important Files)

- `src/App.jsx` - App shell, sidebar pages, popup listener, alert sync flow
- `src/MapSection.js` - Live map, routes, markers, map interactions
- `src/locationConfig.js` - VESIT origin + manual location override rules
- `src/firebaseConfig.js` - Firebase initialization
- `src/App.css` - Main app and map styling

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Google Maps API key

The map uses `REACT_APP_GOOGLE_MAPS_API_KEY`.

Create a `.env` file in project root:

```env
REACT_APP_GOOGLE_MAPS_API_KEY=YOUR_GOOGLE_MAPS_API_KEY
```

### 3. Firebase setup

The app currently reads Firebase config from `src/firebaseConfig.js`.

Required services:
- Firestore
- Storage

Expected collections/folders:
- Firestore collection: `persons`
- Firestore collection: `alerts`
- Storage folder: `persons/`
- Storage folder: `Alerts/`

## Run Scripts

### Start development server

```bash
npm start
```

### Production build

```bash
npm run build
```

### Run tests

```bash
npm test
```

## Manual Location Override Guide

Edit `src/locationConfig.js`:

```js
export const MANUAL_LOCATION_OVERRIDE = {
	enabled: false,
	personID: '',
	latitude: 19.04569824845185,
	longitude: 72.90302415049653,
	locationName: 'Custom Location',
};
```

How to use:

1. Set `enabled: true`.
2. Set `personID` to a specific person (example: `P002`) to apply only for that person.
3. Set `personID` to empty string (`''`) or `null` to apply for all persons.
4. Set `latitude` and `longitude`.
5. Save and refresh app.

Behavior:

- Map marker location for matching person(s) uses manual coordinates.
- Route uses VESIT as origin and manual location as destination point.
- Popup/details also resolve location through the same config logic.

## Maps Page (Fullscreen)

- Open sidebar -> **Maps**.
- This page shows only the live tracking map block.
- Click **Full Screen** to enter browser fullscreen.
- Click **Exit Full Screen** (or press `Esc`) to return.

## Data Flow Summary

1. Alert images are uploaded to Storage (`Alerts/`) by detection pipeline.
2. App scans Storage and writes missing alert docs into Firestore (`alerts`).
3. Firestore real-time listener updates map and popups.
4. Map uses Firestore alert coordinates (or manual override when enabled).

## Notes

- If map does not load, verify Google Maps API key and billing/API enablement.
- If alerts do not appear, verify Storage path names and Firestore rules.
- Some lint warnings may still exist for currently unused variables; they do not block build.
