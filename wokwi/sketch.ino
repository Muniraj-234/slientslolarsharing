// SuryaShare: intelligent load-sharing controller for a solar charging station.
// Wokwi demo on an ESP32 DevKit. One real second is one simulated minute.
//
//   Potentiometer (GPIO34)  = the sun, 0 to 4.1 kW of solar power
//   Slide switches P1..P4   = a vehicle plugs into / leaves that port
//   Slide switch QUEUE      = somebody is waiting for a port
//   Green LEDs (PWM)        = charging power of each port (brighter = more power)
//   Red LED                 = load sharing is active (demand is above supply)
//   LCD 20x4                = kiosk display: budget, each port's share, waiting time
//
// In the real unit the potentiometer is replaced by PV voltage/current sensing, the LEDs by
// MOSFET or DC-DC charger setpoints, and the vehicle battery model below by INA219 readings.

#include <Wire.h>
#include <LiquidCrystal_I2C.h>
#include "allocator.h"

const int N_PORTS = 4;
const int PIN_SUN = 34;
const int PIN_PLUG[N_PORTS] = {4, 18, 19, 23};
const int PIN_PWM[N_PORTS]  = {25, 26, 27, 14};
const int PIN_QUEUE = 13;
const int PIN_ALARM = 2;

// Station ratings (watts, watt-hours)
const float PV_MAX_W = 4100, BUS_LIMIT_W = 5000, PORT_MAX_W = 1500;
const float BATT_WH = 10000, BATT_MAX_W = 3000, SOC_FLOOR = 20, SOC_DERATE = 30;
const float RAMP_W_PER_MIN = 500, FAIR_WH = 3000, FAIR_SOC = 80, TARGET_SOC = 90;

// The vehicle that uses each port in this demo
const char *NAME[N_PORTS]  = {"E-rickshaw", "E-scooter", "E-rickshaw", "E-cycle"};
const float MAX_W[N_PORTS] = {1200, 900, 1200, 300};
const float MIN_W[N_PORTS] = {300, 200, 300, 80};
const float CAP_WH[N_PORTS] = {5000, 3000, 5000, 600};

struct Port {
  bool present, done;
  float soc, startSoc, wh, demand, setW;
};
Port port[N_PORTS];
float battSoc = 60, pvW = 0, budgetW = 0, loadW = 0, demandW = 0;
bool sharing = false, waiting = false;
int waitMin = 0;

LiquidCrystal_I2C lcd(0x27, 20, 4);
unsigned long lastTick = 0;

void pwmBegin(int i) {
#if ESP_ARDUINO_VERSION_MAJOR >= 3
  ledcAttach(PIN_PWM[i], 1000, 8);
#else
  ledcSetup(i, 1000, 8);
  ledcAttachPin(PIN_PWM[i], i);
#endif
}
void pwmWrite(int i, int duty) {
#if ESP_ARDUINO_VERSION_MAJOR >= 3
  ledcWrite(PIN_PWM[i], duty);
#else
  ledcWrite(i, duty);
#endif
}

void setup() {
  Serial.begin(115200);
  for (int i = 0; i < N_PORTS; i++) {
    pinMode(PIN_PLUG[i], INPUT_PULLUP);
    pwmBegin(i);
    port[i] = {false, false, 0, 0, 0, 0, 0};
  }
  pinMode(PIN_QUEUE, INPUT_PULLUP);
  pinMode(PIN_ALARM, OUTPUT);
  lcd.init();
  lcd.backlight();
  lcd.setCursor(0, 0);
  lcd.print("SuryaShare");
  lcd.setCursor(0, 1);
  lcd.print("Load-sharing ctrl");
  delay(800);
  lcd.clear();
}

