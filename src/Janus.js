const WebSocket = require('ws')
const config = require('../../config') // TODO: make setConfig method
const l = require('../logger') // TODO: make setLogger method
const JanusPlugin = require('./JanusPlugin')
const uuid = require('uuid/v4')

let logger = l.channels.janus

class Janus {
  constructor () {
    this.ws = undefined
    this.isConnected = false
    this.sessionId = undefined
    this.logger = logger

    this.transactions = {}
    this.pluginHandles = {}

    this.config = config.webrtc.server
    this.protocol = 'janus-protocol'
    this.sendCreate = true

    /*
    setInterval(() => { console.log('PENDING JANUS TRANSACTION COUNT', Object.keys(this.transactions).length) }, 1000)
    */
  }

  connect () {
    if (this.isConnected) {
      return Promise.resolve(this)
    }

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.config.url, this.protocol, this.config.options)

    this.ws.addEventListener('error', (err) => {
      logger.error('Error connecting to the Janus WebSockets server...', err)
    this.isConnected = false
    reject(err)
  })

    this.ws.addEventListener('close', this.cleanupWebSocket.bind(this))

    this.ws.addEventListener('open', () => {
      if (!this.sendCreate) {
      this.isConnected = true
      this.keepAlive(true)
      return resolve(this)
    }

    let transaction = uuid()
    let request = {janus: 'create', transaction}

    this.transactions[transaction] = {
      resolve: (json) => {
      if (json.janus !== 'success') {
      logger.error('Cannot connect to Janus', json)
      reject(json)
      return
    }

    this.sessionId = json.data.id
    this.isConnected = true
    this.keepAlive(true)

    logger.debug('Janus connected, sessionId: ', this.sessionId)

    resolve(this)
  },
    reject,
      replyType: 'success'
  }

    this.ws.send(JSON.stringify(request))
  })

