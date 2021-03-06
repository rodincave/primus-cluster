/**
 * Module dependencies.
 */

var _ = require('lodash');
var Adapter = require('./adapter');

/**
 * Expose module.
 */

module.exports = function (primus, options) {
  return new PrimusCluster(primus, options);
};

/**
 * Create a new PrimusCluster instance.
 * Enable pub/sub for write and send method (if avalaible).
 *
 * @param {Primus} primus
 * @param {Object} options
 */

function PrimusCluster(primus, options) {
  options = options || {};
  options.cluster = _.defaults(options.cluster || {}, {
    channel: 'primus',
    ttl: 86400
  });

  this.primus = primus;
  this.channel = options.cluster.channel;
  this.silent = false;

  // Generate a random id for this cluster node.
  this.id = Math.random();

  this.initializeClients(options.cluster.redis);
  this.initializeAdapter(options.cluster.ttl);
  this.wrapPrimusMethods();
  this.initializeMessageDispatcher();

  this.primus.on('close', this.close.bind(this));
}

/**
 * Initialize Redis clients.
 */

PrimusCluster.prototype.initializeClients = function initializeClients(options) {
  options = options || {};

  this.clients = {};

  // Create redis clients.
  ['pub', 'sub', 'storage'].forEach(function (name) {
    var client = createClient();

    // Forward errors to Primus.
    client.on('error', function (err) {
      this.primus.emit('error', err);
    }.bind(this));

    this.clients[name] = client;
  }.bind(this));

  /**
   * Create a new redis client.
   *
   * @returns {RedisClient}
   */

  function createClient() {
    if (_.isFunction(options)) return options();

    try {
      return require('redis').createClient(options.port, options.host, _.omit(options, 'port', 'host'));
    }
    catch(err) {
      throw new Error('You must add redis as dependency.');
    }
  }
};

/**
 * Initialize the room adapter.
 *
 * @param {Number} ttl TTL in second
 */

PrimusCluster.prototype.initializeAdapter = function initializeAdapter(ttl) {
  // Create adapter.
  var adapter = new Adapter({
    publish: this.publish.bind(this),
    client: this.clients.storage,
    ttl: ttl
  });

  // Replace adapter in options.
  this.primus.options.rooms = this.primus.options.rooms || {};
  this.primus.options.rooms.adapter = adapter;

  // Replace adapter in primus and in rooms plugin.
  if (this.primus.adapter) this.primus.adapter = adapter;
  if (this.primus._rooms) this.primus._rooms.adapter = adapter;
};

/**
 * Wrap primus methods.
 */

PrimusCluster.prototype.wrapPrimusMethods = function wrapPrimusMethods() {
  ['write', 'send'].forEach(wrapMethod.bind(this));

  function wrapMethod(method) {
    if (! this.primus[method]) return ;
    this.primus['__original' + method] = this.primus[method];
    this.primus[method] = function () {
      this.publish(arguments, 'primus', { method: method });
      this.primus['__original' + method].apply(this.primus, arguments);
    }.bind(this);
  }
};

/**
 * Initialize the message dispatcher to dispatch message over cluster nodes.
 */

PrimusCluster.prototype.initializeMessageDispatcher = function initializeMessageDispatcher() {
  this.clients.sub.subscribe(this.channel);

  this.clients.sub.on('message', function (channel, message) {
    this.dispatchMessage(message);
  }.bind(this));
};

/**
 * Dispatch message depending on its type.
 *
 * @param {Object} msg
 */

PrimusCluster.prototype.dispatchMessage = function dispatchMessage(msg) {
  this.primus.decoder(msg, function (err, msg) {

    // Do a "save" emit('error') when we fail to parse a message. We don't
    // want to throw here as listening to errors should be optional.
    if (err) return this.primus.listeners('error').length && this.primus.emit('error', err);

    // If message have no type, we ignore it.
    if (! msg.type) return ;

    // If we are the emitter, we ignore it.
    if (msg.id === this.id) return ;

    this.callDispatcher(msg);
  }.bind(this));
};

/**
 * Call the dispatcher in silent mode.
 *
 * @param {Object} msg
 */

PrimusCluster.prototype.callDispatcher = function callDispatcher(msg) {
  // Enter silent mode.
  this.silent = true;

  // Call the dispatcher.
  this[msg.type + 'MessageDispatcher'](msg);

  // Exit silent mode.
  this.silent = false;
};

/**
 * Room message dispatcher.
 * Handle message published by adapter.
 *
 * @param {Object} msg
 */

PrimusCluster.prototype.roomMessageDispatcher = function roomMessageDispatcher(msg) {
  _.each(msg.opts.rooms, function (room) {
    //console.log("opts", msg.data);
    //console.log("method", msg.method);
    //console.log("type", msg.type);
    var rooms = this.primus.room(room).to(msg.opts.to).except(msg.opts.except);
    //console.log(rooms);
    //console.log("options array", _.toArray(msg.data));
    rooms[msg.opts.method].apply(rooms, _.toArray(msg.data));
  }, this);
};

/**
 * Primus message dispatcher.
 * Write message on the current primus server.
 *
 * @param {Object} msg
 */

PrimusCluster.prototype.primusMessageDispatcher = function primusMessageDispatcher(msg) {
  this.primus['__original' + msg.opts.method].apply(this.primus, _.toArray(msg.data));
};

/**
 * Publish message over the cluster.
 *
 * @param {mixed} data
 * @param {String} type ('primus', 'room')
 * @param {Object} [opts]
 */

PrimusCluster.prototype.publish = function publish(data, type, opts) {
  opts = opts || {};

  // In silent mode, we do nothing.
  if (this.silent) return ;

  var message = {
    id: this.id,
    data: data,
    type: type,
    opts: opts
  };

  this.primus.encoder(message, function (err, msg) {

    // Do a "save" emit('error') when we fail to parse a message. We don't
    // want to throw here as listening to errors should be optional.
    if (err) return this.primus.listeners('error').length && this.primus.emit('error', err);

    this.clients.pub.publish(this.channel, msg);
  }.bind(this));
};

/**
 * Called when primus is closed.
 * Quit all redis clients.
 */

PrimusCluster.prototype.close = function close() {
  _.invoke(this.clients, 'quit');
};