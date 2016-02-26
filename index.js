var dns = require('dns-socket')
var events = require('events')
var util = require('util')
var crypto = require('crypto')
var txt = require('mdns-txt')()
var network = require('network-address')
var multicast = require('multicast-dns')
var store = require('./store')

var IPv4 = /^\d{1,3}\.\d{1,3}\.\d{1,3}.\d{1,3}$/
var PORT = /^\d{1,5}$/

module.exports = DNSDiscovery

function DNSDiscovery (opts) {
  if (!(this instanceof DNSDiscovery)) return new DNSDiscovery(opts)
  if (!opts) opts = {}

  events.EventEmitter.call(this)

  var self = this

  this.socket = dns(opts)
  this.servers = [].concat(opts.servers || opts.server || []).map(parseAddr)

  this._impliedPort = !!opts.impliedPort
  this._sockets = []
  this._onsocket(this.socket)

  this.multicast = opts.multicast !== false ? multicast() : null
  if (this.multicast) {
    this.multicast.on('query', onmulticastquery)
    this.multicast.on('response', onmulticastresponse)
    this.multicast.on('error', onerror)
  }

  this._listening = false
  this._id = crypto.randomBytes(32).toString('base64')
  this._domain = opts.domain || 'dns-discovery.local'
  this._pushDomain = 'push.' + this._domain
  this._tokens = new Array(this.servers.length)
  this._tokensAge = []
  this._secrets = [
    crypto.randomBytes(32),
    crypto.randomBytes(32)
  ]

  while (this._tokensAge.length < this._tokens.length) this._tokensAge.push(0)

  this._interval = setInterval(rotateSecrets, 5 * 60 * 1000)
  if (this._interval.unref) this._interval.unref()

  this._ttl = opts.ttl || 0
  this._tick = 1

  var push = opts.push || {}
  if (!push.ttl) push.ttl = opts.ttl || 60
  if (!push.limit) push.limit = opts.limit

  this._domainStore = store(opts)
  this._pushStore = store(push)

  function rotateSecrets () {
    self._rotateSecrets()
  }

  function onerror (err) {
    self.emit('error', err)
  }

  function onmulticastquery (message, rinfo) {
    self._onmulticastquery(message, rinfo.port, rinfo.address)
  }

  function onmulticastresponse (message, rinfo) {
    self._onmulticastresponse(message, rinfo.port, rinfo.address)
  }
}

util.inherits(DNSDiscovery, events.EventEmitter)

DNSDiscovery.prototype.toJSON = function () {
  return this._domainStore.toJSON()
}

DNSDiscovery.prototype._onsocket = function (socket) {
  var self = this

  this._sockets.push(socket)
  socket.on('query', onquery)
  socket.on('error', onerror)

  function onerror (err) {
    self.emit('error', err)
  }

  function onquery (message, port, host) {
    self._onquery(message, port, host)
  }
}

DNSDiscovery.prototype._rotateSecrets = function () {
  if (this._listening) {
    this._secrets.shift()
    this._secrets.push(crypto.randomBytes(32))
  }

  for (var i = 0; i < this._tokensAge.length; i++) {
    if (this._tokensAge[i] < this._tick) {
      this._tokens[i] = null
      this._tokensAge[i] = 0
    }
  }

  this._tick++
}

DNSDiscovery.prototype._onmulticastquery = function (query, port, host) {
  var reply = {questions: query.questions, answers: []}
  var i = 0

  for (i = 0; i < query.questions.length; i++) {
    this._onquestion(query.questions[i], port, host, reply.answers, true)
  }
  for (i = 0; i < query.answers.length; i++) {
    this._onanswer(query.answers[i], port, host)
  }
  for (i = 0; i < query.additionals.length; i++) {
    this._onanswer(query.additionals[i], port, host)
  }

  if (reply.answers.length) {
    this.multicast.response(reply)
  }
}

DNSDiscovery.prototype._onmulticastresponse = function (response, port, host) {
  var i = 0

  for (i = 0; i < response.answers.length; i++) {
    this._onanswer(response.answers[i], port, host)
  }
  for (i = 0; i < response.additionals.length; i++) {
    this._onanswer(response.additionals[i], port, host)
  }
}

