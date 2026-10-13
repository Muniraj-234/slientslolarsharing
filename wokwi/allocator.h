// SuryaShare sharing rule: weighted max-min share with a guaranteed minimum.
// Plain C++ with no Arduino dependencies, so the same file compiles on a PC for testing.
#pragma once

struct ShareItem {
  float demand;  // what the vehicle can accept right now (W)
  float minW;    // smallest useful charging power (W)
  float weight;  // 1 = normal, 2 = priority
};

static inline float clampf(float v, float lo, float hi) { return v < lo ? lo : (v > hi ? hi : v); }

// items must be in admission order (who is served first when power is scarce).
// out[i] receives the power setpoint for items[i]. n must be 16 or fewer.
static inline void shareOut(float budget, const ShareItem *items, int n, float *out) {
  bool adm[16];
  float rem = budget, wanted = 0;
  int count = 0;
  for (int i = 0; i < n; i++) {
    out[i] = 0;
    adm[i] = false;
    if (items[i].demand <= 0) continue;
    float m = items[i].minW < items[i].demand ? items[i].minW : items[i].demand;
    if (m <= rem + 1e-6f) { adm[i] = true; rem -= m; wanted += items[i].demand; count++; }
  }
  if (count == 0) return;
  if (wanted <= budget + 1e-6f) {            // enough for everyone
    for (int i = 0; i < n; i++) if (adm[i]) out[i] = items[i].demand;
    return;
  }
  // Find the level k where sum(clamp(k * weight, min, demand)) equals the budget.
  float lo = 0, hi = 1;
  for (int pass = 0; pass < 60; pass++) {
    float k = pass < 20 ? hi : (lo + hi) / 2, total = 0;
    for (int i = 0; i < n; i++) if (adm[i]) {
      float m = items[i].minW < items[i].demand ? items[i].minW : items[i].demand;
      total += clampf(k * items[i].weight, m, items[i].demand);
    }
    if (pass < 20) { if (total < budget) hi *= 2; else pass = 19; }   // grow hi until it overshoots
    else if (total > budget) hi = k; else lo = k;
  }
  for (int i = 0; i < n; i++) if (adm[i]) {
    float m = items[i].minW < items[i].demand ? items[i].minW : items[i].demand;
    out[i] = clampf(lo * items[i].weight, m, items[i].demand);
  }
}
