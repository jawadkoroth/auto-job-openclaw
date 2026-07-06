const EventEmitter = require("events");

class EventBus extends EventEmitter {
    /**
     * Publish an event to all subscribers
     * @param {string} event Name of the event (e.g. 'BrowserStarted', 'JobApplied')
     * @param {any} data Metadata payload associated with the event
     */
    emit(event, data) {
        super.emit(event, data);
    }

    /**
     * Subscribe to an event
     * @param {string} event Name of the event
     * @param {Function} listener Callback function
     */
    on(event, listener) {
        super.on(event, listener);
    }
}

module.exports = new EventBus();
