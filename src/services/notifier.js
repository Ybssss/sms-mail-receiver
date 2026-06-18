const { EventEmitter } = require('events');

const bus = new EventEmitter();
let notifyFn = null;

function setNotifier(fn) {
  notifyFn = fn;
}

async function notifyMailReceived(order, source = 'webhook') {
  bus.emit('mail:received', { order, source });

  if (notifyFn) {
    await notifyFn(order, source);
  }
}

function onMailReceived(listener) {
  bus.on('mail:received', listener);
}

module.exports = { setNotifier, notifyMailReceived, onMailReceived };
