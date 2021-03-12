'use strict';

const utils = require('@iobroker/adapter-core');

const axios = require('axios').default;

//Eigene Variablen 
const apiUrl = "https://api.easee.cloud";
const adapterIntervals = {}; //halten von allen Intervallen
var accessToken = "";
var refreshToken = "";
var expireTime = Date.now();
var polltime = 30;
var minPollTimeEnergy = 120;
var roundCounter = 0;
var arrCharger = [];
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
            this.log.error("Interval in seconds to short -> got to default 30")
        } else {
            polltime = this.config.polltime;
        }
            
        // Testen ob der Login funktioniert
        if (this.config.username == '' ) {
            this.log.error("No username set");
            //Status melden
            await this.setStateAsync('online', false);
        } else {
            
            this.config.password = ''; //reset old passwords
            this.getForeignObject('system.config', async (err, obj) => {
                if ((obj && obj.native && obj.native.secret) || this.config.client_secret == '') {
                    this.log.info("Secret is: " + this.config.client_secret);

                    this.config.password = decrypt(obj.native.secret, this.config.client_secret);            
                    this.log.info("Password decrypted");
                    this.log.debug("Password is:" + this.config.password);

                    var login = await this.login(this.config.username, this.config.password);
    
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
            
                    } else {
                        //Login hat nicht funktionert, Adapter kann nicht gestartet werden
                        //Errohandling in der Loginfunktion derzeit
                    }    
                } else {
                    this.log.error("No password set");
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
            this.log.info("Token is Expired - refresh")
            await this.refreshToken()
        } 

        this.log.info("read new states from the API")        
        
        //Lesen alle Charger aus
        let tmpAllChargers = await this.getAllCharger();
        tmpAllChargers.forEach(async charger => {

            //Prüfen ob wir das Object kennen
            if (!this.arrCharger.includes(charger.id)) {
                //setzen als erstes alle Objekte
                await this.setAllStatusObjects(charger)
                await this.setAllConfigObjects(charger)

                //meken uns den charger
                this.arrCharger.push(charger.id)
            }

            this.log.debug("Charger gefunden")
            this.log.debug(JSON.stringify(charger));
                
            //Lesen den Status aus 
            let tmpChargerState = await this.getChargerState(charger.id);
            //Lesen die config
            let tmpChargerConfig = await this.getChargerConfig(charger.id);

            //Setzen die Daten der Charger
            await this.setNewStatusToCharger(charger, tmpChargerState);

            //Setzen die Config zum Charger
            await this.setConfigStatus(charger, tmpChargerConfig);

            //setzen und erechnen der Energiedaten, aber gebremste
            if(roundCounter > (minPollTimeEnergy/polltime)) {
                //lesen der Energiedaten
                let tmpChargerSession = await this.getChargerSession(charger.id);
                //etzen die Objekte
                this.setNewSessionToCharger(charger, tmpChargerSession)
            }
        });

        //Energiedaten dürfen nur einmal in der Minute aufgerufen werden, daher müssen wir das bremsen
        if(roundCounter > (minPollTimeEnergy/polltime)) {
            this.log.info("Hole Energiedaten: " + roundCounter)
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
            let tmpControl = id.split('.');
            if (tmpControl[3] == "config") {
                // change config, wenn ack = false
                if (!state.ack) {
                    this.log.debug("update config to API: " + id);
                    this.changeConfig(tmpControl[2], tmpControl[4], state.val);
                    this.log.info("Changes send to API");
                }
            } else {
                // control charger            
                switch (tmpControl[4]) {
                    case 'start':
                        // Starten Ladevorgang
                        this.log.info("Starting charging for Charger.id: " + tmpControl[2]);
                        this.startCharging(tmpControl[2]);
                        break;
                    case 'stop':
                        //  Stopen Ladevorgang
                        this.log.info("Stopping charging for Charger.id: " + tmpControl[2]);
                        this.stopCharging(tmpControl[2]);                  
                        break;                
                    case 'pause':
                        //  Pausiere Ladevorgang
                        this.log.info("Pause charging for Charger.id: " + tmpControl[2]);
                        this.pauseCharging(tmpControl[2]);
                        break;  
                    case 'resume':
                        //  Resume Ladevorgang
                        this.log.info("Resume charging for Charger.id: " + tmpControl[2]);
                        this.resumeCharging(tmpControl[2]);                    
                        break;                          
                    case 'reboot':
                        //  Reboot Charger
                        this.log.info("Reboot Charger.id: " + tmpControl[2]);
                        this.rebootCharging(tmpControl[2]);                    
                        break;                              
                    default:
                        this.log.error("No command for Control found for: " + id)
                }    
            }
        } else {
            // The state was deleted
            this.log.info(`state ${id} deleted`);
        }
    }

    /*onStateChange(id, state) {
        if (state) {            
            
            }            
        } else {
            // The state was deleted
            this.log.error(`state ${id} deleted`);
        }
    }*/


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

        this.log.info("Login successful")

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
            this.log.info("RefreshToken successful");
            accessToken = response.data.accessToken;
            refreshToken = response.data.refreshToken;
            expireTime = Date.now() + (response.data.expiresIn - (polltime * 2)) * 1000;
    
            this.log.debug(JSON.stringify(response.data));
        }).catch((error) => {
            this.log.error("RefreshToken error");
            this.log.error(error)
        });
    }

    //Lese alle Charger aus
    async getAllCharger(){
        return await axios.get(apiUrl + '/api/chargers' , 
            { headers: {"Authorization" : `Bearer ${accessToken}`} 
        }).then(response => {
            this.log.debug("Chargers ausgelesen");
            this.log.debug(JSON.stringify(response.data));
            return response.data
        }).catch((error) => {
            this.log.error(error)
        });
    }

    // Lese den Charger aus
    async getChargerState(charger_id){
        return await axios.get(apiUrl + '/api/chargers/' + charger_id +'/state', 
            { headers: {"Authorization" : `Bearer ${accessToken}`} 
        }).then(response => {
            this.log.debug("Charger status ausgelesen mit id: " + charger_id);
            this.log.debug(JSON.stringify(response.data));
            return response.data
        }).catch((error) => {
            this.log.error(error)
        });
    }

    async getChargerConfig(charger_id){
        return await axios.get(apiUrl + '/api/chargers/' + charger_id +'/config', 
            { headers: {"Authorization" : `Bearer ${accessToken}`} 
        }).then(response => {
            this.log.debug("Charger config ausgelesen mit id: " + charger_id);
            this.log.debug(JSON.stringify(response.data));
            return response.data
        }).catch((error) => {
            this.log.error(error)
        });
    }

    async getChargerSession(charger_id){
        return await axios.get(apiUrl + '/api/sessions/charger/' + charger_id +'/monthly', 
            { headers: {"Authorization" : `Bearer ${accessToken}`} 
        }).then(response => {
            this.log.debug("Charger session ausgelesen mit id: " + charger_id);
            this.log.debug(JSON.stringify(response.data));
            return response.data
        }).catch((error) => {
            this.log.error(error)
        });
    }

    async startCharging(id) {
        return await axios.post(apiUrl + '/api/chargers/' + id + '/commands/start_charging', {},
            { headers: {"Authorization" : `Bearer ${accessToken}`}}
        ).then(response => {
            this.log.info("Start charging successful");
            this.log.debug(JSON.stringify(response.data));
        }).catch((error) => {
            this.log.error("Start charging error");
            this.log.error(error)
        });
    }

    async stopCharging(id) {
        return await axios.post(apiUrl + '/api/chargers/' + id + '/commands/stop_charging', {},
            { headers: {"Authorization" : `Bearer ${accessToken}`}}
        ).then(response => {
            this.log.info("Stop charging successful");
            this.log.debug(JSON.stringify(response.data));
        }).catch((error) => {
            this.log.error("Stop charging error");
            this.log.error(error)
        });
    }

    async pauseCharging(id) {
        return await axios.post(apiUrl + '/api/chargers/' + id + '/commands/pause_charging', {},
            { headers: {"Authorization" : `Bearer ${accessToken}`}}
        ).then(response => {
            this.log.info("Pause charging successful");
            this.log.debug(JSON.stringify(response.data));
        }).catch((error) => {
            this.log.error("Pause charging error");
            this.log.error(error)
        });
    }

    async resumeCharging(id) {
        return await axios.post(apiUrl + '/api/chargers/' + id + '/commands/resume_charging', {},
            { headers: {"Authorization" : `Bearer ${accessToken}`}}
        ).then(response => {
            this.log.info("Resume charging successful");
            this.log.debug(JSON.stringify(response.data));
        }).catch((error) => {
            this.log.error("Resume charging error");
            this.log.error(error)
        });
    }

    async rebootCharging(id) {
        return await axios.post(apiUrl + '/api/chargers/' + id + '/commands/reboot', {},
            { headers: {"Authorization" : `Bearer ${accessToken}`}}
        ).then(response => {
            this.log.info("Reboot charging successful");
            this.log.debug(JSON.stringify(response.data));
        }).catch((error) => {
            this.log.error("Reboot charging error");
            this.log.error(error)
        });
    }


    async changeConfig(id, configvalue, value) {
        this.log.debug(JSON.stringify( {
            [configvalue]: value
        }));
        return await axios.post(apiUrl + '/api/chargers/' + id + '/settings', {
            [configvalue]: value
            },
            { headers: {"Authorization" : `Bearer ${accessToken}`}}
        ).then(response => {
            this.log.info("Config update successful");
            this.log.debug(JSON.stringify(response.data));
        }).catch((error) => {
            this.log.error("Config update error");
            this.log.error(error)
        });
    }


    /***********************************************************************
     * Funktionen für Status der Reading um den Code aufgeräumter zu machen
     ***********************************************************************/

    //Setzen alle Status für Charger
    async setNewStatusToCharger(charger, charger_states) {
        this.setState(charger.id + '.name', charger.name);
        this.setState(charger.id + '.status.cableLocked', charger_states.cableLocked);
        this.setState(charger.id + '.status.chargerOpMode', charger_states.chargerOpMode);
        this.setState(charger.id + '.status.totalPower', charger_states.totalPower);
        this.setState(charger.id + '.status.wiFiRSSI', charger_states.wiFiRSSI);
        this.setState(charger.id + '.status.chargerFirmware', charger_states.chargerFirmware);
        this.setState(charger.id + '.status.latestFirmware', charger_states.latestFirmware);
        this.setState(charger.id + '.status.voltage', charger_states.voltage);
        this.setState(charger.id + '.status.outputCurrent', charger_states.outputCurrent);
        this.setState(charger.id + '.status.isOnline', charger_states.isOnline);
        this.setState(charger.id + '.status.wiFiAPEnabled', charger_states.wiFiAPEnabled);    
    }

    /***********************************************************************
     * Funktionen zum erstellen der Objekte der Reading 
    ***********************************************************************/

    async setAllStatusObjects(charger) {
        //Legen die Steurungsbutton für jeden Charger an
        await this.setObjectNotExistsAsync(charger.id + '.control.start', {
            type: 'state',
            common: {
                name: "Start charging",
                type: "boolean",
                role: "button",
                read: true,
                write: true,
            },
            native: {},
        });
        this.subscribeStates(charger.id + '.control.start');

        await this.setObjectNotExistsAsync(charger.id + '.control.stop', {
            type: 'state',
            common: {
                name: "Stop charging",
                type: "boolean",
                role: "button",
                read: false,
                write: true,
            },
            native: {},
        });
        this.subscribeStates(charger.id + '.control.stop');

        await this.setObjectNotExistsAsync(charger.id + '.control.pause', {
            type: 'state',
            common: {
                name: "Pause charging",
                type: "boolean",
                role: "button",
                read: false,
                write: true,
            },
            native: {},
        });
        this.subscribeStates(charger.id + '.control.pause');

        await this.setObjectNotExistsAsync(charger.id + '.control.resume', {
            type: 'state',
            common: {
                name: "Resume charging",
                type: "boolean",
                role: "button",
                read: false,
                write: true,
            },
            native: {},
        });
        this.subscribeStates(charger.id + '.control.resume');

        await this.setObjectNotExistsAsync(charger.id + '.control.reboot', {
            type: 'state',
            common: {
                name: "Reboot Charger",
                type: "boolean",
                role: "button",
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
        this.setState(charger.id + '.id', charger.id);
        
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
                name: 'cableLocked',
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
                name: 'chargerOpMode',
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
                name: 'totalPower',
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
                name: 'wiFiRSSI',
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
                name: 'chargerFirmware',
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
                name: 'latestFirmware',
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
                name: 'outputCurrent',
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
                name: 'wiFiAPEnabled',
                type: 'boolean',
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
            this.setState(charger.id + '.session.' + session.year + '.' + session.month+ '.totalEnergyUsage', session.totalEnergyUsage);     

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
            this.setState(charger.id + '.session.' + session.year + '.' + session.month+ '.totalCost', session.totalCost);     

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
            this.setState(charger.id + '.session.' + session.year + '.' + session.month+ '.currencyId', session.currencyId);     

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

    async setConfigStatus(charger, charger_config) {
        this.setState(charger.id + '.config.isEnabled',{ val: charger_config.isEnabled, ack: true } );
        this.setState(charger.id + '.config.phaseMode', { val: charger_config.phaseMode, ack: true });
        this.setState(charger.id + '.config.ledStripBrightness', { val: charger_config.ledStripBrightness, ack: true });
        this.setState(charger.id + '.config.wiFiSSID', { val: charger_config.wiFiSSID, ack: true });
    }

    async setAllConfigObjects(charger) {

        //isEnabled
        await this.setObjectNotExistsAsync(charger.id + '.config.isEnabled', {
            type: 'state',
            common: {
                name: 'isEnabled',
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
                name: 'phaseMode',
                type: 'number',
                role: 'indicator',
                read: true,
                write: true,
            },
            native: {},
        });
        this.subscribeStates(charger.id + '.config.phaseMode');

        //ledStripBrightness
        await this.setObjectNotExistsAsync(charger.id + '.config.ledStripBrightness', {
            type: 'state',
            common: {
                name: 'ledStripBrightness',
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
                name: 'wiFiSSID',
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




