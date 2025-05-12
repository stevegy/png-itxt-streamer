const duplexer = require('duplexer')
const encode = require('png-chunk-streamer').encode
const decode = require('png-chunk-streamer').decode
const through = require('through2')
const pako = require('pako')

const zTXt = exports.zTXt = 'zTXt'
const iTXt = exports.iTXt = 'iTXt'
const tEXt = exports.tEXt = 'tEXt'
const matchOperatorsRe = /[|\\{}()[\]^$+*?.]/g

const chunkDecoder = {
  iTXt: function (keyword, data, callback) {
    let result = {
      'type': iTXt,
      'keyword': keyword
    }
    result.compressed = (data[0] === 1)
    result.compression_type = data[1]

    let unprocessed = data.slice(2)
    let pos = getFieldEnd(unprocessed)
    result.language = unprocessed.slice(0, pos).toString('utf8')
    unprocessed = unprocessed.slice(pos + 1)

    pos = getFieldEnd(unprocessed)
    result.translated = unprocessed.slice(0, pos).toString('utf8')
    unprocessed = unprocessed.slice(pos + 1)

    // Not sure if this can be tidied up somewhat.
    if (result.compressed) {
      try {
        result.value = pako.inflate(unprocessed, { to: 'string' })
        callback(null, result)
      } catch (err) {
        callback(err, result)
      }
    } else {
      result.value = unprocessed.toString('utf8')
      callback(null, result)
    }
  },
  tEXt: function (keyword, data, callback) {
    const result = {
      'type': tEXt,
      'keyword': keyword,
      'value': data.toString('utf8')
    }
    callback(null, result)
  },
  zTXt: function (keyword, data, callback) {
    const result = {
      'type': zTXt,
      'keyword': keyword,
      'compressed': true,
      'compression_type': data[0]
    }

    try {
      result.value = pako.inflate(data.slice(1), { to: 'string' })
      callback(null, result)
    } catch (err) {
      callback(err, result)
    }
  }
}

const chunkEncoder = {
  iTXt: function (data) {
    const keylen = Math.min(79, Buffer.byteLength(data.keyword))
    const languagelen = data.language ? Buffer.byteLength(data.language) : 0
    const translatedlen = data.translated ? Buffer.byteLength(data.translated) : 0

    const value = new Buffer(data.compressed ? pako.deflate(data.value) : data.value)
    const datalen = value.length

    // 5 is for all the null characters that seperate the fields.
    const buffer = new Buffer(keylen + 5 + datalen + languagelen + translatedlen)

    // Write keyword and null terminate.
    buffer.write(data.keyword, 0, keylen)
    buffer[keylen] = 0

    buffer[keylen + 1] = data.compressed ? 1 : 0
    // Just set to zero as it is the only valid value.
    buffer[keylen + 2] = 0

    let currentPos = keylen + 3
    // check language tag
    if (!data.language) {
      buffer[currentPos] = 0
      currentPos++
    } else {
      buffer.write(data.language, currentPos, languagelen)
      buffer[currentPos + languagelen] = 0
      currentPos += languagelen + 1
    }

    if (!data.translated) {
      buffer[currentPos] = 0
      currentPos++
    } else {
      buffer.write(data.translated, currentPos, translatedlen)
      buffer[currentPos + translatedlen] = 0
      currentPos += translatedlen + 1
    }

    value.copy(buffer, currentPos)
    return buffer
  },
  tEXt: function (data) {
    const keylen = Math.min(79, Buffer.byteLength(data.keyword))
    // 3 is for all the null characters that seperate the fields.
    const buffer = new Buffer(keylen + 1 + Buffer.byteLength(data.value))
    buffer.write(data.keyword, 0, keylen)
    buffer[keylen] = 0

    buffer.write(data.value, keylen + 1)
    return buffer
  },
  zTXt: function (data) {
    const keylen = Math.min(79, Buffer.byteLength(data.keyword))

    // Has to be compressed so make sure it is
    data.compressed = true
    const value = new Buffer(pako.deflate(data.value))
    const datalen = value.length

    // 2 is for all the null characters that seperate the fields.
    const buffer = new Buffer(keylen + 2 + datalen)
    buffer.write(data.keyword, 0, keylen)
    buffer[keylen] = 0

    // Just set to 0 as it is the only value
    buffer[keylen + 1] = 0

    value.copy(buffer, keylen + 2)
    return buffer
  }
}

