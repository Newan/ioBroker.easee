"use strict";

const { expect } = require("chai");
const {
  CHARGER_STATE_OBSERVATION_IDS,
  observationsToChargerState,
} = require("../lib/observations.js");
const easeeEnums = require("../lib/enum.js");

describe("Easee charger observations", () => {
  it("maps observations to the legacy charger state fields", () => {
    const state = observationsToChargerState({
      observations: [
        { id: 103, value: true },
        { id: 109, value: 3 },
        { id: 120, value: 7.4 },
        { id: 194, value: 229.5 },
        { id: 250, value: true },
      ],
    });
    expect(state).to.include({
      cableLocked: true,
      chargerOpMode: 3,
      totalPower: 7.4,
      inVoltageT2T3: 229.5,
      voltage: 229.5,
      isOnline: true,
    });
  });

  it("uses the correct current and firmware observation IDs", () => {
    expect(CHARGER_STATE_OBSERVATION_IDS).to.include.members([80, 114, 250]);
    expect(CHARGER_STATE_OBSERVATION_IDS).not.to.include(82);
  });

  it("routes smart charging SignalR updates to the existing config state", () => {
    expect(easeeEnums.getNameByEnum(102)).to.equal(".config.smartCharging");
  });

  it("handles missing optional observations", () => {
    const state = observationsToChargerState({ observations: [] });
    expect(state.isOnline).to.equal(true);
    expect(state.voltage).to.equal(null);
    expect(state.totalPower).to.equal(null);
  });
});
