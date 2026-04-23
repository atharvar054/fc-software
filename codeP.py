# improved_face_recognition_full.py
import os
import time
import threading
import queue
import cv2
import numpy as np
import face_recognition
from gpiozero import Button, Buzzer
from RPLCD.i2c import CharLCD
import firebase_admin
from firebase_admin import credentials, storage

# ----------------- CONFIG / TUNABLES -----------------
CAM_INDEX = 0
CAPTURE_WIDTH = 1280        # increase capture res for better range
CAPTURE_HEIGHT = 720
FRAME_QUEUE_MAXSIZE = 1     # keep only latest frame
RECOGNITION_FPS = 4        # how often recognition runs (frames/sec)
SYNC_INTERVAL = 30         # firebase polling seconds
ALERT_COOLDOWN = 8         # seconds between same-name alerts
IMAGE_FOLDER = os.path.expanduser("~/face_images")
FIREBASE_BUCKET = "face-recognition-d19b052.firebasestorage.app"
SERVICE_ACCOUNT_PATH = "serviceAccountKey.json"
RESIZE_FACTOR = 0.5
USE_CNN = False
DETECTION_TOLERANCE = 0.45

ALERT_FOLDER = "Alerts/"
LOCATION_NAME = "Station-A"

# ----------------- HARDWARE SETUP -----------------
button = Button(17, pull_up=False)
buzzer = Buzzer(27)
lcd = CharLCD('PCF8574', 0x27)
lcd.clear()

# ----------------- FIREBASE INIT -----------------
if not os.path.exists(SERVICE_ACCOUNT_PATH):
    print("[FIREBASE] Warning: service account file not found:", SERVICE_ACCOUNT_PATH)
else:
    cred = credentials.Certificate(SERVICE_ACCOUNT_PATH)
    firebase_admin.initialize_app(cred, {"storageBucket": FIREBASE_BUCKET})
    bucket = storage.bucket()

# ----------------- SHARED STATE -----------------
os.makedirs(IMAGE_FOLDER, exist_ok=True)
frame_queue = queue.Queue(maxsize=FRAME_QUEUE_MAXSIZE)
detection_queue = queue.Queue(maxsize=1)
lcd_queue = queue.Queue(maxsize=10)
running_event = threading.Event()
stop_event = threading.Event()

known_encodings = []
known_names = []
known_lock = threading.Lock()
last_alert_time = {}
file_index_lock = threading.Lock()
downloaded_files_set = set()

# ----------------- HELPERS -----------------
def lcd_worker():
    while not stop_event.is_set():
        try:
            msg = lcd_queue.get(timeout=0.5)
        except queue.Empty:
            continue
        try:
            lcd.clear()
            lcd.write_string(msg[:32])
        except Exception as e:
            print("[LCD] update failed:", e)

def post_lcd(msg):
    try:
        lcd_queue.put_nowait(msg)
    except queue.Full:
        pass

# ----------------- FIREBASE HELPERS -----------------
def list_firebase_files():
    try:
        blobs = bucket.list_blobs(prefix="Demo/")
        return [b.name for b in blobs if b.name.lower().endswith((".jpg", ".jpeg", ".png"))]
    except Exception as e:
        print("❌ Error listing Firebase files:", e)
        return []

def download_blob(blob_name):
    try:
        blob = bucket.blob(blob_name)
        local_name = os.path.basename(blob_name)
        local_path = os.path.join(IMAGE_FOLDER, local_name)
        if not os.path.exists(local_path):
            print(f"[FIREBASE] downloading: {blob_name}")
            blob.download_to_filename(local_path)
            return local_name
        else:
            return None
    except Exception as e:
        print(f"[FIREBASE] download failed {blob_name}: {e}")
    return None

