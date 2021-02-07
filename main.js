'use strict';

const utils = require('@iobroker/adapter-core');

const axios = require('axios').default;

//Eigene Variablen 
const apiUrl = "https://api.easee.cloud";
const adapterIntervals = {}; //Ahlten von allen Intervallen
var accessToken = "";
var refreshToken = "";
var expireTime = Date.now();

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


        // Testen ob der Login funktioniert
        if (this.config.username == '' || this.config.password == '') {
            this.log.error("No Username or Password set");
            //Status melden
            await this.setStateAsync('online', false);
        } else {
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

                // starten den Statuszyklus der API neu
                this.readAllStates();
    
            } else {
                //Login hat nicht funktionert, Adapter kann nicht gestartet werden
                //Errohandling in der Loginfunktion derzeit
            }    
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
            this.log.debug("Charger gefunden")
            this.log.debug(JSON.stringify(charger));
                
            //Lesen den Status aus 
            let tmpChargerState = await this.getChargerState(charger.id);
            //Lesen die config
            let tmpChargerConfig = await this.getChargerConfig(charger.id);

            //Setzen die Daten der Charger
            this.setNewStatusToCharger(charger, tmpChargerState, tmpChargerConfig);
        });

        //Melden das Update
        await this.setStateAsync('lastUpdate', new Date().toLocaleTimeString()); 
        adapterIntervals.readAllStates = setTimeout(this.readAllStates.bind(this), 30000); //this.config.polltimelive);
    }

    /**
     * Is called if a subscribed state changes
     * @param {string} id
     * @param {ioBroker.State | null | undefined} state
     */
    onStateChange(id, state) {
        if (state) {
            // control charger            
            let tmpControl = id.split('.');
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
                default:
                    this.log.error("No command for state found")
            }
        } else {
            // The state was deleted
            this.log.error(`state ${id} deleted`);
        }
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

        this.log.info("Login successful")

        accessToken = response.data.accessToken;
        refreshToken = response.data.refreshToken;
        expireTime = Date.now() + (response.data.expiresIn - 60) * 1000;

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
            expireTime = Date.now() + (response.data.expiresIn - 60) * 1000;
    
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



    /***********************************************************************
     * Funktionen für Staus der Reading um den Code aufgeräumeter zu machen
     ***********************************************************************/

    //Setzen alle Staus für Charger
    async setNewStatusToCharger(charger, charger_states, charger_config) {
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
        this.setState(charger.id + '.name', charger.name);

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
        this.setState(charger.id + '.status.cableLocked', charger_states.cableLocked);

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
        this.setState(charger.id + '.status.chargerOpMode', charger_states.chargerOpMode);

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
        this.setState(charger.id + '.status.totalPower', charger_states.totalPower);

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
        this.setState(charger.id + '.status.wiFiRSSI', charger_states.wiFiRSSI);

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
        this.setState(charger.id + '.status.chargerFirmware', charger_states.chargerFirmware);

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
        this.setState(charger.id + '.status.latestFirmware', charger_states.latestFirmware);

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
        this.setState(charger.id + '.status.voltage', charger_states.voltage);

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
        this.setState(charger.id + '.status.outputCurrent', charger_states.outputCurrent);

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
        this.setState(charger.id + '.status.isOnline', charger_states.isOnline);

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
        this.setState(charger.id + '.status.wiFiAPEnabled', charger_states.wiFiAPEnabled);
     
        /*************** Config Reading ****************/
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
        this.setState(charger.id + '.config.isEnabled', charger_config.isEnabled);

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
        this.setState(charger.id + '.config.isEnabled', charger_config.isEnabled);

        //phaseMode
        await this.setObjectNotExistsAsync(charger.id + '.config.phaseMode', {
            type: 'state',
            common: {
                name: 'phaseMode',
                type: 'number',
                role: 'indicator',
                read: true,
                write: false,
            },
            native: {},
        });
        this.setState(charger.id + '.config.phaseMode', charger_config.phaseMode);

        //ledStripBrightness
        await this.setObjectNotExistsAsync(charger.id + '.config.ledStripBrightness', {
            type: 'state',
            common: {
                name: 'ledStripBrightness',
                type: 'number',
                role: 'indicator',
                read: true,
                write: false,
            },
            native: {},
        });
        this.setState(charger.id + '.config.ledStripBrightness', charger_config.ledStripBrightness);

        //wiFiSSID
        await this.setObjectNotExistsAsync(charger.id + '.config.wiFiSSID', {
            type: 'state',
            common: {
                name: 'wiFiSSID',
                type: 'string',
                role: 'indicator',
                read: true,
                write: false,
            },
            native: {},
        });
        this.setState(charger.id + '.config.wiFiSSID', charger_config.wiFiSSID);

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




