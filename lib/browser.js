/**
 * Module dependencies.
 */

var keys = require("./keys");
var hasBinary = require("has-binary2");
var sliceBuffer = require("arraybuffer.slice");
var after = require("after");
var utf8 = require("./utf8");

/**
 * Current protocol version.
 */

exports.protocol = 3;

/**
 * Packet types.
 */

var packets = (exports.packets = {
  open: 0, // non-ws
  close: 1, // non-ws
  ping: 2,
  pong: 3,
  message: 4,
  upgrade: 5,
  noop: 6
});

var packetslist = keys(packets);

/**
 * Premade error packet.
 */

var err = { type: "error", data: "parser error" };

/**
 * Encodes a packet.
 *
 *     <packet type id> [ <data> ]
 *
 * Example:
 *
 *     5hello world
 *     3
 *     4
 *
 * Binary is encoded in an identical principle
 *
 * @api private
 */

exports.encodePacket = function(packet, supportsBinary, utf8encode, callback) {
  if (typeof supportsBinary === "function") {
    callback = supportsBinary;
    supportsBinary = false;
  }

  if (typeof utf8encode === "function") {
    callback = utf8encode;
    utf8encode = null;
  }

  var data =
    packet.data === undefined ? undefined : packet.data.buffer || packet.data;

  // Sending data as a utf-8 string
  var encoded = packets[packet.type];

  // data fragment is optional
  if (undefined !== packet.data) {
    encoded += utf8encode
      ? utf8.encode(String(packet.data), { strict: false })
      : String(packet.data);
  }

  return callback("" + encoded);
};

/**
 * Encode packet helpers for binary types
 */

/**
 * Decodes a packet. Changes format to Blob if requested.
 *
 * @return {Object} with `type` and `data` (if any)
 * @api private
 */

exports.decodePacket = function(data, binaryType, utf8decode) {
  if (data === undefined) {
    return err;
  }
  // String data
  if (typeof data === "string") {
    if (utf8decode) {
      data = tryDecode(data);
      if (data === false) {
        return err;
      }
    }
    var type = data.charAt(0);

    if (Number(type) != type || !packetslist[type]) {
      return err;
    }

    if (data.length > 1) {
      return { type: packetslist[type], data: data.substring(1) };
    } else {
      return { type: packetslist[type] };
    }
  }

  var asArray = new Uint8Array(data);
  var type = asArray[0];
  var rest = sliceBuffer(data, 1);
  return { type: packetslist[type], data: rest };
};

function tryDecode(data) {
  try {
    data = utf8.decode(data, { strict: false });
  } catch (e) {
    return false;
  }
  return data;
}

/**
 * Encodes multiple messages (payload).
 *
 *     <length>:data
 *
 * Example:
 *
 *     11:hello world2:hi
 *
 * If any contents are binary, they will be encoded as base64 strings. Base64
 * encoded strings are marked with a b before the length specifier
 *
 * @param {Array} packets
 * @api private
 */

exports.encodePayload = function(packets, supportsBinary, callback) {
  if (typeof supportsBinary === "function") {
    callback = supportsBinary;
    supportsBinary = null;
  }

  var isBinary = hasBinary(packets);

  if (!packets.length) {
    return callback("0:");
  }

  function setLengthHeader(message) {
    return message.length + ":" + message;
  }

  function encodeOne(packet, doneCallback) {
    exports.encodePacket(
      packet,
      !isBinary ? false : supportsBinary,
      false,
      function(message) {
        doneCallback(null, setLengthHeader(message));
      }
    );
  }

  map(packets, encodeOne, function(err, results) {
    return callback(results.join(""));
  });
};

/**
 * Async array map using after
 */

function map(ary, each, done) {
  var result = new Array(ary.length);
  var next = after(ary.length, done);

  var eachWithIndex = function(i, el, cb) {
    each(el, function(error, msg) {
      result[i] = msg;
      cb(error, result);
    });
  };

  for (var i = 0; i < ary.length; i++) {
    eachWithIndex(i, ary[i], next);
  }
}

/*
 * Decodes data when a payload is maybe expected. Possible binary contents are
 * decoded from their base64 representation
 *
 * @param {String} data, callback method
 * @api public
 */

exports.decodePayload = function(data, binaryType, callback) {
  if (typeof binaryType === "function") {
    callback = binaryType;
    binaryType = null;
  }

  var packet;
  if (data === "") {
    // parser error - ignoring payload
    return callback(err, 0, 1);
  }

  var length = "",
    n,
    msg;

  for (var i = 0, l = data.length; i < l; i++) {
    var chr = data.charAt(i);

    if (chr !== ":") {
      length += chr;
      continue;
    }

    if (length === "" || length != (n = Number(length))) {
      // parser error - ignoring payload
      return callback(err, 0, 1);
    }

    msg = data.substr(i + 1, n);

    if (length != msg.length) {
      // parser error - ignoring payload
      return callback(err, 0, 1);
    }

    if (msg.length) {
      packet = exports.decodePacket(msg, binaryType, false);

      if (err.type === packet.type && err.data === packet.data) {
        // parser error in individual packet - ignoring payload
        return callback(err, 0, 1);
      }

      var ret = callback(packet, i + n, l);
      if (false === ret) return;
    }

    // advance cursor
    i += n;
    length = "";
  }

  if (length !== "") {
    // parser error - ignoring payload
    return callback(err, 0, 1);
  }
};