DNSDiscovery.prototype._onanswer = function (answer, port, host) {
  var id = this._getId(answer.name)
  if (!id) return

  if (answer.type === 'SRV') {
    if (!IPv4.test(answer.data.target)) return
    var peer = {
      port: answer.data.port || port,
      host: answer.data.target === '0.0.0.0' ? host : answer.data.target
    }
    this.emit('peer', id, peer)
    return
  }

  if (answer.type === 'TXT') {
    try {
      var data = txt.decode(answer.data)
    } catch (err) {
      return
    }

    var tokenMatch = data.token === hash(this._secrets[1], host)

    if (!tokenMatch) {
      // not an echo
      this._parsePeers(id, data, host)
    }

    if (!this._listening) return

    if (!tokenMatch) {
      // check if old token matches
      if (data.token !== hash(this._secrets[0], host)) return
    }

    if (PORT.test(data.announce)) {
      var announce = Number(data.announce) || port
      this.emit('peer', id, {port: announce, host: host})
      if (this._domainStore.add(id, announce, host)) {
        this._push(id, announce, host)
      }
    }

    if (PORT.test(data.unannounce)) {
      var unannounce = Number(data.unannounce) || port
      this._domainStore.remove(id, unannounce, host)
    }

    if (data.subscribe) {
      this._pushStore.add(id, port, host)
    } else {
      this._pushStore.remove(id, port, host)
    }
  }
}

DNSDiscovery.prototype._push = function (id, port, host) {
  var subs = this._pushStore.get(id, 16)
  var query = {
    additionals: [{
      type: 'SRV',
      name: id + '.' + this._domain,
      ttl: this._ttl,
      data: {
        port: port,
        target: host
      }
    }]
  }

  for (var i = 0; i < subs.length; i++) {
    var peer = subs[i]
    var tid = this.socket.query(query, peer.port, peer.host)
    this.socket.setRetries(tid, 2)
  }
}

DNSDiscovery.prototype._onquestion = function (query, port, host, answers, multicast) {
  if (query.type === 'TXT' && query.name === this._domain) {
    answers.push({
      type: 'TXT',
      name: query.name,
      ttl: this._ttl,
      data: txt.encode({
        token: hash(this._secrets[1], host),
        host: host,
        port: '' + port
      })
    })
    return
  }

  var id = this._getId(query.name)
  if (!id) return

  if (query.type === 'TXT') {
    var buf = toBuffer(this._domainStore.get(id, 100))
    if (multicast && !buf.length) return // just an optimization
    answers.push({
      type: 'TXT',
      name: query.name,
      ttl: this._ttl,
      data: txt.encode({
        token: hash(this._secrets[1], host),
        peers: buf.toString('base64')
      })
    })
    return
  }

  var peers = this._domainStore.get(id, 10)

  for (var i = 0; i < peers.length; i++) {
    var peer = peers[i]

    if (query.type === 'A') {
      answers.push({
        type: 'A',
        name: query.name,
        ttl: this._ttl,
        data: peer.host === '0.0.0.0' ? network() : peer.host
      })
    }
    if (query.type === 'SRV') {
      answers.push({
        type: 'SRV',
        name: query.name,
        ttl: this._ttl,
        data: {
          port: peer.port,
          target: peer.host
        }
      })
    }
  }
}

DNSDiscovery.prototype._getId = function (name) {
  var suffix = '.' + this._domain
  if (name.slice(-suffix.length) !== suffix) return null
  return name.slice(0, -suffix.length)
}

DNSDiscovery.prototype._onquery = function (query, port, host) {
  var reply = {questions: query.questions, answers: []}
  var i = 0

  for (i = 0; i < query.questions.length; i++) {
    this._onquestion(query.questions[i], port, host, reply.answers)
  }
  for (i = 0; i < query.answers.length; i++) {
    this._onanswer(query.answers[i], port, host)
  }
  for (i = 0; i < query.additionals.length; i++) {
    this._onanswer(query.additionals[i], port, host)
  }

  this.socket.response(query, reply, port, host)
}

