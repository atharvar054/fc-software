# improved_face_recognition_multithread.py
import os
import time
import threading
import queue
import cv2
import face_recognition
from gpiozero import Button, Buzzer
from RPLCD.i2c import CharLCD
import firebase_admin
from firebase_admin import credentials, storage

# ----------------- CONFIG / TUNABLES -----------------
CAM_INDEX = 0
CAPTURE_WIDTH = 640
CAPTURE_HEIGHT = 480
FRAME_QUEUE_MAXSIZE = 1            # keep only the latest frame
RECOGNITION_FPS = 4               # how often recognition runs (frames/sec)
SYNC_INTERVAL = 30                # firebase polling seconds
ALERT_COOLDOWN = 5                # seconds between same-name alerts
IMAGE_FOLDER = os.path.expanduser("~/face_images")
FIREBASE_BUCKET = "face-recognition-d19b052.firebasestorage.app"
SERVICE_ACCOUNT_PATH = "serviceAccountKey.json"
RESIZE_FACTOR = 0.4               # for faster face recognition (smaller image)

# ----------------- HARDWARE SETUP -----------------
button = Button(17, pull_up=False)
buzzer = Buzzer(27)
lcd = CharLCD('PCF8574', 0x27)
lcd.clear()

# ----------------- FIREBASE INIT -----------------
cred = credentials.Certificate(SERVICE_ACCOUNT_PATH)
firebase_admin.initialize_app(cred, {"storageBucket": FIREBASE_BUCKET})
bucket = storage.bucket()

# ----------------- SHARED STATE -----------------
os.makedirs(IMAGE_FOLDER, exist_ok=True)
frame_queue = queue.Queue(maxsize=FRAME_QUEUE_MAXSIZE)  # latest frame only
lcd_queue = queue.Queue(maxsize=10)                     # messages for LCD
running_event = threading.Event()                       # set => system running
stop_event = threading.Event()                          # global stop
known_encodings = []    # guarded by known_lock
known_names = []
known_lock = threading.Lock()
last_alert_time = {}    # name -> timestamp (guarded by known_lock or local)
file_index_lock = threading.Lock()
downloaded_files_set = set()  # track local filenames we've indexed

# ----------------- HELPERS -----------------
def lcd_worker():
    """Consume lcd_queue and update LCD (single writer)."""
    while not stop_event.is_set():
        try:
            msg = lcd_queue.get(timeout=0.5)
        except queue.Empty:
            continue
        try:
            lcd.clear()
            # ensure message fits into 2 lines x 16 chars (adjust if you have larger LCD)
            lcd.write_string(msg[:32])
        except Exception as e:
            print("[LCD] update failed:", e)

def post_lcd(msg):
    try:
        lcd_queue.put_nowait(msg)
    except queue.Full:
        # drop if LCD busy
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
    """Downloads blob to local IMAGE_FOLDER. Returns local filename or None."""
    try:
        blob = bucket.blob(blob_name)
        local_name = os.path.basename(blob_name)
        local_path = os.path.join(IMAGE_FOLDER, local_name)
        if not os.path.exists(local_path):
            print(f"[FIREBASE] downloading: {blob_name}")
            blob.download_to_filename(local_path)
            return local_name
    except Exception as e:
        print(f"[FIREBASE] download failed {blob_name}: {e}")
    return None

# ----------------- FACE LOADING / INDEXING -----------------
def compute_encoding_for_file(local_name):
    path = os.path.join(IMAGE_FOLDER, local_name)
    try:
        img = face_recognition.load_image_file(path)
        encs = face_recognition.face_encodings(img, model="small")  # faster
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
    """Downloads new firebase images and computes encodings for just new images."""
    global downloaded_files_set
    while not stop_event.is_set():
        if running_event.is_set():
            try:
                remote_files = list_firebase_files()
                # determine new remote files that we don't have locally
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

# ----------------- CAMERA CAPTURE THREAD -----------------
def camera_capture_loop():
    """Continuously capture frames and drop old frames (put latest into frame_queue)."""
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
        # keep only the latest frame in queue (drop older)
        try:
            if frame_queue.full():
                try:
                    frame_queue.get_nowait()
                except queue.Empty:
                    pass
            frame_queue.put_nowait(frame)
        except Exception as e:
            print("[CAM] frame queue error:", e)
    cap.release()
    print("[CAM] capture stopped")

