
import os
import time
import json
import getpass
import logging
from pathlib import Path

import cv2
import numpy as np
import requests
from insightface.app import FaceAnalysis

# ---------------------------------------
# CONFIGURATION
# ---------------------------------------

BASE_URL = "https://smart-room-exsy.onrender.com"

AGENT_KEY = getpass.getpass("Enter your LAPTOP_AGENT_KEY: ")

POLL_INTERVAL = 5
MATCH_THRESHOLD = 0.40

BASE_DIR = Path(__file__).parent
FACES_DIR = BASE_DIR / "known_faces"
ATTEMPTS_DIR = BASE_DIR / "attempts"
MANIFEST_FILE = BASE_DIR / "manifest.json"
LOG_FILE = BASE_DIR / "attempts.jsonl"

FACES_DIR.mkdir(exist_ok=True)
ATTEMPTS_DIR.mkdir(exist_ok=True)

# ---------------------------------------
# LOGGING
# ---------------------------------------

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(message)s"
)

# ---------------------------------------
# RENDER CONNECTION
# ---------------------------------------

session = requests.Session()
session.headers.update({
    "X-Laptop-Agent-Key": AGENT_KEY
})

# ---------------------------------------
# LOAD FACE RECOGNITION MODEL
# ---------------------------------------

logging.info("Loading InsightFace AI model...")

face_app = FaceAnalysis(
    name="buffalo_l",
    providers=["CPUExecutionProvider"]
)

face_app.prepare(
    ctx_id=-1,
    det_size=(640, 640)
)

logging.info("Face recognition model loaded successfully.")


# ---------------------------------------
# FACE FUNCTIONS
# ---------------------------------------

def get_face_embedding(image):
    faces = face_app.get(image)

    if not faces:
        return None

    # Use the largest detected face
    face = max(
        faces,
        key=lambda f: (
            f.bbox[2] - f.bbox[0]
        ) * (
            f.bbox[3] - f.bbox[1]
        )
    )

    return face.normed_embedding.astype(np.float32)


def cosine_distance(embedding1, embedding2):
    return float(
        1.0 - np.dot(embedding1, embedding2)
    )


# ---------------------------------------
# LOCAL FACE DATABASE
# ---------------------------------------

known_faces = {}


def load_local_faces():
    global known_faces

    known_faces = {}

    if not FACES_DIR.exists():
        return

    for person_folder in FACES_DIR.iterdir():

        if not person_folder.is_dir():
            continue

        person_id = person_folder.name
        embeddings = []

        for image_path in person_folder.glob("*.jpg"):

            image = cv2.imread(str(image_path))

            if image is None:
                continue

            embedding = get_face_embedding(image)

            if embedding is not None:
                embeddings.append(embedding)

        if embeddings:
            known_faces[person_id] = embeddings

    logging.info(
        "Loaded %s registered people.",
        len(known_faces)
    )


# ---------------------------------------
# DOWNLOAD REGISTERED FACES
# ---------------------------------------

def read_manifest():
    if MANIFEST_FILE.exists():
        try:
            return json.loads(
                MANIFEST_FILE.read_text(encoding="utf-8")
            )
        except Exception:
            pass

    return {}


def save_manifest(data):
    MANIFEST_FILE.write_text(
        json.dumps(data, indent=2),
        encoding="utf-8"
    )


def sync_registrations():

    logging.info("Checking registered faces...")

    try:
        response = session.get(
            f"{BASE_URL}/api/agent/registrations",
            timeout=30
        )
        response.raise_for_status()

        data = response.json()

        if not data.get("ok"):
            logging.error("Registration request failed.")
            return

        people = data.get("people", [])
        manifest = read_manifest()

        for person in people:

            person_id = str(person["id"])
            photos = person.get("photos", [])

            if not photos:
                continue

            person_folder = FACES_DIR / person_id
            person_folder.mkdir(exist_ok=True)

            photo_ids = sorted(
                str(photo["id"]) for photo in photos
            )

            previous_ids = manifest.get(person_id, [])

            # Download only when the registered photo list changes
            if previous_ids != photo_ids:

                logging.info(
                    "Downloading photos for %s",
                    person.get("name", person_id)
                )

                success = True

                for photo in photos:

                    angle = photo.get("angle") or str(photo["id"])
                    filename = f"{angle}.jpg"
                    image_path = person_folder / filename

                    try:
                        image_response = requests.get(
                            photo["url"],
                            timeout=30
                        )
                        image_response.raise_for_status()

                        image_path.write_bytes(
                            image_response.content
                        )

                        image = cv2.imread(str(image_path))

                        if image is None:
                            success = False
                            logging.error(
                                "Invalid image: %s", filename
                            )

                    except Exception as error:
                        success = False
                        logging.error(
                            "Photo download failed: %s", error
                        )

                if success:
                    manifest[person_id] = photo_ids
                    save_manifest(manifest)

                    logging.info(
                        "Downloaded registered photos for %s",
                        person.get("name", person_id)
                    )

            # Tell Render that this person's photos are synchronized
            try:
                sync_response = session.post(
                    f"{BASE_URL}/api/agent/registrations/"
                    f"{person_id}/synced",
                    timeout=30
                )
                sync_response.raise_for_status()

            except Exception as error:
                logging.error(
                    "Could not update sync status: %s", error
                )

        load_local_faces()

    except Exception as error:
        logging.error(
            "Registration synchronization error: %s", error
        )