DNSDiscovery.prototype._probeAndSend = function (type, i, id, port, cb) {
  var self = this
  this._probe(i, 0, function (err) {
    if (err) return cb(err)
    self._send(type, i, id, port, cb)
  })
}

DNSDiscovery.prototype._send = function (type, i, id, port, cb) {
  var s = this.servers[i]
  var token = this._tokens[i]
  var data = null

  if (this._impliedPort) port = 0

  switch (type) {
    case 1:
      data = {subscribe: true, token: token}
      break

    case 2:
      data = {subscribe: true, token: token, announce: '' + port}
      break

    case 3:
      data = {token: token, unannounce: '' + port}
      break
  }

  var query = {
    index: i,
    questions: [{
      type: 'TXT',
      name: id + '.' + this._domain
    }],
    additionals: [{
      type: 'TXT',
      name: id + '.' + this._domain,
      ttl: this._ttl,
      data: txt.encode(data)
    }]
  }

  this.socket.query(query, s.port, s.host, cb)
}

DNSDiscovery.prototype.lookup = function (id, cb) {
  this._visit(1, id, 0, cb)
}

DNSDiscovery.prototype.announce = function (id, port, cb) {
  this._visit(2, id, port, cb)
}

DNSDiscovery.prototype.unannounce = function (id, port, cb) {
  this._visit(3, id, port, cb)
}

DNSDiscovery.prototype._visit = function (type, id, port, cb) {
  if (typeof port === 'function') return this._visit(type, id, 0, port)
  if (!cb) cb = noop
  if (Buffer.isBuffer(id)) id = id.toString('hex')

  var self = this
  var missing = this.servers.length
  var success = false

  for (var i = 0; i < this.servers.length; i++) {
    if (this._tokens[i]) this._send(type, i, id, port, done)
    else this._probeAndSend(type, i, id, port, done)
  }

  if (type === 2) this._domainStore.add(id, port, '0.0.0.0')
  if (type === 3) this._domainStore.remove(id, port, '0.0.0.0')

  if (this.multicast && type !== 3) {
    missing++
    this.multicast.query({
      questions: [{
        type: 'TXT',
        name: id + '.' + this._domain
      }]
    }, done)
  }

  if (!missing) {
    missing++
    process.nextTick(done)
  }

  function done (_, res, q, port, host) {
    if (res) {
      success = true
      try {
        var data = res.answers.length && txt.decode(res.answers[0].data)
      } catch (err) {
        // do nothing
      }
      if (data) self._parseData(id, data, q.index, host)
    }

    if (!--missing) cb(success ? null : new Error('Query failed'))
  }
}

DNSDiscovery.prototype._parsePeers = function (id, data, host) {
  try {
    var buf = Buffer(data.peers, 'base64')
  } catch (err) {
    return
  }

  for (var i = 0; i < buf.length; i += 6) {
    var peer = decodePeer(buf, i)
    if (!peer) continue
    if (peer.host === '0.0.0.0') peer.host = host
    this.emit('peer', id, peer)
  }
}

DNSDiscovery.prototype._parseData = function (id, data, index, host) {
  if (data.token) {
    this._tokens[index] = data.token
    this._tokensAge[index] = this._tick
  }
  if (data && data.peers && id) this._parsePeers(id, data, host)
}

DNSDiscovery.prototype.whoami = function (cb) {
  var missing = this.servers.length
  var prevData = null
  var prevHost = null
  var called = false

  if (this.servers.length > 1) {
    for (var i = 0; i < this.servers.length; i++) this._probe(i, 2, done)
  } else {
    missing = 1
    process.nextTick(done)
  }

  function done (_, data, port, host) {
    if (data) {
      if (!called && IPv4.test(data.host) && PORT.test(data.port)) {
        if (prevHost && prevHost !== host) {
          called = true
          if (prevData.host === data.host && prevData.port === data.port) {
            cb(null, {port: Number(data.port), host: data.host})
          } else {
            cb(new Error('Inconsistent remote port/host'))
          }
        }
        prevData = data
        prevHost = host
      }
    }

    if (--missing || called) return
    cb(new Error('Probe failed'))
  }
}