// One control cycle. dtMin is the simulated time step in minutes.
void controlStep(float dtMin) {
  float dtH = dtMin / 60.0f;

  // 1. Sources and limits
  pvW = analogRead(PIN_SUN) / 4095.0f * PV_MAX_W;
  float socD = clampf((battSoc - SOC_FLOOR) / (SOC_DERATE - SOC_FLOOR), 0, 1);
  float battAllowW = BATT_MAX_W * socD;
  budgetW = pvW + battAllowW;
  if (budgetW > BUS_LIMIT_W) budgetW = BUS_LIMIT_W;

  // 2. Who is plugged in, and what can each vehicle accept
  waiting = digitalRead(PIN_QUEUE) == LOW;
  demandW = 0;
  for (int i = 0; i < N_PORTS; i++) {
    bool plugged = digitalRead(PIN_PLUG[i]) == LOW;
    Port &p = port[i];
    if (plugged && !p.present) {                 // a vehicle just arrived
      p.present = true; p.done = false; p.wh = 0; p.setW = 0;
      p.soc = p.startSoc = random(15, 50);
    } else if (!plugged && p.present) {          // it left
      p.present = false; p.done = false; p.setW = 0;
    }
    p.demand = 0;
    if (p.present && !p.done) {
      float taper = p.soc < 80 ? 1.0f : 1.0f - 0.7f * (p.soc - 80) / 20.0f;   // batteries slow down near full
      p.demand = MAX_W[i] * taper;
      if (p.demand > PORT_MAX_W) p.demand = PORT_MAX_W;
      demandW += p.demand;
    }
  }

  // 3. Admission order: the least-charged session first, so nobody is starved when power is scarce
  int order[N_PORTS];
  for (int i = 0; i < N_PORTS; i++) order[i] = i;
  for (int a = 1; a < N_PORTS; a++) {
    int k = order[a], b = a - 1;
    while (b >= 0 && (port[order[b]].soc - port[order[b]].startSoc) > (port[k].soc - port[k].startSoc)) { order[b + 1] = order[b]; b--; }
    order[b + 1] = k;
  }

  // 4. Share the budget
  ShareItem items[N_PORTS];
  float target[N_PORTS];
  for (int j = 0; j < N_PORTS; j++) items[j] = {port[order[j]].demand, MIN_W[order[j]], 1.0f};
  shareOut(budgetW, items, N_PORTS, target);

  // 5. Apply setpoints: cut at once, raise gently
  loadW = 0;
  for (int j = 0; j < N_PORTS; j++) {
    Port &p = port[order[j]];
    if (target[j] < p.setW) p.setW = target[j];
    else {
      p.setW += RAMP_W_PER_MIN * dtMin;
      if (p.setW > target[j]) p.setW = target[j];
    }
    loadW += p.setW;
  }
  sharing = demandW > budgetW + 1;

  // 6. Battery: surplus solar charges it, a shortfall is drawn from it
  float net = pvW - loadW;
  if (net >= 0) {
    float ch = net > BATT_MAX_W ? BATT_MAX_W : net;
    battSoc += ch * 0.95f * dtH / BATT_WH * 100;
  } else {
    battSoc -= (-net) / 0.95f * dtH / BATT_WH * 100;
  }
  battSoc = clampf(battSoc, 0, 100);

  // 7. Vehicle batteries (simulated plant) and session end rules
  float soonest = 1e9;
  bool freePort = false;
  for (int i = 0; i < N_PORTS; i++) {
    Port &p = port[i];
    if (!p.present) { freePort = true; continue; }
    if (p.done) continue;
    float e = p.setW * dtH * 0.93f;
    p.wh += e;
    p.soc += e / CAP_WH[i] * 100;
    bool full = p.soc >= TARGET_SOC;
    bool fairUse = waiting && (p.wh >= FAIR_WH || p.soc >= FAIR_SOC);   // cap applies only while someone waits
    if (full || fairUse) { p.done = true; p.setW = 0; continue; }
    float stopSoc = waiting ? (p.soc > FAIR_SOC ? p.soc : FAIR_SOC) : TARGET_SOC;
    float needWh = (stopSoc - p.soc) / 100 * CAP_WH[i];
    if (waiting && FAIR_WH - p.wh < needWh) needWh = FAIR_WH - p.wh;
    float mins = needWh / (p.setW > 50 ? p.setW * 0.93f : 50) * 60;
    if (mins < soonest) soonest = mins;
  }
  for (int i = 0; i < N_PORTS; i++) if (port[i].present && port[i].done) soonest = 0;   // a finished vehicle only has to unplug
  waitMin = freePort ? 0 : (soonest > 999 ? 999 : (int)(soonest + 0.5f));

  // 8. Outputs
  for (int i = 0; i < N_PORTS; i++) pwmWrite(i, (int)(port[i].setW / PORT_MAX_W * 255));
  digitalWrite(PIN_ALARM, sharing ? HIGH : LOW);
}

void showLcd() {
  char line[24];
  snprintf(line, sizeof line, "SUN %3.1fkW AVL %3.1fkW", pvW / 1000, budgetW / 1000);
  lcd.setCursor(0, 0); lcd.print(line);
  for (int row = 0; row < 2; row++) {
    char a[10], b[10];
    for (int k = 0; k < 2; k++) {
      int i = row * 2 + k;
      char *s = k ? b : a;
      if (!port[i].present) snprintf(s, 10, "P%d ----", i + 1);
      else if (port[i].done) snprintf(s, 10, "P%d DONE", i + 1);
      else snprintf(s, 10, "P%d %4.2f", i + 1, port[i].setW / 1000);
    }
    if (row == 0) snprintf(line, sizeof line, "%-8s%-8s  kW", a, b);
    else snprintf(line, sizeof line, "%-8s%-8sB%3d", a, b, (int)battSoc);
    lcd.setCursor(0, row + 1); lcd.print(line);
  }
  if (waiting && waitMin == 0) snprintf(line, sizeof line, "%-20s", "QUEUE: PLUG IN NOW");
  else if (waiting) snprintf(line, sizeof line, "QUEUE: WAIT ~%3d min", waitMin);
  else snprintf(line, sizeof line, "%-20s", sharing ? "MODE: SHARING" : loadW > 1 ? "MODE: FULL POWER" : "MODE: IDLE");
  lcd.setCursor(0, 3); lcd.print(line);
}

// One JSON line per second: the same message the commercial unit publishes over MQTT to the SCADA server
void sendTelemetry() {
  Serial.printf("{\"pv_w\":%.0f,\"budget_w\":%.0f,\"load_w\":%.0f,\"demand_w\":%.0f,\"batt_soc\":%.1f,\"sharing\":%s,\"wait_min\":%d,\"ports\":[",
                pvW, budgetW, loadW, demandW, battSoc, sharing ? "true" : "false", waiting ? waitMin : -1);
  for (int i = 0; i < N_PORTS; i++) {
    Serial.printf("%s{\"id\":%d,\"present\":%s,\"set_w\":%.0f,\"soc\":%.0f}", i ? "," : "", i + 1,
                  port[i].present ? "true" : "false", port[i].setW, port[i].soc);
  }
  Serial.println("]}");
}

void loop() {
  unsigned long now = millis();
  if (now - lastTick >= 500) {      // 2 control cycles per second, each worth half a simulated minute
    lastTick = now;
    controlStep(0.5f);
    showLcd();
    static bool second = false;
    second = !second;
    if (second) sendTelemetry();
  }
}
