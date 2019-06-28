const fs = require('fs');
const path = require('path');

const QiniuHelper = require('./QiniuHelper');
const VersionLog = require('./VersionLog');
const utils = require('./utils');

const DEBUG_LABEL = '[QiniuCDNPlugin]'

/**
 * @typedef {import('webpack/lib/Compilation')} Compilation
 * @typedef {import('./QiniuHelper').File} RemoteFile
 * @typedef {import('./VersionLog').LogDetail} LogDetail
 * 
 * @typedef {object} LocalFile
 * @property {string} filePath path/to/file.ext
 * @property {Buffer} content
 * @property {string} hash
 * 
 * @typedef {object} ExpireOption
 * @property {number} [time] 上传时间超过多久允许清除，单位秒 基于本地构建时间
 * @property {number} [versions] 保留几个版本
 *      0表示不保留先前版本
 *      1表示仅保留1个版本(上一个版本)，以此类推
 * 
 * @typedef {object} Options
 * @property {string} accessKey qiniu accessKey
 * @property {string} secretKey qiniu secretKey
 * @property {string} bucket qiniu bucket
 * @property {string} cdnHost CDN host
 * @property {string} [dir=''] 前缀
 * @property {string} [logFile='upload-log.json'] 记录文件的文件名
 * @property {ExpireOption} [expire] 生命周期选项
 * @property {RegExp | ((name: string) => boolean)} [exclude] 哪些文件不需要上传 返回true表示不需要上传
 * @property {boolean} [refresh=false] 覆盖上传是否刷新CDN缓存
 * @property {boolean} [prefetch=false] 上传后是否执行CDN预取
 * @property {boolean} [silent=false] 安静模式
 * @property {boolean} [dry=false] 调试模式，不执行实际的上传删除操作
 */

/** @type {Options} */
const DEFAULT_OPTIONS = {
  dir: '',
  logFile: 'upload-log.json',
  remoteLog: true,
  expire: false,
  exclude: () => false,
  prefetch: false,
  refresh: false,
  silent: false,
  dry: false
}

class QiniuCDNPlugin {
  /**
   * @param {Options} options 选项
   */
  constructor(options) {
    utils.validateRequired(options, [
      'accessKey',
      'secretKey',
      'bucket',
      'cdnHost'
    ]);
    if (!/^(https?:)?\/\//.test(options.cdnHost)) {
      throw new Error(`${DEBUG_LABEL} Illegal cdn host`);
    }

    /** @type {Options} */
    const opt = this.options = {
      ...DEFAULT_OPTIONS,
      ...options
    };
    this.qiniu = new QiniuHelper({
      accessKey: opt.accessKey,
      secretKey: opt.secretKey,
      bucket: opt.bucket,
      prefix: opt.dir ? `${opt.dir}/` : ''
    });
    this.publicPath = `${opt.cdnHost}/`;
    if (opt.dir) {
      this.publicPath += `${opt.dir}/`
    }
    // e.g. //cdn.host/prefix/logfile.name
    this.remotePathname = this.publicPath;
    if (/^\/\//.test(this.remotePathname)) {
      this.remotePathname = 'http:' + this.remotePathname;
    }
    /** @type {Compilation} */
    this.compilation = null;
    this.outputPath = null;
    this.log = new VersionLog();
    /** @type {RemoteFile[]} */
    this.remoteFiles = [];
    /**
     * @typedef {'remote' | 'exclude' | 'overwrite' | 'omit' | 'upload' | 'clean'} StatusFields
     * @type {Record<StatusFields, LogDetail[]>}
     */
    this.uploadStatus = {
      remote: [],     // 初始获取的远程文件
      exclude: [],   // 被exclude剔除的文件
      overwrite: [],  // 覆盖的文件
      omit: [],       // 没有变更，已忽略的文件
      upload: [],     // 需要上传的文件
      clean: []       // 清除的文件
    };
    /** @type {Record<string, Buffer>} */
    this.fileSource = {};

    this.handler = this.handler.bind(this);
  }

  apply(compiler) {
    const hooks = compiler.hooks;
    const compilerOutputOptions = compiler.options.output;
    if (compilerOutputOptions.path) {
      this.outputPath = compilerOutputOptions.path;
    } else {
      throw new Error(`${DEBUG_LABEL} missing required option: options.output.path`);
    }
    // set `output.publicPath`
    const publicPath = this.publicPath;
    const userPublicPath = compilerOutputOptions.publicPath;
    if (userPublicPath && userPublicPath !== publicPath && this.options.silent !== true) {
      console.warn(`${DEBUG_LABEL} overwrite publicPath to ${publicPath} from ${userPublicPath}`);
    }
    compilerOutputOptions.publicPath = publicPath;

    // hooks
    if (hooks) {
      hooks.afterEmit.tapAsync('QiniuCDNPlugin', this.handler);
    } else {
      hooks.plugin('afterEmit', this.handler);
    }
  }

