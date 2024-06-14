const { Writable } = require('stream');
const { Buffer } = require('buffer');
const path = require('path');
const { uuid, trimQuotation } = require('./utils');
const fs = require('fs');
const http = require('http');

const DELIMITER = Buffer.from('\r\n');
const FILE_STREAM = Symbol('fileStream');
class FormParser extends Writable {
  constructor(options) {
    super(options);
    this._rawFormData = {};
    this.formData = {};
    this._options = options;
    this._p = 0;
    this._readIndex = 0;
    this._buffer = Buffer.alloc(this.writableHighWaterMark);
    this._readTypeIndex = 0;
    this._readTypes = [
      '_readBoundary',
      '_readDelimiter',
      '_readContentDisposition',
      '_readDelimiter',
    ];
    this._boundary = 'boundary';
    // 读取的content-disposition对象
    this._contentDispositionObj = null;
    this._setBoundary(options.req);
    this._options.req.pipe(this);
  }
  _write(chunk, _, callback) {
    let writeLength = 0;
    while (writeLength < chunk.length) {
      this._fillToLeft();
      const copyLength = chunk.copy(
        this._buffer,
        this._p,
        writeLength
      );
      this._p += copyLength;
      writeLength += copyLength;
      try {
        this._readFormData();
      } catch (e) {
        callback && callback(e);
        return;
      }
    }
    callback && callback();
  }

  _final(callback) {
    // console.log(this._buffer.toString())
    this._readBoundary(true);
    this._normalizeFormData();

    console.log(this.formData);
    callback(); // 告诉 Node.js 清理工作已完成
  }

  // 读取\r\n
  _readDelimiter() {
    const findIndex = this._getBuffer().indexOf(DELIMITER);
    if (findIndex !== 0) {
      return false;
    }
    this._readIndex += DELIMITER.byteLength;
    return true;
  }

  // 读取分隔符
  _readBoundary(end = false) {
    let boundary = '--' + this._boundary;
    if (end) {
      boundary = '--';
    }
    const boundaryBuf = Buffer.from(boundary);

    const findIndex = this._getBuffer().indexOf(boundaryBuf);
    if (findIndex === -1) {
      const endIndex = this._getLastIndex() - boundaryBuf.byteLength;
      if (endIndex > this._readIndex) {
        this._collectionFormData(
          this._readIndex,
          this._getLastIndex() - boundaryBuf.byteLength
        );
        this._readIndex = this._getLastIndex() - boundaryBuf.byteLength;
      }
      return false;
    }

    // 如果读取到了分隔符，说明上一个数据已经读取完毕，将上一个数据存储到data中
    if (this._contentDispositionObj) {
      this._collectionFormData(
        this._readIndex,
        this._readIndex + findIndex - DELIMITER.byteLength
      );
      this._contentDispositionObj = null;
    }
    this._readIndex += findIndex + boundaryBuf.byteLength;
    return true;
  }

  // 读取 Content-Disposition
  _readContentDisposition() {
    if (this._getBuffer().indexOf('Content-Disposition') === -1) {
      return false;
    }
    const findIndex = this._getBuffer().indexOf(DELIMITER);
    if (findIndex === -1) {
      return false;
    }
    const contentDisposition = this._buffer
      .subarray(this._readIndex, this._readIndex + findIndex)
      .toString();
    const contentDispositionValue = contentDisposition.split(': ')[1];
    if (!contentDispositionValue) {
      throw new Error('Content-Disposition value is required');
    }
    const contentDispositionValueItems = contentDispositionValue.split('; ');
    if (contentDispositionValueItems[0] !== 'form-data') {
      throw new Error('Content-Disposition value is not form-data');
    }
    const contentDispositionObj = {
      id: uuid(),
    };
    contentDispositionValueItems.slice(1).forEach((item) => {
      const [key, value] = item.split('=');
      contentDispositionObj[trimQuotation(key)] = trimQuotation(value);
    });

    // 移动指针
    const readIndex = this._readIndex;
    this._readIndex += findIndex + DELIMITER.byteLength;

    if (contentDispositionObj.filename) {
      // 读取 Content-Type
      const findContentTypeIndex = this._getBuffer().indexOf('Content-Type');
      if (findContentTypeIndex === -1) {
        this._readIndex = readIndex;
        return false;
      }
      const contentTypeEndIndex = this._getBuffer().indexOf(DELIMITER);
      if (contentTypeEndIndex === -1) {
        this._readIndex = readIndex;
        return false;
      }
      const contentType = this._buffer
        .subarray(this._readIndex, this._readIndex + contentTypeEndIndex)
        .toString();
      const contentTypeInfo = this._parseContentType(
        contentType.split(': ')[1]
      );
      // console.log('content-disposition', contentTypeValueItems)
      contentDispositionObj['contentType'] = contentTypeInfo.value;
      contentDispositionObj['contentTypeInfo'] = contentTypeInfo;
      this._readIndex += contentTypeEndIndex + DELIMITER.byteLength;
      if (contentDispositionObj['filename']) {
        const filename = path.join(
          this._options.uploadDir,
          uuid() + path.extname(contentDispositionObj['filename'])
        );
        const fileStream = this._options.getFile
          ? Promise.resolve(this._options.getFile(contentDispositionObj))
          : fs.createWriteStream(filename);
        contentDispositionObj[FILE_STREAM] = fileStream;
        contentDispositionObj['filename'] = filename;
      }
    }

    this._contentDispositionObj = contentDispositionObj;

    return true;
  }

