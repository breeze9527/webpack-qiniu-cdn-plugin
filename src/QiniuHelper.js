const qiniu = require('qiniu');
const utils = require('./utils');

/**
 * @typedef {object} File
 * @property {string} name
 * @property {string} hash
 * 
 * @typedef {object} Options
 * @property {string} accessKey
 * @property {string} secretKey
 * @property {string} bucket
 * @property {string} prefix
 */

const BUFFER_LENGTH_OF_4M = 4 * Math.pow(2, 10 * 2)

class QiniuHepler {
  /**
   * @param {Options} options 
   */
  constructor(options) {
    const {
      secretKey,
      accessKey,
      bucket,
      prefix
    } = options;
    const mac = new qiniu.auth.digest.Mac(accessKey, secretKey);
    this.bucketManager = new qiniu.rs.BucketManager(mac);
    this.cdnManager = new qiniu.cdn.CdnManager(mac);
    this.formUploader = new qiniu.form_up.FormUploader();
    this.mac = mac;
    this.bucket = bucket;
    this.prefix = prefix;
  }
  /**
   * cdn文件列表
   * @param {(error: Error | null, files?: File[]) => void} callback 回调
   */
  listCdnFiles(callback) {
    const bucketManager = this.bucketManager;
    const bucket = this.bucket;
    let result = [];
    const prefix = this.prefix;
    const load = marker => {
      bucketManager.listPrefix(bucket, { prefix, marker }, (err, body, info) => {
        if (err) {
          callback(err);
        } else if (info.statusCode !== 200) {
          callback(new Error(`list remote files error: ${JSON.stringify(body)}`));
        } else {
          /** @type {File[]} */
          const items = body.items.map(item => ({
            name: utils.removePrefix(item.key, prefix),
            hash: item.hash
          }));
          result = result.concat(items);
          if (body.marker) {
            load(body.marker);
          } else {
            callback(null, result);
          }
        }
      });
    }
    load();
  }

  /**
   * 计算七牛hash
   * https://developer.qiniu.com/kodo/manual/1231/appendix#qiniu-etag
   * @param {Buffer} buf 
   * @returns {string}
   */
  hashFile(buf) {
    let fileHash;
    if (buf.length <= BUFFER_LENGTH_OF_4M) {
      const chunkHash = utils.hashChunk(buf);
      fileHash = Buffer.concat([Buffer.from([0x16]), chunkHash]);
    } else {
      const chunkHashes = [];
      while (buf.length) {
        const chunk = buf.slice(0, BUFFER_LENGTH_OF_4M);
        chunkHashes.push(utils.hashChunk(chunk));
        buf = buf.slice(BUFFER_LENGTH_OF_4M);
      }
      const hashOfHash = utils.hashChunk(Buffer.concat(chunkHashes));
      fileHash = Buffer.concat([Buffer.from([0x96]), hashOfHash]);
    }
    return fileHash
      .toString('base64')
      .replace(/\/|\+/g, (match) => match === '+' ? '-' : '_');
  }

  /**
   * 上传文件
   * @param {string} filekey 文件名称，包含路径,不包含prefix
   * @param {Buffer} content 文件内容
   * @param {(error: Error | null, callback: (hash: String) => void) => void} callback 文件内容
   */
  uploadBuffer(filekey, content, callback) {
    filekey = `${this.prefix}${utils.filePath2Uri(filekey)}`;
    const putPolicy = new qiniu.rs.PutPolicy({
      scope: `${this.bucket}:${filekey}`,
    });
    const uploadToken = putPolicy.uploadToken(this.mac);
    this.formUploader.put(
      uploadToken,
      filekey,
      content,
      null,
      (error, body, info) => {
        if (error) {
          callback(error);
        } else if (info.statusCode !== 200) {
          callback(new Error(`UploadFile error: ${JSON.stringify(body)}`));
        } else {
          callback(null, body.hash);
        }
      }
    );
  }

  /**
   * 刷新cdn缓存
   * @param {string[]} urls 刷新的url列表
   * @param {(error: Error | null) => void} callback 
   */
  cdnRefresh(urls, callback) {
    const cdnManager = this.cdnManager;
    /** @type {string[][]} */
    const urlQueue = utils.splitList(urls, 100);
    utils.asyncQueue(
      urlQueue,
      1,
      (partialUrl, subCallback) => {
        cdnManager.refreshUrls(partialUrl, (error, body, info) => {
          if (error) {
            subCallback(error);
          } else if (info.statusCode !== 200) {
            subCallback(new Error(`CDN refresh error: ${JSON.stringify(body)}`));
          } else {
            subCallback();
          }
        });
      },
      callback
    );
  }

  /**
   * 预取cdn缓存
   * @param {string[]} urls 刷新的url列表
   * @param {(error: Error | null) => void} callback 
   */
  cdnPrefetch(urls, callback) {
    const cdnManager = this.cdnManager;
    /** @type {string[][]} */
    const urlQueue = utils.splitList(urls, 100);
    utils.asyncQueue(
      urlQueue,
      1,
      (partialUrl, subCallback) => {
        cdnManager.prefetchUrls(partialUrl, (error, body, info) => {
          if (error) {
            subCallback(error);
          } else if (info.statusCode !== 200) {
            subCallback(new Error(`CDN prefetch error: ${JSON.stringify(body)}`));
          } else {
            subCallback();
          }
        });
      },
      callback
    );
  }

  /**
   * 批量删除文件
   * @param {string[]} filenames 
   * @param {(error: Error | null) => void} callback 
   */
  batchDelete(filenames, callback) {
    const prefix = this.prefix;
    const operations = filenames.map(item => qiniu.rs.deleteOp(this.bucket, `${prefix}${item}`));
    this.bucketManager.batch(operations, (error, body, info) => {
      if (error) {
        callback(error);
      } else if (info.statusCode !== 200) {
        callback(new Error(`Delete remote file(${filenames}) error:\n${JSON.stringify(body)}`));
      } else {
        callback();
      }
    });
  }
}

module.exports = QiniuHepler;