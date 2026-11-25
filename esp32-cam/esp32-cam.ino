 /*
  SMART ROOM - DOOR CAMERA (ESP32-CAM, AI-Thinker)
  Turn the switch ON -> the flash lights up -> look straight at the camera ->
  3 seconds later the photo is taken, the flash blinks 2 times, and the photo is
  sent to the Node.js server on your laptop. Then it stops - one photo per switch-on.
  For a new photo, turn the switch OFF and ON again.

  The server checks the face. If it belongs to someone added on the dashboard
  ("Faces that open the door"), the server opens the door - the door ESP32 picks
  that up on its next check, within a second.

  BEFORE UPLOADING:
    1. Start the server on your laptop:  npm start
    2. Put the laptop's IP in SERVER_IP below (same as in esp32/dht/dht.ino).
    3. CAMERA_KEY must match CAMERA_KEY in server.js.

  Wiring - on/off switch:
    one leg   -> 3V3
    other leg -> GPIO 13
  (GPIO 13 has a built-in pull-down, so it reads LOW while the switch is off)

  Arduino IDE:
    Board:            "AI Thinker ESP32-CAM"
    Partition scheme: "Huge APP (3MB No OTA/1MB SPIFFS)"
    Library:          "ArduinoJson" by Benoit Blanchon (version 7) - already installed for the door ESP32

  Serial Monitor: 115200 baud
*/
h
#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include "esp_camera.h"

// ---------------- WiFi ----------------
const char* WIFI_SSID     = "Alizaib Jatoi";
const char* WIFI_PASSWORD = "Alizaib777";

// ---------------- Laptop server ----------------
const char* SERVER_IP   = "192.168.43.233";
const int   SERVER_PORT = 3000;
const char* CAMERA_KEY  = "smart-room-cam";  // must match CAMERA_KEY in server.js

// ---------------- Pins ----------------
#define BUTTON_PIN      13   // the on/off switch
#define FLASH_PIN        4   // the big white LED on the front
#define STATUS_LED_PIN  33   // the small red LED on the back (ON with LOW)

// Turn the picture the right way up if the camera is mounted upside down
const bool FLIP_IMAGE = false;

// AI-Thinker ESP32-CAM camera pins
#define PWDN_GPIO_NUM   32
#define RESET_GPIO_NUM  -1
#define XCLK_GPIO_NUM    0
#define SIOD_GPIO_NUM   26
#define SIOC_GPIO_NUM   27
#define Y9_GPIO_NUM     35
#define Y8_GPIO_NUM     34
#define Y7_GPIO_NUM     39
#define Y6_GPIO_NUM     36
#define Y5_GPIO_NUM     21
#define Y4_GPIO_NUM     19
#define Y3_GPIO_NUM     18
#define Y2_GPIO_NUM      5
#define VSYNC_GPIO_NUM  25
#define HREF_GPIO_NUM   23
#define PCLK_GPIO_NUM   22

const unsigned long DEBOUNCE_MS = 80;     // the switch must stay in a new position this long to count
const unsigned long CANCEL_MS = 250;      // switched off this long during the 3 seconds = cancel
const unsigned long LOOK_TIME_MS = 3000;  // flash on, time to look at the camera before the photo

bool switchWasOn = false;  // the switch position last time we looked

// ---------------- Camera ----------------

