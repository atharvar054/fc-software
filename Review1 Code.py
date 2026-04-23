import os
import time
import cv2
import face_recognition
import threading
from gpiozero import Buzzer
from RPLCD.i2c import CharLCD
from picamera2 import Picamera2
import firebase_admin
from firebase_admin import credentials, storage
from datetime import datetime

# ================= CONFIG =================
FIREBASE_BUCKET = "face-recognition-d19b052.firebasestorage.app"
FIREBASE_PREFIX = "persons/"
LOCAL_FOLDER = "/home/rushi/face_img"

SYNC_INTERVAL = 20
FACE_TOLERANCE = 0.60
LOCATION_TEXT = "Chembur VESIT"

TARGET_FPS = 20
FRAME_DELAY = 1 / TARGET_FPS

# ================= HARDWARE =================
buzzer = Buzzer(17)
lcd = CharLCD('PCF8574', 0x27)
lcd.clear()

# ================= LCD HELPER =================
lcd_lock = threading.Lock()

def lcd_show(line1="", line2="", delay=0):
    with lcd_lock:
        lcd.clear()
        lcd.cursor_pos = (0, 0)
        lcd.write_string(line1[:16])
        lcd.cursor_pos = (1, 0)
        lcd.write_string(line2[:16])
    if delay > 0:
        time.sleep(delay)

# ================= FIREBASE INIT =================
cred = credentials.Certificate("serviceAccountKey.json")

if not firebase_admin._apps:
    firebase_admin.initialize_app(cred, {
        "storageBucket": FIREBASE_BUCKET
    })

bucket = storage.bucket()

# ================= GLOBAL =================
running = True
pause_recognition = threading.Event()
lock = threading.Lock()
night_mode = False

known_encodings = []
known_names = []

os.makedirs(LOCAL_FOLDER, exist_ok=True)

# =================================================
# FIREBASE FUNCTIONS
# =================================================

def list_firebase_images():
    blobs = list(bucket.list_blobs(prefix=FIREBASE_PREFIX))
    return [blob.name for blob in blobs
            if blob.name.lower().endswith((".jpg", ".jpeg", ".png"))]


def download_file(blob_name):
    local_path = os.path.join(LOCAL_FOLDER,
                              os.path.basename(blob_name))
    bucket.blob(blob_name).download_to_filename(local_path)


def full_sync_from_firebase():
    pause_recognition.set()
    lcd_show("Syncing Faces", "")

    firebase_files = list_firebase_images()

    if not firebase_files:
        lcd_show("No Faces Found", "", 2)
        pause_recognition.clear()
        lcd_show("Scanning", "")
        return

    total = len(firebase_files)

    for i, file in enumerate(firebase_files):
        download_file(file)

        progress = int(((i + 1) / total) * 10)
        bar = "[" + "#" * progress + " " * (10 - progress) + "]"
        lcd_show("Syncing Faces", bar)

    reload_encodings()

    lcd_show("Sync Complete", "", 2)
    lcd_show("Scanning", "")
    pause_recognition.clear()


def periodic_sync():
    while running:
        time.sleep(SYNC_INTERVAL)

        lcd_show("Checking New", "Image...")

        firebase_files = list_firebase_images()
        local_files = os.listdir(LOCAL_FOLDER)

        new_files = [
            f for f in firebase_files
            if os.path.basename(f) not in local_files
        ]

        if new_files:
            lcd_show("New Img Found", "", 2)
            full_sync_from_firebase()
        else:
            lcd_show("No New Images", "", 1)
            lcd_show("Scanning", "")

# =================================================
# UPLOAD ALERT
# =================================================

def upload_alert_frame(frame, person_name):
    try:
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        filename = f"{person_name}_{timestamp}.jpg"
        temp_path = f"/tmp/{filename}"

        cv2.imwrite(temp_path, frame)

        blob_path = f"Alerts/{filename}"
        bucket.blob(blob_path).upload_from_filename(temp_path)

        os.remove(temp_path)

        print("[ALERT UPLOADED]", blob_path)

    except Exception as e:
        print("[UPLOAD ERROR]", e)

# =================================================
# LOAD FACES
# =================================================

def reload_encodings():
    global known_encodings, known_names

    encodings = []
    names = []

    for file in os.listdir(LOCAL_FOLDER):
        if file.lower().endswith((".jpg", ".jpeg", ".png")):
            path = os.path.join(LOCAL_FOLDER, file)
            image = face_recognition.load_image_file(path)
            enc = face_recognition.face_encodings(image)

            if enc:
                encodings.append(enc[0])
                names.append(os.path.splitext(file)[0])

    with lock:
        known_encodings = encodings
        known_names = names

    print(f"[INFO] Loaded {len(encodings)} face(s).")