# ----------------- RECOGNITION THREAD -----------------
def recognition_loop():
    """Runs recognition on the latest frame at a limited rate."""
    global last_alert_time
    last_alert_time = {}
    delay = 1.0 / max(1, RECOGNITION_FPS)
    while not stop_event.is_set():
        if not running_event.is_set():
            time.sleep(0.1)
            continue
        try:
            frame = frame_queue.get(timeout=1.0)
        except queue.Empty:
            continue

        # Work on a copy and resized image for speed
        small = cv2.resize(frame, (0, 0), fx=RESIZE_FACTOR, fy=RESIZE_FACTOR)
        rgb_small = cv2.cvtColor(small, cv2.COLOR_BGR2RGB)
        face_locations = face_recognition.face_locations(rgb_small)
        face_encs = face_recognition.face_encodings(rgb_small, face_locations, model="small")

        with known_lock:
            encs_snapshot = list(known_encodings)
            names_snapshot = list(known_names)

        for (top, right, bottom, left), enc in zip(face_locations, face_encs):
            matches = face_recognition.compare_faces(encs_snapshot, enc, tolerance=0.5)
            name = "Unknown"
            if True in matches:
                idx = matches.index(True)
                name = names_snapshot[idx]

            # Alert logic with cooldown
            now = time.time()
            if name != "Unknown" and now - last_alert_time.get(name, 0) > ALERT_COOLDOWN:
                # UI updates via queues
                short_name = name[:16]
                post_lcd(f"Detected:\n{short_name}")
                try:
                    buzzer.on()
                    time.sleep(0.6)
                    buzzer.off()
                except Exception as e:
                    print("[BUZZER] failed:", e)
                last_alert_time[name] = now

        # throttle recognition loop
        time.sleep(delay)

# ----------------- DISPLAY (main thread) -----------------
def display_loop():
    """Runs in main thread: shows the latest frame and overlays names from last recognition pass."""
    window_name = "Face Recognition (press q to quit)"
    cv2.namedWindow(window_name, cv2.WINDOW_NORMAL)
    # We'll display raw frames with no heavy drawing from recognition thread to keep it simple.
    # If you want rectangles, the recognition thread can push results (coords + name) to a shared variable.
    while not stop_event.is_set():
        if not running_event.is_set():
            # show a placeholder or sleep while paused
            blank = 255 * (np.ones((240, 320, 3), dtype=np.uint8))
            cv2.putText(blank, "Paused - press button", (10, 120), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 0, 0), 2)
            cv2.imshow(window_name, blank)
            if cv2.waitKey(100) & 0xFF == ord('q'):
                stop_event.set()
                break
            continue

        try:
            frame = frame_queue.get(timeout=1.0)
        except queue.Empty:
            # no frame yet
            if cv2.waitKey(1) & 0xFF == ord('q'):
                stop_event.set()
                break
            continue

        # show the frame (recognition draws are not applied here to keep display smooth)
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
        initial_load_known_faces()  # ensure we have known faces when starting
        running_event.set()
        post_lcd("System Ready\nCamera ON")

# gpiozero callback
button.when_pressed = toggle_running

# ----------------- MAIN STARTUP -----------------
import numpy as np  # used by display placeholder

def main():
    # start helper threads
    threading.Thread(target=lcd_worker, daemon=True).start()
    threading.Thread(target=camera_capture_loop, daemon=True).start()
    threading.Thread(target=recognition_loop, daemon=True).start()
    threading.Thread(target=firebase_sync_loop, daemon=True).start()

    # initial message
    post_lcd("System Ready\nPress button")
    print("[INFO] System ready — press button to start/stop")

    try:
        # display loop must run in main thread (cv2 GUI)
        display_loop()
    except KeyboardInterrupt:
        stop_event.set()

    # graceful shutdown
    stop_event.set()
    running_event.clear()
    time.sleep(0.5)  # let threads notice stop_event
    print("[INFO] Exiting...")

if __name__ == "__main__":
    main()
