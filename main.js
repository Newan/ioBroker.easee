'use strict';

/*
 * Created with @iobroker/create-adapter v1.31.0
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require('@iobroker/adapter-core');

// Load your modules here, e.g.:
// const fs = require("fs");
const axios = require('axios').default;

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
        // this.on('objectChange', this.onObjectChange.bind(this));
        // this.on('message', this.onMessage.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    /**
     * Is called when databases are connected and adapter received configuration.
     */
    async onReady() {
        //Erstes Objekt erstellen
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
            await this.setStateAsync('testVariable', true);
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

                // starten den Statuszyklus der API
                this.readAllStates();
    
            }     
        }






        // Initialize your adapter here

        // The adapters config (in the instance object everything under the attribute "native") is accessible via
        // this.config:
        this.log.info('config option1: ' + this.config.option1);
        this.log.info('config option2: ' + this.config.option2);

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
     * Is called when adapter shuts down - callback has to be called under any circumstances!
     * @param {() => void} callback
     */
    onUnload(callback) {
        try {
            clearTimeout(adapterIntervals.readAllStates);
            this.log.info('Adaptor easee cleaned up everything...');
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
            this.refreshToken()
        }

        this.log.info("read new states from the API")
        await this.setStateAsync('lastUpdate', new Date().toLocaleTimeString()); 
        adapterIntervals.readAllStates = setTimeout(this.readAllStates.bind(this), 30000); //this.config.polltimelive);
    }

    // If you need to react to object changes, uncomment the following block and the corresponding line in the constructor.
    // You also need to subscribe to the objects with `this.subscribeObjects`, similar to `this.subscribeStates`.
    // /**
    //  * Is called if a subscribed object changes
    //  * @param {string} id
    //  * @param {ioBroker.Object | null | undefined} obj
    //  */
    // onObjectChange(id, obj) {
    //     if (obj) {
    //         // The object was changed
    //         this.log.info(`object ${id} changed: ${JSON.stringify(obj)}`);
    //     } else {
    //         // The object was deleted
    //         this.log.info(`object ${id} deleted`);
    //     }
    // }

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

    // If you need to accept messages in your adapter, uncomment the following block and the corresponding line in the constructor.
    // /**
    //  * Some message was sent to this instance over message box. Used by email, pushover, text2speech, ...
    //  * Using this method requires "common.messagebox" property to be set to true in io-package.json
    //  * @param {ioBroker.Message} obj
    //  */
    // onMessage(obj) {
    //     if (typeof obj === 'object' && obj.message) {
    //         if (obj.command === 'send') {
    //             // e.g. send email or pushover or whatever
    //             this.log.info('send command');

    //             // Send response in callback if required
    //             if (obj.callback) this.sendTo(obj.from, obj.command, 'Message received', obj.callback);
    //         }
    //     }
    // }

    //Todo auslagern


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

    async refreshToken(){

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




