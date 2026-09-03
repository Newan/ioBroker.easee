"use strict";

const CHARGER_STATE_OBSERVATION_IDS = [
  46, 48, 68, 80, 96, 102, 103, 109, 111, 112, 113, 114, 120, 122, 124, 132,
  182, 183, 184, 185, 190, 191, 192, 193, 194, 195, 196, 197, 198, 199, 250,
];

const STATE_FIELDS_BY_OBSERVATION_ID = {
  46: "ledMode",
  48: "dynamicChargerCurrent",
  68: "wiFiAPEnabled",
  80: "chargerFirmware",
  96: "reasonForNoCurrent",
  102: "smartCharging",
  103: "cableLocked",
  109: "chargerOpMode",
  111: "dynamicCircuitCurrentP1",
  112: "dynamicCircuitCurrentP2",
  113: "dynamicCircuitCurrentP3",
  114: "outputCurrent",
  120: "totalPower",
  122: "energyPerHour",
  124: "lifetimeEnergy",
  132: "wiFiRSSI",
  182: "inCurrentT2",
  183: "inCurrentT3",
  184: "inCurrentT4",
  185: "inCurrentT5",
  190: "inVoltageT1T2",
  191: "inVoltageT1T3",
  192: "inVoltageT1T4",
  193: "inVoltageT1T5",
  194: "inVoltageT2T3",
  195: "inVoltageT2T4",
  196: "inVoltageT2T5",
  197: "inVoltageT3T4",
  198: "inVoltageT3T5",
  199: "inVoltageT4T5",
};

const VOLTAGE_FIELDS = [
  "inVoltageT1T2",
  "inVoltageT1T3",
  "inVoltageT1T4",
  "inVoltageT1T5",
  "inVoltageT2T3",
  "inVoltageT2T4",
  "inVoltageT2T5",
  "inVoltageT3T4",
  "inVoltageT3T5",
  "inVoltageT4T5",
];

function observationsToChargerState(responseData) {
  const observations = Array.isArray(responseData?.observations)
    ? responseData.observations
    : [];
  /** @type {Record<string, any>} */
  const chargerState = Object.fromEntries(
    Object.values(STATE_FIELDS_BY_OBSERVATION_ID).map((field) => [field, null]),
  );
  for (const observation of observations) {
    const field = STATE_FIELDS_BY_OBSERVATION_ID[observation.id];
    if (field !== undefined) {
      chargerState[field] = observation.value;
    }
  }
  const cloudObservation = observations.find(
    (observation) => observation.id === 250,
  );
  chargerState.isOnline = cloudObservation
    ? Boolean(cloudObservation.value)
    : true;
  chargerState.voltage = null;
  for (const field of VOLTAGE_FIELDS) {
    const value = chargerState[field];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      chargerState.voltage = value;
      break;
    }
  }
  return chargerState;
}

module.exports = { CHARGER_STATE_OBSERVATION_IDS, observationsToChargerState };