  /**
   * @param {Compilation} compilation
   */
  handler(compilation, callback) {
    this.compilation = compilation;
    this.initCDNStatus(initCDNError => {
      if (initCDNError) {
        callback(initCDNError);
        return;
      }
      this.initUploadStatus(initUploadStatusError => {
        if (initUploadStatusError) {
          callback(initUploadStatusError);
          return;
        }
        const { upload, overwrite, omit } = this.uploadStatus;
        // 推入记录，用于后续计算哪些文件需要清理
        this.log.append({
          timestamp: Math.floor(Date.now() / 1000),
          omit: omit.slice(),
          upload: [...upload, ...overwrite]
        });
        if (this.options.expire) {
          this.initCleanStatus(); // 初始化清理队列状态
        }
        this.run(runErr => {    // 执行上传，清理
          const options = this.options;
          if (options.silent !== true) {
            this.reportStatus();
          }

          if (runErr) {
            callback(runErr);
            return;
          }
          this.emitLog();
          if (options.refresh) {
            this.dnsRefresh();
          }
          if (options.prefetch) {
            this.dnsPrefetch();
          }
        });
      });
    });
  }

  run(callback) {
    utils.taskQueue(
      [
        this.uploadAssets.bind(this),
        this.cleanCDN.bind(this)
      ],
      callback
    )
  }

  /**
   * 初始化远程文件状态，包括`log`和`uploadStatus.remote`
   * @param {(error: Error | null) => void} callback 
   */
  initCDNStatus(callback) {
    const logFileName = this.options.logFile;
    this.qiniu.listCdnFiles((error, files) => {
      if (error) {
        callback(error);
        return;
      }

      const remoteFiles = files.slice();
      const logFileIndex = remoteFiles.findIndex(item => logFileName && item.name === logFileName);
      if (logFileIndex !== -1) {
        remoteFiles.splice(logFileIndex, 1)[0];
        let logFileUrl = `${this.remotePathname}${logFileName}`;
        utils.readRemoteFile(logFileUrl, (readLogError, statusCode, content) => {
          if (readLogError) {
            callback(readLogError);
          } else if ([200, 304].includes(statusCode)) {
            try {
              this.log.init(JSON.parse(content));
              callback();
            } catch (e) {
              callback(new Error(`${DEBUG_LABEL} parse remote log error:\n` + JSON.stringify(e)))
            }
          } else if (statusCode === 404) {
            console.warn(`${DEBUG_LABEL} log file not found(${logFileUrl})`);
          } else {
            callback(new Error(`${DEBUG_LABEL} fetch remote version log error(${statusCode}):\n${content}`));
          }
        });
      } else {
        callback();
      }

      this.uploadStatus.remote = remoteFiles.map(item => ({
        filename: item.name,
        hash: item.hash
      }));
    });
  }

  /**
   * 初始化上传状态: exclude, omit, upload, overwrite
   * @param {(error: Error | null) => void} callback 
   */
  initUploadStatus(callback) {
    const {
      omit,
      upload,
      overwrite,
      exclude
    } = this.uploadStatus;
    const filePaths = Object.keys(this.compilation.assets);
    // filter by exclude option
    const excludeTest = this.options.exclude;
    const filteredFilePaths = filePaths
      .filter(filePath => {
        // const relativePath = path.relative(this.outputPath, filePath);
        if (typeof excludeTest === 'function' ? excludeTest(filePath) : excludeTest.test(filePath)) {
          exclude.push({
            filename: utils.filePath2Uri(filePath),
            hash: '*EXCLUDED*'
          });
          return false;
        } else {
          return true;
        }
      })
      .map(assetsKey => path.join(this.outputPath, assetsKey));

    /** @type {LocalFile[]} */
    const localFiles = [];
    utils.asyncQueue(
      filteredFilePaths,
      10,
      (filePath, subCallback) => {
        fs.readFile(filePath, (err, buf) => {
          if (err) {
            subCallback(err);
            return;
          }
          localFiles.push({
            filePath,
            content: buf,
            hash: this.qiniu.hashFile(buf)
          });
          subCallback();
        });
      },
      err => {
        if (err) {
          callback(err);
          return;
        }
        const remoteFiles = this.uploadStatus.remote;
        localFiles.forEach(file => {
          const fileHash = file.hash;
          const pathname = path.relative(this.outputPath, file.filePath);
          const fileUri = utils.filePath2Uri(pathname);
          const remoteFile = remoteFiles.find(item => item.filename === fileUri);
          this.fileSource[fileUri] = file.content;
          /** @type {LogDetail} */
          const logItme = {
            filename: fileUri,
            hash: fileHash
          }
          if (remoteFile && remoteFile.hash === fileHash) {
            // file unchanged, pass it
            omit.push(logItme);
          } else if (!remoteFile) {
            // upload
            upload.push(logItme);
          } else {
            // overwrite
            overwrite.push(logItme);
          }
        });
        callback();
      }
    );
  }

