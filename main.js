const { Writable } = require('stream');
const { Buffer } = require('buffer');
const path = require('path');
const { uuid, trimQuotation } = require('./utils');
const fs = require('fs');
const http = require('http');

const DELIMITER = Buffer.from('\r\n');
const CONTENT_DISPOSITION = Buffer.from('Content-Disposition');
const CONTENT_TYPE = Buffer.from('Content-Type');
const END_DELIMITER = Buffer.from('--');
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
      '_readContentType',
      '_readDelimiter'
    ];
    this._boundary = 'boundary';
    // 读取的content-disposition对象
    this._contentDispositionObj = null;
    this._setBoundary(options.req);
    this._options.req.pipe(this);
    this._isEnd = false;
  }
  _write(chunk, _, callback) {
    let writeLength = 0;
    while (writeLength < chunk.length) {
      this._fillToLeft();
      const copyLength = chunk.copy(this._buffer, this._p, writeLength);
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
    let error = null;
    if (!this._isEnd) {
      error = new Error('invalid end');
    }
    this._normalizeFormData();

    console.log(this.formData);
    callback(error); // 告诉 Node.js 清理工作已完成
  }

  // 读取\r\n
  _readDelimiter() {
    const findIndex = this._indexOf(DELIMITER);
    if (findIndex === -1) {
      return 0;
    }
    
    if (findIndex !== 0) {
      if (this._buffer.subarray(this._readIndex, this._readIndex + findIndex).equals(END_DELIMITER)) {
        this._isEnd = true;
        this._readIndex = this._p;
        return this._readTypes.length;
      }
      throw new Error('invalid delimiter');
    }
    this._readIndex += DELIMITER.byteLength;
    return 1;
  }

  // 读取分隔符
  _readBoundary() {
    let boundary = '--' + this._boundary;
    const boundaryBuf = Buffer.from(boundary);

    const findIndex = this._indexOf(boundaryBuf);
    if (findIndex === -1) {
      const endIndex = this._getLastIndex() - boundaryBuf.byteLength + 1;
      if (endIndex > this._readIndex) {
        this._collectionFormData(this._readIndex, endIndex);
        this._readIndex = endIndex;
      }
      return 0;
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
    return 1;
  }

  _indexOf(buffer) {
    return this._getBuffer().indexOf(buffer);
  }

  // 读取 Content-Disposition
  _readContentDisposition() {
    const findIndex = this._indexOf(DELIMITER);
    if (findIndex === -1) {
      return 0;
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

    this._contentDispositionObj = contentDispositionObj;
    // 移动指针
    this._readIndex += findIndex + DELIMITER.byteLength;
    
    this._contentDispositionObj = contentDispositionObj;

    return 1;
  }

  _readContentType() {
    // 读取 Content-Type
    const contentTypeEndIndex = this._indexOf(DELIMITER);
    if (contentTypeEndIndex === -1) {
      return 0;
    }
    if (contentTypeEndIndex === 0) {
      this._readIndex += DELIMITER.byteLength;
      return 2;
    }
    const contentType = this._buffer
      .subarray(this._readIndex, this._readIndex + contentTypeEndIndex)
      .toString();
    const contentTypeInfo = this._parseContentType(contentType.split(': ')[1]);
    // console.log('content-disposition', contentTypeValueItems)
    const contentDispositionObj = this._contentDispositionObj || {};
    contentDispositionObj['contentType'] = contentTypeInfo.value;
    contentDispositionObj['contentTypeInfo'] = contentTypeInfo;
    
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
    this._readIndex += contentTypeEndIndex + DELIMITER.byteLength;
    this._contentDispositionObj = contentDispositionObj;
    return 1;
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
              case 'application/json':
                this.formData[key].push(JSON.parse(fieldValue.data.toString()));
                break;
              default:
                this.formData[key].push(fieldValue.data.toString());
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
    if (this._isEnd) {
      throw new Error('multpart/form-data invalid end');
    }
    while (this._readTypeIndex < this._readTypes.length) {
      if (this._readIndex >= this._getLastIndex()) return;
      const readType = this._readTypes[this._readTypeIndex];
      const nextStep = this[readType]();
      if (nextStep === 0) {
        return;
      }
      this._readTypeIndex += nextStep;
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