# ---------------------------------------
# RECOGNIZE A FACE
# ---------------------------------------

def recognize_person(image):

    unknown_embedding = get_face_embedding(image)

    if unknown_embedding is None:
        return None, None

    best_person = None
    best_distance = float("inf")

    for person_id, embeddings in known_faces.items():

        for registered_embedding in embeddings:

            distance = cosine_distance(
                unknown_embedding,
                registered_embedding
            )

            if distance < best_distance:
                best_distance = distance
                best_person = person_id

    if best_person and best_distance <= MATCH_THRESHOLD:
        return best_person, best_distance

    return None, best_distance


# ---------------------------------------
# SAVE ATTEMPT LOCALLY
# ---------------------------------------

def save_attempt(capture_id, image, result, person_id, distance):

    image_path = ATTEMPTS_DIR / f"{capture_id}.jpg"

    cv2.imwrite(str(image_path), image)

    record = {
        "capture_id": capture_id,
        "result": result,
        "person_id": person_id,
        "distance": distance,
        "time": time.strftime("%Y-%m-%d %H:%M:%S")
    }

    with open(LOG_FILE, "a", encoding="utf-8") as file:
        file.write(json.dumps(record) + "\n")


# ---------------------------------------
# SEND RESULT TO RENDER
# ---------------------------------------

def send_result(capture, result, person_id=None,
                distance=None, note=""):

    payload = {
        "result": result,
        "note": note
    }

    if person_id:
        payload["personId"] = person_id

    if distance is not None:
        payload["distance"] = distance

    response = session.post(
        f"{BASE_URL}/api/agent/captures/"
        f"{capture['id']}/result",
        json=payload,
        timeout=30
    )

    response.raise_for_status()

    logging.info(
        "Result sent to Render: %s",
        result
    )


# ---------------------------------------
# PROCESS CAMERA CAPTURES
# ---------------------------------------

def process_captures():

    try:
        response = session.get(
            f"{BASE_URL}/api/agent/captures?limit=5",
            timeout=30
        )

        response.raise_for_status()

        captures = response.json().get("captures", [])

        for capture in captures:

            capture_id = capture.get("captureId") or str(capture["id"])

            logging.info(
                "Processing camera capture: %s",
                capture_id
            )

            try:
                image_response = requests.get(
                    capture["url"],
                    timeout=30
                )
                image_response.raise_for_status()

                image_array = np.frombuffer(
                    image_response.content,
                    dtype=np.uint8
                )

                image = cv2.imdecode(
                    image_array,
                    cv2.IMREAD_COLOR
                )

                if image is None:
                    logging.error("Could not read camera image.")
                    send_result(
                        capture,
                        "no_face",
                        note="Invalid camera image"
                    )
                    continue

                person_id, distance = recognize_person(image)

                if person_id:

                    logging.info(
                        "AUTHORIZED FACE MATCHED: %s",
                        person_id
                    )

                    result = "entered"

                    send_result(
                        capture,
                        result,
                        person_id=person_id,
                        distance=distance,
                        note="Registered face matched"
                    )

                elif distance is None:

                    logging.info("No face detected.")

                    result = "no_face"

                    send_result(
                        capture,
                        result,
                        note="No face detected"
                    )

                else:

                    logging.info(
                        "Unknown face. Distance: %.4f",
                        distance
                    )

                    result = "unknown"

                    send_result(
                        capture,
                        result,
                        distance=distance,
                        note="No registered face matched"
                    )

                save_attempt(
                    capture_id,
                    image,
                    result,
                    person_id,
                    distance
                )

            except requests.RequestException as error:
                # Leave the capture pending so it can be retried
                logging.error(
                    "Network/API error for capture %s: %s",
                    capture_id,
                    error
                )

            except Exception as error:
                logging.exception(
                    "Capture processing error: %s",
                    error
                )

    except Exception as error:
        logging.error(
            "Could not retrieve camera captures: %s",
            error
        )


# ---------------------------------------
# MAIN PROGRAM
# ---------------------------------------

def main():

    if not AGENT_KEY:
        raise RuntimeError("Laptop agent key is required.")

    logging.info("Starting Smart Room Laptop Agent...")

    sync_registrations()

    while True:

        try:
            sync_registrations()
            process_captures()

        except KeyboardInterrupt:
            logging.info("Agent stopped by user.")
            break

        except Exception as error:
            logging.exception("Agent error: %s", error)

        time.sleep(POLL_INTERVAL)


if __name__ == "__main__":
    main()
