'use strict';

const utils = require('@iobroker/adapter-core');

const axios = require('axios').default;
const signalR = require('@microsoft/signalr');
const objEnum = require('./lib/enum.js');

//Eigene Variablen
const apiUrl = 'https://api.easee.cloud';
const adapterIntervals = {}; //halten von allen Intervallen
let accessToken = '';
let refreshToken = '';
let expireTime = Date.now();
let polltime = 30;
let password = '';
const minPollTimeEnergy = 120;
let roundCounter = 0;
const arrCharger = [];

class Easee extends utils.Adapter {

    /**
     * @param {Partial<utils.AdapterOptions>} [options={}]
     */
    constructor(options) {
        super({
            ...options,
            name: 'easee',
        });
        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    /**
     * SignalR
     */
    startSignal(){
        const connection = new signalR.HubConnectionBuilder()
            .withUrl('https://api.easee.cloud/hubs/chargers', { accessTokenFactory: () => accessToken })
            .withAutomaticReconnect()
            .build();

        connection.on('ProductUpdate', data => {
            //haben einen neuen Wert über SIgnalR erhalten
            if(objEnum.getNameByEnum(data.id) == undefined) {
                this.log.debug('New SignalR-ID, possible new Value: ' + data.id);
                this.log.debug(JSON.stringify(data));
            } else {
                //Value is in ioBroker, update it
                const tmpValueId = data.mid + objEnum.getNameByEnum(data.id);
                this.log.info('New value over SignalR for: ' + tmpValueId + 'value: ' + data.value);
                this.setStateAsync(tmpValueId, { val: data.value, ack: true });
            }
        });

        connection.start().then(() => {
            //for each charger subscribe SignalR
            arrCharger.forEach(charger => {
                connection.send('SubscribeWithCurrentState', 'EH530097', true).then(() => {
                    this.log.info('Charger registrate in SignalR: ' + charger.id);
                });
            });
        });

        connection.onclose(() => {
            this.log.error('SignalR Verbindung beendet!!!- restart');
            this.startSignal();
        });
    }


    /**
     * Starten den Adapter
     */
    async onReady() {

        //Erstes Objekt erstellen, für den Onlinestatus
        await this.setObjectNotExistsAsync('online', {
            type: 'state',
            common: {
                name: 'online',
                type: 'boolean',
                role: 'indicator',
                read: true,
                write: false,
            },
            native: {},
        });

        //Schauen ob die Polltime realistisch ist
        if (this.config.polltime < 1) {
            this.log.error('Interval in seconds to short -> got to default 30');
        } else {
            polltime = this.config.polltime;
        }

        // Testen ob der Login funktioniert
        if (this.config.username == '' ) {
            this.log.error('No username set');
            //Status melden
            await this.setStateAsync('online', false);
        } else {

            password = ''; //reset old passwords
            this.getForeignObject('system.config', async (err, obj) => {
                if ((obj && obj.native && obj.native.secret) || this.config.client_secret == '') {
                    this.log.info('Secret is: ' + this.config.client_secret);

                    // @ts-ignore
                    password = decrypt(obj.native.secret, this.config.client_secret);
                    this.log.info('Password decrypted');
                    this.log.debug('Password is:' + password);

                    const login = await this.login(this.config.username, password);

                    if (login) {
                        //Erstes Objekt erstellen
                        await this.setObjectNotExistsAsync('lastUpdate', {
                            type: 'state',
                            common: {
                                name: 'lastUpdate',
                                type: 'string',
                                role: 'indicator',
                                read: true,
                                write: false,
                            },
                            native: {},
                        });

                        //reset all to start
                        this.arrCharger = [];

                        // starten den Statuszyklus der API neu
                        await this.readAllStates();

                        if (this.config.signalR) {
                            this.log.info('Starting SignalR');
                            this.startSignal();
                        }

                    } else {
                        //Login hat nicht funktionert, Adapter kann nicht gestartet werden
                        //Errohandling in der Loginfunktion derzeit
                    }

                } else {
                    this.log.error('No password set');
                    //Status melden
                    await this.setStateAsync('online', false);

                }
            });

        }
    }

    /**
     * Clear all Timeouts an inform the USers
     */
    onUnload(callback) {
        try {
            clearTimeout(adapterIntervals.readAllStates);
            this.log.info('Adaptor easee cleaned up everything...');
            this.setState('online', false);
            callback();
        } catch (e) {
            callback();
        }
    }


    /*****************************************************************************************/
    async readAllStates() {
        if(expireTime <= Date.now()) {
            //Token ist expired!
            this.log.info('Token is Expired - refresh');
            await this.refreshToken();
        }

        this.log.info('read new states from the API');

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

                this.log.debug('Charger gefunden');
                this.log.debug(JSON.stringify(charger));

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
            });
        } else {
            this.log.warn('No Chargers found!');
        }

        //Energiedaten dürfen nur einmal in der Minute aufgerufen werden, daher müssen wir das bremsen
        if(roundCounter > (minPollTimeEnergy/polltime)) {
            this.log.info('Hole Energiedaten: ' + roundCounter);
            roundCounter = 0;
        }
        //Zählen die Runde!
        roundCounter = roundCounter + 1;

        //Melden das Update
        await this.setStateAsync('lastUpdate', new Date().toLocaleTimeString());
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
            this.log.info(`state ${id} changed: ${state.val} (ack = ${state.ack})`);
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
                            this.log.debug('Get infos from site:');
                            this.log.debug(JSON.stringify(site));

                            this.changeCircuitConfig(site.id, site.circuits[0].id, state.val);
                            this.log.info('Changes send to API');
                        });


                    } else {
                        this.log.debug('update config to API: ' + id);
                        this.changeConfig(tmpControl[2], tmpControl[4], state.val);
                        this.log.info('Changes send to API');
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
        await this.setStateAsync(charger.id + '.name', charger.name);
        await this.setStateAsync(charger.id + '.status.cableLocked', charger_states.cableLocked);
        await this.setStateAsync(charger.id + '.status.chargerOpMode', charger_states.chargerOpMode);
        await this.setStateAsync(charger.id + '.status.totalPower', charger_states.totalPower);
        await this.setStateAsync(charger.id + '.status.wiFiRSSI', charger_states.wiFiRSSI);
        await this.setStateAsync(charger.id + '.status.chargerFirmware', charger_states.chargerFirmware);
        await this.setStateAsync(charger.id + '.status.latestFirmware', charger_states.latestFirmware);
        await this.setStateAsync(charger.id + '.status.voltage', charger_states.voltage);
        await this.setStateAsync(charger.id + '.status.outputCurrent', charger_states.outputCurrent);
        await this.setStateAsync(charger.id + '.status.isOnline', charger_states.isOnline);
        await this.setStateAsync(charger.id + '.status.wiFiAPEnabled', charger_states.wiFiAPEnabled);
        await this.setStateAsync(charger.id + '.status.lifetimeEnergy', charger_states.lifetimeEnergy);
        await this.setStateAsync(charger.id + '.status.energyPerHour', charger_states.energyPerHour);
        await this.setStateAsync(charger.id + '.status.inCurrentT2', charger_states.inCurrentT2);
        await this.setStateAsync(charger.id + '.status.inCurrentT3', charger_states.inCurrentT3);
        await this.setStateAsync(charger.id + '.status.inCurrentT4', charger_states.inCurrentT4);
        await this.setStateAsync(charger.id + '.status.inCurrentT5', charger_states.inCurrentT5);

        //wert der config wird nur hier gesendet
        await this.setStateAsync(charger.id + '.config.dynamicChargerCurrent', { val: charger_states.dynamicChargerCurrent, ack: true });
        await this.setStateAsync(charger.id + '.config.dynamicCircuitCurrentP1', { val: charger_states.dynamicCircuitCurrentP1, ack: true });
        await this.setStateAsync(charger.id + '.config.dynamicCircuitCurrentP2', { val: charger_states.dynamicCircuitCurrentP2, ack: true });
        await this.setStateAsync(charger.id + '.config.dynamicCircuitCurrentP3', { val: charger_states.dynamicCircuitCurrentP3, ack: true });

    }


    //Setzen alle Status für Config
    async setConfigStatus(charger, charger_config) {
        await this.setStateAsync(charger.id + '.config.isEnabled',{ val: charger_config.isEnabled, ack: true } );
        await this.setStateAsync(charger.id + '.config.phaseMode', { val: charger_config.phaseMode, ack: true });
        await this.setStateAsync(charger.id + '.config.ledStripBrightness', { val: charger_config.ledStripBrightness, ack: true });
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

    //Get Token from API
    async login(username, password) {


        const response = await axios.post(apiUrl + '/api/accounts/token', {
            userName: username,
            password: password
        });

        this.log.info('Login successful');

        accessToken = response.data.accessToken;
        refreshToken = response.data.refreshToken;
        expireTime = Date.now() + (response.data.expiresIn - (polltime * 2)) * 1000;
        this.log.debug(JSON.stringify(response.data));
        await this.setStateAsync('online', true);


        return true;
    }

    //GET net Token from API
    async refreshToken() {
        return await axios.post(apiUrl + '/api/accounts/refresh_token', {
            accessToken: accessToken,
            refreshToken: refreshToken
        }).then(response => {
            this.log.info('RefreshToken successful');
            accessToken = response.data.accessToken;
            refreshToken = response.data.refreshToken;
            expireTime = Date.now() + (response.data.expiresIn - (polltime * 2)) * 1000;

            this.log.debug(JSON.stringify(response.data));
        }).catch((error) => {
            this.log.error('RefreshToken error');
            this.log.error(error);
        });
    }

    //Lese alle Charger aus
    async getAllCharger(){
        return await axios.get(apiUrl + '/api/chargers' ,
            { headers: {'Authorization' : `Bearer ${accessToken}`}
            }).then(response => {
            this.log.debug('Chargers ausgelesen');
            this.log.debug(JSON.stringify(response.data));
            return response.data;
        }).catch((error) => {
            this.log.error(error);
        });
    }

    // Lese den Charger aus
    async getChargerState(charger_id){
        return await axios.get(apiUrl + '/api/chargers/' + charger_id +'/state',
            { headers: {'Authorization' : `Bearer ${accessToken}`}
            }).then(response => {
            this.log.debug('Charger status ausgelesen mit id: ' + charger_id);
            this.log.debug(JSON.stringify(response.data));
            return response.data;
        }).catch((error) => {
            this.log.error(error);
        });
    }

    async getChargerConfig(charger_id){
        return await axios.get(apiUrl + '/api/chargers/' + charger_id +'/config',
            { headers: {'Authorization' : `Bearer ${accessToken}`}
            }).then(response => {
            this.log.debug('Charger config ausgelesen mit id: ' + charger_id);
            this.log.debug(JSON.stringify(response.data));
            return response.data;
        }).catch((error) => {
            this.log.error(error);
        });
    }

    async getChargerSite(charger_id){
        return await axios.get(apiUrl + '/api/chargers/' + charger_id +'/site',
            { headers: {'Authorization' : `Bearer ${accessToken}`}
            }).then(response => {
            this.log.debug('Charger site ausgelesen mit id: ' + charger_id);
            this.log.debug(JSON.stringify(response.data));
            return response.data;
        }).catch((error) => {
            this.log.error(error);
        });
    }

    async getChargerSession(charger_id){
        return await axios.get(apiUrl + '/api/sessions/charger/' + charger_id +'/monthly',
            { headers: {'Authorization' : `Bearer ${accessToken}`}
            }).then(response => {
            this.log.debug('Charger session ausgelesen mit id: ' + charger_id);
            this.log.debug(JSON.stringify(response.data));
            return response.data;
        }).catch((error) => {
            this.log.error(error);
        });
    }

    async startCharging(id) {
        return await axios.post(apiUrl + '/api/chargers/' + id + '/commands/start_charging', {},
            { headers: {'Authorization' : `Bearer ${accessToken}`}}
        ).then(response => {
            this.log.info('Start charging successful');
            this.log.debug(JSON.stringify(response.data));
        }).catch((error) => {
            this.log.error('Start charging error');
            this.log.error(error);
        });
    }

    async stopCharging(id) {
        return await axios.post(apiUrl + '/api/chargers/' + id + '/commands/stop_charging', {},
            { headers: {'Authorization' : `Bearer ${accessToken}`}}
        ).then(response => {
            this.log.info('Stop charging successful');
            this.log.debug(JSON.stringify(response.data));
        }).catch((error) => {
            this.log.error('Stop charging error');
            this.log.error(error);
        });
    }

    async pauseCharging(id) {
        return await axios.post(apiUrl + '/api/chargers/' + id + '/commands/pause_charging', {},
            { headers: {'Authorization' : `Bearer ${accessToken}`}}
        ).then(response => {
            this.log.info('Pause charging successful');
            this.log.debug(JSON.stringify(response.data));
        }).catch((error) => {
            this.log.error('Pause charging error');
            this.log.error(error);
        });
    }

    async resumeCharging(id) {
        return await axios.post(apiUrl + '/api/chargers/' + id + '/commands/resume_charging', {},
            { headers: {'Authorization' : `Bearer ${accessToken}`}}
        ).then(response => {
            this.log.info('Resume charging successful');
            this.log.debug(JSON.stringify(response.data));
        }).catch((error) => {
            this.log.error('Resume charging error');
            this.log.error(error);
        });
    }

    async rebootCharging(id) {
        return await axios.post(apiUrl + '/api/chargers/' + id + '/commands/reboot', {},
            { headers: {'Authorization' : `Bearer ${accessToken}`}}
        ).then(response => {
            this.log.info('Reboot charging successful');
            this.log.debug(JSON.stringify(response.data));
        }).catch((error) => {
            this.log.error('Reboot charging error');
            this.log.error(error);
        });
    }


    async changeConfig(id, configvalue, value) {
        this.log.debug(JSON.stringify( {
            [configvalue]: value
        }));
        return await axios.post(apiUrl + '/api/chargers/' + id + '/settings', {
            [configvalue]: value
        },
        { headers: {'Authorization' : `Bearer ${accessToken}`}}
        ).then(response => {
            this.log.info('Config update successful');
            this.log.debug(JSON.stringify(response.data));
        }).catch((error) => {
            this.log.error('Config update error');
            this.log.error(error);
        });
    }

    //circuitMaxCurrentPX
    async changeCircuitConfig(site_id, circuit_id, value) {
        return await axios.post(apiUrl + '/api/sites/' + site_id + '/circuits/' + circuit_id + '/settings', {
            'maxCircuitCurrentP1': value,
            'maxCircuitCurrentP2': value,
            'maxCircuitCurrentP3': value,
        },
        { headers: {'Authorization' : `Bearer ${accessToken}`}}
        ).then(response => {
            this.log.info('Circuit update successful');
            this.log.debug(JSON.stringify(response.data));
        }).catch((error) => {
            this.log.error('Circuit update error');
            this.log.error(error);
        });
    }

    /***********************************************************************
     * Funktionen zum erstellen der Objekte der Reading
    ***********************************************************************/

    async setAllStatusObjects(charger) {
        //Legen die Steurungsbutton für jeden Charger an
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
                role: 'indicator',
                read: true,
                write: false,
            },
            native: {},
        });
        await this.setStateAsync(charger.id + '.id', charger.id);

        //name
        await this.setObjectNotExistsAsync(charger.id + '.name', {
            type: 'state',
            common: {
                name: 'name',
                type: 'string',
                role: 'indicator',
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
                role: 'indicator',
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
                role: 'indicator',
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
                role: 'indicator',
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
                role: 'indicator',
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
                role: 'indicator',
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
                role: 'indicator',
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
                role: 'indicator',
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
                role: 'indicator',
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
                role: 'indicator',
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
                role: 'indicator',
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
                role: 'indicator',
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
                role: 'indicator',
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
                role: 'indicator',
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
                role: 'indicator',
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
                role: 'indicator',
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
                role: 'indicator',
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
                role: 'indicator',
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
                role: 'indicator',
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
                    role: 'indicator',
                    read: true,
                    write: false,
                },
                native: {},
            });
            await this.setStateAsync(charger.id + '.session.' + session.year + '.' + session.month+ '.totalEnergyUsage', session.totalEnergyUsage);

            await this.setObjectNotExistsAsync(charger.id + '.session.' + session.year + '.' + session.month+ '.totalCost', {
                type: 'state',
                common: {
                    name: 'totalCost',
                    type: 'number',
                    role: 'indicator',
                    read: true,
                    write: false,
                },
                native: {},
            });
            await this.setStateAsync(charger.id + '.session.' + session.year + '.' + session.month+ '.totalCost', session.totalCost);

            await this.setObjectNotExistsAsync(charger.id + '.session.' + session.year + '.' + session.month+ '.currencyId', {
                type: 'state',
                common: {
                    name: 'currencyId',
                    type: 'string',
                    role: 'indicator',
                    read: true,
                    write: false,
                },
                native: {},
            });
            await this.setStateAsync(charger.id + '.session.' + session.year + '.' + session.month+ '.currencyId', session.currencyId);

            await this.setObjectNotExistsAsync(charger.id + '.session.' + session.year + '.total_year', {
                type: 'state',
                common: {
                    name: 'total_year',
                    type: 'number',
                    role: 'indicator',
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
            this.log.info('set session year data');
            if (tmpYear != session.year) {
                //neues Jahr setzen alles zurück
                this.setState(charger.id + '.session.' + session.year + '.total_year', session.totalEnergyUsage);
                tmpYearCount = session.totalEnergyUsage;
                tmpYear = session.year;
            } else {
                tmpYearCount = tmpYearCount + session.totalEnergyUsage;
                this.setState(charger.id + '.session.' + session.year + '.total_year', tmpYearCount);
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
                role: 'indicator',
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
                role: 'indicator',
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
                role: 'indicator',
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
                role: 'indicator',
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
                role: 'indicator',
                read: true,
                write: false,
            },
            native: {},
        });
        //this.subscribeStates(charger.id + '.config.dynamicCircuitCurrentP1');

        await this.setObjectNotExistsAsync(charger.id + '.config.dynamicCircuitCurrentP2', {
            type: 'state',
            common: {
                name:'Dynamically set circuit maximum current for phase 2 [Amperes]',
                type: 'number',
                role: 'indicator',
                read: true,
                write: false,
            },
            native: {},
        });
        //this.subscribeStates(charger.id + '.config.dynamicCircuitCurrentP2');

        await this.setObjectNotExistsAsync(charger.id + '.config.dynamicCircuitCurrentP3', {
            type: 'state',
            common: {
                name:'Dynamically set circuit maximum current for phase 3 [Amperes]',
                type: 'number',
                role: 'indicator',
                read: true,
                write: false,
            },
            native: {},
        });
        this.subscribeStates(charger.id + '.config.dynamicCircuitCurrentP3');

        await this.setObjectNotExistsAsync(charger.id + '.config.circuitMaxCurrentP1', {
            type: 'state',
            common: {
                name:'Set circuit maximum current [Amperes]',
                type: 'number',
                role: 'indicator',
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
                role: 'indicator',
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
                role: 'indicator',
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
                role: 'indicator',
                read: true,
                write: true,
            },
            native: {},
        });
        this.subscribeStates(charger.id + '.config.ledStripBrightness');

        //wiFiSSID
        await this.setObjectNotExistsAsync(charger.id + '.config.wiFiSSID', {
            type: 'state',
            common: {
                name: 'WiFi SSID name',
                type: 'string',
                role: 'indicator',
                read: true,
                write: true,
            },
            native: {},
        });
        this.subscribeStates(charger.id + '.config.wiFiSSID');

    }
}

function decrypt(key, value) {
    let result = '';
    for (let i = 0; i < value.length; ++i) {
        result += String.fromCharCode(key[i % key.length].charCodeAt(0) ^ value.charCodeAt(i));
    }
    return result;
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




