/**
 * @typedef {object} LogRecord
 * @property {number} timestamp
 * @property {LogDetail[]} upload
 * @property {LogDetail[]} omit
 * 
 * @typedef {object} LogDetail
 * @property {string} filename
 * @property {string} hash
 */

class VersionLog {
  constructor() {
    /** @type {LogRecord[]} */
    this.record = [];
  }

  /**
   * @param {LogRecord[]} content
   */
  init(content) {
    this.record = content.slice().sort((a, b) => b.timestamp - a.timestamp);
  }

  /**
   * @typedef {object} VersionData
   * @property {number} versionIndex
   * @property {number} timestamp
   * 查找文件最近的关联构建版本
   * @param {string} filename
   * @param {string} [hash]
   * @param {number} [startIndex=0]
   * @returns {VersionData}
   */
  findVersion(filename, hash, startIndex = 0) {
    const record = this.record;
    for (let i = startIndex, l = record.length; i < l; i++) {
      const {
        upload,
        omit,
        timestamp
      } = record[i];
      const files = [...upload, ...omit];
      for (let fi = 0, fl = files.length; fi < fl; fi++) {
        const targetFile = files[fi];
        if ((!hash || hash === targetFile.hash) && filename === targetFile.filename) {
          return {
            versionIndex: i,
            timestamp
          }
        }
      }
    }
    return undefined;
  }

  /**
   * 增加记录
   * @param {LogRecord} log 
   */
  append(log) {
    this.record.unshift(log);
  }

  /**
   * @returns {LogRecord}
   */
  getLastVersion() {
    return this.record[0];
  }

  /**
   * 获取第一个过期的版本的index, 没有找到则返回record length
   * @param {number} [maxiumVersion] 
   * @param {number} [deadline]
   */
  getFirstExpireVersionIndex(maxiumVersion, deadline) {
    const record = this.record;
    for (var i = 0; i < record.length; i++) {
      const timestamp = record[i].timestamp;
      const deadlineDefined = typeof deadline === 'number';
      const versionDefined = typeof maxiumVersion === 'number';
      const timeExpire = deadlineDefined && timestamp < deadline;
      const versionExpire = versionDefined && i > maxiumVersion;

      if (
        timeExpire && versionExpire || // 同时满足两个条件
        !deadlineDefined && versionExpire || // 缺少其中一个
        !versionDefined && timeExpire
      ) {
        break;
      }
    }
    return i;
  }

  /**
   * 获取未过期的版本
   * @param {number} [maxiumVersion] 
   * @param {number} [deadline]
   */
  getFreshVersions(maxiumVersion, deadline) {
    const expireIndex = this.getFirstExpireVersionIndex(maxiumVersion, deadline);
    return this.record.slice(0, expireIndex);
  }

  /**
   * 
   * @param {number} startIndex 
   * @param {number} endIndex 
   */
  getVersions(startIndex, endIndex) {
    return this.record.slice(startIndex, endIndex);
  }
}

module.exports = VersionLog;
