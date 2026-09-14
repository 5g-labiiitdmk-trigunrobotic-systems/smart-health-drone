/*
 * ESP32 + NEO-6M GPS -> smart-health-drone telemetry adapter.
 *
 * UNTESTED AGAINST REAL HARDWARE. Written against the TinyGPSPlus and
 * ESP32 WiFi/HTTPClient library documentation only, in an environment with
 * no physical ESP32 board or GPS module available. Validate wiring, baud
 * rate, and the parsed field values against your actual module before any
 * real flight use.
 *
 * Hardware assumed:
 *   - ESP32 dev board
 *   - NEO-6M (or similar) GPS module wired to a hardware UART
 *     (default here: UART2, RX=GPIO16, TX=GPIO17 -- adjust to your wiring)
 *   - No dedicated flight battery sensor is read here; `battery` is sent
 *     as a placeholder constant. Wire a real voltage divider / fuel gauge
 *     IC into an ADC pin and replace readBatteryPercent() if you need
 *     accurate battery reporting.
 *
 * Libraries required (install via Arduino IDE Library Manager or
 * PlatformIO):
 *   - TinyGPSPlus      (https://github.com/mikalhart/TinyGPSPlus)
 *   - WiFi.h, HTTPClient (bundled with the ESP32 Arduino core)
 *
 * Configure WIFI_SSID, WIFI_PASSWORD, SERVER_URL, DRONE_ID and API_KEY
 * below before flashing.
 */

#include <WiFi.h>
#include <HTTPClient.h>
#include <HardwareSerial.h>
#include <TinyGPSPlus.h>

// ---- Configuration: fill these in before flashing ----
const char* WIFI_SSID     = "YOUR_WIFI_SSID";
const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";
const char* SERVER_URL    = "http://your-server.example.com:8003/api/drone-telemetry";
const char* DRONE_ID      = "esp32-drone-1"; // must match the Drone ID entered in drone.html
const char* API_KEY       = "REPLACE_WITH_DRONE_TELEMETRY_API_KEY";

// GPS module wiring (adjust pins to match your board)
#define GPS_RX_PIN 16 // ESP32 RX2 <- GPS TX
#define GPS_TX_PIN 17 // ESP32 TX2 -> GPS RX
#define GPS_BAUD   9600

const unsigned long POST_INTERVAL_MS = 1500; // 1-2s as required

HardwareSerial gpsSerial(2); // UART2
TinyGPSPlus gps;
unsigned long lastPostAt = 0;

void connectWiFi() {
  Serial.print("Connecting to WiFi");
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.println();
  Serial.print("WiFi connected, IP: ");
  Serial.println(WiFi.localIP());
}

// Placeholder: no real battery sensor wired up. Replace with an ADC read
// through a voltage divider (or a fuel-gauge IC like MAX17048) scaled to
// a 0-100 percentage for accurate reporting.
float readBatteryPercent() {
  return -1; // negative = "unknown"; omitted from the payload below
}

void postTelemetry(double lat, double lng, double altitudeMeters, double headingDeg, double speedKmh) {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("WiFi not connected, skipping telemetry post.");
    return;
  }

  HTTPClient http;
  http.begin(SERVER_URL);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("x-api-key", API_KEY);

  // Built manually rather than pulling in ArduinoJson, to keep this sketch
  // dependency-light; switch to ArduinoJson's JsonDocument if the payload
  // grows more fields.
  String payload = "{";
  payload += "\"droneId\":\"" + String(DRONE_ID) + "\",";
  payload += "\"lat\":" + String(lat, 6) + ",";
  payload += "\"lng\":" + String(lng, 6) + ",";
  payload += "\"altitude\":" + String(altitudeMeters, 1) + ",";
  payload += "\"heading\":" + String(headingDeg, 1) + ",";
  payload += "\"speed\":" + String(speedKmh, 1);

  float battery = readBatteryPercent();
  if (battery >= 0) {
    payload += ",\"battery\":" + String(battery, 0);
  }
  payload += "}";

  int statusCode = http.POST(payload);
  if (statusCode == 200) {
    Serial.println("Telemetry posted OK.");
  } else {
    Serial.print("Telemetry post failed, HTTP status: ");
    Serial.println(statusCode);
    Serial.println(http.getString());
  }
  http.end();
}

void setup() {
  Serial.begin(115200);
  gpsSerial.begin(GPS_BAUD, SERIAL_8N1, GPS_RX_PIN, GPS_TX_PIN);
  connectWiFi();
}

void loop() {
  // Feed any available GPS bytes into the TinyGPSPlus parser continuously.
  while (gpsSerial.available() > 0) {
    gps.encode(gpsSerial.read());
  }

  unsigned long now = millis();
  if (now - lastPostAt >= POST_INTERVAL_MS) {
    lastPostAt = now;

    if (gps.location.isValid() && gps.location.isUpdated()) {
      double lat = gps.location.lat();
      double lng = gps.location.lng();
      double altitude = gps.altitude.isValid() ? gps.altitude.meters() : 0.0;
      double heading = gps.course.isValid() ? gps.course.deg() : 0.0;
      double speedKmh = gps.speed.isValid() ? gps.speed.kmph() : 0.0;

      postTelemetry(lat, lng, altitude, heading, speedKmh);
    } else {
      Serial.println("Waiting for a valid GPS fix...");
    }
  }
}
