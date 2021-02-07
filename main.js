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






        // Initialize your adapter here

        /*
        For every state in the system there has to be also an object of type state
        Here a simple template for a boolean variable named "testVariable"
        Because every adapter instance uses its own unique namespace variable names can't collide with other adapters variables
        */

        // In order to get state updates, you need to subscribe to them. The following line adds a subscription for our variable we have created above.
        this.subscribeStates('testVariable');
        // You can also add a subscription for multiple states. The following line watches all states starting with "lights."
        // this.subscribeStates('lights.*');
        // Or, if you really must, you can also watch all states. Don't do this if you don't need to. Otherwise this will cause a lot of unnecessary load on the system:
        // this.subscribeStates('*');

        /*
            setState examples
            you will notice that each setState will cause the stateChange event to fire (because of above subscribeStates cmd)
        */
        // the variable testVariable is set to true as command (ack=false)

        // same thing, but the value is flagged "ack"
        // ack should be always set to true if the value is received from or acknowledged from the target system
        await this.setStateAsync('testVariable', { val: true, ack: true });

        // same thing, but the state is deleted after 30s (getState will return null afterwards)
        await this.setStateAsync('testVariable', { val: true, ack: true, expire: 30 });

        // examples for the checkPassword/checkGroup functions
        let result = await this.checkPasswordAsync('admin', 'iobroker');
        this.log.info('check user admin pw iobroker: ' + result);

        result = await this.checkGroupAsync('admin', 'admin');
        this.log.info('check group user admin group admin: ' + result);
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
            let tmpChargerState = await this.getCharger(charger.id);
            //Setzen die Status der Charger
            this.setNewStatusToCharger(charger, tmpChargerState);

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
            // The state was changed
            this.log.info(`state ${id} changed: ${state.val} (ack = ${state.ack})`);
        } else {
            // The state was deleted
            this.log.info(`state ${id} deleted`);
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
    
            this.log.info(JSON.stringify(response.data));
        }).catch((error) => {
            this.log.info("RefreshToken error");
            this.log.error(error)
        });
    }

    //Lese alle Charger aus
    async getAllCharger(){
        return await axios.get(apiUrl + '/api/chargers' , 
            { headers: {"Authorization" : `Bearer ${accessToken}`} 
        }).then(response => {
            this.log.debug("Chargers ausgelesen");
            this.log.info(JSON.stringify(response.data));
            return response.data
        }).catch((error) => {
            this.log.error(error)
        });
    }

    // Lese den Charger aus
    async getCharger(charger_id){
        return await axios.get(apiUrl + '/api/chargers/' + charger_id +'/state', 
            { headers: {"Authorization" : `Bearer ${accessToken}`} 
        }).then(response => {
            this.log.debug("Charger ausgelesen mit id" + charger_id);
            this.log.info(JSON.stringify(response.data));
            return response.data
        }).catch((error) => {
            this.log.error(error)
        });
    }





    /***********************************************************************
     * Funktionen für Staus der Reading um den Code aufgeräumeter zu machen
     ***********************************************************************/

    //Setzen alle Staus für Charger
    async setNewStatusToCharger(charger, charger_states) {
        //Legen die Steurungsbutton für jeden Charger an
        await this.setObjectNotExistsAsync(charger.id + '.control.start', {
            type: 'state',
            common: {
                name: charger.id + '.chargerStart',
                type: "boolean",
                role: "button",
                read: false,
                write: true,
            },
            native: {},
        });
        await this.setObjectNotExistsAsync(charger.id + '.control.stop', {
            type: 'state',
            common: {
                name: charger.id + '.chargerStop',
                type: "boolean",
                role: "button",
                read: false,
                write: true,
            },
            native: {},
        });
        await this.setObjectNotExistsAsync(charger.id + '.control.pause', {
            type: 'state',
            common: {
                name: charger.id + '.chargerPause',
                type: "boolean",
                role: "button",
                read: false,
                write: true,
            },
            native: {},
        });
        await this.setObjectNotExistsAsync(charger.id + '.control.resume', {
            type: 'state',
            common: {
                name: charger.id + '.chargerResume',
                type: "boolean",
                role: "button",
                read: false,
                write: true,
            },
            native: {},
        });

        //"cableLocked": true,
        await this.setObjectNotExistsAsync(charger.id + '.cableLocked', {
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
        this.setState(charger.id + '.cableLocked', charger_states.cableLocked);

         //"chargerOpMode": 1,
         await this.setObjectNotExistsAsync(charger.id + '.chargerOpMode', {
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
        this.setState(charger.id + '.chargerOpMode', charger_states.chargerOpMode);

         //"totalPower": 0,
         await this.setObjectNotExistsAsync(charger.id + '.totalPower', {
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
        this.setState(charger.id + '.totalPower', charger_states.totalPower);

        //"wiFiRSSI": 0,
        await this.setObjectNotExistsAsync(charger.id + '.wiFiRSSI', {
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
        this.setState(charger.id + '.wiFiRSSI', charger_states.wiFiRSSI);

        //"chargerFirmware": 0,
        await this.setObjectNotExistsAsync(charger.id + '.chargerFirmware', {
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
        this.setState(charger.id + '.chargerFirmware', charger_states.chargerFirmware);

        //"latestFirmware": 0,
        await this.setObjectNotExistsAsync(charger.id + '.latestFirmware', {
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
        this.setState(charger.id + '.latestFirmware', charger_states.latestFirmware);

        //"voltage": 0,
        await this.setObjectNotExistsAsync(charger.id + '.voltage', {
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
        this.setState(charger.id + '.voltage', charger_states.voltage);

        //"outputCurrent": 0,
        await this.setObjectNotExistsAsync(charger.id + '.outputCurrent', {
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
        this.setState(charger.id + '.outputCurrent', charger_states.outputCurrent);

        //"isOnline": true,
        await this.setObjectNotExistsAsync(charger.id + '.isOnline', {
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
        this.setState(charger.id + '.isOnline', charger_states.isOnline);

        //"wiFiAPEnabled": true,
        await this.setObjectNotExistsAsync(charger.id + '.wiFiAPEnabled', {
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
        this.setState(charger.id + '.wiFiAPEnabled', charger_states.wiFiAPEnabled);
     
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




