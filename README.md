# Silent Assistant: intelligent load-sharing controller for solar charging stations

A solar-powered charging station overloads when several users plug in together. This project is a
controller that treats the available power as a budget and shares it every second: fair allocation,
enforced limits, instant adaptation when users join or leave, a grid backup feed, and a kiosk that
shows each charger's status and the waiting time.

**Live demo (station dashboard):** https://muniraj-234.github.io/slientslolarsharing/

**Customer mobile app:** https://muniraj-234.github.io/slientslolarsharing/app.html

## What is in the demo

- **Live simulation** with a 3D station (10 ports, 10 kWp solar, 20 kWh battery, 3 kW grid backup)
- **SCADA** view: KPIs, alarms that name the problem, its cause and the automatic action, fault injection
- **Circuit and hardware**: live single-line diagram, 3D bench prototype (ESP32, INA219, MOSFET, relay), bill of materials
- **Business and schemes**: profit calculators and the Government of India schemes that apply

## Files

| File | Purpose |
|---|---|
| `index.html` | The 3D page (station model, controller, SCADA, business case) |
| `app.html` | Customer mobile app: live station power, slot booking, check-in and charging status |
| `model.js` | Station model and load-sharing controller, shared by the dashboard and the app |
| `station-link.js` | Snapshot and command link between the station and the customer app |
| `suryashare3d.js` | The two 3D scenes, built with three.js |
| `index-classic.html` | Earlier 2D version (6 ports, no backup feed) |
| `wokwi/` | ESP32 firmware and wiring for the Wokwi virtual prototype |

## Run locally

```bash
python -m http.server 8766
```

Then open http://localhost:8766/