def send_firebase_alert(frame, person_name):
    """Upload a compressed full-frame image with bounding box + name."""
    if 'bucket' not in globals():
        print("[ALERT] Firebase not initialized; skipping upload")
        return
    try:
        ts = time.strftime("%Y%m%d-%H%M%S")
        safe_name = "".join(c for c in person_name if c.isalnum() or c in (" ", "-", "_")).strip().replace(" ", "_") or "person"
        filename = f"{safe_name}_{ts}.jpg"
        temp_path = f"/tmp/{filename}"

        # ---------------------- DRAW BOX ON FULL FRAME ----------------------
        # frame already contains drawn boxes in detection_queue → but
        # to be safe, we draw again here using detection data.
        # If multiple faces exist, we draw only the detected person’s box.

        # Attempt to find that face again at reduced size
        small = cv2.resize(frame, (0, 0), fx=RESIZE_FACTOR, fy=RESIZE_FACTOR)
        rgb_small = cv2.cvtColor(small, cv2.COLOR_BGR2RGB)
        face_locations = face_recognition.face_locations(rgb_small, model="hog")
        face_encs = face_recognition.face_encodings(rgb_small, face_locations)

        best_box = None
        for (top, right, bottom, left), enc in zip(face_locations, face_encs):
            with known_lock:
                distances = face_recognition.face_distance(known_encodings, enc)
            idx = int(np.argmin(distances)) if len(distances) else None

            if idx is not None and known_names[idx] == person_name:
                # scale box back up
                top_f = int(top / RESIZE_FACTOR)
                right_f = int(right / RESIZE_FACTOR)
                bottom_f = int(bottom / RESIZE_FACTOR)
                left_f = int(left / RESIZE_FACTOR)
                best_box = (left_f, top_f, right_f, bottom_f)
                break

        # Draw if found
        drawn = frame.copy()
        if best_box:
            left_f, top_f, right_f, bottom_f = best_box
            cv2.rectangle(drawn, (left_f, top_f), (right_f, bottom_f), (0, 255, 0), 2)
            label = person_name
            cv2.rectangle(drawn, (left_f, bottom_f - 25), (right_f, bottom_f), (0, 255, 0), cv2.FILLED)
            cv2.putText(drawn, label, (left_f + 4, bottom_f - 5),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 0, 0), 2)

        # ---------------------- COMPRESS IMAGE ----------------------
        # Reduce size using JPEG compression (quality 40)
        encode_param = [int(cv2.IMWRITE_JPEG_QUALITY), 40]
        cv2.imwrite(temp_path, drawn, encode_param)

        # ---------------------- UPLOAD TO FIREBASE ----------------------
        blob = bucket.blob(ALERT_FOLDER + filename)
        blob.upload_from_filename(temp_path)
        try:
            blob.make_public()
            public_url = blob.public_url
        except Exception:
            public_url = None

        meta_blob = bucket.blob(ALERT_FOLDER + filename + ".txt")
        meta_blob.upload_from_string(
            f"Name: {person_name}\n"
            f"Time: {ts}\n"
            f"Location: {LOCATION_NAME}\n"
            f"ImageURL: {public_url or 'private'}"
        )

        print(f"[ALERT] Uploaded compressed full-frame alert for {person_name} ({filename})")

    except Exception as e:
        print("[ALERT] Error sending alert:", e)


# ----------------- LOAD FACE ENCODINGS -----------------
def compute_encoding_for_file(local_name):
    path = os.path.join(IMAGE_FOLDER, local_name)
    try:
        img = face_recognition.load_image_file(path)
        encs = face_recognition.face_encodings(img, model="small")
        if encs:
            return encs[0]
    except Exception as e:
        print(f"[LOAD] error encoding {local_name}: {e}")
    return None

def initial_load_known_faces():
    global known_encodings, known_names, downloaded_files_set
    encs, names = [], []
    files = [f for f in os.listdir(IMAGE_FOLDER) if f.lower().endswith((".jpg", ".jpeg", ".png"))]
    for f in files:
        enc = compute_encoding_for_file(f)
        if enc is not None:
            encs.append(enc)
            names.append(os.path.splitext(f)[0])
            downloaded_files_set.add(f)
    with known_lock:
        known_encodings = encs
        known_names = names
    print(f"[INFO] Initial loaded {len(encs)} faces.")
    post_lcd(f"Loaded {len(encs)} faces")

# ----------------- FIREBASE SYNC THREAD -----------------
def firebase_sync_loop():
    global downloaded_files_set
    while not stop_event.is_set():
        if running_event.is_set():
            try:
                remote_files = list_firebase_files()
                to_download = []
                with file_index_lock:
                    for rf in remote_files:
                        ln = os.path.basename(rf)
                        if ln not in downloaded_files_set and ln.lower().endswith((".jpg", ".jpeg", ".png")):
                            to_download.append(rf)
                if to_download:
                    post_lcd("⬇ Syncing faces...")
                    print(f"[FIREBASE] {len(to_download)} new files found.")
                    for rf in to_download:
                        local_name = download_blob(rf)
                        if local_name:
                            enc = compute_encoding_for_file(local_name)
                            if enc is not None:
                                with known_lock:
                                    known_encodings.append(enc)
                                    known_names.append(os.path.splitext(local_name)[0])
                                with file_index_lock:
                                    downloaded_files_set.add(local_name)
                                print(f"[FIREBASE] indexed {local_name}")
                    post_lcd("✅ Faces updated")
                else:
                    print("[FIREBASE] No new images.")
            except Exception as e:
                print("[FIREBASE] sync error:", e)
        time.sleep(SYNC_INTERVAL)

# ----------------- CAMERA CAPTURE -----------------
def camera_capture_loop():
    cap = cv2.VideoCapture(CAM_INDEX)
    cap.set(cv2.CAP_PROP_FRAME_WIDTH, CAPTURE_WIDTH)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, CAPTURE_HEIGHT)
    if not cap.isOpened():
        print("[CAM] cannot open camera")
        return
    print("[CAM] capture started")
    while not stop_event.is_set():
        if not running_event.is_set():
            time.sleep(0.1)
            continue
        ret, frame = cap.read()
        if not ret:
            print("[CAM] read failed, retrying...")
            time.sleep(0.1)
            continue
        try:
            if frame_queue.full():
                frame_queue.get_nowait()
            frame_queue.put_nowait(frame)
        except:
            pass
    cap.release()

