'use strict';

const utils = require('@iobroker/adapter-core');

const axios = require('axios').default;
const signalR = require('@microsoft/signalr');
const objEnum = require('./lib/enum.js');

//Eigene Variablen
const apiUrl = 'https://api.easee.cloud';
const apiUrl2 = 'https://api.easee.cloud/api/';
const adapterIntervals = {}; //halten von allen Intervallen
let polltime = 30;
const minPollTimeEnergy = 120;
let roundCounter = 0;
const arrCharger = [];

//Variable für dynamicCircuitCurrentPX
let dynamicCircuitCurrentP1 = 0;
let dynamicCircuitCurrentP2 = 0;
let dynamicCircuitCurrentP3 = 0;

class Easee extends utils.Adapter {

    /**
     * @param {Partial<utils.AdapterOptions>} [options={}]
     */
    constructor(options) {
        super({
            ...options,
            name: 'easee',
        });

        this.accessToken = 'invalidTokenInitial';
        this.accessTokenExpiry = 0;

        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    /**
     * SignalR
     */
    startSignal(){
        const connection = new signalR.HubConnectionBuilder()
            .withUrl('https://api.easee.cloud/hubs/chargers', {
                accessTokenFactory: () => {
                    this.log.debug('signalR.HubConnectionBuilder');
                    return this.getAccessToken();
                }
            })
            .withAutomaticReconnect()
            .build();

        connection.on('ProductUpdate', data => {
            //haben einen neuen Wert über SignalR erhalten
            const data_name = objEnum.getNameByEnum(data.id);
            if (data_name == undefined) {
                this.log.debug('New SignalR-ID, possible new Value: ' + data.id);
                this.log.debug(JSON.stringify(data));
            } else {
                //Value is in ioBroker, update it
                const tmpValueId = data.mid + data_name;
                this.log.info('New value over SignalR for: ' + tmpValueId + ', value: ' + data.value);
                switch (data.dataType) {
                    case 2:
                        data.value = data.value == '1';
                        break;
                    case 3:
                        data.value = parseFloat(data.value);
                        break;
                    case 4:
                        data.value = parseInt(data.value);
                        break;
                    //case 6: JSON
                }
                this.setStateAsync(tmpValueId, { val: data.value, ack: true });
            }
        });

        connection.start().then(() => {
            //for each charger subscribe SignalR
            arrCharger.forEach(charger_id => {
                connection.send('SubscribeWithCurrentState', charger_id, true).then(() => {
                    this.log.info('Charger registrate in SignalR: ' + charger_id);
                });
            });
        });

        connection.onclose(() => {
            this.log.error('SignalR Verbindung beendet!!!- restart');
            this.startSignal();
        });

        connection.onreconnecting(error => {
            console.assert(connection.state === signalR.HubConnectionState.Reconnecting);
            this.log.error(`Connection lost due to error "${error}". Reconnecting.`);
        });
    }


    /**
     * Starten den Adapter
     */
    async onReady() {
        //initial Status melden
        await this.setStateAsync('info.connection', false, true);

        //Schauen ob die Polltime realistisch ist
        if (this.config.polltime < 1) {
            this.log.error('Interval in seconds to short -> got to default 30');
        } else {
            polltime = this.config.polltime;
        }
        // Testen ob der Login funktioniert
        if (this.config.username == '' || this.config.username == '+49') {
            this.log.error('No username set');
            return;
        } else if (this.config.client_secret == '') {
            this.log.error('No password set');
            return;
        }
        this.log.debug('Api login started');
        const accessToken = await this.getAccessToken(true);
        if (accessToken == 'invalidTokenInitial' || accessToken == '') {
            this.log.error('Login failed!');
            return;
        }

        //reset all to start
        this.arrCharger = [];

        // starten den Statuszyklus der API neu
        await this.readAllStates();

        if (this.config.signalR) {
            this.log.info('Starting SignalR');
            this.startSignal();
        }
    }

    /**
     * Clear all Timeouts an inform the USers
     */
    onUnload(callback) {
        try {
            clearTimeout(adapterIntervals.readAllStates);
            clearTimeout(adapterIntervals.updateDynamicCircuitCurrent);
            this.log.info('Adaptor easee cleaned up everything...');
            this.setStateAsync('info.connection', false, true);
            callback();
        } catch (e) {
            callback();
        }
    }


    /*****************************************************************************************/
    async readAllStates() {
        this.log.debug('read new states from the API');

        //Lesen alle Charger aus
        const tmpAllChargers = await this.getAllCharger();
        if (tmpAllChargers != undefined)  {
            tmpAllChargers.forEach(async charger => {
                //Prüfen ob wir das Object kennen
                if (!arrCharger.includes(charger.id)) {
                    //setzen als erstes alle Objekte
                    await this.setAllStatusObjects(charger);
                    await this.setAllConfigObjects(charger);

                    //meken uns den charger
                    arrCharger.push(charger.id);
                }

                this.log.debug('Charger found');
                this.log.debug(JSON.stringify(charger));
                try {

                    //Lesen den Status aus
                    const tmpChargerState = await this.getChargerState(charger.id);
                    //Lesen die config
                    const tmpChargerConfig = await this.getChargerConfig(charger.id);

                    //Setzen die Daten der Charger
                    await this.setNewStatusToCharger(charger, tmpChargerState);

                    //Setzen die Config zum Charger
                    await this.setConfigStatus(charger, tmpChargerConfig);

                    //setzen und erechnen der Energiedaten, aber gebremste
                    if(roundCounter > (minPollTimeEnergy/polltime)) {
                        //lesen der Energiedaten
                        const tmpChargerSession = await this.getChargerSession(charger.id);
                        //etzen die Objekte
                        this.setNewSessionToCharger(charger, tmpChargerSession);
                    }
                } catch (error) {
                    if (typeof error === 'string') {
                        this.log.error(error);
                    } else if (error instanceof Error) {
                        this.log.error(error.message);
                    }
                }

            });
        } else {
            this.log.warn('No Chargers found!');
        }

        //Energiedaten dürfen nur einmal in der Minute aufgerufen werden, daher müssen wir das bremsen
        if(roundCounter > (minPollTimeEnergy/polltime)) {
            this.log.debug('Hole Energiedaten: ' + roundCounter);
            roundCounter = 0;
        }
        //Zählen die Runde!
        roundCounter = roundCounter + 1;

        //Melden das Update
        await this.setStateAsync('lastUpdate', new Date().toLocaleTimeString(), true);
        adapterIntervals.readAllStates = setTimeout(this.readAllStates.bind(this), polltime * 1000);
    }

    /**
     * Is called if a subscribed state changes
     * @param {string} id
     * @param {ioBroker.State | null | undefined} state
     */
    onStateChange(id, state) {
        if (state) {
            // The state was changed
            this.log.debug(`state ${id} changed: ${state.val} (ack = ${state.ack})`);
            const tmpControl = id.split('.');
            if (tmpControl[3] == 'config') {
                // change config, wenn ack = false
                if (!state.ack) {
                    if (tmpControl[4] == 'circuitMaxCurrentP1' || tmpControl[4] == 'circuitMaxCurrentP2' || tmpControl[4] == 'circuitMaxCurrentP3') {

                        //Load site for Charger
                        this.getChargerSite(tmpControl[2]).then( (site) => {
                            this.log.debug('Update circuitMaxCurrent to: ' + state.val);
                            this.log.debug('Get infos from site:');
                            this.log.debug(JSON.stringify(site));

                            this.changeMaxCircuitConfig(site.id, site.circuits[0].id, state.val);
                            this.log.debug('Changes sent to API');
                        });
                    } else if (tmpControl[4] == 'dynamicCircuitCurrentP1' || tmpControl[4] == 'dynamicCircuitCurrentP2' || tmpControl[4] == 'dynamicCircuitCurrentP3') {

                        this.getChargerSite(tmpControl[2]).then( (site) => {
                            this.log.debug('Update dynamicCircuitCurrent to: ' + state.val);
                            this.log.debug('Get infos from site:');
                            this.log.debug(JSON.stringify(site));

                            //setze die WErte für das Update
                            switch(tmpControl[4]) {
                                case 'dynamicCircuitCurrentP1':
                                    dynamicCircuitCurrentP1 = Number(state.val);
                                    break;
                                case 'dynamicCircuitCurrentP2':
                                    dynamicCircuitCurrentP2 = Number(state.val);
                                    break;
                                case 'dynamicCircuitCurrentP3':
                                    dynamicCircuitCurrentP3 = Number(state.val);
                                    break;
                            }

                            //Warten mit dem Update 500ms um weitere Phasen zu setzen:
                            if (adapterIntervals.updateDynamicCircuitCurrent != null) {
                                clearTimeout(adapterIntervals.updateDynamicCircuitCurrent);
                                adapterIntervals.updateDynamicCircuitCurrent = null;

                            }
                            adapterIntervals.updateDynamicCircuitCurrent = setTimeout( async () => {
                                await this.changeCircuitConfig(site.id, site.circuits[0].id);
                            }, 500);

                        });

                    } else {
                        this.log.debug('update config to API: ' + id);
                        this.changeConfig(tmpControl[2], tmpControl[4], state.val);
                        this.log.debug('Changes sent to API');
                    }
                }
            } else {
                // control charger
                switch (tmpControl[4]) {
                    case 'start':
                        // Starten Ladevorgang
                        this.log.info('Starting charging for Charger.id: ' + tmpControl[2]);
                        this.startCharging(tmpControl[2]);
                        break;
                    case 'stop':
                        //  Stopen Ladevorgang
                        this.log.info('Stopping charging for Charger.id: ' + tmpControl[2]);
                        this.stopCharging(tmpControl[2]);
                        break;
                    case 'pause':
                        //  Pausiere Ladevorgang
                        this.log.info('Pause charging for Charger.id: ' + tmpControl[2]);
                        this.pauseCharging(tmpControl[2]);
                        break;
                    case 'resume':
                        //  Resume Ladevorgang
                        this.log.info('Resume charging for Charger.id: ' + tmpControl[2]);
                        this.resumeCharging(tmpControl[2]);
                        break;
                    case 'reboot':
                        //  Reboot Charger
                        this.log.info('Reboot Charger.id: ' + tmpControl[2]);
                        this.rebootCharging(tmpControl[2]);
                        break;
                    default:
                        this.log.error('No command for Control found for: ' + id);
                }
            }
        } else {
            // The state was deleted
            this.log.info(`state ${id} deleted`);
        }
    }

    /***********************************************************************
     * Funktionen für Status der Reading um den Code aufgeräumter zu machen
     ***********************************************************************/

    //Setzen alle Status für Charger
    async setNewStatusToCharger(charger, charger_states) {
        await this.setStateAsync(charger.id + '.name', charger.name, true);
        await this.setStateAsync(charger.id + '.status.cableLocked', charger_states.cableLocked, true);
        await this.setStateAsync(charger.id + '.status.chargerOpMode', charger_states.chargerOpMode, true);
        await this.setStateAsync(charger.id + '.status.totalPower', charger_states.totalPower, true);
        await this.setStateAsync(charger.id + '.status.wiFiRSSI', charger_states.wiFiRSSI, true);
        await this.setStateAsync(charger.id + '.status.chargerFirmware', charger_states.chargerFirmware, true);
        await this.setStateAsync(charger.id + '.status.latestFirmware', charger_states.latestFirmware, true);
        await this.setStateAsync(charger.id + '.status.reasonForNoCurrent', charger_states.reasonForNoCurrent, true);
        await this.setStateAsync(charger.id + '.status.voltage', charger_states.voltage, true);
        await this.setStateAsync(charger.id + '.status.outputCurrent', charger_states.outputCurrent, true);
        await this.setStateAsync(charger.id + '.status.isOnline', charger_states.isOnline, true);
        await this.setStateAsync(charger.id + '.status.wiFiAPEnabled', charger_states.wiFiAPEnabled, true);
        await this.setStateAsync(charger.id + '.status.ledMode', charger_states.ledMode, true);
        await this.setStateAsync(charger.id + '.status.lifetimeEnergy', charger_states.lifetimeEnergy, true);
        await this.setStateAsync(charger.id + '.status.energyPerHour', charger_states.energyPerHour, true);
        await this.setStateAsync(charger.id + '.status.inCurrentT2', charger_states.inCurrentT2, true);
        await this.setStateAsync(charger.id + '.status.inCurrentT3', charger_states.inCurrentT3, true);
        await this.setStateAsync(charger.id + '.status.inCurrentT4', charger_states.inCurrentT4, true);
        await this.setStateAsync(charger.id + '.status.inCurrentT5', charger_states.inCurrentT5, true);
        await this.setStateAsync(charger.id + '.status.inVoltageT1T2', charger_states.inVoltageT1T2, true);
        await this.setStateAsync(charger.id + '.status.inVoltageT1T3', charger_states.inVoltageT1T3, true);
        await this.setStateAsync(charger.id + '.status.inVoltageT1T4', charger_states.inVoltageT1T4, true);
        await this.setStateAsync(charger.id + '.status.inVoltageT1T5', charger_states.inVoltageT1T5, true);
        await this.setStateAsync(charger.id + '.status.inVoltageT2T3', charger_states.inVoltageT2T3, true);
        await this.setStateAsync(charger.id + '.status.inVoltageT2T4', charger_states.inVoltageT2T4, true);
        await this.setStateAsync(charger.id + '.status.inVoltageT2T5', charger_states.inVoltageT2T5, true);
        await this.setStateAsync(charger.id + '.status.inVoltageT3T4', charger_states.inVoltageT3T4, true);
        await this.setStateAsync(charger.id + '.status.inVoltageT3T5', charger_states.inVoltageT3T5, true);
        await this.setStateAsync(charger.id + '.status.inVoltageT4T5', charger_states.inVoltageT4T5, true);

        //wert der config wird nur hier gesendet
        await this.setStateAsync(charger.id + '.config.dynamicChargerCurrent', { val: charger_states.dynamicChargerCurrent, ack: true });
        await this.setStateAsync(charger.id + '.config.dynamicCircuitCurrentP1', { val: charger_states.dynamicCircuitCurrentP1, ack: true });
        await this.setStateAsync(charger.id + '.config.dynamicCircuitCurrentP2', { val: charger_states.dynamicCircuitCurrentP2, ack: true });
        await this.setStateAsync(charger.id + '.config.dynamicCircuitCurrentP3', { val: charger_states.dynamicCircuitCurrentP3, ack: true });
        await this.setStateAsync(charger.id + '.config.smartCharging', charger_states.smartCharging, true);
    }

    //Setzen alle Status für Config
    async setConfigStatus(charger, charger_config) {
        await this.setStateAsync(charger.id + '.config.isEnabled',{ val: charger_config.isEnabled, ack: true } );
        await this.setStateAsync(charger.id + '.config.phaseMode', { val: charger_config.phaseMode, ack: true });
        await this.setStateAsync(charger.id + '.config.ledStripBrightness', { val: charger_config.ledStripBrightness, ack: true });
        await this.setStateAsync(charger.id + '.config.smartButtonEnabled', { val: charger_config.smartButtonEnabled, ack: true });
        await this.setStateAsync(charger.id + '.config.wiFiSSID', { val: charger_config.wiFiSSID, ack: true });
        await this.setStateAsync(charger.id + '.config.maxChargerCurrent', { val: charger_config.maxChargerCurrent, ack: true });

        //Values for sites
        await this.setStateAsync(charger.id + '.config.circuitMaxCurrentP1', { val: charger_config.circuitMaxCurrentP1, ack: true });
        await this.setStateAsync(charger.id + '.config.circuitMaxCurrentP2', { val: charger_config.circuitMaxCurrentP3, ack: true });
        await this.setStateAsync(charger.id + '.config.circuitMaxCurrentP3', { val: charger_config.circuitMaxCurrentP3, ack: true });
    }

    /*************************************************************************
     * API CALLS
     * //Todo auslagern in eigene Datei ?
     **************************************************************************/

    async getAccessToken(login = false, renew = false) {

        if (login) {
            try {
                const response = await axios.post(apiUrl + '/api/accounts/token', {
                    userName: this.config.username,
                    password: this.config.client_secret
                });

                this.log.info('Easee Api Login successful');

                this.accessToken = response.data.accessToken;
                this.refreshToken = response.data.refreshToken;
                this.accessTokenExpiry = Date.now() + (response.data.expiresIn / 2) * 1000;
                this.log.debug(JSON.stringify(response.data));
                this.setStateAsync('info.connection', true, true);
            } catch (error) {
                this.log.error('Api login error - check Username and password');
                if (typeof error === 'string') {
                    this.log.error(error);
                } else if (error instanceof Error) {
                    this.log.error(error.message);
                }
                this.accessToken = '';
                await this.setStateAsync('info.connection', false, true);
            }
        }

        if (this.accessTokenExpiry <= Date.now() || renew) {
            try {
                const response = await axios.post(apiUrl + '/api/accounts/refresh_token', {
                    accessToken: this.accessToken,
                    refreshToken: this.refreshToken
                });
                this.log.info('RefreshToken successful');
                this.accessToken = response.data.accessToken;
                this.refreshToken = response.data.refreshToken;
                this.accessTokenExpiry = Date.now() + (response.data.expiresIn / 2) * 1000;

                this.log.debug(JSON.stringify(response.data));
            } catch (error) {
                this.log.error('RefreshToken error');
                this.log.error(error);
            }
        }

        return this.accessToken;
    }
    /* XXX

    apiGetRequest

    apiPostRequest

    apiRequest
        getToken
        if failed (depend on error code) force_renew/re-login/retry
        if failed -> fail
    */

    async apiRequest(apiPath, postData) {
        const accessToken = await this.getAccessToken();
        let response = {};
        try {
            if (!postData) {
                // GET request
                response = await axios.get(apiUrl2 + apiPath,
                    {
                        headers: { 'Authorization': `Bearer ${accessToken}` }
                    });
            } else {
                // POST request
                this.log.debug(`POST DATA: ${JSON.stringify(postData)}`);
                response = await axios.post(apiUrl2 + apiPath, postData,
                    {
                        headers: { 'Authorization': `Bearer ${accessToken}` }
                    });
            }
            this.log.info(`apiGetRequest successful: ${apiPath}`);
            this.log.debug(JSON.stringify(response.data));
        } catch (error) {
            this.log.error(`apiGetRequest error: ${apiPath}`);
            this.log.error(error);
        }
        return response.data;
    }

    async apiGetRequest(apiPath) {
        return await this.apiRequest(apiPath);
    }
    async apiPostRequest(apiPath, postData) {
        return await this.apiRequest(apiPath, postData);
    }

    //Lese alle Charger aus
    async getAllCharger(){
        this.log.debug('Chargers ausgelesen');
        return await this.apiGetRequest('chargers');
    }

    // Lese den Charger aus
    async getChargerState(charger_id){
        return await this.apiGetRequest('chargers/' + charger_id +'/state');
    }

    async getChargerConfig(charger_id){
        return await this.apiGetRequest('chargers/' + charger_id +'/config');
    }

    async getChargerSite(charger_id){
        return await this.apiGetRequest('chargers/' + charger_id +'/site');
    }

    async getChargerSession(charger_id){
        return await this.apiGetRequest('sessions/charger/' + charger_id +'/monthly');
    }

    async startCharging(charger_id) {
        return await this.apiGetRequest('chargers/' + charger_id +'/commands/start_charging');
    }

    async stopCharging(charger_id) {
        return await this.apiGetRequest('chargers/' + charger_id +'/commands/stop_charging');
    }

    async pauseCharging(charger_id) {
        return await this.apiGetRequest('chargers/' + charger_id +'/commands/pause_charging');
    }

    async resumeCharging(charger_id) {
        return await this.apiGetRequest('chargers/' + charger_id +'/commands/resume_charging');
    }

    async rebootCharging(charger_id) {
        return await this.apiGetRequest('chargers/' + charger_id +'/commands/reboot');
    }


    async changeConfig(charger_id, configvalue, value) {
        this.log.debug('changeConfig');
        return await this.apiPostRequest('chargers/' + charger_id + '/settings', {
            [configvalue]: value
        });
    }

    //circuitMaxCurrentPX
    async changeMaxCircuitConfig(site_id, circuit_id, value) {
        this.log.debug('changeMaxCircuitConfig');
        await this.apiPostRequest('sites/' + site_id + '/circuits/' + circuit_id + '/settings', {
            'maxCircuitCurrentP1': value,
            'maxCircuitCurrentP2': value,
            'maxCircuitCurrentP3': value,
        });
    }

    //dynamicCircuitCurrentPX
    async changeCircuitConfig(site_id, circuit_id) {
        this.log.debug('changeCircuitConfig');

        //Der Wert darf nur für 3 Fach Wwrte aktualisiert werden
        await this.apiPostRequest('sites/' + site_id + '/circuits/' + circuit_id + '/settings', {
            'dynamicCircuitCurrentP1': dynamicCircuitCurrentP1,
            'dynamicCircuitCurrentP2': dynamicCircuitCurrentP2,
            'dynamicCircuitCurrentP3': dynamicCircuitCurrentP3
        });

        //setze Werte zurück
        adapterIntervals.updateDynamicCircuitCurrent = null;
        dynamicCircuitCurrentP1 = 0;
        dynamicCircuitCurrentP2 = 0;
        dynamicCircuitCurrentP3 = 0;

    }


    /***********************************************************************
     * Funktionen zum erstellen der Objekte der Reading
    ***********************************************************************/

    async setAllStatusObjects(charger) {
        //Legen die Steuerungsbutton für jeden Charger an
        await this.setObjectNotExistsAsync(charger.id + '.control.start', {
            type: 'state',
            common: {
                name: 'Start charging',
                type: 'boolean',
                role: 'button',
                read: true,
                write: true,
            },
            native: {},
        });
        this.subscribeStates(charger.id + '.control.start');

        await this.setObjectNotExistsAsync(charger.id + '.control.stop', {
            type: 'state',
            common: {
                name: 'Stop charging',
                type: 'boolean',
                role: 'button',
                read: false,
                write: true,
            },
            native: {},
        });
        this.subscribeStates(charger.id + '.control.stop');

        await this.setObjectNotExistsAsync(charger.id + '.control.pause', {
            type: 'state',
            common: {
                name: 'Pause charging',
                type: 'boolean',
                role: 'button',
                read: false,
                write: true,
            },
            native: {},
        });
        this.subscribeStates(charger.id + '.control.pause');

        await this.setObjectNotExistsAsync(charger.id + '.control.resume', {
            type: 'state',
            common: {
                name: 'Resume charging',
                type: 'boolean',
                role: 'button',
                read: false,
                write: true,
            },
            native: {},
        });
        this.subscribeStates(charger.id + '.control.resume');

        await this.setObjectNotExistsAsync(charger.id + '.control.reboot', {
            type: 'state',
            common: {
                name: 'Reboot Charger',
                type: 'boolean',
                role: 'button',
                read: true,
                write: true,
            },
            native: {},
        });
        this.subscribeStates(charger.id + '.control.reboot');

        //id
        await this.setObjectNotExistsAsync(charger.id + '.id', {
            type: 'state',
            common: {
                name: 'id',
                type: 'string',
                role: 'info.name',
                read: true,
                write: false,
            },
            native: {},
        });
        await this.setStateAsync(charger.id + '.id', charger.id, true);

        //name
        await this.setObjectNotExistsAsync(charger.id + '.name', {
            type: 'state',
            common: {
                name: 'name',
                type: 'string',
                role: 'info.name',
                read: true,
                write: false,
            },
            native: {},
        });

        //"cableLocked": true,
        await this.setObjectNotExistsAsync(charger.id + '.status.cableLocked', {
            type: 'state',
            common: {
                name: 'Cable lock state',
                type: 'boolean',
                role: 'value.lock',
                read: true,
                write: false,
            },
            native: {},
        });

        //"chargerOpMode": 1,
        await this.setObjectNotExistsAsync(charger.id + '.status.chargerOpMode', {
            type: 'state',
            common: {
                name: 'Charger operation mode according to charger mode table',
                type: 'number',
                role: 'value',
                read: true,
                write: false,
            },
            native: {},
        });

        //"totalPower": 0,
        await this.setObjectNotExistsAsync(charger.id + '.status.totalPower', {
            type: 'state',
            common: {
                name: 'Total power [kW]',
                type: 'number',
                role: 'value',
                read: true,
                write: false,
            },
            native: {},
        });

        //"wiFiRSSI": 0,
        await this.setObjectNotExistsAsync(charger.id + '.status.wiFiRSSI', {
            type: 'state',
            common: {
                name: 'WiFi signal strength [dBm]',
                type: 'number',
                role: 'value',
                read: true,
                write: false,
            },
            native: {},
        });

        //"chargerFirmware": 0,
        await this.setObjectNotExistsAsync(charger.id + '.status.chargerFirmware', {
            type: 'state',
            common: {
                name: 'Modem firmware version',
                type: 'number',
                role: 'value',
                read: true,
                write: false,
            },
            native: {},
        });

        //"latestFirmware": 0,
        await this.setObjectNotExistsAsync(charger.id + '.status.latestFirmware', {
            type: 'state',
            common: {
                name: 'Latest Modem firmware version',
                type: 'number',
                role: 'value',
                read: true,
                write: false,
            },
            native: {},
        });

        //"reasonForNoCurrent": 0,
        await this.setObjectNotExistsAsync(charger.id + '.status.reasonForNoCurrent', {
            type: 'state',
            common: {
                name: 'Reason for not offering current to the car',
                type: 'number',
                role: 'value',
                read: true,
                write: false,
            },
            native: {},
        });

        //"voltage": 0,
        await this.setObjectNotExistsAsync(charger.id + '.status.voltage', {
            type: 'state',
            common: {
                name: 'voltage',
                type: 'number',
                role: 'value.voltage',
                read: true,
                write: false,
            },
            native: {},
        });

        //"outputCurrent": 0,
        await this.setObjectNotExistsAsync(charger.id + '.status.outputCurrent', {
            type: 'state',
            common: {
                name: 'Active output phase(s) to EV according to output phase type table.',
                type: 'number',
                role: 'value.current',
                read: true,
                write: false,
            },
            native: {},
        });

        //"inCurrentT2": 0,
        await this.setObjectNotExistsAsync(charger.id + '.status.inCurrentT2', {
            type: 'state',
            common: {
                name: 'Current RMS for input T2 [Amperes]',
                type: 'number',
                role: 'value.current',
                read: true,
                write: false,
            },
            native: {},
        });

        //"inCurrentT3": 0,
        await this.setObjectNotExistsAsync(charger.id + '.status.inCurrentT3', {
            type: 'state',
            common: {
                name: 'Current RMS for input T3 [Amperes]',
                type: 'number',
                role: 'value.current',
                read: true,
                write: false,
            },
            native: {},
        });

        //"inCurrentT4": 0,
        await this.setObjectNotExistsAsync(charger.id + '.status.inCurrentT4', {
            type: 'state',
            common: {
                name: 'Current RMS for input T4 [Amperes]',
                type: 'number',
                role: 'value.current',
                read: true,
                write: false,
            },
            native: {},
        });

        //"inCurrentT5": 0,
        await this.setObjectNotExistsAsync(charger.id + '.status.inCurrentT5', {
            type: 'state',
            common: {
                name: 'Current RMS for input T5 [Amperes]',
                type: 'number',
                role: 'value.current',
                read: true,
                write: false,
            },
            native: {},
        });

        //"inVoltageT1T2": 0,
        await this.setObjectNotExistsAsync(charger.id + '.status.inVoltageT1T2', {
            type: 'state',
            common: {
                name: 'Current Voltage for between inputs T1 and T2 [Volts]',
                type: 'number',
                role: 'value.voltage',
                read: true,
                write: false,
            },
            native: {},
        });
        //"inVoltageT1T3": 0,
        await this.setObjectNotExistsAsync(charger.id + '.status.inVoltageT1T3', {
            type: 'state',
            common: {
                name: 'Current Voltage for between inputs T1 and T3 [Volts]',
                type: 'number',
                role: 'value.voltage',
                read: true,
                write: false,
            },
            native: {},
        });
        //"inVoltageT1T4": 0,
        await this.setObjectNotExistsAsync(charger.id + '.status.inVoltageT1T4', {
            type: 'state',
            common: {
                name: 'Current Voltage for between inputs T1 and T4 [Volts]',
                type: 'number',
                role: 'value.voltage',
                read: true,
                write: false,
            },
            native: {},
        });
        //"inVoltageT1T5": 0,
        await this.setObjectNotExistsAsync(charger.id + '.status.inVoltageT1T5', {
            type: 'state',
            common: {
                name: 'Current Voltage for between inputs T1 and T5 [Volts]',
                type: 'number',
                role: 'value.voltage',
                read: true,
                write: false,
            },
            native: {},
        });
        //"inVoltageT2T3": 0,
        await this.setObjectNotExistsAsync(charger.id + '.status.inVoltageT2T3', {
            type: 'state',
            common: {
                name: 'Current Voltage for between inputs T2 and T3 [Volts]',
                type: 'number',
                role: 'value.voltage',
                read: true,
                write: false,
            },
            native: {},
        });
        //"inVoltageT2T4": 0,
        await this.setObjectNotExistsAsync(charger.id + '.status.inVoltageT2T4', {
            type: 'state',
            common: {
                name: 'Current Voltage for between inputs T2 and T4 [Volts]',
                type: 'number',
                role: 'value.voltage',
                read: true,
                write: false,
            },
            native: {},
        });
        //"inVoltageT2T5": 0,
        await this.setObjectNotExistsAsync(charger.id + '.status.inVoltageT2T5', {
            type: 'state',
            common: {
                name: 'Current Voltage for between inputs T2 and T5 [Volts]',
                type: 'number',
                role: 'value.voltage',
                read: true,
                write: false,
            },
            native: {},
        });
        //"inVoltageT3T4": 0,
        await this.setObjectNotExistsAsync(charger.id + '.status.inVoltageT3T4', {
            type: 'state',
            common: {
                name: 'Current Voltage for between inputs T3 and T4 [Volts]',
                type: 'number',
                role: 'value.voltage',
                read: true,
                write: false,
            },
            native: {},
        });
        //"inVoltageT3T5": 0,
        await this.setObjectNotExistsAsync(charger.id + '.status.inVoltageT3T5', {
            type: 'state',
            common: {
                name: 'Current Voltage for between inputs T3 and T5 [Volts]',
                type: 'number',
                role: 'value.voltage',
                read: true,
                write: false,
            },
            native: {},
        });
        //"inVoltageT4T5": 0,
        await this.setObjectNotExistsAsync(charger.id + '.status.inVoltageT4T5', {
            type: 'state',
            common: {
                name: 'Current Voltage for between inputs T4 and T5 [Volts]',
                type: 'number',
                role: 'value.voltage',
                read: true,
                write: false,
            },
            native: {},
        });

        //"isOnline": true,
        await this.setObjectNotExistsAsync(charger.id + '.status.isOnline', {
            type: 'state',
            common: {
                name: 'isOnline',
                type: 'boolean',
                role: 'indicator.reachable',
                read: true,
                write: false,
            },
            native: {},
        });

        //"wiFiAPEnabled": true,
        await this.setObjectNotExistsAsync(charger.id + '.status.wiFiAPEnabled', {
            type: 'state',
            common: {
                name: 'True if WiFi Access Point is enabled, otherwise false',
                type: 'boolean',
                role: 'value',
                read: true,
                write: false,
            },
            native: {},
        });

        //"ledMode": true,
        await this.setObjectNotExistsAsync(charger.id + '.status.ledMode', {
            type: 'state',
            common: {
                name: 'Charger LED mode',
                type: 'number',
                role: 'value',
                read: true,
                write: false,
            },
            native: {},
        });

        //"lifetimeEnergy": 0,
        await this.setObjectNotExistsAsync(charger.id + '.status.lifetimeEnergy', {
            type: 'state',
            common: {
                name: 'Accumulated energy in the lifetime of the charger [kWh]',
                type: 'number',
                role: 'value',
                read: true,
                write: false,
            },
            native: {},
        });

        //"energyPerHour": 0,
        await this.setObjectNotExistsAsync(charger.id + '.status.energyPerHour', {
            type: 'state',
            common: {
                name: 'Accumulated energy per hour [kWh]',
                type: 'number',
                role: 'value',
                read: true,
                write: false,
            },
            native: {},
        });

        //"energyPerHour": 0,
        await this.setObjectNotExistsAsync(charger.id + '.status.energyPerHour', {
            type: 'state',
            common: {
                name: 'Accumulated energy per hour [kWh]',
                type: 'number',
                role: 'value',
                read: true,
                write: false,
            },
            native: {},
        });

        // Ab hier nur Objekte die über SignalR kommen
        //TempMax
        await this.setObjectNotExistsAsync(charger.id + '.status.TempMax', {
            type: 'state',
            common: {
                name:'SignaleR only: Maximum temperature for all sensors [Celsius]',
                type: 'number',
                role: 'value.temperature.max',
                read: true,
                write: false,
            },
            native: {},
        });


    }

    /*************** Session Reading ****************/
    async setNewSessionToCharger(charger, charger_session) {
        this.log.debug(JSON.stringify(charger_session));
        charger_session.forEach(async session => {

            //für jeden Monat errechnen wir das?
            await this.setObjectNotExistsAsync(charger.id + '.session.' + session.year + '.' + session.month+ '.totalEnergyUsage', {
                type: 'state',
                common: {
                    name: 'totalEnergyUsage',
                    type: 'number',
                    role: 'value',
                    read: true,
                    write: false,
                },
                native: {},
            });
            await this.setStateAsync(charger.id + '.session.' + session.year + '.' + session.month+ '.totalEnergyUsage', session.totalEnergyUsage, true);

            await this.setObjectNotExistsAsync(charger.id + '.session.' + session.year + '.' + session.month+ '.totalCost', {
                type: 'state',
                common: {
                    name: 'totalCost',
                    type: 'number',
                    role: 'value',
                    read: true,
                    write: false,
                },
                native: {},
            });
            await this.setStateAsync(charger.id + '.session.' + session.year + '.' + session.month+ '.totalCost', session.totalCost, true);

            await this.setObjectNotExistsAsync(charger.id + '.session.' + session.year + '.' + session.month+ '.currencyId', {
                type: 'state',
                common: {
                    name: 'currencyId',
                    type: 'string',
                    role: 'value',
                    read: true,
                    write: false,
                },
                native: {},
            });
            await this.setStateAsync(charger.id + '.session.' + session.year + '.' + session.month+ '.currencyId', session.currencyId, true);

            await this.setObjectNotExistsAsync(charger.id + '.session.' + session.year + '.total_year', {
                type: 'state',
                common: {
                    name: 'total_year',
                    type: 'number',
                    role: 'value',
                    read: true,
                    write: false,
                },
                native: {},
            });


        });

        let tmpYear = 1970;
        let tmpYearCount = 0;
        charger_session.forEach(session => {
            //Jahreszähler umhängen
            this.log.debug('set session year data');
            if (tmpYear != session.year) {
                //neues Jahr setzen alles zurück
                this.setStateAsync(charger.id + '.session.' + session.year + '.total_year', session.totalEnergyUsage, true);
                tmpYearCount = session.totalEnergyUsage;
                tmpYear = session.year;
            } else {
                tmpYearCount = tmpYearCount + session.totalEnergyUsage;
                this.setStateAsync(charger.id + '.session.' + session.year + '.total_year', tmpYearCount, true);
            }
        });

    }

    /*************** Config Reading ****************/
    async setAllConfigObjects(charger) {

        //isEnabled
        await this.setObjectNotExistsAsync(charger.id + '.config.isEnabled', {
            type: 'state',
            common: {
                name: 'Set true to enable charger, false disables charger',
                type: 'boolean',
                role: 'value',
                read: true,
                write: false,
            },
            native: {},
        });
        this.subscribeStates(charger.id + '.config.isEnabled');

        //phaseMode
        await this.setObjectNotExistsAsync(charger.id + '.config.phaseMode', {
            type: 'state',
            common: {
                name: 'Phase mode on this charger. 1-Locked to 1-Phase, 2-Auto, 3-Locked to 3-phase(only Home)',
                type: 'number',
                role: 'value',
                read: true,
                write: true,
            },
            native: {},
        });
        this.subscribeStates(charger.id + '.config.phaseMode');

        //maxChargerCurrent
        await this.setObjectNotExistsAsync(charger.id + '.config.maxChargerCurrent', {
            type: 'state',
            common: {
                name: 'Max current this charger is allowed to offer to car (A)',
                type: 'number',
                role: 'value.current',
                read: true,
                write: true,
            },
            native: {},
        });
        this.subscribeStates(charger.id + '.config.maxChargerCurrent');


        //dynamicChargerCurrent
        await this.setObjectNotExistsAsync(charger.id + '.config.dynamicChargerCurrent', {
            type: 'state',
            common: {
                name: 'Dynamic max current this charger is allowed to offer to car (A)',
                type: 'number',
                role: 'value.current',
                read: true,
                write: true,
            },
            native: {},
        });
        this.subscribeStates(charger.id + '.config.dynamicChargerCurrent');

        await this.setObjectNotExistsAsync(charger.id + '.config.dynamicCircuitCurrentP1', {
            type: 'state',
            common: {
                name:'Dynamically set circuit maximum current for phase 1 [Amperes]',
                type: 'number',
                role: 'value.current',
                read: true,
                write: true,
            },
            native: {},
        });
        this.subscribeStates(charger.id + '.config.dynamicCircuitCurrentP1');

        await this.setObjectNotExistsAsync(charger.id + '.config.dynamicCircuitCurrentP2', {
            type: 'state',
            common: {
                name:'Dynamically set circuit maximum current for phase 2 [Amperes]',
                type: 'number',
                role: 'value.current',
                read: true,
                write: true,
            },
            native: {},
        });
        this.subscribeStates(charger.id + '.config.dynamicCircuitCurrentP2');

        await this.setObjectNotExistsAsync(charger.id + '.config.dynamicCircuitCurrentP3', {
            type: 'state',
            common: {
                name:'Dynamically set circuit maximum current for phase 3 [Amperes]',
                type: 'number',
                role: 'value.current',
                read: true,
                write: true,
            },
            native: {},
        });
        this.subscribeStates(charger.id + '.config.dynamicCircuitCurrentP3');

        await this.setObjectNotExistsAsync(charger.id + '.config.circuitMaxCurrentP1', {
            type: 'state',
            common: {
                name:'Set circuit maximum current [Amperes]',
                type: 'number',
                role: 'value.current',
                read: true,
                write: true,
            },
            native: {},
        });
        this.subscribeStates(charger.id + '.config.circuitMaxCurrentP1');

        await this.setObjectNotExistsAsync(charger.id + '.config.circuitMaxCurrentP2', {
            type: 'state',
            common: {
                name:'Set circuit maximum current [Amperes]',
                type: 'number',
                role: 'value.current',
                read: true,
                write: true,
            },
            native: {},
        });
        this.subscribeStates(charger.id + '.config.circuitMaxCurrentP2');

        await this.setObjectNotExistsAsync(charger.id + '.config.circuitMaxCurrentP3', {
            type: 'state',
            common: {
                name:'Set circuit maximum current [Amperes]',
                type: 'number',
                role: 'value.current',
                read: true,
                write: true,
            },
            native: {},
        });
        //this.subscribeStates(charger.id + '.config.circuitMaxCurrentP3');

        //ledStripBrightness
        await this.setObjectNotExistsAsync(charger.id + '.config.ledStripBrightness', {
            type: 'state',
            common: {
                name: 'LED strip brightness, 0-100%',
                type: 'number',
                role: 'value.brightness',
                read: true,
                write: true,
            },
            native: {},
        });
        this.subscribeStates(charger.id + '.config.ledStripBrightness');

        //"smartCharging": true,
        await this.setObjectNotExistsAsync(charger.id + '.config.smartCharging', {
            type: 'state',
            common: {
                name: 'Smart charging state enabled by capacitive touch button',
                type: 'boolean',
                role: 'value',
                read: true,
                write: true,
            },
            native: {},
        });
        this.subscribeStates(charger.id + '.config.smartCharging');

        //smartButtonEnabled
        await this.setObjectNotExistsAsync(charger.id + '.config.smartButtonEnabled', {
            type: 'state',
            common: {
                name: 'Smart Button Enabled/Disabled',
                type: 'boolean',
                role: 'indicator.state',
                read: true,
                write: true,
            },
            native: {},
        });
        this.subscribeStates(charger.id + '.config.smartButtonEnabled');

        //wiFiSSID
        await this.setObjectNotExistsAsync(charger.id + '.config.wiFiSSID', {
            type: 'state',
            common: {
                name: 'WiFi SSID name',
                type: 'string',
                role: 'value',
                read: true,
                write: true,
            },
            native: {},
        });
        this.subscribeStates(charger.id + '.config.wiFiSSID');


    }
}

// @ts-ignore parent is a valid property on module
if (module.parent) {
    // Export the constructor in compact mode
    /**
     * @param {Partial<utils.AdapterOptions>} [options={}]
     */
    module.exports = (options) => new Easee(options);
} else {
    // otherwise start the instance directly
    new Easee();
}
