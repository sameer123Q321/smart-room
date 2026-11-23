
/*
  SMART ROOM - ESP32 + DHT11 + Door Lock + LED Strip + Fan

  Connected to online Render server:
  https://smart-room-exsy.onrender.com

  Sends:
    room.report
    door.check
    light.check
    fan.check

  Libraries required:
    1. DHT sensor library by Adafruit
    2. ArduinoJson version 7
    3. WiFiClientSecure (included with ESP32 board package)
    4. HTTPClient (included with ESP32 board package)
*/

// ---------------- Libraries ----------------

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <DHT.h>
#include <ArduinoJson.h>

// ---------------- WiFi Settings ----------------

// Enter your WiFi name and password here.
// ESP32 requires a 2.4 GHz WiFi network.

const char* WIFI_SSID = "Alizaib jatoi";
const char* WIFI_PASSWORD = "Alizaib777";

// ---------------- Render Server ----------------

const char* SERVER_URL =
  "https://smart-room-exsy.onrender.com/rpc";

// ---------------- DHT11 Sensor ----------------

#define DHT_PIN 4
#define DHT_TYPE DHT11

DHT dht(DHT_PIN, DHT_TYPE);

// ---------------- Relay Settings ----------------

#define LOCK_RELAY_PIN 26

const bool LOCK_RELAY_ACTIVE_LOW = false;

const unsigned long MAX_UNLOCK_MS = 10000;

// Light and fan relay settings

struct Switch {
  const char* name;
  const char* label;
  int pin;
  bool activeLow;
  bool on;
};

Switch switches[] = {
  { "light", "Light", 27, true, false },
  { "fan", "Fan", 25, true, false }
};

const int SWITCH_COUNT =
  sizeof(switches) / sizeof(switches[0]);

// ---------------- Timing ----------------

const unsigned long READ_INTERVAL_MS = 2000;
const unsigned long SYNC_INTERVAL_MS = 1000;

// ---------------- Room Reading ----------------

struct Reading {
  bool valid = false;
  float t = 0;
  float h = 0;
  float feels = 0;

  const char* tStat = "";
  const char* hStat = "";

  String adv = "";
};

Reading room;

bool lockOpen = false;

unsigned long unlockStart = 0;
unsigned long unlockFor = 0;

// ---------------- Temperature Status ----------------

const char* tempStatus(float feels) {

  if (feels < 18) return "Cold";
  if (feels < 26) return "Comfortable";
  if (feels < 30) return "Warm";
  if (feels < 35) return "Hot";

  return "Too hot";
}

// ---------------- Humidity Status ----------------

const char* humidityStatus(float h) {

  if (h < 30) return "Dry";
  if (h <= 60) return "Good";
  if (h <= 70) return "A bit humid";

  return "Too humid";
}

// ---------------- Room Advice ----------------

String advice(float feels, float h) {

  String temp = "";

  if (feels >= 30)
    temp = "Turn on the AC";

  else if (feels >= 26)
    temp = "Turn on the fan";

  else if (feels < 18)
    temp = "Turn off the AC/fan";

  String humid = "";

  if (h > 70)
    humid = "Open the windows for fresh air";

  else if (h < 30)
    humid = "Air is dry - drink water";

  if (temp.length() && humid.length())
    return temp + ". " + humid;

  if (temp.length())
    return temp;

  if (humid.length())
    return humid;

  return "No action needed";
}

// ---------------- Read DHT11 ----------------

void readRoom() {

  float t = dht.readTemperature();
  float h = dht.readHumidity();

  if (isnan(t) || isnan(h)) {

    Serial.println("Sensor error - check DHT11 wiring");

    room.valid = false;
    return;
  }

  room.t = t;
  room.h = h;

  room.feels = dht.computeHeatIndex(t, h, false);

  room.tStat = tempStatus(room.feels);
  room.hStat = humidityStatus(h);

  room.adv = advice(room.feels, h);

  room.valid = true;

  Serial.println("\n----- ROOM READINGS -----");

  Serial.printf("Temperature: %.1f C\n", room.t);
  Serial.printf("Humidity: %.0f %%\n", room.h);
  Serial.printf("Feels Like: %.1f C\n", room.feels);

  Serial.printf("Temperature Status: %s\n", room.tStat);
  Serial.printf("Humidity Status: %s\n", room.hStat);

  Serial.printf("Advice: %s\n", room.adv.c_str());

  Serial.println("-------------------------");
}