# =================================================
# FACE RECOGNITION (15 FPS Optimized)
# =================================================

def recognize_faces(picam2):
    global running, night_mode

    last_alert_time = {}
    alert_cooldown = 10

    while running:

        frame_start = time.time()

        if pause_recognition.is_set():
            time.sleep(0.1)
            continue

        frame = picam2.capture_array()

        if night_mode:
            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            frame = cv2.cvtColor(gray, cv2.COLOR_GRAY2BGR)
            frame = cv2.convertScaleAbs(frame, alpha=2.0, beta=30)

        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)

        # Smaller resize for faster FPS
        small = cv2.resize(rgb, (0, 0), fx=0.4, fy=0.4)

        face_locations = face_recognition.face_locations(small)
        face_encs = face_recognition.face_encodings(small, face_locations)

        current_time_text = datetime.now().strftime("%d-%m-%Y %H:%M:%S")

        with lock:
            for (top, right, bottom, left), enc in zip(
                    face_locations, face_encs):

                matches = face_recognition.compare_faces(
                    known_encodings, enc, tolerance=FACE_TOLERANCE)

                name = "Unknown"
                if True in matches:
                    idx = matches.index(True)
                    name = known_names[idx]

                top, right, bottom, left = [
                    int(v / 0.4) for v in (top, right, bottom, left)]

                color = (0, 255, 0) if name != "Unknown" else (0, 0, 255)

                cv2.rectangle(frame,
                              (left, top),
                              (right, bottom),
                              color, 2)

                cv2.putText(frame, name,
                            (left, bottom - 10),
                            cv2.FONT_HERSHEY_SIMPLEX,
                            0.7, color, 2)

                if name != "Unknown" and \
                   time.time() - last_alert_time.get(name, 0) > alert_cooldown:

                    overlay = frame.copy()

                    cv2.putText(overlay,
                                f"Location: {LOCATION_TEXT}",
                                (10, overlay.shape[0] - 40),
                                cv2.FONT_HERSHEY_SIMPLEX,
                                0.6, (0, 255, 255), 2)

                    cv2.putText(overlay,
                                current_time_text,
                                (10, overlay.shape[0] - 10),
                                cv2.FONT_HERSHEY_SIMPLEX,
                                0.6, (0, 255, 255), 2)

                    upload_alert_frame(overlay, name)

                    lcd_show("Detected:", name[:16], 2)
                    lcd_show("Scanning", "")

                    buzzer.on()
                    time.sleep(0.5)
                    buzzer.off()

                    last_alert_time[name] = time.time()

        # Overlay info
        cv2.putText(frame,
                    f"Location: {LOCATION_TEXT}",
                    (10, frame.shape[0] - 40),
                    cv2.FONT_HERSHEY_SIMPLEX,
                    0.6, (255, 255, 0), 2)

        cv2.putText(frame,
                    current_time_text,
                    (10, frame.shape[0] - 10),
                    cv2.FONT_HERSHEY_SIMPLEX,
                    0.6, (255, 255, 0), 2)

        mode_text = "NIGHT MODE" if night_mode else "DAY MODE"
        cv2.putText(frame,
                    mode_text,
                    (10, 30),
                    cv2.FONT_HERSHEY_SIMPLEX,
                    0.7, (0, 255, 255), 2)

        cv2.imshow("Face Recognition", frame)

        key = cv2.waitKey(1) & 0xFF
        if key == ord('n'):
            night_mode = True
        elif key == ord('d'):
            night_mode = False
        elif key == ord('q'):
            running = False
            break

        # -------- FPS CONTROL --------
        elapsed = time.time() - frame_start
        if elapsed < FRAME_DELAY:
            time.sleep(FRAME_DELAY - elapsed)

    cv2.destroyAllWindows()

# =================================================
# MAIN
# =================================================

def main():
    global running

    lcd_show("System Starting", "")

    picam2 = Picamera2()
    config = picam2.create_video_configuration(
        main={"size": (960, 540)})
    picam2.configure(config)
    picam2.start()

    time.sleep(2)

    full_sync_from_firebase()

    sync_thread = threading.Thread(
        target=periodic_sync,
        daemon=True)
    sync_thread.start()

    lcd_show("Scanning", "")

    recognize_faces(picam2)

    picam2.stop()
    lcd_show("System Stopped", "")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        running = False
        lcd_show("Shutting Down", "", 1)
        lcd.clear()