bool startCamera() {
  camera_config_t config = {};
  config.ledc_channel = LEDC_CHANNEL_0;
  config.ledc_timer = LEDC_TIMER_0;
  config.pin_d0 = Y2_GPIO_NUM;
  config.pin_d1 = Y3_GPIO_NUM;
  config.pin_d2 = Y4_GPIO_NUM;
  config.pin_d3 = Y5_GPIO_NUM;
  config.pin_d4 = Y6_GPIO_NUM;
  config.pin_d5 = Y7_GPIO_NUM;
  config.pin_d6 = Y8_GPIO_NUM;
  config.pin_d7 = Y9_GPIO_NUM;
  config.pin_xclk = XCLK_GPIO_NUM;
  config.pin_pclk = PCLK_GPIO_NUM;
  config.pin_vsync = VSYNC_GPIO_NUM;
  config.pin_href = HREF_GPIO_NUM;
  config.pin_sccb_sda = SIOD_GPIO_NUM;
  config.pin_sccb_scl = SIOC_GPIO_NUM;
  config.pin_pwdn = PWDN_GPIO_NUM;
  config.pin_reset = RESET_GPIO_NUM;
  config.xclk_freq_hz = 20000000;
  config.pixel_format = PIXFORMAT_JPEG;
  config.frame_size = FRAMESIZE_VGA;   // 640x480 - enough for faces, quick to send
  config.jpeg_quality = 12;            // 10-63, lower = better quality
  config.grab_mode = CAMERA_GRAB_LATEST;

  if (psramFound()) {
    config.fb_location = CAMERA_FB_IN_PSRAM;
    config.fb_count = 2;
  } else {
    config.fb_location = CAMERA_FB_IN_DRAM;
    config.fb_count = 1;
  }

  esp_err_t err = esp_camera_init(&config);
  if (err != ESP_OK) {
    Serial.printf("Camera failed to start (error 0x%x). Check the camera ribbon cable.\n", err);
    return false;
  }

  sensor_t* s = esp_camera_sensor_get();
  if (FLIP_IMAGE) {
    s->set_vflip(s, 1);
    s->set_hmirror(s, 1);
  }
  return true;
}

// Takes a fresh photo (call it while the flash is on). Give it back with esp_camera_fb_return().
camera_fb_t* takePhoto() {
  // The camera keeps the last frame ready - throw old ones away so the photo is from right now
  for (int i = 0; i < 2; i++) {
    camera_fb_t* old = esp_camera_fb_get();
    if (old) esp_camera_fb_return(old);
  }
  return esp_camera_fb_get();
}

bool switchOn() {
  return digitalRead(BUTTON_PIN) == HIGH;
}

// True when the switch reads `on` the whole time for `ms` (ignores flicker and contact bounce)
bool switchSteady(bool on, unsigned long ms) {
  unsigned long start = millis();
  while (millis() - start < ms) {
    if (switchOn() != on) return false;
    delay(5);
  }
  return true;
}

void blinkFlash(int times) {
  for (int i = 0; i < times; i++) {
    digitalWrite(FLASH_PIN, HIGH);
    delay(150);
    digitalWrite(FLASH_PIN, LOW);
    delay(150);
  }
}

// ---------------- WiFi ----------------

void connectWiFi() {
  Serial.printf("Connecting to WiFi \"%s\"", WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);  // answer faster
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 15000) {
    delay(500);
    Serial.print(".");
  }
  Serial.println();

  if (WiFi.status() == WL_CONNECTED) {
    Serial.print("WiFi connected! Camera IP: ");
    Serial.println(WiFi.localIP());
  } else {
    Serial.println("WiFi not connected yet - will keep trying. (ESP32 only works with 2.4 GHz WiFi)");
  }
}

// If the WiFi drops, try again every 15 seconds
void keepWiFiConnected() {
  static unsigned long lastTry = 0;
  if (WiFi.status() == WL_CONNECTED) return;
  if (millis() - lastTry < 15000) return;
  lastTry = millis();

  Serial.println("WiFi not connected. Trying again...");
  WiFi.disconnect();
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
}

// ---------------- Send to laptop ----------------