// ---------------- Relay Control ----------------

void relayWrite(int pin, bool activeLow, bool on) {

  if (activeLow && !on) {

    pinMode(pin, INPUT);
    return;
  }

  pinMode(pin, OUTPUT);

  digitalWrite(
    pin,
    (on != activeLow) ? HIGH : LOW
  );
}

// ---------------- Door Lock ----------------

void setLock(bool open) {

  if (open == lockOpen) return;

  lockOpen = open;

  relayWrite(
    LOCK_RELAY_PIN,
    LOCK_RELAY_ACTIVE_LOW,
    open
  );

  Serial.println(
    open ? "Door UNLOCKED" : "Door locked"
  );
}

void openLockFor(unsigned long ms) {

  if (ms == 0) {

    setLock(false);
    return;
  }

  unlockStart = millis();

  unlockFor = min(ms, MAX_UNLOCK_MS);

  setLock(true);
}

void checkUnlockTimer() {

  if (
    lockOpen &&
    millis() - unlockStart >= unlockFor
  ) {

    setLock(false);
  }
}

// ---------------- Light and Fan ----------------

void setSwitch(Switch& s, bool on) {

  if (on == s.on) return;

  s.on = on;

  relayWrite(
    s.pin,
    s.activeLow,
    on
  );

  Serial.printf(
    "%s %s\n",
    s.label,
    on ? "ON" : "OFF"
  );
}

// ---------------- WiFi Connection ----------------

void printWiFiProblem() {

  switch (WiFi.status()) {

    case WL_NO_SSID_AVAIL:

      Serial.println(
        "WiFi name not found. Check your WiFi name and 2.4 GHz network."
      );

      break;

    case WL_CONNECT_FAILED:

      Serial.println(
        "WiFi connection failed. Check your password."
      );

      break;

    default:

      Serial.println(
        "WiFi not connected. Trying again..."
      );

      break;
  }
}

void connectWiFi() {

  Serial.printf(
    "Connecting to WiFi: %s\n",
    WIFI_SSID
  );

  WiFi.mode(WIFI_STA);

  WiFi.begin(
    WIFI_SSID,
    WIFI_PASSWORD
  );

  unsigned long start = millis();

  while (
    WiFi.status() != WL_CONNECTED &&
    millis() - start < 15000
  ) {

    delay(500);
    Serial.print(".");
  }

  Serial.println();

  if (WiFi.status() == WL_CONNECTED) {

    Serial.println("WiFi connected!");

    Serial.print("ESP32 IP: ");
    Serial.println(WiFi.localIP());

  } else {

    printWiFiProblem();
  }
}

// ---------------- Maintain WiFi ----------------

void keepWiFiConnected() {

  static unsigned long lastTry = 0;

  if (WiFi.status() == WL_CONNECTED)
    return;

  if (millis() - lastTry < 15000)
    return;

  lastTry = millis();

  printWiFiProblem();

  WiFi.disconnect();
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
}

// ---------------- Send Data to Render ----------------