  _getBuffer() {
    return this._buffer.subarray(this._readIndex, this._getLastIndex());
  }

  _setBoundary(req) {
    // 从req.headers中读取boundary
    const contentType = req.headers['content-type'];
    if (!contentType) {
      throw new Error('Content-Type is required');
    }
    const contentTypeInfo = this._parseContentType(contentType);
    if (!contentTypeInfo.boundary) {
      throw new Error('boundary is required');
    }
    this._boundary = contentTypeInfo.boundary;
  }

  _getLastIndex() {
    return this._p;
  }

  // 收集表单数据
  _collectionFormData(startIndex, endIndex) {
    if (this._contentDispositionObj) {
      const data = Buffer.from(this._buffer.subarray(startIndex, endIndex));
      let fieldValues = this._rawFormData[this._contentDispositionObj.name];
      if (!fieldValues) {
        fieldValues = [];
        this._rawFormData[this._contentDispositionObj.name] = fieldValues;
      }

      // 如果是文件，将文件流写入到文件中
      let fieldValue = fieldValues.find(
        (item) => item.id === this._contentDispositionObj.id
      );
      if (fieldValue) {
        if (fieldValue.isFile) {
          fieldValue.data.write(data);
        } else {
          fieldValue.data = Buffer.concat([fieldValue.data, data]);
        }
      } else {
        if (this._contentDispositionObj[FILE_STREAM]) {
          this._contentDispositionObj[FILE_STREAM].write(data);
        }
        fieldValues.push({
          id: this._contentDispositionObj.id,
          data: this._contentDispositionObj[FILE_STREAM] || data,
          contentTypeInfo: this._contentDispositionObj.contentTypeInfo,
          filename: this._contentDispositionObj.filename,
          isFile: !!this._contentDispositionObj[FILE_STREAM],
        });
      }
    }
  }

  _normalizeFormData() {
    // console.log(this._rawFormData)
    for (const key in this._rawFormData) {
      const fieldValues = this._rawFormData[key];
      this.formData[key] = [];
      fieldValues.forEach((fieldValue) => {
        // console.log(fieldValue)
        if (fieldValue.contentTypeInfo) {
          const { value } = fieldValue.contentTypeInfo;
          if (fieldValue.isFile) {
            this.formData[key].push({
              filename: fieldValue.filename,
              contentType: fieldValue.contentTypeInfo.value,
              file: fieldValue.data,
            });
          } else {
            switch (value) {
              case 'text/plain':
                this.formData[key].push(fieldValue.data.toString());
              case 'application/json':
                this.formData[key].push(JSON.parse(fieldValue.data.toString()));
                break;
              default:
            }
          }
        } else {
          this.formData[key].push(fieldValue.data.toString());
        }
      });
    }
  }

  getFormData(key) {
    if (key) {
      return this.formData[key].length === 1
        ? this.formData[key][0]
        : this.formData[key];
    }
    return this.formData;
  }

  _parseContentType(contentType) {
    if (!contentType) {
      throw new Error('Content-Type value is required');
    }
    const contentTypeValueItems = contentType.split('; ');
    const contentTypeType = contentTypeValueItems[0];
    const contentTypeInfo = {
      charset: 'utf-8',
      value: contentTypeType,
    };
    contentTypeValueItems.slice(1).forEach((item) => {
      const [key, value] = item.split('=');
      contentTypeInfo[trimQuotation(key)] = trimQuotation(value);
    });
    return contentTypeInfo;
  }

  // 将数据填充移动到左边
  _fillToLeft() {
    if (this._readIndex > 0 && this._readIndex < this._p) {
      const copyLength = this._buffer
        .subarray(this._readIndex)
        .copy(this._buffer);
      this._p = copyLength;
      this._readIndex = 0;
    }
  }

  _readFormData() {
    while (this._readTypeIndex < this._readTypes.length) {
      if (this._readIndex >= this._getLastIndex()) return;
      const readType = this._readTypes[this._readTypeIndex];
      const isRead = this[readType]();
      if (!isRead) {
        return;
      }
      this._readTypeIndex++;
    }
    this._readTypeIndex = 0;
  }
}

// 写入数据
// myWritable.write('Hello, ');
// myWritable.write('World!');

// // 结束流
// // myWritable.end();

// // 监听 'finish' 事件，该事件在流结束时触发
// myWritable.on('finish', () => {
//   console.log('Stream has finished.');
// });

const server = http.createServer((req, res) => {
  if (req.method === 'POST') {
    const formParser = new FormParser({
      highWaterMark: 150,
      req,
      uploadDir: path.resolve(__dirname, 'uploads'),
    });
    formParser.on('finish', () => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(formParser.getFormData()));
    });
  } else {
    res.setHeader('Content-Type', 'text/html');
    fs.createReadStream(path.resolve(__dirname, 'index.html')).pipe(res);
  }
});

server.listen(3000, () => {
  console.log('server is running on 3000');
});
