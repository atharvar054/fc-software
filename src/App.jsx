import React, { useState, useEffect, useRef } from "react";
import { ref, uploadBytes, listAll, getDownloadURL } from "firebase/storage";
import { storage, db } from "./firebaseConfig";
import { collection, setDoc, doc, getDocs, getDoc, onSnapshot, query, orderBy } from "firebase/firestore";
import MapSection from './MapSection';
import './App.css';
import { resolveAlertLocation } from './locationConfig';

function App() {
  const [activePage, setActivePage] = useState('dashboard');
  const [uploadedImages, setUploadedImages] = useState([]);
  const [loading, setLoading] = useState(false);
  const [galleryFolder, setGalleryFolder] = useState('persons'); // 'persons' or 'alerts'
  const [personsImages, setPersonsImages] = useState([]);
  const [alertsImages, setAlertsImages] = useState([]);
  const [alerts, setAlerts] = useState([]);
  const [alertsLoading, setAlertsLoading] = useState(false);
  const [selectedImage, setSelectedImage] = useState(null);
  const [selectedAlertDetails, setSelectedAlertDetails] = useState(null);
  const [alertDetailsLoading, setAlertDetailsLoading] = useState(false);
  const [currentAlertPopup, setCurrentAlertPopup] = useState(null);
  const alertMonitorInitializedRef = useRef(false);
  const knownAlertIdsRef = useRef(new Set());
  const popupTimerRef = useRef(null);
  const alertsSyncInProgressRef = useRef(false);
  const mapsPageRef = useRef(null);
  const [isMapsFullscreen, setIsMapsFullscreen] = useState(false);
  
  // Person upload form state
  const [personForm, setPersonForm] = useState({
    fullName: '',
    age: '',
    tag: 'Missing',
    description: '',
    missingDateTime: '',
    imageFile: null
  });
  const [personUploading, setPersonUploading] = useState(false);

  // Generate personID helper
  const generatePersonID = (n) => `P${String(n).padStart(3, '0')}`;

  // Get next personID from Firestore
  const getNextPersonID = async () => {
    try {
      const personsRef = collection(db, "persons");
      const snapshot = await getDocs(personsRef);
      const count = snapshot.size;
      return generatePersonID(count + 1);
    } catch (error) {
      console.error("Error getting next personID:", error);
      // Fallback: start from P001
      return generatePersonID(1);
    }
  };

  // Upload person with details
  const handlePersonUpload = async () => {
    if (!personForm.imageFile) {
      alert("Please select an image file!");
      return;
    }
    if (!personForm.fullName.trim()) {
      alert("Please enter the person's full name!");
      return;
    }

    setPersonUploading(true);
    try {
      // Generate personID
      const personID = await getNextPersonID();
      
      // Rename file to personID.jpg
      const renamedFile = new File(
        [personForm.imageFile], 
        `${personID}.jpg`, 
        { type: personForm.imageFile.type }
      );

      // Upload image to Storage: /persons/P001.jpg
      const storageRef = ref(storage, `persons/${personID}.jpg`);
      await uploadBytes(storageRef, renamedFile);

      // Save person details to Firestore
      await setDoc(doc(db, "persons", personID), {
        fullName: personForm.fullName.trim(),
        age: personForm.age || null,
        tag: personForm.tag,
        description: personForm.description.trim() || '',
        missingDateTime: personForm.missingDateTime || null,
        createdAt: new Date().toISOString()
      });

      alert(`Person ${personID} uploaded successfully ✅`);
      
      // Reset form
      setPersonForm({
        fullName: '',
        age: '',
        tag: 'Missing',
        description: '',
        missingDateTime: '',
        imageFile: null
      });
      
      // Reset file input
      const fileInput = document.getElementById('person-image-upload');
      if (fileInput) fileInput.value = '';
    } catch (error) {
      console.error("Error uploading person:", error);
      alert("Upload failed ❌");
    } finally {
      setPersonUploading(false);
    }
  };

  // Fetch images from Persons folder
  const fetchPersonsImages = async () => {
    setLoading(true);
    try {
      const personsRef = ref(storage, 'persons/');
      const result = await listAll(personsRef);
      
      const imagePromises = result.items
        .filter(item => {
          const name = item.name.toLowerCase();
          return name.endsWith('.jpg') || name.endsWith('.jpeg') || name.endsWith('.png');
        })
        .map(async (item) => {
          const url = await getDownloadURL(item);
          return {
            name: item.name,
            url: url,
            fullPath: item.fullPath
          };
        });
      
      const images = await Promise.all(imagePromises);
      setPersonsImages(images);
    } catch (error) {
      console.error("Error fetching persons images:", error);
      setPersonsImages([]);
    } finally {
      setLoading(false);
    }
  };

  // Fetch images from Alerts folder
  const fetchAlertsImages = async () => {
    setLoading(true);
    try {
      const alertsRef = ref(storage, 'Alerts/');
      const result = await listAll(alertsRef);
      
      const imagePromises = result.items
        .filter(item => {
          const name = item.name.toLowerCase();
          return name.endsWith('.jpg') || name.endsWith('.jpeg') || name.endsWith('.png');
        })
        .map(async (item) => {
          const url = await getDownloadURL(item);
          return {
            name: item.name,
            url: url,
            fullPath: item.fullPath
          };
        });
      
      const images = await Promise.all(imagePromises);
      setAlertsImages(images);
    } catch (error) {
      console.error("Error fetching alerts images:", error);
      setAlertsImages([]);
    } finally {
      setLoading(false);
    }
  };

  const fetchAlerts = async (showLoading = true) => {
    if (showLoading) setAlertsLoading(true);
    try {
      const alertsRef = ref(storage, "Alerts/");
      const res = await listAll(alertsRef);
      const alertItems = [];
      const firestoreAlertsSnapshot = await getDocs(collection(db, "alerts"));
      const processedAlerts = new Set(
        firestoreAlertsSnapshot.docs.map((docSnap) => docSnap.id)
      );
      // For generating sequential alert IDs like A001, A002, ...
      let nextAlertIndex = firestoreAlertsSnapshot.size + 1;

      for (const item of res.items) {
        // Only process image files (jpg, jpeg, png)
        if (!item.name.toLowerCase().endsWith(".jpg") && 
            !item.name.toLowerCase().endsWith(".jpeg") && 
            !item.name.toLowerCase().endsWith(".png")) {
          continue;
        }

        try {
          // Extract personID and timestamp from filename: P001_20250111-152233.jpg
          const filenameWithoutExt = item.name.replace(/\.(jpg|jpeg|png)$/i, '');
          const parts = filenameWithoutExt.split('_');
          // 👉 Only need the personID (e.g. P001) in Firestore
          const personID = parts[0] || "Unknown";
          const alertTime = parts.slice(1).join('_') || "Unknown";

          // Get image URL only for UI display (NOT stored in Firestore)
          const imageURL = await getDownloadURL(item);

          // Fetch person details from Firestore
          let personDetails = null;
          if (personID !== "Unknown") {
            try {
              const personDoc = await getDoc(doc(db, "persons", personID));
              if (personDoc.exists()) {
                personDetails = personDoc.data();
              }
            } catch (personError) {
              console.warn(`Could not fetch person details for ${personID}:`, personError);
            }
          }

          // Format alert time for display
          let formattedTime = alertTime;
          if (alertTime.length === 15) {
            // Format: 20250111-152233 -> 2025-01-11 15:22:33
            const datePart = alertTime.substring(0, 8);
            const timePart = alertTime.substring(9);
            formattedTime = `${datePart.substring(0, 4)}-${datePart.substring(4, 6)}-${datePart.substring(6)} ${timePart.substring(0, 2)}:${timePart.substring(2, 4)}:${timePart.substring(4)}`;
          }

          const resolvedPersonLocation = resolveAlertLocation({
            personID,
            location: personDetails?.lastKnownLocation,
            locationName: typeof personDetails?.lastKnownLocation === 'string'
              ? personDetails.lastKnownLocation
              : null,
          });

          const enrichedAlert = {
            img: imageURL,
            personID: personID,
            // Person name comes from the persons collection if available
            name: personDetails?.fullName || personID,
            age: personDetails?.age || null,
            tag: personDetails?.tag || "Unknown",
            description: personDetails?.description || "",
            time: formattedTime,
            alertTime: alertTime,
            location: resolvedPersonLocation.location,
            locationName: resolvedPersonLocation.locationName,
            alertDocId: filenameWithoutExt // Store document ID for fetching details
          };

          // Persist into Firestore with deterministic doc id based on filename,
          // and a human‑friendly alertID like A001, A002, ...
          const alertDocId = filenameWithoutExt;
          if (!processedAlerts.has(alertDocId)) {
            const alertID = `A${String(nextAlertIndex).padStart(3, "0")}`;
            nextAlertIndex += 1;

            try {
              await setDoc(doc(db, "alerts", alertDocId), {
                alertID: alertID,
                personID: personID,
                alertTime: formattedTime,
                location: enrichedAlert.location,
                locationName: enrichedAlert.locationName,
                // Store personName for convenience; comes from persons/{personID}
                personName: enrichedAlert.name
              });
              processedAlerts.add(alertDocId);
            } catch (firestoreError) {
              console.warn(`Could not write alert to Firestore for ${alertDocId}:`, firestoreError);
            }
          }

          alertItems.push(enrichedAlert);
        } catch (error) {
          console.error(`Error processing alert item ${item.name}:`, error);
        }
      }

      // Sort alerts by time (newest first)
      alertItems.sort((a, b) => {
        return b.alertTime.localeCompare(a.alertTime);
      });

      setAlerts(alertItems);
    } catch (err) {
      console.error("Error loading alerts:", err);
      setAlerts([]);
    } finally {
      if (showLoading) setAlertsLoading(false);
    }
  };

  useEffect(() => {
    if (activePage === 'gallery') {
      if (galleryFolder === 'persons') {
        fetchPersonsImages();
      } else {
        fetchAlertsImages();
      }
    }
  }, [activePage, galleryFolder]);

  // Fetch alert details from Firestore
  const fetchAlertDetails = async (alertDocId) => {
    setAlertDetailsLoading(true);
    try {
      // Get alert document from Firestore
      const alertDoc = await getDoc(doc(db, "alerts", alertDocId));
      
      if (!alertDoc.exists()) {
        alert("Alert details not found");
        return;
      }

      const alertData = alertDoc.data();
      const resolvedAlertLocation = resolveAlertLocation({
        personID: alertData.personID,
        location: alertData.location,
        locationName: alertData.locationName,
      });
      
      // Get person details from Firestore
      let personDetails = null;
      if (alertData.personID) {
        try {
          const personDoc = await getDoc(doc(db, "persons", alertData.personID));
          if (personDoc.exists()) {
            personDetails = personDoc.data();
          }
        } catch (personError) {
          console.warn(`Could not fetch person details for ${alertData.personID}:`, personError);
        }
      }

      // Get alert image URL from Storage
      const alertImageRef = ref(storage, `Alerts/${alertDocId}.jpg`);
      const imageURL = await getDownloadURL(alertImageRef);

      setSelectedAlertDetails({
        ...alertData,
        location: resolvedAlertLocation.location,
        locationName: resolvedAlertLocation.locationName,
        personDetails: personDetails,
        imageURL: imageURL
      });
    } catch (error) {
      console.error("Error fetching alert details:", error);
      alert("Failed to load alert details");
    } finally {
      setAlertDetailsLoading(false);
    }
  };

  useEffect(() => {
    if (activePage === 'alerts') {
      fetchAlerts();
    }
  }, [activePage]);

  useEffect(() => {
    const runBackgroundSync = async () => {
      if (alertsSyncInProgressRef.current) return;
      alertsSyncInProgressRef.current = true;
      try {
        await fetchAlerts(false);
      } finally {
        alertsSyncInProgressRef.current = false;
      }
    };

    runBackgroundSync();
    const timer = setInterval(runBackgroundSync, 15000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Real-time listener — show popup on ANY page when a new alert lands in Firestore
  useEffect(() => {
    const q = query(collection(db, 'alerts'), orderBy('alertTime', 'asc'));

    const unsub = onSnapshot(q, (snapshot) => {
      // First snapshot = page load. Record all existing IDs as baseline so we
      // never pop up stale alerts when the user opens the site.
      if (!alertMonitorInitializedRef.current) {
        alertMonitorInitializedRef.current = true;
        snapshot.docs.forEach((d) => knownAlertIdsRef.current.add(d.id));
        return;
      }

      // Subsequent snapshots — find docs added after our baseline
      const newDocs = snapshot.docChanges()
        .filter((c) => c.type === 'added' && !knownAlertIdsRef.current.has(c.doc.id))
        .map((c) => ({ id: c.doc.id, ...c.doc.data() }));

      snapshot.docs.forEach((d) => knownAlertIdsRef.current.add(d.id));

      if (newDocs.length === 0) return;

      // Show popup for the most-recent new arrival
      const latest = newDocs.sort((a, b) =>
        (b.alertTime || '').localeCompare(a.alertTime || '')
      )[0];

      const resolvedAlertLocation = resolveAlertLocation({
        personID: latest.personID,
        location: latest.location,
        locationName: latest.locationName,
      });

      clearTimeout(popupTimerRef.current);
      setCurrentAlertPopup({
        alertDocId:  latest.id,
        alertID:     latest.alertID,
        personID:    latest.personID,
        personName:  latest.personName || latest.personID,
        alertTime:   latest.alertTime,
        location:    resolvedAlertLocation.location,
        locationName: resolvedAlertLocation.locationName,
      });
      popupTimerRef.current = setTimeout(() => setCurrentAlertPopup(null), 9000);
    }, (err) => {
      console.error('[AlertMonitor] Firestore error:', err.code, err.message);
    });

    return () => {
      unsub();
      clearTimeout(popupTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsMapsFullscreen(document.fullscreenElement === mapsPageRef.current);
    };

    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
    };
  }, []);

  const toggleMapsFullscreen = async () => {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
        return;
      }

      if (mapsPageRef.current) {
        await mapsPageRef.current.requestFullscreen();
      }
    } catch (error) {
      console.error('Fullscreen toggle failed:', error);
    }
  };


  return (
    <div className="design-root">
      <div className="background-image" style={{ backgroundImage: "url('/static/Background.avif')" }} />
      <div className="main-layout">
        <aside className="sidebar">
          <div className="sidebar-content">
            <div className="sidebar-header">
              <h1 className="sidebar-title">Police Authority</h1>
              <p className="sidebar-subtitle">Face Recognition System</p>
            </div>
            <nav className="sidebar-nav">
              <button 
                className={`sidebar-btn ${activePage === 'dashboard' ? 'active' : ''}`}
                onClick={() => setActivePage('dashboard')}
              >
                <span className="sidebar-icon">{/* Home Icon */}
                  <svg fill="currentColor" height="24" width="24" viewBox="0 0 256 256"><path d="M224,115.55V208a16,16,0,0,1-16,16H168a16,16,0,0,1-16-16V168a8,8,0,0,0-8-8H112a8,8,0,0,0-8,8v40a16,16,0,0,1-16,16H48a16,16,0,0,1-16-16V115.55a16,16,0,0,1,5.17-11.78l80-75.48.11-.11a16,16,0,0,1,21.53,0,1.14,1.14,0,0,0,.11.11l80,75.48A16,16,0,0,1,224,115.55Z"></path></svg>
                </span>
                <span>Dashboard</span>
              </button>
              <button 
                className={`sidebar-btn ${activePage === 'addPerson' ? 'active' : ''}`}
                onClick={() => setActivePage('addPerson')}
              >
                <span className="sidebar-icon">{/* Person Icon */}
                  <svg fill="currentColor" height="24" width="24" viewBox="0 0 256 256"><path d="M128,80a48,48,0,1,0,48,48A48.05,48.05,0,0,0,128,80Zm0,80a32,32,0,1,1,32-32A32,32,0,0,1,128,160Zm88-29.84q.06-2.16,0-4.32l14.92-18.64a8,8,0,0,0,1.48-7.06,107.21,107.21,0,0,0-10.88-26.25,8,8,0,0,0-6-3.93l-23.72-2.64q-1.48-1.56-3-3L186,40.54a8,8,0,0,0-3.94-6,107.71,107.71,0,0,0-26.25-10.87,8,8,0,0,0-7.06,1.49L130.16,40Q128,40,125.84,40L107.2,25.11a8,8,0,0,0-7.06-1.48A107.6,107.6,0,0,0,73.89,34.51a8,8,0,0,0-3.93,6L67.32,64.27q-1.56,1.49-3,3L40.54,70a8,8,0,0,0-6,3.94,107.71,107.71,0,0,0-10.87,26.25,8,8,0,0,0,1.49,7.06L40,125.84Q40,128,40,130.16L25.11,148.8a8,8,0,0,0-1.48,7.06,107.21,107.21,0,0,0,10.88,26.25,8,8,0,0,0,6,3.93l23.72,2.64q1.49,1.56,3,3L70,215.46a8,8,0,0,0,3.94,6,107.71,107.71,0,0,0,26.25,10.87,8,8,0,0,0,7.06-1.49L125.84,216q2.16.06,4.32,0l18.64,14.92a8,8,0,0,0,7.06,1.48,107.21,107.21,0,0,0,26.25-10.88,8,8,0,0,0,3.93-6l2.64-23.72q1.56-1.48,3-3L215.46,186a8,8,0,0,0,6-3.94,107.71,107.71,0,0,0,10.87-26.25,8,8,0,0,0-1.49-7.06Zm-16.1-6.5a73.93,73.93,0,0,1,0,8.68,8,8,0,0,0,1.74,5.48l14.19,17.73a91.57,91.57,0,0,1-6.23,15L187,173.11a8,8,0,0,0-5.1,2.64,74.11,74.11,0,0,1-6.14,6.14,8,8,0,0,0-2.64,5.1l-2.51,22.58a91.32,91.32,0,0,1-15,6.23l-17.74-14.19a8,8,0,0,0-5-1.75h-.48a73.93,73.93,0,0,1-8.68,0,8,8,0,0,0-5.48,1.74L100.45,215.8a91.57,91.57,0,0,1-15-6.23L82.89,187a8,8,0,0,0-2.64-5.1,74.11,74.11,0,0,1-6.14-6.14,8,8,0,0,0-5.1-2.64L46.43,170.6a91.32,91.32,0,0,1-6.23-15l14.19-17.74a8,8,0,0,0,1.74-5.48,73.93,73.93,0,0,1,0-8.68,8,8,0,0,0-1.74-5.48L40.2,100.45a91.57,91.57,0,0,1,6.23-15L69,82.89a8,8,0,0,0,5.1-2.64,74.11,74.11,0,0,1,6.14-6.14A8,8,0,0,0,82.89,69L85.4,46.43a91.32,91.32,0,0,1,15-6.23l17.74,14.19a8,8,0,0,0,5.48,1.74,73.93,73.93,0,0,1,8.68,0,8,8,0,0,0,5.48-1.74L155.55,40.2a91.57,91.57,0,0,1,15,6.23L173.11,69a8,8,0,0,0,2.64,5.1,74.11,74.11,0,0,1,6.14,6.14,8,8,0,0,0,5.1,2.64l22.58,2.51a91.32,91.32,0,0,1,6.23,15l-14.19,17.74A8,8,0,0,0,199.87,123.66Z"></path></svg>
                </span>
                <span>Add Person</span>
              </button>
              <button 
                className={`sidebar-btn ${activePage === 'gallery' ? 'active' : ''}`}
                onClick={() => setActivePage('gallery')}
              >
                <span className="sidebar-icon">{/* Gallery Icon */}
                  <svg fill="currentColor" height="24" width="24" viewBox="0 0 256 256"><path d="M216,40H40A16,16,0,0,0,24,56V200a16,16,0,0,0,16,16H216a16,16,0,0,0,16-16V56A16,16,0,0,0,216,40Zm0,16V158.75l-26.07-26.06a16,16,0,0,0-22.63,0l-20,20-44-44a16,16,0,0,0-22.62,0L40,149.37V56ZM40,172l52-52,80,80H40Zm176,28H194.63l-36-36,20-20L216,181.38V200ZM144,100a12,12,0,1,1,12,12A12,12,0,0,1,144,100Z"></path></svg>
                </span>
                <span>Image Gallery</span>
              </button>
              <button
                className={`sidebar-btn ${activePage === 'maps' ? 'active' : ''}`}
                onClick={() => setActivePage('maps')}
              >
                <span className="sidebar-icon">{/* Map Icon */}
                  <svg fill="currentColor" height="24" width="24" viewBox="0 0 256 256"><path d="M168,56a40,40,0,1,0-40,40A40,40,0,0,0,168,56Zm-40,24a24,24,0,1,1,24-24A24,24,0,0,1,128,80Zm89.56,54.44-80-112a8,8,0,0,0-13.12,0l-80,112A8,8,0,0,0,51,147.31L120,128.77V224a8,8,0,0,0,16,0V128.77l69,18.54a8,8,0,0,0,8.56-12.87Z"></path></svg>
                </span>
                <span>Maps</span>
              </button>
              <button 
                className={`sidebar-btn ${activePage === 'alerts' ? 'active' : ''}`}
                onClick={() => setActivePage('alerts')}
              >
                <span className="sidebar-icon">{/* Alerts Icon */}
                  <svg fill="currentColor" height="24" width="24" viewBox="0 0 256 256"><path d="M221.8,175.94C216.25,166.38,208,139.33,208,104a80,80,0,1,0-160,0c0,35.34-8.26,62.38-13.81,71.94A16,16,0,0,0,48,200H88.81a40,40,0,0,0,78.38,0H208a16,16,0,0,0,13.8-24.06ZM128,216a24,24,0,0,1-22.62-16h45.24A24,24,0,0,1,128,216ZM48,184c7.7-13.24,16-43.92,16-80a64,64,0,1,1,128,0c0,36.05,8.28,66.73,16,80Z"></path></svg>
                </span>
                <span>Alerts</span>
              </button>
            </nav>
            <div className="sidebar-footer">
            </div>
          </div>
        </aside>
        <main className="main-content">
          <header className="main-header">
            <div>
              <h2 className="main-title">
                {activePage === 'dashboard' && 'Dashboard'}
                {activePage === 'addPerson' && 'Add Person'}
                {activePage === 'gallery' && 'Image Gallery'}
                {activePage === 'maps' && 'Maps'}
                {activePage === 'alerts' && 'Alerts'}
              </h2>
              <p className="main-subtitle">
                {activePage === 'dashboard' && 'Overview of system activity and recent alerts'}
                {activePage === 'addPerson' && 'Add a new person to the face recognition database'}
                {activePage === 'gallery' && 'View images from Persons and Alerts folders'}
                {activePage === 'maps' && 'Live tracking map with fullscreen mode'}
                {activePage === 'alerts' && 'System alerts and notifications'}
              </p>
            </div>
            <div className="main-header-actions">
              <div className="search-box">
                <input className="search-input" placeholder="Search for images or cases..." type="search" />
                <span className="search-icon">
                  <svg fill="currentColor" height="20" width="20" viewBox="0 0 256 256"><path d="M229.66,218.34l-50.07-50.06a88.11,88.11,0,1,0-11.31,11.31l50.06,50.07a8,8,0,0,0,11.32-11.32ZM40,112a72,72,0,1,1,72,72A72.08,72.08,0,0,1,40,112Z"></path></svg>
                </span>
              </div>
              <button className="profile-btn">
                <svg fill="currentColor" height="24" width="24" viewBox="0 0 256 256"><path d="M128,80a48,48,0,1,0,48,48A48.05,48.05,0,0,0,128,80Zm0,80a32,32,0,1,1,32-32A32,32,0,0,1,128,160Zm88-29.84q.06-2.16,0-4.32l14.92-18.64a8,8,0,0,0,1.48-7.06,107.21,107.21,0,0,0-10.88-26.25,8,8,0,0,0-6-3.93l-23.72-2.64q-1.48-1.56-3-3L186,40.54a8,8,0,0,0-3.94-6,107.71,107.71,0,0,0-26.25-10.87,8,8,0,0,0-7.06,1.49L130.16,40Q128,40,125.84,40L107.2,25.11a8,8,0,0,0-7.06-1.48A107.6,107.6,0,0,0,73.89,34.51a8,8,0,0,0-3.93,6L67.32,64.27q-1.56,1.49-3,3L40.54,70a8,8,0,0,0-6,3.94,107.71,107.71,0,0,0-10.87,26.25,8,8,0,0,0,1.49,7.06L40,125.84Q40,128,40,130.16L25.11,148.8a8,8,0,0,0-1.48,7.06,107.21,107.21,0,0,0,10.88,26.25,8,8,0,0,0,6,3.93l23.72,2.64q1.49,1.56,3,3L70,215.46a8,8,0,0,0,3.94,6,107.71,107.71,0,0,0,26.25,10.87,8,8,0,0,0,7.06-1.49L125.84,216q2.16.06,4.32,0l18.64,14.92a8,8,0,0,0,7.06,1.48,107.21,107.21,0,0,0,26.25-10.88,8,8,0,0,0,3.93-6l2.64-23.72q1.56-1.48,3-3L215.46,186a8,8,0,0,0,6-3.94,107.71,107.71,0,0,0,10.87-26.25,8,8,0,0,0-1.49-7.06Zm-16.1-6.5a73.93,73.93,0,0,1,0,8.68,8,8,0,0,0,1.74,5.48l14.19,17.73a91.57,91.57,0,0,1-6.23,15L187,173.11a8,8,0,0,0-5.1,2.64,74.11,74.11,0,0,1-6.14,6.14,8,8,0,0,0-2.64,5.1l-2.51,22.58a91.32,91.32,0,0,1-15,6.23l-17.74-14.19a8,8,0,0,0-5-1.75h-.48a73.93,73.93,0,0,1-8.68,0,8,8,0,0,0-5.48,1.74L100.45,215.8a91.57,91.57,0,0,1-15-6.23L82.89,187a8,8,0,0,0-2.64-5.1,74.11,74.11,0,0,1-6.14-6.14,8,8,0,0,0-5.1-2.64L46.43,170.6a91.32,91.32,0,0,1-6.23-15l14.19-17.74a8,8,0,0,0,1.74-5.48,73.93,73.93,0,0,1,0-8.68,8,8,0,0,0-1.74-5.48L40.2,100.45a91.57,91.57,0,0,1,6.23-15L69,82.89a8,8,0,0,0,5.1-2.64,74.11,74.11,0,0,1,6.14-6.14A8,8,0,0,0,82.89,69L85.4,46.43a91.32,91.32,0,0,1,15-6.23l17.74,14.19a8,8,0,0,0,5.48,1.74,73.93,73.93,0,0,1,8.68,0,8,8,0,0,0,5.48-1.74L155.55,40.2a91.57,91.57,0,0,1,15,6.23L173.11,69a8,8,0,0,0,2.64,5.1,74.11,74.11,0,0,1,6.14,6.14,8,8,0,0,0,5.1,2.64l22.58,2.51a91.32,91.32,0,0,1,6.23,15l-14.19,17.74A8,8,0,0,0,199.87,123.66Z"></path></svg>
              </button>
              <img className="profile-img" src="/static/Profile.jpg" alt="User profile" />
            </div>
          </header>
          <div className="main-content-inner">
            {activePage === 'dashboard' && (
              <>
                <section className="uploads-section">
                  <h3 className="section-title">Recent Uploads</h3>
                  <div className="uploads-grid">
                    <div className="upload-card">
                      <div className="upload-img-wrap">
                        <img 
                          src="/static/atharva.jpg" 
                          alt="Missing Person - Atharva" 
                          className="upload-img clickable-img"
                          onClick={() => setSelectedImage({ url: '/static/atharva.jpg', name: 'Missing Person - Atharva', type: 'dashboard' })}
                          style={{ cursor: 'pointer' }}
                        />
                      </div>
                      <div className="upload-info">
                        <p className="upload-name">Missing Person - Atharva</p>
                        <p className="upload-case">Case ID: MP2023-001</p>
                      </div>
                    </div>
                    <div className="upload-card">
                      <div className="upload-img-wrap">
                        <img 
                          src="/static/Rushi.jpg" 
                          alt="Criminal - Chirag" 
                          className="upload-img clickable-img"
                          onClick={() => setSelectedImage({ url: '/static/Rushi.jpg', name: 'Criminal - Hrishikesh', type: 'dashboard' })}
                          style={{ cursor: 'pointer' }}
                        />
                      </div>
                      <div className="upload-info">
                        <p className="upload-name">Wanted - Hrishikesh</p>
                        <p className="upload-case">Case ID: CR2023-002</p>
                      </div>
                    </div>
                    <div className="upload-card">
                      <div className="upload-img-wrap">
                        <img 
                          src="/static/swaroop.jpg" 
                          alt="Missing Person - Swaroop" 
                          className="upload-img clickable-img"
                          onClick={() => setSelectedImage({ url: '/static/swaroop.jpg', name: 'Missing Person - Swaroop', type: 'dashboard' })}
                          style={{ cursor: 'pointer' }}
                        />
                      </div>
                      <div className="upload-info">
                        <p className="upload-name">Missing Person - Swaroop</p>
                        <p className="upload-case">Case ID: MP2023-003</p>
                      </div>
                    </div>
                    <div className="upload-card">
                      <div className="upload-img-wrap">
                        <img 
                          src="/static/kutra.jpg" 
                          alt="Criminal - Doggyman" 
                          className="upload-img clickable-img"
                          onClick={() => setSelectedImage({ url: '/static/kutra.jpg', name: 'Criminal - Doggyman', type: 'dashboard' })}
                          style={{ cursor: 'pointer' }}
                        />
                      </div>
                      <div className="upload-info">
                        <p className="upload-name">Criminal - Doggyman</p>
                        <p className="upload-case">Case ID: CR2023-004</p>
                      </div>
                    </div>
                  </div>
                </section>
                <MapSection />

                <section className="alerts-section">
                  <h3 className="section-title">Alerts</h3>
                  <div className="alerts-list">
                    <div className="alert-row">
                      <img 
                        src="/static/atharva.jpg" 
                        alt="Alert - Missing Person - Atharva" 
                        className="alert-img clickable-img"
                        onClick={() => setSelectedImage({ url: '/static/atharva.jpg', name: 'Missing Person - Atharva', type: 'dashboard' })}
                        style={{ cursor: 'pointer' }}
                      />
                      <div className="alert-info">
                        <p className="alert-name">Missing Person - Atharva</p>
                        <p className="alert-desc">Detected at Central Station</p>
                      </div>
                      <div className="alert-meta">
                        <p className="alert-priority high">High Priority</p>
                        <p className="alert-time">2 hours ago</p>
                      </div>
                    </div>
                    <div className="alert-row">
                      <img 
                        src="/static/Rushi.jpg" 
                        alt="Alert - Criminal - Chirag" 
                        className="alert-img clickable-img"
                        onClick={() => setSelectedImage({ url: '/static/Rushi.jpg', name: 'Criminal - Hrishikesh', type: 'dashboard' })}
                        style={{ cursor: 'pointer' }}
                      />
                      <div className="alert-info">
                        <p className="alert-name">Criminal - Hrishikesh</p>
                        <p className="alert-desc">Detected at City Park</p>
                      </div>
                      <div className="alert-meta">
                        <p className="alert-priority high">High Priority</p>
                        <p className="alert-time">3 hours ago</p>
                      </div>
                    </div>
                    <div className="alert-row">
                      <img 
                        src="/static/swaroop.jpg" 
                        alt="Alert - Missing Person - Swaroop" 
                        className="alert-img clickable-img"
                        onClick={() => setSelectedImage({ url: '/static/swaroop.jpg', name: 'Missing Person - Swaroop', type: 'dashboard' })}
                        style={{ cursor: 'pointer' }}
                      />
                      <div className="alert-info">
                        <p className="alert-name">Missing Person - Swaroop</p>
                        <p className="alert-desc">Detected at Shopping Mall</p>
                      </div>
                      <div className="alert-meta">
                        <p className="alert-priority medium">Medium Priority</p>
                        <p className="alert-time">5 hours ago</p>
                      </div>
                    </div>
                  </div>
                </section>
              </>
            )}

            {activePage === 'gallery' && (
              <section className="uploads-section">
                <div className="gallery-folder-tabs">
                  <button 
                    className={`folder-tab ${galleryFolder === 'persons' ? 'active' : ''}`}
                    onClick={() => setGalleryFolder('persons')}
                  >
                    <svg fill="currentColor" height="20" width="20" viewBox="0 0 256 256">
                      <path d="M128,80a48,48,0,1,0,48,48A48.05,48.05,0,0,0,128,80Zm0,80a32,32,0,1,1,32-32A32,32,0,0,1,128,160Zm88-29.84q.06-2.16,0-4.32l14.92-18.64a8,8,0,0,0,1.48-7.06,107.21,107.21,0,0,0-10.88-26.25,8,8,0,0,0-6-3.93l-23.72-2.64q-1.48-1.56-3-3L186,40.54a8,8,0,0,0-3.94-6,107.71,107.71,0,0,0-26.25-10.87,8,8,0,0,0-7.06,1.49L130.16,40Q128,40,125.84,40L107.2,25.11a8,8,0,0,0-7.06-1.48A107.6,107.6,0,0,0,73.89,34.51a8,8,0,0,0-3.93,6L67.32,64.27q-1.56,1.49-3,3L40.54,70a8,8,0,0,0-6,3.94,107.71,107.71,0,0,0-10.87,26.25,8,8,0,0,0,1.49,7.06L40,125.84Q40,128,40,130.16L25.11,148.8a8,8,0,0,0-1.48,7.06,107.21,107.21,0,0,0,10.88,26.25,8,8,0,0,0,6,3.93l23.72,2.64q1.49,1.56,3,3L70,215.46a8,8,0,0,0,3.94,6,107.71,107.71,0,0,0,26.25,10.87,8,8,0,0,0,7.06-1.49L125.84,216q2.16.06,4.32,0l18.64,14.92a8,8,0,0,0,7.06,1.48,107.21,107.21,0,0,0,26.25-10.88,8,8,0,0,0,3.93-6l2.64-23.72q1.56-1.48,3-3L215.46,186a8,8,0,0,0,6-3.94,107.71,107.71,0,0,0,10.87-26.25,8,8,0,0,0-1.49-7.06Zm-16.1-6.5a73.93,73.93,0,0,1,0,8.68,8,8,0,0,0,1.74,5.48l14.19,17.73a91.57,91.57,0,0,1-6.23,15L187,173.11a8,8,0,0,0-5.1,2.64,74.11,74.11,0,0,1-6.14,6.14,8,8,0,0,0-2.64,5.1l-2.51,22.58a91.32,91.32,0,0,1-15,6.23l-17.74-14.19a8,8,0,0,0-5-1.75h-.48a73.93,73.93,0,0,1-8.68,0,8,8,0,0,0-5.48,1.74L100.45,215.8a91.57,91.57,0,0,1-15-6.23L82.89,187a8,8,0,0,0-2.64-5.1,74.11,74.11,0,0,1-6.14-6.14,8,8,0,0,0-5.1-2.64L46.43,170.6a91.32,91.32,0,0,1-6.23-15l14.19-17.74a8,8,0,0,0,1.74-5.48,73.93,73.93,0,0,1,0-8.68,8,8,0,0,0-1.74-5.48L40.2,100.45a91.57,91.57,0,0,1,6.23-15L69,82.89a8,8,0,0,0,5.1-2.64,74.11,74.11,0,0,1,6.14-6.14A8,8,0,0,0,82.89,69L85.4,46.43a91.32,91.32,0,0,1,15-6.23l17.74,14.19a8,8,0,0,0,5.48,1.74,73.93,73.93,0,0,1,8.68,0,8,8,0,0,0,5.48-1.74L155.55,40.2a91.57,91.57,0,0,1,15,6.23L173.11,69a8,8,0,0,0,2.64,5.1,74.11,74.11,0,0,1,6.14,6.14,8,8,0,0,0,5.1,2.64l22.58,2.51a91.32,91.32,0,0,1,6.23,15l-14.19,17.74A8,8,0,0,0,199.87,123.66Z"></path>
                    </svg>
                    Persons
                  </button>
                  <button 
                    className={`folder-tab ${galleryFolder === 'alerts' ? 'active' : ''}`}
                    onClick={() => setGalleryFolder('alerts')}
                  >
                    <svg fill="currentColor" height="20" width="20" viewBox="0 0 256 256">
                      <path d="M221.8,175.94C216.25,166.38,208,139.33,208,104a80,80,0,1,0-160,0c0,35.34-8.26,62.38-13.81,71.94A16,16,0,0,0,48,200H88.81a40,40,0,0,0,78.38,0H208a16,16,0,0,0,13.8-24.06ZM128,216a24,24,0,0,1-22.62-16h45.24A24,24,0,0,1,128,216ZM48,184c7.7-13.24,16-43.92,16-80a64,64,0,1,1,128,0c0,36.05,8.28,66.73,16,80Z"></path>
                    </svg>
                    Alerts
                  </button>
                </div>
                <div className="section-header">
                  <h3 className="section-title">
                    {galleryFolder === 'persons' ? 'Persons' : 'Alerts'}
                  </h3>
                  <button 
                    onClick={() => galleryFolder === 'persons' ? fetchPersonsImages() : fetchAlertsImages()} 
                    className="refresh-btn"
                    disabled={loading}
                  >
                    <svg fill="currentColor" height="20" width="20" viewBox="0 0 256 256">
                      <path d="M240,56a8,8,0,0,1-8,8H195.88A80.12,80.12,0,0,1,128,128a8,8,0,0,1-16,0A96.12,96.12,0,0,0,195.88,48H232A8,8,0,0,1,240,56ZM128,176a8,8,0,0,1,8-8,80.12,80.12,0,0,1,67.88-72H168a8,8,0,0,1,0-16h64a8,8,0,0,1,8,8v64a8,8,0,0,1-16,0V96.12A96.12,96.12,0,0,0,128,176Z"></path>
                    </svg>
                    {loading ? 'Loading...' : 'Refresh'}
                  </button>
                </div>
                {loading ? (
                  <div className="loading-container">
                    <div className="loading-spinner"></div>
                    <p>Loading images...</p>
                  </div>
                ) : (galleryFolder === 'persons' ? personsImages : alertsImages).length > 0 ? (
                  <div className="uploads-grid">
                    {(galleryFolder === 'persons' ? personsImages : alertsImages).map((image, index) => (
                      <div key={index} className="upload-card">
                        <div className="upload-img-wrap">
                          <img 
                            src={image.url} 
                            alt={image.name} 
                            className="upload-img clickable-img"
                            onClick={() => setSelectedImage({ url: image.url, name: image.name, type: 'gallery' })}
                            style={{ cursor: 'pointer' }}
                          />
                        </div>
                        <div className="upload-info">
                          <p className="upload-name">{image.name}</p>
                          <p className="upload-case">{galleryFolder === 'persons' ? 'Persons Folder' : 'Alerts Folder'}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="empty-state">
                    <div className="empty-icon">
                      <svg fill="currentColor" height="64" width="64" viewBox="0 0 256 256">
                        <path d="M216,40H40A16,16,0,0,0,24,56V200a16,16,0,0,0,16,16H216a16,16,0,0,0,16-16V56A16,16,0,0,0,216,40Zm0,16V158.75l-26.07-26.06a16,16,0,0,0-22.63,0l-20,20-44-44a16,16,0,0,0-22.62,0L40,149.37V56ZM40,172l52-52,80,80H40Zm176,28H194.63l-36-36,20-20L216,181.38V200ZM144,100a12,12,0,1,1,12,12A12,12,0,0,1,144,100Z"></path>
                      </svg>
                    </div>
                    <h4>No images found</h4>
                    <p>{galleryFolder === 'persons' ? 'No persons images uploaded yet' : 'No alert images available yet'}</p>
                  </div>
                )}
              </section>
            )}

            {activePage === 'addPerson' && (
              <section className="uploads-section">
                <div className="person-form-container">
                  <h3 className="section-title">Add New Person</h3>
                  <form className="person-form" onSubmit={(e) => { e.preventDefault(); handlePersonUpload(); }}>
                    <div className="form-group">
                      <label htmlFor="person-image">Person Image *</label>
                      <input
                        type="file"
                        id="person-image-upload"
                        accept="image/*"
                        onChange={(e) => setPersonForm({ ...personForm, imageFile: e.target.files[0] })}
                        className="form-input-file"
                        required
                      />
                      {personForm.imageFile && (
                        <div className="image-preview">
                          <img 
                            src={URL.createObjectURL(personForm.imageFile)} 
                            alt="Preview" 
                            className="preview-img"
                          />
                        </div>
                      )}
                    </div>

                    <div className="form-row">
                      <div className="form-group">
                        <label htmlFor="fullName">Full Name *</label>
                        <input
                          type="text"
                          id="fullName"
                          value={personForm.fullName}
                          onChange={(e) => setPersonForm({ ...personForm, fullName: e.target.value })}
                          className="form-input"
                          placeholder="Enter full name"
                          required
                        />
                      </div>

                      <div className="form-group">
                        <label htmlFor="age">Age</label>
                        <input
                          type="number"
                          id="age"
                          value={personForm.age}
                          onChange={(e) => setPersonForm({ ...personForm, age: e.target.value })}
                          className="form-input"
                          placeholder="Enter age"
                          min="0"
                          max="120"
                        />
                      </div>
                    </div>

                    <div className="form-group">
                      <label htmlFor="tag">Category *</label>
                      <select
                        id="tag"
                        value={personForm.tag}
                        onChange={(e) => setPersonForm({ ...personForm, tag: e.target.value })}
                        className="form-input"
                        required
                      >
                        <option value="Missing">Missing Person</option>
                        <option value="Criminal">Criminal</option>
                        <option value="Wanted">Wanted</option>
                        <option value="Other">Other</option>
                      </select>
                    </div>

                    <div className="form-group">
                      <label htmlFor="description">Description</label>
                      <textarea
                        id="description"
                        value={personForm.description}
                        onChange={(e) => setPersonForm({ ...personForm, description: e.target.value })}
                        className="form-textarea"
                        placeholder="Enter description or additional details"
                        rows="4"
                      />
                    </div>

                    <div className="form-group">
                      <label htmlFor="missingDateTime">Missing/Last Seen Date & Time</label>
                      <input
                        type="datetime-local"
                        id="missingDateTime"
                        value={personForm.missingDateTime}
                        onChange={(e) => setPersonForm({ ...personForm, missingDateTime: e.target.value })}
                        className="form-input"
                      />
                    </div>

                    <button 
                      type="submit" 
                      className="form-submit-btn"
                      disabled={personUploading}
                    >
                      {personUploading ? 'Uploading...' : 'Add Person to Database'}
                    </button>
                  </form>
                </div>
              </section>
            )}

            {activePage === 'alerts' && (
              <section className="alerts-section">
                <div className="section-header">
                  <h3 className="section-title">System Alerts</h3>
                  <button 
                    onClick={fetchAlerts} 
                    className="refresh-btn"
                    disabled={alertsLoading}
                  >
                    <svg fill="currentColor" height="20" width="20" viewBox="0 0 256 256">
                      <path d="M240,56a8,8,0,0,1-8,8H195.88A80.12,80.12,0,0,1,128,128a8,8,0,0,1-16,0A96.12,96.12,0,0,0,195.88,48H232A8,8,0,0,1,240,56ZM128,176a8,8,0,0,1,8-8,80.12,80.12,0,0,1,67.88-72H168a8,8,0,0,1,0-16h64a8,8,0,0,1,8,8v64a8,8,0,0,1-16,0V96.12A96.12,96.12,0,0,0,128,176Z"></path>
                    </svg>
                    {alertsLoading ? 'Loading...' : 'Refresh'}
                  </button>
                </div>

                {alertsLoading ? (
                  <div className="loading-container">
                    <div className="loading-spinner"></div>
                    <p>Loading alerts...</p>
                  </div>
                ) : alerts.length === 0 ? (
                  <div className="empty-state">
                    <div className="empty-icon">
                      <svg fill="currentColor" height="64" width="64" viewBox="0 0 256 256">
                        <path d="M221.8,175.94C216.25,166.38,208,139.33,208,104a80,80,0,1,0-160,0c0,35.34-8.26,62.38-13.81,71.94A16,16,0,0,0,48,200H88.81a40,40,0,0,0,78.38,0H208a16,16,0,0,0,13.8-24.06ZM128,216a24,24,0,0,1-22.62-16h45.24A24,24,0,0,1,128,216ZM48,184c7.7-13.24,16-43.92,16-80a64,64,0,1,1,128,0c0,36.05,8.28,66.73,16,80Z"></path>
                      </svg>
                    </div>
                    <h4>No alerts available</h4>
                    <p>Alerts will appear here when persons are detected</p>
                  </div>
                ) : (
                  <div className="alerts-list">
                    {alerts.map((alert, i) => (
                      <div className="alert-row" key={i}>
                        <img 
                          src={alert.img} 
                          alt={`Alert - ${alert.name}`} 
                          className="alert-img"
                        />
                        <div className="alert-info">
                          <p className="alert-name">{alert.name}</p>
                        </div>
                        <div className="alert-meta">
                          <button 
                            className="alert-details-btn"
                            onClick={() => fetchAlertDetails(alert.alertDocId)}
                            disabled={alertDetailsLoading}
                          >
                            Details
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            )}

            {activePage === 'maps' && (
              <section
                ref={mapsPageRef}
                className={`maps-page-section ${isMapsFullscreen ? 'is-fullscreen' : ''}`}
              >
                <div className="maps-page-toolbar">
                  <button className="maps-fullscreen-btn" onClick={toggleMapsFullscreen}>
                    {isMapsFullscreen ? 'Exit Full Screen' : 'Full Screen'}
                  </button>
                </div>
                <MapSection
                  mapContainerStyle={{
                    width: '100%',
                    height: isMapsFullscreen ? 'calc(100vh - 130px)' : 'calc(100vh - 290px)',
                    borderRadius: '12px',
                    overflow: 'hidden',
                  }}
                />
              </section>
            )}
            
          </div>
        </main>
      </div>
      {/* Image Modal */}
      {selectedImage && (
        <div className="image-modal" onClick={() => setSelectedImage(null)}>
          <div className="image-modal-content" onClick={(e) => e.stopPropagation()}>
            <button 
              className="image-modal-close"
              onClick={() => setSelectedImage(null)}
              aria-label="Close image"
            >
              <svg fill="currentColor" height="24" width="24" viewBox="0 0 256 256">
                <path d="M208.49,191.51a12,12,0,0,1-17,17L128,145,64.49,208.49a12,12,0,0,1-17-17L111,128,47.51,64.49a12,12,0,0,1,17-17L128,111l63.51-63.52a12,12,0,0,1,17,17L145,128Z"></path>
              </svg>
            </button>
            <div className="image-modal-header">
              <h3 className="image-modal-title">{selectedImage.name}</h3>
            </div>
            <div className="image-modal-body">
              <img 
                src={selectedImage.url} 
                alt={selectedImage.name}
                className="image-modal-img"
              />
            </div>
            <div className="image-modal-footer">
              <a 
                href={selectedImage.url} 
                target="_blank" 
                rel="noopener noreferrer"
                className="image-modal-download"
              >
                <svg fill="currentColor" height="20" width="20" viewBox="0 0 256 256">
                  <path d="M224,152v56a16,16,0,0,1-16,16H48a16,16,0,0,1-16-16V152a8,8,0,0,1,16,0v56H208V152a8,8,0,0,1,16,0ZM93.66,93.66,120,67.31V152a8,8,0,0,0,16,0V67.31l26.34,26.35a8,8,0,0,0,11.32-11.32l-40-40a8,8,0,0,0-11.32,0l-40,40A8,8,0,0,0,93.66,93.66Z"></path>
                </svg>
                Open in New Tab
              </a>
            </div>
          </div>
        </div>
      )}

      {/* Alert Details Modal */}
      {selectedAlertDetails && (
        <div className="image-modal" onClick={() => setSelectedAlertDetails(null)}>
          <div className="image-modal-content alert-details-modal" onClick={(e) => e.stopPropagation()}>
            <button 
              className="image-modal-close"
              onClick={() => setSelectedAlertDetails(null)}
              aria-label="Close alert details"
            >
              <svg fill="currentColor" height="24" width="24" viewBox="0 0 256 256">
                <path d="M208.49,191.51a12,12,0,0,1-17,17L128,145,64.49,208.49a12,12,0,0,1-17-17L111,128,47.51,64.49a12,12,0,0,1,17-17L128,111l63.51-63.52a12,12,0,0,1,17,17L145,128Z"></path>
              </svg>
            </button>
            <div className="image-modal-header">
              <h3 className="image-modal-title">Alert Details: {selectedAlertDetails.personName || 'Alert'}</h3>
            </div>
            <div className="alert-details-body">
              {alertDetailsLoading ? (
                <div className="loading-container">
                  <div className="loading-spinner"></div>
                  <p>Loading details...</p>
                </div>
              ) : (
                <>
                  {selectedAlertDetails.imageURL && (
                    <div className="alert-details-image">
                      <img 
                        src={selectedAlertDetails.imageURL} 
                        alt="Alert"
                        className="alert-details-img"
                        onClick={() => setSelectedImage({ url: selectedAlertDetails.imageURL, name: selectedAlertDetails.personName || 'Alert', type: 'alert' })}
                        style={{ cursor: 'pointer' }}
                      />
                    </div>
                  )}
                  
                  <div className="alert-details-info">
                    <h4>Alert Information</h4>
                    <div className="details-grid">
                      <div className="detail-item">
                        <span className="detail-label">Alert ID:</span>
                        <span className="detail-value">{selectedAlertDetails.alertID || 'N/A'}</span>
                      </div>
                      <div className="detail-item">
                        <span className="detail-label">Person ID:</span>
                        <span className="detail-value">{selectedAlertDetails.personID || 'N/A'}</span>
                      </div>
                      <div className="detail-item">
                        <span className="detail-label">Alert Time:</span>
                        <span className="detail-value">{selectedAlertDetails.alertTime || 'N/A'}</span>
                      </div>
                      <div className="detail-item">
                        <span className="detail-label">Location:</span>
                        <span className="detail-value">{typeof selectedAlertDetails.location === 'object' && selectedAlertDetails.location !== null ? `${selectedAlertDetails.location.lat}, ${selectedAlertDetails.location.lng}` : selectedAlertDetails.location || 'N/A'}</span>
                      </div>
                    </div>

                    {selectedAlertDetails.personDetails && (
                      <>
                        <h4>Person Information</h4>
                        <div className="details-grid">
                          <div className="detail-item">
                            <span className="detail-label">Full Name:</span>
                            <span className="detail-value">{selectedAlertDetails.personDetails.fullName || 'N/A'}</span>
                          </div>
                          {selectedAlertDetails.personDetails.age && (
                            <div className="detail-item">
                              <span className="detail-label">Age:</span>
                              <span className="detail-value">{selectedAlertDetails.personDetails.age} years</span>
                            </div>
                          )}
                          <div className="detail-item">
                            <span className="detail-label">Category:</span>
                            <span className="detail-value">
                              <span className="alert-tag">{selectedAlertDetails.personDetails.tag || 'Unknown'}</span>
                            </span>
                          </div>
                          {selectedAlertDetails.personDetails.description && (
                            <div className="detail-item full-width">
                              <span className="detail-label">Description:</span>
                              <span className="detail-value">{selectedAlertDetails.personDetails.description}</span>
                            </div>
                          )}
                          {selectedAlertDetails.personDetails.missingDateTime && (
                            <div className="detail-item full-width">
                              <span className="detail-label">Missing/Last Seen:</span>
                              <span className="detail-value">{selectedAlertDetails.personDetails.missingDateTime}</span>
                            </div>
                          )}
                        </div>
                      </>
                    )}
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Alert Popup - Dynamic */}
      {currentAlertPopup && (
        <div className="alert-popup" role="alert">
          <div className="alert-popup-content">
            <div className="alert-popup-icon">
              <svg fill="currentColor" height="32" width="32" viewBox="0 0 256 256"><path d="M236.8,188.09,149.34,36.22a24,24,0,0,0-42.68,0L19.2,188.09a23.89,23.89,0,0,0,21.34,35.91H215.46A23.89,23.89,0,0,0,236.8,188.09ZM222.31,208.3,134.85,56.42a8,8,0,0,0-13.7,0L33.69,208.3a7.85,7.85,0,0,1-7.11-12,7.92,7.92,0,0,1,7.11-3.9H215.46a7.92,7.92,0,0,1,7.11,3.9A7.85,7.85,0,0,1,222.31,208.3ZM120,144a8,8,0,0,1,8-8,8,8,0,0,1,0,16,8,8,0,0,1-8-8Zm8,32a8,8,0,0,1-8-8V112a8,8,0,0,1,16,0v56A8,8,0,0,1,128,176Z"></path></svg>
            </div>
            <div className="alert-popup-info">
              <h4 className="alert-popup-title">High Priority Alert</h4>
              <p className="alert-popup-desc">Person of interest <b>{currentAlertPopup.personName}</b> detected at <b>{currentAlertPopup.locationName ? `${currentAlertPopup.locationName} (${currentAlertPopup.location.lat.toFixed(6)}, ${currentAlertPopup.location.lng.toFixed(6)})` : `${currentAlertPopup.location.lat.toFixed(6)}, ${currentAlertPopup.location.lng.toFixed(6)}`}</b>. Immediate action required.</p>
              <div className="alert-popup-actions">
                <button 
                  className="alert-popup-btn primary"
                  onClick={() => {
                    fetchAlertDetails(currentAlertPopup.alertDocId);
                    setCurrentAlertPopup(null);
                  }}
                >
                  View Details
                </button>
                <button 
                  className="alert-popup-btn secondary"
                  onClick={() => setCurrentAlertPopup(null)}
                >
                  Dismiss
                </button>
              </div>
            </div>
            <button 
              className="alert-popup-close"
              onClick={() => setCurrentAlertPopup(null)}
            >
              <svg fill="currentColor" height="20" width="20" viewBox="0 0 256 256"><path d="M208.49,191.51a12,12,0,0,1-17,17L128,145,64.49,208.49a12,12,0,0,1-17-17L111,128,47.51,64.49a12,12,0,0,1,17-17L128,111l63.51-63.52a12,12,0,0,1,17,17L145,128Z"></path></svg>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