void syncWithServer() {

  static bool serverOk = true;

  if (WiFi.status() != WL_CONNECTED)
    return;

  // Build JSON-RPC batch request

  JsonDocument req;

  // Room temperature and humidity

  if (room.valid) {

    JsonObject report = req.add<JsonObject>();

    report["jsonrpc"] = "2.0";
    report["method"] = "room.report";
    report["id"] = 1;

    JsonObject p =
      report["params"].to<JsonObject>();

    p["temperature"] = room.t;
    p["humidity"] = room.h;
    p["feelsLike"] = room.feels;

    p["tempStatus"] = room.tStat;
    p["humidityStatus"] = room.hStat;

    p["advice"] = room.adv;
  }

  // Door status

  JsonObject check = req.add<JsonObject>();

  check["jsonrpc"] = "2.0";
  check["method"] = "door.check";
  check["id"] = 2;

  check["params"]["open"] = lockOpen;

  // Light and fan status

  for (int i = 0; i < SWITCH_COUNT; i++) {

    JsonObject sw = req.add<JsonObject>();

    sw["jsonrpc"] = "2.0";

    sw["method"] =
      String(switches[i].name) + ".check";

    sw["id"] = 10 + i;

    sw["params"]["on"] = switches[i].on;
  }

  // Convert JSON into a string

  String body;

  serializeJson(req, body);

  // Connect to Render using HTTPS

  WiFiClientSecure client;

  // Testing only: skips HTTPS certificate verification.
  // Replace with proper certificate verification before production use.

  client.setInsecure();

  HTTPClient http;

  if (!http.begin(client, SERVER_URL)) {

    Serial.println("Could not start HTTPS connection.");
    return;
  }

  http.setConnectTimeout(60000);
  http.setTimeout(60000);

  http.addHeader(
    "Content-Type",
    "application/json"
  );

  Serial.println("\nSending data to Render...");

  int code = http.POST(body);

  // Check HTTP response

  if (code != 200) {

    if (serverOk) {

      if (code > 0) {

        Serial.printf(
          "Render HTTP Error: %d\n",
          code
        );

        Serial.println(http.getString());

      } else {

        Serial.printf(
          "Could not reach Render: %s\n",
          http.errorToString(code).c_str()
        );
      }
    }

    serverOk = false;

    http.end();
    return;
  }

  // Read server response

  String response = http.getString();

  http.end();

  JsonDocument res;

  DeserializationError err =
    deserializeJson(res, response);

  if (err) {

    Serial.printf(
      "Invalid server response: %s\n",
      err.c_str()
    );

    return;
  }

  if (!serverOk) {

    Serial.println(
      "Connected to Render successfully!"
    );
  }

  serverOk = true;

  // Process server commands

  for (JsonObject reply : res.as<JsonArray>()) {

    if (!reply["error"].isNull()) {

      Serial.printf(
        "Server error: %s\n",
        reply["error"]["message"] | "unknown"
      );

      continue;
    }

    int id = reply["id"] | 0;

    // Door command

    if (id == 2) {

      unsigned long ms =
        reply["result"]["unlockMs"] | 0UL;

      openLockFor(ms);
    }

    // Light and fan commands

    else if (
      id >= 10 &&
      id < 10 + SWITCH_COUNT
    ) {

      setSwitch(
        switches[id - 10],
        reply["result"]["on"] | false
      );
    }
  }
}

// ---------------- Main Setup ----------------

void setup() {

  Serial.begin(115200);

  delay(500);

  Serial.println();
  Serial.println("SMART ROOM STARTING...");

  // Keep door locked

  relayWrite(
    LOCK_RELAY_PIN,
    LOCK_RELAY_ACTIVE_LOW,
    false
  );

  // Keep light and fan OFF

  for (int i = 0; i < SWITCH_COUNT; i++) {

    relayWrite(
      switches[i].pin,
      switches[i].activeLow,
      false
    );
  }

  // Start DHT11

  dht.begin();

  // Connect WiFi

  connectWiFi();
}

// ---------------- Main Loop ----------------

void loop() {

  static unsigned long lastRead = 0;
  static unsigned long lastSync = 0;

  keepWiFiConnected();

  checkUnlockTimer();

  // Read sensor every 2 seconds

  if (
    millis() - lastRead >= READ_INTERVAL_MS
  ) {

    lastRead = millis();

    readRoom();
  }

  // Communicate with Render every second

  if (
    millis() - lastSync >= SYNC_INTERVAL_MS
  ) {

    lastSync = millis();

    syncWithServer();
  }
}
