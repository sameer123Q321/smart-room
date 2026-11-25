
/*
  SMART ROOM - DOOR CAMERA (ESP32-CAM, AI-Thinker)

  WORKFLOW:
  1. Turn the switch ON.
  2. Flash turns ON.
  3. Wait 3 seconds for the person to look at the camera.
  4. Capture one photo.
  5. Flash blinks twice.
  6. Send the photo to the Render server using HTTPS.
  7. Render saves the photo in Supabase.
  8. Laptop performs face recognition.
  9. Render sends the unlock command to the door ESP32 if authorized.

  One photo per switch ON.
  Turn OFF and ON again for another photo.

  WIRING:
  Switch:
    One leg -> 3V3
    Other leg -> GPIO 13

  FLASH:
    GPIO 4

  STATUS LED:
    GPIO 33 (active LOW)

  ARDUINO IDE:
    Board: AI Thinker ESP32-CAM
    Partition: Huge APP (3MB No OTA/1MB SPIFFS)
    Library: ArduinoJson by Benoit Blanchon (version 7)

  Serial Monitor: 115200 baud
*/

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include "esp_camera.h"

// ==================================================
// WIFI CONFIGURATION
// ==================================================

const char* WIFI_SSID = "Alizaib jatoi";
const char* WIFI_PASSWORD = "Alizaib777";

// ==================================================
// RENDER SERVER CONFIGURATION
// ==================================================

const char* SERVER_URL =
  "https://smart-room-exsy.onrender.com/api/camera/photo";

// Must match CAMERA_KEY in Render environment variables.
const char* CAMERA_KEY = "smart-room-cam";

// ==================================================
// HARDWARE PINS
// ==================================================

#define BUTTON_PIN 13
#define FLASH_PIN 4
#define STATUS_LED_PIN 33

const bool FLIP_IMAGE = false;

// ==================================================
// AI-THINKER ESP32-CAM PIN CONFIGURATION
// ==================================================

#define PWDN_GPIO_NUM 32
#define RESET_GPIO_NUM -1
#define XCLK_GPIO_NUM 0
#define SIOD_GPIO_NUM 26
#define SIOC_GPIO_NUM 27
#define Y9_GPIO_NUM 35
#define Y8_GPIO_NUM 34
#define Y7_GPIO_NUM 39
#define Y6_GPIO_NUM 36
#define Y5_GPIO_NUM 21
#define Y4_GPIO_NUM 19
#define Y3_GPIO_NUM 18
#define Y2_GPIO_NUM 5
#define VSYNC_GPIO_NUM 25
#define HREF_GPIO_NUM 23
#define PCLK_GPIO_NUM 22

// ==================================================
// TIMING CONFIGURATION
// ==================================================

const unsigned long DEBOUNCE_MS = 80;
const unsigned long CANCEL_MS = 250;
const unsigned long LOOK_TIME_MS = 3000;

bool switchWasOn = false;

// ==================================================
// CAMERA INITIALIZATION
// ==================================================

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

  config.frame_size = FRAMESIZE_VGA;
  config.jpeg_quality = 12;
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
    Serial.printf(
      "Camera failed to start. Error: 0x%x\n",
      err);
    return false;
  }

  sensor_t* sensor = esp_camera_sensor_get();

  if (FLIP_IMAGE) {
    sensor->set_vflip(sensor, 1);
    sensor->set_hmirror(sensor, 1);
  }

  Serial.println("Camera initialized successfully.");

  return true;
}

// ==================================================
// CAPTURE PHOTO
// ==================================================

camera_fb_t* takePhoto() {

  // Remove old frames.
  for (int i = 0; i < 2; i++) {

    camera_fb_t* oldFrame = esp_camera_fb_get();

    if (oldFrame) {
      esp_camera_fb_return(oldFrame);
    }
  }

  return esp_camera_fb_get();
}