  /**
   * 刷新dns缓存
   */
  dnsRefresh() {
    const urls = this.uploadStatus.overwrite.map(item => `${this.remotePathname}${item.filename}`);
    if (urls.length === 0) {
      return;
    }
    if (this.options.dry) {
      console.log(`${DEBUG_LABEL} dry refresh cdn:\n ${urls.join('\n')}`);
      return;
    }
    this.qiniu.cdnRefresh(urls, error => {
      if (error) {
        console.error(`${DEBUG_LABEL} refresh cdn error`, error);
      } else if (this.options.silent !== true) {
        console.log(`${DEBUG_LABEL} refresh cdn success`);
      }
    });
  }

  /**
   * 预取
   */
  dnsPrefetch() {
    const urls = this.uploadStatus.upload.map(item => `${this.remotePathname}${item.filename}`);
    if (urls.length === 0) {
      return;
    }
    if (this.options.dry) {
      console.log(`${DEBUG_LABEL} dry prefetch cdn:\n ${urls.join('\n')}`);
      return;
    }
    this.qiniu.cdnPrefetch(urls, error => {
      if (error) {
        console.error(`${DEBUG_LABEL} refresh cdn error`, error);
      } else if (this.options.silent !== true) {
        console.log(`${DEBUG_LABEL} refresh cdn success`);
      }
    });
  }

  /**
   * 上传资源
   * @param {function} callback 
   */
  uploadAssets(callback) {
    const { upload, overwrite } = this.uploadStatus;
    utils.asyncQueue(
      [...overwrite, ...upload],
      10,
      /** @param {LogDetail} file */
      (file, subCallback) => {
        const filename = file.filename;
        const fileSource = this.fileSource[filename];
        if (this.options.dry) {
          console.log(`${DEBUG_LABEL} dry upload\n filename: ${filename}\nhash: ${file.hash}`);
          subCallback();
          return;
        }
        this.qiniu.uploadBuffer(filename, fileSource, (error, hash) => {
          if (error) {
            subCallback(error);
          } else {
            if (hash !== file.hash && this.options.silent !== true) {
              console.warn(`${DEBUG_LABEL} hash error of file: ${filename}\nlocal: ${file.hash} \nqiniu: ${hash}`);
            }
            subCallback();
          }
        });
      },
      callback
    )
  }

  /**
   * 清除过期的文件
   * @param {(error: Error | null) => void} callback 
   */
  cleanCDN(callback) {
    const filenames = this.uploadStatus.clean.map(item => item.filename);
    if (filenames.length) {
      if (this.options.dry) {
        console.log(`${DEBUG_LABEL} dry clean: ${filenames}`);
        callback();
        return;
      }
      this.qiniu.batchDelete(filenames, callback);
    } else {
      callback();
    }
  }

  /**
   * 初始化cdn回收状态 uploadStatus.clean
   */
  initCleanStatus() {
    const log = this.log;
    const lastVersion = log.getLastVersion();
    const {
      time: expireTime,
      versions: preserveVersions
    } = this.options.expire;
    const deadline = typeof expireTime === 'number' ? lastVersion.timestamp - expireTime : undefined;
    const firstExpireVersionIndex = log.getFirstExpireVersionIndex(preserveVersions, deadline);
    const cleanStatus = this.uploadStatus.clean;
    log.getVersions(firstExpireVersionIndex).forEach(({ omit, upload }, index, arr) => {
      /** @type {LogDetail[]} */
      const files = [].concat(upload).concat(index === arr.length - 1 ? omit : []);
      files.forEach(file => {
        const fileVersionIndex = log.findVersion(file.filename).versionIndex;
        if (fileVersionIndex >= firstExpireVersionIndex) {
          cleanStatus.push({
            ...file
          });
        }
      });
    });
  }

  emitLog() {
    const {
      logFile,
      expire,
      dry
    } = this.options;
    if (!logFile) {
      return;
    }
    let logData = null;
    if (expire) {
      const {
        time: expireTime,
        versions: preserveVersions
      } = expire;
      const lastVersionTime = this.log.getLastVersion().timestamp;
      const deadline = typeof expireTime === 'number' ? lastVersionTime - expireTime : undefined;
      logData = this.log.getFreshVersions(preserveVersions, deadline);
    } else {
      logData = this.log.getVersions();
    }
    const logContent = JSON.stringify(logData, undefined, 2);
    if (dry) {
      console.log(`${DEBUG_LABEL} dry emit log\n ${logContent}`);
      return;
    }
    this.qiniu.uploadBuffer(logFile, Buffer.from(logContent), error => {
      if (error) {
        console.error(error);
      }
    });
  }

  reportStatus() {
    Object.keys(this.uploadStatus).forEach(key => {
      /** @type {LogDetail[]} */
      const files = this.uploadStatus[key];
      utils.drawTable(files.map(file => [file.filename, file.hash]), `${key}: ${files.length}`);
      console.log('\n');
    });
  }
}

module.exports = QiniuCDNPlugin;
