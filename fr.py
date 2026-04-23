import os
import time
import cv2
import face_recognition
import threading
from gpiozero import Button, Buzzer
from RPLCD.i2c import CharLCD
from picamera2 import Picamera2
import firebase_admin
from firebase_admin import credentials, storage

# ----------------- HARDWARE SETUP -----------------
button = Button(17, pull_up=False)
buzzer = Buzzer(27)
lcd = CharLCD('PCF8574', 0x27)
lcd.clear()

# ----------------- FIREBASE SETUP -----------------
FIREBASE_BUCKET = "face-recognition-d19b052.appspot.com"
cred = credentials.Certificate("serviceAccountKey.json")
firebase_admin.initialize_app(cred, {
    "storageBucket": FIREBASE_BUCKET
})
bucket = storage.bucket()

# ----------------- GLOBAL STATE -----------------
running = False
known_encodings = []
known_names = []
lock = threading.Lock()

LOCAL_FOLDER = os.path.expanduser("~/face_images")
os.makedirs(LOCAL_FOLDER, exist_ok=True)

# ----------------- FIREBASE HELPERS -----------------
def list_firebase_files():
    """List all files from Firebase Storage under /known_faces/"""
    try:
        blobs = bucket.list_blobs(prefix="known_faces/")
        files = [b.name for b in blobs if b.name.lower().endswith((".jpg", ".jpeg", ".png"))]
        return files
    except Exception as e:
        print("❌ Error listing Firebase files:", e)
        return []

def download_from_firebase(file_name):
    """Download image file from Firebase Storage"""
    try:
        blob = bucket.blob(file_name)
        local_path = os.path.join(LOCAL_FOLDER, os.path.basename(file_name))
        blob.download_to_filename(local_path)
        print(f"✅ Downloaded: {file_name}")
    except Exception as e:
        print(f"❌ Failed to download {file_name}: {e}")

def sync_firebase_periodically():
    """Continuously sync new face images from Firebase Storage every 60 seconds"""
    global known_encodings, known_names
    while running:
        try:
            firebase_files = list_firebase_files()
            local_files = os.listdir(LOCAL_FOLDER)

            new_files = [f for f in firebase_files if os.path.basename(f) not in local_files]
            if new_files:
                lcd.clear()
                lcd.write_string("⬇ Syncing faces...")
                print(f"[INFO] Found {len(new_files)} new faces to download")

                threads = []
                for f in new_files:
                    t = threading.Thread(target=download_from_firebase, args=(f,), daemon=True)
                    t.start()
                    threads.append(t)
                for t in threads:
                    t.join()

                # Reload encodings after download
                with lock:
                    known_encodings, known_names = load_known_faces()
                lcd.clear()
                lcd.write_string("✅ Faces updated")
            else:
                print("[INFO] No new Firebase images.")
        except Exception as e:
            print("[WARN] Firebase sync failed:", e)

        time.sleep(60)

# ----------------- FACE LOADING -----------------
def load_known_faces():
    encodings, names = [], []
    for file in os.listdir(LOCAL_FOLDER):
        if file.lower().endswith((".jpg", ".jpeg", ".png")):
            img_path = os.path.join(LOCAL_FOLDER, file)
            try:
                img = face_recognition.load_image_file(img_path)
                enc = face_recognition.face_encodings(img)
                if enc:
                    encodings.append(enc[0])
                    names.append(os.path.splitext(file)[0])
            except Exception as e:
                print(f"⚠ Error loading {file}: {e}")
    print(f"[INFO] Loaded {len(encodings)} faces.")
    return encodings, names

# ----------------- FACE RECOGNITION -----------------
def recognize_faces(picam2):
    global known_encodings, known_names
    lcd.clear()
    lcd.write_string("Scanning faces...")
    fps_target = 20
    frame_delay = 1.0 / fps_target

    last_alert_time = {}
    alert_cooldown = 5  # seconds
    detection_hold_time = 3  # seconds

    while running:
        start_time = time.time()
        frame = picam2.capture_array()
        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        small = cv2.resize(rgb, (0, 0), fx=0.5, fy=0.5)

        face_locations = face_recognition.face_locations(small)
        face_encs = face_recognition.face_encodings(small, face_locations)

        with lock:
            for (top, right, bottom, left), enc in zip(face_locations, face_encs):
                matches = face_recognition.compare_faces(known_encodings, enc, tolerance=0.55)
                name = "Unknown"
                if True in matches:
                    idx = matches.index(True)
                    name = known_names[idx]

                # Scale up coordinates back
                top, right, bottom, left = [v * 2 for v in (top, right, bottom, left)]
                color = (0, 255, 0) if name != "Unknown" else (0, 0, 255)
                cv2.rectangle(frame, (left, top), (right, bottom), color, 2)
                cv2.rectangle(frame, (left, bottom - 25), (right, bottom), color, cv2.FILLED)
                cv2.putText(frame, name, (left + 6, bottom - 6),
                            cv2.FONT_HERSHEY_DUPLEX, 0.7, (255, 255, 255), 1)

                # Alert logic
                if name != "Unknown" and time.time() - last_alert_time.get(name, 0) > alert_cooldown:
                    lcd.clear()
                    lcd.write_string(f"Detected:\n{name[:16]}")
                    print(f"[INFO] Recognized {name}")
                    buzzer.on()
                    time.sleep(1)
                    buzzer.off()
                    last_alert_time[name] = time.time()
                    # Hold frame for 3-4 seconds
                    cv2.imshow("Face Recognition", frame)
                    cv2.waitKey(int(detection_hold_time * 1000))

        cv2.imshow("Face Recognition", frame)
        if cv2.waitKey(1) & 0xFF == ord('q'):
            break

        elapsed = time.time() - start_time
        if elapsed < frame_delay:
            time.sleep(frame_delay - elapsed)

    cv2.destroyAllWindows()
    lcd.clear()
    lcd.write_string("Feed stopped")

# ----------------- MAIN -----------------
def main():
    global running, known_encodings, known_names

    lcd.clear()
    lcd.write_string("System Ready\nPress button")
    print("[INFO] System ready — press button to start/stop")

    picam2 = Picamera2()
    config = picam2.create_video_configuration(main={"size": (960, 540)})
    picam2.configure(config)

    while True:
        button.wait_for_press()
        running = not running

        if running:
            lcd.clear()
            lcd.write_string("Starting camera...")
            print("[INFO] Camera started")
            picam2.start()
            time.sleep(2)

            known_encodings, known_names = load_known_faces()
            sync_thread = threading.Thread(target=sync_firebase_periodically, daemon=True)
            sync_thread.start()

            recognize_faces(picam2)
        else:
            print("[INFO] Stopping camera...")
            picam2.stop()
            lcd.clear()
            lcd.write_string("System Paused\nPress again")

if __name__ == "__main__":
    main()