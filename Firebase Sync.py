import firebase_admin
from firebase_admin import credentials, storage

print("Loading credentials...")
cred = credentials.Certificate("serviceAccountKey.json")

firebase_admin.initialize_app(cred, {
    "storageBucket": "face-recognition-d19b052.firebasestorage.app"
})

print("Connecting to bucket...")
bucket = storage.bucket()

print("Listing blobs...")
blobs = bucket.list_blobs()

for blob in blobs:
    print(blob.name)

print("DONE")