// ==================================================
// SWITCH FUNCTIONS
// ==================================================

bool switchOn() {
  return digitalRead(BUTTON_PIN) == HIGH;
}

bool switchSteady(bool on, unsigned long ms) {

  unsigned long start = millis();

  while (millis() - start < ms) {

    if (switchOn() != on) {
      return false;
    }

    delay(5);
  }

  return true;
}

// ==================================================
// FLASH BLINK
// ==================================================

void blinkFlash(int times) {

  for (int i = 0; i < times; i++) {

    digitalWrite(FLASH_PIN, HIGH);
    delay(150);

    digitalWrite(FLASH_PIN, LOW);
    delay(150);
  }
}

// ==================================================
// WIFI CONNECTION
// ==================================================

void connectWiFi() {

  Serial.printf(
    "Connecting to WiFi: %s\n",
    WIFI_SSID);

  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);

  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  unsigned long start = millis();

  while (
    WiFi.status() != WL_CONNECTED && millis() - start < 15000) {

    delay(500);
    Serial.print(".");
  }

  Serial.println();

  if (WiFi.status() == WL_CONNECTED) {

    Serial.println("WiFi connected!");

    Serial.print("Camera IP: ");
    Serial.println(WiFi.localIP());

  } else {

    Serial.println(
      "WiFi not connected. Will retry automatically.");
  }
}

// ==================================================
// AUTOMATIC WIFI RECONNECTION
// ==================================================

void keepWiFiConnected() {

  static unsigned long lastTry = 0;

  if (WiFi.status() == WL_CONNECTED) {
    return;
  }

  if (millis() - lastTry < 15000) {
    return;
  }

  lastTry = millis();

  Serial.println("WiFi disconnected. Reconnecting...");

  WiFi.disconnect();
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
}

// ==================================================
// SEND PHOTO TO RENDER
// ==================================================

void sendPhotoToRender(camera_fb_t* fb) {

  if (!fb) {
    Serial.println("Invalid photo.");
    return;
  }

  if (WiFi.status() != WL_CONNECTED) {

    Serial.println("WiFi disconnected. Photo not sent.");

    return;
  }

  Serial.println("Connecting securely to Render...");

  WiFiClientSecure client;

  // Prototype setting: accepts the HTTPS certificate
  // without validating its identity.
  // Replace with certificate validation for production use.
  client.setInsecure();

  HTTPClient http;

  http.setConnectTimeout(20000);
  http.setTimeout(60000);

  if (!http.begin(client, SERVER_URL)) {

    Serial.println("Could not initialize HTTPS connection.");

    return;
  }

  http.addHeader(
    "Content-Type",
    "image/jpeg");

  http.addHeader(
    "X-Camera-Key",
    CAMERA_KEY);

  Serial.printf(
    "Uploading photo: %u bytes\n",
    fb->len);

  // Upload one photo to Render.
  int httpCode = http.POST(
    fb->buf,
    fb->len);

  String response = "";

  if (httpCode > 0) {
    response = http.getString();
  }

  String errorMessage = http.errorToString(httpCode);

  http.end();

  // ==================================================
  // RESPONSE HANDLING
  // ==================================================

  if (httpCode <= 0) {

    Serial.println("Photo upload failed.");

    Serial.println(errorMessage);

    return;
  }

  Serial.printf(
    "Render HTTP Status: %d\n",
    httpCode);

  Serial.println("Render response:");

  Serial.println(response);

  if (httpCode >= 200 && httpCode < 300) {

    Serial.println("--------------------------------");
    Serial.println("PHOTO SUCCESSFULLY SENT TO RENDER");
    Serial.println("--------------------------------");

    Serial.println(
      "Render will save the photo in Supabase.");

    Serial.println(
      "Laptop will perform face recognition.");

    Serial.println(
      "Door ESP32 will receive the unlock command if authorized.");

  } else {

    Serial.println("--------------------------------");
    Serial.println("RENDER REJECTED THE PHOTO");
    Serial.println("--------------------------------");

    JsonDocument json;

    if (!deserializeJson(json, response)) {

      const char* error = json["error"] | "Unknown server error";

      Serial.print("Server error: ");
      Serial.println(error);
    }
  }
}