    this.ws.addEventListener('message', this.onMessage.bind(this))
    this.ws.addEventListener('close', this.onClose.bind(this))
  })
  }

  /**
   *
   * @param {JanusPlugin} plugin
   * @return {Promise}
   * */
  addPlugin (plugin) {
    if (!(plugin instanceof JanusPlugin)) {
      return Promise.reject(new Error('plugin is not a JanusPlugin'))
    }

    let request = plugin.getAttachPayload()

    return this.transaction('attach', request, 'success').then((json) => {
      if (json['janus'] !== 'success') {
      logger.error('Cannot add plugin', json)
      plugin.error(json)
      throw new Error(json)
    }

    this.pluginHandles[json.data.id] = plugin

    return plugin.success(this, json.data.id)
  })
  }

  transaction (type, payload, replyType) {
    if (!replyType) {
      replyType = 'ack'
    }
    let transactionId = uuid()

    return new Promise((resolve, reject) => {
      if (!this.isConnected) {
      reject(new Error('Janus is not connected'))
      return
    }

    let request = Object.assign({}, payload, {
      janus: type,
      session_id: (payload && parseInt(payload.session_id, 10)) || this.sessionId,
      transaction: transactionId
    })

    this.transactions[request.transaction] = {resolve, reject, replyType}
    this.ws.send(JSON.stringify(request))
  })
  }

  send (type, payload) {
    return new Promise((resolve, reject) => {
      if (!this.isConnected) {
      reject(new Error('Janus is not connected'))
      return
    }

    let request = Object.assign({}, payload, {
      janus: type,
      session_id: this.sessionId,
      transaction: uuid()
    })

    logger.debug('Janus sending', request)
    this.ws.send(JSON.stringify(request), {}, (err) => {
      if (err) {
        reject(err)
      } else {
        resolve()
      }
    })
  })
  }

  destroy () {
    if (!this.isConnected) {
      return Promise.resolve()
    }

    return this.transaction('destroy', {}, 'success').then(this.cleanupWebSocket.bind(this))
  }

  destroyPlugin (plugin) {
    return new Promise((resolve, reject) => {
      if (!(plugin instanceof JanusPlugin)) {
      reject(new Error('plugin is not a JanusPlugin'))
      return
    }

    if (!this.pluginHandles[plugin.janusHandleId]) {
      reject(new Error('unknown plugin'))
      return
    }

    this.transaction('detach', {plugin: plugin.pluginName, handle_id: plugin.janusHandleId}, 'success').then(() => {
      delete this.pluginHandles[plugin.pluginName]
      plugin.detach()

    resolve()
  }).catch((err) => {
      reject(err)
    })
  })
  }

  onMessage (messageEvent) {
    let json
    try {
      json = JSON.parse(messageEvent.data)
    } catch (err) {
      logger.error('cannot parse message', messageEvent.data)
      return
    }

    // logger.debug('JANUS GOT', json)
    if (json['janus'] === 'timeout' && json['session_id'] !== this.sessionId) {
      logger.debug('GOT timeout from another websocket') // seems like a bug in janus timeout handler :)
      return
    }

    if (json['janus'] === 'keepalive') { // Do nothing
      return
    }

    if (json['janus'] === 'ack') { // Just an ack, we can probably ignore
      let transaction = this.getTransaction(json)
      if (transaction && transaction.resolve) {
        transaction.resolve(json)
      }
      return
    }

    if (json['janus'] === 'success') { // Success!
      let transaction = this.getTransaction(json)
      if (!transaction) {
        return
      }

      let plugindata = json['plugindata']
      if (plugindata === undefined || plugindata === null) {
        transaction.resolve(json)
        return
      }

      let sender = json['sender']
      if (!sender) {
        transaction.resolve(json)
        logger.error('Missing sender for plugindata', json)
        return
      }

      let pluginHandle = this.pluginHandles[sender]
      if (!pluginHandle) {
        logger.error('This handle is not attached to this session', json)
        return
      }

      transaction.resolve({data: plugindata['data'], json})
      return
    }

    if (json['janus'] === 'webrtcup') { // The PeerConnection with the gateway is up! Notify this
      let sender = json['sender']
      if (!sender) {
        logger.warn('Missing sender...')
        return
      }
      let pluginHandle = this.pluginHandles[sender]
      if (!pluginHandle) {
        logger.error('This handle is not attached to this session', sender)
        return
      }
      pluginHandle.webrtcState(true)
      return
    }

    if (json['janus'] === 'hangup') { // A plugin asked the core to hangup a PeerConnection on one of our handles
      let sender = json['sender']
      if (!sender) {
        logger.warn('Missing sender...')
        return
      }
      let pluginHandle = this.pluginHandles[sender]
      if (!pluginHandle) {
        logger.error('This handle is not attached to this session', sender)
        return
      }
      pluginHandle.webrtcState(false, json['reason'])
      pluginHandle.hangup()
      return
    }

    if (json['janus'] === 'detached') { // A plugin asked the core to detach one of our handles
      let sender = json['sender']
      if (!sender) {
        logger.warn('Missing sender...')
        return
      }
      return
    }

    if (json['janus'] === 'media') { // Media started/stopped flowing
      let sender = json['sender']
      if (!sender) {
        logger.warn('Missing sender...')
        return
      }
      let pluginHandle = this.pluginHandles[sender]
      if (!pluginHandle) {
        logger.error('This handle is not attached to this session', sender)
        return
      }
      pluginHandle.mediaState(json['type'], json['receiving'])
      return
    }

    if (json['janus'] === 'slowlink') { // Trouble uplink or downlink
      logger.debug('Got a slowlink event on session ' + this.sessionId)
      logger.debug(json)
      let sender = json['sender']
      if (!sender) {
        logger.warn('Missing sender...')
        return
      }
      let pluginHandle = this.pluginHandles[sender]
      if (!pluginHandle) {
        logger.error('This handle is not attached to this session', sender)
        return
      }
      pluginHandle.slowLink(json['uplink'], json['nacks'])
      return
    }

    if (json['janus'] === 'error') { // Oops, something wrong happened
      if (!json.error || json.error.code !== 458) { // do not log 'No such session' errors ?
        logger.error('Ooops: ' + json['error'].code + ' ' + json['error'].reason)
        logger.debug(json)
      }
      let transaction = this.getTransaction(json, true)
      if (transaction && transaction.reject) {
        transaction.reject(json)
      }
      return
    }

    if (json['janus'] === 'event') {
      let sender = json['sender']
      if (!sender) {
        logger.warn('Missing sender...')
        return
      }
      let plugindata = json['plugindata']
      if (plugindata === undefined || plugindata === null) {
        logger.error('Missing plugindata...')
        return
      }

      let pluginHandle = this.pluginHandles[sender]
      if (!pluginHandle) {
        logger.error('This handle is not attached to this session', sender)
        return
      }

      let data = plugindata['data']
      let transaction = this.getTransaction(json)
      if (transaction) {
        if (data['error_code']) {
          transaction.reject({data, json})
        } else {
          transaction.resolve({data, json})
        }
        return
      }

      pluginHandle.onmessage(data, json)
      return
    }

    logger.warn('Unknown message/event ' + json['janus'] + ' on session ' + this.sessionId)
    logger.debug(json)
  }

  onClose () {
    if (!this.isConnected) {
      return
    }

    this.isConnected = false
    logger.error('Lost connection to the gateway (is it down?)')
  }

  keepAlive (isScheduled) {
    if (!this.ws || !this.isConnected || !this.sessionId) {
      return
    }

    if (isScheduled) {
      setTimeout(this.keepAlive.bind(this), config.webrtc.server.keepAliveIntervalMs)
    } else {
      // logger.debug('Sending Janus keepalive')
      this.transaction('keepalive').then(() => {
        setTimeout(this.keepAlive.bind(this), config.webrtc.server.keepAliveIntervalMs)
    })
    }
  }

  getTransaction (json, checkReplyType) {
    let type = json['janus']
    let transactionId = json['transaction']
    if (transactionId && this.transactions.hasOwnProperty(transactionId) && (checkReplyType || this.transactions[transactionId].replyType === type)) {
      let ret = this.transactions[transactionId]
      delete this.transactions[transactionId]
      return ret
    }
  }

  cleanupWebSocket () {
    if (!this.ws) {
      return
    }

    this.pluginHandles = {}

    this.ws.removeAllListeners()
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.close()
    }
    this.ws = undefined
    this.isConnected = false

    Object.keys(this.transactions).forEach((transaction) => {
      if (transaction.reject) {
      transaction.reject()
    }
  })
    this.transactions = {}
  }
}

module.exports = Janus
