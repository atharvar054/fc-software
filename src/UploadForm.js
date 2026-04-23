import React, { useState } from 'react';
import { ref, uploadBytes, getDownloadURL } from "firebase/storage";
import { collection, addDoc, serverTimestamp } from "firebase/firestore";
import { storage, db } from './firebaseConfig';

const UploadForm = () => {
  const [name, setName] = useState('');
  const [image, setImage] = useState(null);

  const handleUpload = async () => {
    if (!name || !image) return alert("Fill all fields!");
    try {
      console.log('Starting upload:', { name, image });
      const storageRef = ref(storage, `faces/${image.name}`);
      await uploadBytes(storageRef, image);
      console.log('File uploaded to storage');
      const imageUrl = await getDownloadURL(storageRef);
      console.log('Download URL:', imageUrl);

      await addDoc(collection(db, "persons"), {
        name,
        imageUrl,
        timestamp: serverTimestamp()
      });
      console.log('Document added to Firestore');

      alert("Uploaded!");
      setName('');
      setImage(null);
    } catch (error) {
      console.error('Upload failed:', error);
      alert("Upload failed: " + error.message);
    }
  };

  return (
    <div>
      <input type="text" value={name} placeholder="Person's Name" onChange={(e) => setName(e.target.value)} />
      <input type="file" onChange={(e) => setImage(e.target.files[0])} />
      <button onClick={handleUpload}>Upload</button>
    </div>
  );
};

export default UploadForm;