void checkFace() {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("No WiFi - photo not sent");
    return;
  }

  // Light on, give the person time to look straight at the camera
  Serial.println("Switch on - look at the camera...");
  digitalWrite(FLASH_PIN, HIGH);
  unsigned long start = millis();
  unsigned long offSince = 0;
  while (millis() - start < LOOK_TIME_MS) {
    if (switchOn()) {
      offSince = 0;
    } else if (offSince == 0) {
      offSince = millis();
    } else if (millis() - offSince >= CANCEL_MS) {
      digitalWrite(FLASH_PIN, LOW);
      Serial.println("Switch turned off - no photo taken");
      return;
    }
    delay(10);
  }

  camera_fb_t* fb = takePhoto();
  digitalWrite(FLASH_PIN, LOW);
  if (!fb) {
    Serial.println("Camera could not take a photo");
    return;
  }

  blinkFlash(2);  // 2 blinks = photo taken, sending it now (the only blinking it does)
  Serial.printf("Photo taken: %u bytes, sending...\n", fb->len);

  String url = String("http://") + SERVER_IP + ":" + SERVER_PORT + "/api/camera/photo";
  HTTPClient http;
  int code = 0;
  String body;

  // The first try after a quiet moment sometimes fails on a phone hotspot - so try twice
  for (int attempt = 1; attempt <= 2; attempt++) {
    http.begin(url);
    http.setConnectTimeout(6000);
    http.setTimeout(15000);  // the laptop needs a moment to check the face
    http.addHeader("Content-Type", "image/jpeg");
    http.addHeader("X-Camera-Key", CAMERA_KEY);
    code = http.POST(fb->buf, fb->len);
    body = code > 0 ? http.getString() : "";
    http.end();
    if (code > 0) break;
    if (attempt == 1) {
      Serial.println("Sending failed - trying once more...");
      delay(500);
    }
  }
  esp_camera_fb_return(fb);

  if (code <= 0) {
    Serial.printf("Could not reach the laptop at %s:%d (%s)\n",
                  SERVER_IP, SERVER_PORT, http.errorToString(code).c_str());
    Serial.println("Check: is server.js running? Is SERVER_IP correct? Is Node.js allowed in the firewall?");
    return;
  }

  JsonDocument res;
  if (deserializeJson(res, body)) {
    Serial.printf("Unexpected reply from the server (%d)\n", code);
    return;
  }
  if (code != 200) {
    Serial.printf("Server: %s\n", res["error"] | "error");
    return;
  }

  // The result is shown by the door itself (it opens or not) and on the dashboard
  String result = res["result"] | "";
  String name = res["name"] | "";

  if (result == "opened") {
    Serial.println("Welcome " + name + "! Door opening.");
  } else if (result == "door_offline") {
    Serial.println(name + " recognised, but the door lock is offline.");
  } else if (result == "unknown") {
    Serial.println("Unknown face - door stays locked.");
  } else {
    Serial.println("No face in the photo - stand in front of the camera, then switch OFF and ON to try again.");
  }
}

// ---------------- Main ----------------

void setup() {
  Serial.begin(115200);
  delay(500);
  Serial.println();
  Serial.println("Door camera starting...");

  pinMode(FLASH_PIN, OUTPUT);
  digitalWrite(FLASH_PIN, LOW);
  pinMode(STATUS_LED_PIN, OUTPUT);
  digitalWrite(STATUS_LED_PIN, HIGH);  // keep the small red LED off (it's ON with LOW)
  pinMode(BUTTON_PIN, INPUT_PULLDOWN);

  if (!startCamera()) {
    // Without the camera there is nothing to do - try again in a moment
    delay(3000);
    ESP.restart();
  }
  connectWiFi();

  // If the switch is already on at start-up, wait for it to go off and on again
  switchWasOn = switchOn();
  if (switchWasOn) {
    Serial.println("Ready - the switch is ON. Turn it OFF and ON again to check a face.");
  } else {
    Serial.println("Ready - turn the switch ON to check a face.");
  }
}

void loop() {
  keepWiFiConnected();

  // Only the moment the switch goes from OFF to ON starts a photo.
  // Staying ON does nothing more; switching OFF does nothing.
  bool on = switchOn();
  if (on != switchWasOn && switchSteady(on, DEBOUNCE_MS)) {
    switchWasOn = on;
    if (on) {
      checkFace();
      switchWasOn = switchOn();  // if it was switched off meanwhile, the next ON counts again
    }
  }
}
