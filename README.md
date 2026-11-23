# Smart Room

Dashboard for the smart room: temperature and humidity (ESP32 + DHT11), door lock, LED strip and fan,
and face recognition at the door (ESP32-CAM).

## Run it on a laptop

Needs [Node.js](https://nodejs.org) 18 or newer, and internet the first time.

```
npm install
npm start
```

`npm install` also downloads the face recognition models (about 190 MB, once) into `models/`.
If that fails, `npm start` downloads them instead.

The server prints the dashboard address, for example `http://localhost:3000`, and the laptop's IP address.

## On a new laptop

1. Copy the project folder (without `node_modules` and `models`), then run `npm install` and `npm start`.
2. The laptop has a new IP address. Put the one the server prints into `SERVER_IP` in
   `esp32/dht/dht.ino` and `esp32-cam/esp32-cam.ino`, and upload both sketches again.
3. To keep the registered faces and the history, also copy the `data` folder.
4. When Windows asks, allow Node.js through the firewall (private and public networks).

## Settings

In `server.js`:

- `DOOR_PIN` - PIN for opening the door and changing faces (change it from `1234`)
- `CAMERA_KEY` - must match `CAMERA_KEY` in `esp32-cam/esp32-cam.ino`
- `UNLOCK_MS` - how long the door stays unlocked

Start on another port with `PORT=4000 npm start`.

## Folders

| Folder | What's in it |
| --- | --- |
| `esp32/` | Sketch for the main ESP32 (sensor, door lock, light, fan) |
| `esp32-cam/` | Sketch for the door camera |
| `data/` | Registered faces and door history (made by the server) |
| `models/` | Face recognition models (downloaded by `npm install`) |

The face recognition models are InsightFace "buffalo_l" (SCRFD + ArcFace), free for non-commercial use only.