# ----------------- RECOGNITION THREAD -----------------
def recognition_loop():
    global last_alert_time
    last_alert_time = {}
    delay = 1.0 / max(1, RECOGNITION_FPS)
    model_name = "cnn" if USE_CNN else "hog"

    while not stop_event.is_set():
        if not running_event.is_set():
            time.sleep(0.1)
            continue
        try:
            frame = frame_queue.get(timeout=1.0)
        except queue.Empty:
            continue

        small = cv2.resize(frame, (0, 0), fx=RESIZE_FACTOR, fy=RESIZE_FACTOR)
        rgb_small = cv2.cvtColor(small, cv2.COLOR_BGR2RGB)
        try:
            face_locations = face_recognition.face_locations(rgb_small, model=model_name)
            face_encs = face_recognition.face_encodings(rgb_small, face_locations, model="small")
        except:
            time.sleep(delay)
            continue

        with known_lock:
            encs_snapshot = list(known_encodings)
            names_snapshot = list(known_names)

        detection_results = []
        annotated_frame = frame.copy()

        for (top, right, bottom, left), enc in zip(face_locations, face_encs):
            name = "Unknown"
            if encs_snapshot:
                distances = face_recognition.face_distance(encs_snapshot, enc)
                best_idx = int(np.argmin(distances))
                if distances[best_idx] < DETECTION_TOLERANCE:
                    name = names_snapshot[best_idx]

            top_f = int(top / RESIZE_FACTOR)
            right_f = int(right / RESIZE_FACTOR)
            bottom_f = int(bottom / RESIZE_FACTOR)
            left_f = int(left / RESIZE_FACTOR)
            detection_results.append((top_f, right_f, bottom_f, left_f, name))

            # Draw green box + name ON THE FULL FRAME
            cv2.rectangle(annotated_frame, (left_f, top_f), (right_f, bottom_f), (0,255,0), 2)
            cv2.putText(annotated_frame, name, (left_f, top_f - 10),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0,255,0), 2)

            now = time.time()
            if name != "Unknown" and now - last_alert_time.get(name, 0) > ALERT_COOLDOWN:
                last_alert_time[name] = now

                post_lcd(f"Detected:\n{name[:16]}")
                try:
                    buzzer.on()
                    time.sleep(0.35)
                    buzzer.off()
                except:
                    pass

                # --------------- 🔄 MODIFIED: Upload full frame instead of cropped ---------------
                threading.Thread(
                    target=send_firebase_alert,
                    args=(annotated_frame.copy(), name),
                    daemon=True
                ).start()
                # --------------------------------------------------------------------------------

        try:
            if detection_queue.full():
                detection_queue.get_nowait()
            detection_queue.put_nowait(detection_results)
        except:
            pass

        time.sleep(delay)

# ----------------- DISPLAY LOOP -----------------
def display_loop():
    window_name = "Face Recognition (press q)"
    cv2.namedWindow(window_name, cv2.WINDOW_NORMAL)
    cv2.resizeWindow(window_name, 800, 450)

    while not stop_event.is_set():
        if not running_event.is_set():
            blank = 255 * np.ones((360, 640, 3), dtype=np.uint8)
            cv2.putText(blank, "Paused - press button", (10, 180),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0,0,0), 2)
            cv2.imshow(window_name, blank)
            if cv2.waitKey(100) & 0xFF == ord('q'):
                stop_event.set()
                break
            continue

        try:
            frame = frame_queue.get(timeout=1.0)
        except queue.Empty:
            if cv2.waitKey(1) & 0xFF == ord('q'):
                stop_event.set()
                break
            continue

        try:
            boxes = detection_queue.get_nowait()
        except queue.Empty:
            boxes = []

        for (top, right, bottom, left, name) in boxes:
            cv2.rectangle(frame, (left, top), (right, bottom), (0,255,0), 2)
            cv2.putText(frame, name, (left, top - 10),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0,255,0), 2)

        cv2.imshow(window_name, frame)
        if cv2.waitKey(1) & 0xFF == ord('q'):
            stop_event.set()
            break

    cv2.destroyAllWindows()

# ----------------- BUTTON HANDLING -----------------
def toggle_running():
    if running_event.is_set():
        print("[BUTTON] Stopping system")
        running_event.clear()
        post_lcd("System Paused\nPress again")
    else:
        print("[BUTTON] Starting system")
        initial_load_known_faces()
        running_event.set()
        post_lcd("System Ready\nCamera ON")

button.when_pressed = toggle_running

# ----------------- MAIN -----------------
def main():
    threading.Thread(target=lcd_worker, daemon=True).start()
    threading.Thread(target=camera_capture_loop, daemon=True).start()
    threading.Thread(target=recognition_loop, daemon=True).start()
    threading.Thread(target=firebase_sync_loop, daemon=True).start()

    post_lcd("System Ready\nPress button")
    print("[INFO] System ready — press button to start/stop")

    try:
        display_loop()
    except KeyboardInterrupt:
        stop_event.set()

    stop_event.set()
    running_event.clear()
    time.sleep(0.5)
    print("[INFO] Exiting...")

if __name__ == "__main__":
    main()
