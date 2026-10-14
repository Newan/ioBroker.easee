![Logo](admin/easee.png)
# ioBroker.easee - NCIceWolf Fork

[![GitHub release](https://img.shields.io/github/v/release/NCIcewolf/ioBroker.easee?include_prereleases)](https://github.com/NCIceWolf/ioBroker.easee/releases)
[![Last commit](https://img.shields.io/github/last-commit/NCIcewolf/ioBroker.easee)](https://github.com/NCIcewolf/ioBroker.easee/commits)
[![License](https://img.shields.io/github/license/NCIcewolf/ioBroker.easee)](LICENSE)

> **Fork-Description:** This Fork offers updates and patches for the unmaintained [Newan/ioBroker.easee](https://github.com/Newan/ioBroker.easee)-Adapter
> (last Upstream-Release **1.0.10 in Juli 2023**).

## Easee Wallbox Adapter for ioBroker

Adapter to connect ioBroker to Easee Wallbox API (Cloud, not local!) to deliver status- and configuration data,
as well as offering the capability to control one or more wallboxes.

## Installation

```bash
iobroker url 'https://github.com/NCIceWolf/ioBroker.easee/tarball/master' easee
```

## Help

`chargerOpMode`-Codes:

| Code | Description |
|---|---|
| 0 | Offline |
| 1 | Disconnected |
| 2 | AwaitingStart |
| 3 | Charging |
| 4 | Completed |
| 5 | Error |
| 6 | ReadyToCharge |
| 7 | AwaitingAuthentication |
| 8 | DeAuthenticating |

`dynamicCircuitCurrentPX` -> All phases must be set within 500ms (script) otherwise all phases will be set to 0.    


## Changelog
<!--
  Placeholder for the next version (at the beginning of the line):
  ### **WORK IN PROGRESS**
-->
### 1.0.20 (2026-10-14) – Fork by NCIceWolf
* (NCIceWolf) Add Node.js version 26.x to workflow matrix by @NCIceWolf in https://github.com/NCIceWolf/ioBroker.easee/pull/220
* (NCIceWolf) Update GitHub Actions workflow and Node.js engine version by @NCIceWolf in https://github.com/NCIceWolf/ioBroker.easee/pull/223
* (dependabot) Updated many many dependencies

### 1.0.19 (2026-09-05) – Fork by NCIceWolf
* (NCIceWolf) updated dependencies
* (NCIceWolf) switched reading endpoints for charger states from "State" to "Get Observations" (changed by Easee on 01.09.26)
* (NCIceWolf) added Easee observation mapping

### 1.0.18 (2026-07-10) – Fork by NCIceWolf
* (NCIceWolf) updated dependencies

### 1.0.17 (2026-06-13) – Fork by NCIceWolf
* (NCIceWolf) updated dependencies
* (NCIceWolf) changed debugging and removed unnecessary "detailed info logging"
* (NCIceWolf) Reworked SignalR to only stay active while a car is connected

### 1.0.16 (2026-06-08) – Fork by NCIceWolf
* (NCIceWolf) updated dependencies
* (NCIceWolf) Refactor comments and improve error handling
* (NCIceWolf) Fix ESLint errors and code quality issues
* (NCIceWolf) Fix SignalR issues and set SignalR as default
* (NCIceWolf) Update dynamicCircuitCurrentPX timing requirement to 500ms

### 1.0.15 (2026-05-23) – Fork by NCIceWolf
* (NCIceWolf) updated dependencies
* (NCIceWolf) Refactor comments and improve error handling
* (NCIceWolf) Fix ESLint errors and code quality issues
* (NCIceWolf) Fix circuitMaxCurrentP2 assignment
* (NCIceWolf) Update dynamicCircuitCurrentPX timing requirement to 1000ms

### 1.0.14 (2026-01-06) – Fork by NCIceWolf
* (NCIceWolf) updated dependencies
* (NCIceWolf) updated copyright years
* (NCIceWolf) updated dependancy schedules
* (NCIceWolf) changed CodeQL analysis to advanced
  
### 1.0.12 (2025-09-01) – Fork by NCIceWolf
* (NCIceWolf) updated dependencies

### 1.0.11 (2025-08-01) – Fork by NCIceWolf
* (NCIceWolf) updated quite some dependencies

### 1.0.10 (2023-07-27)
* (Newan) fix version number

### 1.0.9 (2023-07-27)
* (walburgf)  changed API URL from api.easee.cloud to api.easee.com
* (walburgf)  created addition parameter in admin config to reduce/steer logging information for user
* (walburgf)  modified internationalization to use jsonConfig.json. this needs at least ioBroker.admin version 5
* (walburgf)  added dependency to admin >=v5.1.28

### 1.0.8 (2023-07-02)
* (Newan)  small fixes

### 1.0.7
* (Newan) Changed login URL

### 1.0.6
* (Newan) Changed that smart charging is editable

### 1.0.5
* (marwin79) More Features supported and convert values to expected datatypes

### 1.0.4
* (Newan) dynamicCircuitCurrentPX writeable (set all Phases in 500ms) to limit ampere

### 1.0.3
* (Newan) Adapter crash fixed an other bugfixes

### 1.0.1
* (Newan) Add circuitMaxCurrentPX to limit current ampere

### 1.0.0
* (Newan) Stable Version with SignalR

## License
MIT License

Copyright (c) 2026 Newan <iobroker@newan.de>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