DNSDiscovery.prototype._probe = function (i, retries, cb) {
  var self = this
  var s = this.servers[i]
  var query = {
    questions: [{
      type: 'TXT',
      name: this._domain
    }]
  }

  var missing = 1
  var id1 = this.socket.query(query, s.port, s.host, done)
  var id2 = 0
  var result = null

  if (s.secondaryPort) {
    missing++
    id2 = this.socket.query(query, s.secondaryPort, s.host, done)
  }

  if (retries) {
    this.socket.setRetries(id1, retries)
    if (id2) this.socket.setRetries(id2, retries)
  }

  function done (_, res, query, port, host) {
    if (res) {
      try {
        var data = res.answers.length && txt.decode(res.answers[0].data)
      } catch (err) {
        // do nothing
      }
      if (data && data.token) {
        self._parseData(null, data, i, host)
        self.socket.cancel(id1)
        self.socket.cancel(id2)
        if (id2 && res.id === id2) {
          s.port = s.secondaryPort
          s.secondaryPort = 0
        } else {
          s.secondaryPort = 0
        }
        result = data
      }
    }

    if (!--missing) cb(result ? null : new Error('Probe failed'), result, port, host)
  }
}

DNSDiscovery.prototype.destroy = function (onclose) {
  if (onclose) this.once('close', onclose)

  var self = this
  var missing = this._sockets.length
  clearInterval(this._interval)

  if (this.multicast) this.multicast.destroy(onmulticastclose)
  else onmulticastclose()

  function onmulticastclose () {
    for (var i = 0; i < self._sockets.length; i++) {
      self._sockets[i].destroy(onsocketclose)
    }
  }

  function onsocketclose () {
    if (!--missing) self.emit('close')
  }
}

DNSDiscovery.prototype.listen = function (ports, onlistening) {
  if (onlistening) this.once('listening', onlistening)
  if (this._listening) throw new Error('Server is already listening')
  this._listening = true

  if (!ports) ports = [53, 5300]
  if (!Array.isArray(ports)) ports = [ports]

  var self = this
  var missing = ports.length

  for (var i = 0; i < ports.length; i++) {
    var socket = dns()
    socket.bind(ports[i], onbind)
    this._onsocket(socket)
  }

  function onbind () {
    if (!--missing) self.emit('listening')
  }
}

function noop () {}

function parseAddr (addr) {
  if (addr.indexOf(':') === -1) addr += ':53,5300'
  var match = addr.match(/^([^:]+)(?::(\d{1,5})(?:,(\d{1,5}))?)?$/)
  if (!match) throw new Error('Could not parse ' + addr)

  return {
    port: Number(match[2] || 53),
    secondaryPort: Number(match[3] || 0),
    host: match[1]
  }
}

function hash (secret, host) {
  return crypto.createHash('sha256').update(secret).update(host).digest('base64')
}

function toBuffer (peers) {
  var buf = Buffer(peers.length * 6)
  for (var i = 0; i < peers.length; i++) {
    if (!peers[i].buffer) peers[i].buffer = encodePeer(peers[i])
    peers[i].buffer.copy(buf, i * 6)
  }
  return buf
}

function encodePeer (peer) {
  var buf = Buffer(6)
  var parts = peer.host.split('.')
  buf[0] = Number(parts[0] || 0)
  buf[1] = Number(parts[1] || 0)
  buf[2] = Number(parts[2] || 0)
  buf[3] = Number(parts[3] || 0)
  buf.writeUInt16BE(peer.port || 0, 4)
  return buf
}

function decodePeer (buf, offset) {
  if (buf.length - offset < 6) return null
  var host = buf[offset++] + '.' + buf[offset++] + '.' + buf[offset++] + '.' + buf[offset++]
  var port = buf.readUInt16BE(offset)
  offset += 2
  return {port: port, host: host}
}