// ==================================================
// MAIN FACE CAPTURE PROCESS
// ==================================================

void checkFace() {

  if (WiFi.status() != WL_CONNECTED) {

    Serial.println("No WiFi. Photo not sent.");

    return;
  }

  // ----------------------------------------------
  // STEP 1: TURN FLASH ON
  // ----------------------------------------------

  Serial.println();
  Serial.println("Switch ON detected.");

  Serial.println(
    "Look straight at the camera...");

  digitalWrite(FLASH_PIN, HIGH);

  unsigned long start = millis();
  unsigned long offSince = 0;

  // ----------------------------------------------
  // STEP 2: WAIT THREE SECONDS
  // ----------------------------------------------

  while (millis() - start < LOOK_TIME_MS) {

    if (switchOn()) {

      offSince = 0;

    } else if (offSince == 0) {

      offSince = millis();

    } else if (millis() - offSince >= CANCEL_MS) {

      digitalWrite(FLASH_PIN, LOW);

      Serial.println(
        "Switch turned OFF. Capture cancelled.");

      return;
    }

    delay(10);
  }

  // ----------------------------------------------
  // STEP 3: CAPTURE PHOTO
  // ----------------------------------------------

  Serial.println("Capturing photo...");

  camera_fb_t* fb = takePhoto();

  digitalWrite(FLASH_PIN, LOW);

  if (!fb) {

    Serial.println("Camera could not capture photo.");

    return;
  }

  // ----------------------------------------------
  // STEP 4: BLINK FLASH TWICE
  // ----------------------------------------------

  blinkFlash(2);

  Serial.println("Photo captured successfully.");

  // ----------------------------------------------
  // STEP 5: SEND TO RENDER
  // ----------------------------------------------

  sendPhotoToRender(fb);

  // Release camera memory.
  esp_camera_fb_return(fb);

  Serial.println();
  Serial.println(
    "Camera ready. Turn switch OFF and ON for another capture.");
}

// ==================================================
// SETUP
// ==================================================

void setup() {

  Serial.begin(115200);

  delay(500);

  Serial.println();
  Serial.println("================================");
  Serial.println("SMART ROOM - DOOR CAMERA");
  Serial.println("ESP32-CAM AI-Thinker");
  Serial.println("================================");

  // Initialize hardware pins.
  pinMode(FLASH_PIN, OUTPUT);
  digitalWrite(FLASH_PIN, LOW);

  pinMode(STATUS_LED_PIN, OUTPUT);
  digitalWrite(STATUS_LED_PIN, HIGH);

  pinMode(BUTTON_PIN, INPUT_PULLDOWN);

  // Initialize camera.
  if (!startCamera()) {

    Serial.println(
      "Restarting camera module...");

    delay(3000);

    ESP.restart();
  }

  // Connect WiFi.
  connectWiFi();

  // Check initial switch position.
  switchWasOn = switchOn();

  if (switchWasOn) {

    Serial.println(
      "Switch is already ON. Turn it OFF and ON again.");

  } else {

    Serial.println(
      "Ready. Turn the switch ON to capture a photo.");
  }
}

// ==================================================
// MAIN LOOP
// ==================================================

void loop() {

  // Maintain WiFi connection.
  keepWiFiConnected();

  bool on = switchOn();

  // Detect a stable switch change.
  if (
    on != switchWasOn && switchSteady(on, DEBOUNCE_MS)) {

    switchWasOn = on;

    // Only capture when switch changes OFF -> ON.
    if (on) {

      checkFace();

      // Update switch state after capture.
      switchWasOn = switchOn();
    }
  }
}