function set (data, replaceAll) {
  const encoder = encode()
  const decoder = decode()

  // Assume iTXt chunks to be created
  if (data.type === undefined) {
    data.type = iTXt
  }

  const createChunk = chunkEncoder[data.type]
  if (createChunk === undefined) {
    throw new Error('invalid chunk type specified')
  }

  decoder.pipe(through.obj(function (chunk, enc, cb) {
    // Add just before end if not found.
    if (chunk.type === 'IEND' && !this.found) {
      if (data.value !== null) {
        this.push({ 'type': data.type, 'data': createChunk(data) })
      }
      this.push(chunk)
      return cb()
    }

    if (chunk.type === data.type || (replaceAll !== undefined && replaceAll &&
      (chunk.type === iTXt || chunk.type === zTXt || chunk.type === tEXt))) {
      const pos = getFieldEnd(chunk.data)
      if (chunk.data.slice(0, pos).toString() === data.keyword) {
        if (!this.found) {
          if (data.value !== null) {
            this.push({ 'type': data.type, 'data': createChunk(data) })
          }
          this.found = true
        }
      // If it is the same keyword and it has been replaced ignore chunk.
      } else {
        // Push all chunks where keyword not matched.
        this.push(chunk)
      }
    } else {
      // push all non textual chunks
      this.push(chunk)
    }

    cb()
  })).pipe(encoder)

  return duplexer(decoder, encoder)
}

function get (keyword, filters, callback) {
  // Make sure that there is a callback function
  if (!callback) {
    if (typeof (filters) === 'function') {
      callback = filters
      filters = null

      if (Array.isArray(keyword)) {
        filters = keyword
        keyword = null
      }
    } else if (filters === undefined &&
      typeof (keyword) === 'function') {
      callback = keyword
      keyword = null
      filters = null
    } else {
      // throw exception if there is no callback.
      throw new Error('no callback or invalid arguments provided')
    }
  }
  // If a keyword has been specified make sure it is a regular expression.
  if (keyword && (!(keyword instanceof RegExp))) {
    keyword = new RegExp('^' + keyword.toString().replace(matchOperatorsRe, '\\$&') + '$')
  }

  const encoder = encode()
  const decoder = decode()

  let localHandlers = {}
  if (filters !== undefined && filters !== null) {
    let hasHandler = false
    if (Array.isArray(filters)) {
      for (const index in filters) {
        const filter = filters[index]
        localHandlers[filter] = chunkDecoder[filter]
        hasHandler = true
      }
    }

    // If no handlers match just pass data through
    // without looking at it.
    if (!hasHandler) {
      callback(new Error('invalid filter specified'), null)
      return duplexer(decoder, encoder)
    }
  } else {
    localHandlers = chunkDecoder
  }

  decoder.pipe(through.obj(function (chunk, enc, cb) {
    this.push(chunk)

    // Sees if there is a handler for the current type.
    const handler = localHandlers[chunk.type]
    if (handler) {
      // If there is get the keyword and it is one we are
      // looking for then pass it to the handler.
      const pos = getFieldEnd(chunk.data)
      const currentkey = chunk.data.slice(0, pos).toString('utf8')

      if (!keyword || keyword.test(currentkey)) {
        this.found = true
        handler(currentkey, chunk.data.slice(pos + 1), callback)
      }
    } else if (chunk.type === 'IEND' && (!this.found)) {
      // Works because shouldn't be a handler for IEND
      callback(null, null)
    }

    cb()
  })).pipe(encoder)

  return duplexer(decoder, encoder)
}

function getFieldEnd (data) {
  let i
  const len = data.length;
  for (i = 0; i < len; ++i) {
    if (!data[i]) break
  }
  return i
}

// import wrapper functions
const wrapper = require('./lib/wrapper.js')
exports.getitxt = wrapper.getitxt
exports.getztxt = wrapper.getztxt
exports.gettext = wrapper.gettext

exports.set = set
exports.get = get
exports.createChunk = exports.chunk = function (data) {
  const createChunk = chunkEncoder[data.type]
  if (createChunk === undefined) {
    // Can't handle the chunk
    return null
  }

  return createChunk(data)
}
