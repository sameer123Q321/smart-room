  /*
    SMART ROOM (WiFi) - ESP32 + DHT11 + 12V door lock + 5V LED strip + 5V fan
    Reads the room, prints it in the Serial Monitor (115200 baud) and talks to
    the Node.js server (server.js) on your laptop.

    Every second the ESP32 sends ONE JSON-RPC request to the server with these calls:
      room.report  - the newest temperature / humidity reading
      door.check   - "is the lock open? should it be open?"
      light.check  - "is the LED strip on? should it be on?"
      fan.check    - "is the fan on? should it be on?"
    When someone presses "Open door" on the dashboard, the answer to door.check
    says how long to unlock, and the relay powers the lock for that long.
    When someone presses "Turn on/off" for the light or fan, the answer to
    light.check / fan.check switches that relay.

    BEFORE UPLOADING:
      1. On your laptop, start the server:  npm start
      2. It prints your laptop's IP address. Put that IP in SERVER_IP below.

    Wiring - sensor:
      DHT11 VCC  -> ESP32 3.3V
      DHT11 GND  -> ESP32 GND
      DHT11 DATA -> ESP32 GPIO 4

    Wiring - door relay module (control side):
      Relay VCC  -> ESP32 VIN (5V when the ESP32 is on USB)
      Relay GND  -> ESP32 GND
      Relay IN   -> ESP32 GPIO 26

    Wiring - lock (power side, 12V NEVER touches the ESP32):
      Battery +  -> fuse (2-3 A) -> Relay COM
      Relay NO   -> Lock +  (red wire)
      Lock -     -> Battery -  (black wire)
      1N4007 diode across the lock: stripe side on Lock +, other side on Lock -

    Wiring - 2-channel relay module (control side): K1 = fan, K2 = light
      Module VCC   -> 5V battery +
      Module GND   -> 5V battery -
      5V battery - -> ESP32 GND   (shared ground, required)
      Module IN1   -> ESP32 GPIO 25   (fan)
      Module IN2   -> ESP32 GPIO 27   (light)
      JD-VCC jumper: leave it on (JD-VCC joined to VCC)

    Wiring - LED strip (power side, from the 5V battery, NOT from the ESP32):
      5V battery +  -> K2 COM (middle screw)
      K2 NO         -> Strip +  (red)
      K2 NC         -> not connected
      Strip -       -> 5V battery -  (black)

    Wiring - fan (power side, from the 5V battery):
      5V battery +  -> K1 COM (middle screw)
      K1 NO         -> Fan +  (red)
      K1 NC         -> not connected
      Fan -         -> 5V battery -  (black)
      1N4007 diode across the fan: stripe side on Fan +, other side on Fan -

    Libraries (Arduino IDE -> Library Manager):
      "DHT sensor library" by Adafruit
      "ArduinoJson" by Benoit Blanchon (version 7)
    (WiFi.h and HTTPClient.h come with the ESP32 board package)
  */

  #include <WiFi.h>
  #include <HTTPClient.h>
  #include <DHT.h>
  #include <ArduinoJson.h>

  // ---------------- WiFi ----------------
  const char* WIFI_SSID     = "Alizaib Jatoi";
  const char* WIFI_PASSWORD = "Alizaib777";

  // ---------------- Laptop server ----------------
 
  const char* SERVER_IP   = "192.168.43.233";

  
  const int   SERVER_PORT = 3000;

  // ---------------- Sensor ----------------
  #define DHT_PIN   4
  #define DHT_TYPE  DHT11
  DHT dht(DHT_PIN, DHT_TYPE);

  // ---------------- Relays ----------------
  // ACTIVE_LOW = false: the relay module switches ON with HIGH and OFF with LOW (like yours).
  // ACTIVE_LOW = true:  for a module that switches ON with LOW.
  // With an "ON with LOW" 5V module, the ESP32's HIGH (only 3.3V) still counts as ON. So to switch
  // that kind OFF the ESP32 lets go of the pin instead - same as unplugging the wire.
  #define LOCK_RELAY_PIN 26
  const bool LOCK_RELAY_ACTIVE_LOW = false;
  const unsigned long MAX_UNLOCK_MS = 10000; // safety: never power the lock longer than this

  // On/off switches on the 2-channel module (switches ON with LOW).
  // If one is ON when the dashboard says OFF, change its true to false.
  struct Switch {
    const char* name;   // must match the name in server.js: "light" or "fan"
    const char* label;
    int pin;
    bool activeLow;
    bool on;
  };
  Switch switches[] = {
    { "light", "Light", 27, true, false },  // K2 - LED strip
    { "fan",   "Fan",   25, true, false },  // K1 - fan
  };
  const int SWITCH_COUNT = sizeof(switches) / sizeof(switches[0]);

  // ---------------- Timing ----------------
  const unsigned long READ_INTERVAL_MS = 2000;  // DHT11 can't give new values faster than this
  const unsigned long SYNC_INTERVAL_MS = 1000;  // talk to the server every second

  // Newest reading, sent with every request
  struct Reading {
    bool valid = false;
    float t, h, feels;
    const char* tStat;
    const char* hStat;
    String adv;
  };
  Reading room;

  bool lockOpen = false;
  unsigned long unlockStart = 0;
  unsigned long unlockFor = 0;

  // ---------------- Room status ----------------

  // How the room feels, based on the "feels like" temperature (°C)
  const char* tempStatus(float feels) {
    if (feels < 18) return "Cold";
    if (feels < 26) return "Comfortable";
    if (feels < 30) return "Warm";
    if (feels < 35) return "Hot";
    return "Too hot";
  }

  // How good the humidity is (%)
  const char* humidityStatus(float h) {
    if (h < 30)  return "Dry";
    if (h <= 60) return "Good";
    if (h <= 70) return "A bit humid";
    return "Too humid";
  }

  // What to do about it
  String advice(float feels, float h) {
    String temp = "";
    if (feels >= 30)      temp = "Turn on the AC";
    else if (feels >= 26) temp = "Turn on the fan";
    else if (feels < 18)  temp = "Turn off the AC/fan";

    String humid = "";
    if (h > 70)      humid = "Open the windows for fresh air";
    else if (h < 30) humid = "Air is dry - drink water";

    if (temp.length() && humid.length()) return temp + ". " + humid;
    if (temp.length())  return temp;
    if (humid.length()) return humid;
    return "No action needed";
  }

  void readRoom() {
    float t = dht.readTemperature();  // °C
    float h = dht.readHumidity();     // %

    if (isnan(t) || isnan(h)) {
      Serial.println("Sensor error - check DHT11 wiring");
      room.valid = false;
      return;
    }

    // Humid air feels hotter than it is - this calculates how hot it feels
    room.t = t;
    room.h = h;
    room.feels = dht.computeHeatIndex(t, h, false);
    room.tStat = tempStatus(room.feels);
    room.hStat = humidityStatus(h);
    room.adv = advice(room.feels, h);
    room.valid = true;
  }

  // ---------------- Relays ----------------

  void relayWrite(int pin, bool activeLow, bool on) {
    if (activeLow && !on) {
      pinMode(pin, INPUT);  // let go of the pin -> relay OFF
      return;
    }
    pinMode(pin, OUTPUT);
    digitalWrite(pin, (on != activeLow) ? HIGH : LOW);
  }

  // ---------------- Door lock ----------------

  void setLock(bool open) {
    if (open == lockOpen) return;
    lockOpen = open;
    relayWrite(LOCK_RELAY_PIN, LOCK_RELAY_ACTIVE_LOW, open);
    Serial.println(open ? "Door UNLOCKED" : "Door locked");
  }

  // Unlock for ms milliseconds (0 = lock now)
  void openLockFor(unsigned long ms) {
    if (ms == 0) {
      setLock(false);
      return;
    }
    unlockStart = millis();
    unlockFor = min(ms, MAX_UNLOCK_MS);
    setLock(true);
  }

  // Locks again by itself when the time is up - even if WiFi or the server is gone
  void checkUnlockTimer() {
    if (lockOpen && millis() - unlockStart >= unlockFor) setLock(false);
  }

  // ---------------- Light + fan ----------------

  void setSwitch(Switch& s, bool on) {
    if (on == s.on) return;
    s.on = on;
    relayWrite(s.pin, s.activeLow, on);
    Serial.printf("%s %s\n", s.label, on ? "ON" : "OFF");
  }

  // ---------------- WiFi ----------------

  void printWiFiProblem() {
    switch (WiFi.status()) {
      case WL_NO_SSID_AVAIL:
        Serial.println("WiFi name not found. Check the SSID and make sure it is 2.4 GHz (ESP32 can't use 5 GHz).");
        break;
      case WL_CONNECT_FAILED:
        Serial.println("WiFi connection failed. Check the password.");
        break;
      default:
        Serial.println("WiFi not connected. Trying again...");
        break;
    }
  }

  void connectWiFi() {
    Serial.printf("Connecting to WiFi \"%s\"", WIFI_SSID);
    WiFi.mode(WIFI_STA);
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

    unsigned long start = millis();
    while (WiFi.status() != WL_CONNECTED && millis() - start < 15000) {
      delay(500);
      Serial.print(".");
    }
    Serial.println();

    if (WiFi.status() == WL_CONNECTED) {
      Serial.print("WiFi connected! ESP32 IP: ");
      Serial.println(WiFi.localIP());
    } else {
      printWiFiProblem();
    }
  }

  // If the WiFi drops, try again every 15 seconds
  void keepWiFiConnected() {
    static unsigned long lastTry = 0;
    if (WiFi.status() == WL_CONNECTED) return;
    if (millis() - lastTry < 15000) return;
    lastTry = millis();

    printWiFiProblem();
    WiFi.disconnect();
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  }

  // ---------------- Talk to laptop (one JSON-RPC request) ----------------

  void syncWithServer() {
    static bool serverOk = true;  // only print problems when they start, not every second
    if (WiFi.status() != WL_CONNECTED) return;

    // Build the batch: [ room.report, door.check, light.check, fan.check ]
    JsonDocument req;
    if (room.valid) {
      JsonObject report = req.add<JsonObject>();
      report["jsonrpc"] = "2.0";
      report["method"] = "room.report";
      report["id"] = 1;
      JsonObject p = report["params"].to<JsonObject>();
      p["temperature"] = serialized(String(room.t, 1));
      p["humidity"] = serialized(String(room.h, 0));
      p["feelsLike"] = serialized(String(room.feels, 1));
      p["tempStatus"] = room.tStat;
      p["humidityStatus"] = room.hStat;
      p["advice"] = room.adv;
    }
    JsonObject check = req.add<JsonObject>();
    check["jsonrpc"] = "2.0";
    check["method"] = "door.check";
    check["id"] = 2;
    check["params"]["open"] = lockOpen;

    // Switch i gets id 10 + i, so its answer can be found again
    for (int i = 0; i < SWITCH_COUNT; i++) {
      JsonObject sw = req.add<JsonObject>();
      sw["jsonrpc"] = "2.0";
      sw["method"] = String(switches[i].name) + ".check";
      sw["id"] = 10 + i;
      sw["params"]["on"] = switches[i].on;
    }

    String body;
    serializeJson(req, body);

    String url = String("http://") + SERVER_IP + ":" + SERVER_PORT + "/rpc";
    HTTPClient http;
    http.begin(url);
    http.setConnectTimeout(1500);
    http.setTimeout(1500);
    http.addHeader("Content-Type", "application/json");
    int code = http.POST(body);

    if (code != 200) {
      if (serverOk) {
        if (code > 0) {
          Serial.printf("Laptop server replied with error %d\n", code);
        } else {
          Serial.printf("Could not reach the laptop at %s:%d (%s)\n",
                        SERVER_IP, SERVER_PORT, http.errorToString(code).c_str());
          Serial.println("Check: is server.js running? Is SERVER_IP correct? Is Node.js allowed in the firewall?");
        }
      }
      serverOk = false;
      http.end();
      return;
    }

    JsonDocument res;
    DeserializationError err = deserializeJson(res, http.getString());
    http.end();
    if (err) {
      Serial.printf("Bad reply from server: %s\n", err.c_str());
      return;
    }

    if (!serverOk) Serial.println("Connected to laptop again");
    serverOk = true;

    for (JsonObject reply : res.as<JsonArray>()) {
      if (!reply["error"].isNull()) {
        Serial.printf("Server error: %s\n", reply["error"]["message"] | "unknown");
        continue;
      }
      int id = reply["id"] | 0;
      if (id == 2) {
        unsigned long ms = reply["result"]["unlockMs"] | 0UL;
        openLockFor(ms);
      } else if (id >= 10 && id < 10 + SWITCH_COUNT) {
        setSwitch(switches[id - 10], reply["result"]["on"] | false);
      }
    }
  }

  // ---------------- Main ----------------

  void setup() {
    Serial.begin(115200);
    delay(500);
    Serial.println();
    Serial.println("Smart Room starting...");

    // Keep the lock closed and the light + fan off from the very first moment
    relayWrite(LOCK_RELAY_PIN, LOCK_RELAY_ACTIVE_LOW, false);
    for (int i = 0; i < SWITCH_COUNT; i++) {
      relayWrite(switches[i].pin, switches[i].activeLow, false);
    }

    dht.begin();
    connectWiFi();
  }

  void loop() {
    static unsigned long lastRead = 0;
    static unsigned long lastSync = 0;

    keepWiFiConnected();
    checkUnlockTimer();

    if (millis() - lastRead >= READ_INTERVAL_MS) {
      lastRead = millis();
      readRoom();
    }

    if (millis() - lastSync >= SYNC_INTERVAL_MS) {
      lastSync = millis();
      syncWithServer();
    }
  }
